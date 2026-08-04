import type { PublicExperience } from "./experience.ts";

export function refinePublicExperience(experience: PublicExperience): PublicExperience {
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
        title: "O melhor pôr do sol de Brasília",
        subtitle: "Uma remada para desacelerar e acompanhar as últimas luzes do dia em um dos cenários mais bonitos da cidade.",
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
          "Em um ritmo tranquilo, o grupo aproveita o lago, faz pausas para banho e contempla as últimas luzes do dia antes de retornar à base.",
          "Não é necessário ter experiência. Nossa equipe acompanha toda a atividade e orienta os participantes desde os primeiros movimentos.",
        ],
      },
      restrictions: undefined,
    },
  };
}
