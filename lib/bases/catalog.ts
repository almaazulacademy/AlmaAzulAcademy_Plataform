import type { PublicExperience } from "../editorial/experience.ts";
import { resolveExperienceCardMedia } from "../editorial/image.ts";
import { BASE_STATUSES, LAGO_NORTE_SLUG, type BaseStatus, type CatalogExperience, type PublicBase } from "./types.ts";

type Row = Record<string, unknown>;

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown) {
  const result = text(value).trim();
  return result || null;
}

function order(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * Espelho local das bases semeadas por `202609150001_multi_base.sql`.
 *
 * Só é usado quando o Supabase não responde ou a migration ainda não foi
 * aplicada. Uma resposta válida do banco sempre prevalece.
 */
export const FALLBACK_BASES: PublicBase[] = [
  {
    id: "fallback-lago-norte",
    slug: LAGO_NORTE_SLUG,
    name: "Lago Norte",
    status: "ACTIVE",
    shortDescription: "Nossa base de origem, entre a mata do Córrego do Torto e as águas abertas do Lago Paranoá.",
    description:
      "É daqui que saem todas as experiências da Alma Azul hoje. Uma base à beira do Lago Paranoá, perto de um dos trechos mais preservados de Brasília, com canoas havaianas, equipamentos e instrutores prontos para receber quem nunca remou e quem já é da casa.",
    locationLabel: "Lago Norte · Brasília",
    address: "QL 5 Conjunto 5 - Lago Norte",
    partnerName: null,
    imageUrl: "/images/experiences/imersao-paranoa/lago/vista-aerea-lago.webp",
    displayOrder: 0,
  },
  {
    id: "fallback-concha-acustica",
    slug: "concha-acustica",
    name: "Concha Acústica",
    status: "COMING_SOON",
    shortDescription: "Alma Azul na Concha Acústica, em parceria com o Cápsula Bar.",
    description:
      "Uma nova forma de viver o Lago Paranoá: remadas que partem do coração de Brasília, com a cidade vista a partir da água. A programação ainda não está aberta.",
    locationLabel: "Concha Acústica · Brasília",
    address: null,
    partnerName: "Cápsula Bar",
    imageUrl: "/images/experiences/remada-sunset/remada-sunset-sobre.webp",
    displayOrder: 1,
  },
];

/** Espelho local das experiências planejadas da Concha Acústica (todas "em breve"). */
export const FALLBACK_COMING_SOON_EXPERIENCES: CatalogExperience[] = [
  {
    slug: "caminhos-do-paranoa",
    title: "Caminhos do Paranoá",
    modality: "caminhos-do-paranoa",
    eyebrow: "Remada de dia",
    summary: "Uma remada pelo Lago Paranoá para descobrir Brasília a partir da água.",
    image: "/images/backgrounds/hero-alma-azul-lago.webp",
    displayOrder: 100,
  },
  {
    slug: "remada-nascer-do-sol-concha-acustica",
    title: "Remada Nascer do Sol",
    modality: "remada-nascer-do-sol",
    eyebrow: "Amanhecer no lago",
    summary: "O dia começando devagar, com o sol nascendo sobre o Lago Paranoá.",
    image: "/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-hero.webp",
    displayOrder: 101,
  },
  {
    slug: "remada-sunset-concha-acustica",
    title: "Remada Sunset",
    modality: "remada-sunset",
    eyebrow: "Pôr do sol no lago",
    summary: "As últimas luzes do dia vistas de dentro de uma canoa havaiana.",
    image: "/images/experiences/remada-sunset/remada-sunset-hero.webp",
    displayOrder: 102,
  },
  {
    slug: "remada-lua-cheia-concha-acustica",
    title: "Remada Lua Cheia",
    modality: "remada-lua-cheia",
    eyebrow: "Noite de lua cheia",
    summary: "Uma remada noturna guiada pelo ritmo da água e pela luz da lua.",
    image: "/images/experiences/remada-lua-cheia/remada-lua-cheia-hero.webp",
    displayOrder: 103,
  },
].map((item) => ({
  id: `fallback-${item.slug}`,
  slug: item.slug,
  title: item.title,
  eyebrow: item.eyebrow,
  summary: item.summary,
  status: "COMING_SOON" as const,
  baseSlug: "concha-acustica",
  isExclusive: false,
  modality: item.modality,
  displayOrder: item.displayOrder,
  image: { src: item.image, alt: `${item.title} no Lago Paranoá` },
}));

/** Slugs que já eram exclusivos antes de a exclusividade existir no banco. */
const FALLBACK_EXCLUSIVE_SLUGS = new Set(["imersao-paranoa"]);

export function mapPublicBase(row: Row): PublicBase | null {
  const slug = text(row.slug);
  const name = text(row.name);
  const status = text(row.status) as BaseStatus;
  if (!slug || !name || !BASE_STATUSES.includes(status)) return null;
  return {
    id: text(row.id) || slug,
    slug,
    name,
    status,
    shortDescription: text(row.short_description),
    description: text(row.description),
    locationLabel: text(row.location_label),
    address: nullableText(row.address),
    partnerName: nullableText(row.partner_name),
    imageUrl: nullableText(row.image_url),
    displayOrder: order(row.display_order),
  };
}

/** Experiência publicada (com landing validada) no formato do catálogo. */
export function catalogFromPublishedExperience(
  experience: PublicExperience,
  placement: { baseSlug: string; isExclusive: boolean; modality: string },
): CatalogExperience {
  return {
    id: experience.id,
    slug: experience.slug,
    title: experience.title,
    eyebrow: experience.editorial.hero.eyebrow,
    summary: experience.summary,
    status: "PUBLISHED",
    baseSlug: placement.baseSlug,
    isExclusive: placement.isExclusive,
    modality: placement.modality || experience.slug,
    displayOrder: experience.displayOrder,
    image: resolveExperienceCardMedia(experience),
  };
}

/** Experiência "em breve": não tem landing, só identidade de card. */
export function catalogFromComingSoonRow(row: Row): CatalogExperience | null {
  const slug = text(row.slug);
  const title = text(row.title);
  const baseSlug = text(row.base_slug);
  if (!slug || !title || !baseSlug || text(row.status) !== "COMING_SOON") return null;
  const image = nullableText(row.image_url);
  return {
    id: text(row.id) || slug,
    slug,
    title,
    eyebrow: "Em breve",
    summary: text(row.summary),
    status: "COMING_SOON",
    baseSlug,
    isExclusive: row.is_exclusive === true,
    modality: text(row.modality) || slug,
    displayOrder: order(row.display_order),
    image: { src: image && (image.startsWith("/images/") || /^https:\/\//i.test(image)) ? image : null, alt: `${title} no Lago Paranoá` },
  };
}

/**
 * Catálogo de contingência: tudo o que está publicado pertence ao Lago Norte
 * (é a única base que existia antes da migration) e a Concha aparece com as
 * experiências planejadas, sem nenhuma possibilidade de reserva.
 */
export function fallbackCatalog(published: PublicExperience[]): CatalogExperience[] {
  return [
    ...published.map((experience) =>
      catalogFromPublishedExperience(experience, {
        baseSlug: LAGO_NORTE_SLUG,
        isExclusive: FALLBACK_EXCLUSIVE_SLUGS.has(experience.slug),
        modality: experience.slug,
      }),
    ),
    ...FALLBACK_COMING_SOON_EXPERIENCES,
  ];
}
