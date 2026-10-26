/**
 * Liga a fila do aviso de vaga ao Supabase e ao provedor de e-mail.
 *
 * Só envia com `WAITLIST_NOTIFY_ENABLED=true` e o provedor configurado; senão
 * responde DISABLED sem tocar no banco. Nunca lança.
 */

import { getEmailProvider } from "@/lib/email";
import { sanitizeEmailErrorCode } from "@/lib/email/email-provider";
import { logEmail } from "@/lib/email/observability";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import type { WaitlistRetryReport } from "@/lib/waitlist/joined-email";
import { createWaitlistSpotQueue, isWaitlistNotifyEnabled, sendPendingWaitlistSpotEmails } from "@/lib/waitlist/spot-email";

export async function sendPendingWaitlistSpotNotices(): Promise<WaitlistRetryReport> {
  try {
    if (!isWaitlistNotifyEnabled()) return { outcome: "DISABLED", processed: 0, sent: 0 };
    const provider = getEmailProvider();
    const admin = getSupabaseAdminClient();
    if (!provider || !admin) return { outcome: "DISABLED", processed: 0, sent: 0 };
    return await sendPendingWaitlistSpotEmails({
      queue: createWaitlistSpotQueue({ rpc: (name, args) => admin.rpc(name, args) }),
      provider,
      log: logEmail,
    });
  } catch (error) {
    const errorCode = sanitizeEmailErrorCode(error);
    logEmail({ stage: "waitlist_spot", outcome: "failed", errorCode });
    return { outcome: "FAILED", processed: 0, sent: 0, errorCode };
  }
}
