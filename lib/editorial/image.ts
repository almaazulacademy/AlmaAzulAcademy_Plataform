import { isEditorialImageSource, type PublicExperience } from "./experience.ts";

export type ExperienceCardMedia = { src: string | null; alt: string };

const CARD_LOCATION = "Lago Norte";

export function resolveExperienceCardMedia(experience: PublicExperience): ExperienceCardMedia {
  const cardSource = experience.editorial.cardImage?.src.trim() ?? "";
  const heroSource = experience.editorial.hero.image.src.trim();
  const legacySource = experience.imageUrl?.trim() ?? "";

  // cardImage é opcional e tem prioridade: permite uma foto própria no card sem
  // tocar no Hero da página individual. Sem ele, o comportamento é o anterior.
  if (isEditorialImageSource(cardSource)) {
    return { src: cardSource, alt: experience.editorial.cardImage?.alt ?? experience.editorial.hero.image.alt };
  }

  return {
    src: isEditorialImageSource(heroSource)
      ? heroSource
      : isEditorialImageSource(legacySource)
        ? legacySource
        : null,
    alt: experience.editorial.hero.image.alt,
  };
}

export function resolveExperienceCardLocation(experience: PublicExperience): string {
  const editorialLocation = experience.editorial.quickFacts.find((fact) => /^(local|onde)$/i.test(fact.label.trim()))?.value.trim();
  if (editorialLocation === CARD_LOCATION) return editorialLocation;
  return CARD_LOCATION;
}
