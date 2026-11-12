/**
 * Cupons de desconto — fase 3: painel administrativo (Marketing → Cupons).
 *
 * As regras puras (variável, acesso, leitura das respostas, filtros, resumo
 * financeiro, validação) são testadas direto. O acesso ao banco
 * (`createCouponAdminData`) e o corpo das rotas (`handleCoupon*`) rodam contra
 * o Postgres em memória com todas as migrations, pelas RPCs de verdade da
 * fase 2, com reservas reais (pré-reserva com cupom, pagamento, expiração,
 * reconciliação e cancelamento). As páginas, as rotas e o menu, que o runner do
 * Node não executa, são conferidos no código-fonte.
 *
 * Esta fase não traz migration: só usa as funções da fase 2.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  canManageCoupons,
  canReleaseRedemption,
  couponFinancials,
  couponLimitLabel,
  couponListHref,
  couponPanelError,
  couponScopeLabel,
  couponSummary,
  couponValidityLabel,
  filterCoupons,
  isCouponsAdminEnabled,
  lockedFieldErrors,
  parseAdminCoupon,
  parseAdminCouponDetail,
  parseAdminCoupons,
  parseCouponFilters,
  validateCouponRelease,
  validateCouponStatusChange,
  validateCouponUpdate,
  type AdminCoupon,
  type AdminCouponRedemption,
} from "../lib/admin/coupons.ts";
import {
  createCouponAdminData,
  handleCouponCreate,
  handleCouponRelease,
  handleCouponStatus,
  handleCouponUpdate,
} from "../lib/admin/coupons-data.ts";
import { fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";
import { ADMIN, INSTRUCTOR, STRANGER, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

const OPERATOR = "c0000000-0000-4000-8000-000000000005";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function code(path: string) {
  return source(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
}

const REPORT = source("supabase/diagnostics/discount_coupons_report.sql");

const db = await fullDatabase();
const pglite = createPgliteAdmin(db);
const data = createCouponAdminData(pglite.client);
const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
const { one, rows, call, IMERSAO, SUNSET_CONCHA, makeSession } = fx;

await rows(`insert into auth.users (id, email) values ($1::uuid, 'operador-painel@teste.local') on conflict do nothing`, [OPERATOR]);
await rows(`insert into public.admin_users (user_id, display_name, role, is_active) values ($1::uuid, 'Operador Painel', 'OPERATOR', true) on conflict do nothing`, [OPERATOR]);
// O mínimo de cobrança só é gravado depois de confirmado na InfinitePay; nos testes, R$ 1,00.
await rows(`update public.coupon_settings set min_charge_cents = 100`);

const AS_ADMIN = { userId: ADMIN, role: "ADMIN" };
const AS_OPERATOR = { userId: OPERATOR, role: "OPERATOR" };

let sequence = 0;

function nextCode(prefix = "PAINEL") {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    code: nextCode(),
    percentOff: 10,
    validFrom: null,
    validUntil: null,
    maxUses: null,
    scope: "ALL_REGULAR",
    experienceIds: [],
    status: "ACTIVE",
    description: null,
    ...overrides,
  };
}

async function created(overrides: Record<string, unknown> = {}) {
  const result = await handleCouponCreate(data, AS_ADMIN, body(overrides));
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.coupon as AdminCoupon;
}

/** O corpo de edição a partir do cupom atual, com as mudanças pedidas. */
function editBody(coupon: AdminCoupon, changes: Record<string, unknown> = {}) {
  return {
    code: coupon.code,
    percentOff: coupon.percentOff,
    validFrom: coupon.validFrom,
    validUntil: coupon.validUntil,
    maxUses: coupon.maxUses,
    scope: coupon.scope,
    experienceIds: coupon.experiences.map((item) => item.id),
    description: coupon.description,
    expectedUpdatedAt: coupon.updatedAt,
    ...changes,
  };
}

async function fresh(couponId: string) {
  const coupon = await data.get(ADMIN, couponId);
  assert.ok(coupon);
  return coupon;
}

function bookWithCoupon(sessionId: string, couponCode: string, quantity = 1) {
  sequence += 1;
  const cpf = String(71_000_000_000 + sequence);
  return call(
    `public.create_pre_reservation_with_coupon($1::uuid, $2, $3, $4, $5, $6, null, $7::uuid, $8)`,
    [sessionId, `Cliente Painel ${cpf}`, cpf, `+55619${cpf.slice(-8)}`, `painel${cpf}@teste.local`, quantity, crypto.randomUUID(), couponCode],
  );
}

function pay(reservationId: string, amountCents: number, eventId = `tx-painel-${reservationId}`) {
  return call(
    `public.confirm_reservation_payment($1::uuid, 'INFINITEPAY', $2, $3, 'https://recibo.teste/1', '{}'::jsonb)`,
    [reservationId, eventId, amountCents],
  );
}

async function expire(reservationId: string) {
  await rows(`update public.reservations set created_at = now() - interval '3 hours', expires_at = now() - interval '1 minute' where id = $1::uuid`, [reservationId]);
  await rows(`select public.expire_pre_reservations()`);
}

function regularSession(price = 7_000, capacity = 20) {
  return makeSession(IMERSAO.id, { price, capacity });
}

async function auditCount(couponId: string, action?: string) {
  const row = await one(
    `select count(*)::int as n from public.admin_audit_log where entity_type = 'COUPON' and entity_id = $1::uuid and ($2::text is null or action = $2)`,
    [couponId, action ?? null],
  );
  return row.n as number;
}

async function reportRow(couponCode: string) {
  return (await db.query<Row>(REPORT)).rows.find((row) => row.codigo === couponCode)!;
}

// ===========================================================================
// 1. Regras puras: variável, acesso e leitura
// ===========================================================================

test("variável: só o valor exato true liga o painel; o checkout continua independente", () => {
  assert.equal(isCouponsAdminEnabled({}), false);
  for (const value of ["", "1", "yes", "TRUE ", "false"]) assert.equal(isCouponsAdminEnabled({ COUPONS_ADMIN_ENABLED: value }), false, value);
  assert.equal(isCouponsAdminEnabled({ COUPONS_ADMIN_ENABLED: "true" }), true);
  assert.equal(isCouponsAdminEnabled({ COUPONS_CHECKOUT_ENABLED: "true" }), false);
  assert.equal(isCouponsAdminEnabled({ NEXT_PUBLIC_COUPONS_ADMIN_ENABLED: "true" }), false);
});

test("acesso às rotas: desligado → 404 antes da sessão; depois as regras do painel; gestão só ADMIN", () => {
  const http = code("lib/admin/http.ts");
  const gate = http.match(/export async function authorizeCouponsApi[\s\S]*?\n}\n?/)?.[0] ?? "";
  const order = ["isCouponsAdminEnabled()", "status: 404", "await authorizeAdminApi()", "options.manage && !canManageCoupons(authorization.context.profile.role)", "denied(403)"].map((marker) => gate.indexOf(marker));
  assert.ok(order.every((index) => index >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "variável → sessão/papel administrativo (401/403) → gestão só ADMIN (403)");
  assert.equal(canManageCoupons("ADMIN"), true);
  for (const role of ["OPERATOR", "INSTRUCTOR", "", null, undefined, "admin"]) assert.equal(canManageCoupons(role), false, String(role));
});

test("leitura: linhas incompletas ou com situação desconhecida são descartadas; o alerta vem à parte", () => {
  assert.deepEqual(parseAdminCoupons(null), []);
  assert.deepEqual(parseAdminCoupons([{ id: "a" }, "x", null]), []);
  const base = { id: "a", code: "ABC", percentOff: 10, scope: "ALL_REGULAR", status: "INACTIVE", state: "INACTIVE", uses: {}, experiences: [] };
  assert.equal(parseAdminCoupon({ ...base, state: "OVER_LIMIT" }), null, "OVER_LIMIT não é situação");
  assert.equal(parseAdminCoupon({ ...base, scope: "ALL" }), null);
  const parsed = parseAdminCoupon({ ...base, overLimit: true, excessCount: 2, validFrom: "2026-11-10", maxUses: null });
  assert.deepEqual([parsed?.state, parsed?.overLimit, parsed?.excessCount, parsed?.validFrom, parsed?.maxUses], ["INACTIVE", true, 2, "2026-11-10", null]);
  assert.equal(parseAdminCouponDetail(null), null);
  const detail = parseAdminCouponDetail({ ...base, redemptions: [{ id: "r", reservationId: "x", state: "CONFIRMED" }, { id: "s", reservationId: "y", state: "HACKED" }] });
  assert.deepEqual(detail?.redemptions.map((item) => item.id), ["r"]);
  assert.equal("redemptions" in couponSummary(detail!), false, "o formulário não recebe a lista de usos");
});

test("rótulos: validade, limite e aplicabilidade", () => {
  assert.equal(couponValidityLabel(null, null), "Sem prazo");
  assert.equal(couponValidityLabel("2026-11-10", null), "A partir de 10/11/2026");
  assert.equal(couponValidityLabel(null, "2026-11-30"), "Até 30/11/2026");
  assert.equal(couponValidityLabel("2026-11-10", "2026-11-30"), "10/11/2026 a 30/11/2026");
  assert.equal(couponLimitLabel(null), "Ilimitado");
  assert.equal(couponLimitLabel(1), "1 utilização");
  assert.equal(couponLimitLabel(50), "50 utilizações");
  assert.equal(couponScopeLabel({ scope: "ALL_REGULAR", experiences: [] }), "Todas as experiências regulares");
  assert.equal(couponScopeLabel({ scope: "SELECTED", experiences: [{ id: "a", title: "A", slug: "a", kind: "EVENT" }] }), "1 experiência selecionada");
});

test("filtros: situação, 'com limite excedido' independente da situação, e busca por código", () => {
  const coupon = (id: string, state: AdminCoupon["state"], overLimit = false) => ({ id, code: id, state, overLimit } as AdminCoupon);
  const list = [coupon("ALMA-10", "ACTIVE"), coupon("CAPSULA-15", "EXPIRED", true), coupon("COMUNIDADE-20", "INACTIVE", true), coupon("ALMA-5", "EXHAUSTED")];
  const ids = (filters: Parameters<typeof filterCoupons>[1]) => filterCoupons(list, filters).map((item) => item.id);
  assert.deepEqual(ids({ status: "ALL", query: "" }), ["ALMA-10", "CAPSULA-15", "COMUNIDADE-20", "ALMA-5"]);
  assert.deepEqual(ids({ status: "OVER_LIMIT", query: "" }), ["CAPSULA-15", "COMUNIDADE-20"]);
  assert.deepEqual(ids({ status: "EXPIRED", query: "" }), ["CAPSULA-15"]);
  assert.deepEqual(ids({ status: "ALL", query: "ALMA" }), ["ALMA-10", "ALMA-5"]);
  assert.deepEqual(parseCouponFilters({ status: "over_limit", query: " alma 10 " }), { status: "OVER_LIMIT", query: "ALMA10" });
  assert.deepEqual(parseCouponFilters({ status: "DROP TABLE", query: ["a", "b"] }), { status: "ALL", query: "" });
  assert.equal(couponListHref({ status: "ALL", query: "" }), "/admin/marketing/cupons");
  assert.equal(couponListHref({ status: "EXPIRED", query: "ALMA" }), "/admin/marketing/cupons?status=EXPIRED&query=ALMA");
});

test("pedidos: edição exige a versão aberta; status e liberação validam o corpo", () => {
  const ok = validateCouponUpdate({ code: " alma ", percentOff: 10, scope: "ALL_REGULAR", experienceIds: [], expectedUpdatedAt: "2026-11-12T10:00:00+00:00", status: "HACKED" });
  assert.equal(ok.success, true, "o status do corpo é ignorado na edição");
  if (ok.success) {
    assert.equal(ok.data.code, "ALMA");
    assert.equal("status" in ok.data, false);
  }
  const noVersion = validateCouponUpdate({ code: "ALMA", percentOff: 10, scope: "ALL_REGULAR", experienceIds: [] });
  assert.equal(noVersion.success, false);
  assert.deepEqual(validateCouponStatusChange({ status: "INACTIVE", reason: "  fim da campanha " }), { success: true, data: { status: "INACTIVE", reason: "fim da campanha" } });
  assert.deepEqual(validateCouponStatusChange({ status: "ACTIVE" }), { success: true, data: { status: "ACTIVE", reason: null } });
  assert.equal(validateCouponStatusChange({ status: "DELETED" }).success, false);
  assert.deepEqual(validateCouponRelease({ reason: " Reembolso  integral ", confirmed: true }), { success: true, data: { reason: "Reembolso integral" } });
  for (const value of [null, {}, { reason: "ok", confirmed: true }, { reason: "Motivo válido" }, { reason: "Motivo válido", confirmed: "true" }, { reason: "x".repeat(501), confirmed: true }]) {
    assert.equal(validateCouponRelease(value).success, false, JSON.stringify(value));
  }
});

test("erros: banco e rede viram mensagens da equipe, sem repassar o texto original", () => {
  assert.equal(couponPanelError(new Error("42501: COUPON_ADMIN_FORBIDDEN")).status, 403);
  assert.equal(couponPanelError(new Error("23505: COUPON_CODE_TAKEN")).status, 409);
  assert.equal(couponPanelError(new Error("22023: COUPON_LIMIT_BELOW_USAGE")).field, "maxUses");
  assert.equal(couponPanelError(new Error("PGRST202: Could not find the function public.admin_list_coupons")).status, 503);
  assert.equal(couponPanelError(new Error("TypeError: fetch failed")).status, 503, "falha de conexão");
  assert.equal(couponPanelError(new Error("ADMIN_NOT_CONFIGURED")).status, 503);
  const generic = couponPanelError(new Error("relation secreta tem dados de ana@x.com"));
  assert.equal(generic.status, 500);
  assert.doesNotMatch(generic.message, /ana@x\.com|secreta/);
});

// ===========================================================================
// 2. Permissões no banco e nas rotas
// ===========================================================================

test("permissões: OPERATOR consulta; só ADMIN cria, edita, ativa e libera — na rota e no banco", async () => {
  const coupon = await created();
  // OPERATOR lê a lista e o detalhe.
  assert.ok((await data.list(OPERATOR)).some((item) => item.id === coupon.id));
  assert.equal((await data.get(OPERATOR, coupon.id))?.code, coupon.code);
  // Instrutor e desconhecido não leem.
  for (const actor of [INSTRUCTOR, STRANGER]) {
    await assert.rejects(data.list(actor), /ADMIN_FORBIDDEN/);
    await assert.rejects(data.get(actor, coupon.id), /ADMIN_FORBIDDEN/);
  }

  // A rota recusa o OPERATOR antes de chegar ao banco.
  const before = pglite.calls.rpc.length;
  for (const result of [
    await handleCouponCreate(data, AS_OPERATOR, body()),
    await handleCouponUpdate(data, AS_OPERATOR, coupon.id, editBody(coupon, { description: "operador" })),
    await handleCouponStatus(data, AS_OPERATOR, coupon.id, { status: "INACTIVE" }),
    await handleCouponRelease(data, AS_OPERATOR, crypto.randomUUID(), { reason: "Motivo válido", confirmed: true }),
  ]) {
    assert.equal(result.status, 403);
  }
  assert.equal(pglite.calls.rpc.length, before, "nenhuma RPC chamada pelo OPERATOR");

  // E, mesmo que a rota fosse contornada, o banco recusa o OPERATOR.
  await assert.rejects(data.create(OPERATOR, { ...body(), status: "ACTIVE" } as never), /COUPON_ADMIN_FORBIDDEN/);
  await assert.rejects(data.setStatus(OPERATOR, coupon.id, "INACTIVE", null), /COUPON_ADMIN_FORBIDDEN/);
  await assert.rejects(data.update(OPERATOR, coupon.id, { ...editBody(coupon) } as never), /COUPON_ADMIN_FORBIDDEN/);
  await assert.rejects(data.release(OPERATOR, crypto.randomUUID(), "Motivo válido"), /COUPON_ADMIN_FORBIDDEN/);
  const after = await fresh(coupon.id);
  assert.deepEqual([after.status, after.description, after.updatedAt], [coupon.status, coupon.description, coupon.updatedAt], "nada mudou");
});

// ===========================================================================
// 3. Criação
// ===========================================================================

test("criação válida: código normalizado, situação ativa, auditoria com o ator da sessão", async () => {
  const codeTyped = ` almaazul10-${++sequence} `;
  const result = await handleCouponCreate(data, AS_ADMIN, body({ code: codeTyped, percentOff: 10, description: "  Campanha de boas-vindas para clientes da Comunidade Alma Azul " }));
  assert.equal(result.status, 201);
  const coupon = result.body.coupon as AdminCoupon;
  assert.equal(coupon.code, codeTyped.trim().toUpperCase());
  assert.deepEqual([coupon.percentOff, coupon.state, coupon.status, coupon.locked, coupon.uses.counted], [10, "ACTIVE", "ACTIVE", false, 0]);
  assert.equal(coupon.description, "Campanha de boas-vindas para clientes da Comunidade Alma Azul");
  const audit = await one(`select actor_user_id::text as actor, action from public.admin_audit_log where entity_type = 'COUPON' and entity_id = $1::uuid`, [coupon.id]);
  assert.deepEqual([audit.actor, audit.action], [ADMIN, "COUPON_CREATED"]);

  const inactive = await created({ status: "INACTIVE" });
  assert.equal(inactive.state, "INACTIVE", "status inicial inativo");
});

test("código duplicado: 409 sem diferença de caixa, e nada é criado", async () => {
  const original = await created();
  const count = async () => (await data.list(ADMIN)).length;
  const before = await count();
  const result = await handleCouponCreate(data, AS_ADMIN, body({ code: original.code.toLowerCase() }));
  assert.equal(result.status, 409);
  assert.match(String(result.body.message), /Já existe um cupom com este código/);
  assert.deepEqual(result.body.errors, { code: "Já existe um cupom com este código." });
  assert.equal(await count(), before);

  // Na edição, também.
  const other = await created();
  const clash = await handleCouponUpdate(data, AS_ADMIN, other.id, editBody(other, { code: original.code }));
  assert.equal(clash.status, 409);
});

test("percentual: só inteiros de 1% a 99% — a rota e o banco recusam o resto", async () => {
  for (const percentOff of [0, 100, -5, 10.5, "10", null]) {
    const result = await handleCouponCreate(data, AS_ADMIN, body({ percentOff }));
    assert.equal(result.status, 400, String(percentOff));
    assert.ok((result.body.errors as Record<string, string>).percentOff, String(percentOff));
  }
  for (const percentOff of [0, 100]) {
    await assert.rejects(data.create(ADMIN, { ...body({ percentOff }), status: "ACTIVE" } as never), /COUPON_INVALID_PERCENT/);
  }
  for (const percentOff of [1, 99]) assert.equal((await created({ percentOff })).percentOff, percentOff);
});

test("datas: término antes do início e data inexistente são recusados; o banco confere de novo", async () => {
  const swapped = await handleCouponCreate(data, AS_ADMIN, body({ validFrom: "2026-12-10", validUntil: "2026-12-01" }));
  assert.equal(swapped.status, 400);
  assert.ok((swapped.body.errors as Record<string, string>).validUntil);
  const impossible = await handleCouponCreate(data, AS_ADMIN, body({ validFrom: "2026-02-30" }));
  assert.equal(impossible.status, 400);
  assert.ok((impossible.body.errors as Record<string, string>).validFrom);
  await assert.rejects(data.create(ADMIN, { ...body({ validFrom: "2026-12-10", validUntil: "2026-12-01" }), status: "ACTIVE" } as never), /COUPON_INVALID_VALIDITY/);
  // Mesmo dia de início e término é válido (inclusivo).
  const sameDay = await created({ validFrom: "2026-12-10", validUntil: "2026-12-10" });
  assert.equal(couponValidityLabel(sameDay.validFrom, sameDay.validUntil), "10/12/2026 a 10/12/2026");
});

test("sem validade e sem limite: o cupom fica ativo, 'Sem prazo' e 'Ilimitado'", async () => {
  const coupon = await created({ validFrom: "", validUntil: "", maxUses: "" });
  assert.deepEqual([coupon.validFrom, coupon.validUntil, coupon.maxUses, coupon.state], [null, null, null, "ACTIVE"]);
  assert.equal(couponValidityLabel(coupon.validFrom, coupon.validUntil), "Sem prazo");
  assert.equal(couponLimitLabel(coupon.maxUses), "Ilimitado");
  // Ilimitado: vários usos seguidos continuam aceitos.
  const session = await regularSession();
  for (let index = 0; index < 4; index += 1) await bookWithCoupon(session, coupon.code);
  const after = await fresh(coupon.id);
  assert.deepEqual([after.uses.counted, after.state, after.overLimit, after.excessCount], [4, "ACTIVE", false, 0]);

  const limitZero = await handleCouponCreate(data, AS_ADMIN, body({ maxUses: 0 }));
  assert.equal(limitZero.status, 400);
});

test("aplicabilidade: o formulário recebe o tipo; evento especial só entra quando selecionado", async () => {
  sequence += 1;
  const event = await call(
    `public.admin_create_event($1::uuid, $2::uuid, $3, 'Evento Painel', 'x', '{}'::jsonb, null, now() + interval '12 days', 210, 15000, 24)`,
    [ADMIN, SUNSET_CONCHA.base_id, `evento-painel-${sequence}`],
  );
  const options = await data.experiences(ADMIN);
  assert.equal(options.find((item) => item.id === event.experienceId)?.kind, "EVENT");
  assert.equal(options.find((item) => item.id === IMERSAO.id)?.kind, "REGULAR");
  await assert.rejects(data.experiences(INSTRUCTOR), /ADMIN_FORBIDDEN/);

  const selected = await created({ scope: "SELECTED", experienceIds: [IMERSAO.id, event.experienceId] });
  assert.deepEqual(selected.experiences.map((item) => item.kind).sort(), ["EVENT", "REGULAR"]);
  const allRegular = await created({ scope: "ALL_REGULAR" });
  assert.deepEqual(allRegular.experiences, []);

  const empty = await handleCouponCreate(data, AS_ADMIN, body({ scope: "SELECTED", experienceIds: [] }));
  assert.equal(empty.status, 400);
  const unknown = await handleCouponCreate(data, AS_ADMIN, body({ scope: "SELECTED", experienceIds: [crypto.randomUUID()] }));
  assert.equal(unknown.status, 400, "experiência inexistente é recusada pelo banco");
});

// ===========================================================================
// 4. Edição, concorrência, ativação e desativação
// ===========================================================================

test("edição antes do uso: tudo pode mudar e a auditoria guarda antes e depois", async () => {
  const coupon = await created({ percentOff: 10 });
  const result = await handleCouponUpdate(data, AS_ADMIN, coupon.id, editBody(coupon, { code: `${coupon.code}-B`, percentOff: 20, scope: "SELECTED", experienceIds: [IMERSAO.id], maxUses: 5, validUntil: "2027-01-31", description: "Nova" }));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const updated = result.body.coupon as AdminCoupon;
  assert.deepEqual([updated.code, updated.percentOff, updated.scope, updated.maxUses, updated.validUntil, updated.description], [`${coupon.code}-B`, 20, "SELECTED", 5, "2027-01-31", "Nova"]);
  const audit = await one(`select metadata from public.admin_audit_log where entity_id = $1::uuid and action = 'COUPON_UPDATED'`, [coupon.id]);
  assert.equal(audit.metadata.before.percentOff, 10);
  assert.equal(audit.metadata.after.percentOff, 20);
});

test("edição depois do uso: código, percentual e aplicabilidade bloqueados com mensagem por campo; datas, limite e descrição editáveis", async () => {
  const session = await regularSession();
  const coupon = await created({ maxUses: 5 });
  await bookWithCoupon(session, coupon.code);
  await bookWithCoupon(session, coupon.code);
  let current = await fresh(coupon.id);
  assert.equal(current.locked, true);
  assert.equal(current.uses.counted, 2);

  for (const [changes, field] of [
    [{ code: `${coupon.code}-X` }, "code"],
    [{ percentOff: 30 }, "percentOff"],
    [{ scope: "SELECTED", experienceIds: [IMERSAO.id] }, "experienceIds"],
  ] as const) {
    const result = await handleCouponUpdate(data, AS_ADMIN, coupon.id, editBody(current, changes));
    assert.equal(result.status, 409, field);
    assert.match(String((result.body.errors as Record<string, string>)[field]), /bloquead[oa]s? depois da primeira utilização/, field);
  }
  // O banco recusa do mesmo jeito, se a rota fosse contornada.
  await assert.rejects(data.update(ADMIN, coupon.id, { ...editBody(current, { percentOff: 30 }) } as never), /COUPON_LOCKED_FIELDS/);
  assert.equal((lockedFieldErrors(current, { code: current.code, percentOff: 30, scope: current.scope, experienceIds: [] }) as Record<string, string>).percentOff, "Percentual bloqueado depois da primeira utilização.");

  // Limite abaixo das utilizações contadas: recusado.
  const below = await handleCouponUpdate(data, AS_ADMIN, coupon.id, editBody(current, { maxUses: 1 }));
  assert.equal(below.status, 409);
  assert.ok((below.body.errors as Record<string, string>).maxUses);

  // Datas, limite (igual ou acima do uso) e descrição: aceitos.
  const ok = await handleCouponUpdate(data, AS_ADMIN, coupon.id, editBody(current, { maxUses: 2, validUntil: "2027-03-31", description: "Prorrogado" }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  current = await fresh(coupon.id);
  assert.deepEqual([current.maxUses, current.validUntil, current.description, current.code, current.percentOff], [2, "2027-03-31", "Prorrogado", coupon.code, coupon.percentOff]);
  const unlimited = await handleCouponUpdate(data, AS_ADMIN, coupon.id, editBody(current, { maxUses: null }));
  assert.equal(unlimited.status, 200);
});

test("edição concorrente: quem salva sobre uma versão velha recebe 409 e nada é sobrescrito", async () => {
  const coupon = await created({ description: "Original" });
  const first = await handleCouponUpdate(data, AS_ADMIN, coupon.id, editBody(coupon, { description: "Primeira pessoa" }));
  assert.equal(first.status, 200);
  // A segunda pessoa abriu o formulário antes da primeira salvar.
  const second = await handleCouponUpdate(data, AS_ADMIN, coupon.id, editBody(coupon, { description: "Segunda pessoa" }));
  assert.equal(second.status, 409);
  assert.equal(second.body.stale, true);
  assert.equal((await fresh(coupon.id)).description, "Primeira pessoa");
  // Status mudou no meio-tempo: a versão também muda, e a edição velha é recusada.
  const reopened = await fresh(coupon.id);
  await handleCouponStatus(data, AS_ADMIN, coupon.id, { status: "INACTIVE" });
  assert.equal((await handleCouponUpdate(data, AS_ADMIN, coupon.id, editBody(reopened, { description: "Velha" }))).status, 409);

  const missing = await handleCouponUpdate(data, AS_ADMIN, crypto.randomUUID(), editBody(coupon));
  assert.equal(missing.status, 404);
});

test("desativar: impede novas utilizações e preserva reservas, valores, usos e histórico; reativar volta a aceitar", async () => {
  const session = await regularSession();
  const coupon = await created({ percentOff: 10 });
  const pending = await bookWithCoupon(session, coupon.code, 2);
  const paid = await bookWithCoupon(session, coupon.code, 1);
  assert.equal(await pay(paid.reservationId, 6_300), true);
  const snapshot = async () => rows(
    `select r.id::text, r.status::text, r.unit_price_cents, r.total_cents, cr.original_total_cents, cr.discount_cents, cr.total_cents as charged
       from public.reservations r join public.coupon_redemptions cr on cr.reservation_id = r.id
      where cr.coupon_id = $1::uuid order by r.id`,
    [coupon.id],
  );
  const before = await snapshot();

  const off = await handleCouponStatus(data, AS_ADMIN, coupon.id, { status: "INACTIVE", reason: "Fim da campanha" });
  assert.equal(off.status, 200);
  assert.equal((off.body.coupon as AdminCoupon).state, "INACTIVE");
  assert.deepEqual(await snapshot(), before, "nenhuma reserva nem uso mudou");
  await assert.rejects(bookWithCoupon(session, coupon.code), /COUPON_INACTIVE/);
  // A pré-reserva feita antes ainda paga o valor com desconto gravado.
  assert.equal(await pay(pending.reservationId, 12_600), true);
  const detail = await fresh(coupon.id);
  assert.deepEqual([detail.uses.confirmed, detail.redemptions.length], [2, 2]);

  // Repetir o mesmo status não muda nada nem audita de novo.
  const audits = await auditCount(coupon.id, "COUPON_DEACTIVATED");
  assert.equal((await handleCouponStatus(data, AS_ADMIN, coupon.id, { status: "INACTIVE" })).status, 200);
  assert.equal(await auditCount(coupon.id, "COUPON_DEACTIVATED"), audits);
  const reason = await one(`select reason from public.admin_audit_log where entity_id = $1::uuid and action = 'COUPON_DEACTIVATED'`, [coupon.id]);
  assert.equal(reason.reason, "Fim da campanha");

  const on = await handleCouponStatus(data, AS_ADMIN, coupon.id, { status: "ACTIVE" });
  assert.equal(on.status, 200);
  assert.equal(await auditCount(coupon.id, "COUPON_ACTIVATED"), 1);
  assert.equal((await bookWithCoupon(session, coupon.code)).coupon.code, coupon.code);

  assert.equal((await handleCouponStatus(data, AS_ADMIN, coupon.id, { status: "PAUSED" })).status, 400);
  assert.equal((await handleCouponStatus(data, AS_ADMIN, crypto.randomUUID(), { status: "ACTIVE" })).status, 404);
});

// ===========================================================================
// 5. Histórico, liberação, alerta e consistência financeira
// ===========================================================================

test("histórico de utilizações: reserva, experiência, data, status e valores de cada uso", async () => {
  const session = await regularSession(7_000);
  const coupon = await created({ percentOff: 10 });
  const confirmed = await bookWithCoupon(session, coupon.code, 2);
  assert.equal(await pay(confirmed.reservationId, 12_600), true);
  const pending = await bookWithCoupon(session, coupon.code, 1);
  const lapsed = await bookWithCoupon(session, coupon.code, 1);
  await expire(lapsed.reservationId);

  const detail = await fresh(coupon.id);
  const byReservation = new Map(detail.redemptions.map((item) => [item.reservationId, item]));
  const row = byReservation.get(confirmed.reservationId)!;
  const session_ = await one(`select starts_at from public.sessions where id = $1::uuid`, [session]);
  assert.ok(row.publicCode);
  assert.equal(row.experienceTitle, IMERSAO.title ?? row.experienceTitle);
  assert.equal(new Date(row.startsAt!).getTime(), new Date(session_.starts_at).getTime());
  assert.deepEqual([row.state, row.quantity, row.originalTotalCents, row.discountCents, row.totalCents], ["CONFIRMED", 2, 14_000, 1_400, 12_600]);
  assert.equal(byReservation.get(pending.reservationId)?.state, "RESERVED");
  assert.equal(byReservation.get(lapsed.reservationId)?.state, "LAPSED");
  assert.deepEqual(detail.uses, { counted: 2, reserved: 1, confirmed: 1, cancelledAfterPayment: 0, released: 0, lapsed: 1 });
  assert.equal(canReleaseRedemption(row), false, "uso confirmado não é liberável");
});

test("liberação manual: só de reserva paga e cancelada, com justificativa e confirmação; repetir não libera de novo", async () => {
  const session = await regularSession();
  const coupon = await created({ maxUses: 1 });
  const booking = await bookWithCoupon(session, coupon.code, 1);
  let redemption = (await fresh(coupon.id)).redemptions[0];

  // Ainda reservada: não é liberável.
  const early = await handleCouponRelease(data, AS_ADMIN, redemption.id, { reason: "Tentativa", confirmed: true });
  assert.equal(early.status, 409);
  assert.match(String(early.body.message), /paga e depois cancelada/);

  assert.equal(await pay(booking.reservationId, 6_300), true);
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Reembolso')`, [ADMIN, booking.reservationId]);
  redemption = (await fresh(coupon.id)).redemptions[0];
  assert.equal(redemption.state, "CANCELLED_AFTER_PAYMENT");
  assert.equal(canReleaseRedemption(redemption), true);
  assert.equal((await fresh(coupon.id)).state, "EXHAUSTED", "o uso pago e cancelado ainda ocupa o limite");

  // Sem justificativa ou sem confirmação: recusado antes do banco.
  assert.equal((await handleCouponRelease(data, AS_ADMIN, redemption.id, { reason: "", confirmed: true })).status, 400);
  assert.equal((await handleCouponRelease(data, AS_ADMIN, redemption.id, { reason: "Reembolso integral" })).status, 400);

  const values = await one(`select unit_price_cents, total_cents, status::text from public.reservations where id = $1::uuid`, [booking.reservationId]);
  const released = await handleCouponRelease(data, AS_ADMIN, redemption.id, { reason: "Reembolso integral pelo WhatsApp", confirmed: true });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  const after = await fresh(coupon.id);
  assert.equal(after.redemptions[0].state, "RELEASED");
  assert.equal(after.redemptions[0].releasedReason, "Reembolso integral pelo WhatsApp");
  assert.equal(after.redemptions[0].releasedByName, "Admin Teste");
  assert.deepEqual([after.uses.counted, after.uses.released, after.state], [0, 1, "ACTIVE"]);
  assert.deepEqual(await one(`select unit_price_cents, total_cents, status::text from public.reservations where id = $1::uuid`, [booking.reservationId]), values, "a reserva não muda");
  const audit = await one(`select reason from public.admin_audit_log where entity_id = $1::uuid and action = 'COUPON_REDEMPTION_RELEASED'`, [coupon.id]);
  assert.equal(audit.reason, "Reembolso integral pelo WhatsApp");

  const again = await handleCouponRelease(data, AS_ADMIN, redemption.id, { reason: "De novo", confirmed: true });
  assert.equal(again.status, 409);
  assert.equal(again.body.replayed, true);
  assert.equal(await auditCount(coupon.id, "COUPON_REDEMPTION_RELEASED"), 1);
  assert.equal((await handleCouponRelease(data, AS_ADMIN, crypto.randomUUID(), { reason: "Inexistente", confirmed: true })).status, 404);
});

test("limite excedido: o alerta aparece com qualquer situação, no cupom, nos usos e no filtro", async () => {
  const session = await regularSession(7_000, 30);
  const coupon = await created({ maxUses: 1 });
  const late = await bookWithCoupon(session, coupon.code, 1);
  await expire(late.reservationId);
  const other = await bookWithCoupon(session, coupon.code, 1);
  assert.equal(await pay(other.reservationId, 6_300), true);
  await rows(`update public.reservations set confirmed_at = confirmed_at - interval '1 hour' where id = $1::uuid`, [other.reservationId]);
  assert.equal(await call(`public.reconcile_reservation_payment($1::uuid, 'INFINITEPAY', $2, 6300, '', '{}'::jsonb)`, [late.reservationId, `tx-tardio-painel-${late.reservationId}`]), "RECONCILED");

  const check = async (expectedState: string) => {
    const listed = (await data.list(OPERATOR)).find((item) => item.id === coupon.id)!;
    assert.deepEqual([listed.state, listed.overLimit, listed.excessCount], [expectedState, true, 1], expectedState);
    assert.deepEqual(filterCoupons([listed], { status: "OVER_LIMIT", query: "" }).map((item) => item.id), [coupon.id]);
    const detail = await fresh(coupon.id);
    assert.deepEqual(detail.redemptions.filter((item) => item.overLimit).map((item) => item.reservationId), [late.reservationId]);
    const report = await reportRow(coupon.code);
    assert.deepEqual([report.limite_excedido, Number(report.excedentes), report.situacao], [true, 1, expectedState]);
  };
  await check("EXHAUSTED");
  assert.equal((await handleCouponStatus(data, AS_ADMIN, coupon.id, { status: "INACTIVE" })).status, 200);
  await check("INACTIVE");
  await handleCouponStatus(data, AS_ADMIN, coupon.id, { status: "ACTIVE" });
  // Cupom em excesso continua editável: mantém o limite e muda a data para o passado.
  let current = await fresh(coupon.id);
  assert.equal((await handleCouponUpdate(data, AS_ADMIN, coupon.id, editBody(current, { validFrom: "2026-01-01", validUntil: "2026-01-31" }))).status, 200);
  await check("EXPIRED");
  current = await fresh(coupon.id);
  assert.equal((await handleCouponUpdate(data, AS_ADMIN, coupon.id, editBody(current, { validFrom: "2099-01-01", validUntil: null }))).status, 200);
  await check("SCHEDULED");
});

test("consistência financeira: receita e desconto só de usos confirmados, iguais ao relatório; pendente não é receita", async () => {
  const session = await regularSession(7_000, 30);
  const coupon = await created({ percentOff: 15 });
  const confirmedA = await bookWithCoupon(session, coupon.code, 2); // 2 × 5950 = 11900
  const confirmedB = await bookWithCoupon(session, coupon.code, 1); // 5950
  const pending = await bookWithCoupon(session, coupon.code, 3); // 17850, aguardando
  const cancelled = await bookWithCoupon(session, coupon.code, 1);
  const lapsed = await bookWithCoupon(session, coupon.code, 1);
  assert.equal(await pay(confirmedA.reservationId, 11_900), true);
  assert.equal(await pay(confirmedB.reservationId, 5_950), true);
  assert.equal(await pay(cancelled.reservationId, 5_950), true);
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Reembolso')`, [ADMIN, cancelled.reservationId]);
  await expire(lapsed.reservationId);
  void pending;

  const detail = await fresh(coupon.id);
  const money = couponFinancials(detail.redemptions);
  assert.deepEqual(money, { revenueConfirmedCents: 17_850, discountConfirmedCents: 3 * 1_050, pendingCount: 1, pendingTotalCents: 17_850 });
  const report = await reportRow(coupon.code);
  assert.equal(Number(report.receita_confirmada), money.revenueConfirmedCents);
  assert.equal(Number(report.desconto_confirmado), money.discountConfirmedCents);
  // Cada linha fecha: original − desconto = final, e final = valor da reserva.
  for (const item of detail.redemptions) {
    assert.equal(item.originalTotalCents - item.discountCents, item.totalCents);
    const reservation = await one(`select total_cents from public.reservations where id = $1::uuid`, [item.reservationId]);
    assert.equal(reservation.total_cents, item.totalCents, "o painel mostra o que a reserva cobra");
  }

  const fake = (state: AdminCouponRedemption["state"], total: number, discount: number) => ({ state, totalCents: total, discountCents: discount } as AdminCouponRedemption);
  assert.deepEqual(
    couponFinancials([fake("RESERVED", 100, 10), fake("CANCELLED_AFTER_PAYMENT", 200, 20), fake("RELEASED", 300, 30), fake("LAPSED", 400, 40)]),
    { revenueConfirmedCents: 0, discountConfirmedCents: 0, pendingCount: 1, pendingTotalCents: 100 },
  );
});

// ===========================================================================
// 6. Rotas, páginas, menu e o que não muda
// ===========================================================================

const ROUTES = [
  { path: "app/api/admin/coupons/route.ts", method: "POST", handler: "handleCouponCreate(", id: null },
  { path: "app/api/admin/coupons/[couponId]/route.ts", method: "PATCH", handler: "handleCouponUpdate(", id: "isCouponUuid(couponId)" },
  { path: "app/api/admin/coupons/[couponId]/status/route.ts", method: "POST", handler: "handleCouponStatus(", id: "isCouponUuid(couponId)" },
  { path: "app/api/admin/coupons/redemptions/[redemptionId]/release/route.ts", method: "POST", handler: "handleCouponRelease(", id: "isCouponUuid(redemptionId)" },
];

test("rotas: origem, depois variável/sessão/papel de gestão, id e corpo; ator da sessão; sem GET", () => {
  for (const route of ROUTES) {
    const text = code(route.path);
    const markers = ["isSameOriginRequest(request)", "authorizeCouponsApi({ manage: true })", ...(route.id ? [route.id] : []), route.handler];
    const order = markers.map((marker) => text.indexOf(marker));
    assert.ok(order.every((index) => index > 0), `${route.path} ${JSON.stringify(order)}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, route.path);
    assert.match(text, new RegExp(`export async function ${route.method}\\(`), route.path);
    assert.doesNotMatch(text, /export async function (GET|DELETE|PUT)/, route.path);
    assert.match(text, /authorization\.context\.profile/, `${route.path}: o ator vem da sessão`);
    assert.doesNotMatch(text, /body\.(userId|actor|role)/, route.path);
    assert.match(text, /"cache-control": "no-store"/, route.path);
    assert.doesNotMatch(text, /console\./, route.path);
  }
});

test("páginas: exigem admin, somem com a variável desligada; criar e editar só para ADMIN", () => {
  const pages = [
    "app/admin/marketing/cupons/page.tsx",
    "app/admin/marketing/cupons/novo/page.tsx",
    "app/admin/marketing/cupons/[couponId]/page.tsx",
    "app/admin/marketing/cupons/[couponId]/editar/page.tsx",
  ];
  for (const path of pages) {
    const page = code(path);
    const auth = page.indexOf("await requireAdmin()");
    assert.ok(auth >= 0 && auth < page.indexOf("if (!isCouponsAdminEnabled()) notFound();"), path);
    assert.doesNotMatch(page, /console\.(log|info|warn|error)/, path);
    assert.match(page, /couponAdminData\(\)/, path);
    assert.match(page, /context\.profile\.userId/, path);
  }
  assert.match(code("app/admin/marketing/cupons/novo/page.tsx"), /if \(!canManageCoupons\(context\.profile\.role\)\) redirect\("\/admin\/marketing\/cupons"\)/);
  assert.match(code("app/admin/marketing/cupons/[couponId]/editar/page.tsx"), /if \(!canManageCoupons\(context\.profile\.role\)\) redirect\(/);
  const list = code("app/admin/marketing/cupons/page.tsx");
  assert.match(list, /manager \? <Link href="\/admin\/marketing\/cupons\/novo"/);
  assert.match(list, /<CouponOverLimitBadge overLimit=\{coupon\.overLimit\}/, "o alerta aparece ao lado de qualquer situação");
  const detail = code("app/admin/marketing/cupons/[couponId]/page.tsx");
  assert.match(detail, /manager && canReleaseRedemption\(item\) \? <ReleaseRedemptionButton/);
  assert.match(detail, /manager \? \(\s*<div[^>]*>\s*<CouponStatusButton/);
  assert.match(detail, /couponFinancials\(coupon\.redemptions\)/);
  assert.match(detail, /não é receita/);
});

test("menu: Marketing → Cupons de desconto só existe com a variável ligada; o resto do menu não muda", () => {
  const shell = code("components/admin/admin-shell.tsx");
  assert.match(shell, /couponsEnabled \? \(/);
  assert.match(shell, /href: "\/admin\/marketing\/cupons", label: "Cupons de desconto"/);
  assert.match(shell, /couponsEnabled = false/);
  assert.match(code("app/admin/layout.tsx"), /couponsEnabled=\{isCouponsAdminEnabled\(\)\}/);
  // Os itens já existentes continuam iguais.
  assert.match(shell, /standbyEnabled\s*\?\s*\[item, \{ href: "\/admin\/stand-by"/);
  assert.match(shell, /waitlistEnabled\s*\n?\s*\?\s*\[item, \{ href: "\/admin\/lista-de-espera", label: "Lista de espera"/);
  assert.match(shell, /canManageTeam\(profile\.role\) \? \[\{ href: "\/admin\/equipe"/);
});

test("telas: liberação pede justificativa; formulário mostra campos bloqueados e normaliza o código", () => {
  const release = code("components/admin/coupons/release-redemption-button.tsx");
  assert.match(release, /requireReason/);
  assert.match(release, /JSON\.stringify\(\{ reason, confirmed: true \}\)/);
  const form = code("components/admin/coupons/coupon-form.tsx");
  assert.match(form, /disabled=\{locked\}/);
  assert.match(form, /Código, percentual e experiências elegíveis ficam bloqueados/);
  assert.match(form, /toUpperCase\(\)/);
  assert.match(form, /expectedUpdatedAt: coupon\?\.updatedAt/);
  assert.match(form, /Eventos especiais só recebem o cupom quando marcados aqui/);
  for (const path of ["lib/admin/coupons.ts", "lib/admin/coupons-data.ts", "lib/admin/coupons-server.ts", ...["coupon-form", "coupon-status-button", "release-redemption-button", "coupon-badges"].map((name) => `components/admin/coupons/${name}.tsx`)]) {
    assert.doesNotMatch(code(path), /console\.|NEXT_PUBLIC_COUPONS/, path);
  }
});

test("a fase 3 não traz migration, não liga variável e não toca o checkout público", () => {
  const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((file) => file.endsWith(".sql")).sort();
  assert.equal(migrations.at(-1), "202611020001_discount_coupons.sql", "nenhuma migration depois da fase 2");
  const example = source(".env.example");
  assert.doesNotMatch(example, /^COUPONS_/m, "as variáveis seguem comentadas");
  assert.doesNotMatch(source("vercel.json"), /COUPON/);
  // O checkout público continua sem cupom: nada fora do painel chama as funções de checkout.
  const publicFiles = ["app/api/reservations/route.ts", "lib/reservations/data.ts", "app/reservar/[sessionId]/page.tsx"].filter((path) => {
    try { source(path); return true; } catch { return false; }
  });
  assert.ok(publicFiles.length > 0);
  for (const path of publicFiles) {
    assert.doesNotMatch(code(path), /coupon|isCouponsCheckoutEnabled/i, path);
  }
  const data = code("lib/admin/coupons-data.ts");
  assert.doesNotMatch(data, /preview_coupon|create_pre_reservation_with_coupon|coupon_settings|isCouponsCheckoutEnabled/);
});
