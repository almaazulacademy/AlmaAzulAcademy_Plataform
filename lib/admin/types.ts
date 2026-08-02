import type { ReservationStatus } from "@/lib/reservations/types";

export const SESSION_STATUSES = ["OPEN", "CLOSED", "CANCELLED"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const EXPERIENCE_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type ExperienceStatus = (typeof EXPERIENCE_STATUSES)[number];

export const ADMIN_ROLES = ["ADMIN", "OPERATOR"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const PAYMENT_STATUSES = ["PENDING", "PAID", "PAID_AFTER_EXPIRATION", "NOT_PAID"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export type AdminProfile = {
  userId: string;
  email: string;
  displayName: string;
  role: AdminRole;
};

export type AdminContext = {
  profile: AdminProfile;
};

export type AdminDashboardMetrics = {
  nextSession: {
    id: string;
    experienceTitle: string;
    startsAt: string;
    remainingSpots: number;
  } | null;
  futureSessions: number;
  confirmedReservations: number;
  preReservations: number;
  expectedRevenueCents: number;
  confirmedRevenueCents: number;
  totalParticipants: number;
  lastUpdatedAt: string | null;
};

export type AdminExperience = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  status: ExperienceStatus;
  imageUrl: string | null;
  displayOrder: number;
  sessionsCount: number;
  createdAt: string;
  updatedAt: string;
};

export type AdminSession = {
  id: string;
  experienceId: string;
  experienceTitle: string;
  startsAt: string;
  durationMinutes: number;
  priceCents: number;
  capacity: number;
  remainingSpots: number;
  reservationsCount: number;
  status: SessionStatus;
  internalNotes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminReservation = {
  id: string;
  publicCode: string;
  status: ReservationStatus;
  fullName: string;
  cpfLast4: string;
  phone: string;
  email: string;
  quantity: number;
  totalCents: number;
  notes: string | null;
  expiresAt: string;
  paymentProvider: string | null;
  providerReference: string | null;
  paymentStatus: PaymentStatus;
  confirmedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  sessionId: string;
  startsAt: string;
  experienceId: string;
  experienceTitle: string;
};

export type AdminReservationDetails = AdminReservation & {
  unitPriceCents: number;
  checkoutUrl: string | null;
  durationMinutes: number;
};

export type AdminReservationFilters = {
  date: string;
  experienceId: string;
  status: ReservationStatus | "";
  name: string;
  phone: string;
  cpf: string;
  sessionId: string;
};

export type PlatformSettings = {
  companyName: string;
  whatsapp: string | null;
  email: string | null;
  pixKey: string | null;
  infinitePayConfigured: boolean;
  domain: string | null;
  updatedAt: string | null;
};

export type AdminSessionInput = {
  experienceId: string;
  startsAt: string;
  durationMinutes: number;
  priceCents: number;
  capacity: number;
  status: SessionStatus;
  internalNotes: string;
};

export type AdminExperienceInput = {
  title: string;
  summary: string;
  status: ExperienceStatus;
  imageUrl: string;
  displayOrder: number;
};
