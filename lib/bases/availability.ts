import type { BaseStatus, CatalogExperience, PublicBase } from "./types.ts";

/**
 * Regras de apresentação do catálogo multi-base.
 *
 * Nada aqui decide se uma reserva pode acontecer — quem decide é o banco
 * (experiência PUBLISHED, que por sua vez exige base ACTIVE). Estas funções só
 * garantem que a interface nunca ofereça reserva onde o banco recusaria.
 */

export function isBaseBookable(base: Pick<PublicBase, "status"> | null | undefined) {
  return base?.status === "ACTIVE";
}

export function isExperienceBookable(
  experience: Pick<CatalogExperience, "status">,
  base: Pick<PublicBase, "status"> | null | undefined,
) {
  return experience.status === "PUBLISHED" && isBaseBookable(base);
}

export function baseLabel(base: Pick<PublicBase, "name">) {
  return `Base ${base.name}`;
}

export function exclusiveLabel(base: Pick<PublicBase, "name">) {
  return `Exclusiva da Base ${base.name}`;
}

export function baseStatusLabel(status: BaseStatus) {
  if (status === "ACTIVE") return "Base em operação";
  if (status === "COMING_SOON") return "Em breve";
  return "Inativa";
}

/**
 * Destino de uma experiência no catálogo. Uma experiência "em breve" nunca
 * aponta para uma landing com agenda: leva para a página da base.
 */
export function catalogExperienceHref(
  experience: Pick<CatalogExperience, "slug" | "status" | "baseSlug">,
  base: Pick<PublicBase, "status"> | null | undefined,
) {
  return isExperienceBookable(experience, base)
    ? `/experiencias/${experience.slug}`
    : `/bases/${experience.baseSlug}#experiencias`;
}

/** Valida `?base=`: só aceita o slug de uma base visível. */
export function parseBaseFilter(value: unknown, bases: Array<Pick<PublicBase, "slug">>) {
  const slug = Array.isArray(value) ? value[0] : value;
  if (typeof slug !== "string") return null;
  const normalized = slug.trim().toLowerCase();
  return bases.some((base) => base.slug === normalized) ? normalized : null;
}

export function experiencesForBase<T extends Pick<CatalogExperience, "baseSlug">>(experiences: T[], baseSlug: string | null) {
  return baseSlug ? experiences.filter((experience) => experience.baseSlug === baseSlug) : experiences;
}

export type ModalityEntry = { experience: CatalogExperience; base: PublicBase };

export type ModalityGroup = {
  modality: string;
  /** Experiência que empresta título, resumo e foto ao card. */
  lead: CatalogExperience;
  entries: ModalityEntry[];
  /** Existe em uma única base e está marcada como exclusiva dela. */
  exclusiveBase: PublicBase | null;
  /** Nenhuma das bases onde a modalidade existe está com reservas abertas. */
  comingSoon: boolean;
};

/**
 * Agrupa a mesma modalidade em bases diferentes em um único card.
 *
 * "Remada Sunset — Lago Norte" e "Remada Sunset — Concha Acústica" continuam
 * sendo experiências distintas no banco (sessões, vagas e receita separadas).
 * Na vitrine elas viram um card só, com uma linha por base — assim o visitante
 * vê a modalidade uma vez e nunca fica em dúvida sobre onde cada versão acontece.
 *
 * Experiências sem base visível são descartadas. A ordem dos grupos segue a
 * primeira aparição (ordem das bases, depois display_order).
 */
export function groupCatalogByModality(experiences: CatalogExperience[], bases: PublicBase[]): ModalityGroup[] {
  const baseBySlug = new Map(bases.map((base) => [base.slug, base]));
  const groups = new Map<string, ModalityEntry[]>();

  const ordered = [...experiences].sort((a, b) => {
    const baseA = baseBySlug.get(a.baseSlug)?.displayOrder ?? Number.MAX_SAFE_INTEGER;
    const baseB = baseBySlug.get(b.baseSlug)?.displayOrder ?? Number.MAX_SAFE_INTEGER;
    return baseA - baseB || a.displayOrder - b.displayOrder || a.title.localeCompare(b.title, "pt-BR");
  });

  for (const experience of ordered) {
    const base = baseBySlug.get(experience.baseSlug);
    if (!base) continue;
    const key = experience.modality || experience.slug;
    const entries = groups.get(key) ?? [];
    entries.push({ experience, base });
    groups.set(key, entries);
  }

  return [...groups.entries()].map(([modality, entries]) => {
    const lead = entries.find((entry) => isExperienceBookable(entry.experience, entry.base))?.experience ?? entries[0].experience;
    const [only] = entries;
    return {
      modality,
      lead,
      entries,
      exclusiveBase: entries.length === 1 && only.experience.isExclusive ? only.base : null,
      comingSoon: !entries.some((entry) => isExperienceBookable(entry.experience, entry.base)),
    };
  });
}
