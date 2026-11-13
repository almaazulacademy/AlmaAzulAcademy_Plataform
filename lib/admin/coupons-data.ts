/**
 * Cupons de desconto: as chamadas do painel ao Supabase.
 *
 * Toda decisão é do banco. Cada função entrega o ator validado pela sessão
 * administrativa às RPCs da fase 2 (`admin_list_coupons`, `admin_get_coupon`,
 * `admin_create_coupon`, `admin_update_coupon`, `admin_set_coupon_status`,
 * `admin_release_coupon_redemption`), que conferem o papel de novo, travam o
 * cupom e gravam a auditoria. Nada aqui lê tabela de cupom direto nem
 * registra dado pessoal em log.
 *
 * `createCouponAdminData(client)` não depende do Next nem do Supabase: é o que
 * os testes usam contra o Postgres em memória. Os `handleCoupon*` são o corpo
 * das rotas, sem Next.
 */

import {
  canManageCoupons,
  couponPanelError,
  lockedFieldErrors,
  parseAdminCoupon,
  parseAdminCouponDetail,
  parseAdminCoupons,
  validateCouponCreate,
  validateCouponRelease,
  validateCouponStatusChange,
  validateCouponUpdate,
  type AdminCoupon,
  type AdminCouponDetail,
  type CouponExperienceOption,
  type CouponUpdateInput,
} from "./coupons.ts";
import type { CouponAdminInput, CouponStatus } from "../coupons/rules.ts";

type RpcResult = { data: unknown; error: { message: string; code?: string } | null };

/** O pedaço do supabase-js usado aqui. */
export type CouponAdminClient = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<RpcResult>;
  from(table: string): { select(columns: string): { in(column: string, values: string[]): PromiseLike<RpcResult> } };
};

function failure(error: { message: string; code?: string }) {
  return new Error(error.code ? `${error.code}: ${error.message}` : error.message);
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
}

export function createCouponAdminData(client: CouponAdminClient) {
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.rpc(name, args);
    if (result.error) throw failure(result.error);
    return result.data;
  }

  function couponArgs(input: Omit<CouponAdminInput, "status">) {
    return {
      p_code: input.code,
      p_percent_off: input.percentOff,
      p_valid_from: input.validFrom,
      p_valid_until: input.validUntil,
      p_max_uses: input.maxUses,
      p_scope: input.scope,
      p_experience_ids: input.experienceIds,
      p_description: input.description,
    };
  }

  return {
    /** Todos os cupons, o mais recente primeiro. ADMIN e OPERATOR. */
    async list(actorUserId: string): Promise<AdminCoupon[]> {
      return parseAdminCoupons(await call("admin_list_coupons", { p_actor_id: actorUserId }));
    },

    /** Um cupom com cada uso. Null quando não existe. ADMIN e OPERATOR. */
    async get(actorUserId: string, couponId: string): Promise<AdminCouponDetail | null> {
      return parseAdminCouponDetail(await call("admin_get_coupon", { p_actor_id: actorUserId, p_coupon_id: couponId }));
    },

    async create(actorUserId: string, input: CouponAdminInput): Promise<AdminCoupon | null> {
      return parseAdminCoupon(await call("admin_create_coupon", { p_actor_id: actorUserId, ...couponArgs(input), p_status: input.status }));
    },

    async update(actorUserId: string, couponId: string, input: Omit<CouponAdminInput, "status">): Promise<AdminCoupon | null> {
      return parseAdminCoupon(await call("admin_update_coupon", { p_actor_id: actorUserId, p_coupon_id: couponId, ...couponArgs(input) }));
    },

    async setStatus(actorUserId: string, couponId: string, status: CouponStatus, reason: string | null): Promise<AdminCoupon | null> {
      return parseAdminCoupon(await call("admin_set_coupon_status", { p_actor_id: actorUserId, p_coupon_id: couponId, p_status: status, p_reason: reason }));
    },

    async release(actorUserId: string, redemptionId: string, reason: string): Promise<{ state: string; replayed: boolean }> {
      const answer = await call("admin_release_coupon_redemption", { p_actor_id: actorUserId, p_redemption_id: redemptionId, p_reason: reason });
      const row = answer && typeof answer === "object" ? answer as Record<string, unknown> : {};
      return { state: typeof row.state === "string" ? row.state : "", replayed: row.replayed === true };
    },

    /**
     * Experiências que o formulário oferece, com o tipo (regular ou evento
     * especial). A lista vem de `admin_list_experiences` (que confere o papel);
     * o tipo, de `experiences.kind`. Sem a coluna, toda experiência é regular.
     */
    async experiences(actorUserId: string): Promise<CouponExperienceOption[]> {
      const list = rows(await call("admin_list_experiences", { p_actor_id: actorUserId }));
      const ids = list.map((row) => String(row.id ?? "")).filter(Boolean);
      const kinds = new Map<string, "REGULAR" | "EVENT">();
      if (ids.length) {
        const result = await client.from("experiences").select("id, kind").in("id", ids);
        if (result.error && result.error.code !== "42703") throw failure(result.error);
        for (const row of rows(result.data)) kinds.set(String(row.id), row.kind === "EVENT" ? "EVENT" : "REGULAR");
      }
      return list
        .filter((row) => typeof row.id === "string" && row.id)
        .map((row) => ({
          id: String(row.id),
          title: String(row.title ?? ""),
          status: String(row.status ?? ""),
          kind: kinds.get(String(row.id)) ?? "REGULAR",
        }));
    },
  };
}

export type CouponAdminData = ReturnType<typeof createCouponAdminData>;

export type CouponRouteResponse = { status: number; body: Record<string, unknown> };

const FORBIDDEN: CouponRouteResponse = { status: 403, body: { message: "Somente administradores podem criar ou alterar cupons." } };

function invalid(errors: Record<string, string>): CouponRouteResponse {
  return { status: 400, body: { message: Object.values(errors)[0] ?? "Dados inválidos.", errors } };
}

function refused(error: unknown): CouponRouteResponse {
  const mapped = couponPanelError(error);
  return { status: mapped.status, body: { message: mapped.message, ...(mapped.field ? { errors: { [mapped.field]: mapped.message } } : {}) } };
}

/**
 * "Novo cupom". O ator e o papel vêm da sessão validada, nunca do corpo. O
 * OPERATOR é recusado aqui e de novo pelo banco.
 */
export async function handleCouponCreate(data: CouponAdminData, actor: { userId: string; role: string }, body: unknown): Promise<CouponRouteResponse> {
  if (!canManageCoupons(actor.role)) return FORBIDDEN;
  const validation = validateCouponCreate(body);
  if (!validation.success) return invalid(validation.errors);
  try {
    const coupon = await data.create(actor.userId, validation.data);
    return { status: 201, body: { coupon, message: `Cupom ${validation.data.code} criado.` } };
  } catch (error) {
    return refused(error);
  }
}

/**
 * Edição. Antes de gravar confere a versão que o formulário abriu: se outra
 * pessoa salvou nesse meio-tempo, recusa com 409 em vez de sobrescrever. Os
 * campos bloqueados saem com mensagem por campo; o banco confere tudo de novo
 * com o cupom travado.
 */
export async function handleCouponUpdate(data: CouponAdminData, actor: { userId: string; role: string }, couponId: string, body: unknown): Promise<CouponRouteResponse> {
  if (!canManageCoupons(actor.role)) return FORBIDDEN;
  const validation = validateCouponUpdate(body);
  if (!validation.success) return invalid(validation.errors);
  const input: CouponUpdateInput = validation.data;
  try {
    const current = await data.get(actor.userId, couponId);
    if (!current) return { status: 404, body: { message: "Cupom não encontrado." } };
    if (current.updatedAt !== input.expectedUpdatedAt) {
      return { status: 409, body: { message: "Este cupom foi alterado por outra pessoa enquanto você editava. Recarregue a página para ver a versão atual.", stale: true } };
    }
    const locked = lockedFieldErrors(current, input);
    if (Object.keys(locked).length) {
      return { status: 409, body: { message: "Este cupom já foi utilizado: código, percentual e experiências elegíveis não podem mais mudar.", errors: locked } };
    }
    const fields = {
      code: input.code,
      percentOff: input.percentOff,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      maxUses: input.maxUses,
      scope: input.scope,
      experienceIds: input.experienceIds,
      description: input.description,
    };
    const coupon = await data.update(actor.userId, couponId, fields);
    return { status: 200, body: { coupon, message: `Cupom ${fields.code} atualizado.` } };
  } catch (error) {
    return refused(error);
  }
}

/**
 * Ativar ou desativar. Desativar só impede novos usos: reservas, valores e
 * histórico ficam como estão (o banco não toca em `coupon_redemptions` nem em
 * `reservations`). Repetir o mesmo status não muda nada nem audita de novo.
 */
export async function handleCouponStatus(data: CouponAdminData, actor: { userId: string; role: string }, couponId: string, body: unknown): Promise<CouponRouteResponse> {
  if (!canManageCoupons(actor.role)) return FORBIDDEN;
  const validation = validateCouponStatusChange(body);
  if (!validation.success) return invalid(validation.errors);
  try {
    const coupon = await data.setStatus(actor.userId, couponId, validation.data.status, validation.data.reason);
    if (!coupon) return { status: 404, body: { message: "Cupom não encontrado." } };
    return {
      status: 200,
      body: { coupon, message: validation.data.status === "ACTIVE" ? `Cupom ${coupon.code} ativado.` : `Cupom ${coupon.code} desativado. As reservas já feitas com ele não mudam.` },
    };
  } catch (error) {
    return refused(error);
  }
}

/**
 * Liberação manual de um uso pago e depois cancelado, com justificativa. Só o
 * banco decide se o uso é liberável; repetir não libera duas vezes.
 */
export async function handleCouponRelease(data: CouponAdminData, actor: { userId: string; role: string }, redemptionId: string, body: unknown): Promise<CouponRouteResponse> {
  if (!canManageCoupons(actor.role)) return FORBIDDEN;
  const validation = validateCouponRelease(body);
  if (!validation.success) return invalid(validation.errors);
  try {
    const result = await data.release(actor.userId, redemptionId, validation.data.reason);
    return result.replayed
      ? { status: 409, body: { message: "Esta utilização já estava liberada. Nada foi alterado.", state: result.state, replayed: true } }
      : { status: 200, body: { message: "Utilização liberada. Ela deixa de contar no limite do cupom.", state: result.state } };
  } catch (error) {
    return refused(error);
  }
}
