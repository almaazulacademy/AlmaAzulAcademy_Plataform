import type { PublicExperience } from "./experience.ts";

/**
 * Respostas de FAQ que remetiam ao grupo de WhatsApp da experiência (25/11/2026).
 *
 * As orientações de chegada passaram a estar no e-mail de confirmação, e o
 * site não promete mais grupo nem envio posterior de orientações. As respostas
 * antigas moram no `editorial_content` das experiências do Cápsula Bar (Remada
 * Sunset, Remada da Lua Cheia e as duas Rotas). Como em `modality-copy.ts`,
 * a revisão é de apresentação: não escreve no banco, e só troca a resposta
 * quando ela é **exatamente** a antiga — uma resposta que a equipe já tenha
 * reescrito pelo painel passa intacta.
 *
 * Os textos novos não afirmam nada sobre estacionamento ou estrutura do bar
 * que a equipe não tenha confirmado: remetem ao e-mail e ao WhatsApp oficial.
 */
export const GROUP_FAQ_REPLACEMENTS: ReadonlyMap<string, string> = new Map([
  [
    "As orientações de chegada e de estacionamento no Cápsula Bar são enviadas pela nossa equipe no grupo da experiência, criado até um dia antes.",
    "As orientações de chegada ao Cápsula Bar estão no e-mail de confirmação da sua reserva. Em caso de dúvida sobre estacionamento, fale com a nossa equipe pelo WhatsApp (61) 99268-2522.",
  ],
  [
    "O ponto de encontro fica no Cápsula Bar. As orientações sobre a estrutura disponível no dia são enviadas pela nossa equipe no grupo da experiência.",
    "O ponto de encontro fica no Cápsula Bar. Em caso de dúvida sobre a estrutura disponível no dia, fale com a nossa equipe pelo WhatsApp (61) 99268-2522.",
  ],
]);

export function withoutGroupPromises(experience: PublicExperience): PublicExperience {
  const items = experience.editorial.faq?.items;
  if (!items?.some((item) => GROUP_FAQ_REPLACEMENTS.has(item.answer))) return experience;
  return {
    ...experience,
    editorial: {
      ...experience.editorial,
      faq: {
        ...experience.editorial.faq!,
        items: items.map((item) => {
          const answer = GROUP_FAQ_REPLACEMENTS.get(item.answer);
          return answer ? { ...item, answer } : item;
        }),
      },
    },
  };
}
