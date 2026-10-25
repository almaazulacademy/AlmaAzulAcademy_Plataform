import type { SupabaseClient } from "@supabase/supabase-js";

import { baseLabel } from "@/lib/bases/availability";
import { listCatalogExperiences, listPublicBases } from "@/lib/bases/data";
import { listPublishedExperiences } from "@/lib/editorial/data";
import { resolveExperienceCardLocation } from "@/lib/editorial/image";
import { listOpenSessions, listPublicSessions } from "@/lib/reservations/data";
import { isWaitlistPublicEnabled, type PublicSession } from "@/lib/waitlist/public";
import { loadPublicSessions } from "@/lib/waitlist/sessions";

export type AgendaSession = PublicSession & { location: string };

/**
 * Agenda geral: reúne as sessões abertas de todas as experiências publicadas.
 * Reaproveita list_public_experiences e list_open_sessions — as mesmas regras de
 * publicação, status OPEN, data futura e vagas disponíveis já aplicadas no banco.
 * Com a lista de espera pública ligada, as turmas vêm de list_public_sessions,
 * que aplica as mesmas regras sem esconder as esgotadas.
 */
export async function listAgendaSessions(client: SupabaseClient): Promise<AgendaSession[]> {
  const [experiences, catalog, bases] = await Promise.all([listPublishedExperiences(), listCatalogExperiences(), listPublicBases()]);

  const grouped = await Promise.all(
    experiences.map(async (experience) => {
      // Cada turma diz em qual base acontece. Sem catálogo multi-base, mantém o
      // rótulo anterior (toda sessão existente é da Base Lago Norte).
      const base = bases.find((item) => item.slug === catalog.find((entry) => entry.slug === experience.slug)?.baseSlug);
      const location = base ? baseLabel(base) : `Base ${resolveExperienceCardLocation(experience)}`;
      // Com WAITLIST_PUBLIC_ENABLED desligada, list_open_sessions como sempre;
      // ligada, entram também as turmas esgotadas, marcadas.
      const sessions = await loadPublicSessions(experience.slug, {
        enabled: isWaitlistPublicEnabled(),
        listOpen: (slug) => listOpenSessions(client, slug),
        listPublic: (slug) => listPublicSessions(client, slug),
        warn: (code) => console.warn("[waitlist]", { stage: "agenda_sessions", errorCode: code }),
      });
      return sessions.map((session) => ({ ...session, location }));
    }),
  );

  return grouped
    .flat()
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}
