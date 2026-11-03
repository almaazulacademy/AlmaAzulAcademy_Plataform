/**
 * Cupons de desconto — disputa pelo último uso, com sessões independentes do
 * Postgres.
 *
 * `create_pre_reservation_with_coupon` trava a linha do cupom antes de contar
 * os usos e antes de a pré-reserva travar a sessão. Aqui cada conexão é uma
 * sessão de verdade, e os testes provam que compras simultâneas nunca passam do
 * limite, que quem chega durante uma compra em curso espera e decide com os
 * usos já atualizados, que a mesma tentativa repetida em paralelo não aplica
 * desconto duas vezes e que a edição do limite no painel espera a compra.
 *
 * Precisa de `TEST_DATABASE_URL` apontando para um Postgres local e
 * descartável. No CI é o contêiner do próprio job, e ali estes testes são
 * obrigatórios: sem o banco, falham em vez de serem pulados. Fora do CI, sem a
 * variável, são pulados com aviso. O Supabase nunca é usado.
 */

import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";

import type pg from "pg";

import { realDatabase, realDatabaseUrl } from "./support/real-database.ts";
import { ADMIN, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

const url = realDatabaseUrl();
const database = url ? await realDatabase(url) : null;

if (!database) {
  test("cupons: concorrência com várias conexões PostgreSQL", { skip: process.env.CI ? false : "TEST_DATABASE_URL não definido — estes testes rodam no CI, contra o Postgres do próprio job" }, () => {
    assert.fail("No CI, TEST_DATABASE_URL é obrigatório para os testes de concorrência.");
  });
} else {
  const setup = await database.connect();
  const pool = await Promise.all(Array.from({ length: 16 }, () => database.connect()));
  const [A, B] = pool;

  const fx = await rescheduleFixtures(async (sql, params = []) => (await setup.query(sql, params)).rows as Row[]);
  const { one, call, IMERSAO, makeSession } = fx;
  await setup.query(`update public.coupon_settings set min_charge_cents = 100`);

  after(() => database.destroy());

  beforeEach(async () => {
    // Nenhum teste pode herdar uma transação aberta de outro.
    await Promise.all(pool.map((client) => client.query("rollback").catch(() => undefined)));
  });

  let sequence = 0;

  async function coupon(maxUses: number | null) {
    sequence += 1;
    return call(
      `public.admin_create_coupon($1::uuid, $2, 10, null, null, $3, 'ALL_REGULAR', '{}'::uuid[], 'ACTIVE', null)`,
      [ADMIN, `DISPUTA-${sequence}`, maxUses],
    );
  }

  type Outcome = { ok: true; reservationId: string; totalCents: number } | { ok: false; error: string };

  function bookOn(client: pg.Client, sessionId: string, code: string | null, quantity = 1, key: string = crypto.randomUUID(), cpfSeed?: number): Promise<Outcome> {
    sequence += 1;
    const seed = cpfSeed ?? sequence;
    const cpf = String(80_000_000_000 + seed);
    const args = [sessionId, `Pessoa Paralela ${seed}`, cpf, `+55619${String(50_000_000 + seed)}`, `paralela.cupom${seed}@teste.local`, quantity, key];
    const query = code === null
      ? client.query(`select public.create_pre_reservation($1::uuid, $2, $3, $4, $5, $6, null, $7::uuid) as value`, args)
      : client.query(`select public.create_pre_reservation_with_coupon($1::uuid, $2, $3, $4, $5, $6, null, $7::uuid, $8) as value`, [...args, code]);
    return query.then(
      (result) => ({ ok: true as const, reservationId: result.rows[0].value.reservationId, totalCents: Number(result.rows[0].value.totalCents) }),
      (error: Error) => ({ ok: false as const, error: error.message }),
    );
  }

  async function counted(couponId: string) {
    return Number((await one(`select public.coupon_uses($1::uuid) as n`, [couponId])).n);
  }

  async function reservationsIn(sessionId: string) {
    return Number((await one(`select count(*) as n from public.reservations where session_id = $1::uuid`, [sessionId])).n);
  }

  async function stillWaiting(promise: Promise<unknown>, ms = 300) {
    const marker = Symbol("waiting");
    return (await Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(marker), ms))])) === marker;
  }

  test("16 pessoas, cupom de 5 usos ao mesmo tempo: exatamente 5 entram com desconto, 11 são recusadas sem reserva", async () => {
    const session = await makeSession(IMERSAO.id, { price: 7_000, capacity: 40 });
    const target = await coupon(5);
    const outcomes = await Promise.all(pool.map((client) => bookOn(client, session, target.code)));
    const accepted = outcomes.filter((item): item is Extract<Outcome, { ok: true }> => item.ok);
    assert.equal(accepted.length, 5);
    for (const item of accepted) assert.equal(item.totalCents, 6_300);
    for (const item of outcomes) if (!item.ok) assert.match(item.error, /COUPON_EXHAUSTED/);
    assert.equal(await counted(target.id), 5);
    assert.equal(await reservationsIn(session), 5, "as recusas não deixaram pré-reserva");
  });

  test("último uso em disputa: quem chega espera a compra em curso e é recusado quando ela confirma", async () => {
    const session = await makeSession(IMERSAO.id, { price: 7_000, capacity: 10 });
    const target = await coupon(1);
    await A.query("begin");
    const first = await bookOn(A, session, target.code);
    assert.equal(first.ok, true);

    const second = bookOn(B, session, target.code);
    assert.equal(await stillWaiting(second), true, "a segunda compra espera a trava do cupom");
    await A.query("commit");
    const late = await second;
    assert.equal(late.ok, false);
    assert.match((late as { error: string }).error, /COUPON_EXHAUSTED/);
    assert.equal(await counted(target.id), 1);
  });

  test("último uso em disputa: compra em curso desistida devolve o uso a quem esperava", async () => {
    const session = await makeSession(IMERSAO.id, { price: 7_000, capacity: 10 });
    const target = await coupon(1);
    await A.query("begin");
    await bookOn(A, session, target.code);
    const second = bookOn(B, session, target.code);
    assert.equal(await stillWaiting(second), true);
    await A.query("rollback");
    const won = await second;
    assert.equal(won.ok, true);
    assert.equal(await counted(target.id), 1);
  });

  test("a mesma tentativa enviada duas vezes em paralelo: uma reserva, um uso, um desconto", async () => {
    const session = await makeSession(IMERSAO.id, { price: 7_000, capacity: 10 });
    const target = await coupon(10);
    const key = crypto.randomUUID();
    sequence += 1;
    const seed = sequence;
    const outcomes = await Promise.all([bookOn(A, session, target.code, 2, key, seed), bookOn(B, session, target.code, 2, key, seed)]);
    const ids = new Set(outcomes.map((item) => (item.ok ? item.reservationId : item.error)));
    assert.equal(ids.size, 1, JSON.stringify(outcomes));
    for (const item of outcomes) assert.deepEqual(item.ok && item.totalCents, 12_600);
    assert.equal(await counted(target.id), 1);
    const [reservationId] = [...ids];
    assert.equal(Number((await one(`select unit_price_cents from public.reservations where id = $1::uuid`, [reservationId])).unit_price_cents), 6_300);
  });

  test("cupom e vagas disputados juntos, com e sem cupom: sem deadlock, sem passar da capacidade nem do limite", async () => {
    const session = await makeSession(IMERSAO.id, { price: 7_000, capacity: 6 });
    const target = await coupon(3);
    const outcomes = await Promise.all(pool.map((client, index) => bookOn(client, session, index % 2 === 0 ? target.code : null)));
    for (const item of outcomes) if (!item.ok) assert.match(item.error, /COUPON_EXHAUSTED|INSUFFICIENT_SPOTS/);
    assert.ok(outcomes.filter((item) => item.ok).length <= 6);
    assert.ok(await counted(target.id) <= 3);
    const occupied = Number((await one(
      `select coalesce(sum(quantity), 0) as n from public.reservations where session_id = $1::uuid and status = 'PRE_RESERVED' and expires_at > now()`,
      [session],
    )).n);
    assert.ok(occupied <= 6, `ocupou ${occupied}`);
  });

  test("painel: baixar o limite espera a compra em curso e não fica abaixo dos usos dela", async () => {
    const session = await makeSession(IMERSAO.id, { price: 7_000, capacity: 10 });
    const target = await coupon(3);
    await bookOn(setup, session, target.code);
    await A.query("begin");
    await bookOn(A, session, target.code);

    const lowering = B.query(
      `select public.admin_update_coupon($1::uuid, $2::uuid, $3, 10, null, null, 1, 'ALL_REGULAR', '{}'::uuid[], null) as value`,
      [ADMIN, target.id, target.code],
    ).then(() => "ok", (error: Error) => error.message);
    assert.equal(await stillWaiting(lowering), true, "a edição espera a trava do cupom");
    await A.query("commit");
    assert.match(await lowering, /COUPON_LIMIT_BELOW_USAGE/);
    assert.equal(Number((await one(`select max_uses from public.coupons where id = $1::uuid`, [target.id])).max_uses), 3);
    assert.equal(await counted(target.id), 2);
  });
}
