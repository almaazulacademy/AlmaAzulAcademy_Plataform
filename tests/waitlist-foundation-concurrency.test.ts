/**
 * Lista de espera — fase 1: concorrência com sessões independentes do Postgres.
 *
 * O PGlite tem uma conexão só: a outra suíte prova o que cada chamada decide a
 * partir do estado que encontra. Aqui cada conexão é uma sessão de verdade, e os
 * testes mantêm transações abertas de propósito para observar quem espera e o
 * que cada um decide quando a outra termina: o mesmo e-mail em duas abas, a
 * inscrição ao lado de uma pré-reserva que trava a turma (espera curta, sem
 * ciclo), o limite sob rajada e dois cancelamentos ao mesmo tempo.
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
  test("lista de espera: concorrência com duas conexões PostgreSQL", { skip: process.env.CI ? false : "TEST_DATABASE_URL não definido — estes testes rodam no CI, contra o Postgres do próprio job" }, () => {
    assert.fail("No CI, TEST_DATABASE_URL é obrigatório para os testes de concorrência.");
  });
} else {
  const setup = await database.connect();
  const pool = await Promise.all(Array.from({ length: 6 }, () => database.connect()));
  const [A, B] = pool;

  const fx = await rescheduleFixtures(async (sql, params = []) => (await setup.query(sql, params)).rows as Row[]);
  const { one, rows, call, IMERSAO, makeSession, reserve, uniquePrice } = fx;

  after(() => database.destroy());

  beforeEach(async () => {
    // Nenhum teste pode herdar uma transação aberta de outro.
    await Promise.all(pool.map((client) => client.query("rollback").catch(() => undefined)));
    await Promise.all(pool.map((client) => client.query("set statement_timeout = 0").catch(() => undefined)));
    await setup.query(`delete from public.waitlist_throttle`);
  });

  let sequence = 0;

  async function soldOutSession(capacity = 2) {
    const session = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity });
    await reserve(session, capacity);
    return session;
  }

  function person() {
    sequence += 1;
    return { fullName: `Paralela Pessoa ${sequence}`, email: `paralela${sequence}@teste.local`, phone: `+55619${String(70_000_000 + sequence)}` };
  }

  type Outcome = { ok: true; value: Row } | { ok: false; error: string };

  /** O resultado de uma chamada, sem lançar: o teste compara os dois lados. */
  function settle(promise: Promise<pg.QueryResult>): Promise<Outcome> {
    return promise.then(
      (result) => ({ ok: true as const, value: result.rows[0]?.value }),
      (error: Error) => ({ ok: false as const, error: error.message }),
    );
  }

  function joinOn(client: pg.Client, sessionId: string, who: { fullName: string; email: string; phone: string }, quantity = 1, clientAddress: string | null = null) {
    return settle(client.query(
      `select public.waitlist_join($1::uuid, $2, $3, $4, $5, $6, '') as value`,
      [sessionId, who.fullName, who.email, who.phone, quantity, clientAddress],
    ));
  }

  /** true quando a promessa ainda não terminou depois de `ms`. */
  async function stillWaiting(promise: Promise<unknown>, ms = 300) {
    const marker = Symbol("waiting");
    return (await Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(marker), ms))])) === marker;
  }

  test("o mesmo e-mail em duas abas: a segunda espera a primeira e não duplica", async () => {
    const session = await soldOutSession();
    const who = person();
    await A.query("begin");
    const first = await joinOn(A, session, who);
    assert.deepEqual(first, { ok: true, value: { status: "ACCEPTED" } });

    const second = joinOn(B, session, { ...who, email: who.email.toUpperCase() });
    assert.equal(await stillWaiting(second), true, "a segunda inscrição espera o lock do e-mail");
    await A.query("commit");
    assert.deepEqual(await second, { ok: true, value: { status: "ACCEPTED" } });

    const entries = await rows(`select id from public.waitlist_entries where session_id = $1::uuid`, [session]);
    assert.equal(entries.length, 1);
    assert.equal((await one(`select count(*)::int as n from public.waitlist_notifications where entry_id = $1::uuid`, [entries[0].id])).n, 1);
  });

  test("o mesmo e-mail em duas abas: se a primeira desiste, a segunda grava", async () => {
    const session = await soldOutSession();
    const who = person();
    await A.query("begin");
    await joinOn(A, session, who);
    const second = joinOn(B, session, who);
    assert.equal(await stillWaiting(second), true);
    await A.query("rollback");
    assert.deepEqual(await second, { ok: true, value: { status: "ACCEPTED" } });
    assert.equal((await rows(`select id from public.waitlist_entries where session_id = $1::uuid`, [session])).length, 1);
  });

  // Gravar a inscrição pega FOR KEY SHARE na sessão (chave estrangeira), como
  // gravar uma reserva. Isso espera o FOR UPDATE de uma pré-reserva em curso, e
  // vice-versa — pelo tempo de uma chamada, sem ciclo. Os dois testes provam que
  // a espera termina e que as duas operações concluem.
  test("inscrição ao lado de uma pré-reserva em curso: espera a turma ser solta e conclui", async () => {
    const session = await soldOutSession();
    await A.query("begin");
    await A.query(`select id from public.sessions where id = $1::uuid for update`, [session]);
    await B.query("set statement_timeout = '10s'");
    const joined = joinOn(B, session, person());
    assert.equal(await stillWaiting(joined), true, "a chave estrangeira espera o FOR UPDATE da turma");
    await A.query("rollback");
    assert.deepEqual(await joined, { ok: true, value: { status: "ACCEPTED" } });
  });

  test("pré-reserva ao lado de uma inscrição em curso: espera a inscrição terminar e conclui", async () => {
    const session = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 2 });
    const booking = await reserve(session, 2);
    await A.query("begin");
    assert.deepEqual(await joinOn(A, session, person()), { ok: true, value: { status: "ACCEPTED" } });
    // Libera as vagas por outra sessão, sem tocar na inscrição em curso.
    await call(`public.admin_set_reservation_standby($1::uuid, $2::uuid, 'Libera a turma no meio do teste')`, [ADMIN, booking.id]);
    await B.query("set statement_timeout = '10s'");
    const reserved = settle(B.query(
      `select public.create_pre_reservation($1::uuid, 'Quem Chegou Primeiro', '52998224725', '+5561988887777', 'primeiro@teste.local', 2, null, gen_random_uuid()) as value`,
      [session],
    ));
    assert.equal(await stillWaiting(reserved), true, "o FOR UPDATE da pré-reserva espera a chave estrangeira da inscrição");
    await A.query("commit");
    const outcome = await reserved;
    assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.error);
    assert.ok(outcome.ok && outcome.value.reservationId, "a vaga é de quem reservou (opção A)");
    assert.equal((await rows(`select id from public.waitlist_entries where session_id = $1::uuid and status = 'ACTIVE'`, [session])).length, 1);
  });

  test("limite sob rajada: 10 inscrições por origem, nem uma a mais", async () => {
    const session = await soldOutSession(3);
    const attempts = pool.flatMap((client) => Array.from({ length: 3 }, () => client)).map((client) => joinOn(client, session, person(), 1, "203.0.113.50"));
    const results = await Promise.all(attempts);
    for (const result of results) assert.equal(result.ok, true, result.ok ? "" : result.error);
    const statuses = results.map((result) => (result.ok ? result.value.status : "ERRO"));
    assert.equal(statuses.filter((status) => status === "ACCEPTED").length, 10);
    assert.equal(statuses.filter((status) => status === "RATE_LIMITED").length, 8);
    assert.equal((await rows(`select id from public.waitlist_entries where session_id = $1::uuid`, [session])).length, 10);
  });

  test("dois cancelamentos ao mesmo tempo: um cancela, o outro vê encerrada", async () => {
    const session = await soldOutSession();
    const who = person();
    await joinOn(A, session, who);
    const entry = await one(`select id from public.waitlist_entries where session_id = $1::uuid and email = $2`, [session, who.email]);
    const token = await call(`public.waitlist_cancel_token($1::uuid)`, [entry.id]);

    await A.query("begin");
    const first = await settle(A.query(`select public.waitlist_cancel($1, null) as value`, [token]));
    const second = settle(B.query(`select public.waitlist_cancel($1, null) as value`, [token]));
    assert.equal(await stillWaiting(second), true, "o segundo espera o lock da inscrição");
    await A.query("commit");
    assert.deepEqual(first, { ok: true, value: { status: "CANCELLED" } });
    assert.deepEqual(await second, { ok: true, value: { status: "ALREADY_CLOSED", state: "CANCELLED" } });
  });

  test("cliente cancela enquanto a equipe remove: uma decisão só, sem erro", async () => {
    const session = await soldOutSession();
    const who = person();
    await joinOn(A, session, who);
    const entry = await one(`select id from public.waitlist_entries where session_id = $1::uuid and email = $2`, [session, who.email]);
    const token = await call(`public.waitlist_cancel_token($1::uuid)`, [entry.id]);

    await A.query("begin");
    const removed = await settle(A.query(`select public.admin_remove_waitlist_entry($1::uuid, $2::uuid, 'Removida pela equipe') as value`, [ADMIN, entry.id]));
    const cancelled = settle(B.query(`select public.waitlist_cancel($1, null) as value`, [token]));
    assert.equal(await stillWaiting(cancelled), true);
    await A.query("commit");
    assert.deepEqual(removed, { ok: true, value: { removed: true, status: "REMOVED" } });
    assert.deepEqual(await cancelled, { ok: true, value: { status: "ALREADY_CLOSED", state: "REMOVED" } });
    assert.equal((await one(`select count(*)::int as n from public.admin_audit_log where entity_type = 'waitlist_entry' and entity_id = $1::uuid`, [entry.id])).n, 1);
  });
}
