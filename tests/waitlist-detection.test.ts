/**
 * Lista de espera — fase 5: detecção automática de vagas.
 *
 * Roda contra o Postgres em memória (PGlite) com **todas** as migrations. As
 * vagas aparecem pelos caminhos reais — cancelamento, Stand-by, troca de turma,
 * pré-reserva vencida, fim da janela de pagamento, capacidade e reabertura — e
 * a varredura é chamada como o pg_cron a chamaria: `select waitlist_scan()`.
 *
 * O banco é um só para o arquivo inteiro, e a varredura olha todas as turmas
 * com inscrição: cada teste confere o estado da **própria** turma, não os totais
 * do relatório. Nada é enviado: os avisos ficam `QUEUED`.
 *
 * A concorrência com sessões reais do Postgres (duas varreduras, varredura ao
 * lado de uma pré-reserva) está em `waitlist-detection-concurrency.test.ts`.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { applyMigration, fullDatabase } from "./support/full-database.ts";
import { ADMIN, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

const MIGRATION = "202610260001_waitlist_detection.sql";
const PREVIOUS = "202610250002_waitlist_signup_email.sql";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const db = await fullDatabase();
const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
const { one, rows, call, IMERSAO, SUNSET_CONCHA, makeSession, reserve, setStandby, uniquePrice } = fx;

let sequence = 0;

async function settings(changes: { enabled?: boolean; grace?: number; interval?: number }) {
  await db.query(
    `update public.waitlist_settings set
       detection_enabled = coalesce($1, detection_enabled),
       opening_grace_seconds = coalesce($2, opening_grace_seconds),
       wave_interval_minutes = coalesce($3, wave_interval_minutes)`,
    [changes.enabled ?? null, changes.grace ?? null, changes.interval ?? null],
  );
}

async function scan() {
  return call(`public.waitlist_scan()`);
}

async function soldOut(options: { capacity?: number; experienceId?: string; startsIn?: string; price?: number } = {}) {
  const capacity = options.capacity ?? 2;
  const session = await makeSession(options.experienceId ?? IMERSAO.id, { price: options.price ?? uniquePrice(), capacity, startsIn: options.startsIn });
  const booking = await reserve(session, capacity);
  return { session, booking };
}

async function join(sessionId: string, quantity = 1) {
  sequence += 1;
  const email = `deteccao${sequence}@teste.local`;
  await db.exec(`delete from public.waitlist_throttle`);
  const answer = await call(`public.waitlist_join($1::uuid, $2, $3, $4, $5, null, '')`, [
    sessionId, `Pessoa Deteccao ${sequence}`, email, `+5561${String(920000000 + sequence)}`, quantity,
  ]);
  assert.equal(answer.status, "ACCEPTED");
  return one(`select * from public.waitlist_entries where session_id = $1::uuid and email = $2`, [sessionId, email]);
}

async function openingOf(sessionId: string) {
  return (await rows(`select * from public.waitlist_openings where session_id = $1::uuid and closed_at is null`, [sessionId]))[0] ?? null;
}

async function openingsOf(sessionId: string) {
  return rows(`select * from public.waitlist_openings where session_id = $1::uuid order by opened_at, id`, [sessionId]);
}

/** Avisos de vaga da turma: [entry_id, status], na ordem da fila. */
async function spotNotices(sessionId: string, status?: string) {
  return rows(
    `select n.entry_id, n.status, n.skip_reason, n.spots_at_queue, n.opening_id
     from public.waitlist_notifications n join public.waitlist_entries we on we.id = n.entry_id
     where we.session_id = $1::uuid and n.kind = 'SPOT_AVAILABLE' and ($2::text is null or n.status = $2)
     order by we.queue_sequence, n.created_at`,
    [sessionId, status ?? null],
  );
}

/** Simula o envio da fase 6: o aviso saiu e a inscrição conta mais um aviso. */
async function markSent(entryId: string, hoursAgo = 0) {
  await db.query(
    `update public.waitlist_notifications set status = 'SENT', sent_at = now() where entry_id = $1::uuid and kind = 'SPOT_AVAILABLE' and status = 'QUEUED'`,
    [entryId],
  );
  await db.query(
    `update public.waitlist_entries set notifications_sent = notifications_sent + 1, last_notified_at = now() - make_interval(hours => $2) where id = $1::uuid`,
    [entryId, hoursAgo],
  );
}

// Daqui em diante, ligada e sem carência, salvo onde o teste diz o contrário.
await settings({ enabled: true, grace: 0, interval: 30 });

// ===========================================================================
// 1. Interruptor
// ===========================================================================

test("interruptor: nasce desligado; desligado, a varredura não lê nem grava nada", async () => {
  const fresh = await fullDatabase();
  const local = await rescheduleFixtures(async (sql, params = []) => (await fresh.query(sql, params)).rows as Row[]);
  assert.deepEqual((await fresh.query(`select detection_enabled, wave_interval_minutes, opening_grace_seconds, max_sessions_per_scan from public.waitlist_settings`)).rows, [
    { detection_enabled: false, wave_interval_minutes: 30, opening_grace_seconds: 120, max_sessions_per_scan: 200 },
  ]);
  const session = await local.makeSession(local.IMERSAO.id, { price: local.uniquePrice(), capacity: 1 });
  const booking = await local.reserve(session, 1);
  await fresh.query(`select public.waitlist_join($1::uuid, 'Pessoa Desligada', 'off@teste.local', '+5561999990001', 1, null, '')`, [session]);
  await fresh.query(`select public.admin_cancel_reservation($1::uuid, $2::uuid, 'Libera a vaga')`, [ADMIN, booking.id]);
  const report = (await fresh.query<{ v: unknown }>(`select public.waitlist_scan() as v`)).rows[0].v;
  assert.deepEqual(report, { enabled: false });
  assert.equal((await fresh.query(`select * from public.waitlist_openings`)).rows.length, 0);
  assert.equal((await fresh.query(`select * from public.waitlist_notifications where kind = 'SPOT_AVAILABLE'`)).rows.length, 0);
  await fresh.close();
});

// ===========================================================================
// 2. De onde vêm as vagas
// ===========================================================================

test("vaga por cancelamento: abre a abertura e enfileira a onda", async () => {
  const { session, booking } = await soldOut({ capacity: 2 });
  const entry = await join(session);
  await scan();
  assert.equal(await openingOf(session), null, "sem vaga, sem abertura");

  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Cliente desistiu')`, [ADMIN, booking.id]);
  const report = await scan();
  assert.equal(report.enabled, true);
  const opening = await openingOf(session);
  assert.ok(opening);
  assert.equal(opening.spots_at_open, 2);
  assert.equal(opening.waves, 1);
  const notices = await spotNotices(session);
  assert.deepEqual(notices.map((notice) => [notice.entry_id, notice.status, notice.spots_at_queue]), [[entry.id, "QUEUED", 2]]);
});

test("vaga por Stand-by e por troca de turma", async () => {
  const standby = await soldOut({ capacity: 2 });
  await join(standby.session);
  await setStandby(standby.booking.id);
  await scan();
  assert.ok(await openingOf(standby.session));
  assert.equal((await spotNotices(standby.session)).length, 1);

  const moved = await soldOut({ capacity: 2 });
  await join(moved.session);
  const target = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 6 });
  await call(`public.admin_change_reservation_session($1::uuid, $2::uuid, $3::uuid, 'Pediu outro dia')`, [ADMIN, moved.booking.id, target]);
  await scan();
  assert.equal((await openingOf(moved.session))?.spots_at_open, 2);
  assert.equal((await spotNotices(moved.session)).length, 1);
});

test("vaga por pré-reserva vencida (sem checkout): detectada assim que vence", async () => {
  const session = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 1 });
  const held = await call(
    `public.create_pre_reservation($1::uuid, 'Pessoa Retendo', '52998224725', '+5561988880000', 'retendo@teste.local', 1, null, gen_random_uuid())`,
    [session],
  );
  await join(session);
  await scan();
  assert.equal(await openingOf(session), null);
  await db.query(`update public.reservations set created_at = now() - interval '3 hours', expires_at = now() - interval '1 second' where id = $1::uuid`, [held.reservationId]);
  await scan();
  assert.ok(await openingOf(session), "a vaga vale no instante em que a retenção vence, antes de qualquer escrita");
});

test("janela de pagamento: a vaga não 'aparece' entre o vencimento e o hold, só quando o hold acaba", async () => {
  const session = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 1 });
  const held = await call(
    `public.create_pre_reservation($1::uuid, 'Pessoa Pagando', '52998224725', '+5561988881111', 'pagando@teste.local', 1, null, gen_random_uuid())`,
    [session],
  );
  assert.equal(await call(`public.attach_payment_checkout($1::uuid, 'INFINITEPAY', 'ref', 'https://checkout.teste/1')`, [held.reservationId]), true);
  await join(session);

  // Venceu, tem checkout e o cron ainda não abriu a janela de pagamento:
  // available_spots já devolve a vaga, a detecção não.
  await db.query(`update public.reservations set created_at = now() - interval '3 hours', expires_at = now() - interval '1 second' where id = $1::uuid`, [held.reservationId]);
  assert.equal(await call(`public.available_spots($1::uuid)`, [session]), 1);
  assert.equal(await call(`public.waitlist_detection_spots($1::uuid)`, [session]), 0);
  await scan();
  assert.equal(await openingOf(session), null, "nenhuma abertura pela vaga falsa");

  // O cron abre a janela: a pré-reserva volta a ocupar.
  await call(`public.expire_pre_reservations()`);
  assert.equal(await call(`public.available_spots($1::uuid)`, [session]), 0);
  await scan();
  assert.equal(await openingOf(session), null);

  // A janela acaba sem pagamento: agora a vaga é real.
  await db.query(`update public.reservations set expires_at = now() - interval '1 second' where id = $1::uuid`, [held.reservationId]);
  assert.equal(await call(`public.waitlist_detection_spots($1::uuid)`, [session]), 1);
  await scan();
  assert.ok(await openingOf(session));
});

test("vaga por aumento de capacidade e por reabertura da turma", async () => {
  const grown = await soldOut({ capacity: 2 });
  await join(grown.session);
  const row = await one(`select * from public.sessions where id = $1::uuid`, [grown.session]);
  await call(
    `public.admin_update_session($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5, $6, 4, 'OPEN'::public.session_status, null)`,
    [ADMIN, grown.session, row.experience_id, row.starts_at, row.duration_minutes, row.price_cents],
  );
  await scan();
  assert.equal((await openingOf(grown.session))?.spots_at_open, 2);

  const closed = await soldOut({ capacity: 2 });
  await join(closed.session);
  await db.query(`update public.sessions set status = 'CLOSED' where id = $1::uuid`, [closed.session]);
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Libera com a turma fechada')`, [ADMIN, closed.booking.id]);
  await scan();
  assert.equal(await openingOf(closed.session), null, "turma fechada não abre aviso, mesmo com vaga");
  await db.query(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [closed.session]);
  await scan();
  assert.ok(await openingOf(closed.session), "reaberta, a vaga é detectada");
});

// ===========================================================================
// 3. Quem é avisado
// ===========================================================================

test("régua: só quem cabe nas vagas, na ordem da fila, até max(5, 3 × vagas)", async () => {
  const { session, booking } = await soldOut({ capacity: 4 });
  const queue = [];
  for (const quantity of [2, 1, 3, 1, 1, 1, 1, 1, 1]) queue.push(await join(session, quantity));
  // Uma vaga: cancelamento parcial não existe, então a turma fica com 1 de 4
  // livres trocando a reserva por uma menor.
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Troca por menor')`, [ADMIN, booking.id]);
  const filler = await reserve(session, 3);
  assert.ok(filler.id);
  assert.equal(await call(`public.waitlist_detection_spots($1::uuid)`, [session]), 1);

  await scan();
  const notices = await spotNotices(session);
  const expected = queue.filter((entry) => entry.quantity <= 1).slice(0, 5).map((entry) => entry.id);
  assert.deepEqual(notices.map((notice) => notice.entry_id), expected, "grupos de 2 e 3 ficam de fora; os cinco primeiros de 1, na ordem");
  assert.ok(notices.every((notice) => notice.spots_at_queue === 1));
});

test("idempotência: varrer de novo não duplica abertura nem aviso", async () => {
  const { session, booking } = await soldOut({ capacity: 2 });
  await join(session);
  await join(session);
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Libera')`, [ADMIN, booking.id]);
  for (let index = 0; index < 4; index += 1) await scan();
  assert.equal((await openingsOf(session)).length, 1);
  assert.equal((await spotNotices(session)).length, 2);
  await assert.rejects(
    db.query(`insert into public.waitlist_openings (session_id, spots_at_open) values ($1::uuid, 1)`, [session]),
    /waitlist_openings_open_session_key/,
    "uma abertura por turma",
  );
});

test("ondas: a próxima só depois do intervalo, e vai para os seguintes da fila", async () => {
  const { session, booking } = await soldOut({ capacity: 1 });
  const queue = [];
  for (let index = 0; index < 8; index += 1) queue.push(await join(session));
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Libera')`, [ADMIN, booking.id]);
  await scan();
  assert.deepEqual((await spotNotices(session)).map((notice) => notice.entry_id), queue.slice(0, 5).map((entry) => entry.id));
  await scan();
  assert.equal((await spotNotices(session)).length, 5, "dentro do intervalo, nenhuma onda nova");

  await db.query(`update public.waitlist_openings set last_wave_at = now() - interval '31 minutes' where session_id = $1::uuid and closed_at is null`, [session]);
  await scan();
  const notices = await spotNotices(session);
  assert.deepEqual(notices.map((notice) => notice.entry_id), queue.map((entry) => entry.id), "a segunda onda chega aos três restantes");
  assert.equal((await openingOf(session))?.waves, 2);
});

test("oscilação: a vaga some e volta — a abertura fecha, os avisos parados são descartados e uma nova abertura recomeça", async () => {
  const { session, booking } = await soldOut({ capacity: 1 });
  const first = await join(session);
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Libera')`, [ADMIN, booking.id]);
  await scan();
  const opening = await openingOf(session);
  assert.equal((await spotNotices(session, "QUEUED")).length, 1);

  // Alguém reserva a vaga: a abertura fecha e o aviso ainda na fila é descartado.
  const taker = await reserve(session, 1);
  await scan();
  assert.equal(await openingOf(session), null);
  const closedOpening = await one(`select * from public.waitlist_openings where id = $1::uuid`, [opening.id]);
  assert.equal(closedOpening.closed_reason, "NO_SPOTS");
  assert.deepEqual((await spotNotices(session)).map((notice) => [notice.status, notice.skip_reason]), [["SKIPPED", "OPENING_CLOSED"]]);

  // A vaga volta: nova abertura, novo aviso para a mesma pessoa (nada saiu antes).
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Libera de novo')`, [ADMIN, taker.id]);
  await scan();
  assert.equal((await openingsOf(session)).length, 2);
  assert.deepEqual((await spotNotices(session, "QUEUED")).map((notice) => notice.entry_id), [first.id]);
});

test("limites D3: quem foi avisado há menos de 12 horas espera; com 3 avisos, nunca mais", async () => {
  const { session, booking } = await soldOut({ capacity: 1 });
  const entry = await join(session);
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Libera')`, [ADMIN, booking.id]);
  await scan();
  await markSent(entry.id); // a fase 6 enviou agora

  const reopen = async () => {
    const taker = await reserve(session, 1);
    await scan(); // fecha
    await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Libera')`, [ADMIN, taker.id]);
    await scan(); // abre de novo
  };
  await reopen();
  assert.equal((await spotNotices(session, "QUEUED")).length, 0, "avisado agora há pouco: 12 horas de intervalo");

  await db.query(`update public.waitlist_entries set last_notified_at = now() - interval '13 hours' where id = $1::uuid`, [entry.id]);
  await reopen();
  assert.equal((await spotNotices(session, "QUEUED")).length, 1, "passadas 12 horas, pode ser avisado de novo");

  await markSent(entry.id, 13);
  await db.query(`update public.waitlist_entries set notifications_sent = 3 where id = $1::uuid`, [entry.id]);
  await reopen();
  assert.equal((await spotNotices(session, "QUEUED")).length, 0, "três avisos: nunca mais");
});

test("carência: a primeira onda espera; vaga que some antes não gera aviso", async () => {
  await settings({ grace: 120 });
  try {
    const quick = await soldOut({ capacity: 1 });
    await join(quick.session);
    await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Libera')`, [ADMIN, quick.booking.id]);
    await scan();
    assert.ok(await openingOf(quick.session));
    assert.equal((await spotNotices(quick.session)).length, 0, "dentro da carência");
    await reserve(quick.session, 1); // reservou na hora
    await scan();
    assert.equal(await openingOf(quick.session), null);
    assert.equal((await spotNotices(quick.session)).length, 0, "nenhum aviso para uma vaga que durou segundos");

    const stable = await soldOut({ capacity: 1 });
    await join(stable.session);
    await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Libera')`, [ADMIN, stable.booking.id]);
    await scan();
    await db.query(`update public.waitlist_openings set opened_at = now() - interval '3 minutes' where session_id = $1::uuid and closed_at is null`, [stable.session]);
    await scan();
    assert.equal((await spotNotices(stable.session)).length, 1, "passada a carência, a onda sai");
  } finally {
    await settings({ grace: 0 });
  }
});

// ===========================================================================
// 4. Mudanças de status e manutenção
// ===========================================================================

test("turma que deixa de aceitar reserva: a abertura fecha e os avisos parados são descartados", async () => {
  for (const change of [
    `update public.sessions set status = 'CANCELLED' where id = $1::uuid`,
    `update public.sessions set status = 'CLOSED' where id = $1::uuid`,
    `update public.sessions set starts_at = now() - interval '1 minute' where id = $1::uuid`,
  ]) {
    const { session, booking } = await soldOut({ capacity: 1 });
    await join(session);
    await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Libera')`, [ADMIN, booking.id]);
    await scan();
    const opening = await openingOf(session);
    assert.ok(opening, change);
    await db.query(change, [session]);
    await scan();
    const after = await one(`select * from public.waitlist_openings where id = $1::uuid`, [opening.id]);
    assert.ok(after.closed_at, change);
    assert.equal(after.closed_reason, "SESSION_UNAVAILABLE", change);
    assert.ok((await spotNotices(session)).every((notice) => notice.status === "SKIPPED"), change);
  }
});

test("experiência despublicada: nenhuma abertura enquanto não volta", async () => {
  const experience = await one(`select id from public.experiences where slug = 'remada-nascer-do-sol'`);
  const { session, booking } = await soldOut({ capacity: 1, experienceId: experience.id });
  await join(session);
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Libera')`, [ADMIN, booking.id]);
  await db.query(`update public.experiences set status = 'DRAFT' where id = $1::uuid`, [experience.id]);
  try {
    await scan();
    assert.equal(await openingOf(session), null);
  } finally {
    await db.query(`update public.experiences set status = 'PUBLISHED' where id = $1::uuid`, [experience.id]);
  }
  await scan();
  assert.ok(await openingOf(session));
});

test("manutenção: turma passada encerra a inscrição; reserva paga com o mesmo e-mail converte", async () => {
  const past = await soldOut({ capacity: 1 });
  const expiring = await join(past.session);
  await db.query(`update public.sessions set starts_at = now() - interval '1 hour' where id = $1::uuid`, [past.session]);

  const { session, booking } = await soldOut({ capacity: 1 });
  const converting = await join(session);
  await db.query(`update public.waitlist_entries set created_at = now() - interval '1 hour' where id = $1::uuid`, [converting.id]);
  await setStandby(booking.id);
  const created = await call(
    `public.create_pre_reservation($1::uuid, $2, '52998224725', $3, $4, 1, null, gen_random_uuid())`,
    [session, converting.full_name, converting.phone, converting.email],
  );
  await call(`public.confirm_reservation_payment($1::uuid, 'INFINITEPAY', $2, $3, 'https://recibo.teste/1', '{}'::jsonb)`, [created.reservationId, `tx-${created.reservationId}`, created.totalCents]);

  const report = await scan();
  assert.ok(report.expiredEntries >= 1 && report.convertedEntries >= 1, JSON.stringify(report));
  assert.equal((await one(`select status from public.waitlist_entries where id = $1::uuid`, [expiring.id])).status, "EXPIRED");
  const converted = await one(`select status, converted_reservation_id from public.waitlist_entries where id = $1::uuid`, [converting.id]);
  assert.deepEqual([converted.status, converted.converted_reservation_id], ["CONVERTED", created.reservationId]);
});

// ===========================================================================
// 5. Nada sai, nada de reserva muda
// ===========================================================================

test("os avisos ficam na fila: o envio da fase 3 só pega a confirmação da inscrição", async () => {
  const { session, booking } = await soldOut({ capacity: 1 });
  await join(session);
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Libera')`, [ADMIN, booking.id]);
  await scan();
  const notice = await one(
    `select n.id from public.waitlist_notifications n join public.waitlist_entries we on we.id = n.entry_id where we.session_id = $1::uuid and n.kind = 'SPOT_AVAILABLE'`,
    [session],
  );
  for (let round = 0; round < 30; round += 1) {
    const claims = await call(`public.claim_pending_waitlist_emails(25, 6, 2, 1380)`);
    assert.ok(!claims.some((claim: Row) => claim.notificationId === notice.id));
    if (!claims.length) break;
  }
  assert.equal(await call(`public.waitlist_notification_take($1::uuid, 6, 2, 1380)`, [notice.id]), null);
  assert.equal((await one(`select status, attempts from public.waitlist_notifications where id = $1::uuid`, [notice.id])).status, "QUEUED");
});

test("a varredura não muda reservas, pagamentos, sessões nem Stand-by", async () => {
  const { session, booking } = await soldOut({ capacity: 2, experienceId: SUNSET_CONCHA.id });
  await join(session);
  await setStandby(booking.id);
  const digest = async () => (await one(
    `select md5(string_agg(t, '|' order by t)) as h from (
       select r::text as t from public.reservations r
       union all select p::text from public.payment_events p
       union all select s::text from public.sessions s
       union all select x::text from public.reservation_standby x) z`,
  )).h;
  const before = await digest();
  await scan();
  await scan();
  assert.equal(await digest(), before);
  assert.ok(await openingOf(session));
});

// ===========================================================================
// 6. Migration e scripts
// ===========================================================================

const NEW_FUNCTIONS = ["waitlist_detection_spots(uuid)", "waitlist_scan()", "waitlist_scan_session(uuid,integer,integer)"];

test("migration: aditiva, sem trigger nem agendamento, e nada executável pela API", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  const snapshot = async () => (await before.query<{ name: string; src: string }>(
    `select p.oid::regprocedure::text as name, md5(p.prosrc) as src from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`,
  )).rows;
  const old = await snapshot();
  await applyMigration(before, MIGRATION);
  const current = new Map((await snapshot()).map((row) => [row.name, row.src]));
  for (const row of old) assert.equal(current.get(row.name), row.src, `${row.name} não pode mudar`);
  assert.deepEqual([...current.keys()].filter((name) => !old.some((row) => row.name === name)).sort(), NEW_FUNCTIONS);
  await applyMigration(before, MIGRATION);
  assert.equal((await before.query(`select * from public.waitlist_settings`)).rows.length, 1, "idempotente: uma linha de configuração");

  for (const fn of NEW_FUNCTIONS) {
    const row = (await before.query<Row>(
      `select has_function_privilege('anon', $1, 'EXECUTE') as a, has_function_privilege('authenticated', $1, 'EXECUTE') as b,
              has_function_privilege('service_role', $1, 'EXECUTE') as c, p.prosecdef as definer
       from pg_proc p where p.oid = $1::regprocedure`, [`public.${fn}`])).rows[0];
    assert.deepEqual([row.a, row.b, row.c, row.definer], [false, false, false, true], fn);
  }
  const table = (await before.query<Row>(
    `select c.relrowsecurity as rls, has_table_privilege('service_role', c.oid, 'SELECT') as s, has_table_privilege('anon', c.oid, 'SELECT') as a
     from pg_class c where c.oid = 'public.waitlist_settings'::regclass`)).rows[0];
  assert.deepEqual([table.rls, table.s, table.a], [true, false, false]);

  const code = source(`supabase/migrations/${MIGRATION}`).split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
  assert.doesNotMatch(code, /cron\.schedule|pg_net|net\.http|create extension/i);
  assert.doesNotMatch(code, /create trigger (?!waitlist_settings_set_updated_at)/i);
  assert.doesNotMatch(code, /(insert into|update|delete from) public\.(reservations|sessions|payment_events|reservation_standby)\b/i);
  await before.close();
});

const PREFLIGHT = source("supabase/diagnostics/waitlist_detection_preflight.sql");
const POSTCHECK = source("supabase/diagnostics/waitlist_detection_postcheck.sql");
const ROLLBACK = source("supabase/rollback/202610260001_waitlist_detection.rollback.sql");
const SCHEDULE = source("supabase/maintenance/waitlist_scan_schedule.sql");
const REPORT = source("supabase/diagnostics/waitlist_detection_report.sql");

type Check = { check_name: string; result: string; status: string };

async function report(database: { query: (sql: string) => Promise<{ rows: unknown[] }> }, sql: string) {
  return new Map(((await database.query(sql)).rows as Check[]).map((row) => [row.check_name, row]));
}

test("preflight e postcheck: aprovam o banco do repositório, nas duas pontas", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  // Como em produção: o pg_cron já expira as pré-reservas.
  await before.exec(`insert into cron.job (jobid, jobname, schedule, active) values (1, 'expire-alma-azul-pre-reservations', '* * * * *', true)`);
  const pre = await report(before, PREFLIGHT);
  for (const [name, row] of pre) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  await assert.rejects(before.query(POSTCHECK), /does not exist/);
  await applyMigration(before, MIGRATION);
  const post = await report(before, POSTCHECK);
  for (const [name, row] of post) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  assert.equal(post.get("FUNCOES_NOVAS_COM_A_DEFINICAO_DO_REPOSITORIO")?.result, "3 de 3");
  assert.match(post.get("INTERRUPTOR_DA_DETECCAO")!.result, /^desligado/);
  for (const count of ["ASSINATURA_DAS_FUNCOES_EXISTENTES", "INSCRICOES_POR_STATUS", "ABERTURAS", "FILA_DA_LISTA_POR_STATUS", "RESERVAS_POR_STATUS"]) {
    assert.equal(post.get(count)?.result, pre.get(count)?.result, count);
  }

  // Ligada e agendada mais tarde: aviso, não falha.
  await before.exec(`update public.waitlist_settings set detection_enabled = true`);
  await before.exec(`insert into cron.job (jobid, jobname, schedule, active) values (2, 'waitlist-scan', '* * * * *', true)`);
  const later = await report(before, POSTCHECK);
  assert.equal(later.get("INTERRUPTOR_DA_DETECCAO")?.status, "ATENCAO");
  assert.equal(later.get("AGENDAMENTO_DA_VARREDURA")?.status, "ATENCAO");
  assert.equal(later.get("WAITLIST_DETECCAO_POSTCHECK_OK")?.status, "OK");
  // O relatório só lê e roda.
  await before.query(REPORT);
  await before.close();
});

test("preflight: reprova se a régua da fase 1 estiver diferente do repositório", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  await before.exec(`create or replace function public.waitlist_wave_size(p_spots integer) returns integer language sql immutable security definer set search_path = public as $$ select 99 $$`);
  const pre = await report(before, PREFLIGHT);
  assert.equal(pre.get("FUNCOES_QUE_A_VARREDURA_CHAMA")?.status, "FALHOU");
  assert.match(pre.get("FUNCOES_QUE_A_VARREDURA_CHAMA")!.result, /waitlist_wave_size=DIFERENTE/);
  assert.equal(pre.get("WAITLIST_DETECCAO_PREFLIGHT_OK")?.status, "FALHOU");
  await before.close();
});

test("rollback: remove só o que a migration criou; aberturas e avisos ficam; reaplicar devolve tudo, desligado", async () => {
  const database = await fullDatabase();
  const local = await rescheduleFixtures(async (sql, params = []) => (await database.query(sql, params)).rows as Row[]);
  const session = await local.makeSession(local.IMERSAO.id, { price: local.uniquePrice(), capacity: 1 });
  const booking = await local.reserve(session, 1);
  await database.query(`select public.waitlist_join($1::uuid, 'Pessoa Rollback', 'rb5@teste.local', '+5561999990005', 1, null, '')`, [session]);
  await database.query(`select public.admin_cancel_reservation($1::uuid, $2::uuid, 'Libera')`, [ADMIN, booking.id]);
  await database.exec(`update public.waitlist_settings set detection_enabled = true, opening_grace_seconds = 0`);
  await database.query(`select public.waitlist_scan()`);
  const functions = async () => (await database.query<{ name: string; src: string }>(`select p.oid::regprocedure::text as name, md5(p.prosrc) as src from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`)).rows;
  const beforeFunctions = await functions();

  await database.exec(ROLLBACK);
  const after = await functions();
  assert.deepEqual(beforeFunctions.filter((row) => !after.some((kept) => kept.name === row.name)).map((row) => row.name).sort(), NEW_FUNCTIONS);
  for (const row of after) assert.equal(row.src, beforeFunctions.find((old) => old.name === row.name)?.src, row.name);
  assert.equal((await database.query(`select * from public.waitlist_openings`)).rows.length, 1);
  assert.equal((await database.query(`select * from public.waitlist_notifications where kind = 'SPOT_AVAILABLE'`)).rows.length, 1);
  await assert.rejects(database.query(POSTCHECK), /does not exist/);

  await applyMigration(database, MIGRATION);
  assert.equal((await database.query<{ d: boolean }>(`select detection_enabled as d from public.waitlist_settings`)).rows[0].d, false);
  assert.equal((await report(database, POSTCHECK)).get("WAITLIST_DETECCAO_POSTCHECK_OK")?.status, "OK");
  await database.close();
});

test("agendamento: script à parte, fora das migrations, que não liga a detecção", () => {
  assert.ok(!readdirSync(new URL("../supabase/migrations/", import.meta.url)).some((file) => /waitlist.*schedul/i.test(file)));
  assert.match(SCHEDULE, /select cron\.schedule\('waitlist-scan', '\* \* \* \* \*', 'select public\.waitlist_scan\(\);'\);/);
  const code = SCHEDULE.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
  assert.doesNotMatch(code, /detection_enabled\s*=\s*true/, "agendar não liga o interruptor");
  assert.doesNotMatch(source(`supabase/migrations/${MIGRATION}`).split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n"), /detection_enabled boolean not null default true/);
});
