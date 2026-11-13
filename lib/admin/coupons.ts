/**
 * Cupons de desconto no painel (fase 3): ativação, permissões, leitura das
 * respostas do banco, filtros, resumo financeiro e validação dos pedidos.
 *
 * Sem Next e sem Supabase de propósito — como `waitlist.ts` —, para cada regra
 * ser coberta pelo runner nativo do Node. Quem decide é o banco
 * (`202611020001_discount_coupons.sql`): as RPCs conferem o papel de novo a cada
 * chamada, travam o cupom, recusam campos bloqueados e limite abaixo do uso, e
 * gravam a auditoria. Aqui ficam só a tela e as mensagens.
 */

import { isCouponsAdminEnabled } from "../coupons/flags.ts";
import {
  COUPON_STATES,
  couponAdminError,
  validateCouponAdminInput,
  type CouponAdminInput,
  type CouponScope,
  type CouponState,
  type CouponStatus,
} from "../coupons/rules.ts";
import type { ValidationResult } from "../reservations/validation.ts";

export { isCouponsAdminEnabled };

// --- Permissões ---------------------------------------------------------------

/**
 * Criar, editar, ativar, desativar e liberar usos: só ADMIN. OPERATOR consulta.
 * O banco confere o mesmo (`is_active_owner_admin`) em cada RPC de gestão.
 */
export function canManageCoupons(role: string | null | undefined) {
  return role === "ADMIN";
}

// --- Tipos --------------------------------------------------------------------

export const REDEMPTION_STATES = ["RESERVED", "CONFIRMED", "CANCELLED_AFTER_PAYMENT", "RELEASED", "LAPSED"] as const;
export type RedemptionState = (typeof REDEMPTION_STATES)[number];

export type AdminCouponExperience = { id: string; title: string; slug: string; kind: "REGULAR" | "EVENT" };

export type AdminCouponUses = {
  counted: number;
  reserved: number;
  confirmed: number;
  cancelledAfterPayment: number;
  released: number;
  lapsed: number;
};

export type AdminCoupon = {
  id: string;
  code: string;
  percentOff: number;
  validFrom: string | null;
  validUntil: string | null;
  maxUses: number | null;
  scope: CouponScope;
  status: CouponStatus;
  description: string | null;
  experiences: AdminCouponExperience[];
  uses: AdminCouponUses;
  locked: boolean;
  state: CouponState;
  overLimit: boolean;
  excessCount: number;
  createdAt: string;
  updatedAt: string;
};

export type AdminCouponRedemption = {
  id: string;
  reservationId: string;
  publicCode: string;
  experienceTitle: string;
  startsAt: string | null;
  reservationStatus: string;
  state: RedemptionState;
  quantity: number;
  percentOff: number;
  originalTotalCents: number;
  discountCents: number;
  totalCents: number;
  createdAt: string;
  confirmedAt: string | null;
  releasedAt: string | null;
  releasedReason: string | null;
  releasedByName: string | null;
  overLimit: boolean;
};

export type AdminCouponDetail = AdminCoupon & { redemptions: AdminCouponRedemption[] };

/** Uma experiência que o formulário oferece para um cupom `SELECTED`. */
export type CouponExperienceOption = { id: string; title: string; status: string; kind: "REGULAR" | "EVENT" };

// --- Rótulos ------------------------------------------------------------------

export const COUPON_STATE_LABELS: Record<CouponState, string> = {
  ACTIVE: "Ativo",
  INACTIVE: "Inativo",
  SCHEDULED: "Agendado",
  EXPIRED: "Expirado",
  EXHAUSTED: "Esgotado",
};

export const REDEMPTION_STATE_LABELS: Record<RedemptionState, string> = {
  RESERVED: "Pré-reserva (aguardando pagamento)",
  CONFIRMED: "Confirmada",
  CANCELLED_AFTER_PAYMENT: "Paga e cancelada",
  RELEASED: "Liberada",
  LAPSED: "Expirada sem pagamento",
};

/** "Sem prazo", "A partir de 10/11/2026", "Até 30/11/2026" ou "10/11/2026 a 30/11/2026". */
export function couponValidityLabel(validFrom: string | null, validUntil: string | null) {
  const day = (value: string) => {
    const [year, month, date] = value.split("-");
    return `${date}/${month}/${year}`;
  };
  if (!validFrom && !validUntil) return "Sem prazo";
  if (validFrom && validUntil) return `${day(validFrom)} a ${day(validUntil)}`;
  return validFrom ? `A partir de ${day(validFrom)}` : `Até ${day(validUntil!)}`;
}

export function couponLimitLabel(maxUses: number | null) {
  return maxUses === null ? "Ilimitado" : `${maxUses} ${maxUses === 1 ? "utilização" : "utilizações"}`;
}

export function couponScopeLabel(coupon: Pick<AdminCoupon, "scope" | "experiences">) {
  if (coupon.scope === "ALL_REGULAR") return "Todas as experiências regulares";
  const count = coupon.experiences.length;
  return `${count} ${count === 1 ? "experiência selecionada" : "experiências selecionadas"}`;
}

// --- Leitura das respostas do banco -------------------------------------------

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function integer(value: unknown) {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(number) ? number : 0;
}

function nullableInteger(value: unknown) {
  return value === null || value === undefined ? null : integer(value);
}

/** Datas do cupom (`date`): sempre AAAA-MM-DD, nunca um instante. */
function dateOnly(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function parseExperiences(value: unknown): AdminCouponExperience[] {
  return (Array.isArray(value) ? value : [])
    .filter(isRow)
    .filter((item) => text(item.id))
    .map((item) => ({ id: text(item.id), title: text(item.title), slug: text(item.slug), kind: item.kind === "EVENT" ? "EVENT" : "REGULAR" }));
}

/** Um cupom como `admin_coupon_json` o devolve, ou null se a linha não fizer sentido. */
export function parseAdminCoupon(value: unknown): AdminCoupon | null {
  if (!isRow(value)) return null;
  const id = text(value.id);
  const code = text(value.code);
  const state = text(value.state) as CouponState;
  const scope = text(value.scope) as CouponScope;
  const status = text(value.status) as CouponStatus;
  if (!id || !code || !COUPON_STATES.includes(state) || (scope !== "ALL_REGULAR" && scope !== "SELECTED") || (status !== "ACTIVE" && status !== "INACTIVE")) {
    return null;
  }
  const uses = isRow(value.uses) ? value.uses : {};
  return {
    id,
    code,
    percentOff: integer(value.percentOff),
    validFrom: dateOnly(value.validFrom),
    validUntil: dateOnly(value.validUntil),
    maxUses: nullableInteger(value.maxUses),
    scope,
    status,
    description: nullableText(value.description),
    experiences: parseExperiences(value.experiences),
    uses: {
      counted: integer(uses.counted),
      reserved: integer(uses.reserved),
      confirmed: integer(uses.confirmed),
      cancelledAfterPayment: integer(uses.cancelledAfterPayment),
      released: integer(uses.released),
      lapsed: integer(uses.lapsed),
    },
    locked: value.locked === true,
    state,
    // O alerta vem à parte da situação e vale com qualquer uma delas.
    overLimit: value.overLimit === true,
    excessCount: integer(value.excessCount),
    createdAt: text(value.createdAt),
    updatedAt: text(value.updatedAt),
  };
}

export function parseAdminCoupons(value: unknown): AdminCoupon[] {
  return (Array.isArray(value) ? value : []).map(parseAdminCoupon).filter((item): item is AdminCoupon => item !== null);
}

function parseRedemption(value: unknown): AdminCouponRedemption | null {
  if (!isRow(value)) return null;
  const state = text(value.state) as RedemptionState;
  if (!text(value.id) || !text(value.reservationId) || !REDEMPTION_STATES.includes(state)) return null;
  return {
    id: text(value.id),
    reservationId: text(value.reservationId),
    publicCode: text(value.publicCode),
    experienceTitle: text(value.experienceTitle),
    startsAt: nullableText(value.startsAt),
    reservationStatus: text(value.reservationStatus),
    state,
    quantity: integer(value.quantity),
    percentOff: integer(value.percentOff),
    originalTotalCents: integer(value.originalTotalCents),
    discountCents: integer(value.discountCents),
    totalCents: integer(value.totalCents),
    createdAt: text(value.createdAt),
    confirmedAt: nullableText(value.confirmedAt),
    releasedAt: nullableText(value.releasedAt),
    releasedReason: nullableText(value.releasedReason),
    releasedByName: nullableText(value.releasedByName),
    overLimit: value.overLimit === true,
  };
}

/** O detalhe de `admin_get_coupon`: o cupom e cada uso. Null quando não existe. */
export function parseAdminCouponDetail(value: unknown): AdminCouponDetail | null {
  const coupon = parseAdminCoupon(value);
  if (!coupon || !isRow(value)) return null;
  const redemptions = (Array.isArray(value.redemptions) ? value.redemptions : [])
    .map(parseRedemption)
    .filter((item): item is AdminCouponRedemption => item !== null);
  return { ...coupon, redemptions };
}

/** O cupom sem a lista de usos — o que o formulário de edição precisa receber. */
export function couponSummary(detail: AdminCouponDetail): AdminCoupon {
  const copy: Partial<AdminCouponDetail> = { ...detail };
  delete copy.redemptions;
  return copy as AdminCoupon;
}

// --- Resumo financeiro --------------------------------------------------------

export type CouponFinancials = {
  /** Soma do que foi efetivamente cobrado: só usos confirmados (inclui Stand-by). */
  revenueConfirmedCents: number;
  /** O que deixou de ser cobrado nesses mesmos usos confirmados. */
  discountConfirmedCents: number;
  /** Pré-reservas ainda aguardando pagamento: não é receita. */
  pendingCount: number;
  pendingTotalCents: number;
};

/**
 * Valores do detalhe, com a mesma definição de
 * `supabase/diagnostics/discount_coupons_report.sql`: receita e desconto só de
 * usos `CONFIRMED`. Pagamento pendente fica à parte e nunca soma como receita;
 * uso pago e depois cancelado, liberado ou expirado não soma.
 */
export function couponFinancials(redemptions: AdminCouponRedemption[]): CouponFinancials {
  let revenueConfirmedCents = 0;
  let discountConfirmedCents = 0;
  let pendingCount = 0;
  let pendingTotalCents = 0;
  for (const item of redemptions) {
    if (item.state === "CONFIRMED") {
      revenueConfirmedCents += item.totalCents;
      discountConfirmedCents += item.discountCents;
    } else if (item.state === "RESERVED") {
      pendingCount += 1;
      pendingTotalCents += item.totalCents;
    }
  }
  return { revenueConfirmedCents, discountConfirmedCents, pendingCount, pendingTotalCents };
}

/** A liberação manual só existe para uso pago e depois cancelado (regra do banco). */
export function canReleaseRedemption(item: Pick<AdminCouponRedemption, "state">) {
  return item.state === "CANCELLED_AFTER_PAYMENT";
}

// --- Filtros da lista ---------------------------------------------------------

export const COUPON_STATUS_FILTERS = ["ALL", ...COUPON_STATES, "OVER_LIMIT"] as const;
export type CouponStatusFilter = (typeof COUPON_STATUS_FILTERS)[number];

export const COUPON_STATUS_FILTER_LABELS: Record<CouponStatusFilter, string> = {
  ALL: "Todos",
  ACTIVE: "Ativos",
  INACTIVE: "Inativos",
  SCHEDULED: "Agendados",
  EXPIRED: "Expirados",
  EXHAUSTED: "Esgotados",
  OVER_LIMIT: "Com limite excedido",
};

export type CouponFilters = { status: CouponStatusFilter; query: string };

function single(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}

/** Filtros da URL. O que não for reconhecido vira "sem filtro". */
export function parseCouponFilters(params: Record<string, string | string[] | undefined>): CouponFilters {
  const status = single(params.status).trim().toUpperCase() as CouponStatusFilter;
  return {
    status: COUPON_STATUS_FILTERS.includes(status) ? status : "ALL",
    query: single(params.query).replace(/\s+/g, "").toUpperCase().slice(0, 32),
  };
}

/** Situação e busca por código. "Com limite excedido" independe da situação. */
export function filterCoupons(coupons: AdminCoupon[], filters: CouponFilters) {
  return coupons.filter((coupon) => {
    if (filters.status === "OVER_LIMIT" && !coupon.overLimit) return false;
    if (filters.status !== "ALL" && filters.status !== "OVER_LIMIT" && coupon.state !== filters.status) return false;
    return !filters.query || coupon.code.includes(filters.query);
  });
}

export function couponListHref(filters: CouponFilters) {
  const query = new URLSearchParams();
  if (filters.status !== "ALL") query.set("status", filters.status);
  if (filters.query) query.set("query", filters.query);
  const search = query.toString();
  return `/admin/marketing/cupons${search ? `?${search}` : ""}`;
}

// --- Formulário e pedidos -----------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCouponUuid(value: string) {
  return UUID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Criação: os campos do cupom, com o status inicial. */
export function validateCouponCreate(value: unknown): ValidationResult<CouponAdminInput> {
  return validateCouponAdminInput(value);
}

export type CouponUpdateInput = Omit<CouponAdminInput, "status"> & { expectedUpdatedAt: string };

/**
 * Edição. O status não muda por aqui (é a ativação/desativação, com auditoria
 * própria); `expectedUpdatedAt` é a versão que o formulário abriu, para uma
 * edição feita sobre dados velhos não apagar a de outra pessoa.
 */
export function validateCouponUpdate(value: unknown): ValidationResult<CouponUpdateInput> {
  if (!isRecord(value)) return { success: false, errors: { form: "Dados inválidos." } };
  // O status é ignorado aqui: a validação comum o exige, e ele não é gravado.
  const result = validateCouponAdminInput({ ...value, status: "INACTIVE" });
  const expectedUpdatedAt = typeof value.expectedUpdatedAt === "string" ? value.expectedUpdatedAt.trim() : "";
  const errors = result.success ? {} : { ...result.errors };
  if (!expectedUpdatedAt) errors.form = "Recarregue a página e tente de novo.";
  if (!result.success || Object.keys(errors).length) return { success: false, errors };
  const { code, percentOff, validFrom, validUntil, maxUses, scope, experienceIds, description } = result.data;
  return { success: true, data: { code, percentOff, validFrom, validUntil, maxUses, scope, experienceIds, description, expectedUpdatedAt } };
}

function sameIds(a: string[], b: string[]) {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Campos que o pedido tenta mudar num cupom já utilizado. O banco recusa do
 * mesmo jeito (`COUPON_LOCKED_FIELDS`); aqui a recusa sai campo a campo.
 */
export function lockedFieldErrors(current: AdminCoupon, input: Pick<CouponAdminInput, "code" | "percentOff" | "scope" | "experienceIds">) {
  if (!current.locked) return {};
  const errors: Record<string, string> = {};
  const why = "bloqueado depois da primeira utilização";
  if (input.code !== current.code) errors.code = `Código ${why}.`;
  if (input.percentOff !== current.percentOff) errors.percentOff = `Percentual ${why}.`;
  if (input.scope !== current.scope || !sameIds(input.experienceIds, current.experiences.map((item) => item.id))) {
    errors.experienceIds = `Experiências elegíveis ${why}.`;
  }
  return errors;
}

/** Ativar ou desativar, com motivo opcional (até 500 caracteres) para a auditoria. */
export function validateCouponStatusChange(value: unknown): ValidationResult<{ status: CouponStatus; reason: string | null }> {
  if (!isRecord(value)) return { success: false, errors: { form: "Dados inválidos." } };
  const status = String(value.status ?? "");
  const reason = String(value.reason ?? "").replace(/\s+/g, " ").trim();
  const errors: Record<string, string> = {};
  if (status !== "ACTIVE" && status !== "INACTIVE") errors.status = "Status inválido.";
  if (reason.length > 500) errors.reason = "O motivo aceita até 500 caracteres.";
  return Object.keys(errors).length ? { success: false, errors } : { success: true, data: { status: status as CouponStatus, reason: reason || null } };
}

/** Liberação manual: justificativa de 3 a 500 caracteres e confirmação explícita. */
export function validateCouponRelease(value: unknown): ValidationResult<{ reason: string }> {
  if (!isRecord(value)) return { success: false, errors: { form: "Dados inválidos." } };
  const reason = String(value.reason ?? "").replace(/\s+/g, " ").trim();
  if (reason.length < 3 || reason.length > 500) return { success: false, errors: { reason: "Informe uma justificativa entre 3 e 500 caracteres." } };
  if (value.confirmed !== true) return { success: false, errors: { confirmed: "Confirme a liberação." } };
  return { success: true, data: { reason } };
}

// --- Erros --------------------------------------------------------------------

const CONNECTION_PATTERN = /fetch failed|network|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|timeout|socket hang up|Failed to fetch/i;

/**
 * Erro do banco (ou da rede) para a equipe. Nunca repassa o texto original:
 * as recusas conhecidas viram a mensagem de `couponAdminError`; função ausente
 * é migration não aplicada; falha de conexão pede nova tentativa.
 */
export function couponPanelError(error: unknown): { status: number; message: string; field?: string } {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.includes("PGRST202") || /Could not find the function|function public\.[a-z_]+\(.*\) does not exist/i.test(message)) {
    return { status: 503, message: "Os cupons ainda não estão disponíveis neste banco. Aplique a migration de cupons no Supabase." };
  }
  if (message === "ADMIN_NOT_CONFIGURED") return { status: 503, message: "O painel de cupons não está configurado neste ambiente." };
  if (CONNECTION_PATTERN.test(message)) {
    return { status: 503, message: "Não foi possível falar com o banco agora. Recarregue a página e confira o cupom antes de tentar de novo." };
  }
  return couponAdminError(message);
}
