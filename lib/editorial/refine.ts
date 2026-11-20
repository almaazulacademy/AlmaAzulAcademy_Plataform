import type { PublicExperience } from "./experience.ts";
import { applyModalityCopy, modalitySummary } from "./modality-copy.ts";
import { revisePublicCopy, revisePublicSummary } from "./public-copy.ts";

export function refinePublicExperience(experience: PublicExperience): PublicExperience {
  return applyModalityCopy(refineExperienceCopy(revisePublicCopy(experience)));
}

/**
 * O resumo da experiência lido fora da página (resumo da reserva): recebe a
 * mesma revisão de texto da página — sem o café antigo e sem prometer banho na
 * remada de 1 hora.
 */
export function refineBookingSummary(slug: string, summary: string) {
  return modalitySummary(slug, revisePublicSummary(slug, summary));
}

function refineExperienceCopy(experience: PublicExperience): PublicExperience {
  if (experience.slug === "imersao-paranoa") {
    return {
      ...experience,
      editorial: {
        ...experience.editorial,
        steps: experience.editorial.steps
          ? {
              ...experience.editorial.steps,
              items: experience.editorial.steps.items.map((item, index) =>
                index === 2
                  ? { title: "Banho", description: "Pausa para banho em uma prainha no meio do lago, cercada pela natureza exuberante do Lago Norte." }
                  : item,
              ),
            }
          : experience.editorial.steps,
      },
    };
  }

  if (experience.slug !== "remada-sunset") return experience;

  return {
    ...experience,
    editorial: {
      ...experience.editorial,
      hero: {
        ...experience.editorial.hero,
        title: "O melhor pôr do sol de Brasília, no seu ritmo.",
        subtitle: "O fim do dia ganha outro significado quando você troca a correria pela tranquilidade do lago. Durante a semana, uma remada de 1 hora; aos domingos, a experiência tradicional de 1h30.",
        details: experience.editorial.hero.details
          .filter((detail) => !/^(local|onde)\s*:/i.test(detail.trim()))
          .map((detail) => (/^nível\s*:/i.test(detail.trim()) ? "Nível: iniciantes ao avançado" : detail)),
      },
      quickFacts: experience.editorial.quickFacts
        .filter((fact) => !/^(local|onde)$/i.test(fact.label.trim()))
        .map((fact) => (/^nível$/i.test(fact.label.trim()) ? { ...fact, value: "Iniciantes ao avançado" } : fact)),
      about: {
        ...experience.editorial.about,
        paragraphs: [
          "A Remada Sunset é um convite para terminar o dia de um jeito diferente: dentro de uma canoa havaiana, sobre as águas do Lago Paranoá e diante do melhor pôr do sol de Brasília.",
          "Em um ritmo tranquilo, o grupo aproveita o lago e contempla as últimas luzes do dia antes de retornar à base. Na experiência tradicional de 1h30, aos domingos, há mais tempo para as paradas previstas no roteiro, com possibilidade de banho quando fizer parte do percurso.",
          "Não é necessário ter experiência. Nossa equipe acompanha toda a atividade e orienta os participantes desde os primeiros movimentos.",
        ],
      },
      restrictions: undefined,
    },
  };
}
