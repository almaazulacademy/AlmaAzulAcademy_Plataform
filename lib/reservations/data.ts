import type { SupabaseClient } from "@supabase/supabase-js";

import { parseBaseLocation, type BaseLocation } from "@/lib/bases/location";
import type { BookingSession, ReservationDetails, ReservationStatus } from "@/lib/reservations/types";
import type { PublicSession } from "@/lib/waitlist/public";

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

/** Falha de leitura com o código do PostgREST/Postgres preservado. */
export class SessionListError extends Error {
  readonly code: string;

  // Campo declarado, e não propriedade de parâmetro: o runner de testes do Node
  // carrega os `.ts` em strip-only mode, que não suporta a forma curta.
  constructor(message: string, code: string) {
    super(message);
    this.name = "SessionListError";
    this.code = code;
  }
}

/** PostgREST (PGRST202) ou Postgres (42883): a função não existe no banco. */
export function isMissingFunctionError(error: unknown) {
  if (!(error instanceof SessionListError)) return false;
  return error.code === "PGRST202" || error.code === "42883" || /could not find the function|does not exist/i.test(error.message);
}

export function mapPublicSession(row: Row): PublicSession {
  const session = mapBookingSession(row);
  // Esgotada pela marca do banco ou pela própria contagem: as duas valem.
  return { ...session, soldOut: row.sold_out === true || session.remainingSpots <= 0 };
}

/**
 * Turmas abertas e futuras **inclusive as esgotadas** (`list_public_sessions`,
 * da migration 202610250001). Só exibição: reservar continua passando por
 * `get_booking_session` e `create_pre_reservation`.
 */
export async function listPublicSessions(client: SupabaseClient, experienceSlug: string): Promise<PublicSession[]> {
  const result = await client.rpc("list_public_sessions", { p_experience_slug: experienceSlug });
  if (result.error) throw new SessionListError(result.error.message, result.error.code ?? "");
  return (Array.isArray(result.data) ? result.data : []).map((row) => mapPublicSession(row as Row));
}

/**
 * Localização de uma base pelo id. Nunca lança: sem base legível devolve null
 * e a tela simplesmente não mostra o bloco de local.
 *
 * `select("*")` de propósito: meeting_point e maps_url só existem depois da
 * migration de lançamento da segunda base, e pedir uma coluna ausente
 * derrubaria a leitura inteira.
 */
async function getBaseLocation(client: SupabaseClient, baseId: string): Promise<BaseLocation | null> {
  const base = await client.from("bases").select("*").eq("id", baseId).maybeSingle();
  const row = !base.error ? (base.data as Row | null) : null;
  if (!row) return null;
  return parseBaseLocation({
    baseSlug: row.slug,
    baseName: row.name,
    meetingPoint: row.meeting_point,
    address: row.address,
    mapsUrl: row.maps_url,
  });
}

/** Local de encontro de uma experiência: experiência → base → localização. */
async function getExperienceLocation(client: SupabaseClient, experienceId: string): Promise<BaseLocation | null> {
  if (!experienceId) return null;
  const experience = await client.from("experiences").select("base_id").eq("id", experienceId).maybeSingle();
  const baseId = !experience.error ? asString(experience.data?.base_id) : "";
  return baseId ? getBaseLocation(client, baseId) : null;
}

export type ReservationConfirmationSummary = {
  experienceTitle: string;
  startsAt: string;
  location: BaseLocation | null;
  /** Evento especial: a página do evento, para os textos de ingresso. null = experiência regular. */
  eventSlug?: string | null;
};

/**
 * Experiência e horário de uma reserva, para a tela de retorno do pagamento.
 *
 * Personaliza a mensagem de contato e, principalmente, permite repetir na
 * confirmação a turma que foi realmente reservada — o horário sai de
 * `sessions.starts_at` pela `session_id` da própria reserva, nunca de um texto
 * fixo. O local de encontro sai da base da experiência da reserva. Nenhum dado
 * pessoal é lido aqui: só título, horário e base.
 *
 * Devolve campos vazios quando a reserva não existe ou a leitura falha.
 */
export async function getReservationConfirmationSummary(
  client: SupabaseClient,
  reservationId: string,
): Promise<ReservationConfirmationSummary> {
  const empty: ReservationConfirmationSummary = { experienceTitle: "", startsAt: "", location: null };

  const reservation = await client
    .from("reservations")
    .select("experience_id, session_id")
    .eq("id", reservationId)
    .maybeSingle();
  if (reservation.error) return empty;

  const experienceId = asString(reservation.data?.experience_id);
  const sessionId = asString(reservation.data?.session_id);
  if (!experienceId && !sessionId) return empty;

  const [experience, session] = await Promise.all([
    experienceId
      ? client.from("experiences").select("title, base_id").eq("id", experienceId).maybeSingle()
      : Promise.resolve(null),
    sessionId
      ? client.from("sessions").select("starts_at").eq("id", sessionId).maybeSingle()
      : Promise.resolve(null),
  ]);

  const baseId = experience && !experience.error ? asString(experience.data?.base_id) : "";

  // Leitura à parte: sem a coluna `kind` (banco anterior aos eventos), a
  // reserva é regular e a tela segue como sempre.
  const kind = experienceId ? await client.from("experiences").select("slug, kind").eq("id", experienceId).maybeSingle() : null;
  const eventSlug = kind && !kind.error && kind.data?.kind === "EVENT" ? asString(kind.data?.slug) || null : null;

  return {
    experienceTitle: experience && !experience.error ? asString(experience.data?.title) : "",
    startsAt: session && !session.error ? asString(session.data?.starts_at) : "",
    location: baseId ? await getBaseLocation(client, baseId) : null,
    eventSlug,
  };
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

  const session = mapBookingSession(row);

  return {
    publicCode: asString(row.public_code),
    status: asString(row.reservation_status) as ReservationStatus,
    expiresAt: asString(row.expires_at),
    quantity: asNumber(row.quantity),
    totalCents: asNumber(row.total_cents),
    checkoutUrl: asString(row.checkout_url) || null,
    fullName: asString(row.full_name),
    session,
    location: await getExperienceLocation(client, session.experienceId).catch(() => null),
  };
}
