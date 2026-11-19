/**
 * Modalidades aprovadas das remadas regulares (programação de dezembro/2026).
 *
 * Durante a semana: 1 hora, R$ 60. Fins de semana e feriados: a experiência
 * tradicional de 1h30, R$ 70. Este arquivo guarda só o **texto** que apresenta
 * cada formato na página da experiência. Preço, duração, horário e vagas de
 * cada turma continuam vindo da sessão no banco — na grade de datas, no resumo
 * da reserva e no checkout. Por isso cada modalidade é ligada às turmas reais
 * pela duração e pelo preço: sem turma aberta naquele formato, o bloco avisa
 * que as datas abrem em breve em vez de prometer um horário sem reserva.
 *
 * Experiências sem formato de dia de semana (Imersão Paranoá, Rota Ermida
 * Ponte JK) não entram aqui e seguem com o quadro de turmas de sempre.
 */

export type ExperienceModality = {
  /** Rótulo curto: "Durante a semana", "Domingos". */
  eyebrow: string;
  title: string;
  text: string;
  /** Dias e horário da programação aprovada, como o cliente lê. */
  schedule: string;
  durationMinutes: number;
  priceCents: number;
};

export type ExperienceModalities = {
  /** Vagas por turma na base: Lago Norte 24, Cápsula Bar 12. */
  capacity: number;
  items: [ExperienceModality, ExperienceModality];
};

export const LAGO_NORTE_CAPACITY = 24;
export const CAPSULA_BAR_CAPACITY = 12;

export const HOLIDAY_NOTE = "Em feriados, vale a configuração de cada turma, informada na agenda e no resumo da reserva.";

const MODALITIES: Record<string, ExperienceModalities> = {
  "remada-sunset": {
    capacity: LAGO_NORTE_CAPACITY,
    items: [
      {
        eyebrow: "Durante a semana",
        title: "Uma pausa na rotina",
        text: "Uma hora para deixar as preocupações em terra firme, respirar novos ares e contemplar o pôr do sol no Lago Paranoá.",
        schedule: "Segundas, quartas e sextas, às 17h30",
        durationMinutes: 60,
        priceCents: 6000,
      },
      {
        eyebrow: "Domingos",
        title: "Mais tempo para aproveitar",
        text: "Nossa experiência tradicional de 1h30, para remar com tranquilidade e aproveitar o entardecer em meio à natureza.",
        schedule: "Domingos, às 17h",
        durationMinutes: 90,
        priceCents: 7000,
      },
    ],
  },
  "remada-nascer-do-sol": {
    capacity: LAGO_NORTE_CAPACITY,
    items: [
      {
        eyebrow: "Durante a semana",
        title: "Seu dia começa diferente",
        text: "Uma hora de conexão com a natureza antes da rotina começar: contemplar o nascer do sol, movimentar o corpo e começar a manhã com uma nova energia.",
        schedule: "Segundas, quartas e sextas, às 5h30",
        durationMinutes: 60,
        priceCents: 6000,
      },
      {
        eyebrow: "Sábados",
        title: "Um amanhecer sem pressa",
        text: "Nossa experiência tradicional de 1h30, com mais tempo para contemplar a paisagem e aproveitar a tranquilidade das primeiras horas do dia.",
        schedule: "Sábados, às 5h",
        durationMinutes: 90,
        priceCents: 7000,
      },
    ],
  },
  "remada-sunset-concha-acustica": {
    capacity: CAPSULA_BAR_CAPACITY,
    items: [
      {
        eyebrow: "Durante a semana",
        title: "Uma pausa no fim do dia",
        text: "Uma hora de remada para respirar novos ares, contemplar a paisagem e renovar as energias.",
        schedule: "Segunda a sexta, às 17h30",
        durationMinutes: 60,
        priceCents: 6000,
      },
      {
        eyebrow: "Fins de semana",
        title: "Mais tempo no lago",
        text: "Mais momentos para aproveitar: uma experiência de 1h30 para viver o entardecer sem pressa.",
        schedule: "Sábados e domingos, às 17h",
        durationMinutes: 90,
        priceCents: 7000,
      },
    ],
  },
};

export function experienceModalities(slug: string): ExperienceModalities | null {
  return MODALITIES[slug] ?? null;
}
