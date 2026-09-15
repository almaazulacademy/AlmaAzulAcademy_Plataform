import { cache } from "react";

import { catalogFromComingSoonRow, catalogFromPublishedExperience, FALLBACK_BASES, fallbackCatalog, mapPublicBase } from "@/lib/bases/catalog";
import type { CatalogExperience, PublicBase } from "@/lib/bases/types";
import { listPublishedExperiences, mapPublicExperience } from "@/lib/editorial/data";
import { getSupabaseServerClient } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === "object") : [];
}

/**
 * Bases visíveis (ACTIVE e COMING_SOON), lidas uma vez por requisição.
 *
 * Sem Supabase ou sem a migration multi-base, cai no espelho local — as
 * páginas públicas nunca quebram por causa da ordem de deploy.
 */
export const listPublicBases = cache(async (): Promise<PublicBase[]> => {
  const client = getSupabaseServerClient();
  if (client) {
    const result = await client.rpc("list_public_bases");
    if (!result.error) {
      const bases = rows(result.data).map(mapPublicBase).filter((base): base is PublicBase => base !== null);
      if (bases.length) return bases;
    } else {
      console.error("Erro ao listar bases:", result.error.message);
    }
  }
  return FALLBACK_BASES;
});

export async function getPublicBase(slug: string) {
  const bases = await listPublicBases();
  return bases.find((base) => base.slug === slug) ?? null;
}

/**
 * Catálogo multi-base: experiências publicadas (com landing e agenda) e
 * experiências "em breve", cada uma com a sua base.
 */
export const listCatalogExperiences = cache(async (): Promise<CatalogExperience[]> => {
  const client = getSupabaseServerClient();
  if (client) {
    const result = await client.rpc("list_public_catalog");
    if (!result.error) {
      return rows(result.data)
        .map((row) => {
          if (row.status === "COMING_SOON") return catalogFromComingSoonRow(row);
          const experience = mapPublicExperience(row);
          if (!experience || typeof row.base_slug !== "string") return null;
          return catalogFromPublishedExperience(experience, {
            baseSlug: row.base_slug,
            isExclusive: row.is_exclusive === true,
            modality: typeof row.modality === "string" ? row.modality : experience.slug,
          });
        })
        .filter((item): item is CatalogExperience => item !== null);
    }
    console.error("Erro ao listar catálogo multi-base:", result.error.message);
  }
  return fallbackCatalog(await listPublishedExperiences());
});

/** Base e exclusividade de uma experiência, para a landing e a agenda. */
export async function getExperiencePlacement(slug: string) {
  const [catalog, bases] = await Promise.all([listCatalogExperiences(), listPublicBases()]);
  const experience = catalog.find((item) => item.slug === slug) ?? null;
  const base = experience ? bases.find((item) => item.slug === experience.baseSlug) ?? null : null;
  return experience && base ? { experience, base } : null;
}

export type SessionAvailabilityContext = {
  experienceSlug: string;
  experienceTitle: string;
  experienceStatus: string;
  baseSlug: string;
  baseName: string;
  baseStatus: string;
};

/**
 * Por que uma URL de reserva não abre. Serve apenas para trocar "sessão
 * indisponível" por uma explicação de "em breve"; nunca libera nada.
 */
export async function getSessionAvailabilityContext(sessionId: string): Promise<SessionAvailabilityContext | null> {
  const client = getSupabaseServerClient();
  if (!client) return null;
  const result = await client.rpc("public_session_context", { p_session_id: sessionId });
  if (result.error) return null;
  const [row] = rows(result.data);
  if (!row) return null;
  return {
    experienceSlug: String(row.experience_slug ?? ""),
    experienceTitle: String(row.experience_title ?? ""),
    experienceStatus: String(row.experience_status ?? ""),
    baseSlug: String(row.base_slug ?? ""),
    baseName: String(row.base_name ?? ""),
    baseStatus: String(row.base_status ?? ""),
  };
}
