/**
 * Evento especial como o site o lê: a linha de `list_public_events` /
 * `get_public_event` (migration `202610280001`) transformada em dados prontos
 * para a página, com o conteúdo editorial validado.
 *
 * Uma linha com conteúdo incompleto é descartada: melhor um evento a menos na
 * listagem do que uma página quebrada.
 *
 * Módulo puro, sem imports de aplicação: é lido pelo Next e pelos testes.
 */

import { baseLocation, type BaseLocation } from "../bases/location.ts";
import { validateEventEditorial, type EventEditorial } from "./editorial.ts";
import { isUpcoming, parseAvailability, type EventAvailability } from "./presentation.ts";

export type PublicEventSession = {
  id: string | null;
  startsAt: string | null;
  durationMinutes: number;
  priceCents: number;
  /** Só enquanto a sessão está aberta e no futuro; senão null. */
  remainingSpots: number | null;
  availability: EventAvailability;
};

export type PublicEvent = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  editorial: EventEditorial;
  location: BaseLocation;
  session: PublicEventSession;
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function count(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function mapPublicEvent(value: unknown): PublicEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const slug = text(row.slug);
  const title = text(row.title);
  if (!slug || !title) return null;
  const editorial = validateEventEditorial(row.editorial_content);
  if (!editorial.success) return null;
  const sessionId = text(row.session_id) || null;
  return {
    id: text(row.id) || slug,
    slug,
    title,
    summary: text(row.summary),
    editorial: editorial.data,
    location: baseLocation({
      slug: text(row.base_slug),
      name: text(row.base_name),
      address: text(row.base_address) || null,
      meetingPoint: text(row.base_meeting_point) || null,
      mapsUrl: text(row.base_maps_url) || null,
    }),
    session: {
      id: sessionId,
      startsAt: text(row.starts_at) || null,
      durationMinutes: count(row.duration_minutes),
      priceCents: count(row.price_cents),
      remainingSpots: row.remaining_spots === null || row.remaining_spots === undefined ? null : count(row.remaining_spots),
      availability: sessionId ? parseAvailability(row.availability) : "NO_SESSION",
    },
  };
}

export function mapPublicEvents(value: unknown): PublicEvent[] {
  return (Array.isArray(value) ? value : []).map(mapPublicEvent).filter((item): item is PublicEvent => item !== null);
}

/** Próximos eventos e edições anteriores, na ordem em que o banco já entrega. */
export function splitEvents(events: PublicEvent[]) {
  return {
    upcoming: events.filter((event) => isUpcoming(event.session.availability)),
    past: events.filter((event) => !isUpcoming(event.session.availability) && event.session.availability !== "NO_SESSION"),
  };
}
