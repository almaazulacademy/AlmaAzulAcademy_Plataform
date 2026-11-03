/**
 * Cupons de desconto — fase 2: banco e regras de negócio.
 *
 * Roda contra o Postgres em memória (PGlite) com **todas** as migrations. As
 * reservas passam pelos caminhos reais: `create_pre_reservation_with_coupon`
 * (que envolve a pré-reserva de sempre), confirmação, reconciliação, expiração,
 * cancelamento, troca de turma e Stand-by.
 *
 * O banco é um só para quase todo o arquivo: cada teste cria os próprios
 * cupons e turmas (preço próprio, para isolar o Stand-by) e confere o estado
 * deles. Migration, diagnósticos e rollback usam bancos novos.
 *
 * A disputa pelo último uso com sessões independentes do Postgres está em
 * `discount-coupons-concurrency.test.ts`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  couponAdminError,
  couponBreakdown,
  couponRejection,
  couponRejectionMessage,
  discountedUnitPriceCents,
  isValidCouponCode,
  normalizeCouponCode,
  validateCouponAdminInput,
} from "../lib/coupons/rules.ts";
import { isCouponsAdminEnabled, isCouponsCheckoutEnabled } from "../lib/coupons/flags.ts";
import { applyMigration, fullDatabase } from "./support/full-database.ts";
import { ADMIN, INSTRUCTOR, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

const MIGRATION = "202611020001_discount_coupons.sql";
const PREVIOUS = "202610310004_event_publication_security.sql";
const OPERATOR = "c0000000-0000-4000-8000-000000000004";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const db = await fullDatabase();
const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
const { one, rows, call, IMERSAO, SUNSET_CONCHA, makeSession, uniquePrice, setStandby, reschedule } = fx;

await rows(`insert into auth.users (id, email) values ($1::uuid, 'operador@teste.local') on conflict do nothing`, [OPERATOR]);
await rows(`insert into public.admin_users (user_id, display_name, role, is_active) values ($1::uuid, 'Operador Teste', 'OPERATOR', true) on conflict do nothing`, [OPERATOR]);

/** O mínimo de cobrança só é gravado depois de confirmado na InfinitePay; nos testes, R$ 1,00. */
async function setMinCharge(cents: number | null) {
  await rows(`update public.coupon_settings set min_charge_cents = $1`, [cents]);
}
await setMinCharge(100);

let sequence = 0;

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: Error) => {
    assert.match(error.message, pattern);
    return true;
  });
}

type CouponOptions = {
  code?: string;
  percent?: number;
  validFrom?: string | null;
  validUntil?: string | null;
  maxUses?: number | null;
  scope?: "ALL_REGULAR" | "SELECTED";
  experienceIds?: string[];
  status?: "ACTIVE" | "INACTIVE";
  description?: string | null;
  actor?: string;
};

function createCoupon(options: CouponOptions = {}) {
  sequence += 1;
  return call(
    `public.admin_create_coupon($1::uuid, $2, $3, $4::date, $5::date, $6, $7, $8::uuid[], $9, $10)`,
    [
      options.actor ?? ADMIN,
      options.code ?? `TESTE-${sequence}`,
      options.percent ?? 10,
      options.validFrom ?? null,
      options.validUntil ?? null,
      options.maxUses ?? null,
      options.scope ?? "ALL_REGULAR",
      options.experienceIds ?? [],
      options.status ?? "ACTIVE",
      options.description ?? null,
    ],
  );
}

function updateCoupon(id: string, coupon: Row, changes: Partial<CouponOptions> = {}) {
  return call(
    `public.admin_update_coupon($1::uuid, $2::uuid, $3, $4, $5::date, $6::date, $7, $8, $9::uuid[], $10)`,
    [
      changes.actor ?? ADMIN, id,
      changes.code ?? coupon.code,
      changes.percent ?? coupon.percentOff,
      "validFrom" in changes ? changes.validFrom : coupon.validFrom,
      "validUntil" in changes ? changes.validUntil : coupon.validUntil,
      "maxUses" in changes ? changes.maxUses : coupon.maxUses,
      changes.scope ?? coupon.scope,
      changes.experienceIds ?? coupon.experiences.map((item: Row) => item.id),
      "description" in changes ? changes.description : coupon.description,
    ],
  );
}

type Customer = { cpf: string; key: string };

function customer(): Customer {
  sequence += 1;
  return { cpf: String(70_000_000_000 + sequence), key: crypto.randomUUID() };
}

/** Pré-reserva pelo caminho com cupom. `code` nulo ou vazio não é aceito por ela: é o caminho sem cupom. */
function bookWithCoupon(sessionId: string, code: string, quantity = 2, who: Customer = customer()) {
  return call(
    `public.create_pre_reservation_with_coupon($1::uuid, $2, $3, $4, $5, $6, null, $7::uuid, $8)`,
    [sessionId, `Cliente Cupom ${who.cpf}`, who.cpf, `+55619${who.cpf.slice(-8)}`, `cupom${who.cpf}@teste.local`, quantity, who.key, code],
  );
}

function bookWithoutCoupon(sessionId: string, quantity = 2, who: Customer = customer()) {
  return call(
    `public.create_pre_reservation($1::uuid, $2, $3, $4, $5, $6, null, $7::uuid)`,
    [sessionId, `Cliente Sem Cupom ${who.cpf}`, who.cpf, `+55619${who.cpf.slice(-8)}`, `semcupom${who.cpf}@teste.local`, quantity, who.key],
  );
}

function pay(reservationId: string, amountCents: number, eventId = `tx-${reservationId}`) {
  return call(
    `public.confirm_reservation_payment($1::uuid, 'INFINITEPAY', $2, $3, 'https://recibo.teste/1', '{}'::jsonb)`,
    [reservationId, eventId, amountCents],
  );
}

function reservation(id: string) {
  return one(`select status::text as status, unit_price_cents, total_cents, quantity, confirmed_at, session_id from public.reservations where id = $1::uuid`, [id]);
}

function detail(couponId: string, actor = ADMIN) {
  return call(`public.admin_get_coupon($1::uuid, $2::uuid)`, [actor, couponId]);
}

async function uses(couponId: string) {
  return (await detail(couponId)).uses;
}

function preview(sessionId: string, quantity: number, code: string) {
  return call(`public.preview_coupon($1::uuid, $2, $3)`, [sessionId, quantity, code]);
}

async function expire(reservationId: string) {
  await rows(`update public.reservations set created_at = now() - interval '3 hours', expires_at = now() - interval '1 minute' where id = $1::uuid`, [reservationId]);
  await rows(`select public.expire_pre_reservations()`);
}

/** Uma turma regular aberta, com preço próprio (R$ 70,00 se nada for dito). */
function regularSession(price = 7_000, capacity = 10, experienceId = IMERSAO.id as string) {
  return makeSession(experienceId, { price, capacity });
}

/** Evento publicado, interruptor ligado e sessão aberta: o estado "à venda". */
async function onSaleEvent(price = 15_000) {
  sequence += 1;
  const created = await call(
    `public.admin_create_event($1::uuid, $2::uuid, $3, 'Evento Cupom', 'x', '{}'::jsonb, null, now() + interval '12 days', 210, $4, 24)`,
    [ADMIN, SUNSET_CONCHA.base_id, `evento-cupom-${sequence}`, price],
  );
  await rows(`update public.special_event_settings set publication_enabled = true`);
  await rows(`update public.experiences set status = 'PUBLISHED' where id = $1::uuid`, [created.experienceId]);
  await rows(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [created.sessionId]);
  return { experienceId: created.experienceId as string, sessionId: created.sessionId as string };
}

const todayBrasilia = async () => (await one(`select public.coupon_today()::text as d`)).d as string;
const shiftDays = async (days: number) => (await one(`select (public.coupon_today() + $1::int)::text as d`, [days])).d as string;

// ===========================================================================
// 1. Cálculo e arredondamento
// ===========================================================================

test("cálculo: desconto por participante, meio centavo para cima; total = quantidade × unitário final", () => {
  assert.deepEqual(couponBreakdown(7_000, 10, 2), {
    quantity: 2, percentOff: 10, originalUnitPriceCents: 7_000, unitPriceCents: 6_300,
    originalTotalCents: 14_000, discountCents: 1_400, totalCents: 12_600,
  });
  // 6990 × 15% = 1048,5 → 1049 de desconto por pessoa.
  assert.equal(discountedUnitPriceCents(6_990, 15), 5_941);
  assert.deepEqual(couponBreakdown(6_990, 15, 3), {
    quantity: 3, percentOff: 15, originalUnitPriceCents: 6_990, unitPriceCents: 5_941,
    originalTotalCents: 20_970, discountCents: 3_147, totalCents: 17_823,
  });
  assert.equal(discountedUnitPriceCents(15_000, 99), 150);
  assert.equal(discountedUnitPriceCents(1, 99), 0, "o banco recusa unitário zero (COUPON_BELOW_MIN_CHARGE)");
  for (const [unit, percent, quantity] of [[7_000, 10, 1], [6_990, 33, 7], [15_000, 99, 6], [101, 50, 20]]) {
    const value = couponBreakdown(unit, percent, quantity);
    assert.equal(value.totalCents, value.unitPriceCents * value.quantity);
    assert.equal(value.discountCents, value.originalTotalCents - value.totalCents);
    assert.ok(value.discountCents >= 0 && value.totalCents >= 0);
  }
});

test("cálculo: o banco e lib/coupons dão o mesmo unitário para qualquer preço e percentual", async () => {
  const cases: Array<[number, number]> = [];
  for (const unit of [1, 2, 49, 50, 51, 99, 100, 101, 999, 4_990, 6_990, 7_000, 12_345, 15_000, 99_999]) {
    for (let percent = 1; percent <= 99; percent += 7) cases.push([unit, percent]);
    cases.push([unit, 99]);
  }
  const result = await rows(
    `select u, p, public.coupon_discounted_unit_cents(u, p) as v from unnest($1::int[], $2::int[]) as t(u, p)`,
    [cases.map(([unit]) => unit), cases.map(([, percent]) => percent)],
  );
  for (const row of result) assert.equal(row.v, discountedUnitPriceCents(row.u, row.p), `${row.u} com ${row.p}%`);
});

test("código: maiúsculas, sem espaços nas pontas, 3 a 32 de A–Z, 0–9 e hífen", () => {
  assert.equal(normalizeCouponCode("  almaazul10 \n"), "ALMAAZUL10");
  for (const code of ["ALMAAZUL10", "CAPSULA-15", "A1B", "X".repeat(32)]) assert.equal(isValidCouponCode(code), true, code);
  for (const code of ["AB", "X".repeat(33), "ALMA AZUL", "CUPOM_10", "AÇAÍ", "---", ""]) assert.equal(isValidCouponCode(normalizeCouponCode(code)), false, code);
});

test("mensagens: cada recusa do banco vira o texto do cliente", () => {
  assert.equal(couponRejection("COUPON_EXHAUSTED"), "COUPON_EXHAUSTED");
  assert.equal(couponRejectionMessage(couponRejection('ERROR: COUPON_NOT_FOUND')!), "Cupom não encontrado.");
  assert.equal(couponRejectionMessage("COUPON_EXPIRED"), "Cupom expirado.");
  assert.equal(couponRejectionMessage("COUPON_INACTIVE"), "Cupom inativo.");
  assert.equal(couponRejectionMessage("COUPON_NOT_ELIGIBLE"), "Cupom não disponível para esta experiência.");
  assert.equal(couponRejection("INSUFFICIENT_SPOTS"), null);
  assert.equal(couponAdminError('duplicate key value violates unique constraint "coupons_code_key"').status, 409);
  assert.equal(couponAdminError("COUPON_LOCKED_FIELDS").status, 409);
});

test("interruptores: os dois nascem desligados", () => {
  assert.equal(isCouponsAdminEnabled({}), false);
  assert.equal(isCouponsCheckoutEnabled({}), false);
  assert.equal(isCouponsCheckoutEnabled({ COUPONS_CHECKOUT_ENABLED: "1" }), false);
  assert.equal(isCouponsAdminEnabled({ COUPONS_ADMIN_ENABLED: "true" }), true);
  const example = source(".env.example");
  assert.match(example, /^# COUPONS_ADMIN_ENABLED=true$/m);
  assert.match(example, /^# COUPONS_CHECKOUT_ENABLED=true$/m);
  assert.doesNotMatch(example, /^COUPONS_/m);
});

test("formulário do painel: regras por campo", () => {
  const ok = validateCouponAdminInput({ code: " capsula15 ", percentOff: 15, validFrom: "", validUntil: "2026-11-30", maxUses: 10, scope: "ALL_REGULAR", experienceIds: [], status: "ACTIVE", description: "  Campanha  " });
  assert.equal(ok.success, true);
  if (ok.success) assert.deepEqual(ok.data, { code: "CAPSULA15", percentOff: 15, validFrom: null, validUntil: "2026-11-30", maxUses: 10, scope: "ALL_REGULAR", experienceIds: [], status: "ACTIVE", description: "Campanha" });
  const bad = validateCouponAdminInput({ code: "x", percentOff: 100, validFrom: "2026-12-01", validUntil: "2026-11-30", maxUses: 0, scope: "SELECTED", experienceIds: [], status: "ON" });
  assert.equal(bad.success, false);
  if (!bad.success) assert.deepEqual(Object.keys(bad.errors).sort(), ["code", "experienceIds", "maxUses", "percentOff", "status", "validUntil"]);
  const invalidDate = validateCouponAdminInput({ code: "ABC", percentOff: 5, validUntil: "2026-02-30", scope: "ALL_REGULAR", status: "ACTIVE" });
  assert.equal(invalidDate.success, false);
});

// ===========================================================================
// 2. Checkout: cupom válido, recusas e reserva sem cupom
// ===========================================================================

test("válido: 2 participantes a R$ 70,00 com 10% → R$ 126,00 na reserva e no cupom", async () => {
  const session = await regularSession();
  const coupon = await createCoupon({ code: "almaazul10-a", percent: 10 });
  assert.equal(coupon.code, "ALMAAZUL10-A");

  const shown = await preview(session, 2, " almaazul10-a ");
  assert.deepEqual(shown, { ok: true, code: "ALMAAZUL10-A", percentOff: 10, quantity: 2, originalUnitPriceCents: 7_000, unitPriceCents: 6_300, originalTotalCents: 14_000, discountCents: 1_400, totalCents: 12_600 });

  const created = await bookWithCoupon(session, "almaazul10-a", 2);
  assert.equal(created.totalCents, 12_600);
  assert.deepEqual(created.coupon, { code: "ALMAAZUL10-A", percentOff: 10, quantity: 2, originalUnitPriceCents: 7_000, unitPriceCents: 6_300, originalTotalCents: 14_000, discountCents: 1_400, totalCents: 12_600 });
  const stored = await reservation(created.reservationId);
  assert.equal(stored.status, "PRE_RESERVED");
  assert.equal(stored.unit_price_cents, 6_300);
  assert.equal(stored.total_cents, 12_600, "total_cents é o valor cobrado: quantidade × unitário com desconto");
  assert.deepEqual(await uses(coupon.id), { counted: 1, reserved: 1, confirmed: 0, cancelledAfterPayment: 0, released: 0, lapsed: 0 });
});

test("vários participantes: 6 pessoas, 15% sobre R$ 69,90", async () => {
  const session = await regularSession(6_990);
  const coupon = await createCoupon({ percent: 15 });
  const created = await bookWithCoupon(session, coupon.code, 6);
  assert.equal(created.coupon.unitPriceCents, 5_941);
  assert.equal(created.totalCents, 6 * 5_941);
  assert.equal(created.coupon.discountCents, 6 * (6_990 - 5_941));
  assert.equal((await reservation(created.reservationId)).quantity, 6);
});

test("recusas: inexistente, inativo, expirado, ainda não válido, esgotado e não elegível — nada é criado", async () => {
  const session = await regularSession();
  const count = async () => Number((await one(`select count(*) as n from public.reservations where session_id = $1::uuid`, [session])).n);

  const inactive = await createCoupon({ status: "INACTIVE" });
  const expired = await createCoupon({ validFrom: await shiftDays(-10), validUntil: await shiftDays(-1) });
  const future = await createCoupon({ validFrom: await shiftDays(1) });
  const otherExperience = await createCoupon({ scope: "SELECTED", experienceIds: [SUNSET_CONCHA.id] });
  const exhausted = await createCoupon({ maxUses: 1 });
  await bookWithCoupon(session, exhausted.code, 1);

  const before = await count();
  for (const [code, reason] of [
    ["NAO-EXISTE", "COUPON_NOT_FOUND"],
    [inactive.code, "COUPON_INACTIVE"],
    [expired.code, "COUPON_EXPIRED"],
    [future.code, "COUPON_NOT_STARTED"],
    [otherExperience.code, "COUPON_NOT_ELIGIBLE"],
    [exhausted.code, "COUPON_EXHAUSTED"],
  ]) {
    assert.deepEqual(await preview(session, 1, code), { ok: false, reason }, code);
    const who = customer();
    await rejects(bookWithCoupon(session, code, 1, who), new RegExp(reason));
    // A recusa desfaz tudo: a mesma chave continua livre para seguir sem cupom.
    const plain = await bookWithoutCoupon(session, 1, who);
    assert.equal(plain.totalCents, 7_000);
    await call(`public.cancel_pre_reservation($1::uuid)`, [plain.reservationId]);
  }
  assert.equal(await count(), before + 6, "só as seis reservas sem cupom, nenhuma com desconto");
  assert.equal((await uses(exhausted.id)).counted, 1);
});

test("validade pela data da compra em Brasília: hoje é o último dia e o primeiro dia", async () => {
  const session = await regularSession();
  const today = await todayBrasilia();
  const lastDay = await createCoupon({ validUntil: today });
  const firstDay = await createCoupon({ validFrom: today });
  assert.equal((await preview(session, 1, lastDay.code)).ok, true);
  assert.equal((await preview(session, 1, firstDay.code)).ok, true);
  assert.equal((await detail(lastDay.id)).state, "ACTIVE");
});

test("sem cupom: a pré-reserva de sempre não passa por cupom nenhum", async () => {
  const session = await regularSession();
  const before = Number((await one(`select count(*) as n from public.coupon_redemptions`)).n);
  const created = await bookWithoutCoupon(session, 3);
  assert.equal(created.totalCents, 21_000);
  assert.equal("coupon" in created, false, "a resposta da RPC de sempre não muda");
  const stored = await reservation(created.reservationId);
  assert.equal(stored.unit_price_cents, 7_000);
  assert.equal(await pay(created.reservationId, 21_000), true);
  assert.equal(Number((await one(`select count(*) as n from public.coupon_redemptions`)).n), before);
});

test("100%: fora da primeira versão — o painel e a tabela recusam", async () => {
  await rejects(createCoupon({ percent: 100 }), /COUPON_INVALID_PERCENT/);
  await rejects(createCoupon({ percent: 0 }), /COUPON_INVALID_PERCENT/);
  await rejects(db.query(`insert into public.coupons (code, percent_off) values ('CEM-POR-CENTO', 100)`), /coupons_percent_range/);
});

test("valor mínimo: sem mínimo confirmado nenhum cupom é aplicado; abaixo do mínimo, recusa", async () => {
  const session = await regularSession(1_000);
  const coupon = await createCoupon({ percent: 95 });
  await setMinCharge(null);
  try {
    assert.deepEqual(await preview(session, 1, coupon.code), { ok: false, reason: "COUPON_UNAVAILABLE" });
    await rejects(bookWithCoupon(session, coupon.code, 1), /COUPON_UNAVAILABLE/);
  } finally {
    await setMinCharge(100);
  }
  // R$ 10,00 com 95% → R$ 0,50 por pessoa: uma pessoa fica abaixo de R$ 1,00, duas chegam a R$ 1,00.
  assert.deepEqual(await preview(session, 1, coupon.code), { ok: false, reason: "COUPON_BELOW_MIN_CHARGE" });
  await rejects(bookWithCoupon(session, coupon.code, 1), /COUPON_BELOW_MIN_CHARGE/);
  assert.equal((await bookWithCoupon(session, coupon.code, 2)).totalCents, 100);
  assert.equal((await uses(coupon.id)).counted, 1, "a tentativa recusada não deixou uso");
});

test("código sem diferença de maiúsculas: duplicado é recusado, e o cliente pode digitar em minúsculas", async () => {
  await createCoupon({ code: "COMUNIDADE-T" });
  await rejects(createCoupon({ code: "comunidade-t" }), /COUPON_CODE_TAKEN/);
  const session = await regularSession();
  assert.equal((await bookWithCoupon(session, "Comunidade-T", 1)).coupon.code, "COMUNIDADE-T");
});

// ===========================================================================
// 3. Eventos especiais
// ===========================================================================

test("evento: cupom de todas as regulares não alcança evento; só quando o evento é selecionado", async () => {
  const event = await onSaleEvent();
  const regular = await createCoupon({ percent: 20 });
  assert.deepEqual(await preview(event.sessionId, 1, regular.code), { ok: false, reason: "COUPON_NOT_ELIGIBLE" });
  await rejects(bookWithCoupon(event.sessionId, regular.code, 1), /COUPON_NOT_ELIGIBLE/);

  assert.equal(await call(`public.coupon_field_visible($1::uuid)`, [event.sessionId]), false, "evento sem cupom: campo oculto");
  assert.equal(await call(`public.coupon_field_visible($1::uuid)`, [await regularSession()]), true, "regular: campo sempre visível");
  assert.equal(await call(`public.coupon_field_visible($1::uuid)`, [crypto.randomUUID()]), false);

  const selected = await createCoupon({ scope: "SELECTED", experienceIds: [event.experienceId], percent: 10 });
  assert.equal(await call(`public.coupon_field_visible($1::uuid)`, [event.sessionId]), true);
  const created = await bookWithCoupon(event.sessionId, selected.code, 2);
  assert.equal(created.totalCents, 2 * 13_500);
  await call(`public.admin_set_coupon_status($1::uuid, $2::uuid, 'INACTIVE', 'fim da campanha')`, [ADMIN, selected.id]);
  assert.equal(await call(`public.coupon_field_visible($1::uuid)`, [event.sessionId]), false);
});

// ===========================================================================
// 4. Pagamento: confirmação, webhook repetido, manipulação e expiração
// ===========================================================================

test("pagamento: confirma pelo valor com desconto; webhook repetido não muda nada", async () => {
  const session = await regularSession();
  const coupon = await createCoupon({ maxUses: 5 });
  const created = await bookWithCoupon(session, coupon.code, 2);
  assert.equal(await pay(created.reservationId, 12_600, "tx-repetido"), true);
  assert.equal(await pay(created.reservationId, 12_600, "tx-repetido"), true);
  assert.equal(await pay(created.reservationId, 12_600, "tx-outro"), true);
  assert.equal((await reservation(created.reservationId)).status, "CONFIRMED");
  assert.deepEqual(await uses(coupon.id), { counted: 1, reserved: 0, confirmed: 1, cancelledAfterPayment: 0, released: 0, lapsed: 0 });
  assert.equal(Number((await one(`select count(*) as n from public.coupon_redemptions where reservation_id = $1::uuid`, [created.reservationId])).n), 1);
});

test("manipulação: o valor vem do banco — o preço cheio não confirma, nem um centavo a menos", async () => {
  const session = await regularSession();
  const coupon = await createCoupon();
  const created = await bookWithCoupon(session, coupon.code, 2);
  assert.equal(await pay(created.reservationId, 12_599, "tx-menos"), false);
  assert.equal(await pay(created.reservationId, 14_000, "tx-cheio"), false, "a RPC exige igualdade com total_cents");
  assert.equal((await reservation(created.reservationId)).status, "PRE_RESERVED");
  assert.equal(await pay(created.reservationId, 12_600, "tx-certo"), true);
  // A RPC não tem parâmetro de valor, percentual ou limite: o cliente só manda o código.
  const args = (await one(`select pg_get_function_identity_arguments('public.create_pre_reservation_with_coupon'::regproc) as a`)).a as string;
  assert.doesNotMatch(args, /cents|percent|amount|price|total/i);
});

test("expirada ou cancelada sem pagamento: o uso volta; pré-reserva válida segura o uso", async () => {
  const session = await regularSession();
  const coupon = await createCoupon({ maxUses: 1 });
  const first = await bookWithCoupon(session, coupon.code, 1);
  await rejects(bookWithCoupon(session, coupon.code, 1), /COUPON_EXHAUSTED/);

  // A janela de segurança empurra expires_at: enquanto ela vale, o uso continua preso.
  await rows(`update public.reservations set expires_at = now() + interval '20 minutes' where id = $1::uuid`, [first.reservationId]);
  await rejects(bookWithCoupon(session, coupon.code, 1), /COUPON_EXHAUSTED/);

  await expire(first.reservationId);
  assert.equal((await reservation(first.reservationId)).status, "EXPIRED");
  assert.deepEqual(await uses(coupon.id), { counted: 0, reserved: 0, confirmed: 0, cancelledAfterPayment: 0, released: 0, lapsed: 1 });

  const second = await bookWithCoupon(session, coupon.code, 1);
  await call(`public.cancel_pre_reservation($1::uuid)`, [second.reservationId]);
  assert.equal((await uses(coupon.id)).counted, 0);
  assert.equal((await bookWithCoupon(session, coupon.code, 1)).coupon.code, coupon.code);
});

test("pagamento tardio acima do limite: confirma, mas o cupom e o uso aparecem como excedidos", async () => {
  const session = await regularSession();
  const coupon = await createCoupon({ maxUses: 1 });
  const late = await bookWithCoupon(session, coupon.code, 1);
  await expire(late.reservationId);
  const other = await bookWithCoupon(session, coupon.code, 1);
  assert.equal(await pay(other.reservationId, 6_300, "tx-outro-cliente"), true);
  // O relógio do PGlite tem resolução de milissegundo: separa as duas confirmações no tempo.
  await rows(`update public.reservations set confirmed_at = confirmed_at - interval '1 minute' where id = $1::uuid`, [other.reservationId]);

  // O primeiro cliente tinha pago; a reconciliação recupera porque ainda há vaga.
  assert.equal(await call(`public.reconcile_reservation_payment($1::uuid, 'INFINITEPAY', 'tx-tardio', 6300, '', '{}'::jsonb)`, [late.reservationId]), "RECONCILED");
  assert.equal((await reservation(late.reservationId)).status, "CONFIRMED");

  const shown = await detail(coupon.id);
  assert.equal(shown.state, "OVER_LIMIT");
  assert.equal(shown.uses.counted, 2);
  const flagged = shown.redemptions.filter((item: Row) => item.overLimit).map((item: Row) => item.reservationId);
  assert.deepEqual(flagged, [late.reservationId], "o uso confirmado por último é o que passou do limite");
  const listed = (await call(`public.admin_list_coupons($1::uuid)`, [OPERATOR])).find((item: Row) => item.id === coupon.id);
  assert.equal(listed.state, "OVER_LIMIT");
  await rejects(bookWithCoupon(session, coupon.code, 1), /COUPON_EXHAUSTED/);
});

// ===========================================================================
// 5. Idempotência
// ===========================================================================

test("idempotência: repetir a mesma tentativa devolve a mesma reserva e não aplica desconto de novo", async () => {
  const session = await regularSession();
  const coupon = await createCoupon({ maxUses: 3 });
  const who = customer();
  const first = await bookWithCoupon(session, coupon.code, 2, who);
  const again = await bookWithCoupon(session, coupon.code, 2, who);
  assert.equal(again.reservationId, first.reservationId);
  assert.equal(again.totalCents, 12_600);
  assert.deepEqual(again.coupon, first.coupon);
  assert.equal((await reservation(first.reservationId)).unit_price_cents, 6_300, "o desconto não é aplicado duas vezes");
  assert.equal((await uses(coupon.id)).counted, 1);

  // Outro código, ou nenhum, com a mesma chave: a reserva já gravada, como está.
  const other = await createCoupon({ percent: 50 });
  const replay = await bookWithCoupon(session, other.code, 2, who);
  assert.equal(replay.reservationId, first.reservationId);
  assert.equal(replay.coupon.code, coupon.code);
  assert.equal((await uses(other.id)).counted, 0);

  // A chave usada sem cupom continua sem cupom.
  const plainWho = customer();
  const plain = await bookWithoutCoupon(session, 1, plainWho);
  const plainReplay = await bookWithCoupon(session, coupon.code, 1, plainWho);
  assert.equal(plainReplay.reservationId, plain.reservationId);
  assert.equal(plainReplay.coupon, null);
  assert.equal(plainReplay.totalCents, 7_000);

  // Mesma chave com outro CPF: o conflito de sempre.
  await rejects(bookWithCoupon(session, coupon.code, 2, { cpf: customer().cpf, key: who.key }), /IDEMPOTENCY_CONFLICT/);
});

// ===========================================================================
// 6. Reagendamento, Stand-by e cancelamento
// ===========================================================================

test("troca de turma pelo painel: o valor pago com desconto fica, nada é cobrado de novo", async () => {
  const price = uniquePrice();
  const origin = await regularSession(price);
  const destination = await regularSession(price + 2_000);
  const coupon = await createCoupon({ percent: 10 });
  const created = await bookWithCoupon(origin, coupon.code, 2);
  const paid = created.totalCents;
  assert.equal(await pay(created.reservationId, paid), true);
  const eventsBefore = Number((await one(`select count(*) as n from public.payment_events where reservation_id = $1::uuid`, [created.reservationId])).n);

  await call(`public.admin_change_reservation_session($1::uuid, $2::uuid, $3::uuid, 'Cliente pediu outra data')`, [ADMIN, created.reservationId, destination]);
  const moved = await reservation(created.reservationId);
  assert.equal(moved.session_id, destination);
  assert.equal(moved.total_cents, paid);
  assert.equal(Number((await one(`select count(*) as n from public.payment_events where reservation_id = $1::uuid`, [created.reservationId])).n), eventsBefore);
  assert.deepEqual((await one(`select public.coupon_reservation_summary($1::uuid) as s`, [created.reservationId])).s, created.coupon);
});

test("Stand-by: a régua de preço usa o preço de lista; o desconto é preservado", async () => {
  const price = uniquePrice();
  const origin = await regularSession(price);
  const discounted = discountedUnitPriceCents(price, 20);
  const sameList = await regularSession(price, 10, SUNSET_CONCHA.id);
  const atDiscountPrice = await regularSession(discounted, 10, SUNSET_CONCHA.id);
  const coupon = await createCoupon({ percent: 20 });
  const created = await bookWithCoupon(origin, coupon.code, 2);
  assert.equal(await pay(created.reservationId, created.totalCents), true);
  await setStandby(created.reservationId);

  const panel = await call(`public.admin_standby_reschedule_options($1::uuid, $2::uuid)`, [ADMIN, created.reservationId]);
  const offered = (panel.options as Row[]).map((item) => item.sessionId);
  assert.ok(offered.includes(sameList), "turma com o mesmo preço de lista é oferecida");
  assert.ok(!offered.includes(atDiscountPrice), "turma com o preço do unitário descontado não é");
  assert.equal(await call(`public.reservation_standby_target_rejection($1::uuid, $2::uuid, 'CUSTOMER')`, [created.reservationId, atDiscountPrice]), "PRICE_NOT_ELIGIBLE");

  const resolution = await reschedule(created.reservationId, sameList);
  assert.equal(resolution.status ?? "CONFIRMED", "CONFIRMED");
  const after = await reservation(created.reservationId);
  assert.equal(after.status, "CONFIRMED");
  assert.equal(after.session_id, sameList);
  assert.equal(after.unit_price_cents, discounted);
  assert.equal(after.total_cents, created.totalCents);
  assert.equal((await uses(coupon.id)).confirmed, 1);
});

test("Stand-by sem cupom: a régua continua a de antes", async () => {
  const price = uniquePrice();
  const origin = await regularSession(price);
  const same = await regularSession(price, 10, SUNSET_CONCHA.id);
  const different = await regularSession(price + 100, 10, SUNSET_CONCHA.id);
  const created = await bookWithoutCoupon(origin, 2);
  assert.equal(await pay(created.reservationId, created.totalCents), true);
  await setStandby(created.reservationId);
  assert.equal(await call(`public.reservation_standby_target_rejection($1::uuid, $2::uuid, 'CUSTOMER')`, [created.reservationId, same]), null);
  assert.equal(await call(`public.reservation_standby_target_rejection($1::uuid, $2::uuid, 'CUSTOMER')`, [created.reservationId, different]), "PRICE_NOT_ELIGIBLE");
});

test("cancelamento depois do pagamento: o uso continua contado até a liberação manual do ADMIN", async () => {
  const session = await regularSession();
  const coupon = await createCoupon({ maxUses: 1 });
  const created = await bookWithCoupon(session, coupon.code, 1);
  assert.equal(await pay(created.reservationId, created.totalCents), true);
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Reembolso pedido pelo WhatsApp')`, [ADMIN, created.reservationId]);
  assert.deepEqual(await uses(coupon.id), { counted: 1, reserved: 0, confirmed: 0, cancelledAfterPayment: 1, released: 0, lapsed: 0 });
  await rejects(bookWithCoupon(session, coupon.code, 1), /COUPON_EXHAUSTED/);

  const [redemption] = (await detail(coupon.id)).redemptions;
  await rejects(call(`public.admin_release_coupon_redemption($1::uuid, $2::uuid, 'ok')`, [OPERATOR, redemption.id]), /COUPON_ADMIN_FORBIDDEN/);
  await rejects(call(`public.admin_release_coupon_redemption($1::uuid, $2::uuid, '  ')`, [ADMIN, redemption.id]), /REASON_REQUIRED/);
  const released = await call(`public.admin_release_coupon_redemption($1::uuid, $2::uuid, 'Reembolso integral feito')`, [ADMIN, redemption.id]);
  assert.deepEqual(released, { redemptionId: redemption.id, state: "RELEASED", replayed: false });
  assert.equal((await call(`public.admin_release_coupon_redemption($1::uuid, $2::uuid, 'de novo')`, [ADMIN, redemption.id])).replayed, true);

  const after = await detail(coupon.id);
  assert.equal(after.uses.counted, 0);
  assert.equal(after.redemptions[0].releasedReason, "Reembolso integral feito");
  assert.equal(after.redemptions[0].releasedByName, "Admin Teste");
  assert.equal(after.redemptions[0].totalCents, 6_300, "o histórico financeiro fica");
  const audit = await one(`select reason, metadata from public.admin_audit_log where action = 'COUPON_REDEMPTION_RELEASED' and entity_id = $1::uuid`, [coupon.id]);
  assert.equal(audit.reason, "Reembolso integral feito");
  assert.equal(audit.metadata.reservation_id, created.reservationId);
  assert.equal((await bookWithCoupon(session, coupon.code, 1)).coupon.code, coupon.code);
});

test("liberação: nunca de um uso reservado ou confirmado", async () => {
  const session = await regularSession();
  const coupon = await createCoupon();
  const pending = await bookWithCoupon(session, coupon.code, 1);
  const confirmed = await bookWithCoupon(session, coupon.code, 1);
  await pay(confirmed.reservationId, confirmed.totalCents);
  for (const item of (await detail(coupon.id)).redemptions) {
    await rejects(call(`public.admin_release_coupon_redemption($1::uuid, $2::uuid, 'tentativa')`, [ADMIN, item.id]), /COUPON_RELEASE_NOT_ALLOWED/);
  }
  assert.equal((await uses(coupon.id)).counted, 2);
  void pending;
});

// ===========================================================================
// 7. Painel: permissões, travas, limite e auditoria
// ===========================================================================

test("permissões: ADMIN cria e edita; OPERATOR só consulta; instrutor e desconhecido nada", async () => {
  const coupon = await createCoupon();
  for (const actor of [OPERATOR, INSTRUCTOR, crypto.randomUUID()]) {
    await rejects(createCoupon({ actor }), /COUPON_ADMIN_FORBIDDEN/);
    await rejects(updateCoupon(coupon.id, coupon, { actor, percent: 20 }), /COUPON_ADMIN_FORBIDDEN/);
    await rejects(call(`public.admin_set_coupon_status($1::uuid, $2::uuid, 'INACTIVE', null)`, [actor, coupon.id]), /COUPON_ADMIN_FORBIDDEN/);
  }
  assert.equal((await detail(coupon.id, OPERATOR)).code, coupon.code);
  assert.ok((await call(`public.admin_list_coupons($1::uuid)`, [OPERATOR])).length >= 1);
  await rejects(call(`public.admin_list_coupons($1::uuid)`, [INSTRUCTOR]), /ADMIN_FORBIDDEN/);
  await rejects(detail(coupon.id, INSTRUCTOR), /ADMIN_FORBIDDEN/);
});

test("edição antes do primeiro uso: tudo muda; depois, código, percentual e aplicabilidade travam", async () => {
  const coupon = await createCoupon({ percent: 10 });
  const edited = await updateCoupon(coupon.id, coupon, { code: `${coupon.code}-B`, percent: 12, scope: "SELECTED", experienceIds: [IMERSAO.id], description: "Campanha de novembro" });
  assert.equal(edited.code, `${coupon.code}-B`);
  assert.equal(edited.percentOff, 12);
  assert.equal(edited.locked, false);

  await bookWithCoupon(await regularSession(), edited.code, 1);
  const locked = await detail(coupon.id);
  assert.equal(locked.locked, true);
  await rejects(updateCoupon(coupon.id, locked, { code: "OUTRO-CODIGO" }), /COUPON_LOCKED_FIELDS/);
  await rejects(updateCoupon(coupon.id, locked, { percent: 30 }), /COUPON_LOCKED_FIELDS/);
  await rejects(updateCoupon(coupon.id, locked, { scope: "ALL_REGULAR", experienceIds: [] }), /COUPON_LOCKED_FIELDS/);
  await rejects(updateCoupon(coupon.id, locked, { experienceIds: [IMERSAO.id, SUNSET_CONCHA.id] }), /COUPON_LOCKED_FIELDS/);

  const later = await updateCoupon(coupon.id, locked, { validUntil: await shiftDays(30), maxUses: 50, description: null });
  assert.equal(later.maxUses, 50);
  assert.equal(later.description, null);
  assert.equal(later.percentOff, 12);
});

test("limite: nunca abaixo dos usos que já contam; ilimitado sempre pode", async () => {
  const session = await regularSession();
  const coupon = await createCoupon({ maxUses: 5 });
  const paid = await bookWithCoupon(session, coupon.code, 1);
  await pay(paid.reservationId, paid.totalCents);
  await bookWithCoupon(session, coupon.code, 1);
  const current = await detail(coupon.id);
  assert.equal(current.uses.counted, 2);
  await rejects(updateCoupon(coupon.id, current, { maxUses: 1 }), /COUPON_LIMIT_BELOW_USAGE/);
  assert.equal((await updateCoupon(coupon.id, current, { maxUses: 2 })).state, "EXHAUSTED");
  assert.equal((await updateCoupon(coupon.id, current, { maxUses: null })).maxUses, null);
});

test("desativar e alterar depois não mexe nos valores de quem já reservou", async () => {
  const session = await regularSession();
  const coupon = await createCoupon({ percent: 25 });
  const created = await bookWithCoupon(session, coupon.code, 2);
  await call(`public.admin_set_coupon_status($1::uuid, $2::uuid, 'INACTIVE', 'Campanha encerrada')`, [ADMIN, coupon.id]);
  await updateCoupon(coupon.id, await detail(coupon.id), { validUntil: await shiftDays(-1), maxUses: 1 });
  assert.equal(await pay(created.reservationId, created.totalCents), true, "a pré-reserva paga o valor que foi gravado");
  assert.deepEqual((await one(`select public.coupon_reservation_summary($1::uuid) as s`, [created.reservationId])).s, created.coupon);
  await rejects(db.query(`update public.coupon_redemptions set total_cents = 1 where reservation_id = $1::uuid`, [created.reservationId]), /COUPON_REDEMPTION_IMMUTABLE/);
  await rejects(db.query(`delete from public.coupon_redemptions where reservation_id = $1::uuid`, [created.reservationId]), /COUPON_REDEMPTION_IMMUTABLE/);
  await rejects(db.query(`delete from public.coupons where id = $1::uuid`, [coupon.id]), /foreign key|violates/);
});

test("auditoria: criar, editar, ativar e desativar ficam registrados com quem fez", async () => {
  const coupon = await createCoupon({ status: "INACTIVE" });
  await updateCoupon(coupon.id, coupon, { maxUses: 7 });
  await call(`public.admin_set_coupon_status($1::uuid, $2::uuid, 'ACTIVE', null)`, [ADMIN, coupon.id]);
  await call(`public.admin_set_coupon_status($1::uuid, $2::uuid, 'ACTIVE', null)`, [ADMIN, coupon.id]); // sem mudança, sem registro
  await call(`public.admin_set_coupon_status($1::uuid, $2::uuid, 'INACTIVE', 'pausa')`, [ADMIN, coupon.id]);
  const log = await rows(`select action, actor_user_id, reason, metadata from public.admin_audit_log where entity_type = 'COUPON' and entity_id = $1::uuid order by created_at, action`, [coupon.id]);
  assert.deepEqual(log.map((row) => row.action).sort(), ["COUPON_ACTIVATED", "COUPON_CREATED", "COUPON_DEACTIVATED", "COUPON_UPDATED"]);
  for (const row of log) assert.equal(row.actor_user_id, ADMIN);
  const updated = log.find((row) => row.action === "COUPON_UPDATED")!;
  assert.equal(updated.metadata.before.maxUses, null);
  assert.equal(updated.metadata.after.maxUses, 7);
  assert.equal(log.find((row) => row.action === "COUPON_DEACTIVATED")!.reason, "pausa");
});

test("entrada inválida no painel é recusada pelo banco", async () => {
  await rejects(createCoupon({ code: "ab" }), /COUPON_INVALID_CODE/);
  await rejects(createCoupon({ code: "com espaço" }), /COUPON_INVALID_CODE/);
  await rejects(createCoupon({ validFrom: "2026-12-10", validUntil: "2026-12-01" }), /COUPON_INVALID_VALIDITY/);
  await rejects(createCoupon({ maxUses: 0 }), /COUPON_INVALID_LIMIT/);
  await rejects(createCoupon({ scope: "SELECTED", experienceIds: [] }), /COUPON_INVALID_EXPERIENCES/);
  await rejects(createCoupon({ scope: "SELECTED", experienceIds: [crypto.randomUUID()] }), /COUPON_INVALID_EXPERIENCES/);
  await rejects(createCoupon({ scope: "ALL_REGULAR", experienceIds: [IMERSAO.id] }), /COUPON_INVALID_EXPERIENCES/);
  await rejects(createCoupon({ status: "PAUSED" as "ACTIVE" }), /COUPON_INVALID_STATUS/);
  await rejects(createCoupon({ description: "x".repeat(501) }), /COUPON_INVALID_DESCRIPTION/);
});

test("nenhum cupom nasce com a migration, e ninguém lê as tabelas sem as RPCs", async () => {
  const fresh = await fullDatabase();
  assert.equal(Number((await fresh.query<Row>(`select count(*) as n from public.coupons`)).rows[0].n), 0);
  assert.equal((await fresh.query<Row>(`select min_charge_cents from public.coupon_settings`)).rows[0].min_charge_cents, null);
  for (const table of ["coupons", "coupon_experiences", "coupon_redemptions", "coupon_settings"]) {
    const row = (await fresh.query<Row>(
      `select c.relrowsecurity as rls, has_table_privilege('anon', c.oid, 'SELECT') as a, has_table_privilege('authenticated', c.oid, 'SELECT') as b,
              has_table_privilege('service_role', c.oid, 'SELECT') as s, has_table_privilege('authenticated', c.oid, 'UPDATE') as u
       from pg_class c where c.oid = $1::regclass`, [`public.${table}`])).rows[0];
    assert.deepEqual([row.rls, row.a, row.b, row.s, row.u], [true, false, false, false, false], table);
  }
  await fresh.close();
});

// ===========================================================================
// 8. Migration, diagnósticos e rollback
// ===========================================================================

const NEW_FUNCTIONS = [
  "admin_coupon_json(uuid)",
  "admin_create_coupon(uuid,text,integer,date,date,integer,text,uuid[],text,text)",
  "admin_get_coupon(uuid,uuid)",
  "admin_list_coupons(uuid)",
  "admin_release_coupon_redemption(uuid,uuid,text)",
  "admin_set_coupon_status(uuid,uuid,text,text)",
  "admin_update_coupon(uuid,uuid,text,integer,date,date,integer,text,uuid[],text)",
  "coupon_admin_input_error(text,integer,date,date,integer,text,uuid[],text)",
  "coupon_discounted_unit_cents(integer,integer)",
  "coupon_field_visible(uuid)",
  "coupon_normalize_code(text)",
  "coupon_price_rejection(integer,integer,integer)",
  "coupon_redemption_state(timestamp with time zone,text,timestamp with time zone,timestamp with time zone)",
  "coupon_rejection(uuid,uuid)",
  "coupon_reservation_summary(uuid)",
  "coupon_today()",
  "coupon_uses(uuid)",
  "create_pre_reservation_with_coupon(uuid,text,text,text,text,integer,text,uuid,text)",
  "enforce_coupon_redemption_history()",
  "preview_coupon(uuid,integer,text)",
];
const SERVER_RPCS = ["preview_coupon", "coupon_field_visible", "create_pre_reservation_with_coupon", "admin_list_coupons", "admin_get_coupon", "admin_create_coupon", "admin_update_coupon", "admin_set_coupon_status", "admin_release_coupon_redemption"];
const CHANGED = "reservation_standby_target_rejection(uuid,uuid,text)";

const functionsSql = `select regexp_replace(p.oid::regprocedure::text, '^public\\.', '') as name, md5(p.prosrc) as src from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`;

test("migration: aditiva e idempotente; só a régua de preço do Stand-by muda entre as existentes", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  const old = (await before.query<{ name: string; src: string }>(functionsSql)).rows;
  const reservationsBefore = (await before.query(`select id, unit_price_cents, total_cents, updated_at from public.reservations order by id`)).rows;
  await applyMigration(before, MIGRATION);
  await applyMigration(before, MIGRATION);
  const current = new Map((await before.query<{ name: string; src: string }>(functionsSql)).rows.map((row) => [row.name, row.src]));
  for (const row of old) {
    if (row.name === CHANGED) assert.notEqual(current.get(row.name), row.src, "a régua do Stand-by muda");
    else assert.equal(current.get(row.name), row.src, `${row.name} não pode mudar`);
  }
  assert.deepEqual([...current.keys()].filter((name) => !old.some((row) => row.name === name)).sort(), NEW_FUNCTIONS);
  assert.deepEqual((await before.query(`select id, unit_price_cents, total_cents, updated_at from public.reservations order by id`)).rows, reservationsBefore);
  assert.equal((await before.query(`select * from public.coupon_settings`)).rows.length, 1);

  for (const fn of NEW_FUNCTIONS) {
    const row = (await before.query<Row>(
      `select has_function_privilege('anon', $1, 'EXECUTE') as a, has_function_privilege('authenticated', $1, 'EXECUTE') as b,
              has_function_privilege('service_role', $1, 'EXECUTE') as c
       from pg_proc p where p.oid = $1::regprocedure`, [`public.${fn}`])).rows[0];
    const server = SERVER_RPCS.some((name) => fn.startsWith(`${name}(`));
    assert.deepEqual([row.a, row.b, row.c], [false, false, server], fn);
  }

  const code = source(`supabase/migrations/${MIGRATION}`).split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
  assert.doesNotMatch(code, /cron\.schedule|pg_net|net\.http|create extension/i);
  assert.doesNotMatch(code, /create or replace function public\.(create_pre_reservation|confirm_reservation_payment|reconcile_reservation_payment|expire_pre_reservations|attach_payment_checkout|cancel_pre_reservation|admin_cancel_reservation|admin_confirm_reservation|admin_change_reservation_session)\s*\(/i);
  assert.doesNotMatch(code, /(insert into|delete from) public\.(reservations|sessions|payment_events|experiences)\b/i);
  // A única escrita em reservas é o desconto da reserva recém-criada pela própria RPC.
  assert.equal((code.match(/update public\.reservations/gi) ?? []).length, 1);
  assert.doesNotMatch(code, /drop function|cascade;/i);
  await before.close();
});

const PREFLIGHT = source("supabase/diagnostics/discount_coupons_preflight.sql");
const POSTCHECK = source("supabase/diagnostics/discount_coupons_postcheck.sql");
const REPORT = source("supabase/diagnostics/discount_coupons_report.sql");
const ROLLBACK = source("supabase/rollback/202611020001_discount_coupons.rollback.sql");

type Check = { check_name: string; result: string; status: string };

async function report(database: { query: (sql: string) => Promise<{ rows: unknown[] }> }, sql: string) {
  return new Map(((await database.query(sql)).rows as Check[]).map((row) => [row.check_name, row]));
}

test("preflight e postcheck: aprovam o banco do repositório, nas duas pontas", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  const pre = await report(before, PREFLIGHT);
  for (const [name, row] of pre) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  await applyMigration(before, MIGRATION);
  const post = await report(before, POSTCHECK);
  for (const [name, row] of post) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  assert.equal(post.get("FUNCOES_NOVAS_COM_A_DEFINICAO_DO_REPOSITORIO")?.result, `${NEW_FUNCTIONS.length} de ${NEW_FUNCTIONS.length}`);
  assert.match(post.get("VALOR_MINIMO")!.result, /^não definido/);
  for (const count of ["ASSINATURA_DAS_OUTRAS_FUNCOES", "RESERVAS_POR_STATUS"]) {
    assert.equal(post.get(count)?.result, pre.get(count)?.result, count);
  }
  await before.close();
});

test("preflight: reprova se uma função de que a migration depende estiver diferente do repositório", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  await before.exec(`create or replace function public.is_active_owner_admin(p_user_id uuid) returns boolean language sql stable security definer set search_path = public as $$ select true $$`);
  const pre = await report(before, PREFLIGHT);
  assert.equal(pre.get("FUNCOES_QUE_A_MIGRATION_USA")?.status, "FALHOU");
  assert.match(pre.get("FUNCOES_QUE_A_MIGRATION_USA")!.result, /is_active_owner_admin=DIFERENTE/);
  assert.equal(pre.get("CUPONS_PREFLIGHT_OK")?.status, "FALHOU");
  await before.close();
});

test("relatório: mostra usos e excedentes sem dado pessoal", async () => {
  const shown = (await db.query<Row>(REPORT)).rows;
  assert.ok(shown.length >= 1);
  const keys = Object.keys(shown[0]).join(",");
  assert.doesNotMatch(keys, /name|email|cpf|phone/i);
  assert.ok(shown.some((row) => row.situacao === "OVER_LIMIT"), "o pagamento tardio acima do limite aparece");
});

test("rollback: recusa com uso registrado; sem uso, remove tudo e devolve a régua do Stand-by", async () => {
  const database = await fullDatabase();
  const before = (await database.query<{ name: string; src: string }>(functionsSql)).rows;
  const original = (await (await fullDatabase({ until: PREVIOUS })).query<{ name: string; src: string }>(functionsSql)).rows;

  const local = await rescheduleFixtures(async (sql, params = []) => (await database.query(sql, params)).rows as Row[]);
  await database.query(`update public.coupon_settings set min_charge_cents = 100`);
  const coupon = await local.call(`public.admin_create_coupon($1::uuid, 'ROLLBACK-1', 10, null, null, null, 'ALL_REGULAR', '{}'::uuid[], 'ACTIVE', null)`, [ADMIN]);
  const session = await local.makeSession(local.IMERSAO.id, { price: 7_000 });
  await local.call(`public.create_pre_reservation_with_coupon($1::uuid, 'Cliente Rollback', '12345678909', '+5561999990000', 'rollback@teste.local', 1, null, gen_random_uuid(), 'ROLLBACK-1')`, [session]);
  await assert.rejects(database.exec(ROLLBACK), /ROLLBACK_RECUSADO/);
  await database.exec(`rollback`);
  assert.equal((await database.query(`select 1 from public.coupons where id = $1::uuid`, [coupon.id])).rows.length, 1);

  const clean = await fullDatabase();
  await clean.exec(ROLLBACK);
  const after = (await clean.query<{ name: string; src: string }>(functionsSql)).rows;
  assert.deepEqual(after, original, "o banco volta exatamente ao de antes da migration");
  for (const table of ["coupons", "coupon_experiences", "coupon_redemptions", "coupon_settings"]) {
    assert.equal((await clean.query<Row>(`select to_regclass($1) as t`, [`public.${table}`])).rows[0].t, null, table);
  }
  await clean.exec(ROLLBACK); // de novo: sem efeito e sem erro
  await applyMigration(clean, MIGRATION);
  assert.equal((await report(clean, POSTCHECK)).get("CUPONS_POSTCHECK_OK")?.status, "OK");
  assert.ok(before.length > original.length);
  await clean.close();
  await database.close();
});
