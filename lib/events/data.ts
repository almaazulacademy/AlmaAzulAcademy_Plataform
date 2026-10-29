import { cache } from "react";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { mapPublicEvent, mapPublicEvents, type PublicEvent } from "./public.ts";
import { parseAvailability, type EventAvailability } from "./presentation.ts";

/**
 * Leitura pública dos eventos especiais, pelas funções da migration
 * `202610280001`. Só devolvem evento publicado (o que exige o interruptor de
 * publicação). Sem Supabase, ou numa falha, a seção fica vazia: o site
 * regular não depende dela.
 */

export const listPublicEvents = cache(async (): Promise<PublicEvent[]> => {
  const client = getSupabaseServerClient();
  if (!client) return [];
  const result = await client.rpc("list_public_events");
  if (result.error) {
    console.error("Erro ao listar eventos especiais:", result.error.message);
    return [];
  }
  return mapPublicEvents(result.data);
});

export const getPublicEvent = cache(async (slug: string): Promise<PublicEvent | null> => {
  const client = getSupabaseServerClient();
  if (!client) return null;
  const result = await client.rpc("get_public_event", { p_slug: slug });
  if (result.error) {
    console.error("Erro ao carregar evento especial:", result.error.message);
    return null;
  }
  const [row] = Array.isArray(result.data) ? result.data : [];
  return mapPublicEvent(row);
});

export type PublicEventSessionRow = {
  id: string;
  startsAt: string;
  durationMinutes: number;
  priceCents: number;
  remainingSpots: number | null;
  availability: EventAvailability;
};

/** Todas as sessões de um evento publicado, inclusive as já realizadas. */
export const listPublicEventSessions = cache(async (slug: string): Promise<PublicEventSessionRow[]> => {
  const client = getSupabaseServerClient();
  if (!client) return [];
  const result = await client.rpc("list_public_event_sessions", { p_slug: slug });
  if (result.error) {
    console.error("Erro ao listar sessões do evento:", result.error.message);
    return [];
  }
  return (Array.isArray(result.data) ? result.data : []).map((row: Record<string, unknown>) => ({
    id: String(row.id),
    startsAt: String(row.starts_at),
    durationMinutes: Number(row.duration_minutes) || 0,
    priceCents: Number(row.price_cents) || 0,
    remainingSpots: row.remaining_spots === null || row.remaining_spots === undefined ? null : Number(row.remaining_spots),
    availability: parseAvailability(row.availability),
  }));
});

/** Há algum evento publicado? Decide o item do menu e o destaque da home. */
export async function hasPublishedEvents() {
  return (await listPublicEvents()).length > 0;
}
