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
async function drainPendingEmails(admin: SupabaseClient, provider: EmailProvider) {
  const claim = await admin.rpc("claim_pending_confirmation_emails", {
    p_limit: OPPORTUNISTIC_EMAIL_DRAIN,
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
    if (result.outcome === "SENT") await drainPendingEmails(admin, provider).catch(() => 0);

    return result;
  } catch (error) {
    // Rede de segurança final. Nada pode escapar para quem confirmou o pagamento.
    const errorCode = sanitizeEmailErrorCode(error);
    logEmail({ stage: "confirmation", outcome: "failed", reservationId, errorCode });
    return { outcome: "PENDING", errorCode };
  }
}

/** true quando o provedor de e-mail está configurado neste ambiente. */
export function isConfirmationEmailEnabled() {
  return getEmailProvider() !== null;
}
