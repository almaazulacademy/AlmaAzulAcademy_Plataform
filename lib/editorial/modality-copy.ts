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
 */

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
        "Uma experiência em ritmo tranquilo, com pausas para banho, contemplação e registros fotográficos feitos pelos instrutores.",
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

export function applyModalityCopy(experience: PublicExperience): PublicExperience {
  const copy = COPY[experience.slug];
  if (!copy) return experience;

  const editorial = replaceTexts(experience.editorial, copy.texts) as PublicExperience["editorial"];
  const quickFacts = editorial.quickFacts.flatMap((fact) => {
    const rule = copy.facts.find((item) => item.label === fact.label.trim() && item.from === fact.value.trim());
    if (!rule) return [fact];
    return rule.to === null ? [] : [{ ...fact, value: rule.to }];
  });
  const faq = editorial.faq
    ? {
        ...editorial.faq,
        items: editorial.faq.items.map((item) => {
          const rule = copy.faq[item.question];
          return rule && item.answer === rule[0] ? { ...item, answer: rule[1] } : item;
        }),
      }
    : editorial.faq;

  return { ...experience, editorial: { ...editorial, quickFacts, faq } };
}
