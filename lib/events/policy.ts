/**
 * Regras operacionais de um evento especial que têm data e hora: a tolerância
 * de chegada e o prazo de cancelamento. Os valores vêm do `editorial_content`
 * de cada evento (bloco `event.arrival` e `event.cancellation`); nada aqui é
 * específico de uma edição.
 *
 * O prazo de cancelamento é guardado como instante inequívoco: ISO 8601 com o
 * deslocamento explícito (`2026-11-05T12:00:00-03:00`) e o fuso de exibição
 * (`America/Sao_Paulo`). O prazo é **inclusivo**: um pedido recebido
 * exatamente no instante limite ainda está dentro dele.
 *
 * Esta fase só informa. Não há cancelamento, crédito, reembolso nem
 * reagendamento automáticos: o crédito para outras experiências é
 * implementado na fase 5, e o reembolso é pedido pelo atendimento oficial no
 * WhatsApp e devolvido manualmente pela equipe.
 *
 * Módulo puro, sem imports de aplicação: é lido pelo Next e pelos testes.
 */

export const POLICY_TIME_ZONE = "America/Sao_Paulo";

/** ISO 8601 com data, hora e deslocamento explícito (Z ou ±HH:MM). */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

export type EventArrival = {
  /** Início da experiência, "05:30", no horário de Brasília. */
  startTime: string;
  /** Até quando a chegada é tolerada, "05:50". */
  toleranceUntil: string;
};

export type EventCancellation = {
  /** Instante limite, ISO com deslocamento. Inclusivo. */
  deadline: string;
  timeZone: typeof POLICY_TIME_ZONE;
  /** Resumo curto ao lado do botão de reserva, ex.: "crédito para outras experiências ou reembolso". */
  summary: string;
};

export type CancellationWindow = "WITHIN_DEADLINE" | "AFTER_DEADLINE";

export function isIsoWithOffset(value: string) {
  return ISO_WITH_OFFSET.test(value) && !Number.isNaN(new Date(value).getTime());
}

export function isClockTime(value: string) {
  return HH_MM.test(value);
}

/**
 * Pedido dentro ou fora do prazo. Até o instante limite, inclusive, está
 * dentro; depois dele, fica para análise da equipe — sem promessa automática.
 */
export function cancellationWindow(cancellation: Pick<EventCancellation, "deadline">, requestedAt: Date): CancellationWindow {
  return requestedAt.getTime() <= new Date(cancellation.deadline).getTime() ? "WITHIN_DEADLINE" : "AFTER_DEADLINE";
}

function zonedParts(value: string | Date) {
  const format = new Intl.DateTimeFormat("pt-BR", {
    timeZone: POLICY_TIME_ZONE,
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, string> = {};
  for (const part of format.formatToParts(typeof value === "string" ? new Date(value) : value)) map[part.type] = part.value;
  return map;
}

/** "5 de novembro de 2026", no horário de Brasília. */
export function deadlineDayText(deadline: string) {
  const p = zonedParts(deadline);
  return `${p.day} de ${p.month} de ${p.year}`;
}

/** "12h00", no horário de Brasília. */
export function deadlineTimeText(deadline: string) {
  const p = zonedParts(deadline);
  return `${p.hour}h${p.minute}`;
}

/** "05/11/2026 às 12h00 (horário de Brasília)" — a linha curta do bloco de reserva. */
export function deadlineShortText(deadline: string) {
  const date = new Intl.DateTimeFormat("pt-BR", { timeZone: POLICY_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(deadline));
  return `${date} às ${deadlineTimeText(deadline)} (horário de Brasília)`;
}

/** "05h50" a partir de "05:50". */
export function clockText(time: string) {
  const [hour, minute] = time.split(":");
  return `${hour}h${minute}`;
}

/** Horário de início da sessão no fuso de Brasília, "05:30". */
export function sessionStartClock(startsAt: string) {
  const p = zonedParts(startsAt);
  return `${p.hour}:${p.minute}`;
}

/**
 * A chegada combina com a sessão cadastrada: começa no mesmo horário e a
 * tolerância cai depois do início e antes do fim.
 */
export function arrivalMatchesSession(arrival: EventArrival, startsAt: string, durationMinutes: number) {
  if (sessionStartClock(startsAt) !== arrival.startTime) return false;
  const [startHour, startMinute] = arrival.startTime.split(":").map(Number);
  const [toleranceHour, toleranceMinute] = arrival.toleranceUntil.split(":").map(Number);
  const offset = toleranceHour * 60 + toleranceMinute - (startHour * 60 + startMinute);
  return offset > 0 && offset < durationMinutes;
}
