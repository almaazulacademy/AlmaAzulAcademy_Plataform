/**
 * Cupons de desconto — rollback da migration disputado com compras em curso,
 * com sessões independentes do Postgres.
 *
 * O rollback trava, tudo ou nada, `reservations`, `experiences` e as quatro
 * tabelas de cupom antes de contar os usos, e conta e remove na mesma
 * transação. Cada cenário usa um banco próprio, porque o rollback apaga as
 * tabelas: A) compra aberta que confirma → o rollback espera e recusa; B) compra
 * aberta que desiste → o rollback espera e segue; C) rollback com as travas →
 * a compra espera e falha inteira; D) uso confirmado → recusa, tudo preservado;
 * E) transação que já leu reservas e depois compra com cupom → sem deadlock.
 *
 * Precisa de `TEST_DATABASE_URL` apontando para um Postgres local e
 * descartável. No CI é o contêiner do próprio job, e ali estes testes são
 * obrigatórios: sem o banco, falham em vez de serem pulados. Fora do CI, sem a
 * variável, são pulados com aviso. O Supabase nunca é usado.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type pg from "pg";

import { realDatabase, realDatabaseUrl, type RealDatabase } from "./support/real-database.ts";
import { ADMIN, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

const url = realDatabaseUrl();
const ROLLBACK = readFileSync(new URL("../supabase/rollback/202611020001_discount_coupons.rollback.sql", import.meta.url), "utf8");
/** O mesmo rollback sem o `commit;` final: a transação fica aberta, segurando as travas. */
const ROLLBACK_OPEN = ROLLBACK.replace(/\ncommit;\s*$/, "\n");

if (!url) {
  test("cupons: rollback concorrente com várias conexões PostgreSQL", { skip: process.env.CI ? false : "TEST_DATABASE_URL não definido — estes testes rodam no CI, contra o Postgres do próprio job" }, () => {
    assert.fail("No CI, TEST_DATABASE_URL é obrigatório para os testes de concorrência.");
  });
} else {
  assert.notEqual(ROLLBACK_OPEN, ROLLBACK, "o rollback termina em commit;");

  type Scenario = {
    database: RealDatabase;
    setup: pg.Client;
    A: pg.Client;
    B: pg.Client;
    sessionId: string;
    code: string;
  };

  let sequence = 0;

  /** Banco novo, com todas as migrations, o mínimo de cobrança, um cupom e uma turma. */
  async function scenario(): Promise<Scenario> {
    const database = await realDatabase(url!);
    const setup = await database.connect();
    const [A, B] = await Promise.all([database.connect(), database.connect()]);
    const fx = await rescheduleFixtures(async (sql, params = []) => (await setup.query(sql, params)).rows as Row[]);
    await setup.query(`update public.coupon_settings set min_charge_cents = 100`);
    const coupon = await fx.call(`public.admin_create_coupon($1::uuid, 'ROLLBACK-DISPUTA', 10, null, null, 5, 'ALL_REGULAR', '{}'::uuid[], 'ACTIVE', null)`, [ADMIN]);
    const sessionId = await fx.makeSession(fx.IMERSAO.id, { price: 7_000, capacity: 10 });
    return { database, setup, A, B, sessionId, code: coupon.code };
  }

  function book(client: pg.Client, s: Scenario, withCoupon = true) {
    sequence += 1;
    const args = [s.sessionId, `Pessoa Rollback ${sequence}`, String(90_000_000_000 + sequence), `+55619${String(60_000_000 + sequence)}`, `rollback${sequence}@teste.local`, 1, crypto.randomUUID()];
    const query = withCoupon
      ? client.query(`select public.create_pre_reservation_with_coupon($1::uuid, $2, $3, $4, $5, $6, null, $7::uuid, $8) as value`, [...args, s.code])
      : client.query(`select public.create_pre_reservation($1::uuid, $2, $3, $4, $5, $6, null, $7::uuid) as value`, args);
    return query.then(
      (result) => ({ ok: true as const, value: result.rows[0].value as Row, key: args[6] as string }),
      (error: Error) => ({ ok: false as const, error: error.message, key: args[6] as string }),
    );
  }

  function run(client: pg.Client, sql: string) {
    return client.query(sql).then(() => "OK", (error: Error) => error.message);
  }

  async function stillWaiting(promise: Promise<unknown>, ms = 500) {
    const marker = Symbol("waiting");
    return (await Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(marker), ms))])) === marker;
  }

  async function couponsInstalled(client: pg.Client) {
    const row = (await client.query(`
      select to_regclass('public.coupons') is not null as coupons,
             to_regclass('public.coupon_redemptions') is not null as redemptions,
             to_regprocedure('public.create_pre_reservation_with_coupon(uuid,text,text,text,text,integer,text,uuid,text)') is not null as rpc,
             (select prosrc like '%coupon_redemptions%' from pg_proc where oid = 'public.reservation_standby_target_rejection(uuid,uuid,text)'::regprocedure) as standby_rule
    `)).rows[0] as Row;
    return [row.coupons, row.redemptions, row.rpc, row.standby_rule] as boolean[];
  }

  async function redemptions(client: pg.Client) {
    return Number(((await client.query(`select count(*) as n from public.coupon_redemptions`)).rows[0] as Row).n);
  }

  test("A: compra com uso gravado e ainda aberta — o rollback espera e, com o commit da compra, recusa sem apagar nada", async () => {
    const s = await scenario();
    try {
      await s.A.query("begin");
      const purchase = await book(s.A, s);
      assert.equal(purchase.ok, true);

      const rollback = run(s.B, ROLLBACK);
      assert.equal(await stillWaiting(rollback), true, "o rollback espera a compra em curso");
      await s.A.query("commit");
      assert.match(await rollback, /ROLLBACK_RECUSADO/);
      await s.B.query("rollback");

      assert.deepEqual(await couponsInstalled(s.setup), [true, true, true, true]);
      assert.equal(await redemptions(s.setup), 1);
      const kept = (await s.setup.query(`select unit_price_cents, total_cents from public.reservations where idempotency_key = $1::uuid`, [purchase.key])).rows[0] as Row;
      assert.deepEqual([kept.unit_price_cents, kept.total_cents], [6_300, 6_300]);
    } finally {
      await s.database.destroy();
    }
  });

  test("B: compra aberta que desiste — o rollback espera e segue, porque não sobra uso nenhum", async () => {
    const s = await scenario();
    try {
      await s.A.query("begin");
      assert.equal((await book(s.A, s)).ok, true);
      const rollback = run(s.B, ROLLBACK);
      assert.equal(await stillWaiting(rollback), true);
      await s.A.query("rollback");
      assert.equal(await rollback, "OK");

      assert.deepEqual(await couponsInstalled(s.setup), [false, false, false, false], "tabelas, RPC e régua de antes");
      // A reserva sem cupom segue funcionando depois do rollback.
      const plain = await book(s.setup, s, false);
      assert.equal(plain.ok, true);
      assert.equal(Number((plain as { value: Row }).value.totalCents), 7_000);
    } finally {
      await s.database.destroy();
    }
  });

  test("C: rollback com as travas — a compra espera e falha inteira, sem pré-reserva nem uso", async () => {
    const s = await scenario();
    try {
      assert.equal(await run(s.B, ROLLBACK_OPEN), "OK", "travas obtidas e remoção feita, ainda sem commit");
      const purchase = book(s.A, s);
      assert.equal(await stillWaiting(purchase), true, "a compra espera o rollback");
      await s.B.query("commit");
      const result = await purchase;
      assert.equal(result.ok, false);
      await s.A.query("rollback").catch(() => undefined);

      assert.equal((await s.setup.query(`select 1 from public.reservations where idempotency_key = $1::uuid`, [result.key])).rows.length, 0);
      assert.deepEqual(await couponsInstalled(s.setup), [false, false, false, false]);
      assert.equal((await book(s.setup, s, false)).ok, true, "reserva sem cupom segue funcionando");
    } finally {
      await s.database.destroy();
    }
  });

  test("D: uso confirmado — o rollback recusa e preserva histórico e estrutura", async () => {
    const s = await scenario();
    try {
      const purchase = await book(s.setup, s);
      assert.equal(purchase.ok, true);
      const reservationId = (purchase as { value: Row }).value.reservationId;
      await s.setup.query(`select public.confirm_reservation_payment($1::uuid, 'INFINITEPAY', 'tx-rollback', 6300, '', '{}'::jsonb)`, [reservationId]);
      const before = (await s.setup.query(`select * from public.coupon_redemptions`)).rows;

      assert.match(await run(s.B, ROLLBACK), /ROLLBACK_RECUSADO/);
      await s.B.query("rollback");

      assert.deepEqual(await couponsInstalled(s.setup), [true, true, true, true]);
      assert.deepEqual((await s.setup.query(`select * from public.coupon_redemptions`)).rows, before);
      assert.equal(((await s.setup.query(`select status::text as status from public.reservations where id = $1::uuid`, [reservationId])).rows[0] as Row).status, "CONFIRMED");
    } finally {
      await s.database.destroy();
    }
  });

  test("E: transação que já leu reservas e depois compra com cupom — sem deadlock; o rollback espera e recusa", async () => {
    const s = await scenario();
    try {
      // A ordem das compras: reservas primeiro, cupons depois. O rollback nunca
      // espera segurando trava, então não fecha ciclo com ela.
      await s.A.query("begin");
      await s.A.query(`select count(*) from public.reservations`);
      const rollback = run(s.B, ROLLBACK);
      assert.equal(await stillWaiting(rollback), true);
      const purchase = await book(s.A, s);
      assert.equal(purchase.ok, true, JSON.stringify(purchase));
      await s.A.query("commit");
      assert.match(await rollback, /ROLLBACK_RECUSADO/);
      await s.B.query("rollback");
      assert.equal(await redemptions(s.setup), 1);
    } finally {
      await s.database.destroy();
    }
  });
}
