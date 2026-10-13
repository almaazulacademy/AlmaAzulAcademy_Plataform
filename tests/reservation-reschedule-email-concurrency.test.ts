/**
 * E-mail de reagendamento: concorrência com sessões independentes do Postgres.
 *
 * Os outros testes rodam em PGlite, que tem uma conexão só: eles provam o que
 * cada chamada decide a partir do estado que encontra, mas não a espera real de
 * uma sessão pelo lock de outra. Aqui cada conexão é uma sessão de verdade, e
 * os testes mantêm transações abertas de propósito para observar quem espera,
 * quem pula e o que cada um decide quando a outra termina.
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
import {
  ADMIN,
  LEASE_MINUTES,
  MAX_ATTEMPTS,
  rescheduleFixtures,
  WINDOW_MINUTES,
  type Row,
} from "./support/reschedule-email-fixtures.ts";

const url = realDatabaseUrl();
const database = url ? await realDatabase(url) : null;

if (!database) {
  // No CI o banco é obrigatório: um teste de concorrência pulado em silêncio é
  // pior do que um teste que não existe.
  test("concorrência com duas conexões PostgreSQL", { skip: process.env.CI ? false : "TEST_DATABASE_URL não definido — estes testes rodam no CI, contra o Postgres do próprio job" }, () => {
    assert.fail("No CI, TEST_DATABASE_URL é obrigatório para os testes de concorrência.");
  });
} else {
  const setup = await database.connect();
  const [A, B, C] = await Promise.all([database.connect(), database.connect(), database.connect()]);
  const pool = [A, B, C, ...(await Promise.all([database.connect(), database.connect(), database.connect()]))];

  const fx = await rescheduleFixtures(async (sql, params = []) => (await setup.query(sql, params)).rows as Row[]);
  const { one, IMERSAO, makeSession, reserve, setStandby, reschedule, reservation, rescheduled, emails, email, attempts, claimAndFreeze, expireLease, settleQueue, uniquePrice } = fx;

  after(() => database.destroy());

  beforeEach(async () => {
    // Nenhum teste pode herdar uma transação aberta de outro.
    await Promise.all(pool.map((client) => client.query("rollback").catch(() => undefined)));
    await settleQueue();
  });

  // --- Operações da fila, por sessão -----------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function value(client: pg.Client, expression: string, params: unknown[] = []): Promise<any> {
    return (await client.query(`select ${expression} as value`, params)).rows[0].value;
  }

  const claim = (client: pg.Client, changeId: string) =>
    value(client, `public.claim_reservation_reschedule_email($1::uuid, ${MAX_ATTEMPTS}, ${LEASE_MINUTES}, ${WINDOW_MINUTES})`, [changeId]);
  const claimPending = (client: pg.Client, limit = 25) =>
    value(client, `public.claim_pending_reservation_reschedule_emails($1, ${MAX_ATTEMPTS}, ${LEASE_MINUTES}, ${WINDOW_MINUTES})`, [limit]);
  const complete = (client: pg.Client, emailId: string, token: string) =>
    value(client, `public.complete_reservation_reschedule_email($1::uuid, $2::uuid)`, [emailId, token]);
  const fail = (client: pg.Client, emailId: string, token: string, code: string, kind: string) =>
    value(client, `public.fail_reservation_reschedule_email($1::uuid, $2::uuid, $3, $4, 0)`, [emailId, token, code, kind]);
  const rescheduleOn = (client: pg.Client, reservationId: string, sessionId: string) =>
    value(client, `public.admin_reschedule_standby_same_price($1::uuid, $2::uuid, $3::uuid, null)`, [ADMIN, reservationId, sessionId]);

  // --- Observação de espera ---------------------------------------------------

  const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

  async function backendPid(client: pg.Client) {
    return (await client.query(`select pg_backend_pid() as pid`)).rows[0].pid as number;
  }

  /** true quando a sessão está parada esperando um lock de outra. */
  async function isWaitingOnLock(client: pg.Client) {
    const pid = await pidOf.get(client)!;
    const [activity] = (await setup.query(`select wait_event_type from pg_stat_activity where pid = $1`, [pid])).rows;
    return activity?.wait_event_type === "Lock";
  }

  /** Espera até a sessão estar de fato bloqueada. Falha se ela nunca bloquear. */
  async function untilBlocked(client: pg.Client, label: string) {
    for (let elapsed = 0; elapsed < 5000; elapsed += 20) {
      if (await isWaitingOnLock(client)) return;
      await sleep(20);
    }
    assert.fail(`${label}: a sessão deveria estar esperando um lock`);
  }

  /** O resultado de uma chamada que não pode esperar por lock nenhum. */
  async function withoutWaiting<T>(client: pg.Client, promise: Promise<T>, label: string): Promise<T> {
    let settled = false;
    const tracked = promise.finally(() => { settled = true; });
    for (let elapsed = 0; elapsed < 3000 && !settled; elapsed += 20) {
      assert.equal(await isWaitingOnLock(client), false, `${label}: a sessão não pode ficar esperando`);
      await sleep(20);
    }
    assert.ok(settled, `${label}: deveria ter respondido sem esperar`);
    return tracked;
  }

  const pidOf = new Map<pg.Client, Promise<number>>(pool.map((client) => [client, backendPid(client)]));

  test("o banco de teste é um Postgres de verdade, com sessões independentes", async () => {
    const pids = await Promise.all(pool.map((client) => pidOf.get(client)!));
    assert.equal(new Set(pids).size, pool.length, "cada conexão é uma sessão própria");
    const { version } = (await setup.query(`select version()`)).rows[0];
    assert.match(version, /^PostgreSQL \d+/);
    assert.equal((await setup.query(`show transaction_isolation`)).rows[0].transaction_isolation, "read committed", "o nível de isolamento é o do Supabase");
    const { n } = (await setup.query(`select count(*)::int as n from pg_proc where proname = 'reservation_reschedule_email_take'`)).rows[0];
    assert.equal(n, 1, "todas as migrations foram aplicadas");
  });

  // ===========================================================================
  // 1. Duas instâncias tentando enviar ao mesmo tempo
  // ===========================================================================

  test("duas instâncias reivindicam o mesmo e-mail: a segunda não espera, não reivindica e não envia", async () => {
    const { booking, emailId, changeId } = await rescheduled();

    await A.query("begin");
    const first = await claim(A, changeId);
    assert.equal(first.attempt, 1);

    // A reivindicação de A ainda nem foi confirmada, e B já recebe "não é sua".
    assert.equal(await withoutWaiting(B, claim(B, changeId), "segunda reivindicação"), null);
    assert.deepEqual(await withoutWaiting(C, claimPending(C), "rotina"), []);

    await A.query("commit");
    assert.equal(await claim(B, changeId), null, "confirmada: envio em curso");
    const [row] = await emails(booking.id);
    assert.deepEqual([row.status, row.attempts], ["SENDING", 1]);
    assert.equal((await attempts(emailId)).length, 1);
  });

  test("se a transação da primeira reivindicação for desfeita, nada fica reivindicado — e a segunda instância envia", async () => {
    const { booking, emailId, changeId } = await rescheduled();

    await A.query("begin");
    assert.ok(await claim(A, changeId));
    assert.equal(await claim(B, changeId), null);
    await A.query("rollback");

    const [row] = await emails(booking.id);
    assert.deepEqual([row.status, row.attempts], ["QUEUED", 0], "a reivindicação desfeita não deixa rastro");
    const second = await claim(B, changeId);
    assert.equal(second.attempt, 1);
    assert.equal((await attempts(emailId)).length, 1);
  });

  test("trinta reivindicações em paralelo, de seis sessões: exatamente uma", async () => {
    const { booking, emailId, changeId } = await rescheduled();

    const results = await Promise.all(pool.flatMap((client) => Array.from({ length: 5 }, () => claim(client, changeId))));
    assert.equal(results.length, 30);
    assert.equal(results.filter(Boolean).length, 1, "um único chamador recebe o direito de enviar");

    const [row] = await emails(booking.id);
    assert.deepEqual([row.status, row.attempts, row.generation], ["SENDING", 1, 1]);
    assert.equal((await attempts(emailId)).length, 1);
  });

  test("duas execuções da rotina ao mesmo tempo dividem a fila, sem esperar uma pela outra", async () => {
    const queued = [await rescheduled(), await rescheduled(), await rescheduled(), await rescheduled()];

    await A.query("begin");
    const first = await claimPending(A, 2);
    assert.deepEqual(first.map((item: Row) => item.emailId), [queued[0].emailId, queued[1].emailId]);

    // B não espera pelas linhas que A segura: pula e pega as seguintes.
    const second = await withoutWaiting(B, claimPending(B, 10), "segunda execução da rotina");
    assert.deepEqual(second.map((item: Row) => item.emailId), [queued[2].emailId, queued[3].emailId]);
    await A.query("commit");

    assert.deepEqual(await claimPending(C, 10), []);
    for (const item of queued) assert.equal((await email(item.emailId)).attempts, 1, "cada e-mail foi reivindicado uma vez");
  });

  test("seis sessões rodando a rotina sem parar: cada e-mail é reivindicado exatamente uma vez", async () => {
    const queued: Array<Awaited<ReturnType<typeof rescheduled>>> = [];
    for (let index = 0; index < 6; index += 1) queued.push(await rescheduled());

    const rounds = await Promise.all(pool.flatMap((client) => Array.from({ length: 4 }, () => claimPending(client, 3))));
    const leftovers = await claimPending(setup, 25);
    const claimed = [...rounds.flat(), ...leftovers].map((item: Row) => item.emailId as string);

    assert.equal(claimed.length, queued.length, "nenhum e-mail foi reivindicado duas vezes");
    assert.deepEqual([...claimed].sort(), queued.map((item) => item.emailId).sort());
    for (const item of queued) {
      const row = await email(item.emailId);
      assert.deepEqual([row.status, row.attempts], ["SENDING", 1]);
    }
  });

  // ===========================================================================
  // 2. O prazo vence durante um envio; a resposta chega atrasada
  // ===========================================================================

  test("resposta tardia do provedor enquanto outra instância reivindica: as duas se enfileiram na linha, e o e-mail termina enviado", async () => {
    const { booking, emailId, changeId } = await rescheduled();
    const slow = await claimAndFreeze(changeId, booking.id);
    await expireLease(emailId);

    // A assume o envio (transação aberta); a resposta positiva da tentativa
    // antiga chega em B no mesmo instante.
    await A.query("begin");
    const retaken = await claim(A, changeId);
    assert.deepEqual([retaken.attempt, retaken.generation], [2, 1], "resultado desconhecido: mesma chave");
    assert.equal(retaken.message.html, "<p>v1</p>", "e a mesma mensagem");

    const late = complete(B, emailId, slow.claimToken);
    await untilBlocked(B, "a conclusão tardia espera a reivindicação terminar");
    await A.query("commit");
    assert.equal(await late, true);

    let row = await email(emailId);
    assert.deepEqual([row.status, row.attempts, row.locked_until, row.frozen_message], ["SENT", 2, null, null], "o resultado positivo vale, mesmo registrado depois da nova reivindicação");

    // O que a segunda tentativa disser depois não muda mais nada.
    assert.equal(await fail(A, emailId, retaken.claimToken, "IDEMPOTENCY_IN_PROGRESS", "UNKNOWN"), true);
    row = await email(emailId);
    assert.deepEqual([row.status, row.last_error_code], ["SENT", null]);
    assert.equal(await claim(C, changeId), null);
    assert.deepEqual(await claimPending(C), []);
    assert.deepEqual((await attempts(emailId)).map((item) => [item.attempt, item.outcome]), [[1, "SENT"], [2, "UNKNOWN"]]);
  });

  test("resposta tardia registrada antes: a nova reivindicação encontra o e-mail enviado e não envia", async () => {
    const { booking, emailId, changeId } = await rescheduled();
    const slow = await claimAndFreeze(changeId, booking.id);
    await expireLease(emailId);

    // A conclusão tardia ainda não foi confirmada quando a rotina passa.
    await A.query("begin");
    assert.equal(await complete(A, emailId, slow.claimToken), true);
    assert.equal(await withoutWaiting(B, claim(B, changeId), "reivindicação durante a conclusão"), null, "a linha está com outra sessão: não espera, não envia");
    assert.deepEqual(await withoutWaiting(C, claimPending(C), "rotina durante a conclusão"), []);
    await A.query("commit");

    assert.equal(await claim(B, changeId), null);
    const row = await email(emailId);
    assert.deepEqual([row.status, row.attempts], ["SENT", 1]);
  });

  test("falha tardia de uma tentativa antiga não solta o envio que outra instância está fazendo", async () => {
    const { booking, emailId, changeId } = await rescheduled();
    const slow = await claimAndFreeze(changeId, booking.id);
    await expireLease(emailId);

    await A.query("begin");
    const retaken = await claim(A, changeId);
    const late = fail(B, emailId, slow.claimToken, "TIMEOUT", "UNKNOWN");
    await untilBlocked(B, "a falha tardia espera a reivindicação terminar");
    await A.query("commit");
    assert.equal(await late, true);

    const row = await email(emailId);
    assert.deepEqual([row.status, row.attempts, row.generation_uncertain], ["SENDING", 2, true]);
    assert.equal(await claim(C, changeId), null, "o envio da segunda tentativa continua protegido");
    assert.equal(await complete(A, emailId, retaken.claimToken), true);
    assert.equal((await email(emailId)).status, "SENT");
  });

  // ===========================================================================
  // 3. Repetição da requisição de reagendamento
  // ===========================================================================

  test("reagendamento ainda não confirmado é invisível para a fila; desfeito, não deixa e-mail", async () => {
    const price = uniquePrice();
    const origin = await makeSession(IMERSAO.id, { price });
    const destination = await makeSession(IMERSAO.id, { price, startsIn: "12 days" });
    const booking = await reserve(origin);
    await setStandby(booking.id);
    const before = (await one(`select count(*)::int as n from public.reservation_reschedule_emails`)).n;

    await A.query("begin");
    const pending = await rescheduleOn(A, booking.id, destination);
    assert.equal(pending.replayed, false);
    assert.equal((await A.query(`select count(*)::int as n from public.reservation_reschedule_emails where change_id = $1::uuid`, [pending.changeId])).rows[0].n, 1, "dentro da transação, a linha existe");

    // Fora dela, não existe evento: nem a requisição nem a rotina têm o que enviar.
    assert.equal(await withoutWaiting(B, claim(B, pending.changeId), "reivindicação de reagendamento não confirmado"), null);
    assert.deepEqual(await withoutWaiting(C, claimPending(C), "rotina"), []);
    assert.equal((await one(`select count(*)::int as n from public.reservation_reschedule_emails`)).n, before);

    await A.query("rollback");
    assert.equal(await claim(B, pending.changeId), null);
    assert.equal((await one(`select count(*)::int as n from public.reservation_reschedule_emails`)).n, before, "transação desfeita: nenhum e-mail a enviar");
    assert.equal((await reservation(booking.id)).status, "AWAITING_RESCHEDULE");

    // Confirmado, o evento aparece — uma vez.
    const done = await rescheduleOn(A, booking.id, destination);
    assert.equal((await claim(B, done.changeId)).attempt, 1);
    assert.equal((await emails(booking.id)).length, 1);
  });

  test("duas requisições de reagendamento ao mesmo tempo: uma grava, a outra espera e recebe a repetição — um evento, um e-mail", async () => {
    const price = uniquePrice();
    const origin = await makeSession(IMERSAO.id, { price });
    const destination = await makeSession(IMERSAO.id, { price, startsIn: "12 days" });
    const other = await makeSession(IMERSAO.id, { price, startsIn: "13 days" });
    const booking = await reserve(origin);
    await setStandby(booking.id);

    await A.query("begin");
    const first = await rescheduleOn(A, booking.id, destination);

    const duplicate = rescheduleOn(B, booking.id, destination);
    const conflicting = rescheduleOn(C, booking.id, other).then(() => null, (error: Error) => error);
    await untilBlocked(B, "a requisição repetida espera a primeira");
    await untilBlocked(C, "a requisição para outra turma também");
    await A.query("commit");

    const replay = await duplicate;
    assert.equal(replay.replayed, true);
    assert.equal(replay.changeId, first.changeId, "a repetição devolve a mesma chave do e-mail");
    assert.match((await conflicting)?.message ?? "", /STANDBY_ALREADY_USED/);

    assert.equal((await emails(booking.id)).length, 1, "um evento");
    assert.equal((await one(`select count(*)::int as n from public.reservation_session_changes where reservation_id = $1::uuid`, [booking.id])).n, 1);
    assert.equal((await reservation(booking.id)).session_id, destination);

    // As duas requisições seguem para o envio, como a rota faz: um e-mail.
    const sends = await Promise.all([claim(A, first.changeId), claim(B, replay.changeId)]);
    assert.equal(sends.filter(Boolean).length, 1);
  });

  // ===========================================================================
  // 4. Cancelamento ou nova troca de turma com envio pendente
  // ===========================================================================

  test("volta ao Stand-by em andamento: a reivindicação espera e decide com o estado final — não envia", async () => {
    const { booking, emailId, changeId } = await rescheduled();

    await A.query("begin");
    await value(A, `public.admin_set_reservation_standby($1::uuid, $2::uuid, 'Turma cancelada de novo')`, [ADMIN, booking.id]);

    const pending = claim(B, changeId);
    await untilBlocked(B, "a reivindicação espera a reserva");
    await A.query("commit");

    assert.equal(await pending, null);
    const row = await email(emailId);
    assert.deepEqual([row.status, row.last_error_code, row.attempts], ["SKIPPED", "RESERVATION_NOT_CONFIRMED", 0]);
  });

  test("cancelamento em andamento: a reivindicação espera e não envia; cancelamento desfeito: envia", async () => {
    const cancelled = await rescheduled();
    await A.query("begin");
    assert.equal(await value(A, `public.admin_cancel_reservation($1::uuid, $2::uuid, 'Cliente desistiu')`, [ADMIN, cancelled.booking.id]), true);
    const first = claim(B, cancelled.changeId);
    await untilBlocked(B, "a reivindicação espera o cancelamento");
    await A.query("commit");
    assert.equal(await first, null);
    assert.deepEqual([(await email(cancelled.emailId)).status, (await email(cancelled.emailId)).last_error_code], ["SKIPPED", "RESERVATION_NOT_CONFIRMED"]);

    const kept = await rescheduled();
    await A.query("begin");
    await value(A, `public.admin_cancel_reservation($1::uuid, $2::uuid, 'Engano')`, [ADMIN, kept.booking.id]);
    const second = claim(B, kept.changeId);
    await untilBlocked(B, "a reivindicação espera o cancelamento");
    await A.query("rollback");
    assert.equal((await second).attempt, 1, "o cancelamento não aconteceu: a reserva continua confirmada e o e-mail sai");
  });

  test("troca de turma tradicional em andamento: a reivindicação espera e descarta o e-mail da turma antiga", async () => {
    const { booking, emailId, changeId, price } = await rescheduled();
    const elsewhere = await makeSession(IMERSAO.id, { price, startsIn: "40 days" });

    await A.query("begin");
    await value(A, `public.admin_change_reservation_session($1::uuid, $2::uuid, $3::uuid, null)`, [ADMIN, booking.id, elsewhere]);
    const pending = claim(B, changeId);
    await untilBlocked(B, "a reivindicação espera a troca de turma");
    await A.query("commit");

    assert.equal(await pending, null);
    const row = await email(emailId);
    assert.deepEqual([row.status, row.last_error_code], ["SKIPPED", "SUPERSEDED"]);
    assert.equal((await emails(booking.id)).length, 1, "a troca tradicional não enfileira outro e-mail");
  });

  test("enquanto a reivindicação decide, o cancelamento espera — e o que foi reivindicado antes dele é o limite conhecido", async () => {
    const { booking, emailId, changeId } = await rescheduled();

    await A.query("begin");
    const claimed = await claim(A, changeId);
    assert.ok(claimed);

    // A reserva está travada pela reivindicação: o cancelamento só começa depois.
    const cancelling = value(B, `public.admin_cancel_reservation($1::uuid, $2::uuid, 'Cliente desistiu')`, [ADMIN, booking.id]);
    await untilBlocked(B, "o cancelamento espera a reivindicação");
    await A.query("commit");
    assert.equal(await cancelling, true);

    // O envio já tinha sido autorizado quando o cancelamento começou: esta é a
    // janela que nenhum lock fecha, porque o envio acontece fora do banco.
    let row = await email(emailId);
    assert.deepEqual([row.status, row.attempts], ["SENDING", 1]);
    assert.equal((await reservation(booking.id)).status, "CANCELLED");

    // Se esse envio não der certo, nenhuma nova tentativa acontece.
    assert.equal(await fail(A, emailId, claimed.claimToken, "TIMEOUT", "UNKNOWN"), true);
    assert.equal(await claim(C, changeId), null);
    row = await email(emailId);
    assert.deepEqual([row.status, row.last_error_code], ["SKIPPED", "RESERVATION_NOT_CONFIRMED"]);
  });

  test("novo reagendamento em andamento para a mesma reserva: o e-mail antigo espera, e só o novo sai", async () => {
    const { booking, emailId, changeId, destination } = await rescheduled();
    await setStandby(booking.id);

    await A.query("begin");
    const again = await rescheduleOn(A, booking.id, destination);
    const stale = claim(B, changeId);
    await untilBlocked(B, "a reivindicação do e-mail antigo espera o novo reagendamento");
    await A.query("commit");

    assert.equal(await stale, null);
    assert.deepEqual([(await email(emailId)).status, (await email(emailId)).last_error_code], ["SKIPPED", "SUPERSEDED"]);
    const fresh = await claim(B, again.changeId);
    assert.equal(fresh.attempt, 1);
    assert.deepEqual((await emails(booking.id)).map((row) => row.status), ["SKIPPED", "SENDING"]);
  });

  // ===========================================================================
  // 5. Uma transação presa não segura a fila
  // ===========================================================================

  test("reserva presa em outra transação: a rotina desiste dela em 3 s e segue com o resto; a reivindicação direta falha sem enviar", async () => {
    const stuck = await rescheduled();
    const free = await rescheduled();

    // Uma transação que travou a reserva e não terminou.
    await A.query("begin");
    await A.query(`select 1 from public.reservations where id = $1::uuid for update`, [stuck.booking.id]);

    const started = Date.now();
    const batch = await claimPending(B, 10);
    const elapsed = Date.now() - started;
    assert.deepEqual(batch.map((item: Row) => item.emailId), [free.emailId], "o lote segue com o e-mail da outra reserva");
    assert.ok(elapsed >= 2500 && elapsed < 10_000, `a espera pela reserva tem limite (${elapsed} ms)`);
    assert.deepEqual([(await email(stuck.emailId)).status, (await email(stuck.emailId)).attempts], ["QUEUED", 0], "o e-mail da reserva presa fica para a próxima execução");

    // A reivindicação direta falha com erro de lock: quem chama trata como "pendente" e não envia.
    await assert.rejects(claim(C, stuck.changeId), (error: Error & { code?: string }) => {
      assert.equal(error.code, "55P03");
      return true;
    });
    assert.equal((await email(stuck.emailId)).attempts, 0);

    await A.query("rollback");
    assert.equal((await claim(C, stuck.changeId)).attempt, 1, "liberada a reserva, o e-mail sai normalmente");
  });

  test("reagendar não espera pela fila: nenhuma operação de Stand-by trava a linha de um e-mail", async () => {
    // Uma reivindicação aberta para o e-mail do primeiro reagendamento…
    const { booking, changeId, destination, price } = await rescheduled();
    const next = await makeSession(IMERSAO.id, { price, startsIn: "50 days" });

    await A.query("begin");
    assert.ok(await claim(A, changeId));

    // …segura a reserva em modo compartilhado. Colocar em Stand-by espera por ela
    // (precisa da reserva), mas não há ciclo: assim que a reivindicação termina,
    // tudo anda.
    const parking = value(B, `public.admin_set_reservation_standby($1::uuid, $2::uuid, 'Outra vez')`, [ADMIN, booking.id]);
    await untilBlocked(B, "o Stand-by espera a reivindicação");
    await A.query("commit");
    await parking;

    const again = await rescheduleOn(C, booking.id, next);
    assert.equal(again.replayed, false);
    assert.notEqual(again.targetSessionId, destination);
    assert.equal((await emails(booking.id)).length, 2);
    assert.equal((await reschedule(booking.id, next)).replayed, true);
  });
}
