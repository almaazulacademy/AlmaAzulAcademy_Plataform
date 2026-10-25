/**
 * E-mail de confirmação da inscrição na lista de espera: a fila e o envio.
 *
 * Sem Next e sem Supabase de propósito — recebe um cliente de RPC e um provedor
 * de e-mail —, como `lib/reservations/reschedule-email.ts`, cujo protocolo este
 * módulo repete: quem decide se um e-mail sai é o banco
 * (`202610250002_waitlist_signup_email.sql`), a mensagem é congelada antes do
 * envio, e um resultado desconhecido nunca é tratado como "não enviado".
 */

import { emailDeliveryOf, isRetryableEmailError, sanitizeEmailErrorCode, type EmailMessage } from "../email/email-provider.ts";
import { buildWaitlistJoinedEmail, parseWaitlistJoinedEmailData } from "./joined-email-content.ts";

// --- Política -----------------------------------------------------------------

/** Por quanto tempo uma reivindicação vale. O envio tem timeout de 8 segundos. */
export const WAITLIST_EMAIL_LEASE_MINUTES = 2;

/** Tentativas automáticas. Depois disso, só uma pessoa reenvia (painel, fase 4). */
export const WAITLIST_EMAIL_MAX_ATTEMPTS = 6;

/** Espera, em segundos, depois da 1ª, 2ª, … tentativa que não deu certo. */
export const WAITLIST_RETRY_BACKOFF_SECONDS = [3, 15, 300, 1800, 7200] as const;

/** Novas tentativas da própria requisição de inscrição, em segundo plano. */
export const WAITLIST_FOLLOW_UP_ATTEMPTS = 2;

/** O Resend guarda a chave por 24 horas; a fila para uma hora antes. */
export const WAITLIST_IDEMPOTENCY_WINDOW_MINUTES = 23 * 60;

/** Quantos pendentes um envio bem-sucedido recupera de carona. */
export const OPPORTUNISTIC_WAITLIST_DRAIN = 2;

/** Teto de uma execução da rotina de recuperação. */
export const MAX_WAITLIST_RETRY_BATCH = 10;

const COMPLETE_ATTEMPTS = 3;

/** Uma recusa que repetir não resolve espera pelo menos isto (índice no backoff). */
const NON_RETRYABLE_MIN_BACKOFF_INDEX = 2;

// --- Tipos --------------------------------------------------------------------

export type WaitlistEmailContent = { to: string; subject: string; html: string; text: string };

export type WaitlistEmailClaim = {
  notificationId: string;
  claimToken: string;
  attempt: number;
  generation: number;
  /** Preenchida quando a tentativa repete uma geração: é ela que precisa ser enviada. */
  message: WaitlistEmailContent | null;
  payload: unknown;
};

export type WaitlistFailureKind = "REJECTED" | "UNKNOWN" | "KEY_REFUSED";

export type WaitlistEmailResult = {
  outcome: "SENT" | "SKIPPED" | "PENDING" | "DISABLED";
  errorCode?: string;
  retryable?: boolean;
};

export type WaitlistRetryReport = { outcome: "PROCESSED" | "DISABLED" | "FAILED"; processed: number; sent: number; errorCode?: string };

export type WaitlistRpcClient = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

export type WaitlistEmailQueue = {
  claimJoined(sessionId: string, email: string): Promise<WaitlistEmailClaim | null>;
  claimPending(limit: number): Promise<WaitlistEmailClaim[]>;
  freeze(claim: WaitlistEmailClaim, message: WaitlistEmailContent): Promise<boolean>;
  complete(claim: WaitlistEmailClaim): Promise<void>;
  fail(claim: WaitlistEmailClaim, errorCode: string, kind: WaitlistFailureKind, retryable: boolean): Promise<void>;
};

export type WaitlistEmailRuntime = {
  queue: WaitlistEmailQueue;
  provider: { name: string; send(message: EmailMessage): Promise<void> };
  /** Espera entre as tentativas em segundo plano. Os testes trocam por uma que não dorme. */
  wait?: (milliseconds: number) => Promise<void>;
  /** Origem do link de cancelamento. Padrão: o domínio oficial. */
  origin?: string;
  log?: (fields: { stage: "waitlist_joined" | "waitlist_retry"; outcome: "sent" | "skipped" | "pending" | "failed"; attempt?: number; errorCode?: string; drained?: number }) => void;
};

// --- Leitura das respostas do banco -------------------------------------------

type Row = Record<string, unknown>;

function asRow(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function parseWaitlistEmailContent(value: unknown): WaitlistEmailContent | null {
  const row = asRow(value);
  if (!row) return null;
  const content = { to: asString(row.to), subject: asString(row.subject), html: asString(row.html), text: asString(row.text) };
  return content.to && content.subject && content.html && content.text ? content : null;
}

export function parseWaitlistEmailClaim(value: unknown): WaitlistEmailClaim | null {
  const row = asRow(value);
  if (!row) return null;
  const claim = {
    notificationId: asString(row.notificationId),
    claimToken: asString(row.claimToken),
    attempt: Number(row.attempt) || 0,
    generation: Number(row.generation) || 0,
    message: parseWaitlistEmailContent(row.message),
    payload: row.payload ?? null,
  };
  return claim.notificationId && claim.claimToken && claim.generation > 0 ? claim : null;
}

// --- Fila ---------------------------------------------------------------------

/**
 * Chave de idempotência no provedor: uma por geração. Não leva nada do
 * conteúdo: quem decide quando ela pode mudar é o banco, pela geração.
 */
export function waitlistEmailIdempotencyKey(notificationId: string, generation: number) {
  return `waitlist-joined/${notificationId}/${generation}`;
}

export function waitlistRetryAfterSeconds(attempt: number, retryable: boolean, backoff: readonly number[] = WAITLIST_RETRY_BACKOFF_SECONDS) {
  const index = Math.max(attempt - 1, retryable ? 0 : NON_RETRYABLE_MIN_BACKOFF_INDEX);
  return backoff[Math.min(index, backoff.length - 1)] ?? 0;
}

export function createWaitlistEmailQueue(client: WaitlistRpcClient): WaitlistEmailQueue {
  async function call(name: string, args: Record<string, unknown>, failure: string) {
    const result = await client.rpc(name, args);
    if (result.error) throw new Error(failure);
    return result.data;
  }

  const policy = {
    p_max_attempts: WAITLIST_EMAIL_MAX_ATTEMPTS,
    p_lease_minutes: WAITLIST_EMAIL_LEASE_MINUTES,
    p_window_minutes: WAITLIST_IDEMPOTENCY_WINDOW_MINUTES,
  };

  return {
    async claimJoined(sessionId, email) {
      return parseWaitlistEmailClaim(await call("claim_waitlist_joined_email", { p_session_id: sessionId, p_email: email, ...policy }, "CLAIM_UNAVAILABLE"));
    },
    async claimPending(limit) {
      const claims = await call("claim_pending_waitlist_emails", { p_limit: limit, ...policy }, "CLAIM_UNAVAILABLE");
      return Array.isArray(claims) ? claims.flatMap((item) => parseWaitlistEmailClaim(item) ?? []) : [];
    },
    async freeze(claim, message) {
      const frozen = await call("freeze_waitlist_email", {
        p_notification_id: claim.notificationId,
        p_claim_token: claim.claimToken,
        p_message: { to: message.to, subject: message.subject, html: message.html, text: message.text },
      }, "FREEZE_UNAVAILABLE");
      return frozen === true;
    },
    async complete(claim) {
      const recorded = await call("complete_waitlist_email", { p_notification_id: claim.notificationId, p_claim_token: claim.claimToken }, "COMPLETE_UNAVAILABLE");
      if (recorded !== true) throw new Error("COMPLETE_REJECTED");
    },
    async fail(claim, errorCode, kind, retryable) {
      await call("fail_waitlist_email", {
        p_notification_id: claim.notificationId,
        p_claim_token: claim.claimToken,
        p_error_code: errorCode,
        p_outcome: kind,
        p_retry_after_seconds: waitlistRetryAfterSeconds(claim.attempt, retryable),
      }, "FAIL_UNAVAILABLE");
    },
  };
}

// --- Envio --------------------------------------------------------------------

function errorCodeOf(error: unknown) {
  return error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : sanitizeEmailErrorCode(error);
}

/**
 * Envia um e-mail já reivindicado: mensagem (a congelada, ou montada agora e
 * congelada **antes** do envio), envio com a chave da geração, e registro. Um
 * envio que deu certo nunca é registrado como falha.
 */
async function deliverClaimed(runtime: WaitlistEmailRuntime, claim: WaitlistEmailClaim, stage: "waitlist_joined" | "waitlist_retry"): Promise<WaitlistEmailResult> {
  const failed = async (errorCode: string, kind: WaitlistFailureKind, retryable: boolean): Promise<WaitlistEmailResult> => {
    await runtime.queue.fail(claim, errorCode, kind, retryable).catch(() => undefined);
    runtime.log?.({ stage, outcome: "pending", attempt: claim.attempt, errorCode });
    return { outcome: "PENDING", errorCode, retryable };
  };

  let message = claim.message;
  if (!message) {
    const data = parseWaitlistJoinedEmailData(claim.payload);
    if (!data) return failed("PAYLOAD_EMPTY", "REJECTED", false);
    message = buildWaitlistJoinedEmail(data, runtime.origin);
    const frozen = await runtime.queue.freeze(claim, message).catch(() => false);
    if (!frozen) return failed("FREEZE_FAILED", "REJECTED", true);
  }

  try {
    await runtime.provider.send({ ...message, idempotencyKey: waitlistEmailIdempotencyKey(claim.notificationId, claim.generation) });
  } catch (error) {
    const delivery = emailDeliveryOf(error);
    return failed(sanitizeEmailErrorCode(error), delivery === "NOT_SENT" ? "REJECTED" : delivery, isRetryableEmailError(error));
  }

  for (let attempt = 1; attempt <= COMPLETE_ATTEMPTS; attempt += 1) {
    try {
      await runtime.queue.complete(claim);
      runtime.log?.({ stage, outcome: "sent", attempt: claim.attempt });
      return { outcome: "SENT" };
    } catch {
      // Só falta gravar que o e-mail saiu: tenta de novo.
    }
  }
  runtime.log?.({ stage, outcome: "failed", attempt: claim.attempt, errorCode: "SENT_NOT_RECORDED" });
  return { outcome: "SENT", errorCode: "SENT_NOT_RECORDED" };
}

async function drain(runtime: WaitlistEmailRuntime, limit: number) {
  const claims = await runtime.queue.claimPending(limit);
  let sent = 0;
  for (const claim of claims) {
    if ((await deliverClaimed(runtime, claim, "waitlist_retry")).outcome === "SENT") sent += 1;
  }
  return { processed: claims.length, sent };
}

/**
 * Envia a confirmação de uma inscrição recém-gravada. Nunca lança. Repetir a
 * mesma inscrição não duplica: a confirmação que já saiu, ou está saindo, não é
 * reivindicada de novo.
 */
export async function sendWaitlistJoinedEmail(runtime: WaitlistEmailRuntime, sessionId: string, email: string): Promise<WaitlistEmailResult> {
  try {
    const claim = await runtime.queue.claimJoined(sessionId, email);
    if (!claim) return { outcome: "SKIPPED" };
    const result = await deliverClaimed(runtime, claim, "waitlist_joined");
    if (result.outcome === "SENT") await drain(runtime, OPPORTUNISTIC_WAITLIST_DRAIN).catch(() => undefined);
    return result;
  } catch (error) {
    const errorCode = errorCodeOf(error);
    runtime.log?.({ stage: "waitlist_joined", outcome: "failed", errorCode });
    return { outcome: "PENDING", errorCode, retryable: true };
  }
}

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * Novas tentativas da própria inscrição, depois da resposta, para a falha
 * passageira não esperar a rotina do dia seguinte. Nunca lança.
 */
export async function followUpWaitlistJoinedEmail(
  runtime: WaitlistEmailRuntime,
  sessionId: string,
  email: string,
  options: { attempts?: number; backoffSeconds?: readonly number[] } = {},
): Promise<WaitlistEmailResult> {
  const attempts = options.attempts ?? WAITLIST_FOLLOW_UP_ATTEMPTS;
  const backoff = options.backoffSeconds ?? WAITLIST_RETRY_BACKOFF_SECONDS;
  const wait = runtime.wait ?? sleep;
  let last: WaitlistEmailResult = { outcome: "PENDING", retryable: true };
  try {
    for (let index = 0; index < attempts; index += 1) {
      await wait((backoff[Math.min(index, backoff.length - 1)] ?? 0) * 1000 + 500);
      const claim = await runtime.queue.claimJoined(sessionId, email);
      if (!claim) return { outcome: "SKIPPED" };
      last = await deliverClaimed(runtime, claim, "waitlist_retry");
      if (last.outcome !== "PENDING" || last.retryable === false) return last;
    }
    return last;
  } catch (error) {
    const errorCode = errorCodeOf(error);
    runtime.log?.({ stage: "waitlist_retry", outcome: "failed", errorCode });
    return { outcome: "PENDING", errorCode, retryable: true };
  }
}

/** Recupera pendências: rotina diária e inscrições seguintes. Nunca lança. */
export async function retryPendingWaitlistEmails(runtime: WaitlistEmailRuntime, limit = MAX_WAITLIST_RETRY_BATCH): Promise<WaitlistRetryReport> {
  try {
    const report = await drain(runtime, Math.max(1, Math.min(limit, MAX_WAITLIST_RETRY_BATCH)));
    runtime.log?.({ stage: "waitlist_retry", outcome: report.sent ? "sent" : "skipped", drained: report.sent });
    return { outcome: "PROCESSED", ...report };
  } catch (error) {
    const errorCode = errorCodeOf(error);
    runtime.log?.({ stage: "waitlist_retry", outcome: "failed", errorCode });
    return { outcome: "FAILED", processed: 0, sent: 0, errorCode };
  }
}
