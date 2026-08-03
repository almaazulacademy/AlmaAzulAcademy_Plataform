const BRASILIA_TIME_ZONE = "America/Sao_Paulo";

export function formatCurrency(cents: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

export function formatAdminDateTime(value: string | null) {
  if (!value) return "Sem registro";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Data inválida";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: BRASILIA_TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatAdminDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Data inválida";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: BRASILIA_TIME_ZONE,
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function formatMaskedCpf(last4: string) {
  const normalized = last4.replace(/\D/g, "").slice(-4).padStart(4, "•");
  return `•••.•••.${normalized.slice(0, 2)}-${normalized.slice(2)}`;
}

export function formatAdminPhone(value: string) {
  const digits = value.replace(/\D/g, "").replace(/^55/, "").slice(0, 11);
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return value;
}

export function reservationMessage(name: string, publicCode: string) {
  return `Olá, ${name}! Seu código de reserva na Alma Azul Academy é ${publicCode}.`;
}
