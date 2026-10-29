/**
 * E-mail de confirmação do reagendamento vindo de Stand-by: a fila e o envio.
 *
 * Sem Next e sem Supabase de propósito — recebe um cliente de RPC e um provedor
 * de e-mail. É o que permite exercitar o fluxo inteiro contra um Postgres real
 * em memória, com um provedor falso, sem nunca enviar um e-mail de verdade.
 *
 * Quem decide se um e-mail sai é o banco. A linha da fila nasce na mesma
 * transação que reagenda a reserva (`reservation_reschedule_emails`), e só envia
 * quem a reivindica. Este módulo nunca escolhe destinatário, nunca cria evento e
 * nunca reenvia o e-mail de pagamento: a fila de lá (`integration_sync_jobs`)
 * não é lida nem escrita aqui.
 *
 * ## O que se sabe depois de uma tentativa
 *
 * Uma tentativa que não deu certo é uma de três coisas, e cada uma tem um
 * tratamento:
 *
 *   REJECTED — o provedor recusou (4xx). Nada saiu: a próxima tentativa pode
 *              usar chave nova e mensagem renderizada de novo.
 *   UNKNOWN  — timeout, rede, 5xx, instância que morreu no meio. Pode ter saído.
 *              A próxima tentativa reusa a **mesma chave e a mesma mensagem**,
 *              byte a byte: é o que faz o provedor reconhecer a repetição.
 *   KEY_REFUSED — o provedor recusou a chave (409). Pode ser um pedido ainda em
 *              curso: a próxima tentativa repete, como em UNKNOWN. Se a recusa
 *              se repetir, é conflito — o banco para e uma pessoa decide.
 *
 * Um envio com resultado desconhecido nunca é tratado como "não enviado".
 */

import { emailDeliveryOf, isRetryableEmailError, sanitizeEmailErrorCode, type EmailMessage } from "../email/email-provider.ts";
import { buildReservationRescheduleEmail, parseReservationConfirmationData } from "./confirmation-email.ts";

// --- Ativação -----------------------------------------------------------------

/**
 * O e-mail de reagendamento só sai quando `STANDBY_RESCHEDULE_EMAIL_ENABLED=true`.
 *
 * Publicar o código não ativa nada. Sem a variável, o reagendamento acontece
 * igual, a linha da fila é gravada pelo banco e fica QUEUED: nada é
 * reivindicado e nada é enviado. É variável de servidor — nunca `NEXT_PUBLIC_`.
 */
export function isRescheduleEmailEnabled(env: Record<string, string | undefined> = process.env) {
  return (env.STANDBY_RESCHEDULE_EMAIL_ENABLED ?? "").trim().toLowerCase() === "true";
}

// --- Política -----------------------------------------------------------------

/**
 * Por quanto tempo uma reivindicação vale. O envio tem timeout de 8 segundos e a
 * função que o faz não vive mais que um minuto: passados dois, quem reivindicou
 * não está mais enviando.
 */
export const RESCHEDULE_EMAIL_LEASE_MINUTES = 2;

/** Tentativas automáticas. Depois disso o e-mail espera uma pessoa. */
export const RESCHEDULE_EMAIL_MAX_ATTEMPTS = 6;

/**
 * Espera, em segundos, depois da 1ª, 2ª, … tentativa que não deu certo. As duas
 * primeiras cabem na própria requisição que reagendou; as seguintes dependem de
 * alguém ou algo acionar a fila — o painel aberto, outro reagendamento, a rotina.
 */
export const RESCHEDULE_RETRY_BACKOFF_SECONDS = [3, 15, 300, 1800, 7200] as const;

/** Quantas novas tentativas a requisição que reagendou faz em segundo plano. */
export const RESCHEDULE_FOLLOW_UP_ATTEMPTS = 2;

/**
 * O Resend guarda a chave de idempotência por 24 horas. A fila para uma hora
 * antes: daí em diante uma repetição poderia ser entregue como e-mail novo.
 */
export const RESCHEDULE_IDEMPOTENCY_WINDOW_MINUTES = 23 * 60;

/** Quantos pendentes um envio bem-sucedido recupera de carona. */
export const OPPORTUNISTIC_RESCHEDULE_DRAIN = 2;

/** Teto de uma execução da rotina de recuperação. */
export const MAX_RESCHEDULE_RETRY_BATCH = 10;

/** Quantas vezes insistir em registrar um envio que o provedor já aceitou. */
const COMPLETE_ATTEMPTS = 3;

/** Uma recusa que repetir não resolve (chave inválida, domínio não verificado) espera pelo menos isto. */
const NON_RETRYABLE_MIN_BACKOFF_INDEX = 2;

// --- Tipos --------------------------------------------------------------------

/** Os quatro campos de um e-mail, exatamente como vão para o provedor. */
export type RescheduleEmailContent = { to: string; subject: string; html: string; text: string };

/** O direito de enviar um e-mail, obtido do banco. Vale até o prazo vencer. */
export type RescheduleEmailClaim = {
  emailId: string;
  claimToken: string;
  attempt: number;
  /** Número da chave de idempotência em uso. Muda só quando é seguro mudar. */
  generation: number;
  reservationId: string;
  /** Preenchida quando a tentativa repete uma geração: é ela que precisa ser enviada. */
  message: RescheduleEmailContent | null;
  payload: unknown;
};

/** O que se sabe sobre uma tentativa que não deu certo. */
export type RescheduleFailureKind = "REJECTED" | "UNKNOWN" | "KEY_REFUSED";

export type RescheduleEmailOutcome =
  /** Enviado agora. */
  | "SENT"
  /** Nada a fazer: já enviado, envio em curso, ou a reserva não está mais naquela turma. */
  | "SKIPPED"
  /** Não saiu; ficou na fila para nova tentativa. */
  | "PENDING"
  /** Só no reenvio pelo painel: a entrega anterior não foi confirmada, e reenviar exige aceitar o risco de duplicidade. */
  | "NEEDS_CONFIRMATION"
  /** E-mail de reagendamento desligado, ou provedor não configurado. */
  | "DISABLED";

export type RescheduleEmailResult = {
  outcome: RescheduleEmailOutcome;
  errorCode?: string;
  /** Com PENDING: true quando vale tentar de novo em seguida. */
  retryable?: boolean;
};

export type RescheduleRetryReport = {
  outcome: "PROCESSED" | "DISABLED" | "FAILED";
  processed: number;
  sent: number;
  errorCode?: string;
};

export type RescheduleEmailStatus = "QUEUED" | "SENDING" | "SENT" | "FAILED" | "UNCERTAIN" | "SKIPPED";

/** Estado do e-mail de um reagendamento, para o painel. */
export type RescheduleEmailState = {
  emailId: string;
  standbyId: string;
  status: RescheduleEmailStatus;
  inFlight: boolean;
  attempts: number;
  lastErrorCode: string | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  sentAt: string | null;
  createdAt: string;
};

/** Um cliente que ainda não recebeu a confirmação do reagendamento. */
export type UndeliveredRescheduleEmail = {
  emailId: string;
  reservationId: string;
  publicCode: string;
  fullName: string;
  phone: string;
  status: RescheduleEmailStatus;
  inFlight: boolean;
  attempts: number;
  lastErrorCode: string | null;
  nextAttemptAt: string | null;
  rescheduledAt: string;
  targetStartsAt: string;
  experienceTitle: string;
  baseName: string;
};

export type UndeliveredRescheduleEmails = { total: number; items: UndeliveredRescheduleEmail[] };

/** O mínimo do supabase-js de que a fila precisa. */
export type RescheduleRpcClient = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

export type RescheduleEmailQueue = {
  claim(changeId: string): Promise<RescheduleEmailClaim | null>;
  claimPending(limit: number): Promise<RescheduleEmailClaim[]>;
  /** `acceptUncertain`: a pessoa viu o aviso e aceita o risco de o cliente receber duas vezes. */
  claimForAdmin(actorUserId: string, reservationId: string, acceptUncertain: boolean): Promise<RescheduleEmailClaim | "NEEDS_CONFIRMATION" | null>;
  /** Grava a mensagem da geração antes do envio. false = não congelou; nada pode ser enviado. */
  freeze(claim: RescheduleEmailClaim, message: RescheduleEmailContent): Promise<boolean>;
  complete(claim: RescheduleEmailClaim): Promise<void>;
  fail(claim: RescheduleEmailClaim, errorCode: string, kind: RescheduleFailureKind, retryable: boolean): Promise<void>;
  states(actorUserId: string, reservationId: string): Promise<RescheduleEmailState[]>;
  undelivered(actorUserId: string, limit: number): Promise<UndeliveredRescheduleEmails>;
};

export type RescheduleEmailRuntime = {
  queue: RescheduleEmailQueue;
  /**
   * Completa o payload com o conteúdo do evento especial
   * (`withEventEmailContext`). Ausente nos testes antigos: payload de sempre.
   */
  enrich?: (payload: unknown) => Promise<unknown>;
  provider: { name: string; send(message: EmailMessage): Promise<void> };
  /** Espera entre as tentativas em segundo plano. Os testes trocam por uma que não dorme. */
  wait?: (milliseconds: number) => Promise<void>;
  log?: (fields: {
    stage: "reschedule" | "reschedule_retry";
    outcome: "sent" | "skipped" | "pending" | "failed";
    reservationId?: string;
    provider?: string;
    attempt?: number;
    errorCode?: string;
    durationMs?: number;
    drained?: number;
  }) => void;
};

// --- Leitura das respostas do banco ------------------------------------------

type Row = Record<string, unknown>;

function asRow(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown) {
  return asString(value) || null;
}

const STATUSES: readonly RescheduleEmailStatus[] = ["QUEUED", "SENDING", "SENT", "FAILED", "UNCERTAIN", "SKIPPED"];

function asStatus(value: unknown) {
  return STATUSES.find((candidate) => candidate === value) ?? null;
}

/** A mensagem congelada só serve inteira: sem um dos campos, não há o que repetir. */
export function parseRescheduleEmailContent(value: unknown): RescheduleEmailContent | null {
  const row = asRow(value);
  if (!row) return null;
  const content = { to: asString(row.to), subject: asString(row.subject), html: asString(row.html), text: asString(row.text) };
  return content.to && content.subject && content.html && content.text ? content : null;
}

export function parseRescheduleEmailClaim(value: unknown): RescheduleEmailClaim | null {
  const row = asRow(value);
  if (!row) return null;
  const claim = {
    emailId: asString(row.emailId),
    claimToken: asString(row.claimToken),
    attempt: Number(row.attempt) || 0,
    generation: Number(row.generation) || 0,
    reservationId: asString(row.reservationId),
    message: parseRescheduleEmailContent(row.message),
    payload: row.payload ?? null,
  };
  return claim.emailId && claim.claimToken && claim.generation > 0 ? claim : null;
}

export function parseRescheduleEmailStates(value: unknown): RescheduleEmailState[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = asRow(item);
    const status = asStatus(row?.status);
    if (!row || !status || !asString(row.emailId)) return [];
    return [{
      emailId: asString(row.emailId),
      standbyId: asString(row.standbyId),
      status,
      inFlight: row.inFlight === true,
      attempts: Number(row.attempts) || 0,
      lastErrorCode: nullableString(row.lastErrorCode),
      lastAttemptAt: nullableString(row.lastAttemptAt),
      nextAttemptAt: nullableString(row.nextAttemptAt),
      sentAt: nullableString(row.sentAt),
      createdAt: asString(row.createdAt),
    }];
  });
}

export function parseUndeliveredRescheduleEmails(value: unknown): UndeliveredRescheduleEmails {
  const row = asRow(value);
  const items = Array.isArray(row?.items) ? row.items : [];
  return {
    total: Number(row?.total) || 0,
    items: items.flatMap((item) => {
      const entry = asRow(item);
      const status = asStatus(entry?.status);
      if (!entry || !status || !asString(entry.reservationId)) return [];
      return [{
        emailId: asString(entry.emailId),
        reservationId: asString(entry.reservationId),
        publicCode: asString(entry.publicCode),
        fullName: asString(entry.fullName),
        phone: asString(entry.phone),
        status,
        inFlight: entry.inFlight === true,
        attempts: Number(entry.attempts) || 0,
        lastErrorCode: nullableString(entry.lastErrorCode),
        nextAttemptAt: nullableString(entry.nextAttemptAt),
        rescheduledAt: asString(entry.rescheduledAt),
        targetStartsAt: asString(entry.targetStartsAt),
        experienceTitle: asString(entry.experienceTitle),
        baseName: asString(entry.baseName),
      }];
    }),
  };
}

// --- Textos do painel ---------------------------------------------------------

/** true enquanto o cliente ainda não recebeu e ainda há o que fazer a respeito. */
export function isRescheduleEmailUndelivered(state: Pick<RescheduleEmailState, "status">) {
  return state.status === "QUEUED" || state.status === "SENDING" || state.status === "FAILED" || state.status === "UNCERTAIN";
}

/** true quando ainda há o que uma pessoa possa mandar reenviar. */
export function canResendRescheduleEmail(state: Pick<RescheduleEmailState, "status" | "inFlight">) {
  return isRescheduleEmailUndelivered(state) && !(state.status === "SENDING" && state.inFlight);
}

const SKIP_REASONS: Record<string, string> = {
  SUPERSEDED: "a reserva mudou de turma de novo antes do envio",
  RESERVATION_NOT_CONFIRMED: "a reserva deixou de estar confirmada antes do envio",
  SESSION_STARTED: "a turma começou antes do envio",
};

/** "Entrega não confirmada": o que aconteceu e por que ninguém reenvia sozinho. */
export const UNCERTAIN_DELIVERY_NOTE =
  "O envio ficou sem resposta do provedor, e já não há como confirmar se o e-mail saiu. Confirme com o cliente antes de reenviar: um novo envio pode chegar em duplicidade.";

/** Uma linha para o painel dizer o que aconteceu com o e-mail daquele reagendamento. */
export function rescheduleEmailSummary(state: RescheduleEmailState, formatDate: (value: string | null) => string) {
  if (state.status === "SENT") return `E-mail de confirmação enviado em ${formatDate(state.sentAt)}.`;
  if (state.status === "SKIPPED") {
    return `E-mail de confirmação não enviado: ${SKIP_REASONS[state.lastErrorCode ?? ""] ?? "deixou de ser necessário"}.`;
  }
  if (state.status === "UNCERTAIN") return `Entrega do e-mail de confirmação não confirmada, após ${state.attempts} tentativa(s).`;
  if (state.status === "FAILED") {
    return `E-mail de confirmação com erro (${state.lastErrorCode ?? "erro desconhecido"}), após ${state.attempts} tentativa(s). O reagendamento não foi afetado.`;
  }
  if (state.status === "SENDING" && state.inFlight) return "E-mail de confirmação em envio.";
  return "E-mail de confirmação pendente; será tentado de novo automaticamente.";
}

/**
 * O que o painel diz, com destaque, enquanto o cliente não recebeu a
 * confirmação. null quando não há o que avisar (enviado, ou descartado).
 */
export function rescheduleEmailAlert(
  state: RescheduleEmailState,
  formatDate: (value: string | null) => string,
  maxAttempts: number = RESCHEDULE_EMAIL_MAX_ATTEMPTS,
): { title: string; description: string } | null {
  if (!isRescheduleEmailUndelivered(state)) return null;
  const title = "O cliente ainda não recebeu a confirmação do reagendamento";
  const error = state.lastErrorCode ?? "erro desconhecido";

  if (state.status === "UNCERTAIN") {
    return { title: "Não sabemos se o cliente recebeu a confirmação do reagendamento", description: UNCERTAIN_DELIVERY_NOTE };
  }
  if (state.status === "SENDING" && state.inFlight) {
    return { title, description: "O e-mail está sendo enviado agora. Atualize a página em instantes." };
  }
  if (state.status === "FAILED" && state.attempts >= maxAttempts) {
    return {
      title,
      description: `As ${state.attempts} tentativas automáticas falharam (${error}) e nenhuma outra será feita sozinha. Avise o cliente por outro canal e, corrigida a causa, use "Reenviar e-mail de reagendamento".`,
    };
  }
  if (state.status === "FAILED") {
    const next = state.nextAttemptAt ? `A próxima tentativa fica liberada em ${formatDate(state.nextAttemptAt)}` : "Uma nova tentativa já está liberada";
    return {
      title,
      description: `A tentativa ${state.attempts} falhou (${error}). ${next} e acontece quando a fila for acionada — ou agora, com "Reenviar e-mail de reagendamento". Se a experiência for em breve, avise o cliente por outro canal.`,
    };
  }
  return {
    title,
    description: "O e-mail está na fila e ainda não foi enviado. Se a experiência for em breve, avise o cliente por outro canal ou use \"Reenviar e-mail de reagendamento\".",
  };
}

/** Situação resumida de um e-mail ainda não entregue, para a lista do painel. */
export function undeliveredRescheduleEmailLabel(
  item: Pick<UndeliveredRescheduleEmail, "status" | "inFlight" | "attempts" | "lastErrorCode">,
  maxAttempts: number = RESCHEDULE_EMAIL_MAX_ATTEMPTS,
) {
  if (item.status === "UNCERTAIN") return "Entrega não confirmada — confirme com o cliente antes de reenviar";
  if (item.status === "SENDING" && item.inFlight) return "Enviando agora";
  if (item.status === "FAILED" && item.attempts >= maxAttempts) return `Falhou ${item.attempts} vezes (${item.lastErrorCode ?? "erro desconhecido"}) — só sai com reenvio manual`;
  if (item.status === "FAILED" || item.status === "SENDING") return `Falhou (${item.lastErrorCode ?? "erro desconhecido"}) — nova tentativa pendente`;
  return "Na fila, ainda não enviado";
}

// --- Fila ---------------------------------------------------------------------

/**
 * Chave de idempotência no provedor: uma por geração de um reagendamento.
 *
 * Não leva nada do conteúdo, de propósito. A proteção do provedor é "mesma
 * chave, mesmo corpo → não entrega de novo"; uma chave que mudasse com o
 * conteúdo transformaria qualquer alteração de template ou de cadastro em e-mail
 * novo. Quem decide quando a chave pode mudar é o banco, pela geração. Nada tem a
 * ver com a do e-mail de pagamento, que é a linha da reserva em
 * `integration_sync_jobs`.
 */
export function rescheduleEmailIdempotencyKey(emailId: string, generation: number) {
  return `reschedule-confirmation/${emailId}/${generation}`;
}

/** Quanto esperar depois da tentativa `attempt`, que não deu certo. */
export function rescheduleRetryAfterSeconds(attempt: number, retryable: boolean, backoff: readonly number[] = RESCHEDULE_RETRY_BACKOFF_SECONDS) {
  const index = Math.max(attempt - 1, retryable ? 0 : NON_RETRYABLE_MIN_BACKOFF_INDEX);
  return backoff[Math.min(index, backoff.length - 1)] ?? 0;
}

export type RescheduleQueueOptions = {
  maxAttempts: number;
  leaseMinutes: number;
  windowMinutes: number;
  backoffSeconds: readonly number[];
};

export const DEFAULT_RESCHEDULE_QUEUE_OPTIONS: RescheduleQueueOptions = {
  maxAttempts: RESCHEDULE_EMAIL_MAX_ATTEMPTS,
  leaseMinutes: RESCHEDULE_EMAIL_LEASE_MINUTES,
  windowMinutes: RESCHEDULE_IDEMPOTENCY_WINDOW_MINUTES,
  backoffSeconds: RESCHEDULE_RETRY_BACKOFF_SECONDS,
};

export function createRescheduleEmailQueue(
  client: RescheduleRpcClient,
  options: RescheduleQueueOptions = DEFAULT_RESCHEDULE_QUEUE_OPTIONS,
): RescheduleEmailQueue {
  async function call(name: string, args: Record<string, unknown>, failure: string) {
    const result = await client.rpc(name, args);
    if (result.error) throw new Error(failure);
    return result.data;
  }

  return {
    async claim(changeId) {
      return parseRescheduleEmailClaim(await call("claim_reservation_reschedule_email", {
        p_change_id: changeId,
        p_max_attempts: options.maxAttempts,
        p_lease_minutes: options.leaseMinutes,
        p_window_minutes: options.windowMinutes,
      }, "CLAIM_UNAVAILABLE"));
    },
    async claimPending(limit) {
      const claims = await call("claim_pending_reservation_reschedule_emails", {
        p_limit: limit,
        p_max_attempts: options.maxAttempts,
        p_lease_minutes: options.leaseMinutes,
        p_window_minutes: options.windowMinutes,
      }, "CLAIM_UNAVAILABLE");
      return Array.isArray(claims)
        ? claims.flatMap((item) => parseRescheduleEmailClaim(item) ?? [])
        : [];
    },
    async claimForAdmin(actorUserId, reservationId, acceptUncertain) {
      const answer = await call("admin_claim_reservation_reschedule_email", {
        p_actor_id: actorUserId,
        p_reservation_id: reservationId,
        p_lease_minutes: options.leaseMinutes,
        p_window_minutes: options.windowMinutes,
        p_accept_uncertain: acceptUncertain,
      }, "CLAIM_UNAVAILABLE");
      if (asRow(answer)?.needsConfirmation === true) return "NEEDS_CONFIRMATION";
      return parseRescheduleEmailClaim(answer);
    },
    async freeze(claim, message) {
      const frozen = await call("freeze_reservation_reschedule_email", {
        p_email_id: claim.emailId,
        p_claim_token: claim.claimToken,
        p_message: { to: message.to, subject: message.subject, html: message.html, text: message.text },
      }, "FREEZE_UNAVAILABLE");
      return frozen === true;
    },
    async complete(claim) {
      const recorded = await call("complete_reservation_reschedule_email", {
        p_email_id: claim.emailId,
        p_claim_token: claim.claimToken,
      }, "COMPLETE_UNAVAILABLE");
      if (recorded !== true) throw new Error("COMPLETE_REJECTED");
    },
    async fail(claim, errorCode, kind, retryable) {
      await call("fail_reservation_reschedule_email", {
        p_email_id: claim.emailId,
        p_claim_token: claim.claimToken,
        p_error_code: errorCode,
        p_outcome: kind,
        p_retry_after_seconds: rescheduleRetryAfterSeconds(claim.attempt, retryable, options.backoffSeconds),
      }, "FAIL_UNAVAILABLE");
    },
    async states(actorUserId, reservationId) {
      return parseRescheduleEmailStates(await call("admin_reservation_reschedule_emails", {
        p_actor_id: actorUserId,
        p_reservation_id: reservationId,
      }, "STATE_UNAVAILABLE"));
    },
    async undelivered(actorUserId, limit) {
      return parseUndeliveredRescheduleEmails(await call("admin_list_undelivered_reschedule_emails", {
        p_actor_id: actorUserId,
        p_limit: limit,
      }, "STATE_UNAVAILABLE"));
    },
  };
}

// --- Envio --------------------------------------------------------------------

/** Erros da própria fila já são símbolos curtos; o resto passa pelo sanitizador. */
function errorCodeOf(error: unknown) {
  return error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : sanitizeEmailErrorCode(error);
}

/**
 * Envia um e-mail já reivindicado.
 *
 * A ordem é o que sustenta a idempotência:
 *
 *   1. **Mensagem.** Se a reivindicação trouxe a mensagem da geração, é ela que
 *      vai — nunca uma renderização nova, que poderia diferir em um byte e fazer
 *      o provedor entregar outra vez. Senão a mensagem é montada agora e
 *      **congelada no banco antes do envio**: se o congelamento falhar, nada é
 *      enviado.
 *   2. **Envio**, com a chave da geração.
 *   3. **Registro.** Se o envio falhou, a fila recebe o que se sabe (recusado,
 *      desconhecido ou chave recusada). Se o envio deu certo e o registro falhou, a
 *      fila nunca recebe "falhou" — isso autorizaria outro envio. O registro é
 *      repetido aqui; se não der, o prazo vence, a tentativa fica como
 *      desconhecida e a próxima repete a mesma chave e a mesma mensagem.
 */
async function deliverClaimed(
  runtime: RescheduleEmailRuntime,
  claim: RescheduleEmailClaim,
  stage: "reschedule" | "reschedule_retry",
): Promise<RescheduleEmailResult> {
  const startedAt = Date.now();
  const base = { stage, reservationId: claim.reservationId, provider: runtime.provider.name, attempt: claim.attempt };

  const failed = async (errorCode: string, kind: RescheduleFailureKind, retryable: boolean): Promise<RescheduleEmailResult> => {
    await runtime.queue.fail(claim, errorCode, kind, retryable).catch(() => undefined);
    runtime.log?.({ ...base, outcome: "pending", errorCode, durationMs: Date.now() - startedAt });
    return { outcome: "PENDING", errorCode, retryable };
  };

  let message = claim.message;
  if (!message) {
    // Reserva sem e-mail utilizável: fica visível como erro até alguém corrigir
    // o cadastro e pedir o reenvio.
    let payload: unknown = claim.payload;
    try {
      payload = runtime.enrich ? await runtime.enrich(claim.payload) : claim.payload;
    } catch {
      return failed("EVENT_CONTEXT_UNAVAILABLE", "REJECTED", true);
    }
    const data = parseReservationConfirmationData(payload);
    if (!data) return failed("PAYLOAD_EMPTY", "REJECTED", false);

    try {
      message = buildReservationRescheduleEmail(data);
    } catch {
      // Ingresso de evento sem conteúdo de e-mail: nunca o e-mail genérico.
      return failed("EVENT_EMAIL_NOT_READY", "REJECTED", true);
    }
    const frozen = await runtime.queue.freeze(claim, message).catch(() => false);
    // Sem a mensagem gravada não há como repetir este envio com segurança.
    if (!frozen) return failed("FREEZE_FAILED", "REJECTED", true);
  }

  try {
    await runtime.provider.send({ ...message, idempotencyKey: rescheduleEmailIdempotencyKey(claim.emailId, claim.generation) });
  } catch (error) {
    const delivery = emailDeliveryOf(error);
    return failed(sanitizeEmailErrorCode(error), delivery === "NOT_SENT" ? "REJECTED" : delivery, isRetryableEmailError(error));
  }

  for (let attempt = 1; attempt <= COMPLETE_ATTEMPTS; attempt += 1) {
    try {
      await runtime.queue.complete(claim);
      runtime.log?.({ ...base, outcome: "sent", durationMs: Date.now() - startedAt });
      return { outcome: "SENT" };
    } catch {
      // Tenta de novo: o que falta é só gravar que o e-mail saiu.
    }
  }

  // Estado ambíguo e raro: o cliente recebeu, a fila ainda não sabe. Nunca esconder.
  runtime.log?.({ ...base, outcome: "failed", errorCode: "SENT_NOT_RECORDED", durationMs: Date.now() - startedAt });
  return { outcome: "SENT", errorCode: "SENT_NOT_RECORDED" };
}

async function drain(runtime: RescheduleEmailRuntime, limit: number) {
  const claims = await runtime.queue.claimPending(limit);
  let sent = 0;
  for (const claim of claims) {
    const result = await deliverClaimed(runtime, claim, "reschedule_retry");
    if (result.outcome === "SENT") sent += 1;
  }
  return { processed: claims.length, sent };
}

/**
 * Envia a confirmação de um reagendamento que acabou de ser gravado. Nunca lança.
 *
 * `changeId` é a linha do histórico devolvida pela operação de reagendamento. A
 * requisição repetida devolve o mesmo `changeId`, e a reivindicação responde
 * null porque o e-mail já saiu ou está saindo: repetir não duplica.
 */
export async function sendRescheduleEmailForChange(runtime: RescheduleEmailRuntime, changeId: string): Promise<RescheduleEmailResult> {
  try {
    const claim = await runtime.queue.claim(changeId);
    if (!claim) return { outcome: "SKIPPED" };

    const result = await deliverClaimed(runtime, claim, "reschedule");
    // Só recupera pendências quando o envio principal deu certo: com o provedor
    // fora, insistir em mais dois só atrasaria a resposta de quem reagendou.
    if (result.outcome === "SENT") await drain(runtime, OPPORTUNISTIC_RESCHEDULE_DRAIN).catch(() => undefined);
    return result;
  } catch (error) {
    const errorCode = errorCodeOf(error);
    runtime.log?.({ stage: "reschedule", outcome: "failed", errorCode });
    return { outcome: "PENDING", errorCode, retryable: true };
  }
}

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * As novas tentativas da própria requisição que reagendou, feitas em segundo
 * plano depois da resposta. Nunca lança.
 *
 * Existe para a falha passageira — um timeout, um 5xx, um limite de taxa — não
 * esperar a rotina do dia seguinte. Cada tentativa é uma reivindicação como
 * outra qualquer: respeita a espera gravada pelo banco, reusa a chave e a
 * mensagem quando o resultado anterior é desconhecido, e para assim que o e-mail
 * sai, deixa de fazer sentido, é pego por outra instância ou recebe uma recusa
 * que repetir não resolve.
 */
export async function followUpRescheduleEmail(
  runtime: RescheduleEmailRuntime,
  changeId: string,
  options: { attempts?: number; backoffSeconds?: readonly number[] } = {},
): Promise<RescheduleEmailResult> {
  const attempts = options.attempts ?? RESCHEDULE_FOLLOW_UP_ATTEMPTS;
  const backoff = options.backoffSeconds ?? RESCHEDULE_RETRY_BACKOFF_SECONDS;
  const wait = runtime.wait ?? sleep;
  let last: RescheduleEmailResult = { outcome: "PENDING", retryable: true };

  try {
    for (let index = 0; index < attempts; index += 1) {
      // Meio segundo além da espera do banco: a próxima reivindicação só é
      // aceita depois de `next_attempt_at`.
      await wait((backoff[Math.min(index, backoff.length - 1)] ?? 0) * 1000 + 500);

      const claim = await runtime.queue.claim(changeId);
      if (!claim) return { outcome: "SKIPPED" };

      last = await deliverClaimed(runtime, claim, "reschedule_retry");
      if (last.outcome !== "PENDING" || last.retryable === false) return last;
    }
    return last;
  } catch (error) {
    const errorCode = errorCodeOf(error);
    runtime.log?.({ stage: "reschedule_retry", outcome: "failed", errorCode });
    return { outcome: "PENDING", errorCode, retryable: true };
  }
}

/** Recupera pendências sem depender de um novo reagendamento. Nunca lança. */
export async function retryPendingRescheduleEmails(runtime: RescheduleEmailRuntime, limit = MAX_RESCHEDULE_RETRY_BATCH): Promise<RescheduleRetryReport> {
  try {
    const report = await drain(runtime, Math.max(1, Math.min(limit, MAX_RESCHEDULE_RETRY_BATCH)));
    runtime.log?.({ stage: "reschedule_retry", outcome: report.sent ? "sent" : "skipped", provider: runtime.provider.name, drained: report.sent });
    return { outcome: "PROCESSED", ...report };
  } catch (error) {
    const errorCode = errorCodeOf(error);
    runtime.log?.({ stage: "reschedule_retry", outcome: "failed", errorCode });
    return { outcome: "FAILED", processed: 0, sent: 0, errorCode };
  }
}

/**
 * "Reenviar e-mail de reagendamento", pelo painel. Nunca lança.
 *
 * O banco confere de novo quem pede e o que há para enviar: e-mail já enviado
 * não é reenviado, e clicar dez vezes não gera dez e-mails. É também o único
 * caminho que reabre um e-mail com entrega não confirmada — e só com
 * `acceptUncertain`, que significa "a pessoa viu o aviso de possível
 * duplicidade e decidiu reenviar". Sem ele, a resposta é NEEDS_CONFIRMATION e
 * nada é enviado.
 */
export async function resendRescheduleEmail(
  runtime: RescheduleEmailRuntime,
  actorUserId: string,
  reservationId: string,
  options: { acceptUncertain?: boolean } = {},
): Promise<RescheduleEmailResult> {
  try {
    const claim = await runtime.queue.claimForAdmin(actorUserId, reservationId, options.acceptUncertain === true);
    if (claim === "NEEDS_CONFIRMATION") return { outcome: "NEEDS_CONFIRMATION" };
    if (!claim) return { outcome: "SKIPPED" };
    return await deliverClaimed(runtime, claim, "reschedule_retry");
  } catch (error) {
    const errorCode = errorCodeOf(error);
    runtime.log?.({ stage: "reschedule_retry", outcome: "failed", reservationId, errorCode });
    return { outcome: "PENDING", errorCode, retryable: true };
  }
}
