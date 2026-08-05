import type { ReservationStatus } from "@/lib/reservations/types";
import type { ExperienceEditorial } from "@/lib/editorial/experience";

export const SESSION_STATUSES = ["OPEN", "CLOSED", "CANCELLED"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

// Estado de exibição de uma sessão, incluindo ARCHIVED. Não usar para o
// formulário de criação/edição: arquivar e restaurar têm RPCs próprias
// com suas regras de negócio, então o status de arquivamento nunca deve
// ser enviado pelo formulário genérico.
export const SESSION_LIFECYCLE_STATUSES = [...SESSION_STATUSES, "ARCHIVED"] as const;
export type SessionLifecycleStatus = (typeof SESSION_LIFECYCLE_STATUSES)[number];

export const SESSION_FILTERS = ["ACTIVE", "ARCHIVED", "ALL"] as const;
export type SessionFilter = (typeof SESSION_FILTERS)[number];

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
  totalReservations: number;
  averageOccupancyRate: number;
  topExperience: string | null;
  monthlyRevenueCents: number;
  averageTicketCents: number;
  revenueByMonth: Array<{ month: string; revenueCents: number }>;
  lastUpdatedAt: string | null;
};

export type AdminExperience = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  description: string;
  durationMinutes: number;
  priceCents: number;
  defaultCapacity: number;
  status: ExperienceStatus;
  imageUrl: string | null;
  displayOrder: number;
  editorialContent: ExperienceEditorial;
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
  status: SessionLifecycleStatus;
  internalNotes: string | null;
  createdAt: string;
  updatedAt: string;
  participants: Array<{ id: string; name: string; quantity: number; status: ReservationStatus }>;
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
  paymentStatus: PaymentStatus | "";
  query: string;
  sort: "recent" | "oldest" | "session";
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
  description: string;
  durationMinutes: number;
  priceCents: number;
  defaultCapacity: number;
  status: ExperienceStatus;
  imageUrl: string;
  displayOrder: number;
  editorialContent: ExperienceEditorial;
};
