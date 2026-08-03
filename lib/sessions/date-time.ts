export const SESSION_TIME_ZONE = "America/Sao_Paulo";

type SessionDateTimeValue = string | Date;

function sessionFormatter(options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("pt-BR", {
    ...options,
    timeZone: SESSION_TIME_ZONE,
  });
}

function parseSessionDateTime(value: SessionDateTimeValue) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError("Data de sessão inválida.");
  return date;
}

export function formatSessionWeekday(value: SessionDateTimeValue) {
  return sessionFormatter({ weekday: "long" }).format(parseSessionDateTime(value));
}

export function formatSessionDayMonth(value: SessionDateTimeValue) {
  return sessionFormatter({ day: "2-digit", month: "long" }).format(parseSessionDateTime(value));
}

export function formatSessionDate(value: SessionDateTimeValue) {
  return sessionFormatter({
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(parseSessionDateTime(value));
}

export function formatSessionTime(value: SessionDateTimeValue) {
  return sessionFormatter({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(parseSessionDateTime(value));
}

export function formatSessionDateTime(value: SessionDateTimeValue) {
  return sessionFormatter({ dateStyle: "medium", timeStyle: "short", hourCycle: "h23" }).format(parseSessionDateTime(value));
}

export function formatSessionDateShort(value: SessionDateTimeValue) {
  return sessionFormatter({ day: "2-digit", month: "2-digit", year: "numeric" }).format(parseSessionDateTime(value));
}

export function toSessionDateTimeLocal(value: SessionDateTimeValue) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SESSION_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(parseSessionDateTime(value));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

export function sessionLocalToIso(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return "";
  const parsed = new Date(`${value}:00-03:00`);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}
