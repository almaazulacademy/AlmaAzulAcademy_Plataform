/**
 * Eventos especiais — fase 2: as 12 vagas sob disputa, com sessões
 * independentes do Postgres.
 *
 * O evento não tem motor próprio: a capacidade é a de sempre, decidida por
 * `create_pre_reservation` com `FOR UPDATE` na sessão. Aqui cada conexão é uma
 * sessão de verdade, e os testes provam que várias pessoas comprando ao mesmo
 * tempo nunca passam de 12 participantes, e que quem chega durante uma compra
 * em curso espera e decide com a ocupação já atualizada.
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
  test("eventos especiais: concorrência com várias conexões PostgreSQL", { skip: process.env.CI ? false : "TEST_DATABASE_URL não definido — estes testes rodam no CI, contra o Postgres do próprio job" }, () => {
    assert.fail("No CI, TEST_DATABASE_URL é obrigatório para os testes de concorrência.");
  });
} else {
  const setup = await database.connect();
  const pool = await Promise.all(Array.from({ length: 16 }, () => database.connect()));
  const [A, B] = pool;

  const fx = await rescheduleFixtures(async (sql, params = []) => (await setup.query(sql, params)).rows as Row[]);
  const { one, call, SUNSET_CONCHA } = fx;

  after(() => database.destroy());

  beforeEach(async () => {
    // Nenhum teste pode herdar uma transação aberta de outro.
    await Promise.all(pool.map((client) => client.query("rollback").catch(() => undefined)));
  });

  let sequence = 0;

  /** Evento publicado com a sessão de 12 vagas aberta: o ESSÊNCIA, à venda. */
  async function onSaleEvent(capacity = 12) {
    sequence += 1;
    const created = await call(
      `public.admin_create_event($1::uuid, $2::uuid, $3, 'Evento Concorrência', 'x', '{}'::jsonb, null, now() + interval '10 days', 210, 15000, $4)`,
      [ADMIN, SUNSET_CONCHA.base_id, `evento-concorrencia-${sequence}`, capacity],
    );
    await setup.query(`update public.special_event_settings set publication_enabled = true`);
    // Conteúdo editorial é exigência só do painel; aqui basta o status.
    await setup.query(`update public.experiences set status = 'PUBLISHED' where id = $1::uuid`, [created.experienceId]);
    await setup.query(`update public.special_event_settings set publication_enabled = false`);
    await setup.query(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [created.sessionId]);
    return created.sessionId as string;
  }

  type Outcome = { ok: true; quantity: number } | { ok: false; error: string };

  function preReserveOn(client: pg.Client, sessionId: string, quantity: number): Promise<Outcome> {
    sequence += 1;
    return client.query(
      `select public.create_pre_reservation($1::uuid, $2, $3, $4, $5, $6, null, gen_random_uuid()) as value`,
      [sessionId, `Pessoa Paralela ${sequence}`, String(60_000_000_000 + sequence), `+55619${String(40_000_000 + sequence)}`, `paralela.evento${sequence}@teste.local`, quantity],
    ).then(
      (result) => ({ ok: true as const, quantity: Number(result.rows[0].value.quantity) }),
      (error: Error) => ({ ok: false as const, error: error.message }),
    );
  }

  async function occupied(sessionId: string) {
    return Number((await one(
      `select coalesce(sum(quantity), 0) as n from public.reservations
       where session_id = $1::uuid and (status = 'CONFIRMED' or (status = 'PRE_RESERVED' and expires_at > now()))`,
      [sessionId],
    )).n);
  }

  async function stillWaiting(promise: Promise<unknown>, ms = 300) {
    const marker = Symbol("waiting");
    return (await Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(marker), ms))])) === marker;
  }

  test("16 pessoas compram 1 vaga ao mesmo tempo: exatamente 12 entram, 4 são recusadas", async () => {
    const session = await onSaleEvent();
    const outcomes = await Promise.all(pool.map((client) => preReserveOn(client, session, 1)));
    assert.equal(outcomes.filter((item) => item.ok).length, 12);
    const refused = outcomes.filter((item): item is { ok: false; error: string } => !item.ok);
    assert.equal(refused.length, 4);
    for (const item of refused) assert.match(item.error, /INSUFFICIENT_SPOTS/);
    assert.equal(await occupied(session), 12);
    assert.equal(Number((await one(`select public.available_spots($1::uuid) as n`, [session])).n), 0);
  });

  test("grupos de tamanhos diferentes ao mesmo tempo: a soma nunca passa de 12", async () => {
    const session = await onSaleEvent();
    const sizes = [5, 4, 4, 3, 3, 2, 2, 1];
    const outcomes = await Promise.all(sizes.map((size, index) => preReserveOn(pool[index], session, size)));
    const accepted = outcomes.reduce((sum, item) => sum + (item.ok ? item.quantity : 0), 0);
    assert.ok(accepted <= 12, `aceitou ${accepted}`);
    for (const item of outcomes) if (!item.ok) assert.match(item.error, /INSUFFICIENT_SPOTS/);
    assert.equal(await occupied(session), accepted);
    // Toda recusa foi justa: o grupo recusado não cabia no que sobrou.
    const smallestRefused = Math.min(...outcomes.map((item, index) => (item.ok ? Infinity : sizes[index])));
    if (Number.isFinite(smallestRefused)) assert.ok(12 - accepted < smallestRefused);
  });

  test("compra em curso: quem chega espera a trava da sessão e decide com a ocupação atualizada", async () => {
    const session = await onSaleEvent();
    await A.query("begin");
    const first = await preReserveOn(A, session, 12);
    assert.deepEqual(first, { ok: true, quantity: 12 });

    const second = preReserveOn(B, session, 1);
    assert.equal(await stillWaiting(second), true, "a segunda compra espera a primeira");
    await A.query("commit");
    const late = await second;
    assert.equal(late.ok, false);
    assert.match((late as { error: string }).error, /INSUFFICIENT_SPOTS/);
    assert.equal(await occupied(session), 12);
  });

  test("compra em curso desistida: a vaga volta e quem esperava consegue", async () => {
    const session = await onSaleEvent();
    await A.query("begin");
    await preReserveOn(A, session, 12);
    const second = preReserveOn(B, session, 2);
    assert.equal(await stillWaiting(second), true);
    await A.query("rollback");
    assert.deepEqual(await second, { ok: true, quantity: 2 });
    assert.equal(await occupied(session), 2);
  });
}
