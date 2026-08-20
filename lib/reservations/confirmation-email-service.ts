/**
 * Ponto central do e-mail de confirmação.
 *
 * Liga o Supabase e o provedor de e-mail à orquestração pura de
 * `confirmation-email.ts`. Chamado dos mesmos dois lugares que a sincronização
 * com a planilha — `confirmPayment()` e `confirmAdminReservation()` — o que
 * cobre webhook da InfinitePay, retorno do pagamento, "Verificar pagamento" e
 * confirmação manual sem duplicar lógica em nenhum endpoint.
 *
 * Regra inegociável, a mesma da planilha: **nada aqui pode derrubar o fluxo que
 * chamou.** Se o provedor de e-mail cair, a reserva continua CONFIRMED, o
 * pagamento continua confirmado, a vaga continua ocupada e o webhook continua
 * respondendo — o envio fica pendente e é retentado depois.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getEmailProvider,
  MAX_EMAIL_ATTEMPTS,
  OPPORTUNISTIC_EMAIL_DRAIN,
  STALE_EMAIL_MINUTES,
} from "@/lib/email";
import { sanitizeEmailErrorCode, type EmailProvider } from "@/lib/email/email-provider";
import { logEmail } from "@/lib/email/observability";
import {
  deliverReservationConfirmationEmail,
  type ConfirmationEmailResult,
} from "@/lib/reservations/confirmation-email";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

type PendingJob = { id: string; reservation_id: string; attempts: number };

/** Nome da integração na fila `integration_sync_jobs`. */
export const CONFIRMATION_EMAIL_INTEGRATION = "RESERVATION_CONFIRMATION_EMAIL";

/** Teto de uma execução da rotina de recuperação. */
export const MAX_RETRY_BATCH = 25;

export type RetryReport = {
  outcome: "PROCESSED" | "DISABLED" | "FAILED";
  processed: number;
  sent: number;
  errorCode?: string;
};

export type ConfirmationEmailState = {
  status: "SYNCED" | "PENDING" | "FAILED";
  attempts: number;
  lastErrorCode: string | null;
  sentAt: string | null;
};

const DISABLED: ConfirmationEmailResult = { outcome: "DISABLED" };

/**
 * Executa um envio já reivindicado ou a reivindicar.
 *
 * `claimedJobId` vem preenchido na recuperação de pendências, onde a
 * reivindicação já aconteceu no `claim_pending_confirmation_emails`.
 */
async function deliver(
  admin: SupabaseClient,
  provider: EmailProvider,
  reservationId: string,
  options: { claimedJobId?: string; stage: "confirmation" | "retry"; attempt?: number },
): Promise<ConfirmationEmailResult> {
  const startedAt = Date.now();

  const result = await deliverReservationConfirmationEmail({
    claim: async () => {
      if (options.claimedJobId) return options.claimedJobId;
      const claim = await admin.rpc("claim_reservation_confirmation_email", {
        p_reservation_id: reservationId,
        p_max_attempts: MAX_EMAIL_ATTEMPTS,
      });
      if (claim.error) throw new Error("CLAIM_UNAVAILABLE");
      return typeof claim.data === "string" && claim.data ? claim.data : null;
    },
    load: async () => {
      const payload = await admin.rpc("reservation_confirmation_email", { p_reservation_id: reservationId });
      if (payload.error) throw new Error("PAYLOAD_UNAVAILABLE");
      return payload.data;
    },
    send: (message) => provider.send(message),
    complete: async (jobId) => {
      await admin.rpc("complete_integration_sync_job", { p_job_id: jobId });
    },
    fail: async (jobId, errorCode) => {
      await admin.rpc("fail_integration_sync_job", { p_job_id: jobId, p_error_code: errorCode });
    },
    sanitizeError: sanitizeEmailErrorCode,
  });

  logEmail({
    stage: options.stage,
    outcome: result.outcome === "SENT" ? "sent" : result.outcome === "SKIPPED" ? "skipped" : "pending",
    reservationId,
    provider: provider.name,
    attempt: options.attempt,
    errorCode: result.errorCode,
    durationMs: Date.now() - startedAt,
  });

  return result;
}

/**
 * Recupera envios que falharam antes ou que ficaram presos.
 *
 * É a tentativa posterior sem cron e sem polling: a próxima reserva confirmada
 * carrega junto algumas pendências. O limite baixo mantém o webhook rápido.
 */
async function drainPendingEmails(admin: SupabaseClient, provider: EmailProvider, limit: number) {
  const claim = await admin.rpc("claim_pending_confirmation_emails", {
    p_limit: limit,
    p_max_attempts: MAX_EMAIL_ATTEMPTS,
    p_stale_minutes: STALE_EMAIL_MINUTES,
  });
  if (claim.error || !Array.isArray(claim.data) || claim.data.length === 0) return 0;

  let sent = 0;
  for (const job of claim.data as PendingJob[]) {
    const result = await deliver(admin, provider, job.reservation_id, {
      claimedJobId: job.id,
      stage: "retry",
      attempt: job.attempts + 1,
    });
    if (result.outcome === "SENT") sent += 1;
  }

  if (sent) logEmail({ stage: "retry", outcome: "sent", provider: provider.name, drained: sent });
  return sent;
}

/**
 * Envia a confirmação de uma reserva. Nunca lança.
 *
 * O status é conferido no banco, dentro de `claim_reservation_confirmation_email`:
 * reserva pendente, expirada ou cancelada nunca chega a gerar mensagem, e um
 * e-mail já enviado nunca é reenviado.
 */
export async function sendReservationConfirmationEmail(reservationId: string): Promise<ConfirmationEmailResult> {
  try {
    const provider = getEmailProvider();
    if (!provider) return DISABLED;

    const admin = getSupabaseAdminClient();
    if (!admin) return DISABLED;

    const result = await deliver(admin, provider, reservationId, { stage: "confirmation", attempt: 1 });

    // Só recupera pendências quando o envio principal deu certo: se o provedor
    // está fora, insistir em mais dois só atrasaria a resposta do webhook.
    if (result.outcome === "SENT") await drainPendingEmails(admin, provider, OPPORTUNISTIC_EMAIL_DRAIN).catch(() => 0);

    return result;
  } catch (error) {
    // Rede de segurança final. Nada pode escapar para quem confirmou o pagamento.
    const errorCode = sanitizeEmailErrorCode(error);
    logEmail({ stage: "confirmation", outcome: "failed", reservationId, errorCode });
    return { outcome: "PENDING", errorCode };
  }
}

/**
 * Recupera envios pendentes sem depender de uma nova confirmação chegar.
 *
 * É o que a rotina agendada e a ação administrativa chamam. Continua idempotente
 * pelo mesmo motivo de sempre: quem não reivindica não envia, e a reivindicação
 * ignora job já concluído. Uma reserva cancelada depois da confirmação também é
 * descartada aqui, na própria consulta.
 */
export async function retryPendingConfirmationEmails(limit = MAX_RETRY_BATCH): Promise<RetryReport> {
  const provider = getEmailProvider();
  if (!provider) return { outcome: "DISABLED", processed: 0, sent: 0 };

  const admin = getSupabaseAdminClient();
  if (!admin) return { outcome: "DISABLED", processed: 0, sent: 0 };

  try {
    const claim = await admin.rpc("claim_pending_confirmation_emails", {
      p_limit: Math.max(1, Math.min(limit, MAX_RETRY_BATCH)),
      p_max_attempts: MAX_EMAIL_ATTEMPTS,
      p_stale_minutes: STALE_EMAIL_MINUTES,
    });
    if (claim.error) throw new Error("CLAIM_UNAVAILABLE");

    const jobs = Array.isArray(claim.data) ? (claim.data as PendingJob[]) : [];
    let sent = 0;
    for (const job of jobs) {
      const result = await deliver(admin, provider, job.reservation_id, {
        claimedJobId: job.id,
        stage: "retry",
        attempt: job.attempts + 1,
      });
      if (result.outcome === "SENT") sent += 1;
    }

    logEmail({ stage: "retry", outcome: sent ? "sent" : "skipped", provider: provider.name, drained: sent });
    return { outcome: "PROCESSED", processed: jobs.length, sent };
  } catch (error) {
    const errorCode = sanitizeEmailErrorCode(error);
    logEmail({ stage: "retry", outcome: "failed", errorCode });
    return { outcome: "FAILED", processed: 0, sent: 0, errorCode };
  }
}

/** Estado do envio, para o painel exibir Enviado, Pendente ou Erro. */
export async function getConfirmationEmailState(reservationId: string): Promise<ConfirmationEmailState | null> {
  const admin = getSupabaseAdminClient();
  if (!admin) return null;

  try {
    const result = await admin.rpc("integration_sync_state", {
      p_integration: CONFIRMATION_EMAIL_INTEGRATION,
      p_entity_type: "RESERVATION",
      p_entity_id: reservationId,
    });
    if (result.error || !result.data || typeof result.data !== "object") return null;

    const row = result.data as Record<string, unknown>;
    const status = row.status === "SYNCED" || row.status === "FAILED" ? row.status : "PENDING";
    return {
      status,
      attempts: Number(row.attempts) || 0,
      lastErrorCode: typeof row.lastErrorCode === "string" ? row.lastErrorCode : null,
      sentAt: typeof row.syncedAt === "string" ? row.syncedAt : null,
    };
  } catch {
    return null;
  }
}

/** true quando o provedor de e-mail está configurado neste ambiente. */
export function isConfirmationEmailEnabled() {
  return getEmailProvider() !== null;
}
