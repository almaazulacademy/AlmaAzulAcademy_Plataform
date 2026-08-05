import type { SupabaseClient } from "@supabase/supabase-js";

import { listPublishedExperiences } from "@/lib/editorial/data";
import { resolveExperienceCardLocation } from "@/lib/editorial/image";
import { listOpenSessions } from "@/lib/reservations/data";
import type { BookingSession } from "@/lib/reservations/types";

export type AgendaSession = BookingSession & { location: string };

/**
 * Agenda geral: reúne as sessões abertas de todas as experiências publicadas.
 * Reaproveita list_public_experiences e list_open_sessions — as mesmas regras de
 * publicação, status OPEN, data futura e vagas disponíveis já aplicadas no banco.
 */
export async function listAgendaSessions(client: SupabaseClient): Promise<AgendaSession[]> {
  const experiences = await listPublishedExperiences();

  const grouped = await Promise.all(
    experiences.map(async (experience) => {
      const location = resolveExperienceCardLocation(experience);
      const sessions = await listOpenSessions(client, experience.slug);
      return sessions.map((session) => ({ ...session, location }));
    }),
  );

  return grouped
    .flat()
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}
