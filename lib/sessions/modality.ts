/**
 * Duração e modalidade de uma turma, para o cliente ler.
 *
 * Desde dezembro/2026 a mesma experiência pode ter turmas de 1 hora (dias de
 * semana, R$ 60) e turmas tradicionais de 1h30 (fins de semana e feriados,
 * R$ 70). A fonte de verdade continua sendo a sessão: `duration_minutes` e
 * `price_cents` de cada linha de `public.sessions`. Nada aqui calcula preço ou
 * duração a partir do dia da semana — só descreve o que a sessão já é.
 *
 * Funções puras: sem rede, sem banco, sem `Date.now()`.
 */

import { toSessionDateTimeLocal } from "./date-time.ts";
import { brasiliaHolidayName } from "./holidays.ts";

/** `60` → "1 hora", `90` → "1h30", `120` → "2 horas", `45` → "45 minutos". */
export function formatDurationLabel(minutes: number) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole} minutos`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (rest === 0) return hours === 1 ? "1 hora" : `${hours} horas`;
  return `${hours}h${String(rest).padStart(2, "0")}`;
}

/** "1 hora de experiência" / "1h30 de experiência"; vazio sem duração. */
export function formatExperienceDuration(minutes: number) {
  const label = formatDurationLabel(minutes);
  return label ? `${label} de experiência` : "";
}

/** Dia local de Brasília (`AAAA-MM-DD`) e dia ISO da semana (1 = segunda … 7 = domingo). */
export function sessionLocalDay(startsAt: string) {
  const local = toSessionDateTimeLocal(startsAt);
  const dayKey = local.slice(0, 10);
  const [year, month, day] = dayKey.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { dayKey, time: local.slice(11, 16), isoWeekday: weekday === 0 ? 7 : weekday };
}

/** Feriado em Brasília no dia local da sessão, ou null. */
export function sessionHolidayName(startsAt: string) {
  return brasiliaHolidayName(sessionLocalDay(startsAt).dayKey);
}

const WEEKDAY_PLURAL = ["", "segundas", "terças", "quartas", "quintas", "sextas", "sábados", "domingos"] as const;

function joinPortuguese(items: string[]) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

/** `[1,3,5]` → "segundas, quartas e sextas"; `[1..5]` → "segunda a sexta". */
export function describeWeekdays(isoWeekdays: readonly number[]) {
  const days = [...new Set(isoWeekdays)].filter((day) => day >= 1 && day <= 7).sort((a, b) => a - b);
  if (!days.length) return "";
  if (days.length === 7) return "todos os dias";
  if (days.join(",") === "1,2,3,4,5") return "segunda a sexta";
  if (days.join(",") === "6,7") return "sábados e domingos";
  return joinPortuguese(days.map((day) => WEEKDAY_PLURAL[day]));
}

type ModalitySession = { startsAt: string; durationMinutes: number; priceCents: number };

/** As turmas de uma experiência com a mesma duração e o mesmo preço. */
export type ModalitySummary = {
  durationMinutes: number;
  priceCents: number;
  /** Horários de início, sem repetição, na ordem do relógio. */
  times: string[];
  /** Dias ISO da semana em que acontece, sem contar feriados. */
  weekdays: number[];
  /** Dias (`AAAA-MM-DD`) de feriado em que acontece. */
  holidays: string[];
  sessionCount: number;
};

/**
 * Agrupa as turmas por duração + preço — é isso que define uma modalidade.
 * Feriados ficam à parte dos dias da semana: uma sexta-feira de feriado com a
 * turma de 1h30 não transforma o formato de fim de semana em "sextas".
 */
export function summarizeModalities(sessions: readonly ModalitySession[]): ModalitySummary[] {
  const groups = new Map<string, ModalitySummary & { timeSet: Set<string>; daySet: Set<number>; holidaySet: Set<string> }>();
  for (const session of sessions) {
    const key = `${session.durationMinutes}|${session.priceCents}`;
    const group = groups.get(key) ?? {
      durationMinutes: session.durationMinutes,
      priceCents: session.priceCents,
      times: [],
      weekdays: [],
      holidays: [],
      sessionCount: 0,
      timeSet: new Set<string>(),
      daySet: new Set<number>(),
      holidaySet: new Set<string>(),
    };
    const day = sessionLocalDay(session.startsAt);
    group.timeSet.add(day.time);
    if (brasiliaHolidayName(day.dayKey)) group.holidaySet.add(day.dayKey);
    else group.daySet.add(day.isoWeekday);
    group.sessionCount += 1;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ timeSet, daySet, holidaySet, ...group }) => ({
      ...group,
      times: [...timeSet].sort(),
      weekdays: [...daySet].sort((a, b) => a - b),
      holidays: [...holidaySet].sort(),
    }))
    .sort((a, b) => a.durationMinutes - b.durationMinutes || a.priceCents - b.priceCents);
}

/** Há algum dia com mais de um horário? Só então "turmas no mesmo dia" é verdade. */
export function hasSeveralTimesOnSameDay(sessions: readonly { startsAt: string }[]) {
  const timesByDay = new Map<string, Set<string>>();
  for (const session of sessions) {
    const day = sessionLocalDay(session.startsAt);
    const times = timesByDay.get(day.dayKey) ?? new Set<string>();
    times.add(day.time);
    timesByDay.set(day.dayKey, times);
  }
  return [...timesByDay.values()].some((times) => times.size > 1);
}
