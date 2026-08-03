import type { SupabaseClient } from "@supabase/supabase-js";

import { imersaoParanoaFallback } from "./imersao-paranoa.ts";
import { validateExperienceEditorial, type PublicExperience } from "./experience.ts";
import { getSupabaseServerClient } from "@/lib/supabase/server";

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
  return {
    id: typeof row.id === "string" ? row.id : slug,
    slug,
    title,
    summary,
    imageUrl: typeof row.image_url === "string" && row.image_url ? row.image_url : null,
    displayOrder: Number.isFinite(Number(row.display_order)) ? Number(row.display_order) : 0,
    editorial: editorial.data,
  };
}

async function publicClient(): Promise<SupabaseClient | null> {
  return getSupabaseServerClient();
}

export async function getPublishedExperience(slug: string, fallback = false): Promise<PublicExperience | null> {
  const client = await publicClient();
  if (client) {
    const result = await client.rpc("get_public_experience", { p_slug: slug });
    if (!result.error) {
      const experience = mapPublicExperience(result.data);
      if (experience) return experience;
      return fallback && slug === imersaoParanoaFallback.slug ? imersaoParanoaFallback : null;
    } else {
      console.error("Erro ao carregar experiência publicada:", result.error.message);
    }
  }
  return slug === imersaoParanoaFallback.slug ? imersaoParanoaFallback : null;
}

export async function listPublishedExperiences(): Promise<PublicExperience[]> {
  const client = await publicClient();
  if (client) {
    const result = await client.rpc("list_public_experiences");
    if (!result.error) {
      const mapped = rows(result.data).map(mapPublicExperience).filter((item): item is PublicExperience => item !== null);
      return mapped;
    } else {
      console.error("Erro ao listar experiências publicadas:", result.error.message);
    }
  }
  return [imersaoParanoaFallback];
}
