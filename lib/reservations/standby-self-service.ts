/**
 * Autoatendimento do reagendamento de Stand-by: o cliente escolhe a nova data
 * pelo site.
 *
 * Sem Next e sem Supabase de propósito — as rotas injetam o cliente do banco, o
 * envio do e-mail e a planilha. É o que permite exercitar o fluxo inteiro com o
 * runner nativo do Node, contra o Postgres em memória e as RPCs de verdade.
 *
 * Quem decide é o banco. Este módulo só:
 *
 *   1. valida o formato da credencial (CPF + código, ou o token do link) e da
 *      escolha, sem consultar nada;
 *   2. registra a tentativa no limite (`register_customer_access_attempt`, o
 *      mesmo da consulta pública da reserva) **antes** de qualquer consulta que
 *      dependa da credencial;
 *   3. chama a RPC e traduz a resposta para o cliente.
 *
 * A credencial vai inteira a cada chamada: não há sessão, cookie nem token
 * próprio do autoatendimento. O id da reserva, a quantidade e o valor nunca são
 * parâmetros — só a autorização que o cliente viu e a turma que ele escolheu.
 */

import { parseStandbyResolution } from "../admin/standby.ts";
import { filterSameKind, type SessionKinds } from "../events/kind.ts";
import { registerAccessAttempt, TOO_MANY_ATTEMPTS_MESSAGE } from "./access-throttle.ts";
import { digitsOnly, isValidCpf } from "./validation.ts";

// --- Ativação -----------------------------------------------------------------

/**
 * O autoatendimento só existe quando `STANDBY_SELF_SERVICE_ENABLED=true`.
 *
 * Sem a variável, as rotas respondem 404, a página de acompanhamento continua
 * mandando o cliente em Stand-by para o WhatsApp e o link individual abre a
 * consulta comum. Variável de servidor — nunca `NEXT_PUBLIC_`.
 */
export function isStandbySelfServiceEnabled(env: Record<string, string | undefined> = process.env) {
  return (env.STANDBY_SELF_SERVICE_ENABLED ?? "").trim().toLowerCase() === "true";
}

// --- Credencial ---------------------------------------------------------------

export type SelfServiceCredential =
  | { kind: "CPF_CODE"; cpf: string; publicCode: string }
  | { kind: "LINK"; token: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lê o token do fragmento do link (`#r=<token>`). Só o formato exato gerado
 * pelo banco; qualquer outra coisa é ignorada.
 */
export function standbyTokenFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = (params.get("r") ?? "").trim().toLowerCase();
  return TOKEN.test(token) ? token : null;
}

/** Credencial do corpo da requisição. Uma das duas formas, nunca as duas. */
export function parseCredential(value: unknown): SelfServiceCredential | null {
  if (!isRecord(value)) return null;
  const token = typeof value.token === "string" ? value.token.trim().toLowerCase() : "";
  const hasCpfCode = value.cpf !== undefined || value.publicCode !== undefined;
  if (token) {
    if (hasCpfCode || !TOKEN.test(token)) return null;
    return { kind: "LINK", token };
  }
  const cpf = digitsOnly(String(value.cpf ?? ""));
  const publicCode = String(value.publicCode ?? "").trim().toUpperCase();
  if (!isValidCpf(cpf) || !/^[A-Z0-9]{8,12}$/.test(publicCode)) return null;
  return { kind: "CPF_CODE", cpf, publicCode };
}

export function credentialArgs(credential: SelfServiceCredential) {
  return credential.kind === "LINK"
    ? { p_cpf: null, p_public_code: null, p_link_token: credential.token }
    : { p_cpf: credential.cpf, p_public_code: credential.publicCode, p_link_token: null };
}

export type RescheduleChoice = { credential: SelfServiceCredential; standbyId: string; sessionId: string };

export function parseRescheduleChoice(value: unknown): RescheduleChoice | null {
  if (!isRecord(value)) return null;
  const credential = parseCredential(value.credential);
  const standbyId = String(value.standbyId ?? "").trim();
  const sessionId = String(value.sessionId ?? "").trim();
  if (!credential || !UUID.test(standbyId) || !UUID.test(sessionId)) return null;
  return { credential, standbyId, sessionId };
}

// --- Respostas do banco -------------------------------------------------------

export type SelfServiceOption = {
  /** `id` e `startsAt` no formato de `groupSessionsByDay`. */
  id: string;
  sessionId: string;
  experienceTitle: string;
  baseSlug: string;
  baseName: string;
  startsAt: string;
  durationMinutes: number;
  remainingSpots: number;
  isOriginal: boolean;
};

export type SelfServiceSession = {
  startsAt: string;
  durationMinutes: number;
  experienceTitle: string;
  baseName: string;
};

export type SelfServiceOverview =
  | {
      state: "OPEN";
      standbyId: string;
      publicCode: string;
      firstName: string;
      quantity: number;
      totalCents: number;
      original: { startsAt: string; experienceTitle: string; baseName: string };
      hiddenForCapacity: number;
      options: SelfServiceOption[];
    }
  | {
      state: "RESCHEDULED";
      publicCode: string;
      firstName: string;
      quantity: number;
      resolvedBy: "CUSTOMER" | "ADMIN";
      session: SelfServiceSession | null;
    }
  | { state: "CANCELLED" | "LINK_REPLACED" | "CLOSED"; publicCode: string };

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function count(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** Só o que a tela usa. Nada além do que a RPC já limita. */
export function parseOverview(value: unknown): SelfServiceOverview | null {
  if (!isRecord(value)) return null;
  const publicCode = text(value.publicCode);
  switch (value.state) {
    case "OPEN": {
      const original = isRecord(value.original) ? value.original : {};
      const options = Array.isArray(value.options) ? value.options.filter(isRecord) : [];
      return {
        state: "OPEN",
        standbyId: text(value.standbyId),
        publicCode,
        firstName: text(value.firstName),
        quantity: count(value.quantity),
        totalCents: count(value.totalCents),
        original: {
          startsAt: text(original.startsAt),
          experienceTitle: text(original.experienceTitle),
          baseName: text(original.baseName),
        },
        hiddenForCapacity: count(value.hiddenForCapacity),
        options: options.map((option) => ({
          id: text(option.sessionId),
          sessionId: text(option.sessionId),
          experienceTitle: text(option.experienceTitle),
          baseSlug: text(option.baseSlug),
          baseName: text(option.baseName),
          startsAt: text(option.startsAt),
          durationMinutes: count(option.durationMinutes),
          remainingSpots: count(option.remainingSpots),
          isOriginal: option.isOriginal === true,
        })),
      };
    }
    case "RESCHEDULED": {
      const session = isRecord(value.session) ? value.session : null;
      return {
        state: "RESCHEDULED",
        publicCode,
        firstName: text(value.firstName),
        quantity: count(value.quantity),
        resolvedBy: value.resolvedBy === "CUSTOMER" ? "CUSTOMER" : "ADMIN",
        session: session
          ? {
              startsAt: text(session.startsAt),
              durationMinutes: count(session.durationMinutes),
              experienceTitle: text(session.experienceTitle),
              baseName: text(session.baseName),
            }
          : null,
      };
    }
    case "CANCELLED":
    case "LINK_REPLACED":
    case "CLOSED":
      return { state: value.state, publicCode };
    default:
      return null;
  }
}

// --- Erros --------------------------------------------------------------------

export type SelfServiceErrorCode =
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "TOO_MANY_ATTEMPTS"
  | "ALREADY_USED"
  | "NO_SPOTS"
  | "SESSION_UNAVAILABLE"
  | "UNAVAILABLE"
  | "FAILED";

export type SelfServiceFailure = {
  status: number;
  code: SelfServiceErrorCode;
  message: string;
  retryAfterSeconds?: number;
};

export const SELF_SERVICE_MESSAGES = {
  INVALID_REQUEST: "Confira os dados informados e tente de novo.",
  NOT_FOUND_CPF: "Não encontramos uma reserva aguardando nova data com este CPF e código. Confira os dados.",
  NOT_FOUND_LINK: "Este link não é válido. Ele pode ter sido substituído ou cancelado pela equipe.",
  TOO_MANY_ATTEMPTS: TOO_MANY_ATTEMPTS_MESSAGE,
  ALREADY_USED: "Esta reserva já foi reagendada ou não está mais aguardando uma nova data.",
  NO_SPOTS: "As vagas desta turma acabaram enquanto você escolhia. Escolha outra data.",
  SESSION_UNAVAILABLE: "Esta turma não está mais disponível. Escolha outra data.",
  PRICE_NOT_ELIGIBLE: "Esta turma não tem o mesmo valor por participante da sua reserva. Escolha outra data.",
  UNAVAILABLE: "O reagendamento pelo site está indisponível agora. Tente de novo em instantes ou fale com a equipe.",
  FAILED: "Não foi possível concluir o reagendamento agora. Nada foi alterado na sua reserva.",
} as const;

const SESSION_UNAVAILABLE = [
  "SESSION_NOT_OPEN",
  "SESSION_MUST_BE_FUTURE",
  "SESSION_NOT_FOUND",
  "EXPERIENCE_NOT_AVAILABLE",
  "EXPERIENCE_NOT_FOUND",
  "BASE_NOT_AVAILABLE",
  // Turma de outro tipo (evento especial × agenda regular): para o cliente, é
  // só uma turma que não serve para esta reserva.
  "EVENT_KIND_MISMATCH",
];

/**
 * Tradução das recusas do banco. Tudo que o banco recusa foi desfeito na mesma
 * transação: nenhuma mensagem aqui precisa dizer "talvez tenha mudado".
 */
export function selfServiceRescheduleError(error: unknown, credential: SelfServiceCredential): SelfServiceFailure {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.includes("STANDBY_NOT_AUTHORIZED") || message.includes("STANDBY_NOT_FOUND")) {
    return notFound(credential);
  }
  if (message.includes("STANDBY_ALREADY_USED")) return { status: 409, code: "ALREADY_USED", message: SELF_SERVICE_MESSAGES.ALREADY_USED };
  if (message.includes("INSUFFICIENT_SPOTS")) return { status: 409, code: "NO_SPOTS", message: SELF_SERVICE_MESSAGES.NO_SPOTS };
  if (message.includes("PRICE_NOT_ELIGIBLE")) {
    return { status: 409, code: "SESSION_UNAVAILABLE", message: SELF_SERVICE_MESSAGES.PRICE_NOT_ELIGIBLE };
  }
  if (SESSION_UNAVAILABLE.some((symbol) => message.includes(symbol))) {
    return { status: 409, code: "SESSION_UNAVAILABLE", message: SELF_SERVICE_MESSAGES.SESSION_UNAVAILABLE };
  }
  return { status: 500, code: "FAILED", message: SELF_SERVICE_MESSAGES.FAILED };
}

function notFound(credential: SelfServiceCredential): SelfServiceFailure {
  return {
    status: 404,
    code: "NOT_FOUND",
    message: credential.kind === "LINK" ? SELF_SERVICE_MESSAGES.NOT_FOUND_LINK : SELF_SERVICE_MESSAGES.NOT_FOUND_CPF,
  };
}

// --- Fluxo --------------------------------------------------------------------

type RpcResult = { data: unknown; error: { message: string; code?: string } | null };

export type SelfServiceDeps = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<RpcResult>;
  /**
   * Tipo de cada sessão (agenda regular ou evento especial). A tela só mostra
   * turmas do mesmo tipo da original; o banco recusa o resto.
   */
  sessionKinds: SessionKinds;
  /** A tentativa imediata do e-mail da etapa 4. Nunca lança. */
  sendConfirmationEmail?(changeId: string): Promise<{ outcome: string; retryable?: boolean }>;
  /** O que roda depois da resposta: planilha e novas tentativas do e-mail. */
  afterResponse?(task: () => Promise<unknown>): void;
  followUpConfirmationEmail?(changeId: string): Promise<unknown>;
  syncSheet?(reservationId: string, previousSessionId: string): Promise<unknown>;
};

export type SelfServiceResponse = {
  status: number;
  body: Record<string, unknown>;
  retryAfterSeconds?: number;
};

function failure(result: SelfServiceFailure): SelfServiceResponse {
  return {
    status: result.status,
    body: { code: result.code, message: result.message },
    retryAfterSeconds: result.retryAfterSeconds,
  };
}

/**
 * Registra a tentativa. Sem o limite não há autoatendimento: se a função não
 * responder (migration ausente, banco fora), a resposta é "indisponível" e a
 * credencial nem chega a ser consultada.
 */
async function throttle(deps: SelfServiceDeps, credential: SelfServiceCredential, client: string): Promise<SelfServiceResponse | null> {
  const attempt = await registerAccessAttempt(deps.rpc, client, credentialArgs(credential));
  if (attempt.status === "ALLOWED") return null;
  if (attempt.status === "BLOCKED") {
    return failure({ status: 429, code: "TOO_MANY_ATTEMPTS", message: SELF_SERVICE_MESSAGES.TOO_MANY_ATTEMPTS, retryAfterSeconds: attempt.retryAfterSeconds });
  }
  return failure({ status: 503, code: "UNAVAILABLE", message: SELF_SERVICE_MESSAGES.UNAVAILABLE });
}

/** A tela: turmas elegíveis, ou o estado da autorização já encerrada. */
export async function handleSelfServiceOverview(deps: SelfServiceDeps, body: unknown, client: string): Promise<SelfServiceResponse> {
  const credential = parseCredential(isRecord(body) ? body.credential : null);
  if (!credential) return failure({ status: 400, code: "INVALID_REQUEST", message: SELF_SERVICE_MESSAGES.INVALID_REQUEST });

  const limited = await throttle(deps, credential, client);
  if (limited) return limited;

  let result: RpcResult;
  try {
    result = await deps.rpc("customer_reschedule_overview", credentialArgs(credential));
  } catch {
    return failure({ status: 503, code: "UNAVAILABLE", message: SELF_SERVICE_MESSAGES.UNAVAILABLE });
  }
  if (result.error) return failure({ status: 503, code: "UNAVAILABLE", message: SELF_SERVICE_MESSAGES.UNAVAILABLE });

  let data = result.data;
  if (isRecord(data) && data.state === "OPEN" && Array.isArray(data.options)) {
    const original = isRecord(data.original) ? text(data.original.sessionId) : "";
    try {
      const options = await filterSameKind(deps.sessionKinds, original, data.options.filter(isRecord), (option) => text(option.sessionId));
      data = { ...data, options };
    } catch {
      return failure({ status: 503, code: "UNAVAILABLE", message: SELF_SERVICE_MESSAGES.UNAVAILABLE });
    }
  }

  const overview = parseOverview(data);
  if (!overview) return failure(notFound(credential));
  return { status: 200, body: { overview } };
}

/**
 * Confirma a turma escolhida. A transação do banco move a reserva, encerra a
 * autorização, grava o histórico e a auditoria e enfileira o e-mail da etapa 4
 * — tudo junto ou nada. Depois dela, e só se ela gravou:
 *
 *   - a tentativa imediata do e-mail (que não faz nada com o e-mail desligado);
 *   - em segundo plano, a planilha e, se o e-mail falhou por algo passageiro,
 *     mais duas tentativas — exatamente o que a rota do painel faz.
 *
 * Nenhuma delas desfaz o reagendamento se falhar.
 */
export async function handleSelfServiceReschedule(deps: SelfServiceDeps, body: unknown, client: string): Promise<SelfServiceResponse> {
  const choice = parseRescheduleChoice(body);
  if (!choice) return failure({ status: 400, code: "INVALID_REQUEST", message: SELF_SERVICE_MESSAGES.INVALID_REQUEST });

  const limited = await throttle(deps, choice.credential, client);
  if (limited) return limited;

  let result: RpcResult;
  try {
    result = await deps.rpc("customer_reschedule_reservation", {
      ...credentialArgs(choice.credential),
      p_standby_id: choice.standbyId,
      p_target_session_id: choice.sessionId,
    });
  } catch (error) {
    return failure(selfServiceRescheduleError(error, choice.credential));
  }
  if (result.error) return failure(selfServiceRescheduleError(new Error(result.error.message), choice.credential));

  const resolution = parseStandbyResolution(result.data);
  if (!resolution || resolution.resolution !== "RESCHEDULED") {
    return failure({ status: 500, code: "FAILED", message: SELF_SERVICE_MESSAGES.FAILED });
  }

  let emailOutcome = "DISABLED";
  if (deps.sendConfirmationEmail && resolution.changeId) {
    const email = await deps.sendConfirmationEmail(resolution.changeId).catch(() => ({ outcome: "PENDING", retryable: true }));
    emailOutcome = email.outcome;
    if (email.outcome === "PENDING" && email.retryable !== false && deps.followUpConfirmationEmail && deps.afterResponse) {
      const followUp = deps.followUpConfirmationEmail;
      deps.afterResponse(() => followUp(resolution.changeId));
    }
  }

  // A repetição da mesma requisição não escreveu nada: não há o que sincronizar.
  if (!resolution.replayed && deps.syncSheet && deps.afterResponse) {
    const sync = deps.syncSheet;
    deps.afterResponse(() => sync(resolution.reservationId, resolution.previousSessionId).catch(() => undefined));
  }

  return {
    status: 200,
    body: {
      rescheduled: {
        publicCode: resolution.publicCode,
        replayed: resolution.replayed,
        quantity: resolution.quantity,
        startsAt: resolution.targetStartsAt,
        experienceTitle: resolution.targetExperienceTitle,
      },
      // Só o que a tela precisa para escolher o texto: saiu, ou ainda não.
      emailSent: emailOutcome === "SENT",
    },
  };
}
