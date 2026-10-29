/**
 * Como um evento especial aparece para o visitante: situação das vagas, textos
 * do botão, data, horário e preço no horário de Brasília.
 *
 * A situação vem do banco (`special_event_availability`): AVAILABLE, SOLD_OUT,
 * CLOSED, ENDED, CANCELLED ou NO_SESSION. Aqui só se decide o que mostrar.
 * Reservar continua sendo decidido por `create_pre_reservation`.
 *
 * Módulo puro, sem imports de aplicação: é lido pelo Next e pelos testes.
 */

export const EVENT_AVAILABILITIES = ["AVAILABLE", "SOLD_OUT", "CLOSED", "ENDED", "CANCELLED", "NO_SESSION"] as const;
export type EventAvailability = (typeof EVENT_AVAILABILITIES)[number];

export const EVENT_TIME_ZONE = "America/Sao_Paulo";

/** A partir de quantas vagas o selo passa a dizer "últimas vagas". */
export const LAST_SPOTS_THRESHOLD = 3;

export function parseAvailability(value: unknown): EventAvailability {
  return EVENT_AVAILABILITIES.includes(value as EventAvailability) ? value as EventAvailability : "NO_SESSION";
}

/** Próximo (ainda vai acontecer) ou edição anterior. */
export function isUpcoming(availability: EventAvailability) {
  return availability === "AVAILABLE" || availability === "SOLD_OUT" || availability === "CLOSED";
}

export type AvailabilityBadge = { label: string; tone: "open" | "last" | "closed" | "past" };

export function availabilityBadge(availability: EventAvailability, remainingSpots: number | null): AvailabilityBadge {
  switch (availability) {
    case "AVAILABLE":
      return remainingSpots !== null && remainingSpots <= LAST_SPOTS_THRESHOLD
        ? { label: remainingSpots === 1 ? "Última vaga" : `Últimas ${remainingSpots} vagas`, tone: "last" }
        : { label: "Vagas abertas", tone: "open" };
    case "SOLD_OUT":
      return { label: "Esgotado", tone: "closed" };
    case "CLOSED":
      return { label: "Reservas encerradas", tone: "closed" };
    case "CANCELLED":
      return { label: "Evento cancelado", tone: "past" };
    case "ENDED":
      return { label: "Evento realizado", tone: "past" };
    default:
      return { label: "Data a confirmar", tone: "closed" };
  }
}

export type EventCta =
  | { kind: "BOOK"; label: string; href: string }
  | { kind: "SOON"; label: string; note: string }
  | { kind: "UNAVAILABLE"; label: string; note: string };

/**
 * O botão de reserva. Com `bookingOpen` desligado — fase 4, antes do fluxo de
 * reserva do evento — o botão aparece, mas não leva a lugar nenhum.
 */
export function eventCta(options: {
  availability: EventAvailability;
  sessionId: string | null;
  ctaLabel: string;
  bookingOpen: boolean;
}): EventCta {
  const { availability, sessionId, ctaLabel, bookingOpen } = options;
  if (availability === "AVAILABLE") {
    if (bookingOpen && sessionId) return { kind: "BOOK", label: ctaLabel, href: `/reservar/${sessionId}` };
    return { kind: "SOON", label: ctaLabel, note: "As reservas pelo site abrem em breve." };
  }
  if (availability === "SOLD_OUT") return { kind: "UNAVAILABLE", label: "Esgotado", note: "Todas as vagas desta edição foram reservadas." };
  if (availability === "CLOSED") return { kind: "UNAVAILABLE", label: "Reservas encerradas", note: "As reservas para esta edição foram encerradas." };
  if (availability === "ENDED") return { kind: "UNAVAILABLE", label: "Evento realizado", note: "Esta edição já aconteceu." };
  if (availability === "CANCELLED") return { kind: "UNAVAILABLE", label: "Evento cancelado", note: "Esta edição foi cancelada." };
  return { kind: "UNAVAILABLE", label: "Data a confirmar", note: "A data desta edição ainda será divulgada." };
}

function parts(value: string | Date) {
  const date = typeof value === "string" ? new Date(value) : value;
  const format = new Intl.DateTimeFormat("pt-BR", {
    timeZone: EVENT_TIME_ZONE,
    day: "2-digit",
    month: "short",
    weekday: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, string> = {};
  for (const part of format.formatToParts(date)) map[part.type] = part.value;
  return map;
}

/** "07 NOV · SÁBADO" */
export function eventDayLabel(startsAt: string) {
  const p = parts(startsAt);
  const month = p.month.replace(".", "").toUpperCase();
  const weekday = p.weekday.split("-")[0].toUpperCase();
  return `${p.day} ${month} · ${weekday}`;
}

/** "07 de novembro de 2026" */
export function eventLongDate(startsAt: string) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: EVENT_TIME_ZONE, day: "2-digit", month: "long", year: "numeric" }).format(new Date(startsAt));
}

function clock(date: Date) {
  const p = parts(date);
  return p.minute === "00" ? `${p.hour}H` : `${p.hour}H${p.minute}`;
}

/** "05H30 ÀS 09H" */
export function eventTimeRange(startsAt: string, durationMinutes: number) {
  const start = new Date(startsAt);
  const end = new Date(start.getTime() + Math.max(0, durationMinutes) * 60_000);
  return `${clock(start)} ÀS ${clock(end)}`;
}

/** "05h30" a partir de "05:30" da programação. */
export function programTimeLabel(time: string) {
  const [hour, minute] = time.split(":");
  return minute === "00" ? `${hour}h` : `${hour}h${minute}`;
}

/** "R$ 150" — sem centavos quando o valor é redondo. */
export function eventPrice(cents: number) {
  const value = cents / 100;
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value).replace(/ /g, " ");
}

/** "12 vagas", "1 vaga" — só enquanto há vaga para vender. */
export function spotsLabel(availability: EventAvailability, remainingSpots: number | null) {
  if (availability === "SOLD_OUT") return "Esgotado";
  if (availability !== "AVAILABLE" || remainingSpots === null) return null;
  return remainingSpots === 1 ? "1 vaga" : `${remainingSpots} vagas`;
}
