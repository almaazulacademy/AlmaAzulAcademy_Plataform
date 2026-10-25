/**
 * Lista de espera no painel (fase 4): ativação, tipos, leitura das respostas do
 * banco, filtros e validação da remoção.
 *
 * Sem Next e sem Supabase de propósito — como `standby.ts` —, para cada regra
 * ser coberta pelo runner nativo do Node. Quem fala com o banco é
 * `waitlist-data.ts`, pelas RPCs administrativas da fase 1, que conferem de novo
 * `is_active_admin` a cada chamada.
 */

import type { ValidationResult } from "../reservations/validation.ts";
import { parseDateFilter, sessionDayKey } from "../sessions/date-filter.ts";

// --- Ativação -----------------------------------------------------------------

/**
 * O painel da lista de espera só existe quando `WAITLIST_ADMIN_ENABLED=true`.
 * Sem a variável não há menu, página nem rota. Variável de servidor — nunca
 * `NEXT_PUBLIC_`. Independe das variáveis do site: a equipe pode acompanhar a
 * lista antes de abrir a inscrição ao público, ou depois de fechá-la.
 */
export function isWaitlistAdminEnabled(env: Record<string, string | undefined> = process.env) {
  return (env.WAITLIST_ADMIN_ENABLED ?? "").trim().toLowerCase() === "true";
}

// --- Tipos --------------------------------------------------------------------

export const WAITLIST_ENTRY_STATUSES = ["ACTIVE", "CONVERTED", "CANCELLED", "REMOVED", "EXPIRED"] as const;
export type WaitlistEntryStatus = (typeof WAITLIST_ENTRY_STATUSES)[number];

export const WAITLIST_STATUS_LABELS: Record<WaitlistEntryStatus, string> = {
  ACTIVE: "Aguardando vaga",
  CONVERTED: "Reservou",
  CANCELLED: "Saiu da lista",
  REMOVED: "Removida pela equipe",
  EXPIRED: "Encerrada",
};

export type WaitlistSession = {
  sessionId: string;
  startsAt: string;
  sessionStatus: string;
  capacity: number;
  remainingSpots: number;
  experienceId: string;
  experienceTitle: string;
  baseId: string | null;
  baseName: string;
  activeEntries: number;
  activeParticipants: number;
  totalEntries: number;
  lastSignupAt: string | null;
};

export type WaitlistEntry = {
  entryId: string;
  status: WaitlistEntryStatus;
  sessionId: string;
  startsAt: string;
  sessionStatus: string;
  experienceTitle: string;
  baseId: string | null;
  baseName: string;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  quantity: number;
  position: number | null;
  notificationsSent: number;
  lastNotifiedAt: string | null;
  createdAt: string;
  closedAt: string | null;
  closedReason: string | null;
  anonymized: boolean;
};

export type WaitlistEntryPage = {
  items: WaitlistEntry[];
  total: number;
  totalParticipants: number;
  limit: number;
  offset: number;
};

export type WaitlistNotificationTry = {
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  errorCode: string | null;
};

export type WaitlistNotification = {
  notificationId: string;
  kind: "JOINED" | "SPOT_AVAILABLE";
  status: string;
  spotsAtQueue: number | null;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
  skippedAt: string | null;
  skipReason: string | null;
  lastErrorCode: string | null;
  tries: WaitlistNotificationTry[];
};

export type WaitlistEvent = { action: string; reason: string | null; createdAt: string; actorName: string };

export type WaitlistEntryDetail = WaitlistEntry & {
  storedStatus: string;
  capacity: number;
  remainingSpots: number;
  convertedReservationId: string | null;
  notifications: WaitlistNotification[];
  events: WaitlistEvent[];
};

// --- Leitura das respostas do banco -------------------------------------------

type Row = Record<string, unknown>;

function asRow(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function asNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function asStatus(value: unknown): WaitlistEntryStatus | null {
  return WAITLIST_ENTRY_STATUSES.find((status) => status === value) ?? null;
}

export function parseWaitlistSessions(value: unknown): WaitlistSession[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = asRow(item);
    if (!row || !asString(row.sessionId) || !asString(row.startsAt)) return [];
    return [{
      sessionId: asString(row.sessionId),
      startsAt: asString(row.startsAt),
      sessionStatus: asString(row.sessionStatus),
      capacity: asNumber(row.capacity),
      remainingSpots: asNumber(row.remainingSpots),
      experienceId: asString(row.experienceId),
      experienceTitle: asString(row.experienceTitle),
      baseId: nullableString(row.baseId),
      baseName: asString(row.baseName),
      activeEntries: asNumber(row.activeEntries),
      activeParticipants: asNumber(row.activeParticipants),
      totalEntries: asNumber(row.totalEntries),
      lastSignupAt: nullableString(row.lastSignupAt),
    }];
  });
}

function parseEntry(row: Row): WaitlistEntry | null {
  const status = asStatus(row.status);
  if (!status || !asString(row.entryId)) return null;
  const position = row.position === null || row.position === undefined ? null : asNumber(row.position);
  return {
    entryId: asString(row.entryId),
    status,
    sessionId: asString(row.sessionId),
    startsAt: asString(row.startsAt),
    sessionStatus: asString(row.sessionStatus),
    experienceTitle: asString(row.experienceTitle),
    baseId: nullableString(row.baseId),
    baseName: asString(row.baseName),
    fullName: nullableString(row.fullName),
    email: nullableString(row.email),
    phone: nullableString(row.phone),
    quantity: asNumber(row.quantity),
    position,
    notificationsSent: asNumber(row.notificationsSent),
    lastNotifiedAt: nullableString(row.lastNotifiedAt),
    createdAt: asString(row.createdAt),
    closedAt: nullableString(row.closedAt),
    closedReason: nullableString(row.closedReason),
    anonymized: row.anonymized === true,
  };
}

export function parseWaitlistEntryPage(value: unknown): WaitlistEntryPage {
  const row = asRow(value);
  const items = Array.isArray(row?.items) ? row.items : [];
  return {
    items: items.flatMap((item) => {
      const entry = asRow(item);
      const parsed = entry ? parseEntry(entry) : null;
      return parsed ? [parsed] : [];
    }),
    total: asNumber(row?.total),
    totalParticipants: asNumber(row?.totalParticipants),
    limit: asNumber(row?.limit),
    offset: asNumber(row?.offset),
  };
}

export function parseWaitlistEntryDetail(value: unknown): WaitlistEntryDetail | null {
  const row = asRow(value);
  if (!row) return null;
  const entry = parseEntry(row);
  if (!entry) return null;
  const notifications = (Array.isArray(row.notifications) ? row.notifications : []).flatMap((item) => {
    const notification = asRow(item);
    if (!notification || !asString(notification.notificationId)) return [];
    const kind = notification.kind === "SPOT_AVAILABLE" ? "SPOT_AVAILABLE" : "JOINED";
    const tries = (Array.isArray(notification.tries) ? notification.tries : []).flatMap((attempt) => {
      const tried = asRow(attempt);
      return tried ? [{
        attempt: asNumber(tried.attempt),
        startedAt: asString(tried.startedAt),
        finishedAt: nullableString(tried.finishedAt),
        outcome: nullableString(tried.outcome),
        errorCode: nullableString(tried.errorCode),
      }] : [];
    });
    return [{
      notificationId: asString(notification.notificationId),
      kind: kind as WaitlistNotification["kind"],
      status: asString(notification.status),
      spotsAtQueue: notification.spotsAtQueue === null || notification.spotsAtQueue === undefined ? null : asNumber(notification.spotsAtQueue),
      attempts: asNumber(notification.attempts),
      createdAt: asString(notification.createdAt),
      sentAt: nullableString(notification.sentAt),
      skippedAt: nullableString(notification.skippedAt),
      skipReason: nullableString(notification.skipReason),
      lastErrorCode: nullableString(notification.lastErrorCode),
      tries,
    }];
  });
  const events = (Array.isArray(row.events) ? row.events : []).flatMap((item) => {
    const event = asRow(item);
    return event && asString(event.action)
      ? [{ action: asString(event.action), reason: nullableString(event.reason), createdAt: asString(event.createdAt), actorName: asString(event.actorName) }]
      : [];
  });
  return {
    ...entry,
    storedStatus: asString(row.storedStatus),
    capacity: asNumber(row.capacity),
    remainingSpots: asNumber(row.remainingSpots),
    convertedReservationId: nullableString(row.convertedReservationId),
    notifications,
    events,
  };
}

// --- Textos -------------------------------------------------------------------

export const WAITLIST_NOTIFICATION_KIND_LABELS: Record<WaitlistNotification["kind"], string> = {
  JOINED: "Confirmação da inscrição",
  SPOT_AVAILABLE: "Aviso de vaga",
};

export const WAITLIST_NOTIFICATION_STATUS_LABELS: Record<string, string> = {
  QUEUED: "Na fila",
  SENDING: "Enviando",
  SENT: "Enviado",
  FAILED: "Falhou — nova tentativa pendente",
  UNCERTAIN: "Entrega não confirmada",
  SKIPPED: "Não enviado",
};

const SKIP_REASONS: Record<string, string> = {
  ENTRY_CLOSED: "a inscrição foi encerrada antes do envio",
  SESSION_STARTED: "a turma começou antes do envio",
  SESSION_UNAVAILABLE: "a turma foi cancelada ou arquivada antes do envio",
};

const CLOSED_REASONS: Record<string, string> = {
  CUSTOMER: "pelo próprio cliente, pelo link do e-mail",
  ADMIN: "pela equipe",
  SESSION_STARTED: "porque a turma começou",
  SESSION_UNAVAILABLE: "porque a turma foi cancelada ou arquivada",
  RESERVATION_CONFIRMED: "porque o cliente reservou esta turma",
};

export function waitlistSkipReasonLabel(reason: string | null) {
  return reason ? SKIP_REASONS[reason] ?? reason : "";
}

export function waitlistClosedReasonLabel(reason: string | null) {
  return reason ? CLOSED_REASONS[reason] ?? reason : "";
}

export const WAITLIST_EVENT_LABELS: Record<string, string> = {
  WAITLIST_ENTRY_REMOVED: "Inscrição removida",
};

// --- Filtros ------------------------------------------------------------------

export const WAITLIST_ENTRIES_PAGE_SIZE = 25;
export const WAITLIST_SESSIONS_PAGE_SIZE = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isWaitlistUuid(value: string) {
  return UUID.test(value);
}

/** "ALL" = todos os status; vazio = só quem ainda espera, o mais útil no dia a dia. */
export type WaitlistStatusFilter = WaitlistEntryStatus | "ALL";

export type WaitlistFilters = {
  experience: string;
  base: string;
  date: string;
  status: WaitlistStatusFilter;
  query: string;
  past: boolean;
  session: string;
  page: number;
  sessionsPage: number;
};

type SearchParams = Record<string, string | string[] | undefined>;

function param(params: SearchParams, key: string) {
  const value = params[key];
  return typeof value === "string" ? value.trim() : "";
}

function positive(value: string) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? number : 1;
}

/** Tudo vem da URL: o que não for válido vira "sem filtro", nunca erro. */
export function parseWaitlistFilters(params: SearchParams, bases: ReadonlyArray<{ slug: string }>): WaitlistFilters {
  const base = param(params, "base");
  const status = param(params, "status").toUpperCase();
  const experience = param(params, "experience");
  const session = param(params, "session");
  return {
    experience: isWaitlistUuid(experience) ? experience : "",
    base: bases.some((item) => item.slug === base) ? base : "",
    date: parseDateFilter(param(params, "date")) ?? "",
    status: status === "ALL" ? "ALL" : asStatus(status) ?? "ACTIVE",
    query: param(params, "query").slice(0, 120),
    past: param(params, "past") === "1",
    session: isWaitlistUuid(session) ? session : "",
    page: positive(param(params, "page")),
    sessionsPage: positive(param(params, "turmas")),
  };
}

/** Endereço da página com os filtros atuais, trocando o que for pedido. */
export function waitlistListHref(filters: WaitlistFilters, changes: Partial<WaitlistFilters> = {}) {
  const next = { ...filters, ...changes };
  const search = new URLSearchParams();
  if (next.experience) search.set("experience", next.experience);
  if (next.base) search.set("base", next.base);
  if (next.date) search.set("date", next.date);
  if (next.status !== "ACTIVE") search.set("status", next.status);
  if (next.query) search.set("query", next.query);
  if (next.past) search.set("past", "1");
  if (next.session) search.set("session", next.session);
  if (next.page > 1) search.set("page", String(next.page));
  if (next.sessionsPage > 1) search.set("turmas", String(next.sessionsPage));
  const query = search.toString();
  return query ? `/admin/lista-de-espera?${query}` : "/admin/lista-de-espera";
}

/**
 * Turmas que passam nos filtros de experiência, base e data. A lista vem
 * inteira do banco — só turmas que têm inscrição, que são poucas — e o recorte é
 * feito aqui, com o dia no fuso de Brasília.
 */
export function filterWaitlistSessions(sessions: readonly WaitlistSession[], filters: Pick<WaitlistFilters, "experience" | "date">, baseId: string | null) {
  return sessions.filter((session) =>
    (!filters.experience || session.experienceId === filters.experience)
    && (!baseId || session.baseId === baseId)
    && (!filters.date || sessionDayKey(session.startsAt) === filters.date),
  );
}

/** Experiências que aparecem nas turmas com inscrição, para o filtro. */
export function waitlistExperienceOptions(sessions: readonly WaitlistSession[]) {
  const byId = new Map<string, string>();
  for (const session of sessions) if (session.experienceId) byId.set(session.experienceId, session.experienceTitle);
  return [...byId.entries()].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));
}

export function waitlistPageCount(total: number, pageSize: number) {
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
}

// --- Remoção ------------------------------------------------------------------

/**
 * "Remover da lista de espera". Motivo obrigatório (3 a 500 caracteres, o mesmo
 * limite do banco) e confirmação explícita: a pessoa deixa de ser avisada.
 */
export function validateWaitlistRemoval(value: unknown): ValidationResult<{ reason: string }> {
  if (!asRow(value)) return { success: false, errors: { form: "Dados inválidos." } };
  const row = value as Row;
  const reason = typeof row.reason === "string" ? row.reason.trim().replace(/\s+/g, " ") : "";
  const errors: Record<string, string> = {};
  if (reason.length < 3 || reason.length > 500) errors.reason = "Informe um motivo entre 3 e 500 caracteres.";
  if (row.confirmed !== true) errors.confirmed = "Confirme a remoção.";
  return Object.keys(errors).length ? { success: false, errors } : { success: true, data: { reason } };
}

/** Recusa do banco traduzida para a equipe. Nunca repassa a mensagem original. */
export function waitlistAdminError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("PGRST202") || /Could not find the function|function public\.[a-z_]+\(.*\) does not exist/i.test(message)) {
    return { status: 503, message: "A lista de espera ainda não está disponível neste banco. Aplique as migrations da lista de espera no Supabase." };
  }
  if (message.includes("ADMIN_FORBIDDEN")) return { status: 403, message: "Seu perfil não tem permissão para esta função." };
  if (message.includes("WAITLIST_INVALID_REASON")) return { status: 400, message: "Informe um motivo entre 3 e 500 caracteres." };
  if (message.includes("WAITLIST_ENTRY_NOT_FOUND")) return { status: 404, message: "Inscrição não encontrada." };
  if (message.includes("WAITLIST_INVALID_FILTER")) return { status: 400, message: "Filtro inválido." };
  return { status: 500, message: "Não foi possível concluir a ação na lista de espera." };
}
