/**
 * Tradução de um snapshot do Supabase para as linhas da planilha.
 *
 * Tudo aqui é função pura: entra dado, sai linha. Nenhuma chamada de rede,
 * nenhum acesso a banco, nenhum segredo. É por isso que os testes conseguem
 * cobrir expansão de vagas, idempotência e cancelamento sem nunca falar com o
 * Google.
 *
 * O que este módulo **não** conhece é tão importante quanto o que ele conhece:
 * CPF, hash de CPF, e-mail, endereço, checkout_url, referência do provedor e
 * observações digitadas pelo cliente não existem no tipo de entrada. O snapshot
 * vem de RPCs que nunca os devolvem.
 */

import { formatAdminPhone } from "../../admin/format.ts";
import { formatSessionDateShort, formatSessionTime } from "../../sessions/date-time.ts";
import {
  ACTIVE_NO,
  ACTIVE_YES,
  SITE_ORIGIN,
} from "./schema.ts";

export type SheetValue = string | number;

export type ReservationSnapshot = {
  id: string;
  sessionId: string;
  publicCode: string;
  fullName: string;
  phone: string;
  quantity: number;
  totalCents: number;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  createdAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
};

export type SessionSnapshot = {
  id: string;
  experienceTitle: string;
  startsAt: string;
  durationMinutes: number;
  capacity: number;
  confirmedSpots: number;
  remainingSpots: number;
  status: string;
};

export type SyncSnapshot = {
  session: SessionSnapshot;
  reservations: ReservationSnapshot[];
};

const RESERVATION_STATUS_LABEL: Record<string, string> = {
  PRE_RESERVED: "Pré-reserva",
  CONFIRMED: "Confirmada",
  EXPIRED: "Expirada",
  CANCELLED: "Cancelada",
};

const PAYMENT_STATUS_LABEL: Record<string, string> = {
  PAID: "Pago",
  PAID_AFTER_EXPIRATION: "Pago após expiração",
  PENDING: "Pendente",
  NOT_PAID: "Não pago",
};

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  pix: "PIX",
  credit_card: "Cartão de crédito",
  debit_card: "Cartão de débito",
  boleto: "Boleto",
  manual: "Confirmação manual",
};

const SESSION_STATUS_LABEL: Record<string, string> = {
  OPEN: "Aberta",
  CLOSED: "Fechada",
  CANCELLED: "Cancelada",
  ARCHIVED: "Arquivada",
};

export function reservationStatusLabel(status: string) {
  return RESERVATION_STATUS_LABEL[status] ?? status;
}

export function paymentStatusLabel(status: string) {
  return PAYMENT_STATUS_LABEL[status] ?? status;
}

export function paymentMethodLabel(method: string) {
  const normalized = method.trim().toLowerCase();
  if (!normalized) return "Não informado";
  return PAYMENT_METHOD_LABEL[normalized] ?? normalized;
}

export function sessionStatusLabel(status: string) {
  return SESSION_STATUS_LABEL[status] ?? status;
}

/** Chave conceitual de uma vaga individual: `reservation_id:índice`. */
export function spotKey(reservationId: string, participantIndex: number) {
  return `${reservationId}:${participantIndex}`;
}

/** Rótulo do dropdown: `06/09/2026 · Imersão Paranoá · 09:00`. */
export function sessionLabel(session: SessionSnapshot) {
  return `${formatSessionDateShort(session.startsAt)} · ${session.experienceTitle} · ${formatSessionTime(session.startsAt)}`;
}

function timestampLabel(value: string) {
  return `${formatSessionDateShort(value)} ${formatSessionTime(value)}`;
}

/** Reais, não centavos: a planilha formata a coluna como moeda. */
function toReais(cents: number) {
  return Math.round(cents) / 100;
}

/**
 * Somente uma vaga confirmada entra na lista operacional da turma. Cancelada,
 * expirada ou ainda em pré-reserva não vira participante — mas a linha continua
 * existindo, marcada como inativa, para preservar o histórico.
 */
export function isActiveSpot(reservation: ReservationSnapshot) {
  return reservation.status === "CONFIRMED";
}

/**
 * Observação operacional gerada pelo sistema.
 *
 * Deliberadamente não é o campo `notes` da reserva: aquele é texto livre
 * digitado pelo cliente e pode conter qualquer coisa, inclusive dado pessoal
 * que não tem por que viajar até a planilha.
 */
export function operationalNote(reservation: ReservationSnapshot) {
  const parts: string[] = [];
  if (reservation.quantity > 1) parts.push(`Reserva de ${reservation.quantity} pessoas`);
  if (reservation.paymentStatus === "PAID_AFTER_EXPIRATION") parts.push("Pagamento reconciliado após expiração");
  if (reservation.paymentMethod.trim().toLowerCase() === "manual") parts.push("Confirmação manual");
  if (reservation.status === "CANCELLED" && reservation.cancelledAt) {
    parts.push(`Cancelada em ${timestampLabel(reservation.cancelledAt)}`);
  }
  return parts.join(" · ");
}

/** Uma linha por reserva na aba `Reservas do Site`. */
export function reservationRow(
  reservation: ReservationSnapshot,
  session: SessionSnapshot,
  syncedAt: string,
): SheetValue[] {
  return [
    reservation.id,
    reservation.publicCode,
    session.id,
    session.experienceTitle,
    formatSessionDateShort(session.startsAt),
    formatSessionTime(session.startsAt),
    reservation.fullName,
    formatAdminPhone(reservation.phone),
    reservation.quantity,
    toReais(reservation.totalCents),
    reservationStatusLabel(reservation.status),
    paymentStatusLabel(reservation.paymentStatus),
    paymentMethodLabel(reservation.paymentMethod),
    SITE_ORIGIN,
    timestampLabel(syncedAt),
  ];
}

/** Uma linha por sessão na aba `Sessões`. Números vêm do sistema, não da planilha. */
export function sessionRow(session: SessionSnapshot, syncedAt: string): SheetValue[] {
  return [
    session.id,
    session.experienceTitle,
    formatSessionDateShort(session.startsAt),
    formatSessionTime(session.startsAt),
    session.capacity,
    session.confirmedSpots,
    session.remainingSpots,
    sessionStatusLabel(session.status),
    timestampLabel(syncedAt),
    sessionLabel(session),
  ];
}

/**
 * Uma linha por vaga ocupada.
 *
 * Uma reserva de três pessoas ocupa três vagas e repete o nome do responsável,
 * porque ainda não coletamos o nome de cada participante. O valor total aparece
 * uma única vez, na primeira vaga: é isso que impede R$ 210 de virar R$ 630 na
 * arrecadação da turma.
 */
export function spotRows(
  reservation: ReservationSnapshot,
  session: SessionSnapshot,
  syncedAt: string,
): Array<{ key: string; values: SheetValue[] }> {
  const active = isActiveSpot(reservation);
  const baseNote = operationalNote(reservation);
  const quantity = Math.max(1, Math.trunc(reservation.quantity));

  return Array.from({ length: quantity }, (_, offset) => {
    const participantIndex = offset + 1;
    const note = participantIndex === 1
      ? baseNote
      : [`Vaga ${participantIndex} de ${quantity} da mesma reserva`, baseNote].filter(Boolean).join(" · ");

    return {
      key: spotKey(reservation.id, participantIndex),
      values: [
        spotKey(reservation.id, participantIndex),
        reservation.id,
        session.id,
        participantIndex,
        reservation.publicCode,
        reservation.fullName,
        formatAdminPhone(reservation.phone),
        participantIndex === 1 ? toReais(reservation.totalCents) : "",
        paymentMethodLabel(reservation.paymentMethod),
        reservationStatusLabel(reservation.status),
        note,
        active ? ACTIVE_YES : ACTIVE_NO,
        reservation.createdAt,
        timestampLabel(syncedAt),
      ],
    };
  });
}

// --- Leitura defensiva do snapshot vindo do banco ---------------------------

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function nullableString(value: unknown) {
  const text = asString(value);
  return text || null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseSnapshot(value: unknown): SyncSnapshot | null {
  const root = asRecord(value);
  const sessionRecord = root ? asRecord(root.session) : null;
  if (!sessionRecord) return null;

  const session: SessionSnapshot = {
    id: asString(sessionRecord.id),
    experienceTitle: asString(sessionRecord.experienceTitle),
    startsAt: asString(sessionRecord.startsAt),
    durationMinutes: asNumber(sessionRecord.durationMinutes),
    capacity: asNumber(sessionRecord.capacity),
    confirmedSpots: asNumber(sessionRecord.confirmedSpots),
    remainingSpots: asNumber(sessionRecord.remainingSpots),
    status: asString(sessionRecord.status),
  };
  if (!session.id || !session.startsAt) return null;

  const rawReservations = Array.isArray(root?.reservations) ? root.reservations : [];
  const reservations = rawReservations
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item): ReservationSnapshot => ({
      id: asString(item.id),
      sessionId: asString(item.sessionId) || session.id,
      publicCode: asString(item.publicCode),
      fullName: asString(item.fullName),
      phone: asString(item.phone),
      quantity: Math.max(1, asNumber(item.quantity)),
      totalCents: asNumber(item.totalCents),
      status: asString(item.status),
      paymentStatus: asString(item.paymentStatus),
      paymentMethod: asString(item.paymentMethod),
      createdAt: asString(item.createdAt),
      confirmedAt: nullableString(item.confirmedAt),
      cancelledAt: nullableString(item.cancelledAt),
    }))
    .filter((reservation) => Boolean(reservation.id));

  return { session, reservations };
}
