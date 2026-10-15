/**
 * Autoatendimento do Stand-by: concorrência com sessões independentes do
 * Postgres.
 *
 * O PGlite tem uma conexão só: a outra suíte prova o que cada chamada decide a
 * partir do estado que encontra. Aqui cada conexão é uma sessão de verdade, e os
 * testes mantêm transações abertas de propósito para observar quem espera e o
 * que cada um decide quando a outra termina: duas pessoas na última vaga, a
 * mesma autorização em duas abas, o cliente e a equipe ao mesmo tempo, e o
 * limite de tentativas sob rajada.
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
import { handlePublicLookup } from "../lib/reservations/public-lookup.ts";
import { handleSelfServiceOverview, handleSelfServiceReschedule } from "../lib/reservations/standby-self-service.ts";
import { ADMIN, rescheduleFixtures, type Booking, type Row } from "./support/reschedule-email-fixtures.ts";

const url = realDatabaseUrl();
const database = url ? await realDatabase(url) : null;

if (!database) {
  test("autoatendimento: concorrência com duas conexões PostgreSQL", { skip: process.env.CI ? false : "TEST_DATABASE_URL não definido — estes testes rodam no CI, contra o Postgres do próprio job" }, () => {
    assert.fail("No CI, TEST_DATABASE_URL é obrigatório para os testes de concorrência.");
  });
} else {
  const setup = await database.connect();
  const pool = await Promise.all(Array.from({ length: 6 }, () => database.connect()));
  const [A, B, C] = pool;

  const fx = await rescheduleFixtures(async (sql, params = []) => (await setup.query(sql, params)).rows as Row[]);
  const { one, rows, call, IMERSAO, SUNSET_CONCHA, makeSession, reserve, setStandby, reservation, emails, uniquePrice, settleQueue } = fx;

  after(() => database.destroy());

  beforeEach(async () => {
    // Nenhum teste pode herdar uma transação aberta de outro.
    await Promise.all(pool.map((client) => client.query("rollback").catch(() => undefined)));
    await settleQueue();
    await setup.query(`delete from public.customer_access_throttle`);
  });

  // --- Operações, por sessão --------------------------------------------------

  type Outcome = { ok: true; value: Row } | { ok: false; error: string };

  /** O resultado de uma chamada, sem lançar: o teste compara os dois lados. */
  function settle(promise: Promise<pg.QueryResult>): Promise<Outcome> {
    return promise.then(
      (result) => ({ ok: true as const, value: result.rows[0]?.value }),
      (error: Error) => ({ ok: false as const, error: error.message }),
    );
  }

  async function standbyIdOf(reservationId: string) {
    return (await one(`select id from public.reservation_standby where reservation_id = $1::uuid and resolved_at is null`, [reservationId])).id as string;
  }

  function customerByCpf(client: pg.Client, booking: Booking, standbyId: string, sessionId: string) {
    return settle(client.query(
      `select public.customer_reschedule_reservation($1, $2, null, $3::uuid, $4::uuid) as value`,
      [booking.cpf, booking.code, standbyId, sessionId],
    ));
  }

  function customerByLink(client: pg.Client, token: string, standbyId: string, sessionId: string) {
    return settle(client.query(
      `select public.customer_reschedule_reservation(null, null, $1, $2::uuid, $3::uuid) as value`,
      [token, standbyId, sessionId],
    ));
  }

  function adminReschedule(client: pg.Client, reservationId: string, sessionId: string) {
    return settle(client.query(
      `select public.admin_reschedule_standby_same_price($1::uuid, $2::uuid, $3::uuid, null) as value`,
      [ADMIN, reservationId, sessionId],
    ));
  }

  function preReserve(client: pg.Client, sessionId: string, quantity: number) {
    return settle(client.query(
      `select public.create_pre_reservation($1::uuid, 'Cliente Novo Site', '52998224725', '+5561988887777', 'novo@teste.local', $2, null, gen_random_uuid()) as value`,
      [sessionId, quantity],
    ));
  }

  function throttle(client: pg.Client, address: string, code: string) {
    return settle(client.query(`select public.register_customer_access_attempt($1, null, $2, null) as value`, [address, code]));
  }

  async function generateLink(reservationId: string) {
    return (await call(`public.admin_generate_reservation_standby_link($1::uuid, $2::uuid)`, [ADMIN, reservationId])).token as string;
  }

  /** Reserva paga, em Stand-by, e a sua autorização. */
  async function parked(quantity: number, price: number) {
    const origin = await makeSession(IMERSAO.id, { price, capacity: 20 });
    const booking = await reserve(origin, quantity);
    await setStandby(booking.id);
    return { booking, origin, standbyId: await standbyIdOf(booking.id) };
  }

  async function occupied(sessionId: string) {
    return (await one(
      `select coalesce(sum(quantity), 0)::int as n from public.reservations
       where session_id = $1::uuid and (status = 'CONFIRMED' or (status = 'PRE_RESERVED' and expires_at > now()))`,
      [sessionId],
    )).n as number;
  }

  async function changes(reservationId: string) {
    return rows(`select * from public.reservation_session_changes where reservation_id = $1::uuid and origin = 'STANDBY_RESCHEDULE'`, [reservationId]);
  }

  // --- Observação de espera ---------------------------------------------------

  const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  const pidOf = new Map<pg.Client, Promise<number>>(
    pool.map((client) => [client, client.query(`select pg_backend_pid() as pid`).then((result) => result.rows[0].pid as number)]),
  );

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

  test("o banco de teste é um Postgres de verdade, com sessões independentes e a migration da etapa 5", async () => {
    const pids = await Promise.all(pool.map((client) => pidOf.get(client)!));
    assert.equal(new Set(pids).size, pool.length);
    assert.equal((await setup.query(`show transaction_isolation`)).rows[0].transaction_isolation, "read committed");
    const { n } = (await setup.query(`select count(*)::int as n from pg_proc where proname in ('register_customer_access_attempt', 'customer_reschedule_overview')`)).rows[0];
    assert.equal(n, 2);
  });

  // ===========================================================================
  // 1. A última vaga
  // ===========================================================================

  test("duas pessoas em Stand-by escolhem a última vaga ao mesmo tempo: a segunda espera e recebe 'sem vagas'", async () => {
    const price = uniquePrice();
    const first = await parked(2, price);
    const second = await parked(2, price);
    const target = await makeSession(SUNSET_CONCHA.id, { price, capacity: 3 });

    await A.query("begin");
    const won = await customerByCpf(A, first.booking, first.standbyId, target);
    assert.ok(won.ok, JSON.stringify(won));

    const contender = customerByCpf(B, second.booking, second.standbyId, target);
    await untilBlocked(B, "segunda pessoa");
    await A.query("commit");

    const lost = await contender;
    assert.ok(!lost.ok);
    assert.match(lost.error, /INSUFFICIENT_SPOTS/);

    assert.equal(await occupied(target), 2, "nunca acima da capacidade");
    assert.equal((await reservation(first.booking.id)).session_id, target);
    assert.equal((await reservation(second.booking.id)).status, "AWAITING_RESCHEDULE", "a perdedora continua em Stand-by, com a autorização aberta");
    assert.equal(await standbyIdOf(second.booking.id), second.standbyId);
    assert.equal((await emails(first.booking.id)).length, 1);
    assert.equal((await emails(second.booking.id)).length, 0, "quem não reagendou não tem e-mail");
  });

  test("cliente em Stand-by e compra nova pelo site disputam a última vaga, nas duas ordens", async () => {
    const price = uniquePrice();

    // O cliente chega primeiro: a compra nova espera e é recusada.
    const first = await parked(2, price);
    const target = await makeSession(SUNSET_CONCHA.id, { price, capacity: 2 });
    await A.query("begin");
    assert.ok((await customerByCpf(A, first.booking, first.standbyId, target)).ok);
    const purchase = preReserve(B, target, 1);
    await untilBlocked(B, "compra nova");
    await A.query("commit");
    const refused = await purchase;
    assert.ok(!refused.ok);
    assert.match(refused.error, /INSUFFICIENT_SPOTS/);
    assert.equal(await occupied(target), 2);

    // A compra nova chega primeiro: o cliente em Stand-by espera e é recusado.
    const second = await parked(2, price);
    const other = await makeSession(SUNSET_CONCHA.id, { price, capacity: 2 });
    await B.query("begin");
    assert.ok((await preReserve(B, other, 1)).ok);
    const late = customerByCpf(A, second.booking, second.standbyId, other);
    await untilBlocked(A, "cliente em Stand-by");
    await B.query("commit");
    const lateResult = await late;
    assert.ok(!lateResult.ok);
    assert.match(lateResult.error, /INSUFFICIENT_SPOTS/);
    assert.equal(await occupied(other), 1);
    assert.equal((await reservation(second.booking.id)).status, "AWAITING_RESCHEDULE");
  });

  // ===========================================================================
  // 2. Uma autorização, um reagendamento
  // ===========================================================================

  test("a mesma escolha em duas abas: a segunda espera e recebe a repetição — um histórico, um e-mail", async () => {
    const price = uniquePrice();
    const { booking, standbyId } = await parked(2, price);
    const target = await makeSession(SUNSET_CONCHA.id, { price, capacity: 6 });

    await A.query("begin");
    const first = await customerByCpf(A, booking, standbyId, target);
    assert.ok(first.ok);
    assert.equal(first.value.replayed, false);

    const second = customerByCpf(B, booking, standbyId, target);
    await untilBlocked(B, "segunda aba");
    await A.query("commit");

    const repeated = await second;
    assert.ok(repeated.ok, JSON.stringify(repeated));
    assert.equal(repeated.value.replayed, true);
    assert.equal(repeated.value.changeId, first.value.changeId);
    assert.equal((await changes(booking.id)).length, 1);
    assert.equal((await emails(booking.id)).length, 1);
    assert.equal(await occupied(target), 2, "a vaga é ocupada uma vez");
  });

  test("a mesma autorização, turmas diferentes — CPF numa aba, link na outra: só a primeira vale", async () => {
    const price = uniquePrice();
    const { booking, standbyId } = await parked(2, price);
    const token = await generateLink(booking.id);
    const first = await makeSession(SUNSET_CONCHA.id, { price, capacity: 6 });
    const second = await makeSession(IMERSAO.id, { price, capacity: 6 });

    await A.query("begin");
    assert.ok((await customerByCpf(A, booking, standbyId, first)).ok);
    const other = customerByLink(B, token, standbyId, second);
    await untilBlocked(B, "aba do link");
    await A.query("commit");

    const refused = await other;
    assert.ok(!refused.ok);
    assert.match(refused.error, /STANDBY_ALREADY_USED/);
    assert.equal((await reservation(booking.id)).session_id, first);
    assert.equal(await occupied(second), 0, "a turma recusada não perde vaga");
    assert.equal((await changes(booking.id)).length, 1);
    assert.equal((await emails(booking.id)).length, 1);
  });

  test("cliente e equipe reagendam a mesma reserva ao mesmo tempo: quem chega depois é recusado", async () => {
    const price = uniquePrice();
    const { booking, standbyId } = await parked(1, price);
    const byCustomer = await makeSession(SUNSET_CONCHA.id, { price, capacity: 6 });
    const byTeam = await makeSession(IMERSAO.id, { price, capacity: 6 });

    await A.query("begin");
    assert.ok((await customerByCpf(A, booking, standbyId, byCustomer)).ok);
    const team = adminReschedule(B, booking.id, byTeam);
    await untilBlocked(B, "equipe");
    await A.query("commit");

    const refused = await team;
    assert.ok(!refused.ok);
    assert.match(refused.error, /STANDBY_ALREADY_USED/);
    const [change] = await changes(booking.id);
    assert.equal(change.actor_type, "CUSTOMER");
    assert.equal((await emails(booking.id)).length, 1);

    // Na ordem inversa, o cliente é quem é recusado.
    const again = await parked(1, price);
    await B.query("begin");
    assert.ok((await adminReschedule(B, again.booking.id, byTeam)).ok);
    const customer = customerByCpf(A, again.booking, again.standbyId, byCustomer);
    await untilBlocked(A, "cliente");
    await B.query("commit");
    const late = await customer;
    assert.ok(!late.ok);
    assert.match(late.error, /STANDBY_ALREADY_USED/);
  });

  test("transação desfeita não deixa reagendamento, histórico nem e-mail — e a vaga continua livre", async () => {
    const price = uniquePrice();
    const { booking, standbyId } = await parked(2, price);
    const target = await makeSession(SUNSET_CONCHA.id, { price, capacity: 2 });

    await A.query("begin");
    assert.ok((await customerByCpf(A, booking, standbyId, target)).ok);
    const other = await parked(2, price);
    const waiting = customerByCpf(B, other.booking, other.standbyId, target);
    await untilBlocked(B, "segunda pessoa");
    await A.query("rollback");

    const result = await waiting;
    assert.ok(result.ok, "desfeita a primeira, a vaga é da segunda");
    assert.equal((await reservation(booking.id)).status, "AWAITING_RESCHEDULE");
    assert.equal(await standbyIdOf(booking.id), standbyId, "a autorização desfeita continua aberta");
    assert.equal((await changes(booking.id)).length, 0);
    assert.equal((await emails(booking.id)).length, 0);
    assert.equal((await emails(other.booking.id)).length, 1);
  });

  // ===========================================================================
  // 3. Limite de tentativas
  // ===========================================================================

  test("limite sob rajada: 30 tentativas simultâneas no mesmo código, de 6 sessões, deixam passar exatamente 10", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 30 }, (_, index) => throttle(pool[index % pool.length], `203.0.113.${index}`, "RAJADA01")),
    );
    const allowed = attempts.filter((attempt) => attempt.ok && attempt.value.allowed === true).length;
    assert.ok(attempts.every((attempt) => attempt.ok), "nenhuma tentativa falha por concorrência");
    assert.equal(allowed, 10);
    assert.equal((await one(`select max(attempts)::int as n from public.customer_access_throttle where bucket like 'credential:%'`)).n, 30);
  });

  test("limite: duas tentativas no mesmo balde se enfileiram — a segunda lê o que a primeira gravou", async () => {
    for (let attempt = 0; attempt < 9; attempt += 1) await throttle(setup, `198.51.100.${attempt}`, "FILA0001");

    await A.query("begin");
    const tenth = await throttle(A, "198.51.100.200", "FILA0001");
    assert.ok(tenth.ok && tenth.value.allowed === true);

    const eleventh = throttle(B, "198.51.100.201", "FILA0001");
    await untilBlocked(B, "décima primeira tentativa");
    await A.query("commit");

    const result = await eleventh;
    assert.ok(result.ok);
    assert.equal(result.value.allowed, false, "não existe janela em que as duas leem 'abaixo do limite'");
  });

  test("limite: uma tentativa desfeita não conta; a de outro código não espera", async () => {
    await A.query("begin");
    await throttle(A, "192.0.2.10", "DESFEITA");
    // Outro código, outro endereço: nenhum lock em comum.
    const free = await throttle(C, "192.0.2.11", "LIVRE001");
    assert.ok(free.ok && free.value.allowed === true);
    await A.query("rollback");
    const [row] = await rows(`select count(*)::int as n from public.customer_access_throttle`);
    assert.equal(row.n, 2, "só os baldes da tentativa confirmada");
  });

  // ===========================================================================
  // 4. Os três endpoints ao mesmo tempo
  // ===========================================================================

  /** O `rpc(nome, argumentos)` do supabase-js, sobre uma sessão própria do Postgres. */
  function rpcOn(client: pg.Client) {
    return async (name: string, args: Record<string, unknown>) => {
      const keys = Object.keys(args);
      try {
        const result = await client.query(
          `select * from public.${name}(${keys.map((key, index) => `${key} => $${index + 1}`).join(", ")})`,
          keys.map((key) => args[key]),
        );
        const scalar = result.fields.length === 1 && result.fields[0].name === name;
        return { data: scalar ? result.rows[0]?.[name] ?? null : result.rows, error: null };
      } catch (error) {
        return { data: null, error: { message: (error as Error).message, code: (error as { code?: string }).code } };
      }
    };
  }

  let cpfSequence = 500_000_000;
  function validCpf() {
    cpfSequence += 7919;
    const base = String(cpfSequence).padStart(9, "0").slice(-9);
    const digit = (digits: string) => {
      const sum = digits.split("").reduce((total, value, index) => total + Number(value) * (digits.length + 1 - index), 0);
      const remainder = (sum * 10) % 11;
      return remainder === 10 ? 0 : remainder;
    };
    const first = digit(base);
    return `${base}${first}${digit(`${base}${first}`)}`;
  }

  test("rajada distribuída: 30 tentativas simultâneas no mesmo código, entre consulta, tela e escolha, em 6 sessões — passam 10", async () => {
    const price = uniquePrice();
    const { booking, standbyId } = await parked(1, price);
    const target = await makeSession(SUNSET_CONCHA.id, { price, capacity: 6 });
    const attempts = Array.from({ length: 30 }, (_, index) => {
      const client = pool[index % pool.length];
      const rpc = rpcOn(client);
      const credential = { cpf: validCpf(), publicCode: booking.code };
      const address = `203.0.113.${index}`;
      switch (index % 3) {
        case 0:
          return handlePublicLookup({ rpc, lookup: async () => null }, credential, address);
        case 1:
          return handleSelfServiceOverview({ rpc }, { credential }, address);
        default:
          return handleSelfServiceReschedule({ rpc }, { credential, standbyId, sessionId: target }, address);
      }
    });
    const responses = await Promise.all(attempts);
    assert.equal(responses.filter((response) => response.status !== 429).length, 10);
    assert.ok(responses.every((response) => [404, 429].includes(response.status)), JSON.stringify(responses.map((response) => response.status)));
    assert.equal((await reservation(booking.id)).status, "AWAITING_RESCHEDULE");
  });

  test("rajada de um mesmo endereço com códigos diferentes, em 6 sessões: passam exatamente 30", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 45 }, (_, index) => throttle(pool[index % pool.length], "198.51.100.99", `VARRE${String(index).padStart(3, "0")}`)),
    );
    assert.ok(attempts.every((attempt) => attempt.ok), "nenhuma tentativa falha por concorrência");
    assert.equal(attempts.filter((attempt) => attempt.ok && attempt.value.allowed === true).length, 30);
  });

  test("origens e credenciais cruzadas ao mesmo tempo não se bloqueiam em ciclo", async () => {
    const addresses = ["192.0.2.1", "192.0.2.2", "192.0.2.3", ""];
    const codes = ["CRUZA001", "CRUZA002", "CRUZA003"];
    const attempts = await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        throttle(pool[index % pool.length], addresses[index % addresses.length], codes[(index * 7) % codes.length])),
    );
    const failures = attempts.filter((attempt) => !attempt.ok);
    assert.deepEqual(failures, [], "nenhum deadlock nem erro de serialização");
  });
}
