export const EDITORIAL_VERSION = 1 as const;

export type EditorialImage = {
  src: string;
  alt: string;
  credit?: string;
};

export type EditorialCta = { label: string; href: string };
export type EditorialListItem = { title: string; description: string; icon?: string };

export type ExperienceEditorial = {
  version: typeof EDITORIAL_VERSION;
  hero: {
    eyebrow: string;
    title: string;
    subtitle: string;
    image: EditorialImage;
    primaryCta: EditorialCta;
    secondaryCta?: EditorialCta;
    details: string[];
  };
  /**
   * Imagem exclusiva do card público da experiência. Opcional: quando ausente,
   * o card continua usando hero.image. Existe para permitir que o card e o Hero
   * da página individual usem fotos diferentes sem duplicar conteúdo editorial.
   */
  cardImage?: EditorialImage;
  quickFacts: Array<{ label: string; value: string }>;
  about: {
    eyebrow: string;
    title: string;
    paragraphs: string[];
    image: EditorialImage;
  };
  gallery?: {
    eyebrow: string;
    title: string;
    description: string;
    images: EditorialImage[];
  };
  steps?: {
    eyebrow: string;
    title: string;
    description: string;
    items: EditorialListItem[];
  };
  included?: {
    eyebrow: string;
    title: string;
    description: string;
    items: EditorialListItem[];
  };
  whatToBring?: { eyebrow: string; title: string; items: string[] };
  restrictions?: { eyebrow: string; title: string; items: string[] };
  faq?: {
    eyebrow: string;
    title: string;
    locationLabel?: string;
    items: Array<{ question: string; answer: string }>;
  };
  reservations: {
    eyebrow: string;
    title: string;
    description: string;
    image: EditorialImage;
  };
  seo: { title: string; description: string };
};

export type PublicExperience = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  imageUrl: string | null;
  displayOrder: number;
  editorial: ExperienceEditorial;
};

type Validation = { success: true; data: ExperienceEditorial } | { success: false; errors: string[] };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function isEditorialImageSource(value: string) {
  return value.startsWith("/images/") || /^https:\/\//i.test(value);
}

export function validateExperienceEditorial(value: unknown, complete = true): Validation {
  const root = record(value);
  if (!root) return { success: false, errors: ["O conteúdo editorial deve ser um objeto JSON."] };
  const errors: string[] = [];
  const requiredObject = (key: string) => {
    const item = record(root[key]);
    if (!item && complete) errors.push(`A seção ${key} é obrigatória.`);
    return item;
  };
  const requiredText = (owner: Record<string, unknown> | null, key: string, label: string) => {
    const valueText = text(owner?.[key]);
    if (!valueText && complete) errors.push(`${label} é obrigatório.`);
    return valueText;
  };
  const validateImage = (valueImage: unknown, label: string) => {
    const image = record(valueImage);
    const src = text(image?.src);
    const alt = text(image?.alt);
    if (complete && (!src || !isEditorialImageSource(src))) errors.push(`${label} deve usar /images/... ou HTTPS.`);
    if (complete && !alt) errors.push(`${label} precisa de texto alternativo.`);
  };

  if (root.version !== EDITORIAL_VERSION) errors.push(`A versão editorial deve ser ${EDITORIAL_VERSION}.`);
  const hero = requiredObject("hero");
  requiredText(hero, "eyebrow", "Eyebrow do Hero");
  requiredText(hero, "title", "Título do Hero");
  requiredText(hero, "subtitle", "Subtítulo do Hero");
  validateImage(hero?.image, "Imagem do Hero");
  const primaryCta = record(hero?.primaryCta);
  requiredText(primaryCta, "label", "Texto do CTA principal");
  requiredText(primaryCta, "href", "Destino do CTA principal");

  const about = requiredObject("about");
  requiredText(about, "title", "Título da seção Sobre");
  if (complete && (!Array.isArray(about?.paragraphs) || !about.paragraphs.some((item) => text(item)))) {
    errors.push("A seção Sobre precisa de pelo menos um parágrafo.");
  }
  validateImage(about?.image, "Imagem da seção Sobre");

  const reservations = requiredObject("reservations");
  requiredText(reservations, "title", "Título de reservas");
  requiredText(reservations, "description", "Descrição de reservas");
  validateImage(reservations?.image, "Imagem de reservas");

  const seo = requiredObject("seo");
  requiredText(seo, "title", "SEO title");
  requiredText(seo, "description", "SEO description");

  const arrays = ["quickFacts"] as const;
  for (const key of arrays) {
    if (complete && (!Array.isArray(root[key]) || root[key].length === 0)) errors.push(`${key} precisa de pelo menos um item.`);
  }
  for (const key of ["gallery", "steps", "included", "faq"] as const) {
    const section = record(root[key]);
    const items = section?.items ?? section?.images;
    if (section && (!Array.isArray(items) || items.length === 0)) {
      errors.push(`A seção opcional ${key} não pode estar vazia.`);
    }
  }
  const gallery = record(root.gallery);
  if (gallery && Array.isArray(gallery.images)) gallery.images.forEach((image, index) => validateImage(image, `Imagem ${index + 1} da galeria`));

  return errors.length ? { success: false, errors } : { success: true, data: value as ExperienceEditorial };
}

export function emptyExperienceEditorial(): ExperienceEditorial {
  return {
    version: 1,
    hero: { eyebrow: "", title: "", subtitle: "", image: { src: "", alt: "" }, primaryCta: { label: "", href: "#reservas" }, details: [] },
    quickFacts: [],
    about: { eyebrow: "", title: "", paragraphs: [], image: { src: "", alt: "" } },
    reservations: { eyebrow: "", title: "", description: "", image: { src: "", alt: "" } },
    seo: { title: "", description: "" },
  };
}
