import { getEmailProvider } from "@/lib/email";
import { sanitizeEmailErrorCode } from "@/lib/email/email-provider";
import { logEmail } from "@/lib/email/observability";
import { runQrBulk, type QrBulkReport } from "@/lib/checkin/qr-bulk";
import { buildCheckinReminderEmail, parseReservationConfirmationData } from "@/lib/reservations/confirmation-email";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

/** Máximo de reservas por chamada: mantém cada requisição curta. O painel repete até acabar. */
export const QR_BULK_CHUNK = 20;

type Candidate = { reservation_id: string; public_code: string; quantity: number };

function adminClient() {
  const client = getSupabaseAdminClient();
  if (!client) throw new Error("ADMIN_NOT_CONFIGURED");
  return client;
}

export async function listQrBulkCandidates(actorUserId: string) {
  const result = await adminClient().rpc("admin_checkin_qr_bulk_candidates", { p_actor_id: actorUserId });
  if (result.error) throw new Error(result.error.message);
  const rows = (Array.isArray(result.data) ? result.data : []) as Candidate[];
  return rows.map((row) => ({ reservationId: row.reservation_id, publicCode: row.public_code, quantity: Number(row.quantity) || 0 }));
}

export type QrBulkChunkResult = QrBulkReport & {
  /** Código público das reservas que falharam, para localizar no painel. */
  failedCodes: Record<string, string>;
  remaining: number;
};

/**
 * Processa um pedaço do lote. Recalcula os candidatos no momento do envio —
 * nada é fixo — e ignora os que já falharam nesta rodada (`exclude`).
 */
export async function sendQrBulkChunk(actorUserId: string, exclude: string[]): Promise<QrBulkChunkResult | "DISABLED"> {
  const provider = getEmailProvider();
  if (!provider) return "DISABLED";
  const admin = adminClient();

  const skip = new Set(exclude);
  const candidates = (await listQrBulkCandidates(actorUserId)).filter((item) => !skip.has(item.reservationId));
  const chunk = candidates.slice(0, QR_BULK_CHUNK);

  const report = await runQrBulk(chunk.map((item) => item.reservationId), {
    claim: async (reservationId) => {
      const result = await admin.rpc("admin_checkin_qr_bulk_claim", { p_actor_id: actorUserId, p_reservation_id: reservationId });
      if (result.error) throw new Error("CLAIM_UNAVAILABLE");
      const row = (result.data ?? {}) as { jobId?: string; payload?: unknown; skipped?: string };
      if (row.jobId) return { jobId: row.jobId, payload: row.payload };
      return { skipped: row.skipped ?? "UNKNOWN" };
    },
    send: async (payload) => {
      // Mesmo template e mesmo token do botão "Reenviar QR Code".
      const data = parseReservationConfirmationData(payload);
      const message = data ? buildCheckinReminderEmail(data) : null;
      if (!message) throw new Error("PAYLOAD_EMPTY");
      await provider.send(message);
    },
    complete: async (jobId) => {
      const result = await admin.rpc("admin_checkin_qr_bulk_complete", { p_actor_id: actorUserId, p_job_id: jobId });
      return !result.error && result.data === true;
    },
    fail: async (jobId, errorCode) => {
      await admin.rpc("admin_checkin_qr_bulk_fail", { p_actor_id: actorUserId, p_job_id: jobId, p_error_code: errorCode });
    },
    sanitizeError: (error) => {
      // Erro do provedor vira HTTP_xxx/TIMEOUT; os nossos (PAYLOAD_EMPTY,
      // CLAIM_UNAVAILABLE) já são símbolos curtos e seguros de exibir.
      const code = sanitizeEmailErrorCode(error);
      return code === "UNEXPECTED_ERROR" && error instanceof Error && /^[A-Z_]{3,40}$/.test(error.message) ? error.message : code;
    },
  });

  for (const failure of report.failed) {
    logEmail({ stage: "checkin_reminder", outcome: "failed", reservationId: failure.reservationId, provider: provider.name, errorCode: failure.errorCode });
  }
  if (report.sent) logEmail({ stage: "checkin_reminder", outcome: "sent", provider: provider.name, drained: report.sent });

  const codes = new Map(chunk.map((item) => [item.reservationId, item.publicCode]));
  const failedCodes = Object.fromEntries(report.failed.map((failure) => [failure.reservationId, codes.get(failure.reservationId) ?? ""]));
  const failedIds = new Set([...skip, ...report.failed.map((failure) => failure.reservationId)]);
  const remaining = (await listQrBulkCandidates(actorUserId)).filter((item) => !failedIds.has(item.reservationId)).length;

  return { ...report, failedCodes, remaining };
}
