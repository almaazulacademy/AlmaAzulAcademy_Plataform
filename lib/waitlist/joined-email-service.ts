/**
 * Ponto central do e-mail de confirmação da lista de espera.
 *
 * Liga o Supabase e o provedor de e-mail à fila de `joined-email.ts`. Só envia
 * com `WAITLIST_SIGNUP_ENABLED=true` (e a exibição das esgotadas ligada) e o
 * provedor configurado. Regra herdada dos outros e-mails: **nada aqui derruba
 * quem chamou** — a inscrição já foi gravada; o e-mail fica na fila.
 */

import { getEmailProvider } from "@/lib/email";
import { sanitizeEmailErrorCode } from "@/lib/email/email-provider";
import { logEmail } from "@/lib/email/observability";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import {
  createWaitlistEmailQueue,
  followUpWaitlistJoinedEmail,
  retryPendingWaitlistEmails,
  sendWaitlistJoinedEmail,
  type WaitlistEmailResult,
  type WaitlistEmailRuntime,
  type WaitlistRetryReport,
} from "@/lib/waitlist/joined-email";
import { isWaitlistSignupEnabled } from "@/lib/waitlist/signup";

const DISABLED: WaitlistEmailResult = { outcome: "DISABLED" };

function runtime(): WaitlistEmailRuntime | null {
  if (!isWaitlistSignupEnabled()) return null;
  const provider = getEmailProvider();
  if (!provider) return null;
  const admin = getSupabaseAdminClient();
  if (!admin) return null;
  return {
    queue: createWaitlistEmailQueue({ rpc: (name, args) => admin.rpc(name, args) }),
    provider,
    log: logEmail,
  };
}

export async function sendWaitlistConfirmationEmail(sessionId: string, email: string): Promise<WaitlistEmailResult> {
  try {
    const active = runtime();
    return active ? await sendWaitlistJoinedEmail(active, sessionId, email) : DISABLED;
  } catch (error) {
    const errorCode = sanitizeEmailErrorCode(error);
    logEmail({ stage: "waitlist_joined", outcome: "failed", errorCode });
    return { outcome: "PENDING", errorCode, retryable: true };
  }
}

export async function followUpWaitlistConfirmationEmail(sessionId: string, email: string): Promise<WaitlistEmailResult> {
  try {
    const active = runtime();
    return active ? await followUpWaitlistJoinedEmail(active, sessionId, email) : DISABLED;
  } catch (error) {
    const errorCode = sanitizeEmailErrorCode(error);
    logEmail({ stage: "waitlist_retry", outcome: "failed", errorCode });
    return { outcome: "PENDING", errorCode, retryable: true };
  }
}

/** Recuperação de pendências, pela rotina agendada. Nunca lança. */
export async function retryPendingWaitlistConfirmationEmails(): Promise<WaitlistRetryReport> {
  try {
    const active = runtime();
    return active ? await retryPendingWaitlistEmails(active) : { outcome: "DISABLED", processed: 0, sent: 0 };
  } catch (error) {
    const errorCode = sanitizeEmailErrorCode(error);
    logEmail({ stage: "waitlist_retry", outcome: "failed", errorCode });
    return { outcome: "FAILED", processed: 0, sent: 0, errorCode };
  }
}
