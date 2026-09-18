import { isAdminRole, isStaffRole } from "../admin/roles.ts";
import type { StaffRole } from "../admin/types.ts";
import { RESET_LINK_INVALID_MESSAGE, RESET_PATH } from "./password-reset-rules.ts";

/**
 * Recuperação de senha da equipe (ADMIN, OPERATOR e INSTRUCTOR).
 *
 * Pedido: o servidor gera o link com `auth.admin.generateLink` (o Supabase não
 * envia nada) e manda o e-mail pelo provedor do site. Só contas ativas em
 * `admin_users` recebem; a resposta ao navegador é sempre a mesma.
 *
 * Redefinição: `verifyOtp` com o token do link prova a posse do e-mail; a senha
 * é trocada, TODAS as sessões da conta são encerradas e a pessoa entra de novo
 * pelo login normal da equipe (que confere papel e status outra vez).
 */

export const RESET_COOLDOWN_SECONDS = 120;
export const RESET_MAX_PER_HOUR = 5;

export type ResetMembership = { role: string; isActive: boolean; displayName: string };

export type ResetRequestDeps = {
  /** null quando o e-mail não tem conta no Auth. */
  generateLink(email: string): Promise<{ userId: string; tokenHash: string } | null>;
  membership(userId: string): Promise<ResetMembership | null>;
  /** Pedidos anteriores desta conta: segundos desde o último e total na última hora. */
  recentRequests(userId: string): Promise<{ secondsSinceLast: number | null; lastHour: number }>;
  send(message: { to: string; displayName: string; url: string }): Promise<void>;
  record(userId: string): Promise<void>;
  origin: string;
  log?(stage: string, details?: Record<string, unknown>): void;
};

export type ResetRequestOutcome = "SENT" | "NO_ACCOUNT" | "NOT_STAFF" | "INACTIVE" | "THROTTLED" | "SEND_FAILED";

export function resetUrl(origin: string, tokenHash: string) {
  return `${origin}${RESET_PATH}?token=${encodeURIComponent(tokenHash)}`;
}

/** O resultado é só para log e teste; a rota responde sempre a mesma mensagem. */
export async function requestPasswordReset(email: string, deps: ResetRequestDeps): Promise<ResetRequestOutcome> {
  const log = deps.log ?? (() => undefined);
  const link = await deps.generateLink(email);
  if (!link) {
    log("no_account");
    return "NO_ACCOUNT";
  }

  const membership = await deps.membership(link.userId);
  if (!membership || !isStaffRole(membership.role)) {
    log("not_staff");
    return "NOT_STAFF";
  }
  if (!membership.isActive) {
    log("inactive");
    return "INACTIVE";
  }

  const recent = await deps.recentRequests(link.userId);
  if ((recent.secondsSinceLast !== null && recent.secondsSinceLast < RESET_COOLDOWN_SECONDS) || recent.lastHour >= RESET_MAX_PER_HOUR) {
    log("throttled");
    return "THROTTLED";
  }

  try {
    await deps.send({ to: email, displayName: membership.displayName, url: resetUrl(deps.origin, link.tokenHash) });
  } catch {
    log("send_failed");
    return "SEND_FAILED";
  }
  await deps.record(link.userId).catch(() => log("record_failed"));
  log("sent", { role: membership.role });
  return "SENT";
}

export type ResetCompleteDeps = {
  /** Valida o token do link; null se inválido, usado ou expirado. */
  verify(tokenHash: string): Promise<{ userId: string; email: string; accessToken: string } | null>;
  membership(userId: string): Promise<ResetMembership | null>;
  updatePassword(userId: string, password: string): Promise<"OK" | "WEAK_PASSWORD" | "FAILED">;
  /** Encerra todas as sessões da conta (inclusive a aberta pelo link). */
  signOutEverywhere(accessToken: string): Promise<void>;
  record(userId: string): Promise<void>;
  log?(stage: string, details?: Record<string, unknown>): void;
};

export type ResetCompleteResult =
  | { ok: true; email: string; role: StaffRole }
  | { ok: false; status: number; code: string; message: string };

export async function completePasswordReset(input: { token: string; password: string }, deps: ResetCompleteDeps): Promise<ResetCompleteResult> {
  const log = deps.log ?? (() => undefined);
  const verified = await deps.verify(input.token);
  if (!verified) {
    log("link_invalid");
    return { ok: false, status: 410, code: "LINK_INVALID", message: RESET_LINK_INVALID_MESSAGE };
  }

  // Só a equipe tem senha útil aqui; um link de outra conta não troca nada.
  const membership = await deps.membership(verified.userId);
  if (!membership || !isStaffRole(membership.role) || !membership.isActive) {
    await deps.signOutEverywhere(verified.accessToken).catch(() => undefined);
    log("not_active_staff");
    return { ok: false, status: 403, code: "NOT_ALLOWED", message: "Esta conta não tem acesso ativo. Fale com a administração da Alma Azul." };
  }

  const updated = await deps.updatePassword(verified.userId, input.password);
  if (updated !== "OK") {
    await deps.signOutEverywhere(verified.accessToken).catch(() => undefined);
    log("update_failed", { reason: updated });
    return updated === "WEAK_PASSWORD"
      ? { ok: false, status: 400, code: "WEAK_PASSWORD", message: "Esta senha foi recusada por ser fraca. Peça um novo link e escolha outra." }
      : { ok: false, status: 502, code: "UPDATE_FAILED", message: "Não foi possível trocar a senha agora. Peça um novo link e tente de novo." };
  }

  await deps.signOutEverywhere(verified.accessToken).catch(() => log("sign_out_failed"));
  await deps.record(verified.userId).catch(() => log("record_failed"));
  log("completed", { admin: isAdminRole(membership.role) });
  return { ok: true, email: verified.email, role: membership.role as StaffRole };
}
