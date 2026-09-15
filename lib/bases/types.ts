export const BASE_STATUSES = ["ACTIVE", "COMING_SOON", "INACTIVE"] as const;
export type BaseStatus = (typeof BASE_STATUSES)[number];

/** Status públicos de uma experiência no catálogo multi-base. */
export const CATALOG_STATUSES = ["PUBLISHED", "COMING_SOON"] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

export const LAGO_NORTE_SLUG = "lago-norte";

export type PublicBase = {
  id: string;
  slug: string;
  name: string;
  status: BaseStatus;
  shortDescription: string;
  description: string;
  locationLabel: string;
  address: string | null;
  partnerName: string | null;
  imageUrl: string | null;
  displayOrder: number;
};

export type CatalogExperience = {
  id: string;
  slug: string;
  title: string;
  eyebrow: string;
  summary: string;
  status: CatalogStatus;
  baseSlug: string;
  isExclusive: boolean;
  /** Chave que agrupa a mesma modalidade em bases diferentes (ex.: remada-sunset). */
  modality: string;
  displayOrder: number;
  image: { src: string | null; alt: string };
};
