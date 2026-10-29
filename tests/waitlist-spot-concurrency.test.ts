/**
 * Lista de espera — fase 6: o envio do aviso de vaga com sessões independentes
 * do Postgres.
 *
 * O PGlite tem uma conexão só. Aqui cada conexão é uma sessão de verdade, e os
 * testes mantêm transações abertas de propósito: dois envios ao mesmo tempo, um
 * cancelamento da inscrição antes e depois da reivindicação, e uma reserva
 * durante a reivindicação.
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
  test("aviso de vaga da lista de espera: concorrência com duas conexões PostgreSQL", { skip: process.env.CI ? false : "TEST_DATABASE_URL não definido — estes testes rodam no CI, contra o Postgres do próprio job" }, () => {
    assert.fail("No CI, TEST_DATABASE_URL é obrigatório para os testes de concorrência.");
  });
} else {
  const setup = await database.connect();
  const pool = await Promise.all(Array.from({ length: 3 }, () => database.connect()));
  const [A, B] = pool;

  const fx = await rescheduleFixtures(async (sql, params = []) => (await setup.query(sql, params)).rows as Row[]);
  const { one, call, IMERSAO, SUNSET_CONCHA, makeSession, reserve, uniquePrice } = fx;

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

  /** Turma com a vaga liberada, uma pessoa na lista e o aviso dela já na fila. */
  async function queuedNotice() {
    const session = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 1 });
    const booking = await reserve(session, 1);
    sequence += 1;
    await call(`public.waitlist_join($1::uuid, $2, $3, $4, 1, null, '')`, [session, `Pessoa Envio ${sequence}`, `paralela-envio${sequence}@teste.local`, `+5561${String(920000000 + sequence)}`]);
    await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Libera a vaga')`, [ADMIN, booking.id]);
    await call(`public.waitlist_scan()`);
    const notice = await one(
      `select n.id, n.entry_id from public.waitlist_notifications n join public.waitlist_entries we on we.id = n.entry_id
       where we.session_id = $1::uuid and n.kind = 'SPOT_AVAILABLE' and n.status = 'QUEUED'`,
      [session],
    );
    return { session, notice: notice.id as string, entry: notice.entry_id as string };
  }

  const claimOn = (client: pg.Client) => settle(client.query(`select public.claim_pending_waitlist_spot_emails(50, 6, 2, 1380) as value`));
  const claimed = (outcome: Outcome, notice: string) => outcome.ok && (outcome.value as unknown as Row[]).some((claim) => claim.notificationId === notice);

  test("dois envios ao mesmo tempo: o segundo não espera nem pega o mesmo aviso, e o envio conta uma vez", async () => {
    const { notice, entry } = await queuedNotice();
    await A.query("begin");
    const first = await claimOn(A);
    assert.equal(claimed(first, notice), true);

    await B.query("set statement_timeout = '3s'");
    const second = await claimOn(B);
    assert.ok(second.ok, second.ok ? "" : second.error);
    assert.equal(claimed(second, notice), false, "o aviso em reivindicação é pulado, não esperado");
    await A.query("commit");

    // Depois de confirmada, o aviso está em envio: ninguém mais o pega até o prazo vencer.
    assert.equal(claimed(await claimOn(B), notice), false);
    const token = (first.ok ? (first.value as unknown as Row[]) : []).find((claim) => claim.notificationId === notice)!.claimToken;
    assert.equal(await call(`public.complete_waitlist_spot_email($1::uuid, $2::uuid)`, [notice, token]), true);
    assert.equal(await call(`public.complete_waitlist_spot_email($1::uuid, $2::uuid)`, [notice, token]), true);
    assert.equal((await one(`select notifications_sent from public.waitlist_entries where id = $1::uuid`, [entry])).notifications_sent, 1);
  });

  test("cancelamento em curso: o envio desiste da inscrição em 3 s; confirmado, o aviso é descartado", async () => {
    const { notice, entry } = await queuedNotice();
    const token = await call(`public.waitlist_cancel_token($1::uuid)`, [entry]);
    await B.query("begin");
    const cancelling = await settle(B.query(`select public.waitlist_cancel($1, null) as value`, [token]));
    assert.ok(cancelling.ok, cancelling.ok ? "" : cancelling.error);

    await A.query("set statement_timeout = '10s'");
    const started = Date.now();
    const during = await claimOn(A);
    assert.ok(Date.now() - started < 8000, "não espera além do lock_timeout");
    assert.ok(during.ok, during.ok ? "" : during.error);
    assert.equal(claimed(during, notice), false);
    await B.query("commit");

    assert.equal(claimed(await claimOn(A), notice), false);
    const after = await one(`select status::text as status, skip_reason from public.waitlist_notifications where id = $1::uuid`, [notice]);
    assert.deepEqual([after.status, after.skip_reason], ["SKIPPED", "ENTRY_CLOSED"]);
  });

  test("cancelamento durante a reivindicação: espera só até ela terminar, e conclui", async () => {
    const { notice, entry } = await queuedNotice();
    const token = await call(`public.waitlist_cancel_token($1::uuid)`, [entry]);
    await A.query("begin");
    assert.equal(claimed(await claimOn(A), notice), true);

    await B.query("set statement_timeout = '10s'");
    const cancelling = settle(B.query(`select public.waitlist_cancel($1, null) as value`, [token]));
    // A reivindicação segura a inscrição em FOR SHARE até confirmar: uma chamada só, em produção.
    assert.equal(await stillWaiting(cancelling), true);
    await A.query("commit");
    const done = await cancelling;
    assert.ok(done.ok, done.ok ? "" : done.error);
    assert.equal((await one(`select status::text as s from public.waitlist_entries where id = $1::uuid`, [entry])).s, "CANCELLED");
  });

  test("reserva durante a reivindicação não espera: a lista nunca segura a vaga", async () => {
    const { session, notice } = await queuedNotice();
    await A.query("begin");
    assert.equal(claimed(await claimOn(A), notice), true);

    await B.query("set statement_timeout = '3s'");
    const reservation = await settle(B.query(
      `select public.create_pre_reservation($1::uuid, 'Quem Chegou Primeiro', '52998224725', '+5561988886666', 'primeiro-envio@teste.local', 1, null, gen_random_uuid()) as value`,
      [session],
    ));
    assert.ok(reservation.ok && reservation.value.reservationId, reservation.ok ? JSON.stringify(reservation.value) : reservation.error);
    await A.query("commit");
    assert.equal(await call(`public.available_spots($1::uuid)`, [session]), 0);
  });

  // Etapa 5C-2: a reivindicação por tipo (migration 202610300001) divide a fila do mesmo jeito.
  const claimByKindOn = (client: pg.Client, kinds: string[]) => settle(client.query(`select public.claim_pending_waitlist_spot_emails_by_kind($1::text[], 50, 6, 2, 1380) as value`, [kinds]));

  test("reivindicação por tipo: dois envios ao mesmo tempo não pegam o mesmo aviso; tipo fora do pedido nem é tocado", async () => {
    const { notice } = await queuedNotice();
    await A.query("begin");
    const onlyEvents = await claimByKindOn(A, ["EVENT"]);
    assert.ok(onlyEvents.ok, onlyEvents.ok ? "" : onlyEvents.error);
    assert.equal(claimed(onlyEvents, notice), false, "aviso de turma regular fora de um pedido só de eventos");
    const first = await claimByKindOn(A, ["REGULAR", "EVENT"]);
    assert.equal(claimed(first, notice), true);

    await B.query("set statement_timeout = '3s'");
    const second = await claimByKindOn(B, ["REGULAR", "EVENT"]);
    assert.ok(second.ok, second.ok ? "" : second.error);
    assert.equal(claimed(second, notice), false, "o aviso em reivindicação é pulado, não esperado");
    await A.query("commit");
    const attempts = (await one(`select attempts from public.waitlist_notifications where id = $1::uuid`, [notice])).attempts;
    assert.equal(attempts, 1, "uma tentativa só");
  });

  // Interruptor de publicação (202610310001 + 202610300001): evento escondido não tem aviso reivindicado.
  test("interruptor desligado: reivindicações simultâneas não tocam o aviso do evento; religado, uma só o pega", async () => {
    sequence += 1;
    const created = await call(
      `public.admin_create_event($1::uuid, $2::uuid, $3, 'Evento Paralelo', 'x', '{}'::jsonb, null, now() + interval '10 days', 210, 15000, 1)`,
      [ADMIN, SUNSET_CONCHA.base_id, `evento-paralelo-${sequence}`],
    );
    await setup.query(`update public.special_event_settings set publication_enabled = true`);
    await setup.query(`update public.experiences set status = 'PUBLISHED' where id = $1::uuid`, [created.experienceId]);
    await setup.query(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [created.sessionId]);
    const booking = await reserve(created.sessionId, 1);
    await call(`public.waitlist_join($1::uuid, $2, $3, $4, 1, null, '')`, [created.sessionId, `Pessoa Evento ${sequence}`, `paralela-evento${sequence}@teste.local`, `+5561${String(930000000 + sequence)}`]);
    await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Libera a vaga')`, [ADMIN, booking.id]);
    await call(`public.waitlist_scan()`);
    const notice = (await one(
      `select n.id from public.waitlist_notifications n join public.waitlist_entries we on we.id = n.entry_id
       where we.session_id = $1::uuid and n.kind = 'SPOT_AVAILABLE' and n.status = 'QUEUED'`, [created.sessionId],
    )).id as string;

    await setup.query(`update public.special_event_settings set publication_enabled = false`);
    const [a, b] = await Promise.all([claimByKindOn(A, ["REGULAR", "EVENT"]), claimByKindOn(B, ["REGULAR", "EVENT"])]);
    assert.equal(claimed(a, notice) || claimed(b, notice), false, "escondido: ninguém pega");
    assert.equal((await one(`select attempts from public.waitlist_notifications where id = $1::uuid`, [notice])).attempts, 0);

    await setup.query(`update public.special_event_settings set publication_enabled = true`);
    const [c, d] = await Promise.all([claimByKindOn(A, ["REGULAR", "EVENT"]), claimByKindOn(B, ["REGULAR", "EVENT"])]);
    assert.equal(Number(claimed(c, notice)) + Number(claimed(d, notice)), 1, "religado: exatamente uma execução pega");
    assert.equal((await one(`select attempts from public.waitlist_notifications where id = $1::uuid`, [notice])).attempts, 1);
  });
}
