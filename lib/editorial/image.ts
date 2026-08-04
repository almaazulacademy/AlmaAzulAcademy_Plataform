import { isEditorialImageSource, type PublicExperience } from "./experience.ts";

export type ExperienceCardMedia = { src: string | null; alt: string };

const CARD_LOCATION = "Lago Norte";

export function resolveExperienceCardMedia(experience: PublicExperience): ExperienceCardMedia {
  if (experience.slug === "imersao-paranoa") {
    return {
      src: "/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-3977.webp",
      alt: "Grupo em canoas dentro do Córrego do Torto, cercado pela mata",
    };
  }
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
