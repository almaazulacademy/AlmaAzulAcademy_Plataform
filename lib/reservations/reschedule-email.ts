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
 */

import type { EmailMessage } from "../email/email-provider.ts";
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

// --- Tipos --------------------------------------------------------------------

/** O direito de enviar um e-mail, obtido do banco. Vale até o prazo vencer. */
export type RescheduleEmailClaim = {
  emailId: string;
  claimToken: string;
  attempt: number;
  reservationId: string;
  payload: unknown;
};

export type RescheduleEmailOutcome =
  /** Enviado agora. */
  | "SENT"
  /** Nada a fazer: já enviado, envio em curso, ou a reserva não está mais naquela turma. */
  | "SKIPPED"
  /** Não saiu; ficou na fila para nova tentativa. */
  | "PENDING"
  /** E-mail de reagendamento desligado, ou provedor não configurado. */
  | "DISABLED";

export type RescheduleEmailResult = {
  outcome: RescheduleEmailOutcome;
  errorCode?: string;
};

export type RescheduleRetryReport = {
  outcome: "PROCESSED" | "DISABLED" | "FAILED";
  processed: number;
  sent: number;
  errorCode?: string;
};

/** Estado do e-mail de um reagendamento, para o painel. */
export type RescheduleEmailState = {
  emailId: string;
  standbyId: string;
  status: "QUEUED" | "SENDING" | "SENT" | "FAILED" | "SKIPPED";
  inFlight: boolean;
  attempts: number;
  lastErrorCode: string | null;
  lastAttemptAt: string | null;
  sentAt: string | null;
  createdAt: string;
};

/** O mínimo do supabase-js de que a fila precisa. */
export type RescheduleRpcClient = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

export type RescheduleEmailQueue = {
  claim(changeId: string): Promise<RescheduleEmailClaim | null>;
  claimPending(limit: number): Promise<RescheduleEmailClaim[]>;
  claimForAdmin(actorUserId: string, reservationId: string): Promise<RescheduleEmailClaim | null>;
  complete(claim: RescheduleEmailClaim): Promise<void>;
  fail(claim: RescheduleEmailClaim, errorCode: string): Promise<void>;
  states(actorUserId: string, reservationId: string): Promise<RescheduleEmailState[]>;
};

export type RescheduleEmailRuntime = {
  queue: RescheduleEmailQueue;
  provider: { name: string; send(message: EmailMessage): Promise<void> };
  sanitizeError: (error: unknown) => string;
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

export function parseRescheduleEmailClaim(value: unknown): RescheduleEmailClaim | null {
  const row = asRow(value);
  if (!row) return null;
  const claim = {
    emailId: asString(row.emailId),
    claimToken: asString(row.claimToken),
    attempt: Number(row.attempt) || 0,
    reservationId: asString(row.reservationId),
    payload: row.payload ?? null,
  };
  return claim.emailId && claim.claimToken ? claim : null;
}

const STATUSES = ["QUEUED", "SENDING", "SENT", "FAILED", "SKIPPED"] as const;

export function parseRescheduleEmailStates(value: unknown): RescheduleEmailState[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = asRow(item);
    const status = STATUSES.find((candidate) => candidate === row?.status);
    if (!row || !status || !asString(row.emailId)) return [];
    return [{
      emailId: asString(row.emailId),
      standbyId: asString(row.standbyId),
      status,
      inFlight: row.inFlight === true,
      attempts: Number(row.attempts) || 0,
      lastErrorCode: nullableString(row.lastErrorCode),
      lastAttemptAt: nullableString(row.lastAttemptAt),
      sentAt: nullableString(row.sentAt),
      createdAt: asString(row.createdAt),
    }];
  });
}

/** true quando ainda há o que uma pessoa possa mandar reenviar. */
export function canResendRescheduleEmail(state: Pick<RescheduleEmailState, "status" | "inFlight">) {
  return state.status === "QUEUED" || state.status === "FAILED" || (state.status === "SENDING" && !state.inFlight);
}

const SKIP_REASONS: Record<string, string> = {
  SUPERSEDED: "a reserva mudou de turma de novo antes do envio",
  RESERVATION_NOT_CONFIRMED: "a reserva deixou de estar confirmada antes do envio",
  SESSION_STARTED: "a turma começou antes do envio",
};

/** Uma linha para o painel dizer o que aconteceu com o e-mail daquele reagendamento. */
export function rescheduleEmailSummary(state: RescheduleEmailState, formatDate: (value: string | null) => string) {
  if (state.status === "SENT") return `E-mail de confirmação enviado em ${formatDate(state.sentAt)}.`;
  if (state.status === "SKIPPED") {
    return `E-mail de confirmação não enviado: ${SKIP_REASONS[state.lastErrorCode ?? ""] ?? "deixou de ser necessário"}.`;
  }
  if (state.status === "FAILED") {
    return `E-mail de confirmação com erro (${state.lastErrorCode ?? "erro desconhecido"}), após ${state.attempts} tentativa(s). O reagendamento não foi afetado.`;
  }
  if (state.status === "SENDING" && state.inFlight) return "E-mail de confirmação em envio.";
  return "E-mail de confirmação pendente; será tentado de novo automaticamente.";
}

// --- Fila ---------------------------------------------------------------------

/**
 * Chave de idempotência no provedor: uma por reagendamento. Nada tem a ver com
 * a do e-mail de pagamento, que é a linha da reserva em `integration_sync_jobs`.
 */
export function rescheduleEmailIdempotencyKey(emailId: string) {
  return `reschedule-confirmation/${emailId}`;
}

export function createRescheduleEmailQueue(
  client: RescheduleRpcClient,
  options: { maxAttempts: number; leaseMinutes: number },
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
      }, "CLAIM_UNAVAILABLE"));
    },
    async claimPending(limit) {
      const claims = await call("claim_pending_reservation_reschedule_emails", {
        p_limit: limit,
        p_max_attempts: options.maxAttempts,
        p_lease_minutes: options.leaseMinutes,
      }, "CLAIM_UNAVAILABLE");
      return Array.isArray(claims)
        ? claims.flatMap((item) => parseRescheduleEmailClaim(item) ?? [])
        : [];
    },
    async claimForAdmin(actorUserId, reservationId) {
      return parseRescheduleEmailClaim(await call("admin_claim_reservation_reschedule_email", {
        p_actor_id: actorUserId,
        p_reservation_id: reservationId,
        p_lease_minutes: options.leaseMinutes,
      }, "CLAIM_UNAVAILABLE"));
    },
    async complete(claim) {
      const recorded = await call("complete_reservation_reschedule_email", {
        p_email_id: claim.emailId,
        p_claim_token: claim.claimToken,
      }, "COMPLETE_UNAVAILABLE");
      if (recorded !== true) throw new Error("COMPLETE_REJECTED");
    },
    async fail(claim, errorCode) {
      await call("fail_reservation_reschedule_email", {
        p_email_id: claim.emailId,
        p_claim_token: claim.claimToken,
        p_error_code: errorCode,
      }, "FAIL_UNAVAILABLE");
    },
    async states(actorUserId, reservationId) {
      return parseRescheduleEmailStates(await call("admin_reservation_reschedule_emails", {
        p_actor_id: actorUserId,
        p_reservation_id: reservationId,
      }, "STATE_UNAVAILABLE"));
    },
  };
}

// --- Envio --------------------------------------------------------------------

/** Quantas vezes insistir em registrar um envio que o provedor já aceitou. */
const COMPLETE_ATTEMPTS = 3;

/** Quantos pendentes um envio bem-sucedido recupera de carona. */
export const OPPORTUNISTIC_RESCHEDULE_DRAIN = 2;

/** Teto de uma execução da rotina de recuperação. */
export const MAX_RESCHEDULE_RETRY_BATCH = 10;

/** Erros da própria fila já são símbolos curtos; o resto passa pelo sanitizador. */
function errorCodeOf(runtime: RescheduleEmailRuntime, error: unknown) {
  return error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : runtime.sanitizeError(error);
}

/**
 * Envia um e-mail já reivindicado.
 *
 * Duas falhas diferentes, tratadas de formas diferentes:
 *
 *   * **o envio falhou** — a tentativa é devolvida à fila como FAILED;
 *   * **o envio deu certo, mas o registro falhou** — a fila nunca recebe FAILED,
 *     porque isso mandaria o mesmo e-mail de novo. O registro é repetido aqui e,
 *     se não der, a linha fica SENDING até o prazo vencer; a nova tentativa usa
 *     a mesma chave de idempotência e o provedor não entrega outra vez.
 */
async function deliverClaimed(
  runtime: RescheduleEmailRuntime,
  claim: RescheduleEmailClaim,
  stage: "reschedule" | "reschedule_retry",
): Promise<RescheduleEmailResult> {
  const startedAt = Date.now();
  const base = { stage, reservationId: claim.reservationId, provider: runtime.provider.name, attempt: claim.attempt };

  const failed = async (errorCode: string): Promise<RescheduleEmailResult> => {
    await runtime.queue.fail(claim, errorCode).catch(() => undefined);
    runtime.log?.({ ...base, outcome: "pending", errorCode, durationMs: Date.now() - startedAt });
    return { outcome: "PENDING", errorCode };
  };

  // Reserva sem e-mail utilizável: fica visível como erro até alguém corrigir o
  // cadastro e pedir o reenvio.
  const data = parseReservationConfirmationData(claim.payload);
  if (!data) return failed("PAYLOAD_EMPTY");

  try {
    await runtime.provider.send({
      ...buildReservationRescheduleEmail(data),
      idempotencyKey: rescheduleEmailIdempotencyKey(claim.emailId),
    });
  } catch (error) {
    return failed(runtime.sanitizeError(error));
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
    const errorCode = errorCodeOf(runtime, error);
    runtime.log?.({ stage: "reschedule", outcome: "failed", errorCode });
    return { outcome: "PENDING", errorCode };
  }
}

/** Recupera pendências sem depender de um novo reagendamento. Nunca lança. */
export async function retryPendingRescheduleEmails(runtime: RescheduleEmailRuntime, limit = MAX_RESCHEDULE_RETRY_BATCH): Promise<RescheduleRetryReport> {
  try {
    const report = await drain(runtime, Math.max(1, Math.min(limit, MAX_RESCHEDULE_RETRY_BATCH)));
    runtime.log?.({ stage: "reschedule_retry", outcome: report.sent ? "sent" : "skipped", provider: runtime.provider.name, drained: report.sent });
    return { outcome: "PROCESSED", ...report };
  } catch (error) {
    const errorCode = errorCodeOf(runtime, error);
    runtime.log?.({ stage: "reschedule_retry", outcome: "failed", errorCode });
    return { outcome: "FAILED", processed: 0, sent: 0, errorCode };
  }
}

/**
 * "Reenviar e-mail de reagendamento", pelo painel. Nunca lança.
 *
 * O banco confere de novo quem pede e o que há para enviar: e-mail já enviado
 * não é reenviado, e clicar dez vezes não gera dez e-mails.
 */
export async function resendRescheduleEmail(runtime: RescheduleEmailRuntime, actorUserId: string, reservationId: string): Promise<RescheduleEmailResult> {
  try {
    const claim = await runtime.queue.claimForAdmin(actorUserId, reservationId);
    if (!claim) return { outcome: "SKIPPED" };
    return await deliverClaimed(runtime, claim, "reschedule_retry");
  } catch (error) {
    const errorCode = errorCodeOf(runtime, error);
    runtime.log?.({ stage: "reschedule_retry", outcome: "failed", reservationId, errorCode });
    return { outcome: "PENDING", errorCode };
  }
}
