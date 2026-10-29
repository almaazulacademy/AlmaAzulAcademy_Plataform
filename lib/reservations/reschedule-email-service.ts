/**
 * Ponto central do e-mail de confirmação de reagendamento.
 *
 * Liga o Supabase e o provedor de e-mail à fila de `reschedule-email.ts`. Envia
 * por quatro caminhos e nenhum outro: a rota que reagenda uma reserva em
 * Stand-by (a tentativa imediata e as duas seguintes, em segundo plano), a
 * recuperação de pendências (rotina agendada e páginas do painel de Stand-by) e
 * o botão de reenvio. Colocar em Stand-by, gerar ou revogar link e desfazer o
 * Stand-by não passam por aqui.
 *
 * Regra inegociável, a mesma do e-mail de pagamento: **nada aqui pode derrubar
 * o fluxo que chamou.** Se o provedor cair, a reserva continua reagendada e
 * confirmada; o envio fica na fila e é retentado depois.
 */

import { withEventEmailContext, type EventEmailQueryClient } from "@/lib/reservations/event-email-context";
import { getEmailProvider } from "@/lib/email";
import { sanitizeEmailErrorCode } from "@/lib/email/email-provider";
import { logEmail } from "@/lib/email/observability";
import {
  createRescheduleEmailQueue,
  followUpRescheduleEmail,
  isRescheduleEmailEnabled,
  resendRescheduleEmail,
  retryPendingRescheduleEmails,
  sendRescheduleEmailForChange,
  type RescheduleEmailResult,
  type RescheduleEmailRuntime,
  type RescheduleEmailState,
  type RescheduleRetryReport,
  type UndeliveredRescheduleEmails,
} from "@/lib/reservations/reschedule-email";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

const DISABLED: RescheduleEmailResult = { outcome: "DISABLED" };

/** Quantos clientes sem confirmação o painel lista de uma vez. */
const UNDELIVERED_LIMIT = 20;

/** null com o e-mail de reagendamento desligado ou sem provedor configurado. */
function runtime(): RescheduleEmailRuntime | null {
  if (!isRescheduleEmailEnabled()) return null;
  const provider = getEmailProvider();
  if (!provider) return null;
  const admin = getSupabaseAdminClient();
  if (!admin) return null;

  return {
    queue: createRescheduleEmailQueue({ rpc: (name, args) => admin.rpc(name, args) }),
    enrich: (payload) => withEventEmailContext(admin as unknown as EventEmailQueryClient, payload),
    provider,
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
    return { outcome: "PENDING", errorCode, retryable: true };
  }
}

/**
 * As duas novas tentativas da requisição que reagendou, para rodar depois da
 * resposta. Nunca lança.
 */
export async function followUpRescheduleConfirmationEmail(changeId: string): Promise<RescheduleEmailResult> {
  try {
    const active = runtime();
    if (!active || !changeId) return DISABLED;
    return await followUpRescheduleEmail(active, changeId);
  } catch (error) {
    const errorCode = sanitizeEmailErrorCode(error);
    logEmail({ stage: "reschedule_retry", outcome: "failed", errorCode });
    return { outcome: "PENDING", errorCode, retryable: true };
  }
}

/** Recupera o que ficou pendente: rotina agendada e painel aberto. Nunca lança. */
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

/**
 * Botão "Reenviar e-mail de reagendamento". Nunca lança. `acceptUncertain` só é
 * true quando a pessoa confirmou, no painel, que aceita o risco de duplicidade.
 */
export async function resendRescheduleConfirmationEmail(actorUserId: string, reservationId: string, acceptUncertain: boolean): Promise<RescheduleEmailResult> {
  try {
    const active = runtime();
    if (!active) return DISABLED;
    return await resendRescheduleEmail(active, actorUserId, reservationId, { acceptUncertain });
  } catch (error) {
    const errorCode = sanitizeEmailErrorCode(error);
    logEmail({ stage: "reschedule_retry", outcome: "failed", reservationId, errorCode });
    return { outcome: "PENDING", errorCode, retryable: true };
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

/**
 * Clientes reagendados que ainda não receberam a confirmação, a turma mais
 * próxima primeiro. Mesma tolerância do estado: sem migration ou com o e-mail
 * desligado, vazio.
 */
export async function getUndeliveredRescheduleEmails(actorUserId: string): Promise<UndeliveredRescheduleEmails> {
  try {
    const active = runtime();
    return active ? await active.queue.undelivered(actorUserId, UNDELIVERED_LIMIT) : { total: 0, items: [] };
  } catch {
    return { total: 0, items: [] };
  }
}
