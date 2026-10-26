/**
 * Lista de espera — fase 5: a detecção com sessões independentes do Postgres.
 *
 * O PGlite tem uma conexão só. Aqui cada conexão é uma sessão de verdade, e os
 * testes mantêm transações abertas de propósito para ver quem espera e o que
 * cada um decide: duas varreduras ao mesmo tempo, a varredura ao lado de uma
 * pré-reserva que trava a turma (nas duas ordens), e inscrição e cancelamento
 * durante uma varredura.
 *
 * Precisa de `TEST_DATABASE_URL` apontando para um Postgres local e
 * descartável. No CI é o contêiner do próprio job, e ali estes testes são
 * obrigatórios. Fora do CI, sem a variável, são pulados com aviso.
 */

import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";

import type pg from "pg";

import { realDatabase, realDatabaseUrl } from "./support/real-database.ts";
import { ADMIN, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

const url = realDatabaseUrl();
const database = url ? await realDatabase(url) : null;

if (!database) {
  test("detecção da lista de espera: concorrência com duas conexões PostgreSQL", { skip: process.env.CI ? false : "TEST_DATABASE_URL não definido — estes testes rodam no CI, contra o Postgres do próprio job" }, () => {
    assert.fail("No CI, TEST_DATABASE_URL é obrigatório para os testes de concorrência.");
  });
} else {
  const setup = await database.connect();
  const pool = await Promise.all(Array.from({ length: 3 }, () => database.connect()));
  const [A, B] = pool;

  const fx = await rescheduleFixtures(async (sql, params = []) => (await setup.query(sql, params)).rows as Row[]);
  const { one, rows, call, IMERSAO, makeSession, reserve, uniquePrice } = fx;

  await setup.query(`update public.waitlist_settings set detection_enabled = true, opening_grace_seconds = 0, wave_interval_minutes = 30`);

  after(() => database.destroy());

  beforeEach(async () => {
    await Promise.all(pool.map((client) => client.query("rollback").catch(() => undefined)));
    await Promise.all(pool.map((client) => client.query("set statement_timeout = 0").catch(() => undefined)));
    await setup.query(`delete from public.waitlist_throttle`);
  });

  let sequence = 0;

  type Outcome = { ok: true; value: Row } | { ok: false; error: string };

  function settle(promise: Promise<pg.QueryResult>): Promise<Outcome> {
    return promise.then(
      (result) => ({ ok: true as const, value: result.rows[0]?.value }),
      (error: Error) => ({ ok: false as const, error: error.message }),
    );
  }

  async function stillWaiting(promise: Promise<unknown>, ms = 300) {
    const marker = Symbol("waiting");
    return (await Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(marker), ms))])) === marker;
  }

  /** Turma esgotada, com uma pessoa na lista e a vaga já liberada — pronta para abrir. */
  async function freedSession() {
    const session = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 1 });
    const booking = await reserve(session, 1);
    sequence += 1;
    await call(`public.waitlist_join($1::uuid, $2, $3, $4, 1, null, '')`, [session, `Pessoa Paralela ${sequence}`, `paralela-scan${sequence}@teste.local`, `+5561${String(930000000 + sequence)}`]);
    await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Libera a vaga')`, [ADMIN, booking.id]);
    return session;
  }

  async function openings(sessionId: string) {
    return rows(`select * from public.waitlist_openings where session_id = $1::uuid`, [sessionId]);
  }

  async function notices(sessionId: string) {
    return rows(
      `select n.* from public.waitlist_notifications n join public.waitlist_entries we on we.id = n.entry_id where we.session_id = $1::uuid and n.kind = 'SPOT_AVAILABLE'`,
      [sessionId],
    );
  }

  const scanOn = (client: pg.Client) => settle(client.query(`select public.waitlist_scan() as value`));

  test("duas varreduras ao mesmo tempo: a segunda volta na hora, sem esperar nem duplicar", async () => {
    const session = await freedSession();
    await A.query("begin");
    const first = await scanOn(A);
    assert.equal(first.ok && first.value.enabled, true);
    await B.query("set statement_timeout = '3s'");
    const second = await scanOn(B);
    assert.deepEqual(second, { ok: true, value: { enabled: true, skipped: "ALREADY_RUNNING" } });
    await A.query("commit");

    const third = await scanOn(B);
    assert.ok(third.ok && third.value.skipped === undefined);
    assert.equal((await openings(session)).length, 1);
    assert.equal((await notices(session)).length, 1);
  });

  test("turma travada por uma pré-reserva: a varredura pula a turma em 2 s e segue; na próxima, abre", async () => {
    const session = await freedSession();
    await A.query("begin");
    await A.query(`select id from public.sessions where id = $1::uuid for update`, [session]);
    await B.query("set statement_timeout = '10s'");
    const started = Date.now();
    const blocked = await scanOn(B);
    assert.ok(Date.now() - started < 8000, "não espera além do lock_timeout");
    assert.ok(blocked.ok, blocked.ok ? "" : blocked.error);
    assert.ok(blocked.ok && blocked.value.sessionsSkipped >= 1, JSON.stringify(blocked));
    assert.equal((await openings(session)).length, 0, "nada gravado para a turma travada");
    await A.query("rollback");

    const next = await scanOn(B);
    assert.ok(next.ok);
    assert.equal((await openings(session)).length, 1);
  });

  test("pré-reserva durante uma varredura: espera só até a varredura terminar, e conclui", async () => {
    const session = await freedSession();
    await A.query("begin");
    const scanning = await scanOn(A);
    assert.ok(scanning.ok);
    await B.query("set statement_timeout = '10s'");
    const reservation = settle(B.query(
      `select public.create_pre_reservation($1::uuid, 'Quem Chegou Primeiro', '52998224725', '+5561988887777', 'primeiro-scan@teste.local', 1, null, gen_random_uuid()) as value`,
      [session],
    ));
    // A abertura recém-gravada segura a turma em FOR KEY SHARE até a varredura confirmar.
    assert.equal(await stillWaiting(reservation), true);
    await A.query("commit");
    const done = await reservation;
    assert.ok(done.ok && done.value.reservationId, done.ok ? "" : done.error);

    // A vaga foi tomada: a próxima varredura fecha a abertura e descarta o aviso parado.
    const closing = await scanOn(B);
    assert.ok(closing.ok);
    const [opening] = await openings(session);
    assert.ok(opening.closed_at);
    assert.equal(opening.closed_reason, "NO_SPOTS");
    assert.ok((await notices(session)).every((notice) => notice.status === "SKIPPED"));
  });

  test("inscrição e cancelamento durante uma varredura não esperam", async () => {
    const session = await freedSession();
    const other = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 1 });
    const otherBooking = await reserve(other, 1);
    await A.query("begin");
    assert.ok((await scanOn(A)).ok);

    await B.query("set statement_timeout = '3s'");
    sequence += 1;
    // A outra turma está esgotada: a inscrição é aceita, sem esperar a varredura.
    const joined = await settle(B.query(
      `select public.waitlist_join($1::uuid, 'Inscrita Durante', $2, $3, 1, null, '') as value`,
      [other, `durante${sequence}@teste.local`, `+5561${String(940000000 + sequence)}`],
    ));
    assert.deepEqual(joined, { ok: true, value: { status: "ACCEPTED" } });
    const cancelled = await settle(B.query(`select public.admin_cancel_reservation($1::uuid, $2::uuid, 'Cancela durante') as value`, [ADMIN, otherBooking.id]));
    assert.ok(cancelled.ok, cancelled.ok ? "" : cancelled.error);
    await A.query("commit");
    assert.equal((await one(`select status::text as s from public.reservations where id = $1::uuid`, [otherBooking.id])).s, "CANCELLED");
    assert.ok(session);
  });
}
