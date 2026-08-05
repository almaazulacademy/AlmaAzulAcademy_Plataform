import type {
  AdminDashboardMetrics,
  AdminExperience,
  AdminExperienceInput,
  AdminReservation,
  AdminReservationDetails,
  AdminReservationFilters,
  AdminSession,
  AdminSessionInput,
  ExperienceStatus,
  PaymentStatus,
  PlatformSettings,
  SessionFilter,
  SessionLifecycleStatus,
} from "@/lib/admin/types";
import type { ReservationStatus } from "@/lib/reservations/types";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { emptyExperienceEditorial, validateExperienceEditorial } from "@/lib/editorial/experience";

type Row = Record<string, unknown>;

function asRow(value: unknown): Row | null {
  if (Array.isArray(value)) return value[0] && typeof value[0] === "object" ? value[0] as Row : null;
  return value && typeof value === "object" ? value as Row : null;
}

function asRows(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === "object") : [];
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown) {
  const text = asString(value);
  return text || null;
}

function asNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function asBoolean(value: unknown) {
  return value === true;
}

function adminClient() {
  const client = getSupabaseAdminClient();
  if (!client) throw new Error("ADMIN_NOT_CONFIGURED");
  return client;
}

function mapPaymentStatus(value: unknown): PaymentStatus {
  const status = asString(value);
  if (status === "PENDING" || status === "PAID" || status === "PAID_AFTER_EXPIRATION") return status;
  return "NOT_PAID";
}

function mapReservationStatus(value: unknown): ReservationStatus {
  const status = asString(value);
  if (status === "PRE_RESERVED" || status === "CONFIRMED" || status === "EXPIRED" || status === "CANCELLED") {
    return status;
  }
  return "EXPIRED";
}

function mapReservation(row: Row): AdminReservation {
  return {
    id: asString(row.id),
    publicCode: asString(row.public_code),
    status: mapReservationStatus(row.reservation_status),
    fullName: asString(row.full_name),
    cpfLast4: asString(row.cpf_last4),
    phone: asString(row.phone),
    email: asString(row.email),
    quantity: asNumber(row.quantity),
    totalCents: asNumber(row.total_cents),
    notes: nullableString(row.notes),
    expiresAt: asString(row.expires_at),
    paymentProvider: nullableString(row.payment_provider),
    providerReference: nullableString(row.provider_reference),
    paymentStatus: mapPaymentStatus(row.payment_status),
    confirmedAt: nullableString(row.confirmed_at),
    cancelledAt: nullableString(row.cancelled_at),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    sessionId: asString(row.session_id),
    startsAt: asString(row.starts_at),
    experienceId: asString(row.experience_id),
    experienceTitle: asString(row.experience_title),
  };
}

export async function getAdminDashboard(actorUserId: string): Promise<AdminDashboardMetrics> {
  const result = await adminClient().rpc("admin_dashboard_metrics", { p_actor_id: actorUserId });
  if (result.error) throw new Error(result.error.message);
  const row = asRow(result.data) ?? {};
  const next = asRow(row.nextSession);

  return {
    nextSession: next
      ? {
          id: asString(next.id),
          experienceTitle: asString(next.experienceTitle),
          startsAt: asString(next.startsAt),
          remainingSpots: asNumber(next.remainingSpots),
        }
      : null,
    futureSessions: asNumber(row.futureSessions),
    confirmedReservations: asNumber(row.confirmedReservations),
    preReservations: asNumber(row.preReservations),
    expectedRevenueCents: asNumber(row.expectedRevenueCents),
    confirmedRevenueCents: asNumber(row.confirmedRevenueCents),
    totalParticipants: asNumber(row.totalParticipants),
    totalReservations: asNumber(row.totalReservations),
    averageOccupancyRate: asNumber(row.averageOccupancyRate),
    topExperience: nullableString(row.topExperience),
    monthlyRevenueCents: asNumber(row.monthlyRevenueCents),
    averageTicketCents: asNumber(row.averageTicketCents),
    revenueByMonth: asRows(row.revenueByMonth).map((item) => ({ month: asString(item.month), revenueCents: asNumber(item.revenueCents) })),
    lastUpdatedAt: nullableString(row.lastUpdatedAt),
  };
}

export async function listAdminExperiences(actorUserId: string): Promise<AdminExperience[]> {
  const result = await adminClient().rpc("admin_list_experiences", { p_actor_id: actorUserId });
  if (result.error) throw new Error(result.error.message);
  return asRows(result.data).map((row) => {
    const editorial = validateExperienceEditorial(row.editorial_content, false);
    return ({
    id: asString(row.id),
    slug: asString(row.slug),
    title: asString(row.title),
    summary: asString(row.summary),
    description: asString(row.description),
    durationMinutes: asNumber(row.duration_minutes),
    priceCents: asNumber(row.price_cents),
    defaultCapacity: asNumber(row.default_capacity),
    status: asString(row.status) as ExperienceStatus,
    imageUrl: nullableString(row.image_url),
    displayOrder: asNumber(row.display_order),
    editorialContent: editorial.success ? editorial.data : emptyExperienceEditorial(),
    sessionsCount: asNumber(row.sessions_count),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  }); });
}

export async function listAdminSessions(actorUserId: string, filter: SessionFilter = "ACTIVE"): Promise<AdminSession[]> {
  const result = await adminClient().rpc("admin_list_sessions", { p_actor_id: actorUserId, p_filter: filter });
  if (result.error) throw new Error(result.error.message);
  return asRows(result.data).map((row) => ({
    id: asString(row.id),
    experienceId: asString(row.experience_id),
    experienceTitle: asString(row.experience_title),
    startsAt: asString(row.starts_at),
    durationMinutes: asNumber(row.duration_minutes),
    priceCents: asNumber(row.price_cents),
    capacity: asNumber(row.capacity),
    remainingSpots: asNumber(row.remaining_spots),
    reservationsCount: asNumber(row.reservations_count),
    status: asString(row.status) as SessionLifecycleStatus,
    internalNotes: nullableString(row.internal_notes),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    participants: asRows(row.participants).map((item) => ({ id: asString(item.id), name: asString(item.name), quantity: asNumber(item.quantity), status: mapReservationStatus(item.status) })),
  }));
}

export async function createAdminSession(actorUserId: string, input: AdminSessionInput) {
  const result = await adminClient().rpc("admin_create_session", {
    p_actor_id: actorUserId,
    p_experience_id: input.experienceId,
    p_starts_at: input.startsAt,
    p_duration_minutes: input.durationMinutes,
    p_price_cents: input.priceCents,
    p_capacity: input.capacity,
    p_status: input.status,
    p_internal_notes: input.internalNotes,
  });
  if (result.error) throw new Error(result.error.message);
  return asString(result.data);
}

export async function updateAdminSession(actorUserId: string, sessionId: string, input: AdminSessionInput) {
  const result = await adminClient().rpc("admin_update_session", {
    p_actor_id: actorUserId,
    p_session_id: sessionId,
    p_experience_id: input.experienceId,
    p_starts_at: input.startsAt,
    p_duration_minutes: input.durationMinutes,
    p_price_cents: input.priceCents,
    p_capacity: input.capacity,
    p_status: input.status,
    p_internal_notes: input.internalNotes,
  });
  if (result.error) throw new Error(result.error.message);
  return asBoolean(result.data);
}

export async function deleteAdminSession(actorUserId: string, sessionId: string) {
  const result = await adminClient().rpc("admin_delete_session", {
    p_actor_id: actorUserId,
    p_session_id: sessionId,
  });
  if (result.error) throw new Error(result.error.message);
  return asBoolean(result.data);
}

export async function restoreAdminSession(actorUserId: string, sessionId: string) {
  const result = await adminClient().rpc("admin_restore_session", {
    p_actor_id: actorUserId,
    p_session_id: sessionId,
  });
  if (result.error) throw new Error(result.error.message);
  return asBoolean(result.data);
}

export async function createAdminExperience(actorUserId: string, slug: string, input: AdminExperienceInput) {
  const result = await adminClient().rpc("admin_create_experience", {
    p_actor_id: actorUserId,
    p_slug: slug,
    p_title: input.title,
    p_summary: input.summary,
    p_status: input.status,
    p_image_url: input.imageUrl,
    p_display_order: input.displayOrder,
    p_description: input.description,
    p_duration_minutes: input.durationMinutes,
    p_price_cents: input.priceCents,
    p_default_capacity: input.defaultCapacity,
    p_editorial_content: input.editorialContent,
  });
  if (result.error) throw new Error(result.error.message);
  return asString(result.data);
}

export async function updateAdminExperience(actorUserId: string, experienceId: string, input: AdminExperienceInput) {
  const result = await adminClient().rpc("admin_update_experience", {
    p_actor_id: actorUserId,
    p_experience_id: experienceId,
    p_title: input.title,
    p_summary: input.summary,
    p_status: input.status,
    p_image_url: input.imageUrl,
    p_display_order: input.displayOrder,
    p_description: input.description,
    p_duration_minutes: input.durationMinutes,
    p_price_cents: input.priceCents,
    p_default_capacity: input.defaultCapacity,
    p_editorial_content: input.editorialContent,
  });
  if (result.error) throw new Error(result.error.message);
  return asBoolean(result.data);
}

export async function listAdminReservations(
  actorUserId: string,
  filters: AdminReservationFilters,
): Promise<AdminReservation[]> {
  const result = await adminClient().rpc("admin_list_reservations", {
    p_actor_id: actorUserId,
    p_date: filters.date || null,
    p_experience_id: filters.experienceId || null,
    p_status: filters.status || null,
    p_name: filters.name,
    p_phone: filters.phone,
    p_cpf: filters.cpf,
    p_session_id: filters.sessionId || null,
    p_payment_status: filters.paymentStatus || null,
    p_query: filters.query,
    p_sort: filters.sort,
  });
  if (result.error) throw new Error(result.error.message);
  return asRows(result.data).map(mapReservation);
}

export async function getAdminReservation(actorUserId: string, reservationId: string): Promise<AdminReservationDetails | null> {
  const result = await adminClient().rpc("admin_get_reservation", {
    p_actor_id: actorUserId,
    p_reservation_id: reservationId,
  });
  if (result.error) throw new Error(result.error.message);
  const row = asRow(result.data);
  if (!row) return null;
  return {
    ...mapReservation(row),
    unitPriceCents: asNumber(row.unit_price_cents),
    checkoutUrl: nullableString(row.checkout_url),
    durationMinutes: asNumber(row.duration_minutes),
  };
}

export async function confirmAdminReservation(actorUserId: string, reservationId: string, reason: string) {
  const result = await adminClient().rpc("admin_confirm_reservation", {
    p_actor_id: actorUserId,
    p_reservation_id: reservationId,
    p_reason: reason,
  });
  if (result.error) throw new Error(result.error.message);
  return asBoolean(result.data);
}

export async function cancelAdminReservation(actorUserId: string, reservationId: string, reason: string) {
  const result = await adminClient().rpc("admin_cancel_reservation", {
    p_actor_id: actorUserId,
    p_reservation_id: reservationId,
    p_reason: reason,
  });
  if (result.error) throw new Error(result.error.message);
  return asBoolean(result.data);
}

export async function getPlatformSettings(): Promise<PlatformSettings> {
  const result = await adminClient()
    .from("platform_settings")
    .select("company_name, whatsapp, email, pix_key, updated_at")
    .eq("singleton", true)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const row = (result.data ?? {}) as Row;

  return {
    companyName: asString(row.company_name) || "Alma Azul Academy",
    whatsapp: nullableString(row.whatsapp),
    email: nullableString(row.email),
    pixKey: nullableString(row.pix_key),
    infinitePayConfigured: Boolean(process.env.INFINITEPAY_HANDLE?.trim()),
    domain: process.env.NEXT_PUBLIC_SITE_URL?.trim() || null,
    updatedAt: nullableString(row.updated_at),
  };
}
