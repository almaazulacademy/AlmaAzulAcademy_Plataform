/**
 * Lista de espera — fase 6: envio do aviso de vaga.
 *
 * Roda contra o Postgres em memória (PGlite) com **todas** as migrations. As
 * vagas aparecem pelos caminhos reais, a varredura da fase 5 enfileira os
 * avisos, e o envio é feito por `sendPendingWaitlistSpotEmails` com o provedor
 * falso que segue o contrato de idempotência do Resend: nenhum e-mail sai, e
 * `delivered` conta o que chegaria a uma caixa de entrada.
 *
 * O banco é um só para o arquivo, e a fila também: cada teste confere os
 * próprios destinatários, não os totais.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { EmailProviderError } from "../lib/email/email-provider.ts";
import { applyMigration, fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";
import { ADMIN, fakeResend, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";
import {
  buildWaitlistSpotEmail,
  parseWaitlistSpotEmailData,
  waitlistReserveUrl,
  WAITLIST_SPOT_NOT_GUARANTEED_NOTE,
} from "../lib/waitlist/spot-email-content.ts";
import {
  createWaitlistSpotQueue,
  isWaitlistNotifyEnabled,
  sendPendingWaitlistSpotEmails,
  waitlistSpotIdempotencyKey,
  type WaitlistSpotRuntime,
} from "../lib/waitlist/spot-email.ts";

const MIGRATION = "202610260002_waitlist_spot_email.sql";
const PREVIOUS = "202610260001_waitlist_detection.sql";
const ORIGIN = "https://www.almaazulacademy.com.br";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function code(path: string) {
  return source(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "").split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
}

const db = await fullDatabase();
const admin = createPgliteAdmin(db);
const rpc = (name: string, args: Record<string, unknown>) => admin.client.rpc(name, args);
const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
const { one, rows, call, IMERSAO, makeSession, reserve, setStandby, uniquePrice } = fx;

await db.exec(`update public.waitlist_settings set detection_enabled = true, opening_grace_seconds = 0, wave_interval_minutes = 30`);

let sequence = 0;

function runtime(provider = fakeResend()): WaitlistSpotRuntime & { provider: ReturnType<typeof fakeResend> } {
  return { queue: createWaitlistSpotQueue({ rpc }), provider, origin: ORIGIN, pause: async () => undefined };
}

/** Esvazia a fila de avisos de vaga, em quantas rodadas forem precisas. */
async function drain(active: WaitlistSpotRuntime) {
  let total = { processed: 0, sent: 0 };
  for (let round = 0; round < 20; round += 1) {
    const report = await sendPendingWaitlistSpotEmails(active);
    assert.equal(report.outcome, "PROCESSED", report.errorCode);
    total = { processed: total.processed + report.processed, sent: total.sent + report.sent };
    if (report.processed === 0) break;
  }
  return total;
}

async function soldOut(capacity = 1, price = uniquePrice()) {
  const session = await makeSession(IMERSAO.id, { price, capacity });
  const booking = await reserve(session, capacity);
  return { session, booking, price };
}

async function join(sessionId: string, quantity = 1, name?: string) {
  sequence += 1;
  const email = `aviso${sequence}@teste.local`;
  await db.exec(`delete from public.waitlist_throttle`);
  const answer = await call(`public.waitlist_join($1::uuid, $2, $3, $4, $5, null, '')`, [
    sessionId, name ?? `Pessoa Aviso ${sequence}`, email, `+5561${String(950000000 + sequence)}`, quantity,
  ]);
  assert.equal(answer.status, "ACCEPTED");
  return one(`select * from public.waitlist_entries where session_id = $1::uuid and email = $2`, [sessionId, email]);
}

async function cancel(reservationId: string) {
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Libera a vaga')`, [ADMIN, reservationId]);
}

async function scan() {
  return call(`public.waitlist_scan()`);
}

async function spotOf(entryId: string) {
  return (await rows(`select * from public.waitlist_notifications where entry_id = $1::uuid and kind = 'SPOT_AVAILABLE' order by created_at desc`, [entryId]))[0] ?? null;
}

async function entry(entryId: string) {
  return one(`select * from public.waitlist_entries where id = $1::uuid`, [entryId]);
}

async function release(notificationId: string) {
  await db.query(`update public.waitlist_notifications set next_attempt_at = now() - interval '1 second' where id = $1::uuid`, [notificationId]);
}

// ===========================================================================
// 1. Variável e conteúdo
// ===========================================================================

test("variável: só o valor exato true liga o envio", () => {
  assert.equal(isWaitlistNotifyEnabled({}), false);
  for (const value of ["", "1", "yes", "false"]) assert.equal(isWaitlistNotifyEnabled({ WAITLIST_NOTIFY_ENABLED: value }), false, value);
  assert.equal(isWaitlistNotifyEnabled({ WAITLIST_NOTIFY_ENABLED: " TRUE " }), true);
  assert.equal(isWaitlistNotifyEnabled({ WAITLIST_SIGNUP_ENABLED: "true", WAITLIST_PUBLIC_ENABLED: "true" }), false);
  assert.equal(isWaitlistNotifyEnabled({ NEXT_PUBLIC_WAITLIST_NOTIFY_ENABLED: "true" }), false);
});

test("e-mail: vaga não garantida, depende do pagamento, link para a turma certa e para sair da lista", () => {
  const data = parseWaitlistSpotEmailData({
    fullName: "Bia <b>Mar</b> Azul", email: "BIA@X.COM", quantity: 2, sessionId: "6c212186-5809-4eb6-8f52-5c3bc6570d33",
    experienceTitle: "Imersão Paranoá", startsAt: "2026-11-07T12:00:00.000Z", baseName: "Lago Norte", priceCents: 18000, remainingSpots: 2, cancelToken: "a".repeat(64),
  });
  assert.ok(data);
  const email = buildWaitlistSpotEmail(data, ORIGIN);
  assert.equal(email.to, "bia@x.com");
  assert.match(email.subject, /^Abriu vaga: Imersão Paranoá, .* às 09:00/);
  assert.match(email.text, /A VAGA NÃO ESTÁ GARANTIDA/);
  assert.ok(email.text.includes(WAITLIST_SPOT_NOT_GUARANTEED_NOTE));
  assert.match(email.text, /fica com quem concluir primeiro a reserva e o pagamento/);
  assert.match(email.text, /A reserva só é confirmada depois de o pagamento ser aprovado/);
  assert.match(email.text, /Você pediu: 2 pessoas/);
  assert.ok(email.text.includes(`Reservar esta turma: ${ORIGIN}/reservar/6c212186-5809-4eb6-8f52-5c3bc6570d33`));
  assert.ok(email.html.includes(waitlistReserveUrl("6c212186-5809-4eb6-8f52-5c3bc6570d33", ORIGIN)));
  assert.ok(email.text.includes(`${ORIGIN}/lista-de-espera#t=${"a".repeat(64)}`));
  assert.doesNotMatch(email.html, /<b>Mar<\/b>/, "o nome é escapado");
  assert.doesNotMatch(email.text + email.html, /reserva confirmada|vaga garantida para você|cpf/i);

  for (const broken of [{ sessionId: "x" }, { cancelToken: "y" }, { quantity: 0 }, { email: "" }, { startsAt: "ontem" }]) {
    assert.equal(parseWaitlistSpotEmailData({ ...data, ...broken }), null, JSON.stringify(broken));
  }
});

// ===========================================================================
// 2. De ponta a ponta
// ===========================================================================

test("de ponta a ponta: a vaga aparece, a varredura enfileira e o aviso sai, na ordem da fila, com o link da turma", async () => {
  const { session, booking } = await soldOut(1);
  const queue: Row[] = [];
  for (let index = 0; index < 3; index += 1) queue.push(await join(session));
  await cancel(booking.id);
  await scan();

  const active = runtime();
  await drain(active);
  const mine = active.provider.delivered.filter((message) => queue.some((item) => item.email === message.to));
  assert.deepEqual(mine.map((message) => message.to), queue.map((item) => item.email), "um aviso para cada um, na ordem da fila");
  for (const message of mine) assert.ok(message.text.includes(`${ORIGIN}/reservar/${session}`));

  for (const item of queue) {
    const notice = await spotOf(item.id);
    assert.equal(notice.status, "SENT");
    assert.equal(notice.frozen_message, null);
    const after = await entry(item.id);
    assert.equal(after.notifications_sent, 1);
    assert.ok(after.last_notified_at);
    assert.equal(mine.find((message) => message.to === item.email)?.idempotencyKey, waitlistSpotIdempotencyKey(notice.id, 1));
  }
  // Opção A: a vaga continua livre para qualquer um.
  assert.equal(await call(`public.available_spots($1::uuid)`, [session]), 1);
  assert.equal(await call(`public.waitlist_detection_spots($1::uuid)`, [session]), 1);
});

test("cada origem de vaga leva ao aviso: Stand-by, troca de turma, pré-reserva vencida e capacidade", async () => {
  const active = runtime();
  const cases: Array<[string, () => Promise<{ session: string; email: string }>]> = [
    ["Stand-by", async () => {
      const { session, booking } = await soldOut(1);
      const item = await join(session);
      await setStandby(booking.id);
      return { session, email: item.email };
    }],
    ["troca de turma", async () => {
      const { session, booking } = await soldOut(1);
      const item = await join(session);
      const target = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 4 });
      await call(`public.admin_change_reservation_session($1::uuid, $2::uuid, $3::uuid, 'Outro dia')`, [ADMIN, booking.id, target]);
      return { session, email: item.email };
    }],
    ["pré-reserva vencida", async () => {
      const session = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 1 });
      const held = await call(`public.create_pre_reservation($1::uuid, 'Pessoa Retendo', '52998224725', '+5561988880000', 'retendo-aviso@teste.local', 1, null, gen_random_uuid())`, [session]);
      const item = await join(session);
      await db.query(`update public.reservations set created_at = now() - interval '3 hours', expires_at = now() - interval '1 second' where id = $1::uuid`, [held.reservationId]);
      return { session, email: item.email };
    }],
    ["capacidade", async () => {
      const { session } = await soldOut(1);
      const item = await join(session);
      await db.query(`update public.sessions set capacity = 2 where id = $1::uuid`, [session]);
      return { session, email: item.email };
    }],
  ];
  for (const [name, build] of cases) {
    const { session, email } = await build();
    await scan();
    await drain(active);
    const received = active.provider.deliveredTo(email);
    assert.equal(received.length, 1, name);
    assert.ok(received[0].text.includes(`/reservar/${session}`), name);
  }
});

// ===========================================================================
// 3. Conferência antes do envio
// ===========================================================================

test("vaga perdida antes do envio: o aviso é descartado e nada sai", async () => {
  const { session, booking } = await soldOut(1);
  const item = await join(session);
  await cancel(booking.id);
  await scan();
  await reserve(session, 1); // alguém reservou antes de o aviso sair
  const active = runtime();
  await drain(active);
  assert.equal(active.provider.deliveredTo(item.email).length, 0);
  const notice = await spotOf(item.id);
  assert.deepEqual([notice.status, notice.skip_reason], ["SKIPPED", "NO_SPOTS"]);
  assert.equal((await entry(item.id)).notifications_sent, 0, "aviso não enviado não conta");
});

test("grupo maior que a vaga que sobrou na hora do envio: não é avisado", async () => {
  const { session, booking } = await soldOut(3);
  const group = await join(session, 3);
  await cancel(booking.id);
  await scan();
  await reserve(session, 1); // sobram 2, o grupo é de 3
  const active = runtime();
  await drain(active);
  assert.equal(active.provider.deliveredTo(group.email).length, 0);
  assert.equal((await spotOf(group.id)).skip_reason, "NO_SPOTS");
});

test("turma que deixou de aceitar reserva antes do envio: descartado", async () => {
  for (const [change, reason] of [
    [`update public.sessions set status = 'CLOSED' where id = $1::uuid`, "SESSION_UNAVAILABLE"],
    [`update public.sessions set starts_at = now() - interval '1 minute' where id = $1::uuid`, "SESSION_STARTED"],
  ] as const) {
    const { session, booking } = await soldOut(1);
    const item = await join(session);
    await cancel(booking.id);
    await scan();
    await db.query(change, [session]);
    const active = runtime();
    await drain(active);
    assert.equal(active.provider.deliveredTo(item.email).length, 0, change);
    const notice = await spotOf(item.id);
    assert.equal(notice.status, "SKIPPED", change);
    assert.ok([reason, "ENTRY_CLOSED"].includes(notice.skip_reason), `${change}: ${notice.skip_reason}`);
  }
});

test("inscrição cancelada, removida, convertida ou expirada: nunca recebe o aviso", async () => {
  const active = runtime();
  const closeBy: Array<[string, (item: Row, session: string) => Promise<void>]> = [
    ["cancelada", async (item) => { await call(`public.waitlist_cancel($1, null)`, [await call(`public.waitlist_cancel_token($1::uuid)`, [item.id])]); }],
    ["removida", async (item) => { await call(`public.admin_remove_waitlist_entry($1::uuid, $2::uuid, 'Pediu para sair')`, [ADMIN, item.id]); }],
    ["convertida", async (item) => { await db.query(`update public.waitlist_entries set status = 'CONVERTED', closed_at = now(), closed_reason = 'RESERVATION_CONFIRMED' where id = $1::uuid`, [item.id]); }],
    ["expirada", async (item) => { await db.query(`update public.waitlist_entries set status = 'EXPIRED', closed_at = now(), closed_reason = 'SESSION_STARTED' where id = $1::uuid`, [item.id]); }],
  ];
  for (const [name, close] of closeBy) {
    const { session, booking } = await soldOut(1);
    const item = await join(session);
    await cancel(booking.id);
    await scan();
    await close(item, session);
    await drain(active);
    assert.equal(active.provider.deliveredTo(item.email).length, 0, name);
    assert.equal((await spotOf(item.id)).status, "SKIPPED", name);
  }
});

test("abertura fechada pela varredura antes do envio: descartado", async () => {
  const { session, booking } = await soldOut(1);
  const item = await join(session);
  await cancel(booking.id);
  await scan();
  await reserve(session, 1);
  await scan(); // fecha a abertura
  const active = runtime();
  await drain(active);
  assert.equal(active.provider.deliveredTo(item.email).length, 0);
  assert.deepEqual([(await spotOf(item.id)).status, (await spotOf(item.id)).skip_reason], ["SKIPPED", "OPENING_CLOSED"]);
});

// ===========================================================================
// 4. Limites (D3) e ondas
// ===========================================================================

test("12 horas e 3 avisos: conferidos de novo na hora do envio, e o envio é que conta", async () => {
  const active = runtime();
  const { session, booking } = await soldOut(1);
  const item = await join(session);
  await cancel(booking.id);
  await scan();
  await drain(active);
  assert.equal(active.provider.deliveredTo(item.email).length, 1);

  // A vaga some e volta: com aviso enviado agora há pouco, a varredura não enfileira de novo.
  const taker = await reserve(session, 1);
  await scan();
  await cancel(taker.id);
  await scan();
  await drain(active);
  assert.equal(active.provider.deliveredTo(item.email).length, 1, "12 horas entre avisos");

  // Mesmo que um aviso chegasse à fila, o envio confere de novo (11 h depois, ainda cedo).
  await db.query(`update public.waitlist_entries set last_notified_at = now() - interval '11 hours' where id = $1::uuid`, [item.id]);
  const opening = await one(`select id from public.waitlist_openings where session_id = $1::uuid and closed_at is null`, [session]);
  await db.query(`insert into public.waitlist_notifications (entry_id, kind, opening_id, spots_at_queue) values ($1::uuid, 'SPOT_AVAILABLE', $2::uuid, 1) on conflict do nothing`, [item.id, opening.id]);
  await drain(active);
  assert.equal(active.provider.deliveredTo(item.email).length, 1);
  assert.equal((await spotOf(item.id)).skip_reason, "TOO_SOON");

  await db.query(`update public.waitlist_entries set notifications_sent = 3, last_notified_at = now() - interval '13 hours' where id = $1::uuid`, [item.id]);
  await db.query(`delete from public.waitlist_notifications where entry_id = $1::uuid and kind = 'SPOT_AVAILABLE' and opening_id = $2::uuid`, [item.id, opening.id]);
  await db.query(`insert into public.waitlist_notifications (entry_id, kind, opening_id, spots_at_queue) values ($1::uuid, 'SPOT_AVAILABLE', $2::uuid, 1)`, [item.id, opening.id]);
  await drain(active);
  assert.equal(active.provider.deliveredTo(item.email).length, 1);
  assert.equal((await spotOf(item.id)).skip_reason, "LIMIT_REACHED");
});

test("ondas: só a primeira sai; a segunda, depois do intervalo, vai para os seguintes da fila", async () => {
  const active = runtime();
  const { session, booking } = await soldOut(1);
  const queue: Row[] = [];
  for (let index = 0; index < 7; index += 1) queue.push(await join(session));
  await cancel(booking.id);
  await scan();
  await drain(active);
  const sent = () => queue.filter((item) => active.provider.deliveredTo(item.email).length === 1).map((item) => item.id);
  assert.deepEqual(sent(), queue.slice(0, 5).map((item) => item.id), "primeira onda: max(5, 3 × 1) = 5");

  await scan();
  await drain(active);
  assert.equal(sent().length, 5, "dentro do intervalo, ninguém mais");

  await db.query(`update public.waitlist_openings set last_wave_at = now() - interval '31 minutes' where session_id = $1::uuid and closed_at is null`, [session]);
  await scan();
  await drain(active);
  assert.deepEqual(sent(), queue.map((item) => item.id), "segunda onda: os dois restantes");
  for (const item of queue) assert.equal(active.provider.deliveredTo(item.email).length, 1, "ninguém recebe duas vezes");
});

// ===========================================================================
// 5. Falhas do Resend e idempotência
// ===========================================================================

async function queuedFor() {
  const { session, booking } = await soldOut(1);
  const item = await join(session);
  await cancel(booking.id);
  await scan();
  return { session, item, notice: await spotOf(item.id) };
}

test("resultado desconhecido: a próxima tentativa repete chave e mensagem, e o cliente recebe uma vez", async () => {
  const { item, notice } = await queuedFor();
  const active = runtime();
  active.provider.next("accepted-then-timeout");
  await sendPendingWaitlistSpotEmails(active);
  const failed = await spotOf(item.id);
  assert.deepEqual([failed.status, failed.generation_uncertain], ["FAILED", true]);
  assert.ok(failed.frozen_message);
  assert.equal((await entry(item.id)).notifications_sent, 0, "ainda não se sabe se saiu");

  await release(notice.id);
  await drain(active);
  const requests = active.provider.requests.filter((request) => request.to === item.email);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].idempotencyKey, requests[1].idempotencyKey);
  assert.equal(requests[0].html, requests[1].html);
  assert.equal(active.provider.deliveredTo(item.email).length, 1);
  assert.equal((await entry(item.id)).notifications_sent, 1, "conta uma vez");
});

test("recusa comprovada: chave nova; chave recusada duas vezes: UNCERTAIN, nada mais sai", async () => {
  const rejected = await queuedFor();
  const active = runtime();
  active.provider.next(new EmailProviderError("HTTP_422", false, "NOT_SENT"));
  await sendPendingWaitlistSpotEmails(active);
  await release(rejected.notice.id);
  await drain(active);
  const keys = active.provider.requests.filter((request) => request.to === rejected.item.email).map((request) => request.idempotencyKey);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  assert.equal(active.provider.deliveredTo(rejected.item.email).length, 1);

  const conflicted = await queuedFor();
  const other = runtime();
  other.provider.next("accepted-then-timeout", "in-progress", "in-progress");
  await sendPendingWaitlistSpotEmails(other);
  await release(conflicted.notice.id);
  await sendPendingWaitlistSpotEmails(other);
  await release(conflicted.notice.id);
  await sendPendingWaitlistSpotEmails(other);
  const after = await spotOf(conflicted.item.id);
  assert.deepEqual([after.status, after.last_error_code, after.frozen_message], ["UNCERTAIN", "IDEMPOTENCY_CONFLICT", null]);
  const before = other.provider.requests.length;
  await release(conflicted.notice.id);
  await drain(other);
  assert.equal(other.provider.requests.filter((request) => request.to === conflicted.item.email).length, 3, "nada mais é tentado");
  assert.ok(other.provider.requests.length >= before);
  assert.equal((await entry(conflicted.item.id)).notifications_sent, 0, "entrega incerta não conta");
});

test("janela da chave vencida com resultado desconhecido: UNCERTAIN, sem reenvio às cegas", async () => {
  const { item, notice } = await queuedFor();
  const active = runtime();
  active.provider.next("lost");
  await sendPendingWaitlistSpotEmails(active);
  await db.query(`update public.waitlist_notifications set generation_started_at = now() - interval '24 hours', next_attempt_at = now() - interval '1 second' where id = $1::uuid`, [notice.id]);
  await drain(active);
  assert.deepEqual([(await spotOf(item.id)).status, (await spotOf(item.id)).last_error_code], ["UNCERTAIN", "IDEMPOTENCY_WINDOW_EXPIRED"]);
  assert.equal(active.provider.requests.filter((request) => request.to === item.email).length, 1);
});

test("sem duplicidade: duas execuções seguidas, conclusão repetida e resposta atrasada contam uma vez", async () => {
  const { item, notice } = await queuedFor();
  const claims = await call(`public.claim_pending_waitlist_spot_emails(50, 6, 2, 1380)`);
  const mine = claims.find((claim: Row) => claim.notificationId === notice.id);
  assert.ok(mine);
  assert.ok(!(await call(`public.claim_pending_waitlist_spot_emails(50, 6, 2, 1380)`)).some((claim: Row) => claim.notificationId === notice.id), "em envio: ninguém mais pega");
  assert.equal(await call(`public.freeze_waitlist_email($1::uuid, $2::uuid, $3::jsonb)`, [notice.id, mine.claimToken, JSON.stringify({ to: item.email, subject: "s", html: "h", text: "t" })]), true);

  // O prazo vence; outra execução assume com a mesma mensagem.
  await db.query(`update public.waitlist_notifications set locked_until = now() - interval '1 second' where id = $1::uuid`, [notice.id]);
  const retaken = (await call(`public.claim_pending_waitlist_spot_emails(50, 6, 2, 1380)`)).find((claim: Row) => claim.notificationId === notice.id);
  assert.ok(retaken);
  assert.deepEqual(retaken.message, { to: item.email, subject: "s", html: "h", text: "t" });

  // As duas respondem que saiu: conta uma vez.
  assert.equal(await call(`public.complete_waitlist_spot_email($1::uuid, $2::uuid)`, [notice.id, mine.claimToken]), true);
  assert.equal(await call(`public.complete_waitlist_spot_email($1::uuid, $2::uuid)`, [notice.id, retaken.claimToken]), true);
  assert.equal(await call(`public.complete_waitlist_spot_email($1::uuid, $2::uuid)`, [notice.id, retaken.claimToken]), true);
  assert.equal((await entry(item.id)).notifications_sent, 1);
  assert.equal((await spotOf(item.id)).status, "SENT");
});

test("as filas não se misturam: confirmação e aviso de vaga têm reivindicações próprias", async () => {
  const { item, notice } = await queuedFor();
  for (let round = 0; round < 30; round += 1) {
    const joined = await call(`public.claim_pending_waitlist_emails(25, 6, 2, 1380)`);
    assert.ok(!joined.some((claim: Row) => claim.notificationId === notice.id), "a fila da confirmação não pega aviso de vaga");
    if (!joined.length) break;
  }
  const joinedNotice = await one(`select id from public.waitlist_notifications where entry_id = $1::uuid and kind = 'JOINED'`, [item.id]);
  assert.equal(await call(`public.waitlist_spot_take($1::uuid, 6, 2, 1380)`, [joinedNotice.id]), null, "a fila do aviso não pega confirmação");
  assert.equal(await call(`public.complete_waitlist_spot_email($1::uuid, gen_random_uuid())`, [joinedNotice.id]), false);
});

test("o envio não muda reservas, pagamentos, sessões nem Stand-by", async () => {
  await queuedFor();
  const digest = async () => (await one(
    `select md5(string_agg(t, '|' order by t)) as h from (
       select r::text as t from public.reservations r
       union all select p::text from public.payment_events p
       union all select s::text from public.sessions s
       union all select x::text from public.reservation_standby x) z`,
  )).h;
  const before = await digest();
  await drain(runtime());
  assert.equal(await digest(), before);
});

test("ritmo: um envio por segundo, lotes de 5 e nenhum lote novo depois do orçamento de tempo", async () => {
  const { session, booking } = await soldOut(1);
  const queue: Row[] = [];
  for (let index = 0; index < 7; index += 1) queue.push(await join(session));
  await cancel(booking.id);
  await scan(); // primeira onda: 5 avisos

  const pauses: number[] = [];
  let clock = 0;
  const active: WaitlistSpotRuntime & { provider: ReturnType<typeof fakeResend> } = {
    ...runtime(),
    pause: async (ms) => { pauses.push(ms); clock += ms; },
    now: () => clock,
  };
  const claimed: number[] = [];
  const queueApi = active.queue;
  active.queue = { ...queueApi, claimPending: async (limit) => { const claims = await queueApi.claimPending(limit); claimed.push(claims.length); return claims; } };

  const report = await sendPendingWaitlistSpotEmails(active, { batch: 2, claimBudgetMs: 2500 });
  // Lotes de 2: 0 s → lote 1 (2 envios, 1 pausa); 1 s → lote 2 (2 envios, 2 pausas); 3 s ≥ 2,5 s → para.
  assert.deepEqual(claimed, [2, 2]);
  assert.equal(report.processed, 4);
  assert.deepEqual(pauses, [1000, 1000, 1000], "uma pausa de 1 s entre envios, nunca antes do primeiro");
  await drain(active);
  assert.equal(queue.slice(0, 5).filter((item) => active.provider.deliveredTo(item.email).length === 1).length, 5, "o resto sai na execução seguinte");
});

// ===========================================================================
// 6. Rota, agendamento e migration
// ===========================================================================

test("rota: segredo do cron, desligada por padrão, só contadores na resposta", () => {
  const route = code("app/api/cron/waitlist-notifications/route.ts");
  assert.match(route, /const secret = process\.env\.CRON_SECRET\?\.trim\(\);\s*if \(!secret\) \{[\s\S]*?status: 503/);
  assert.match(route, /if \(!isAuthorizedCronRequest\(request, secret\)\) \{[\s\S]*?status: 401/);
  assert.ok(route.indexOf("isAuthorizedCronRequest") < route.indexOf("sendPendingWaitlistSpotNotices()"));
  assert.match(route, /\{ outcome: report\.outcome, processed: report\.processed, sent: report\.sent, errorCode: report\.errorCode \}/);
  const service = code("lib/waitlist/spot-email-service.ts");
  assert.ok(service.indexOf("if (!isWaitlistNotifyEnabled()) return { outcome: \"DISABLED\"") < service.indexOf("getSupabaseAdminClient()"), "desligada, nem chega ao banco");
  assert.doesNotMatch(source("vercel.json"), /waitlist/i, "nenhum cron da Vercel");
  for (const path of ["app/api/cron/waitlist-notifications/route.ts", "lib/waitlist/spot-email.ts", "lib/waitlist/spot-email-service.ts"]) {
    assert.doesNotMatch(code(path), /console\.|NEXT_PUBLIC_WAITLIST/, path);
  }
});

test("agendamento: script à parte, sem segredo no repositório, só chama a rota com aviso pendente", () => {
  const schedule = source("supabase/maintenance/waitlist_notify_schedule.sql");
  assert.match(schedule, /select cron\.schedule\(\s*'waitlist-notify',\s*'\* \* \* \* \*'/);
  assert.match(schedule, /net\.http_post\(/);
  assert.match(schedule, /url := 'https:\/\/www\.almaazulacademy\.com\.br\/api\/cron\/waitlist-notifications'/);
  assert.match(schedule, /from vault\.decrypted_secrets where name = 'waitlist_cron_secret'/);
  assert.match(schedule, /where exists \(select 1 from vault\.decrypted_secrets[\s\S]*?n\.kind = 'SPOT_AVAILABLE'/);
  assert.doesNotMatch(schedule.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n"), /vault\.create_secret|detection_enabled\s*=\s*true/, "o segredo e o interruptor são passos manuais à parte");
  assert.ok(!readdirSync(new URL("../supabase/migrations/", import.meta.url)).some((file) => /notify|schedul.*waitlist|waitlist.*schedul/i.test(file)));
});

const NEW_FUNCTIONS = [
  "claim_pending_waitlist_spot_emails(integer,integer,integer,integer)",
  "complete_waitlist_spot_email(uuid,uuid)",
  "waitlist_spot_payload(uuid)",
  "waitlist_spot_rejection(uuid)",
  "waitlist_spot_take(uuid,integer,integer,integer)",
];

test("migration: aditiva, nenhuma função existente muda, nada pela API além das duas do servidor", async () => {
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
  for (const fn of NEW_FUNCTIONS) {
    const row = (await before.query<Row>(
      `select has_function_privilege('anon', $1, 'EXECUTE') as a, has_function_privilege('authenticated', $1, 'EXECUTE') as b,
              has_function_privilege('service_role', $1, 'EXECUTE') as c, p.prosecdef as definer
       from pg_proc p where p.oid = $1::regprocedure`, [`public.${fn}`])).rows[0];
    const server = fn.startsWith("claim_pending") || fn.startsWith("complete_");
    assert.deepEqual([row.a, row.b, row.c, row.definer], [false, false, server, true], fn);
  }
  const migration = code(`supabase/migrations/${MIGRATION}`);
  assert.doesNotMatch(migration, /(insert into|update|delete from) public\.(reservations|sessions|payment_events|reservation_standby)\b/i);
  assert.doesNotMatch(migration, /cron\.|pg_net|net\.http|create extension|create table|create trigger/i);
  await before.close();
});

const PREFLIGHT = source("supabase/diagnostics/waitlist_spot_email_preflight.sql");
const POSTCHECK = source("supabase/diagnostics/waitlist_spot_email_postcheck.sql");
const ROLLBACK = source("supabase/rollback/202610260002_waitlist_spot_email.rollback.sql");

type Check = { check_name: string; result: string; status: string };

async function report(database: { query: (sql: string) => Promise<{ rows: unknown[] }> }, sql: string) {
  return new Map(((await database.query(sql)).rows as Check[]).map((row) => [row.check_name, row]));
}

test("preflight e postcheck: aprovam o banco do repositório, nas duas pontas", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  const pre = await report(before, PREFLIGHT);
  for (const [name, row] of pre) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  await assert.rejects(before.query(POSTCHECK), /does not exist/);
  await applyMigration(before, MIGRATION);
  const post = await report(before, POSTCHECK);
  for (const [name, row] of post) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  assert.equal(post.get("FUNCOES_NOVAS_COM_A_DEFINICAO_DO_REPOSITORIO")?.result, "5 de 5");
  assert.equal(post.get("PERMISSOES_DAS_FUNCOES")?.result, "2 do servidor, 3 internas");
  assert.equal(post.get("INTERRUPTOR_DA_DETECCAO")?.result, "desligado");
  assert.equal(post.get("AGENDAMENTOS_DA_LISTA")?.result, "nenhum");
  for (const count of ["ASSINATURA_DAS_FUNCOES_EXISTENTES", "INSCRICOES_POR_STATUS", "FILA_DA_LISTA_POR_STATUS", "RESERVAS_POR_STATUS"]) {
    assert.equal(post.get(count)?.result, pre.get(count)?.result, count);
  }
  await before.close();
});

test("preflight: reprova se o congelamento da fase 3 estiver diferente do repositório", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  await before.exec(`create or replace function public.freeze_waitlist_email(p_notification_id uuid, p_claim_token uuid, p_message jsonb) returns boolean language sql security definer set search_path = public as $$ select true $$`);
  const pre = await report(before, PREFLIGHT);
  assert.equal(pre.get("FUNCOES_REAPROVEITADAS")?.status, "FALHOU");
  assert.match(pre.get("FUNCOES_REAPROVEITADAS")!.result, /freeze_waitlist_email=DIFERENTE/);
  await before.close();
});

test("rollback: remove só as cinco funções; fila e contagens ficam; reaplicar devolve tudo", async () => {
  const database = await fullDatabase();
  const functions = async () => (await database.query<{ name: string; src: string }>(`select p.oid::regprocedure::text as name, md5(p.prosrc) as src from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`)).rows;
  const beforeFunctions = await functions();
  await database.exec(ROLLBACK);
  const after = await functions();
  assert.deepEqual(beforeFunctions.filter((row) => !after.some((kept) => kept.name === row.name)).map((row) => row.name).sort(), NEW_FUNCTIONS);
  for (const row of after) assert.equal(row.src, beforeFunctions.find((old) => old.name === row.name)?.src, row.name);
  await assert.rejects(database.query(POSTCHECK), /does not exist/);
  await applyMigration(database, MIGRATION);
  assert.equal((await report(database, POSTCHECK)).get("WAITLIST_AVISO_POSTCHECK_OK")?.status, "OK");
  await database.close();
});
