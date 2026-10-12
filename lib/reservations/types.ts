import type { BaseLocation } from "../bases/location.ts";

/**
 * `AWAITING_RESCHEDULE` ("Aguardando reagendamento") é uma reserva paga que saiu
 * da turma original por decisão administrativa e ainda não tem nova turma. Não
 * ocupa vaga, e **não** é cancelamento, expiração nem pagamento pendente.
 */
export const RESERVATION_STATUSES = ["PRE_RESERVED", "CONFIRMED", "EXPIRED", "CANCELLED", "AWAITING_RESCHEDULE"] as const;

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export function isReservationStatus(value: unknown): value is ReservationStatus {
  return typeof value === "string" && (RESERVATION_STATUSES as readonly string[]).includes(value);
}

/** Rótulo de cada status, em um lugar só: painel, planilha e página pública. */
export const RESERVATION_STATUS_LABELS: Record<ReservationStatus, string> = {
  PRE_RESERVED: "Pré-reserva",
  CONFIRMED: "Confirmada",
  EXPIRED: "Expirada",
  CANCELLED: "Cancelada",
  AWAITING_RESCHEDULE: "Aguardando reagendamento",
};

/**
 * Status em que o pagamento da reserva está confirmado. Nenhum caminho de
 * pagamento — webhook, retorno, verificação, reconciliação ou confirmação
 * manual — tem o que fazer com uma reserva nesses estados.
 */
export function isPaymentSettledStatus(status: unknown) {
  return status === "CONFIRMED" || status === "AWAITING_RESCHEDULE";
}

export type BookingSession = {
  id: string;
  experienceId: string;
  experienceSlug: string;
  experienceTitle: string;
  experienceSummary: string;
  startsAt: string;
  durationMinutes: number;
  priceCents: number;
  remainingSpots: number;
};

export type ReservationDetails = {
  publicCode: string;
  status: ReservationStatus;
  expiresAt: string;
  quantity: number;
  totalCents: number;
  checkoutUrl: string | null;
  fullName: string;
  session: BookingSession;
  /** Local de encontro, da base da experiência reservada. null se a base não puder ser lida. */
  location: BaseLocation | null;
};

export type CreateReservationInput = {
  sessionId: string;
  fullName: string;
  cpf: string;
  phone: string;
  email: string;
  quantity: number;
  notes?: string;
  idempotencyKey: string;
};
