export const RESERVATION_STATUSES = ["PRE_RESERVED", "CONFIRMED", "EXPIRED", "CANCELLED"] as const;

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

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
