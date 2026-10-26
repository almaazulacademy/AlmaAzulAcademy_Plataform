/**
 * Aviso de vaga da lista de espera: a fila e o envio.
 *
 * Mesmo protocolo da confirmação da inscrição (`joined-email.ts`), com a régua
 * do aviso de vaga, que é do banco (`202610260002_waitlist_spot_email.sql`):
 * antes de cada tentativa a vaga, a turma, a abertura e os limites da inscrição
 * são conferidos de novo; um aviso que já não descreve uma vaga real é
 * descartado sem sair. Congelar e falhar reaproveitam as funções da fase 3;
 * reivindicar e concluir são as do aviso de vaga — concluir conta o aviso na
 * inscrição (12 horas e 3 avisos).
 *
 * Sem Next e sem Supabase: recebe um cliente de RPC e um provedor de e-mail.
 */

import { emailDeliveryOf, isRetryableEmailError, sanitizeEmailErrorCode, type EmailMessage } from "../email/email-provider.ts";
import {
  parseWaitlistEmailClaim,
  waitlistRetryAfterSeconds,
  WAITLIST_EMAIL_LEASE_MINUTES,
  WAITLIST_EMAIL_MAX_ATTEMPTS,
  WAITLIST_IDEMPOTENCY_WINDOW_MINUTES,
  type WaitlistEmailClaim,
  type WaitlistEmailContent,
  type WaitlistFailureKind,
  type WaitlistRetryReport,
  type WaitlistRpcClient,
} from "./joined-email.ts";
import { buildWaitlistSpotEmail, parseWaitlistSpotEmailData } from "./spot-email-content.ts";

/**
 * Quantos avisos uma execução reivindica de uma vez. Pequeno de propósito: o que
 * é reivindicado é enviado na mesma execução, e cinco envios cabem no tempo da
 * função mesmo com o Resend respondendo no limite do timeout (8 s cada).
 */
export const WAITLIST_SPOT_BATCH = 5;

/** Teto de lotes por execução. Na prática quem para é o orçamento de tempo. */
export const WAITLIST_SPOT_MAX_BATCHES = 10;

/**
 * Intervalo mínimo entre dois envios. O Resend limita a conta inteira (cerca de
 * 2 pedidos por segundo); um envio por segundo deixa metade para os e-mails de
 * reserva, pagamento e Stand-by, que nunca devem esbarrar numa onda de avisos.
 */
export const WAITLIST_SPOT_SPACING_MS = 1000;

/**
 * Depois deste tempo, a execução não reivindica outro lote: termina o que já
 * pegou e para. 10 s + 5 envios × (8 s + 1 s) = 55 s, dentro dos 60 s da rota.
 */
export const WAITLIST_SPOT_CLAIM_BUDGET_MS = 10_000;

const COMPLETE_ATTEMPTS = 3;

/**
 * A variável do envio. Só `WAITLIST_NOTIFY_ENABLED=true` liga; ausente, a rota
 * responde "desligado" sem tocar no banco nem no provedor. Variável de servidor.
 */
export function isWaitlistNotifyEnabled(env: Record<string, string | undefined> = process.env) {
  return (env.WAITLIST_NOTIFY_ENABLED ?? "").trim().toLowerCase() === "true";
}

/** Chave de idempotência do aviso de vaga: uma por geração, nada do conteúdo. */
export function waitlistSpotIdempotencyKey(notificationId: string, generation: number) {
  return `waitlist-spot/${notificationId}/${generation}`;
}

export type WaitlistSpotQueue = {
  claimPending(limit: number): Promise<WaitlistEmailClaim[]>;
  freeze(claim: WaitlistEmailClaim, message: WaitlistEmailContent): Promise<boolean>;
  complete(claim: WaitlistEmailClaim): Promise<void>;
  fail(claim: WaitlistEmailClaim, errorCode: string, kind: WaitlistFailureKind, retryable: boolean): Promise<void>;
};

export type WaitlistSpotRuntime = {
  queue: WaitlistSpotQueue;
  provider: { name: string; send(message: EmailMessage): Promise<void> };
  /** Origem dos links (reservar e sair da lista). Padrão: o domínio oficial. */
  origin?: string;
  log?: (fields: { stage: "waitlist_spot"; outcome: "sent" | "skipped" | "pending" | "failed"; attempt?: number; errorCode?: string; drained?: number }) => void;
  /** Espera entre envios. Padrão: `setTimeout`. Os testes trocam por nada. */
  pause?: (milliseconds: number) => Promise<void>;
  /** Relógio do orçamento de tempo. Padrão: `Date.now`. */
  now?: () => number;
};

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export function createWaitlistSpotQueue(client: WaitlistRpcClient): WaitlistSpotQueue {
  async function call(name: string, args: Record<string, unknown>, failure: string) {
    const result = await client.rpc(name, args);
    if (result.error) throw new Error(failure);
    return result.data;
  }

  return {
    async claimPending(limit) {
      const claims = await call("claim_pending_waitlist_spot_emails", {
        p_limit: limit,
        p_max_attempts: WAITLIST_EMAIL_MAX_ATTEMPTS,
        p_lease_minutes: WAITLIST_EMAIL_LEASE_MINUTES,
        p_window_minutes: WAITLIST_IDEMPOTENCY_WINDOW_MINUTES,
      }, "CLAIM_UNAVAILABLE");
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
      const recorded = await call("complete_waitlist_spot_email", { p_notification_id: claim.notificationId, p_claim_token: claim.claimToken }, "COMPLETE_UNAVAILABLE");
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

function errorCodeOf(error: unknown) {
  return error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : sanitizeEmailErrorCode(error);
}

/**
 * Envia um aviso já reivindicado: a mensagem congelada, ou montada agora e
 * congelada **antes** do envio; o envio com a chave da geração; e o registro.
 * Um envio que deu certo nunca é registrado como falha.
 */
async function deliverClaimed(runtime: WaitlistSpotRuntime, claim: WaitlistEmailClaim) {
  const failed = async (errorCode: string, kind: WaitlistFailureKind, retryable: boolean) => {
    await runtime.queue.fail(claim, errorCode, kind, retryable).catch(() => undefined);
    runtime.log?.({ stage: "waitlist_spot", outcome: "pending", attempt: claim.attempt, errorCode });
    return false;
  };

  let message = claim.message;
  if (!message) {
    const data = parseWaitlistSpotEmailData(claim.payload);
    if (!data) return failed("PAYLOAD_EMPTY", "REJECTED", false);
    message = buildWaitlistSpotEmail(data, runtime.origin);
    const frozen = await runtime.queue.freeze(claim, message).catch(() => false);
    if (!frozen) return failed("FREEZE_FAILED", "REJECTED", true);
  }

  try {
    await runtime.provider.send({ ...message, idempotencyKey: waitlistSpotIdempotencyKey(claim.notificationId, claim.generation) });
  } catch (error) {
    const delivery = emailDeliveryOf(error);
    return failed(sanitizeEmailErrorCode(error), delivery === "NOT_SENT" ? "REJECTED" : delivery, isRetryableEmailError(error));
  }

  for (let attempt = 1; attempt <= COMPLETE_ATTEMPTS; attempt += 1) {
    try {
      await runtime.queue.complete(claim);
      runtime.log?.({ stage: "waitlist_spot", outcome: "sent", attempt: claim.attempt });
      return true;
    } catch {
      // Só falta gravar que o e-mail saiu: tenta de novo.
    }
  }
  runtime.log?.({ stage: "waitlist_spot", outcome: "failed", attempt: claim.attempt, errorCode: "SENT_NOT_RECORDED" });
  return true;
}

/**
 * Drena a fila de avisos de vaga em lotes curtos, um envio por segundo, e para
 * de reivindicar quando o orçamento de tempo acaba (o resto fica para a próxima
 * execução). Nunca lança. É o que a rota agendada chama; rodar duas vezes ao
 * mesmo tempo não duplica nada — o banco entrega cada aviso a uma execução só.
 */
export async function sendPendingWaitlistSpotEmails(
  runtime: WaitlistSpotRuntime,
  options: { batch?: number; maxBatches?: number; spacingMs?: number; claimBudgetMs?: number } = {},
): Promise<WaitlistRetryReport> {
  const batch = Math.max(1, Math.min(options.batch ?? WAITLIST_SPOT_BATCH, 50));
  const maxBatches = Math.max(1, Math.min(options.maxBatches ?? WAITLIST_SPOT_MAX_BATCHES, 20));
  const spacing = Math.max(0, options.spacingMs ?? WAITLIST_SPOT_SPACING_MS);
  const budget = Math.max(0, options.claimBudgetMs ?? WAITLIST_SPOT_CLAIM_BUDGET_MS);
  const pause = runtime.pause ?? sleep;
  const now = runtime.now ?? Date.now;
  const started = now();
  let processed = 0;
  let sent = 0;
  try {
    for (let round = 0; round < maxBatches; round += 1) {
      if (round > 0 && now() - started >= budget) break;
      const claims = await runtime.queue.claimPending(batch);
      if (!claims.length) break;
      for (const claim of claims) {
        if (processed > 0 && spacing > 0) await pause(spacing);
        processed += 1;
        if (await deliverClaimed(runtime, claim)) sent += 1;
      }
      if (claims.length < batch) break;
    }
    runtime.log?.({ stage: "waitlist_spot", outcome: sent ? "sent" : "skipped", drained: sent });
    return { outcome: "PROCESSED", processed, sent };
  } catch (error) {
    const errorCode = errorCodeOf(error);
    runtime.log?.({ stage: "waitlist_spot", outcome: "failed", errorCode });
    return { outcome: "FAILED", processed, sent, errorCode };
  }
}
