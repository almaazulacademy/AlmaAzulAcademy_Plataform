import type { SupabaseClient } from "@supabase/supabase-js";

import { imersaoParanoaFallback } from "./imersao-paranoa.ts";
import { validateExperienceEditorial, type PublicExperience } from "./experience.ts";
import { isMissingFunction, rpcWithLegacyFallback } from "@/lib/supabase/rpc-fallback";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { refinePublicExperience } from "./refine.ts";

type Row = Record<string, unknown>;

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === "object") : [];
}

export function mapPublicExperience(value: unknown): PublicExperience | null {
  const row = Array.isArray(value) ? value[0] as Row | undefined : value as Row | null;
  if (!row || typeof row !== "object") return null;
  const editorial = validateExperienceEditorial(row.editorial_content, true);
  if (!editorial.success) return null;
  const slug = typeof row.slug === "string" ? row.slug : "";
  const title = typeof row.title === "string" ? row.title : "";
  const summary = typeof row.summary === "string" ? row.summary : "";
  if (!slug || !title || !summary) return null;
  return refinePublicExperience({
    id: typeof row.id === "string" ? row.id : slug,
    slug,
    title,
    summary,
    imageUrl: typeof row.image_url === "string" && row.image_url ? row.image_url : null,
    displayOrder: Number.isFinite(Number(row.display_order)) ? Number(row.display_order) : 0,
    editorial: editorial.data,
  });
}

async function publicClient(): Promise<SupabaseClient | null> {
  return getSupabaseServerClient();
}

/**
 * Um evento especial publicado não é uma experiência da agenda regular: a
 * landing `/experiencias/[slug]` não o mostra (a página dele é outra). Sem a
 * função de eventos no banco não existe evento; numa falha passageira dela, a
 * página segue como sempre, porque `get_public_experience` já exige publicação.
 */
async function isPublishedEvent(client: SupabaseClient, slug: string) {
  const result = await client.rpc("get_public_event", { p_slug: slug });
  if (result.error) {
    if (!isMissingFunction(result.error)) console.error("Erro ao conferir evento especial:", result.error.message);
    return false;
  }
  return rows(result.data).length > 0;
}

export async function getPublishedExperience(slug: string, fallback = false): Promise<PublicExperience | null> {
  const client = await publicClient();
  if (client) {
    const [result, event] = await Promise.all([
      client.rpc("get_public_experience", { p_slug: slug }),
      isPublishedEvent(client, slug),
    ]);
    if (event) return null;
    if (!result.error) {
      const experience = mapPublicExperience(result.data);
      if (experience) return experience;
      return fallback && slug === imersaoParanoaFallback.slug ? refinePublicExperience(imersaoParanoaFallback) : null;
    } else {
      console.error("Erro ao carregar experiência publicada:", result.error.message);
    }
  }
  return slug === imersaoParanoaFallback.slug ? refinePublicExperience(imersaoParanoaFallback) : null;
}

export async function listPublishedExperiences(): Promise<PublicExperience[]> {
  const client = await publicClient();
  if (client) {
    // Só a agenda regular: eventos especiais têm a sua própria listagem.
    const result = await rpcWithLegacyFallback(client, "list_public_regular_experiences", "list_public_experiences");
    if (!result.error) {
      const mapped = rows(result.data).map(mapPublicExperience).filter((item): item is PublicExperience => item !== null);
      return mapped;
    } else {
      console.error("Erro ao listar experiências publicadas:", result.error.message);
    }
  }
  return [refinePublicExperience(imersaoParanoaFallback)];
}
