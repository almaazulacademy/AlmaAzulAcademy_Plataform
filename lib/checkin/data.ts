import {
  parseAttendanceSession,
  parseAttendanceSessions,
  parseCheckinReservation,
  parsePublicCheckinTicket,
  type CheckinMethod,
} from "@/lib/checkin/parse";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

function adminClient() {
  const client = getSupabaseAdminClient();
  if (!client) throw new Error("ADMIN_NOT_CONFIGURED");
  return client;
}

/** Turmas de um dia (yyyy-mm-dd, fuso de Brasília) com os totais de presença. */
export async function listAttendanceSessions(actorUserId: string, date: string) {
  const result = await adminClient().rpc("admin_attendance_sessions", { p_actor_id: actorUserId, p_date: date });
  if (result.error) throw new Error(result.error.message);
  return parseAttendanceSessions(result.data);
}

export async function getAttendanceSession(actorUserId: string, sessionId: string) {
  const result = await adminClient().rpc("admin_attendance_session", { p_actor_id: actorUserId, p_session_id: sessionId });
  if (result.error) throw new Error(result.error.message);
  return parseAttendanceSession(result.data);
}

export async function lookupCheckin(actorUserId: string, target: { token?: string; reservationId?: string }) {
  const result = await adminClient().rpc("admin_checkin_lookup", {
    p_actor_id: actorUserId,
    p_token: target.token ?? null,
    p_reservation_id: target.reservationId ?? null,
  });
  if (result.error) throw new Error(result.error.message);
  return parseCheckinReservation(result.data);
}

/** count null desfaz o check-in. Toda regra é conferida no banco. */
export async function registerCheckin(
  actorUserId: string,
  input: { reservationId: string; count: number | null; method: CheckinMethod; expectedSessionId: string | null; allowUpdate: boolean },
) {
  const result = await adminClient().rpc("admin_register_checkin", {
    p_actor_id: actorUserId,
    p_reservation_id: input.reservationId,
    p_count: input.count,
    p_method: input.method,
    p_expected_session_id: input.expectedSessionId,
    p_allow_update: input.allowUpdate,
  });
  if (result.error) throw new Error(result.error.message);
  return parseCheckinReservation(result.data);
}

/** Payload do e-mail com o token existente, para o "Reenviar QR Code". */
export async function getReservationQrEmailPayload(actorUserId: string, reservationId: string) {
  const result = await adminClient().rpc("admin_reservation_qr_email", { p_actor_id: actorUserId, p_reservation_id: reservationId });
  if (result.error) throw new Error(result.error.message);
  return result.data as unknown;
}

export async function getPublicCheckinTicket(token: string) {
  const result = await adminClient().rpc("public_checkin_ticket", { p_token: token });
  if (result.error) throw new Error(result.error.message);
  return parsePublicCheckinTicket(result.data);
}
