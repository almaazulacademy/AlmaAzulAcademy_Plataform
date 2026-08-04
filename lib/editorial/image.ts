import { isEditorialImageSource, type PublicExperience } from "./experience.ts";

export type ExperienceCardMedia = { src: string | null; alt: string };

const CARD_LOCATION = "Lago Norte";

export function resolveExperienceCardMedia(experience: PublicExperience): ExperienceCardMedia {
  const heroSource = experience.editorial.hero.image.src.trim();
  const legacySource = experience.imageUrl?.trim() ?? "";

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
