import type { PublicExperience } from "./experience.ts";

// Compatibility for editorial records saved before the public copy revision.
const replacements = new Map<string, string>([
  ["No caminho passamos por paisagens que poucas pessoas conhecem, fazemos uma pausa para banho em uma prainha no meio do lago e encerramos tudo com um lanche colaborativo na nossa base.", "No caminho passamos por paisagens que poucas pessoas conhecem e fazemos uma pausa para banho em uma prainha no meio do lago."],
  ["Durante a experiência, o grupo acompanha as primeiras luzes da manhã, faz pausas para banho no meio do lago e em uma prainha e compartilha um café preto ainda dentro da canoa.", "Durante a experiência, o grupo acompanha as primeiras luzes da manhã e faz pausas para banho no meio do lago e em uma prainha."],
  ["Uma remada nas primeiras luzes do dia, com banho no lago, café preto dentro da canoa e os sons da natureza ao redor.", "Uma remada nas primeiras luzes do dia, com banho no lago e os sons da natureza ao redor."],
  ["Banho e café na canoa", "Banho no lago"],
  ["Durante o percurso, fazemos pausas para banho no meio do lago e em uma prainha. Também compartilhamos um café preto dentro da canoa enquanto contemplamos as primeiras luzes do dia.", "Durante o percurso, fazemos pausas para banho no meio do lago e em uma prainha enquanto contemplamos as primeiras luzes do dia."],
  ["Veja Brasília despertar de dentro de uma canoa havaiana. Remada de 1h30 com banho no lago, café preto na canoa, fotos e acompanhamento completo.", "Veja Brasília despertar de dentro de uma canoa havaiana. Remada de 1h30 com banho no lago, fotos e acompanhamento completo."],
]);
const removedTitles = new Set(["Lanche colaborativo", "Café preto compartilhado dentro da canoa"]);
const technicalKeys = new Set(["id", "slug", "src", "href", "imageUrl", "icon"]);

function revise(value: unknown, removeRefreshments: boolean): unknown {
  if (typeof value === "string") {
    const text = removeRefreshments ? replacements.get(value) ?? value : value;
    return text.replace(/\bC[áa]psula\b(?! Bar)/g, "Cápsula Bar");
  }
  if (Array.isArray(value)) {
    return value.filter((item) => !removeRefreshments || !item || typeof item !== "object" || (
      !removedTitles.has(item.title) && item.question !== "Tem café da manhã?"
    )).map((item) => revise(item, removeRefreshments));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, technicalKeys.has(key) ? item : revise(item, removeRefreshments),
    ]));
  }
  return value;
}

export function revisePublicCopy(experience: PublicExperience): PublicExperience {
  const removeRefreshments = ["imersao-paranoa", "remada-nascer-do-sol"].includes(experience.slug);
  return revise(experience, removeRefreshments) as PublicExperience;
}
