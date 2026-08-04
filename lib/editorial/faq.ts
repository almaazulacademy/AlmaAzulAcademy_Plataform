import type { ExperienceEditorial } from "./experience.ts";

type EditorialFaq = NonNullable<ExperienceEditorial["faq"]>;
export type EditorialFaqItem = EditorialFaq["items"][number];

export const DEFAULT_EXPERIENCE_FAQ_ITEMS: EditorialFaqItem[] = [
  {
    question: "Preciso ter experiência com canoa ou remo?",
    answer: "Não. Nossas experiências são muito recomendadas para quem quer dar as primeiras remadas. Antes de entrar na água, nossa equipe apresenta os equipamentos e oferece uma instrução completa.",
  },
  {
    question: "Preciso saber nadar?",
    answer: "Não. Todos os participantes utilizam colete salva-vidas e são acompanhados por instrutores durante toda a experiência.",
  },
  {
    question: "Crianças podem participar?",
    answer: "Sim. As crianças são muito bem-vindas, desde que estejam acompanhadas pelos pais ou responsáveis.",
  },
  {
    question: "Pessoas idosas podem participar?",
    answer: "Sim. Nossas experiências acontecem em um ritmo tranquilo e podem ser aproveitadas por pessoas de diferentes idades. Em caso de alguma condição específica, recomendamos avisar nossa equipe antes da reserva.",
  },
  {
    question: "O que devo vestir?",
    answer: "Use roupa confortável para praticar atividade física e leve roupa de banho caso queira entrar na água. Também recomendamos chinelo, repelente e um agasalho leve.",
  },
  {
    question: "O que acontece se chover ou as condições não estiverem seguras?",
    answer: "Se a experiência precisar ser cancelada por chuva, vento ou outra condição de segurança, o participante poderá escolher entre o reembolso integral ou deixar o valor como crédito para uma nova data.",
  },
  {
    question: "Qual é a política de cancelamento?",
    answer: "Cancelamentos solicitados até um dia antes da experiência podem receber reembolso ou crédito para outra data. Depois desse prazo, a solicitação será analisada pela equipe.",
  },
  {
    question: "Existe estacionamento?",
    answer: "Sim. É possível estacionar na rua em frente à base, em um local tranquilo e seguro.",
  },
  {
    question: "Há banheiro no local?",
    answer: "Sim. Nossa base possui banheiro com ducha para os participantes.",
  },
  {
    question: "Posso participar sozinho?",
    answer: "Claro. Muitas pessoas participam sozinhas e acabam compartilhando a experiência com o restante do grupo.",
  },
  {
    question: "Existe tolerância para atrasos?",
    answer: "Há tolerância de até 20 minutos após o horário de chegada programado. Depois desse período, a saída poderá acontecer sem o participante para não comprometer a experiência do grupo.",
  },
];

function questionKey(question: string) {
  return question.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").replace(/[^a-z0-9]+/g, " ").trim();
}

export function resolveExperienceFaq(specific?: ExperienceEditorial["faq"]): EditorialFaq {
  const questions = new Set(DEFAULT_EXPERIENCE_FAQ_ITEMS.map((item) => questionKey(item.question)));
  const additional = (specific?.items ?? []).filter((item) => {
    const key = questionKey(item.question);
    if (questions.has(key)) return false;
    questions.add(key);
    return true;
  });

  return {
    eyebrow: specific?.eyebrow || "Dúvidas frequentes",
    title: specific?.title || "Antes de entrar na água.",
    locationLabel: specific?.locationLabel,
    items: [...DEFAULT_EXPERIENCE_FAQ_ITEMS, ...additional],
  };
}
