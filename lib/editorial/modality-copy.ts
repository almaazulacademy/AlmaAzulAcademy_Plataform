import type { PublicExperience } from "./experience.ts";

/**
 * Textos das remadas do Lago Norte com dois formatos (dezembro/2026).
 *
 * O conteúdo editorial dessas páginas mora no banco e foi escrito quando toda
 * remada durava 1h30, custava R$ 70 e saía às 6h (Nascer do Sol), com
 * "capacidade padrão 28 pessoas". Esta revisão é de apresentação: não escreve
 * no banco. Por isso cada troca só acontece quando o texto atual é **exatamente**
 * o antigo — um texto que a equipe já tenha reescrito pelo painel passa intacto.
 *
 * Os dados que mudam por formato (dias, horário, duração, valor, vagas) saem
 * das informações rápidas e passam a ser mostrados lado a lado no quadro
 * "Escolha o seu formato" (`components/experience-modalities.tsx`), sem
 * duplicar a mesma informação duas vezes na página.
 *
 * Atividades: a remada de 1 hora é curta, prática e contemplativa — sem
 * promessa de banho ou prainha. A experiência tradicional de 1h30 tem as
 * paradas previstas no roteiro, com possibilidade de banho quando fizer parte
 * do percurso. Fotos não são entrega garantida em nenhum formato: o item
 * "Fotos registradas pelos instrutores" sai de "O que está incluído" e a FAQ
 * ganha o texto aprovado (`PHOTO_NOTE`).
 */

/** Texto aprovado (19/11/2026): fotos possíveis nos dois formatos, nunca garantidas. */
export const PHOTO_NOTE = "Durante a experiência, nossa equipe poderá realizar registros fotográficos para guardar momentos especiais da remada.";
export const PHOTO_QUESTION = "Vocês fazem fotos durante a remada?";

/** Itens de "O que está incluído" que deixam de aparecer (prometiam fotos). */
const REMOVED_INCLUDED = new Set(["Fotos registradas pelos instrutores"]);

type FactRule = { label: string; from: string; to: string | null };

type ModalityCopy = {
  /** Troca de texto inteiro: só vale quando o campo é igual à chave. */
  texts: Record<string, string>;
  /** Informações rápidas: `to: null` remove o item. */
  facts: FactRule[];
  /** Respostas de FAQ por pergunta: [resposta antiga, resposta nova]. */
  faq: Record<string, [string, string]>;
};

const COPY: Record<string, ModalityCopy> = {
  "remada-nascer-do-sol": {
    texts: {
      "Sinta o despertar do Lago Paranoá.": "Comece o dia onde tudo desperta.",
      "Uma remada ao amanhecer para contemplar Brasília despertando, ouvir os sons da natureza e começar o dia com mais presença, energia e leveza.":
        "Antes da cidade ganhar movimento, o Lago Paranoá revela uma de suas paisagens mais bonitas. Escolha a remada de 1 hora durante a semana ou a tradicional de 1h30 aos sábados.",
      "Duração: 1h30": "Duração: 1h ou 1h30",
      "Horário: 6h": "Horário: 5h30 ou 5h",
      "Veja Brasília despertar de dentro de uma canoa havaiana. Remada de 1h30 com banho no lago, fotos e acompanhamento completo.":
        "Veja Brasília despertar de dentro de uma canoa havaiana: remadas de 1 hora durante a semana e a tradicional de 1h30 aos sábados, com instrução e acompanhamento completo.",
      // Resumo (cards e reserva) e galeria.
      "Uma remada nas primeiras luzes do dia, com banho no lago e os sons da natureza ao redor.":
        "Uma remada nas primeiras luzes do dia, com os sons da natureza ao redor.",
      "Durante a experiência, o grupo acompanha as primeiras luzes da manhã e faz pausas para banho no meio do lago e em uma prainha.":
        "Durante a remada, o grupo acompanha as primeiras luzes da manhã. Na experiência tradicional de 1h30, aos sábados, há mais tempo para as paradas previstas no roteiro, com possibilidade de banho quando fizer parte do percurso.",
      "Banho no lago": "O amanhecer no lago",
      "Durante o percurso, fazemos pausas para banho no meio do lago e em uma prainha enquanto contemplamos as primeiras luzes do dia.":
        "Contemplamos as primeiras luzes do dia de dentro da canoa. Na experiência de 1h30, há mais tempo para as paradas previstas no roteiro, com possibilidade de banho quando fizer parte do percurso.",
      "Paradas para banho": "Paradas previstas no roteiro da experiência de 1h30",
      "Roupa de banho": "Roupa de banho, se quiser entrar na água nas paradas da experiência de 1h30",
      "Uma experiência ao amanhecer para contemplar o despertar de Brasília, mergulhar no Lago Paranoá e começar o dia com mais energia e leveza.":
        "Uma experiência ao amanhecer para contemplar o despertar de Brasília e começar o dia com mais energia e leveza.",
    },
    facts: [
      { label: "Duração", from: "1h30", to: "1h ou 1h30, conforme o dia" },
      { label: "Horário de saída", from: "6h", to: "5h30 ou 5h, conforme o dia" },
      { label: "Chegada recomendada", from: "5h50", to: "10 minutos antes da sua turma" },
      { label: "Dias habituais", from: "sextas-feiras e sábados", to: null },
      { label: "Valor", from: "R$ 70 por pessoa", to: null },
      { label: "Capacidade padrão", from: "28 pessoas", to: null },
    ],
    faq: {
      "Que horas devo chegar?": [
        "A chegada está programada para 5h50, para que o grupo possa se preparar com tranquilidade antes da saída às 6h.",
        "Recomendamos chegar 10 minutos antes do horário da sua turma — às 5h20 para a turma das 5h30 e às 4h50 para a das 5h. O horário exato aparece na reserva e no e-mail de confirmação.",
      ],
    },
  },
  "remada-sunset": {
    texts: {
      "Duração: 1h30": "Duração: 1h ou 1h30",
      "Uma experiência de 1h30 em ritmo tranquilo, com paradas prolongadas para banho, contemplação e registros fotográficos feitos pelos instrutores.":
        "Uma remada guiada em ritmo tranquilo, com instrutores em cada canoa do início ao fim.",
      // Resumo (cards e reserva) e galeria.
      "Uma remada ao entardecer com pausas para banho, contemplação e as últimas luzes do dia no Lago Paranoá.":
        "Uma remada ao entardecer para contemplar as últimas luzes do dia no Lago Paranoá.",
      "Banho, contemplação e prainha": "O pôr do sol na água",
      "Durante o percurso, fazemos pausas prolongadas para banho e contemplação. A experiência termina em uma prainha, acompanhando as últimas luzes do pôr do sol antes do retorno à base.":
        "Acompanhamos as últimas luzes do dia de dentro da canoa. Na experiência de 1h30, há mais tempo para as paradas previstas no roteiro, com possibilidade de banho quando fizer parte do percurso, antes do retorno à base.",
      "Paradas para banho e contemplação": "Paradas previstas no roteiro da experiência de 1h30",
      "Roupa de banho": "Roupa de banho, se quiser entrar na água nas paradas da experiência de 1h30",
      "Uma experiência de 1h30 em canoa havaiana para contemplar o pôr do sol, aproveitar o Lago Paranoá e encerrar o dia em uma prainha, cercado pela natureza.":
        "Uma remada em canoa havaiana para contemplar o pôr do sol, aproveitar o Lago Paranoá e encerrar o dia cercado pela natureza.",
      "Contemple o pôr do sol de Brasília em uma canoa havaiana. Experiência de 1h30 com instrução, banho no lago, fotos e acompanhamento completo.":
        "Contemple o pôr do sol de Brasília em uma canoa havaiana: remadas de 1 hora durante a semana e a tradicional de 1h30 aos domingos, com instrução e acompanhamento completo.",
    },
    facts: [
      { label: "Duração", from: "1h30", to: "1h ou 1h30, conforme o dia" },
      { label: "Dias habituais", from: "sextas-feiras e domingos", to: null },
      { label: "Valor", from: "R$ 70 por pessoa", to: null },
      { label: "Capacidade padrão", from: "28 pessoas", to: null },
    ],
    faq: {},
  },
};

const TECHNICAL_KEYS = new Set(["id", "slug", "src", "href", "imageUrl", "icon", "alt", "credit"]);

function replaceTexts(value: unknown, texts: Record<string, string>): unknown {
  if (typeof value === "string") return Object.hasOwn(texts, value) ? texts[value] : value;
  if (Array.isArray(value)) return value.map((item) => replaceTexts(item, texts));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, TECHNICAL_KEYS.has(key) ? item : replaceTexts(item, texts)]));
  }
  return value;
}

/** Resumo da experiência lido fora da página (cards do catálogo, reserva). */
export function modalitySummary(slug: string, summary: string) {
  const copy = COPY[slug];
  return copy && Object.hasOwn(copy.texts, summary) ? copy.texts[summary] : summary;
}

export function applyModalityCopy(experience: PublicExperience): PublicExperience {
  const copy = COPY[experience.slug];
  if (!copy) return experience;

  const editorial = replaceTexts(experience.editorial, copy.texts) as PublicExperience["editorial"];
  const quickFacts = editorial.quickFacts.flatMap((fact) => {
    const rule = copy.facts.find((item) => item.label === fact.label.trim() && item.from === fact.value.trim());
    if (!rule) return [fact];
    return rule.to === null ? [] : [{ ...fact, value: rule.to }];
  });
  const faqItems = (editorial.faq?.items ?? []).map((item) => {
    const rule = copy.faq[item.question];
    return rule && item.answer === rule[0] ? { ...item, answer: rule[1] } : item;
  });
  if (!faqItems.some((item) => item.question === PHOTO_QUESTION)) faqItems.push({ question: PHOTO_QUESTION, answer: PHOTO_NOTE });
  const faq = { ...editorial.faq, eyebrow: editorial.faq?.eyebrow ?? "Dúvidas frequentes", title: editorial.faq?.title ?? "Antes de entrar na água.", items: faqItems };
  const included = editorial.included
    ? { ...editorial.included, items: editorial.included.items.filter((item) => !REMOVED_INCLUDED.has(item.title)) }
    : editorial.included;

  return {
    ...experience,
    summary: modalitySummary(experience.slug, experience.summary),
    editorial: { ...editorial, quickFacts, faq, included },
  };
}
