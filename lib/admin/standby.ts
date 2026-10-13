/**
 * Stand-by de reservas no painel: tipos, leitura das respostas do banco e
 * validação das ações.
 *
 * Sem Next e sem Supabase de propósito — é o que permite cobrir cada regra com o
 * runner nativo do Node. Quem fala com o banco é `standby-data.ts`; quem decide
 * se uma reserva entra, sai ou muda de turma continua sendo o Supabase.
 */

import type { ValidationResult } from "../reservations/validation.ts";
import { isUuid } from "./validation.ts";

// --- Ativação -----------------------------------------------------------------

/**
 * O painel de Stand-by só existe quando `STANDBY_ADMIN_ENABLED=true`.
 *
 * Publicar o código não ativa nada: sem a variável, o menu, os botões e as
 * rotas ficam desligados e o painel se comporta como antes. É variável de
 * servidor — nunca `NEXT_PUBLIC_`.
 */
export function isStandbyAdminEnabled(env: Record<string, string | undefined> = process.env) {
  return (env.STANDBY_ADMIN_ENABLED ?? "").trim().toLowerCase() === "true";
}

// --- Tipos --------------------------------------------------------------------

export type StandbyListItem = {
  standbyId: string;
  reservationId: string;
  publicCode: string;
  fullName: string;
  phone: string;
  email: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  originalSessionId: string;
  originalStartsAt: string;
  originalExperienceTitle: string;
  originalBaseId: string | null;
  originalBaseName: string;
  enteredAt: string;
  enteredByName: string;
  reason: string | null;
  hasActiveLink: boolean;
  linkCreatedAt: string | null;
};

export type StandbyListPage = {
  total: number;
  totalParticipants: number;
  totalCents: number;
  limit: number;
  offset: number;
  items: StandbyListItem[];
};

export type StandbyLinkFilter = "" | "WITH" | "WITHOUT";

export type StandbyListFilters = {
  query: string;
  base: string;
  link: StandbyLinkFilter;
  page: number;
};

export type StandbyOption = {
  /** `id` e `startsAt` no formato de `groupSessionsByDay`. */
  id: string;
  sessionId: string;
  experienceId: string;
  experienceTitle: string;
  baseId: string;
  baseName: string;
  startsAt: string;
  durationMinutes: number;
  capacity: number;
  remainingSpots: number;
  priceCents: number;
  isOriginal: boolean;
};

export type StandbyOptions = {
  standbyId: string;
  reservationId: string;
  publicCode: string;
  fullName: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  enteredAt: string;
  reason: string | null;
  original: {
    sessionId: string;
    startsAt: string;
    experienceId: string;
    experienceTitle: string;
    baseName: string;
  };
  restore: { allowed: boolean; rejection: string | null; remainingSpots: number };
  hasActiveLink: boolean;
  linkCreatedAt: string | null;
  hiddenForCapacity: number;
  options: StandbyOption[];
  /** Acrescentado pela rota: true quando reagendar envia o e-mail de confirmação. */
  rescheduleEmailEnabled?: boolean;
};

export type StandbyEntry = {
  standbyId: string;
  reservationId: string;
  publicCode: string;
  originalSessionId: string;
};

/** Resultado de desfazer ou reagendar. Sem dado pessoal. */
export type StandbyResolution = {
  standbyId: string;
  /** Linha do histórico de trocas. No reagendamento, é o que identifica o e-mail de confirmação. */
  changeId: string;
  reservationId: string;
  publicCode: string;
  resolution: "RESCHEDULED" | "RESTORED";
  replayed: boolean;
  previousSessionId: string;
  previousStartsAt: string;
  previousExperienceTitle: string;
  targetSessionId: string;
  targetStartsAt: string;
  targetExperienceTitle: string;
  experienceChanged: boolean;
  quantity: number;
  totalCents: number;
};

/** O token existe uma única vez: nesta resposta. */
export type StandbyLink = { standbyId: string; token: string; createdAt: string };

export type StandbyCycle = {
  standbyId: string;
  enteredAt: string;
  enteredByName: string;
  reason: string | null;
  quantity: number;
  totalCents: number;
  originalStartsAt: string;
  originalExperienceTitle: string;
  originalBaseName: string;
  open: boolean;
  resolution: "RESCHEDULED" | "RESTORED" | "CANCELLED" | null;
  resolvedAt: string | null;
  resolvedByType: "ADMIN" | "CUSTOMER" | null;
  resolvedByName: string;
  resolvedAccess: "ADMIN" | "CPF_CODE" | "LINK" | null;
  resolvedReason: string | null;
  targetStartsAt: string | null;
  targetExperienceTitle: string;
  targetBaseName: string;
  hasActiveLink: boolean;
  linkCreatedAt: string | null;
  linkCreatedByName: string;
  linkRevokedAt: string | null;
};

export type StandbyEvent = {
  id: string;
  at: string;
  action: string;
  actorName: string;
  actorType: "ADMIN" | "CUSTOMER";
  access: string | null;
  reason: string | null;
};

export type StandbyHistory = { cycles: StandbyCycle[]; events: StandbyEvent[] };

// --- Leitura das respostas do banco ------------------------------------------

type Row = Record<string, unknown>;

function asRow(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function asRows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((item): item is Row => Boolean(item) && typeof item === "object") : [];
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown) {
  return asString(value) || null;
}

function asNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return allowed.includes(value as T) ? value as T : null;
}

export function parseStandbyListPage(value: unknown): StandbyListPage {
  const row = asRow(value) ?? {};
  return {
    total: asNumber(row.total),
    totalParticipants: asNumber(row.totalParticipants),
    totalCents: asNumber(row.totalCents),
    limit: asNumber(row.limit),
    offset: asNumber(row.offset),
    items: asRows(row.items).map((item) => ({
      standbyId: asString(item.standbyId),
      reservationId: asString(item.reservationId),
      publicCode: asString(item.publicCode),
      fullName: asString(item.fullName),
      phone: asString(item.phone),
      email: asString(item.email),
      quantity: asNumber(item.quantity),
      unitPriceCents: asNumber(item.unitPriceCents),
      totalCents: asNumber(item.totalCents),
      originalSessionId: asString(item.originalSessionId),
      originalStartsAt: asString(item.originalStartsAt),
      originalExperienceTitle: asString(item.originalExperienceTitle),
      originalBaseId: nullableString(item.originalBaseId),
      originalBaseName: asString(item.originalBaseName),
      enteredAt: asString(item.enteredAt),
      enteredByName: asString(item.enteredByName),
      reason: nullableString(item.reason),
      hasActiveLink: item.hasActiveLink === true,
      linkCreatedAt: nullableString(item.linkCreatedAt),
    })),
  };
}

export function parseStandbyOptions(value: unknown): StandbyOptions | null {
  const row = asRow(value);
  if (!row || !asString(row.standbyId)) return null;
  const original = asRow(row.original) ?? {};
  const restore = asRow(row.restore) ?? {};
  return {
    standbyId: asString(row.standbyId),
    reservationId: asString(row.reservationId),
    publicCode: asString(row.publicCode),
    fullName: asString(row.fullName),
    quantity: asNumber(row.quantity),
    unitPriceCents: asNumber(row.unitPriceCents),
    totalCents: asNumber(row.totalCents),
    enteredAt: asString(row.enteredAt),
    reason: nullableString(row.reason),
    original: {
      sessionId: asString(original.sessionId),
      startsAt: asString(original.startsAt),
      experienceId: asString(original.experienceId),
      experienceTitle: asString(original.experienceTitle),
      baseName: asString(original.baseName),
    },
    restore: {
      allowed: restore.allowed === true,
      rejection: nullableString(restore.rejection),
      remainingSpots: asNumber(restore.remainingSpots),
    },
    hasActiveLink: row.hasActiveLink === true,
    linkCreatedAt: nullableString(row.linkCreatedAt),
    hiddenForCapacity: asNumber(row.hiddenForCapacity),
    options: asRows(row.options).map((option) => ({
      id: asString(option.sessionId),
      sessionId: asString(option.sessionId),
      experienceId: asString(option.experienceId),
      experienceTitle: asString(option.experienceTitle),
      baseId: asString(option.baseId),
      baseName: asString(option.baseName),
      startsAt: asString(option.startsAt),
      durationMinutes: asNumber(option.durationMinutes),
      capacity: asNumber(option.capacity),
      remainingSpots: asNumber(option.remainingSpots),
      priceCents: asNumber(option.priceCents),
      isOriginal: option.isOriginal === true,
    })),
  };
}

export function parseStandbyEntry(value: unknown): StandbyEntry | null {
  const row = asRow(value);
  if (!row || !asString(row.standbyId)) return null;
  return {
    standbyId: asString(row.standbyId),
    reservationId: asString(row.reservationId),
    publicCode: asString(row.publicCode),
    originalSessionId: asString(row.originalSessionId),
  };
}

export function parseStandbyResolution(value: unknown): StandbyResolution | null {
  const row = asRow(value);
  const resolution = oneOf(row?.resolution, ["RESCHEDULED", "RESTORED"] as const);
  if (!row || !resolution || !asString(row.standbyId)) return null;
  return {
    standbyId: asString(row.standbyId),
    changeId: asString(row.changeId),
    reservationId: asString(row.reservationId),
    publicCode: asString(row.publicCode),
    resolution,
    replayed: row.replayed === true,
    previousSessionId: asString(row.previousSessionId),
    previousStartsAt: asString(row.previousStartsAt),
    previousExperienceTitle: asString(row.previousExperienceTitle),
    targetSessionId: asString(row.targetSessionId),
    targetStartsAt: asString(row.targetStartsAt),
    targetExperienceTitle: asString(row.targetExperienceTitle),
    experienceChanged: row.experienceChanged === true,
    quantity: asNumber(row.quantity),
    totalCents: asNumber(row.totalCents),
  };
}

/** Token no formato exato gerado pelo banco: 64 hexadecimais minúsculos. */
export function isStandbyLinkToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function parseStandbyLink(value: unknown): StandbyLink | null {
  const row = asRow(value);
  if (!row || !isStandbyLinkToken(row.token)) return null;
  return { standbyId: asString(row.standbyId), token: row.token, createdAt: asString(row.createdAt) };
}

export function parseStandbyHistory(value: unknown): StandbyHistory {
  const row = asRow(value) ?? {};
  return {
    cycles: asRows(row.cycles).map((cycle) => ({
      standbyId: asString(cycle.standbyId),
      enteredAt: asString(cycle.enteredAt),
      enteredByName: asString(cycle.enteredByName),
      reason: nullableString(cycle.reason),
      quantity: asNumber(cycle.quantity),
      totalCents: asNumber(cycle.totalCents),
      originalStartsAt: asString(cycle.originalStartsAt),
      originalExperienceTitle: asString(cycle.originalExperienceTitle),
      originalBaseName: asString(cycle.originalBaseName),
      open: cycle.open === true,
      resolution: oneOf(cycle.resolution, ["RESCHEDULED", "RESTORED", "CANCELLED"] as const),
      resolvedAt: nullableString(cycle.resolvedAt),
      resolvedByType: oneOf(cycle.resolvedByType, ["ADMIN", "CUSTOMER"] as const),
      resolvedByName: asString(cycle.resolvedByName),
      resolvedAccess: oneOf(cycle.resolvedAccess, ["ADMIN", "CPF_CODE", "LINK"] as const),
      resolvedReason: nullableString(cycle.resolvedReason),
      targetStartsAt: nullableString(cycle.targetStartsAt),
      targetExperienceTitle: asString(cycle.targetExperienceTitle),
      targetBaseName: asString(cycle.targetBaseName),
      hasActiveLink: cycle.hasActiveLink === true,
      linkCreatedAt: nullableString(cycle.linkCreatedAt),
      linkCreatedByName: asString(cycle.linkCreatedByName),
      linkRevokedAt: nullableString(cycle.linkRevokedAt),
    })),
    events: asRows(row.events).map((event) => ({
      id: asString(event.id),
      at: asString(event.at),
      action: asString(event.action),
      actorName: asString(event.actorName),
      actorType: event.actorType === "CUSTOMER" ? "CUSTOMER" : "ADMIN",
      access: nullableString(event.access),
      reason: nullableString(event.reason),
    })),
  };
}

// --- Validação das ações ------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cleanReason(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

/**
 * "Colocar em Stand-by". O motivo é obrigatório — é o que a equipe e o histórico
 * vão ler depois — e a confirmação precisa vir explícita no corpo: a ação libera
 * as vagas da turma original.
 */
export function validateStandbyEntry(value: unknown): ValidationResult<{ reason: string }> {
  if (!isRecord(value)) return { success: false, errors: { form: "Dados inválidos." } };
  const reason = cleanReason(value.reason);
  const errors: Record<string, string> = {};
  if (reason.length < 3 || reason.length > 500) errors.reason = "Informe um motivo entre 3 e 500 caracteres.";
  if (value.confirmed !== true) errors.confirmed = "Confirme que as vagas da turma original serão liberadas.";
  return Object.keys(errors).length ? { success: false, errors } : { success: true, data: { reason } };
}

/** "Desfazer Stand-by". Motivo opcional, registrado no histórico. */
export function validateStandbyUndo(value: unknown): ValidationResult<{ reason: string }> {
  const reason = cleanReason(isRecord(value) ? value.reason : "");
  if (reason.length > 500) return { success: false, errors: { reason: "Use no máximo 500 caracteres." } };
  return { success: true, data: { reason } };
}

/** "Reagendar". O cliente da requisição só escolhe a turma; o resto é da reserva. */
export function validateStandbyReschedule(value: unknown): ValidationResult<{ targetSessionId: string; reason: string }> {
  if (!isRecord(value)) return { success: false, errors: { form: "Dados inválidos." } };
  const targetSessionId = String(value.targetSessionId ?? "").trim();
  const reason = cleanReason(value.reason);
  const errors: Record<string, string> = {};
  if (!isUuid(targetSessionId)) errors.targetSessionId = "Selecione a nova turma.";
  if (reason.length > 500) errors.reason = "Use no máximo 500 caracteres.";
  return Object.keys(errors).length ? { success: false, errors } : { success: true, data: { targetSessionId, reason } };
}

// --- Lista --------------------------------------------------------------------

export const STANDBY_PAGE_SIZE = 25;

type SearchParams = Record<string, string | string[] | undefined>;

function param(params: SearchParams, key: string) {
  const value = params[key];
  return typeof value === "string" ? value.trim() : "";
}

export function parseStandbyListFilters(params: SearchParams, bases: ReadonlyArray<{ slug: string }>): StandbyListFilters {
  const base = param(params, "base");
  const link = param(params, "link").toUpperCase();
  const page = Number.parseInt(param(params, "page"), 10);
  return {
    query: param(params, "query").slice(0, 120),
    base: bases.some((item) => item.slug === base) ? base : "",
    link: link === "WITH" || link === "WITHOUT" ? link : "",
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

export function standbyPageCount(total: number, pageSize = STANDBY_PAGE_SIZE) {
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
}

/** Endereço da lista com os filtros atuais e a página pedida. */
export function standbyListHref(filters: StandbyListFilters, page: number) {
  const search = new URLSearchParams();
  if (filters.query) search.set("query", filters.query);
  if (filters.base) search.set("base", filters.base);
  if (filters.link) search.set("link", filters.link);
  if (page > 1) search.set("page", String(page));
  const query = search.toString();
  return query ? `/admin/stand-by?${query}` : "/admin/stand-by";
}

// --- Link individual ----------------------------------------------------------

/**
 * O token vai no fragmento (`#r=`): o navegador não o envia ao servidor, então
 * ele não aparece em log de acesso nem em pré-visualização de link.
 */
export function standbyLinkUrl(origin: string, token: string) {
  return `${origin.replace(/\/+$/, "")}/acompanhar-reserva#r=${token}`;
}

/** Texto preparado para o admin revisar e enviar pelo WhatsApp. */
export function standbyLinkMessage(fullName: string, publicCode: string, url: string) {
  const firstName = fullName.trim().split(/\s+/)[0] || "Olá";
  return `Olá, ${firstName}! Sua reserva ${publicCode} na Alma Azul Academy está paga e aguardando uma nova data. Use este link pessoal para acompanhar: ${url}`;
}

// --- Textos -------------------------------------------------------------------

const RESTORE_REJECTIONS: Record<string, string> = {
  SESSION_NOT_OPEN: "A turma original não está aberta para receber reservas.",
  SESSION_MUST_BE_FUTURE: "A turma original já começou ou já aconteceu.",
  SESSION_NOT_FOUND: "A turma original não existe mais.",
  EXPERIENCE_NOT_FOUND: "A experiência da turma original não existe mais.",
  EXPERIENCE_NOT_AVAILABLE: "A experiência da turma original não está disponível.",
  INSUFFICIENT_SPOTS: "A turma original não tem vagas para o grupo inteiro.",
};

/** Por que "Desfazer Stand-by" não está disponível agora. */
export function restoreRejectionMessage(rejection: string | null) {
  if (!rejection) return "";
  return RESTORE_REJECTIONS[rejection] ?? "A turma original não pode receber esta reserva agora.";
}

const RESCHEDULE_EMAIL_NOTICES: Record<string, { text: string; delivered: boolean }> = {
  SENT: { text: "O e-mail de confirmação da nova data foi enviado ao cliente.", delivered: true },
  SKIPPED: { text: "O e-mail de confirmação deste reagendamento já foi enviado ou está em andamento.", delivered: true },
  PENDING: {
    text: "O cliente AINDA NÃO recebeu o e-mail de confirmação: o envio falhou e está sendo tentado de novo. Acompanhe no detalhe da reserva e, se a experiência for em breve, avise o cliente por outro canal.",
    delivered: false,
  },
};

const NO_RESCHEDULE_EMAIL = { text: "Nenhum e-mail foi enviado: avise o cliente.", delivered: false };

/**
 * O que dizer ao admin sobre o e-mail logo depois de reagendar. Sem resultado
 * conhecido — e-mail de reagendamento desligado, por exemplo — o aviso é o de
 * sempre: ninguém foi avisado.
 */
export function rescheduleEmailNotice(outcome: string | null | undefined) {
  return (RESCHEDULE_EMAIL_NOTICES[outcome ?? ""] ?? NO_RESCHEDULE_EMAIL).text;
}

/** true quando o aviso precisa de destaque: a reserva foi reagendada e o e-mail não saiu. */
export function rescheduleEmailNeedsAttention(outcome: string | null | undefined) {
  return outcome === "PENDING";
}

const EVENT_LABELS: Record<string, string> = {
  RESERVATION_STANDBY_SET: "Colocada em Stand-by",
  RESERVATION_STANDBY_RESTORED: "Stand-by desfeito",
  RESERVATION_STANDBY_RESCHEDULED: "Reagendada",
  RESERVATION_STANDBY_LINK_GENERATED: "Link gerado",
  RESERVATION_STANDBY_LINK_REVOKED: "Link revogado",
};

export function standbyEventLabel(action: string) {
  return EVENT_LABELS[action] ?? action;
}

/** Quem fez: o nome do admin, ou o cliente e por onde ele entrou. */
export function standbyActorLabel(event: Pick<StandbyEvent, "actorName" | "actorType" | "access">) {
  if (event.actorType === "CUSTOMER") {
    return event.access === "LINK" ? "Cliente, pelo link" : "Cliente, com CPF e código";
  }
  return event.actorName || "Administrador removido";
}

export function standbyResolutionLabel(cycle: Pick<StandbyCycle, "open" | "resolution">) {
  if (cycle.open) return "Aguardando reagendamento";
  if (cycle.resolution === "RESCHEDULED") return "Reagendada";
  if (cycle.resolution === "RESTORED") return "Stand-by desfeito";
  if (cycle.resolution === "CANCELLED") return "Reserva cancelada";
  return "Encerrado";
}
