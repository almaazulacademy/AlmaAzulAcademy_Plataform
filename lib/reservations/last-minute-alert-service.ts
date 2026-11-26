import { getEmailProvider } from "@/lib/email";
import { maskIdentifier } from "@/lib/payments/observability";
import { createLastMinuteAlertQueue, processLastMinuteAlerts, type AlertReport } from "@/lib/reservations/last-minute-alerts";
import { SITE_URL } from "@/lib/site";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

/** Duas barreiras: flag do backend e ativação explícita com marco no banco. */
export async function drainLastMinuteAlerts(): Promise<AlertReport> {
  if (process.env.LAST_MINUTE_ALERTS_ENABLED !== "true") return { outcome: "DISABLED", processed: 0, sent: 0 };
  try {
    const provider = getEmailProvider();
    const admin = getSupabaseAdminClient();
    if (!provider || !admin) return { outcome: "DISABLED", processed: 0, sent: 0 };
    return await processLastMinuteAlerts({
      queue: createLastMinuteAlertQueue(admin), provider, siteUrl: SITE_URL,
      log: ({ alertId, ...entry }) => {
        const safe = { scope: "notifications.last_minute", alertId: maskIdentifier(alertId), ...entry };
        if (entry.outcome === "failed") console.error("[last-minute-alert]", safe);
        else console.info("[last-minute-alert]", safe);
      },
    });
  } catch {
    console.error("[last-minute-alert]", { scope: "notifications.last_minute", errorCode: "ALERT_PROCESSING_FAILED" });
    return { outcome: "FAILED", processed: 0, sent: 0, errorCode: "ALERT_PROCESSING_FAILED" };
  }
}
