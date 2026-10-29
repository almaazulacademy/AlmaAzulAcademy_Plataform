/**
 * Liga a fila do aviso de vaga ao Supabase e ao provedor de e-mail.
 *
 * Só envia com `WAITLIST_NOTIFY_ENABLED=true` e o provedor configurado; senão
 * responde DISABLED sem tocar no banco. Nunca lança.
 *
 * Avisos de evento só são reivindicados com a venda e a lista dos eventos
 * abertas (`isEventsWaitlistEnabled`): fechadas, ficam na fila sem gastar
 * tentativa. Cada aviso sai no modelo do tipo da sua sessão.
 */

import { getEmailProvider } from "@/lib/email";
import { sanitizeEmailErrorCode } from "@/lib/email/email-provider";
import { logEmail } from "@/lib/email/observability";
import { isEventSessionPublic, type RulesQueryClient } from "@/lib/events/booking";
import { isEventsWaitlistEnabled } from "@/lib/events/flags";
import { withWaitlistEventContext } from "@/lib/events/waitlist-email";
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
      kinds: isEventsWaitlistEnabled() ? ["REGULAR", "EVENT"] : ["REGULAR"],
      enrich: (payload) => withWaitlistEventContext(admin as unknown as RulesQueryClient, payload),
      eventPublic: (slug, sessionId) => isEventSessionPublic(admin as unknown as RulesQueryClient, slug, sessionId),
    });
  } catch (error) {
    const errorCode = sanitizeEmailErrorCode(error);
    logEmail({ stage: "waitlist_spot", outcome: "failed", errorCode });
    return { outcome: "FAILED", processed: 0, sent: 0, errorCode };
  }
}
