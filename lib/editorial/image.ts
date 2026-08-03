import { isEditorialImageSource, type PublicExperience } from "./experience.ts";

export type ExperienceCardMedia = { src: string | null; alt: string };

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
