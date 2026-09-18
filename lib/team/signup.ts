import { hashInviteToken, INVITE_STATE_MESSAGES, parseInviteState, type InviteState, type SignupInput } from "./invite.ts";

/**
 * Cadastro pelo convite, orquestrado no servidor.
 *
 *   1. confere o convite (falha rápida, sem criar nada);
 *   2. cria o usuário no Supabase Auth (service role, e-mail já confirmado —
 *      o convite é a prova de que a administração autorizou esta pessoa);
 *   3. consome o convite com `instructor_invite_claim`, que numa transação só
 *      trava o convite, cria o perfil INSTRUCTOR, marca o uso e audita;
 *   4. se o passo 3 falhar, apaga o usuário criado no passo 2.
 *
 * Assim nunca sobra convite consumido sem usuário (o consumo é o último passo),
 * nem usuário sem perfil (é desfeito), nem perfil com outro papel (o papel é
 * fixado dentro da RPC). Dois cadastros simultâneos com o mesmo convite: o
 * `for update` da RPC deixa um passar; o outro recebe INVITE_USED e seu usuário
 * é removido.
 */

export type SignupDeps = {
  inviteStatus(tokenHash: string): Promise<unknown>;
  createUser(email: string, password: string): Promise<{ userId: string } | { error: "EMAIL_EXISTS" | "WEAK_PASSWORD" | "FAILED" }>;
  claimInvite(tokenHash: string, userId: string, displayName: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  log?(stage: string, details?: Record<string, unknown>): void;
};

export type SignupResult =
  | { ok: true; userId: string }
  | { ok: false; status: number; code: string; message: string; inviteState?: InviteState };

function inviteFailure(state: Exclude<InviteState, "VALID">): SignupResult {
  return { ok: false, status: state === "INVALID" ? 404 : 410, code: `INVITE_${state}`, message: INVITE_STATE_MESSAGES[state].description, inviteState: state };
}

export function claimErrorState(message: string): Exclude<InviteState, "VALID"> | "ACCOUNT_EXISTS" | null {
  for (const state of ["USED", "EXPIRED", "REVOKED", "ACCOUNT_EXISTS"] as const) {
    if (message.includes(`INVITE_${state}`)) return state;
  }
  if (message.includes("INVITE_INVALID")) return "INVALID";
  return null;
}

export async function registerInstructor(input: SignupInput, deps: SignupDeps): Promise<SignupResult> {
  const log = deps.log ?? (() => undefined);
  const tokenHash = hashInviteToken(input.token);

  const state = parseInviteState(await deps.inviteStatus(tokenHash));
  if (state !== "VALID") {
    log("invite_rejected", { state });
    return inviteFailure(state);
  }

  const created = await deps.createUser(input.email, input.password);
  if ("error" in created) {
    log("auth_user_rejected", { reason: created.error });
    if (created.error === "EMAIL_EXISTS") {
      return { ok: false, status: 409, code: "EMAIL_EXISTS", message: "Já existe uma conta com este e-mail. Use outro e-mail ou entre com a sua senha." };
    }
    if (created.error === "WEAK_PASSWORD") {
      return { ok: false, status: 400, code: "WEAK_PASSWORD", message: "Esta senha foi recusada por ser fraca. Escolha outra." };
    }
    return { ok: false, status: 502, code: "AUTH_FAILED", message: "Não foi possível criar sua conta agora. Tente novamente em instantes." };
  }

  try {
    await deps.claimInvite(tokenHash, created.userId, input.name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("claim_failed_rolling_back", { reason: claimErrorState(message) ?? "UNEXPECTED" });
    try {
      await deps.deleteUser(created.userId);
    } catch {
      // Sem perfil em admin_users, este usuário não acessa nada; fica só o registro no Auth.
      log("rollback_delete_failed", { userId: created.userId });
    }
    const reason = claimErrorState(message);
    if (reason === "ACCOUNT_EXISTS") {
      return { ok: false, status: 409, code: "EMAIL_EXISTS", message: "Já existe uma conta com este e-mail." };
    }
    if (reason) return inviteFailure(reason);
    return { ok: false, status: 500, code: "UNEXPECTED", message: "Não foi possível concluir o cadastro. Nada foi criado; tente novamente." };
  }

  log("instructor_registered");
  return { ok: true, userId: created.userId };
}
