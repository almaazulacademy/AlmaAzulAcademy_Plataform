import { LAGO_NORTE_SLUG } from "../bases/types.ts";

/**
 * Recorte administrativo por base.
 *
 * A base de uma sessão ou reserva é sempre a base da experiência. Enquanto a
 * migration multi-base não estiver aplicada, nenhuma experiência tem base
 * explícita — e toda a operação existente é, por definição, da Base Lago Norte.
 */

type WithBase = { id: string; baseSlug?: string | null };

export function experienceBaseSlug(experience: { baseSlug?: string | null } | undefined) {
  return experience?.baseSlug || LAGO_NORTE_SLUG;
}

/** Aceita apenas o slug de uma base conhecida; qualquer outro valor vira "todas". */
export function parseAdminBaseFilter(value: unknown, bases: Array<{ slug: string }>) {
  const slug = Array.isArray(value) ? value[0] : value;
  if (typeof slug !== "string") return "";
  const normalized = slug.trim().toLowerCase();
  return bases.some((base) => base.slug === normalized) ? normalized : "";
}

export function experienceBaseMap(experiences: WithBase[]) {
  return new Map(experiences.map((experience) => [experience.id, experienceBaseSlug(experience)]));
}

export function experiencesInBase<T extends WithBase>(experiences: T[], baseSlug: string) {
  return baseSlug ? experiences.filter((experience) => experienceBaseSlug(experience) === baseSlug) : experiences;
}

/** Filtra qualquer item ligado a uma experiência (sessão, reserva). */
export function itemsInBase<T extends { experienceId: string }>(items: T[], experiences: WithBase[], baseSlug: string) {
  if (!baseSlug) return items;
  const bases = experienceBaseMap(experiences);
  return items.filter((item) => (bases.get(item.experienceId) ?? LAGO_NORTE_SLUG) === baseSlug);
}

/**
 * Rótulo de experiência nos selects do painel. Com duas "Remada Sunset", só o
 * título não diz qual é qual — a base vem sempre junto.
 */
export function adminExperienceLabel(experience: { title: string; baseName?: string | null }) {
  return experience.baseName ? `${experience.title} · ${experience.baseName}` : experience.title;
}
