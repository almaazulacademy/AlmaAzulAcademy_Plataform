/**
 * Regras dos cupons de desconto que o servidor e as telas compartilham.
 *
 * Quem decide é o banco (`202611020001_discount_coupons.sql`): validade,
 * elegibilidade, limite de usos, valor mínimo e o desconto gravado na reserva.
 * Este módulo espelha o cálculo para a prévia e as telas, normaliza o que se
 * digita e traduz os símbolos do banco em mensagens. Nunca é a fonte do valor
 * cobrado.
 *
 * Módulo puro, sem imports de aplicação: é lido pelo Next e pelos testes.
 */

import type { ValidationResult } from "../reservations/validation.ts";

export const COUPON_PERCENT_MIN = 1;
/** Sem 100% na primeira versão: a InfinitePay não cobra valor zero. Cortesia segue pela confirmação manual. */
export const COUPON_PERCENT_MAX = 99;
export const COUPON_CODE_MAX_LENGTH = 32;
const COUPON_CODE_PATTERN = /^[A-Z0-9-]{3,32}$/;

export const COUPON_SCOPES = ["ALL_REGULAR", "SELECTED"] as const;
export type CouponScope = (typeof COUPON_SCOPES)[number];

export const COUPON_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type CouponStatus = (typeof COUPON_STATUSES)[number];

/** O código como é guardado: sem espaços nas pontas, em maiúsculas. */
export function normalizeCouponCode(value: unknown) {
  return String(value ?? "").replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").toUpperCase();
}

/** 3 a 32 caracteres entre A–Z, 0–9 e hífen, com ao menos uma letra ou número. */
export function isValidCouponCode(code: string) {
  return COUPON_CODE_PATTERN.test(code) && /[A-Z0-9]/.test(code);
}

/**
 * Unitário com desconto, meio centavo para cima — o mesmo cálculo de
 * `coupon_discounted_unit_cents`. Aritmética inteira, sem ponto flutuante.
 */
export function discountedUnitPriceCents(unitPriceCents: number, percentOff: number) {
  return unitPriceCents - Math.floor((unitPriceCents * percentOff + 50) / 100);
}

export type CouponBreakdown = {
  quantity: number;
  percentOff: number;
  originalUnitPriceCents: number;
  unitPriceCents: number;
  originalTotalCents: number;
  discountCents: number;
  totalCents: number;
};

/**
 * Valores de uma reserva com cupom. O desconto é por participante, então o
 * total é sempre `quantidade × unitário final` — exatamente o que a InfinitePay
 * recebe e o que a confirmação compara.
 */
export function couponBreakdown(unitPriceCents: number, percentOff: number, quantity: number): CouponBreakdown {
  const unit = discountedUnitPriceCents(unitPriceCents, percentOff);
  return {
    quantity,
    percentOff,
    originalUnitPriceCents: unitPriceCents,
    unitPriceCents: unit,
    originalTotalCents: unitPriceCents * quantity,
    discountCents: (unitPriceCents - unit) * quantity,
    totalCents: unit * quantity,
  };
}

/**
 * Situação operacional de um cupom no painel (`state` de `admin_coupon_json`).
 * O excesso de limite não é uma situação: vem à parte, em `overLimit` e
 * `excessCount`, e vale com qualquer uma delas.
 */
export const COUPON_STATES = ["ACTIVE", "INACTIVE", "EXPIRED", "SCHEDULED", "EXHAUSTED"] as const;
export type CouponState = (typeof COUPON_STATES)[number];

export type CouponLimitAlert = { overLimit: boolean; excessCount: number };

/** "Limite excedido: 2 utilizações", ou null quando não há excesso. */
export function couponOverLimitLabel(alert: CouponLimitAlert) {
  if (!alert.overLimit || alert.excessCount < 1) return null;
  return `Limite excedido: ${alert.excessCount} ${alert.excessCount === 1 ? "utilização" : "utilizações"}`;
}

/** Recusas do checkout (prévia e pré-reserva), na forma em que o banco as devolve. */
export const COUPON_REJECTIONS = [
  "COUPON_NOT_FOUND",
  "COUPON_EXPIRED",
  "COUPON_NOT_STARTED",
  "COUPON_INACTIVE",
  "COUPON_EXHAUSTED",
  "COUPON_NOT_ELIGIBLE",
  "COUPON_BELOW_MIN_CHARGE",
  "COUPON_UNAVAILABLE",
] as const;
export type CouponRejection = (typeof COUPON_REJECTIONS)[number];

const REJECTION_MESSAGES: Record<CouponRejection, string> = {
  COUPON_NOT_FOUND: "Cupom não encontrado.",
  COUPON_EXPIRED: "Cupom expirado.",
  COUPON_NOT_STARTED: "Este cupom ainda não está válido.",
  COUPON_INACTIVE: "Cupom inativo.",
  COUPON_EXHAUSTED: "Cupom com limite de utilizações esgotado.",
  COUPON_NOT_ELIGIBLE: "Cupom não disponível para esta experiência.",
  COUPON_BELOW_MIN_CHARGE: "Com este cupom, o valor fica abaixo do mínimo aceito para pagamento.",
  COUPON_UNAVAILABLE: "Cupons indisponíveis no momento.",
};

/** O símbolo de recusa contido numa mensagem de erro do banco, ou null. */
export function couponRejection(message: string | null | undefined): CouponRejection | null {
  if (!message) return null;
  return COUPON_REJECTIONS.find((code) => new RegExp(`\\b${code}\\b`).test(message)) ?? null;
}

export function couponRejectionMessage(reason: CouponRejection) {
  return REJECTION_MESSAGES[reason];
}

/** Erros das RPCs do painel, na forma em que o banco os devolve. */
const ADMIN_ERROR_MESSAGES: Record<string, { status: number; message: string; field?: string }> = {
  COUPON_ADMIN_FORBIDDEN: { status: 403, message: "Somente administradores podem criar ou alterar cupons." },
  ADMIN_FORBIDDEN: { status: 403, message: "Acesso não autorizado." },
  COUPON_CODE_TAKEN: { status: 409, message: "Já existe um cupom com este código.", field: "code" },
  coupons_code_key: { status: 409, message: "Já existe um cupom com este código.", field: "code" },
  COUPON_INVALID_CODE: { status: 400, message: "Use de 3 a 32 caracteres: letras, números e hífen.", field: "code" },
  COUPON_INVALID_PERCENT: { status: 400, message: `O desconto deve ficar entre ${COUPON_PERCENT_MIN}% e ${COUPON_PERCENT_MAX}%.`, field: "percentOff" },
  COUPON_INVALID_VALIDITY: { status: 400, message: "A data de término não pode ser anterior à de início.", field: "validUntil" },
  COUPON_INVALID_LIMIT: { status: 400, message: "O limite deve ser de pelo menos 1 utilização.", field: "maxUses" },
  COUPON_INVALID_SCOPE: { status: 400, message: "Escolha a aplicabilidade do cupom.", field: "scope" },
  COUPON_INVALID_EXPERIENCES: { status: 400, message: "Selecione ao menos uma experiência válida.", field: "experienceIds" },
  COUPON_INVALID_STATUS: { status: 400, message: "Status inválido.", field: "status" },
  COUPON_INVALID_DESCRIPTION: { status: 400, message: "A descrição aceita até 500 caracteres.", field: "description" },
  COUPON_LOCKED_FIELDS: { status: 409, message: "Este cupom já foi utilizado: código, percentual e aplicabilidade não podem mais mudar." },
  COUPON_LIMIT_BELOW_USAGE: { status: 409, message: "O limite não pode ser reduzido abaixo das utilizações já reservadas ou confirmadas.", field: "maxUses" },
  COUPON_NOT_FOUND: { status: 404, message: "Cupom não encontrado." },
  COUPON_REDEMPTION_NOT_FOUND: { status: 404, message: "Utilização não encontrada." },
  COUPON_RELEASE_NOT_ALLOWED: { status: 409, message: "Só é possível liberar a utilização de uma reserva paga e depois cancelada." },
  REASON_REQUIRED: { status: 400, message: "Informe o motivo.", field: "reason" },
};

export function couponAdminError(message: string | null | undefined) {
  const text = message ?? "";
  const key = Object.keys(ADMIN_ERROR_MESSAGES).find((code) => new RegExp(`\\b${code}\\b`).test(text));
  return key ? ADMIN_ERROR_MESSAGES[key] : { status: 500, message: "Não foi possível salvar o cupom." };
}

export type CouponAdminInput = {
  code: string;
  percentOff: number;
  validFrom: string | null;
  validUntil: string | null;
  maxUses: number | null;
  scope: CouponScope;
  experienceIds: string[];
  status: CouponStatus;
  description: string | null;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalDate(value: unknown) {
  if (value === null || value === undefined || value === "") return { ok: true as const, value: null };
  const text = String(value).trim();
  if (!DATE_PATTERN.test(text)) return { ok: false as const };
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? { ok: false as const } : { ok: true as const, value: text };
}

/**
 * Formulário do painel. As mesmas regras são conferidas de novo no banco
 * (`coupon_admin_input_error`); aqui elas dão a mensagem por campo.
 */
export function validateCouponAdminInput(value: unknown): ValidationResult<CouponAdminInput> {
  if (!isRecord(value)) return { success: false, errors: { form: "Dados inválidos." } };
  const errors: Record<string, string> = {};

  const code = normalizeCouponCode(value.code);
  if (!isValidCouponCode(code)) errors.code = ADMIN_ERROR_MESSAGES.COUPON_INVALID_CODE.message;

  const percentOff = typeof value.percentOff === "number" ? value.percentOff : Number.NaN;
  if (!Number.isInteger(percentOff) || percentOff < COUPON_PERCENT_MIN || percentOff > COUPON_PERCENT_MAX) {
    errors.percentOff = ADMIN_ERROR_MESSAGES.COUPON_INVALID_PERCENT.message;
  }

  const from = optionalDate(value.validFrom);
  const until = optionalDate(value.validUntil);
  if (!from.ok) errors.validFrom = "Data de início inválida.";
  if (!until.ok) errors.validUntil = "Data de término inválida.";
  if (from.ok && until.ok && from.value && until.value && until.value < from.value) {
    errors.validUntil = ADMIN_ERROR_MESSAGES.COUPON_INVALID_VALIDITY.message;
  }

  let maxUses: number | null = null;
  if (value.maxUses !== null && value.maxUses !== undefined && value.maxUses !== "") {
    maxUses = typeof value.maxUses === "number" ? value.maxUses : Number.NaN;
    if (!Number.isInteger(maxUses) || maxUses < 1) errors.maxUses = ADMIN_ERROR_MESSAGES.COUPON_INVALID_LIMIT.message;
  }

  const scope = String(value.scope ?? "") as CouponScope;
  if (!COUPON_SCOPES.includes(scope)) errors.scope = ADMIN_ERROR_MESSAGES.COUPON_INVALID_SCOPE.message;

  const rawIds = Array.isArray(value.experienceIds) ? value.experienceIds : [];
  const experienceIds = [...new Set(rawIds.map((id) => String(id).trim()))];
  if (experienceIds.some((id) => !UUID_PATTERN.test(id))
      || (scope === "SELECTED" && experienceIds.length === 0)
      || (scope === "ALL_REGULAR" && experienceIds.length > 0)) {
    errors.experienceIds = ADMIN_ERROR_MESSAGES.COUPON_INVALID_EXPERIENCES.message;
  }

  const status = String(value.status ?? "") as CouponStatus;
  if (!COUPON_STATUSES.includes(status)) errors.status = ADMIN_ERROR_MESSAGES.COUPON_INVALID_STATUS.message;

  const description = String(value.description ?? "").trim();
  if (description.length > 500) errors.description = ADMIN_ERROR_MESSAGES.COUPON_INVALID_DESCRIPTION.message;

  return Object.keys(errors).length
    ? { success: false, errors }
    : {
        success: true,
        data: {
          code,
          percentOff,
          validFrom: from.ok ? from.value : null,
          validUntil: until.ok ? until.value : null,
          maxUses,
          scope,
          experienceIds,
          status,
          description: description || null,
        },
      };
}
