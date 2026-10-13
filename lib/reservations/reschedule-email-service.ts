/**
 * Ponto central do e-mail de confirmação de reagendamento.
 *
 * Liga o Supabase e o provedor de e-mail à fila de `reschedule-email.ts`. Tem
 * três chamadores e nenhum outro: a rota que reagenda uma reserva em Stand-by,
 * a rotina agendada e o botão de reenvio do painel. Colocar em Stand-by, gerar
 * ou revogar link e desfazer o Stand-by não passam por aqui.
 *
 * Regra inegociável, a mesma do e-mail de pagamento: **nada aqui pode derrubar
 * o fluxo que chamou.** Se o provedor cair, a reserva continua reagendada e
 * confirmada; o envio fica na fila e é retentado depois.
 */

import { getEmailProvider, MAX_EMAIL_ATTEMPTS, STALE_EMAIL_MINUTES } from "@/lib/email";
import { sanitizeEmailErrorCode } from "@/lib/email/email-provider";
import { logEmail } from "@/lib/email/observability";
import {
  createRescheduleEmailQueue,
  isRescheduleEmailEnabled,
  resendRescheduleEmail,
  retryPendingRescheduleEmails,
  sendRescheduleEmailForChange,
  type RescheduleEmailResult,
  type RescheduleEmailRuntime,
  type RescheduleEmailState,
  type RescheduleRetryReport,
} from "@/lib/reservations/reschedule-email";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

const DISABLED: RescheduleEmailResult = { outcome: "DISABLED" };

/** null com o e-mail de reagendamento desligado ou sem provedor configurado. */
function runtime(): RescheduleEmailRuntime | null {
  if (!isRescheduleEmailEnabled()) return null;
  const provider = getEmailProvider();
  if (!provider) return null;
  const admin = getSupabaseAdminClient();
  if (!admin) return null;

  return {
    queue: createRescheduleEmailQueue(
      { rpc: (name, args) => admin.rpc(name, args) },
      // O prazo de uma reivindicação é o mesmo tempo que o e-mail de pagamento
      // espera antes de considerar um envio preso.
      { maxAttempts: MAX_EMAIL_ATTEMPTS, leaseMinutes: STALE_EMAIL_MINUTES },
    ),
    provider,
    sanitizeError: sanitizeEmailErrorCode,
    log: logEmail,
  };
}

/** true quando o e-mail de reagendamento está ligado e há provedor configurado. */
export function isRescheduleEmailActive() {
  return isRescheduleEmailEnabled() && getEmailProvider() !== null;
}

/** Envia a confirmação do reagendamento recém-gravado. Nunca lança. */
export async function sendRescheduleConfirmationEmail(changeId: string): Promise<RescheduleEmailResult> {
  try {
    const active = runtime();
    if (!active || !changeId) return DISABLED;
    return await sendRescheduleEmailForChange(active, changeId);
  } catch (error) {
    // Rede de segurança final. Nada pode escapar para quem reagendou.
    const errorCode = sanitizeEmailErrorCode(error);
    logEmail({ stage: "reschedule", outcome: "failed", errorCode });
    return { outcome: "PENDING", errorCode };
  }
}

/** Rotina agendada: recupera o que ficou pendente. Nunca lança. */
export async function retryPendingRescheduleConfirmationEmails(): Promise<RescheduleRetryReport> {
  try {
    const active = runtime();
    if (!active) return { outcome: "DISABLED", processed: 0, sent: 0 };
    return await retryPendingRescheduleEmails(active);
  } catch (error) {
    const errorCode = sanitizeEmailErrorCode(error);
    logEmail({ stage: "reschedule_retry", outcome: "failed", errorCode });
    return { outcome: "FAILED", processed: 0, sent: 0, errorCode };
  }
}

/** Botão "Reenviar e-mail de reagendamento". Nunca lança. */
export async function resendRescheduleConfirmationEmail(actorUserId: string, reservationId: string): Promise<RescheduleEmailResult> {
  try {
    const active = runtime();
    if (!active) return DISABLED;
    return await resendRescheduleEmail(active, actorUserId, reservationId);
  } catch (error) {
    const errorCode = sanitizeEmailErrorCode(error);
    logEmail({ stage: "reschedule_retry", outcome: "failed", reservationId, errorCode });
    return { outcome: "PENDING", errorCode };
  }
}

/**
 * Estado do e-mail de cada reagendamento da reserva, para o painel. Informativo:
 * sem a migration aplicada, ou com o e-mail desligado, devolve lista vazia.
 */
export async function getRescheduleEmailStates(actorUserId: string, reservationId: string): Promise<RescheduleEmailState[]> {
  try {
    const active = runtime();
    return active ? await active.queue.states(actorUserId, reservationId) : [];
  } catch {
    return [];
  }
}
