/**
 * Leitura defensiva do que as RPCs de check-in devolvem. Puro, para teste.
 */

export type CheckinMethod = "QR" | "MANUAL";

export type CheckinReservation = {
  reservationId: string;
  publicCode: string;
  status: string;
  fullName: string;
  email: string;
  quantity: number;
  sessionId: string;
  experienceTitle: string;
  startsAt: string;
  hasToken: boolean;
  checkedInCount: number | null;
  checkedInAt: string | null;
  checkinMethod: CheckinMethod | null;
  checkedInByName: string | null;
};

export type AttendanceReservation = Pick<
  CheckinReservation,
  "reservationId" | "publicCode" | "fullName" | "quantity" | "checkedInCount" | "checkedInAt" | "checkinMethod" | "checkedInByName"
>;

export type AttendanceSession = {
  sessionId: string;
  experienceTitle: string;
  baseName: string | null;
  startsAt: string;
  sessionStatus: string;
  capacity: number;
  reservations: AttendanceReservation[];
};

export type AttendanceSessionSummary = {
  sessionId: string;
  experienceTitle: string;
  baseName: string | null;
  startsAt: string;
  sessionStatus: string;
  capacity: number;
  reservationsCount: number;
  reservedSpots: number;
  presentCount: number;
  pendingReservations: number;
  /** Vagas de reservas ainda sem registro de presença. */
  pendingSpots: number;
};

export type PublicCheckinTicket = {
  experienceTitle: string;
  startsAt: string;
  quantity: number;
  checkedIn: boolean;
};

type Row = Record<string, unknown>;

function asRow(value: unknown): Row | null {
  if (Array.isArray(value)) return value[0] && typeof value[0] === "object" ? value[0] as Row : null;
  return value && typeof value === "object" ? value as Row : null;
}

function str(value: unknown) {
  return typeof value === "string" ? value : "";
}

function nullableStr(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function num(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function nullableNum(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function method(value: unknown): CheckinMethod | null {
  return value === "QR" || value === "MANUAL" ? value : null;
}

function attendanceReservation(row: Row): AttendanceReservation {
  return {
    reservationId: str(row.reservationId),
    publicCode: str(row.publicCode),
    fullName: str(row.fullName),
    quantity: num(row.quantity),
    checkedInCount: nullableNum(row.checkedInCount),
    checkedInAt: nullableStr(row.checkedInAt),
    checkinMethod: method(row.checkinMethod),
    checkedInByName: nullableStr(row.checkedInByName),
  };
}

export function parseCheckinReservation(value: unknown): CheckinReservation | null {
  const row = asRow(value);
  if (!row || !str(row.reservationId)) return null;
  return {
    ...attendanceReservation(row),
    status: str(row.status),
    email: str(row.email),
    sessionId: str(row.sessionId),
    experienceTitle: str(row.experienceTitle),
    startsAt: str(row.startsAt),
    hasToken: row.hasToken === true,
  };
}

export function parseAttendanceSession(value: unknown): AttendanceSession | null {
  const row = asRow(value);
  if (!row || !str(row.sessionId)) return null;
  const reservations = Array.isArray(row.reservations)
    ? row.reservations.filter((item): item is Row => Boolean(item) && typeof item === "object").map(attendanceReservation)
    : [];
  return {
    sessionId: str(row.sessionId),
    experienceTitle: str(row.experienceTitle),
    baseName: nullableStr(row.baseName),
    startsAt: str(row.startsAt),
    sessionStatus: str(row.sessionStatus),
    capacity: num(row.capacity),
    reservations,
  };
}

export function parseAttendanceSessions(value: unknown): AttendanceSessionSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Row => Boolean(item) && typeof item === "object")
    .map((row) => ({
      sessionId: str(row.session_id),
      experienceTitle: str(row.experience_title),
      baseName: nullableStr(row.base_name),
      startsAt: str(row.starts_at),
      sessionStatus: str(row.session_status),
      capacity: num(row.capacity),
      reservationsCount: num(row.reservations_count),
      reservedSpots: num(row.reserved_spots),
      presentCount: num(row.present_count),
      pendingReservations: num(row.pending_reservations),
      pendingSpots: num(row.pending_spots),
    }))
    .filter((item) => item.sessionId);
}

export function parsePublicCheckinTicket(value: unknown): PublicCheckinTicket | null {
  const row = asRow(value);
  if (!row || !str(row.startsAt)) return null;
  return {
    experienceTitle: str(row.experienceTitle),
    startsAt: str(row.startsAt),
    quantity: num(row.quantity),
    checkedIn: row.checkedIn === true,
  };
}

/** Motivo de recusa do banco → status HTTP e texto para o instrutor. */
export function checkinErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ADMIN_FORBIDDEN")) return { status: 403, code: "FORBIDDEN", message: "Sem acesso administrativo ativo." };
  if (message.includes("CHECKIN_ALREADY_DONE")) return { status: 409, code: "ALREADY_DONE", message: "Check-in já realizado para esta reserva." };
  if (message.includes("CHECKIN_WRONG_SESSION")) return { status: 409, code: "WRONG_SESSION", message: "Este QR pertence a outra experiência." };
  if (message.includes("CHECKIN_INVALID_COUNT")) return { status: 400, code: "INVALID_COUNT", message: "Quantidade de presentes inválida para esta reserva." };
  if (message.includes("CHECKIN_NOT_DONE")) return { status: 409, code: "NOT_DONE", message: "Esta reserva ainda não tem check-in." };
  if (message.includes("RESERVATION_NOT_CONFIRMED")) return { status: 409, code: "NOT_CONFIRMED", message: "Esta reserva não está confirmada." };
  if (message.includes("RESERVATION_NOT_FOUND")) return { status: 404, code: "NOT_FOUND", message: "Reserva não encontrada." };
  if (message.includes("ADMIN_NOT_CONFIGURED")) return { status: 503, code: "NOT_CONFIGURED", message: "Supabase não configurado neste ambiente." };
  if (/function .*(admin_register_checkin|admin_checkin_lookup|admin_attendance)|Could not find the function/i.test(message)) {
    return { status: 503, code: "MIGRATION_PENDING", message: "Aplique a migration de check-in no Supabase." };
  }
  return { status: 500, code: "UNEXPECTED", message: "Não foi possível registrar agora. Tente novamente." };
}
