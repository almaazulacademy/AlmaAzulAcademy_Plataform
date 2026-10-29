/**
 * Lista de espera — fase 3: inscrição gratuita e cancelamento pelo link.
 *
 * O fluxo do servidor, sem Next e sem Supabase: recebe `rpc(nome, argumentos)`
 * e as funções de envio. As decisões — turma esgotada, duplicidade, limite de
 * tentativas, campo isca, tetos — são do banco (`waitlist_join`,
 * `waitlist_cancel_overview`, `waitlist_cancel`, da fase 1). Aqui só a validação
 * de formato, a tradução para HTTP e o disparo do e-mail.
 *
 * Nenhuma resposta traz dado pessoal, id interno ou token, e a inscrição
 * responde igual para quem acabou de se inscrever e para quem já estava na lista.
 */

import { isWaitlistPublicEnabled } from "./public.ts";
import { EVENT_WAITLIST_MESSAGES, eventWaitlistQuantityMessage, type WaitlistScope } from "../events/waitlist.ts";
import { digitsOnly, normalizePhone } from "../reservations/validation.ts";

/**
 * A inscrição só existe com `WAITLIST_SIGNUP_ENABLED=true` **e** a exibição das
 * esgotadas (`WAITLIST_PUBLIC_ENABLED=true`): sem turma esgotada na tela, não há
 * onde se inscrever. Variável de servidor — nunca `NEXT_PUBLIC_`.
 */
export function isWaitlistSignupEnabled(env: Record<string, string | undefined> = process.env) {
  return isWaitlistPublicEnabled(env) && (env.WAITLIST_SIGNUP_ENABLED ?? "").trim().toLowerCase() === "true";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANCEL_TOKEN = /^[0-9a-f]{64}$/i;

export type WaitlistSignupInput = {
  sessionId: string;
  fullName: string;
  email: string;
  phone: string;
  quantity: number;
  /** Campo isca: invisível para pessoas. Preenchido, o banco responde sucesso e não grava. */
  trap: string;
};

export const WAITLIST_FIELD_MESSAGES: Record<string, string> = {
  fullName: "Informe nome e sobrenome.",
  email: "Informe um e-mail válido.",
  phone: "Informe um WhatsApp válido com DDD.",
  quantity: "Escolha uma quantidade de pessoas que caiba na turma.",
};

export const WAITLIST_MESSAGES = {
  ACCEPTED: "Inscrição recebida. Se este e-mail ainda não estava na lista desta turma, a confirmação chega em instantes, com o link para sair da lista quando quiser.",
  RATE_LIMITED: "Muitas tentativas seguidas. Aguarde alguns minutos antes de tentar de novo.",
  SESSION_UNAVAILABLE: "Esta turma não está mais aberta para a lista de espera.",
  NOT_SOLD_OUT: "Boa notícia: esta turma tem vagas agora. Você pode reservar direto.",
  LIMIT_REACHED: "Este e-mail já está na lista de espera de muitas turmas. Saia de alguma delas antes de entrar em outra.",
  WAITLIST_FULL: "A lista de espera desta turma está cheia.",
  UNAVAILABLE: "A lista de espera está indisponível agora. Tente novamente em instantes.",
  INVALID: "Confira os campos destacados.",
} as const;

export type WaitlistResponse = { status: number; body: Record<string, unknown>; retryAfterSeconds?: number };

type RpcResult = { data: unknown; error: { message: string; code?: string } | null };
export type WaitlistRpc = (name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;

export type WaitlistSignupDeps = {
  rpc: WaitlistRpc;
  /** Envia a confirmação na hora. Nunca lança. */
  sendConfirmation: (sessionId: string, email: string) => Promise<unknown>;
  /** Novas tentativas, depois da resposta. Nunca lança. */
  followUpConfirmation: (sessionId: string, email: string) => Promise<unknown>;
  afterResponse: (task: () => Promise<unknown>) => void;
  /**
   * Escopo da sessão (regular ou evento, cada um com a sua variável), decidido
   * no servidor antes do banco. A rota sempre passa; sem ele, é a inscrição
   * regular de sempre.
   */
  scope?: (sessionId: string) => Promise<WaitlistScope>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateWaitlistSignup(value: unknown): { success: true; data: WaitlistSignupInput } | { success: false; errors: Record<string, string> } {
  if (!isRecord(value)) return { success: false, errors: { form: "Dados inválidos." } };
  const input: WaitlistSignupInput = {
    sessionId: String(value.sessionId ?? "").trim(),
    fullName: String(value.fullName ?? "").trim().replace(/\s+/g, " "),
    email: String(value.email ?? "").trim().toLowerCase(),
    phone: normalizePhone(String(value.phone ?? "")),
    quantity: Number(value.quantity),
    trap: String(value.website ?? "").slice(0, 200),
  };
  const errors: Record<string, string> = {};
  if (!UUID.test(input.sessionId)) errors.form = "Atualize a página e tente novamente.";
  if (input.fullName.length < 5 || input.fullName.length > 120 || !input.fullName.includes(" ")) errors.fullName = WAITLIST_FIELD_MESSAGES.fullName;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || input.email.length > 254) errors.email = WAITLIST_FIELD_MESSAGES.email;
  if (!/^\+55\d{10,11}$/.test(input.phone) || digitsOnly(String(value.phone ?? "")).length < 10) errors.phone = WAITLIST_FIELD_MESSAGES.phone;
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 20) errors.quantity = WAITLIST_FIELD_MESSAGES.quantity;
  return Object.keys(errors).length ? { success: false, errors } : { success: true, data: input };
}

function unavailable(): WaitlistResponse {
  return { status: 503, body: { code: "UNAVAILABLE", message: WAITLIST_MESSAGES.UNAVAILABLE } };
}

function rateLimited(seconds: unknown): WaitlistResponse {
  const retryAfterSeconds = Math.max(1, Math.ceil(Number(seconds) || 900));
  return { status: 429, body: { code: "RATE_LIMITED", message: WAITLIST_MESSAGES.RATE_LIMITED }, retryAfterSeconds };
}

/**
 * Inscrição. Formato errado é recusado aqui, sem tocar no banco; o resto é a
 * resposta de `waitlist_join`, que conta a tentativa no limite antes de tudo.
 */
export async function handleWaitlistSignup(deps: WaitlistSignupDeps, body: unknown, clientAddress: string | null): Promise<WaitlistResponse> {
  const validation = validateWaitlistSignup(body);
  if (!validation.success) return { status: 400, body: { code: "INVALID", message: WAITLIST_MESSAGES.INVALID, errors: validation.errors } };
  const input = validation.data;

  const scope: WaitlistScope = deps.scope ? await deps.scope(input.sessionId) : { kind: "REGULAR" };
  if (scope.kind === "DISABLED") return { status: 404, body: { message: "Recurso não disponível." } };
  if (scope.kind === "UNAVAILABLE") return unavailable();
  if (scope.kind === "SESSION_UNAVAILABLE") return { status: 409, body: { code: "SESSION_UNAVAILABLE", message: EVENT_WAITLIST_MESSAGES.SESSION_UNAVAILABLE } };
  const event = scope.kind === "EVENT" ? scope : null;
  const messages = event ? { ...WAITLIST_MESSAGES, ...EVENT_WAITLIST_MESSAGES } : WAITLIST_MESSAGES;
  // O máximo por pedido do evento (6 no ESSÊNCIA), antes do banco, que só
  // conhece o limite geral (20) e a capacidade da sessão.
  if (event && input.quantity > event.maxPerOrder) {
    return { status: 400, body: { code: "INVALID", message: WAITLIST_MESSAGES.INVALID, errors: { quantity: eventWaitlistQuantityMessage(event.maxPerOrder) } } };
  }

  let result: RpcResult;
  try {
    result = await deps.rpc("waitlist_join", {
      p_session_id: input.sessionId,
      p_full_name: input.fullName,
      p_email: input.email,
      p_phone: input.phone,
      p_quantity: input.quantity,
      p_client_address: clientAddress,
      p_trap: input.trap,
    });
  } catch {
    return unavailable();
  }
  if (result.error || !isRecord(result.data)) return unavailable();

  const answer = result.data;
  switch (answer.status) {
    case "ACCEPTED":
      // Campo isca: o banco não gravou nada, e não há e-mail a enviar.
      if (!input.trap.trim()) {
        deps.afterResponse(async () => {
          const sent = await deps.sendConfirmation(input.sessionId, input.email);
          const outcome = isRecord(sent) ? sent.outcome : null;
          if (outcome === "PENDING" && (sent as Record<string, unknown>).retryable !== false) {
            await deps.followUpConfirmation(input.sessionId, input.email);
          }
        });
      }
      return { status: 200, body: { status: "ACCEPTED", message: messages.ACCEPTED } };
    case "RATE_LIMITED":
      return rateLimited(answer.retryAfterSeconds);
    case "INVALID": {
      const field = typeof answer.field === "string" && answer.field in WAITLIST_FIELD_MESSAGES ? answer.field : "form";
      const fieldMessage = event && field === "quantity" ? eventWaitlistQuantityMessage(event.maxPerOrder) : WAITLIST_FIELD_MESSAGES[field] ?? WAITLIST_MESSAGES.INVALID;
      return { status: 400, body: { code: "INVALID", message: WAITLIST_MESSAGES.INVALID, errors: { [field]: fieldMessage } } };
    }
    case "SESSION_UNAVAILABLE":
      return { status: 409, body: { code: "SESSION_UNAVAILABLE", message: messages.SESSION_UNAVAILABLE } };
    case "NOT_SOLD_OUT":
      return { status: 409, body: { code: "NOT_SOLD_OUT", message: messages.NOT_SOLD_OUT, reserveHref: `/reservar/${input.sessionId}` } };
    case "LIMIT_REACHED":
      return { status: 409, body: { code: "LIMIT_REACHED", message: messages.LIMIT_REACHED } };
    case "WAITLIST_FULL":
      return { status: 409, body: { code: "WAITLIST_FULL", message: messages.WAITLIST_FULL } };
    default:
      return unavailable();
  }
}

// --- Cancelamento pelo link -----------------------------------------------------

export type WaitlistCancelDeps = { rpc: WaitlistRpc };

export const WAITLIST_CANCEL_MESSAGES = {
  NOT_FOUND: "Este link não é válido. Se você recebeu o e-mail de confirmação, abra o link direto dele.",
  CANCELLED: "Pronto: você saiu da lista de espera desta turma. Não enviaremos mais avisos sobre ela.",
  ALREADY_CLOSED: "Esta inscrição já não está ativa na lista de espera.",
  RATE_LIMITED: WAITLIST_MESSAGES.RATE_LIMITED,
  UNAVAILABLE: WAITLIST_MESSAGES.UNAVAILABLE,
} as const;

/** O token do link, só no formato certo. O texto nunca é devolvido nem logado. */
export function parseCancelToken(value: unknown) {
  if (!isRecord(value)) return null;
  const token = String(value.token ?? "").trim().toLowerCase();
  return CANCEL_TOKEN.test(token) ? token : null;
}

/** Lê o token do fragmento `#t=<token>` da página. */
export function waitlistTokenFromHash(hash: string) {
  const match = /(?:^#|&)t=([0-9a-f]{64})(?:&|$)/i.exec(hash ?? "");
  return match ? match[1].toLowerCase() : null;
}

const ENTRY_STATES = new Set(["ACTIVE", "CONVERTED", "CANCELLED", "REMOVED", "EXPIRED"]);

function isMissingFunction(error: { message: string; code?: string }) {
  return error.code === "42883" || error.code === "PGRST202" || /function .* does not exist|could not find the function/i.test(error.message);
}

async function callCancel(deps: WaitlistCancelDeps, name: "waitlist_cancel_overview" | "waitlist_cancel", body: unknown, clientAddress: string | null) {
  const token = parseCancelToken(body);
  // Formato errado: a mesma resposta de token desconhecido, sem tocar no banco.
  if (!token) return { kind: "NOT_FOUND" as const };
  try {
    // A visão do link vem com o tipo da experiência (migration 202610300001).
    // Sem a função nova, a de sempre — e a página fala de "turma", como antes.
    if (name === "waitlist_cancel_overview") {
      const withKind = await deps.rpc("waitlist_cancel_overview_with_kind", { p_token: token, p_client_address: clientAddress });
      if (!withKind.error && isRecord(withKind.data)) return { kind: "DATA" as const, data: withKind.data };
      if (withKind.error && !isMissingFunction(withKind.error)) return { kind: "UNAVAILABLE" as const };
    }
    const result = await deps.rpc(name, { p_token: token, p_client_address: clientAddress });
    if (result.error || !isRecord(result.data)) return { kind: "UNAVAILABLE" as const };
    return { kind: "DATA" as const, data: result.data };
  } catch {
    return { kind: "UNAVAILABLE" as const };
  }
}

/** O que a página do link mostra antes de o cliente confirmar. */
export async function handleWaitlistCancelOverview(deps: WaitlistCancelDeps, body: unknown, clientAddress: string | null): Promise<WaitlistResponse> {
  const answer = await callCancel(deps, "waitlist_cancel_overview", body, clientAddress);
  if (answer.kind === "NOT_FOUND") return { status: 404, body: { code: "NOT_FOUND", message: WAITLIST_CANCEL_MESSAGES.NOT_FOUND } };
  if (answer.kind === "UNAVAILABLE") return unavailable();
  const data = answer.data;
  if (data.status === "RATE_LIMITED") return rateLimited(data.retryAfterSeconds);
  if (data.status === "NOT_FOUND") return { status: 404, body: { code: "NOT_FOUND", message: WAITLIST_CANCEL_MESSAGES.NOT_FOUND } };
  if (typeof data.status !== "string" || !ENTRY_STATES.has(data.status)) return unavailable();
  const session = isRecord(data.session) ? data.session : {};
  const eventSlug = data.experienceKind === "EVENT" && typeof data.experienceSlug === "string" && /^[a-z0-9-]{1,80}$/.test(data.experienceSlug) ? data.experienceSlug : null;
  // Só o que o banco já limitou: estado, primeiro nome, quantidade, a turma e,
  // para evento, o slug da página dele.
  return {
    status: 200,
    body: {
      state: data.status,
      event: eventSlug ? { slug: eventSlug } : null,
      firstName: typeof data.firstName === "string" ? data.firstName : "",
      quantity: Number(data.quantity) || 0,
      session: {
        startsAt: typeof session.startsAt === "string" ? session.startsAt : "",
        experienceTitle: typeof session.experienceTitle === "string" ? session.experienceTitle : "",
        baseName: typeof session.baseName === "string" ? session.baseName : "",
      },
    },
  };
}

/** Confirma a saída da lista. Idempotente. */
export async function handleWaitlistCancel(deps: WaitlistCancelDeps, body: unknown, clientAddress: string | null): Promise<WaitlistResponse> {
  const answer = await callCancel(deps, "waitlist_cancel", body, clientAddress);
  if (answer.kind === "NOT_FOUND") return { status: 404, body: { code: "NOT_FOUND", message: WAITLIST_CANCEL_MESSAGES.NOT_FOUND } };
  if (answer.kind === "UNAVAILABLE") return unavailable();
  const data = answer.data;
  if (data.status === "RATE_LIMITED") return rateLimited(data.retryAfterSeconds);
  if (data.status === "NOT_FOUND") return { status: 404, body: { code: "NOT_FOUND", message: WAITLIST_CANCEL_MESSAGES.NOT_FOUND } };
  if (data.status === "CANCELLED") return { status: 200, body: { state: "CANCELLED", message: WAITLIST_CANCEL_MESSAGES.CANCELLED } };
  if (data.status === "ALREADY_CLOSED") {
    const state = typeof data.state === "string" && ENTRY_STATES.has(data.state) ? data.state : "CLOSED";
    return { status: 200, body: { state, message: WAITLIST_CANCEL_MESSAGES.ALREADY_CLOSED } };
  }
  return unavailable();
}
