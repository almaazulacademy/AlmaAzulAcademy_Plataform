/**
 * Token do QR de check-in e estado de presença.
 *
 * Funções puras, sem rede nem banco, para os testes cobrirem exatamente o que o
 * painel e o e-mail usam.
 *
 * O QR carrega **só** uma URL com o token (`/checkin/<uuid>`): nada de nome,
 * CPF, telefone, e-mail ou código da reserva. O token é um UUID v4 aleatório
 * gerado pelo banco na confirmação e nunca muda.
 */

import { SITE_URL } from "../site.ts";

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CHECKIN_PATH = "/checkin";

export function isCheckinToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/** URL gravada no QR. Aberta por um celular qualquer, só valida o QR. */
export function checkinUrl(token: string, origin: string = SITE_URL) {
  return `${origin.replace(/\/$/, "")}${CHECKIN_PATH}/${token.toLowerCase()}`;
}

/** Imagem PNG do QR, usada no e-mail (cliente de e-mail não renderiza SVG nem data URI). */
export function checkinQrImageUrl(token: string, origin: string = SITE_URL) {
  return `${origin.replace(/\/$/, "")}/api/checkin/qr/${token.toLowerCase()}`;
}

/**
 * Extrai o token do texto lido pela câmera.
 *
 * Aceita a URL completa (de qualquer origem — produção, preview ou localhost)
 * ou o UUID puro. Qualquer outra coisa é recusada.
 */
export function extractCheckinToken(scanned: string): string | null {
  const text = scanned.trim();
  if (TOKEN_PATTERN.test(text)) return text.toLowerCase();
  const match = /\/checkin\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(text);
  return match && TOKEN_PATTERN.test(match[1]) ? match[1].toLowerCase() : null;
}

export type PresenceState = "WAITING" | "COMPLETE" | "PARTIAL" | "ABSENT";

/** null = ninguém registrou ainda; 0 = ausência registrada. */
export function presenceState(quantity: number, checkedInCount: number | null): PresenceState {
  if (checkedInCount === null) return "WAITING";
  if (checkedInCount <= 0) return "ABSENT";
  if (checkedInCount >= quantity) return "COMPLETE";
  return "PARTIAL";
}

export const PRESENCE_LABELS: Record<PresenceState, string> = {
  WAITING: "Aguardando",
  COMPLETE: "Check-in concluído",
  PARTIAL: "Check-in parcial",
  ABSENT: "Ausente",
};

export type AttendanceTotals = {
  reservations: number;
  reservedSpots: number;
  present: number;
  /** Reservas ainda sem nenhum registro de presença. */
  pendingReservations: number;
  /** Vagas de reservas ainda sem registro. */
  pendingSpots: number;
};

export function attendanceTotals(rows: Array<{ quantity: number; checkedInCount: number | null }>): AttendanceTotals {
  return rows.reduce<AttendanceTotals>(
    (totals, row) => ({
      reservations: totals.reservations + 1,
      reservedSpots: totals.reservedSpots + row.quantity,
      present: totals.present + (row.checkedInCount ?? 0),
      pendingReservations: totals.pendingReservations + (row.checkedInCount === null ? 1 : 0),
      pendingSpots: totals.pendingSpots + (row.checkedInCount === null ? row.quantity : 0),
    }),
    { reservations: 0, reservedSpots: 0, present: 0, pendingReservations: 0, pendingSpots: 0 },
  );
}

/** Data local (Brasília) no formato yyyy-mm-dd, com deslocamento em dias. */
export function localDateKey(now: Date = new Date(), offsetDays = 0) {
  const shifted = new Date(now.getTime() + offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(shifted);
  return parts;
}

export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
