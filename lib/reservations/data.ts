import type { SupabaseClient } from "@supabase/supabase-js";

import type { BookingSession, ReservationDetails, ReservationStatus } from "@/lib/reservations/types";

type Row = Record<string, unknown>;

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function firstRow(value: unknown): Row | null {
  if (Array.isArray(value)) return value[0] && typeof value[0] === "object" ? value[0] as Row : null;
  return value && typeof value === "object" ? value as Row : null;
}

export function mapBookingSession(row: Row): BookingSession {
  return {
    id: asString(row.id ?? row.session_id),
    experienceId: asString(row.experience_id),
    experienceSlug: asString(row.experience_slug),
    experienceTitle: asString(row.experience_title),
    experienceSummary: asString(row.experience_summary),
    startsAt: asString(row.starts_at),
    durationMinutes: asNumber(row.duration_minutes),
    priceCents: asNumber(row.price_cents),
    remainingSpots: asNumber(row.remaining_spots),
  };
}

export async function listOpenSessions(client: SupabaseClient, experienceSlug: string) {
  const result = await client.rpc("list_open_sessions", { p_experience_slug: experienceSlug });
  if (result.error) throw new Error(result.error.message);
  return (Array.isArray(result.data) ? result.data : []).map((row) => mapBookingSession(row as Row));
}

/**
 * Título da experiência de uma reserva. Usado só para personalizar a mensagem de
 * contato após o pagamento — nenhum dado pessoal é lido aqui.
 * Devolve string vazia quando a reserva não existe ou a leitura falha.
 */
export async function getReservationExperienceTitle(client: SupabaseClient, reservationId: string) {
  const reservation = await client
    .from("reservations")
    .select("experience_id")
    .eq("id", reservationId)
    .maybeSingle();
  const experienceId = asString(reservation.data?.experience_id);
  if (reservation.error || !experienceId) return "";

  const experience = await client
    .from("experiences")
    .select("title")
    .eq("id", experienceId)
    .maybeSingle();
  if (experience.error) return "";
  return asString(experience.data?.title);
}

export async function getBookingSession(client: SupabaseClient, sessionId: string) {
  const result = await client.rpc("get_booking_session", { p_session_id: sessionId });
  if (result.error) throw new Error(result.error.message);
  const row = firstRow(result.data);
  return row ? mapBookingSession(row) : null;
}

export async function lookupReservation(client: SupabaseClient, cpf: string, publicCode: string): Promise<ReservationDetails | null> {
  const result = await client.rpc("lookup_reservation", { p_cpf: cpf, p_public_code: publicCode });
  if (result.error) throw new Error(result.error.message);
  const row = firstRow(result.data);
  if (!row) return null;

  return {
    publicCode: asString(row.public_code),
    status: asString(row.reservation_status) as ReservationStatus,
    expiresAt: asString(row.expires_at),
    quantity: asNumber(row.quantity),
    totalCents: asNumber(row.total_cents),
    checkoutUrl: asString(row.checkout_url) || null,
    fullName: asString(row.full_name),
    session: mapBookingSession(row),
  };
}
