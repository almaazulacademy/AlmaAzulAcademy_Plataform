import type {
  AdminSession,
  AdminSessionFilters,
  SessionFilter,
  SessionPeriodFilter,
  SessionSort,
  SessionStatusFilter,
} from "./types.ts";
import { formatSessionDate, formatSessionDateShort, formatSessionTime, toSessionDateTimeLocal } from "../sessions/date-time.ts";

// Vocabulário da URL. Os valores em português já eram usados por
// `?filtro=ativas|arquivadas|todas`, então links e favoritos antigos
// continuam funcionando.
export const SESSION_STATUS_PARAMS: Record<string, SessionStatusFilter> = {
  ativas: "ACTIVE",
  abertas: "OPEN",
  fechadas: "CLOSED",
  canceladas: "CANCELLED",
  arquivadas: "ARCHIVED",
  todas: "ALL",
};

export const SESSION_PERIOD_PARAMS: Record<string, SessionPeriodFilter> = {
  todas: "ALL",
  proximas: "UPCOMING",
  passadas: "PAST",
  hoje: "TODAY",
};

export const SESSION_SORT_PARAMS: Record<string, SessionSort> = {
  proximas: "UPCOMING",
  recentes: "RECENT",
  antigas: "OLDEST",
};

export const SESSION_STATUS_OPTIONS = [
  { param: "ativas", label: "Ativas" },
  { param: "abertas", label: "Abertas" },
  { param: "fechadas", label: "Fechadas" },
  { param: "canceladas", label: "Canceladas" },
  { param: "arquivadas", label: "Arquivadas" },
  { param: "todas", label: "Todas" },
] as const;

export const SESSION_PERIOD_OPTIONS = [
  { param: "todas", label: "Todas" },
  { param: "proximas", label: "Próximas" },
  { param: "passadas", label: "Passadas" },
  { param: "hoje", label: "Hoje" },
] as const;

export const SESSION_SORT_OPTIONS = [
  { param: "proximas", label: "Mais próximas primeiro" },
  { param: "recentes", label: "Mais recentes primeiro" },
  { param: "antigas", label: "Mais antigas primeiro" },
] as const;

export const DEFAULT_SESSION_FILTERS: AdminSessionFilters = {
  query: "",
  status: "ACTIVE",
  experienceId: "",
  period: "ALL",
  from: "",
  to: "",
  sort: "UPCOMING",
};

type SearchParams = Record<string, string | string[] | undefined>;

function valueOf(params: SearchParams, key: string) {
  const value = params[key];
  return typeof value === "string" ? value.trim() : "";
}

function isoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function paramFor<T extends string>(map: Record<string, T>, value: T, fallback: string) {
  return Object.keys(map).find((key) => map[key] === value) ?? fallback;
}

export function sessionStatusParam(status: SessionStatusFilter) {
  return paramFor(SESSION_STATUS_PARAMS, status, "ativas");
}

export function sessionPeriodParam(period: SessionPeriodFilter) {
  return paramFor(SESSION_PERIOD_PARAMS, period, "todas");
}

export function sessionSortParam(sort: SessionSort) {
  return paramFor(SESSION_SORT_PARAMS, sort, "proximas");
}

export function sessionFiltersFrom(params: SearchParams): AdminSessionFilters {
  return {
    query: valueOf(params, "busca"),
    status: SESSION_STATUS_PARAMS[valueOf(params, "filtro")] ?? DEFAULT_SESSION_FILTERS.status,
    experienceId: valueOf(params, "experiencia"),
    period: SESSION_PERIOD_PARAMS[valueOf(params, "periodo")] ?? DEFAULT_SESSION_FILTERS.period,
    from: isoDate(valueOf(params, "de")),
    to: isoDate(valueOf(params, "ate")),
    sort: SESSION_SORT_PARAMS[valueOf(params, "ordem")] ?? DEFAULT_SESSION_FILTERS.sort,
  };
}

export function hasSessionFilters(filters: AdminSessionFilters) {
  return (Object.keys(DEFAULT_SESSION_FILTERS) as Array<keyof AdminSessionFilters>).some(
    (key) => filters[key] !== DEFAULT_SESSION_FILTERS[key],
  );
}

// Só o recorte de arquivamento existe na RPC; os demais status são
// subconjuntos de ACTIVE e são aplicados aqui, sem consulta extra.
export function sessionListFilterFor(status: SessionStatusFilter): SessionFilter {
  if (status === "ARCHIVED") return "ARCHIVED";
  if (status === "ALL") return "ALL";
  return "ACTIVE";
}

export function sessionSearchParams(filters: AdminSessionFilters) {
  const params = new URLSearchParams();
  if (filters.query) params.set("busca", filters.query);
  if (filters.status !== DEFAULT_SESSION_FILTERS.status) params.set("filtro", sessionStatusParam(filters.status));
  if (filters.experienceId) params.set("experiencia", filters.experienceId);
  if (filters.period !== DEFAULT_SESSION_FILTERS.period) params.set("periodo", sessionPeriodParam(filters.period));
  if (filters.from) params.set("de", filters.from);
  if (filters.to) params.set("ate", filters.to);
  if (filters.sort !== DEFAULT_SESSION_FILTERS.sort) params.set("ordem", sessionSortParam(filters.sort));
  return params.toString();
}

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function timeOf(value: string) {
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

// Data e horário sempre no fuso das sessões (Brasília), no mesmo formato
// exibido nos cards — quem busca digita o que está vendo na tela.
export function sessionLocalDate(startsAt: string) {
  return timeOf(startsAt) === null ? "" : toSessionDateTimeLocal(startsAt).slice(0, 10);
}

function searchableFields(session: AdminSession) {
  const fields = [session.experienceTitle];
  if (timeOf(session.startsAt) !== null) {
    fields.push(formatSessionDate(session.startsAt), formatSessionDateShort(session.startsAt), formatSessionTime(session.startsAt), sessionLocalDate(session.startsAt));
  }
  return fields.map(normalize);
}

function matchesQuery(session: AdminSession, query: string) {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const fields = searchableFields(session);
  const digitFields = fields.map((field) => field.replace(/\D/g, "")).filter(Boolean);
  return terms.every((term) => {
    if (fields.some((field) => field.includes(term))) return true;
    const digits = term.replace(/\D/g, "");
    // "09/08", "0908" e "2026-08-09" caem no mesmo comparador numérico.
    return Boolean(digits) && !/[a-z]/.test(term) && digitFields.some((field) => field.includes(digits));
  });
}

function matchesStatus(session: AdminSession, status: SessionStatusFilter) {
  if (status === "ALL") return true;
  if (status === "ACTIVE") return session.status !== "ARCHIVED";
  return session.status === status;
}

function matchesPeriod(session: AdminSession, period: SessionPeriodFilter, now: Date) {
  if (period === "ALL") return true;
  const startsAt = timeOf(session.startsAt);
  if (startsAt === null) return false;
  if (period === "TODAY") return sessionLocalDate(session.startsAt) === toSessionDateTimeLocal(now).slice(0, 10);
  return period === "UPCOMING" ? startsAt >= now.getTime() : startsAt < now.getTime();
}

function matchesRange(session: AdminSession, from: string, to: string) {
  if (!from && !to) return true;
  const date = sessionLocalDate(session.startsAt);
  if (!date) return false;
  return (!from || date >= from) && (!to || date <= to);
}

function sortSessions(sessions: AdminSession[], sort: SessionSort, now: Date) {
  const items = [...sessions];
  const at = (session: AdminSession) => timeOf(session.startsAt) ?? 0;
  if (sort === "OLDEST") return items.sort((a, b) => at(a) - at(b));
  if (sort === "RECENT") return items.sort((a, b) => at(b) - at(a));
  // Mais próximas primeiro: futuras em ordem crescente e, depois delas,
  // as passadas da mais recente para a mais antiga.
  const reference = now.getTime();
  return items.sort((a, b) => {
    const aFuture = at(a) >= reference;
    const bFuture = at(b) >= reference;
    if (aFuture !== bFuture) return aFuture ? -1 : 1;
    return aFuture ? at(a) - at(b) : at(b) - at(a);
  });
}

export function applySessionFilters(sessions: AdminSession[], filters: AdminSessionFilters, now = new Date()) {
  const matched = sessions.filter(
    (session) =>
      matchesStatus(session, filters.status) &&
      (!filters.experienceId || session.experienceId === filters.experienceId) &&
      matchesPeriod(session, filters.period, now) &&
      matchesRange(session, filters.from, filters.to) &&
      matchesQuery(session, filters.query),
  );
  return sortSessions(matched, filters.sort, now);
}
