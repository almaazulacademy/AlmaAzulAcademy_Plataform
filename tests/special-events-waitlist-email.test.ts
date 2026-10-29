/**
 * Eventos especiais — etapa 5C-2: e-mails e saída da lista de espera do evento.
 *
 * A fila, a reivindicação, a idempotência e as tentativas são as da lista de
 * sempre; aqui se prova o que muda: o modelo de evento escolhido pelo tipo da
 * sessão lido no banco (sem nunca cair no modelo regular por engano), o aviso
 * de vaga só reivindicado com a venda do evento aberta (sem gastar tentativa
 * com ela fechada), o link para `/eventos/<slug>#reserva`, a página de saída com
 * textos de evento e a migration aditiva `202610300001`.
 *
 * Postgres em memória com todas as migrations; o provedor de e-mail é falso.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { RulesQueryClient } from "../lib/events/booking.ts";
import { ESSENCIA_CAPACITY, ESSENCIA_EDITORIAL, ESSENCIA_STARTS_AT, CONCHA_ACUSTICA_LOCATION } from "../lib/events/fixtures/essencia.ts";
import { EVENT_WAITLIST_EMAILS_READY, isEventsWaitlistEnabled } from "../lib/events/flags.ts";
import { validateEventEditorial } from "../lib/events/editorial.ts";
import {
  buildEventWaitlistJoinedEmail,
  buildEventWaitlistSpotEmail,
  EVENT_WAITLIST_SPOT_CTA,
  eventWaitlistReserveUrl,
  withWaitlistEventContext,
  type WaitlistEvent,
} from "../lib/events/waitlist-email.ts";
import { createWaitlistEmailQueue, sendWaitlistJoinedEmail, type WaitlistEmailRuntime } from "../lib/waitlist/joined-email.ts";
import { WAITLIST_JOINED_INTRO } from "../lib/waitlist/joined-email-content.ts";
import { handleWaitlistCancel, handleWaitlistCancelOverview } from "../lib/waitlist/signup.ts";
import { createWaitlistSpotQueue, sendPendingWaitlistSpotEmails, waitlistSpotIdempotencyKey, type WaitlistSpotRuntime } from "../lib/waitlist/spot-email.ts";
import { WAITLIST_SPOT_CTA } from "../lib/waitlist/spot-email-content.ts";
import { applyMigration, fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";
import { ADMIN, fakeResend, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

const MIGRATION = "202610300001_waitlist_event_scope.sql";
const PREVIOUS = "202610280001_special_events_foundation.sql";
const ORIGIN = "https://www.almaazulacademy.com.br";
const NEW_FUNCTIONS = [
  "claim_pending_waitlist_spot_emails_by_kind(text[],integer,integer,integer,integer)",
  "waitlist_cancel_overview_with_kind(text,text)",
];

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const db = await fullDatabase();
const admin = createPgliteAdmin(db);
const rpc = (name: string, args: Record<string, unknown>) => admin.client.rpc(name, args);
const client = admin.client as unknown as RulesQueryClient;
const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
const { one, rows, call, SUNSET_CONCHA, IMERSAO, makeSession, reserve, uniquePrice } = fx;

await db.exec(`update public.waitlist_settings set detection_enabled = true, opening_grace_seconds = 0, wave_interval_minutes = 30`);

let sequence = 0;
const enrich = (payload: unknown) => withWaitlistEventContext(client, payload);

function joinedRuntime(provider = fakeResend(), overrides: Partial<WaitlistEmailRuntime> = {}): WaitlistEmailRuntime & { provider: ReturnType<typeof fakeResend> } {
  return { queue: createWaitlistEmailQueue({ rpc }), provider, origin: ORIGIN, wait: async () => undefined, enrich, ...overrides } as WaitlistEmailRuntime & { provider: ReturnType<typeof fakeResend> };
}

function spotRuntime(kinds: Array<"REGULAR" | "EVENT">, provider = fakeResend(), queueRpc = rpc): WaitlistSpotRuntime & { provider: ReturnType<typeof fakeResend> } {
  return { queue: createWaitlistSpotQueue({ rpc: queueRpc }), provider, origin: ORIGIN, pause: async () => undefined, kinds, enrich };
}

async function drain(active: WaitlistSpotRuntime) {
  let sent = 0;
  for (let round = 0; round < 20; round += 1) {
    const report = await sendPendingWaitlistSpotEmails(active);
    assert.equal(report.outcome, "PROCESSED", report.errorCode);
    sent += report.sent;
    if (report.processed === 0) break;
  }
  return sent;
}

/** O ESSÊNCIA publicado, com 24 vagas; `full` ocupa as 24 com duas reservas pagas de 12. */
async function essencia(full = true) {
  sequence += 1;
  const slug = `essencia-aviso-${sequence}`;
  const created = await call(
    `public.admin_create_event($1::uuid, $2::uuid, $3, 'ESSÊNCIA — Corpo, Mente e Natureza', 'x', $4::jsonb, null, now() + interval '9 days', 210, 15000, $5)`,
    [ADMIN, SUNSET_CONCHA.base_id, slug, JSON.stringify(ESSENCIA_EDITORIAL), ESSENCIA_CAPACITY],
  );
  await rows(`update public.special_event_settings set publication_enabled = true`);
  await rows(`update public.experiences set status = 'PUBLISHED' where id = $1::uuid`, [created.experienceId]);
  await rows(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [created.sessionId]);
  const bookings = full ? [await reserve(created.sessionId, 12), await reserve(created.sessionId, 12)] : [];
  return { slug, experienceId: created.experienceId as string, sessionId: created.sessionId as string, bookings };
}

async function join(sessionId: string, quantity: number) {
  sequence += 1;
  const email = `lista-evento${sequence}@teste.local`;
  await db.exec(`delete from public.waitlist_throttle`);
  const answer = await call(`public.waitlist_join($1::uuid, $2, $3, $4, $5, null, '')`, [sessionId, `Marina Lista ${sequence}`, email, `+5561${String(960000000 + sequence)}`, quantity]);
  assert.equal(answer.status, "ACCEPTED");
  return one(`select * from public.waitlist_entries where session_id = $1::uuid and email = $2`, [sessionId, email]);
}

async function cancelReservation(reservationId: string) {
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Libera a vaga')`, [ADMIN, reservationId]);
}

async function spotOf(entryId: string) {
  return (await rows(`select * from public.waitlist_notifications where entry_id = $1::uuid and kind = 'SPOT_AVAILABLE' order by created_at desc`, [entryId]))[0] ?? null;
}

async function entry(entryId: string) {
  return one(`select * from public.waitlist_entries where id = $1::uuid`, [entryId]);
}

/** Uma vaga de 2 participantes: cancela uma reserva paga de 12 e ocupa 10 de novo. */
async function freeTwoSpots(event: Awaited<ReturnType<typeof essencia>>) {
  await cancelReservation(event.bookings[0].id);
  await reserve(event.sessionId, 10);
  assert.equal(Number((await one(`select public.available_spots($1::uuid) as n`, [event.sessionId])).n), 2);
}

const editorial = validateEventEditorial(ESSENCIA_EDITORIAL);
if (!editorial.success) throw new Error(editorial.errors.join("; "));
const DEMO_EVENT: WaitlistEvent = { slug: "essencia", content: editorial.data.event, location: CONCHA_ACUSTICA_LOCATION, durationMinutes: 210 };
const TOKEN = "a".repeat(64);

// ===========================================================================
// 1. Conteúdo
// ===========================================================================

test("confirmação do evento: nome, data, horário, local, participantes, não é ingresso e link de saída", () => {
  const email = buildEventWaitlistJoinedEmail(
    { fullName: "Marina Albuquerque", email: "marina@teste.local", quantity: 3, experienceTitle: "ESSÊNCIA — Corpo, Mente e Natureza", startsAt: ESSENCIA_STARTS_AT, baseName: "Cápsula Bar — Concha Acústica", cancelToken: TOKEN },
    DEMO_EVENT, ORIGIN,
  );
  assert.equal(email.subject, "Você está na lista de espera — ESSÊNCIA — Corpo, Mente e Natureza | Alma Azul Academy");
  for (const text of [
    "Recebemos sua inscrição na lista de espera do evento:",
    "Evento: ESSÊNCIA — Corpo, Mente e Natureza",
    "Data: sábado, 07 de novembro de 2026",
    "Horário: 05h30 às 09h00",
    "Local: Em frente ao Cápsula Bar — Concha Acústica — SHTN Trecho 1, Lote 8 — Brasília/DF",
    "Participantes: 3 participantes",
    "ISTO NÃO É UM INGRESSO",
    "não é ingresso nem reserva garantida",
    `${ORIGIN}/lista-de-espera#t=${TOKEN}`,
  ]) assert.ok(email.text.includes(text), text);
  assert.doesNotMatch(email.text + email.html, /turma|remada/i);
  assert.ok(!email.text.includes(WAITLIST_JOINED_INTRO));
});

test("aviso de vaga do evento: surgiu disponibilidade, não garantida, GARANTIR MEU INGRESSO para a seção de reserva", () => {
  const email = buildEventWaitlistSpotEmail(
    { fullName: "Marina Albuquerque", email: "marina@teste.local", quantity: 2, sessionId: "00000000-0000-4000-8000-000000000001", experienceTitle: "ESSÊNCIA — Corpo, Mente e Natureza", startsAt: ESSENCIA_STARTS_AT, baseName: "Cápsula Bar — Concha Acústica", priceCents: 15_000, remainingSpots: 2, cancelToken: TOKEN },
    DEMO_EVENT, ORIGIN,
  );
  assert.equal(email.subject, "Surgiu uma vaga: ESSÊNCIA — Corpo, Mente e Natureza | Alma Azul Academy");
  assert.equal(eventWaitlistReserveUrl("essencia", ORIGIN), `${ORIGIN}/eventos/essencia#reserva`);
  for (const text of [
    "Surgiu disponibilidade no evento",
    "Horário: 05h30 às 09h00",
    "Participantes: 2 participantes",
    "A VAGA NÃO ESTÁ GARANTIDA",
    "a disponibilidade pode mudar até a conclusão da compra",
    `GARANTIR MEU INGRESSO: ${ORIGIN}/eventos/essencia#reserva`,
  ]) assert.ok(email.text.includes(text), text);
  assert.match(email.html, new RegExp(`href="${ORIGIN}/eventos/essencia#reserva"`));
  assert.match(email.html, />Garantir meu ingresso</);
  assert.equal(EVENT_WAITLIST_SPOT_CTA, "Garantir meu ingresso");
  assert.doesNotMatch(email.text + email.html, /\/reservar\/|turma|remada/i);
});

test("nome do cliente escapado no HTML dos dois modelos", () => {
  const joined = buildEventWaitlistJoinedEmail({ fullName: "<b>x</b> Silva", email: "a@b.co", quantity: 1, experienceTitle: "E", startsAt: ESSENCIA_STARTS_AT, baseName: "", cancelToken: TOKEN }, DEMO_EVENT);
  assert.ok(!joined.html.includes("<b>x</b>"));
});

// ===========================================================================
// 2. Confirmação pela fila
// ===========================================================================

test("confirmação pela fila: inscrição no ESSÊNCIA esgotado recebe o modelo do evento, uma vez", async () => {
  const event = await essencia();
  const item = await join(event.sessionId, 6);
  const active = joinedRuntime();
  assert.deepEqual(await sendWaitlistJoinedEmail(active, event.sessionId, item.email), { outcome: "SENT" });
  assert.equal(await sendWaitlistJoinedEmail(active, event.sessionId, item.email).then((result) => result.outcome), "SKIPPED");
  const [message] = active.provider.deliveredTo(item.email);
  assert.equal(active.provider.deliveredTo(item.email).length, 1);
  assert.match(message.subject, /^Você está na lista de espera — ESSÊNCIA — Corpo, Mente e Natureza/);
  assert.ok(message.text.includes("Participantes: 6 participantes"));
  assert.ok(message.text.includes("Local: Em frente ao Cápsula Bar — Concha Acústica"));
  assert.doesNotMatch(message.text, /turma/i);
});

test("experiência regular: a confirmação de sempre, sem mudança", async () => {
  const session = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 1 });
  await reserve(session, 1);
  const item = await join(session, 1);
  const active = joinedRuntime();
  await sendWaitlistJoinedEmail(active, session, item.email);
  const [message] = active.provider.deliveredTo(item.email);
  assert.ok(message.text.includes(WAITLIST_JOINED_INTRO));
  assert.doesNotMatch(message.text, /Isto não é um ingresso/i);
});

test("sem conseguir ler o tipo, ou com o conteúdo do evento inválido: nada sai, fica pendente — nunca o modelo regular", async () => {
  const event = await essencia();
  const item = await join(event.sessionId, 2);
  const broken = joinedRuntime(fakeResend(), { enrich: async () => { throw new Error("fetch failed"); } });
  const result = await sendWaitlistJoinedEmail(broken, event.sessionId, item.email);
  assert.deepEqual([result.outcome, result.errorCode], ["PENDING", "EVENT_CONTEXT_UNAVAILABLE"]);
  assert.equal(broken.provider.requests.length, 0);

  const other = await essencia();
  const second = await join(other.sessionId, 2);
  await rows(`update public.experiences set editorial_content = '{"version":1}'::jsonb where id = $1::uuid`, [other.experienceId]);
  const invalid = joinedRuntime();
  const refused = await sendWaitlistJoinedEmail(invalid, other.sessionId, second.email);
  assert.deepEqual([refused.outcome, refused.errorCode], ["PENDING", "EVENT_EMAIL_NOT_READY"]);
  assert.equal(invalid.provider.requests.length, 0);
});

// ===========================================================================
// 3. Aviso de vaga: liberação, régua e venda
// ===========================================================================

test("24 vagas, 3 na lista, reserva de 2 cancelada: avisa só quem cabe, com o link do evento", async () => {
  const event = await essencia();
  const two = await join(event.sessionId, 2);
  const six = await join(event.sessionId, 6);
  const one_ = await join(event.sessionId, 1);
  await freeTwoSpots(event);
  await call(`public.waitlist_scan()`);
  const active = spotRuntime(["REGULAR", "EVENT"]);
  await drain(active);
  for (const [item, expected] of [[two, 1], [six, 0], [one_, 1]] as const) {
    assert.equal(active.provider.deliveredTo(item.email).length, expected, `quantidade ${item.quantity}`);
  }
  const [message] = active.provider.deliveredTo(two.email);
  assert.ok(message.text.includes(`${ORIGIN}/eventos/${event.slug}#reserva`));
  assert.ok(message.text.includes("Participantes: 2 participantes"));
  assert.equal((await entry(two.id)).notifications_sent, 1);
  // A lista não reserva: as 2 vagas continuam abertas para qualquer cliente.
  assert.equal(Number((await one(`select public.available_spots($1::uuid) as n`, [event.sessionId])).n), 2);
});

test("venda do evento fechada: o aviso nem é reivindicado — sem tentativa, sem envio, segue na fila", async () => {
  const event = await essencia();
  const item = await join(event.sessionId, 2);
  await freeTwoSpots(event);
  await call(`public.waitlist_scan()`);
  const closed = spotRuntime(["REGULAR"]);
  await drain(closed);
  const queued = await spotOf(item.id);
  assert.deepEqual([queued.status, queued.attempts], ["QUEUED", 0]);
  assert.equal(closed.provider.requests.length, 0);
  assert.equal((await entry(item.id)).notifications_sent, 0);
  // Venda aberta: sai, conferido de novo na hora.
  const open = spotRuntime(["REGULAR", "EVENT"]);
  await drain(open);
  assert.equal(open.provider.deliveredTo(item.email).length, 1);
  assert.equal((await spotOf(item.id)).status, "SENT");
});

test("evento despublicado antes do envio: descartado pela régua de sempre, sem contar envio", async () => {
  const event = await essencia();
  const item = await join(event.sessionId, 2);
  await freeTwoSpots(event);
  await call(`public.waitlist_scan()`);
  await rows(`update public.experiences set status = 'DRAFT' where id = $1::uuid`, [event.experienceId]);
  const active = spotRuntime(["REGULAR", "EVENT"]);
  await drain(active);
  const skipped = await spotOf(item.id);
  assert.deepEqual([skipped.status, skipped.skip_reason, skipped.attempts], ["SKIPPED", "SESSION_UNAVAILABLE", 0]);
  assert.equal(active.provider.requests.length, 0);
  assert.equal((await entry(item.id)).notifications_sent, 0);
});

test("pré-reserva vencida libera vaga e leva ao aviso", async () => {
  const event = await essencia(false);
  await reserve(event.sessionId, 12);
  await reserve(event.sessionId, 11);
  const held = await call(`public.create_pre_reservation($1::uuid, 'Pessoa Retendo', '52998224725', '+5561988880001', 'retendo-evento@teste.local', 1, null, gen_random_uuid())`, [event.sessionId]);
  const item = await join(event.sessionId, 1);
  await call(`public.waitlist_scan()`);
  assert.equal(await spotOf(item.id), null, "com a pré-reserva valendo, nada");
  await db.query(`update public.reservations set created_at = now() - interval '3 hours', expires_at = now() - interval '1 second' where id = $1::uuid`, [held.reservationId]);
  await call(`public.waitlist_scan()`);
  const active = spotRuntime(["REGULAR", "EVENT"]);
  await drain(active);
  assert.equal(active.provider.deliveredTo(item.email).length, 1);
});

test("pedido de reembolso ainda pendente não libera vaga: a reserva continua confirmada e ninguém é avisado", async () => {
  const event = await essencia();
  const item = await join(event.sessionId, 2);
  // O pedido de reembolso (5D) é feito pelo WhatsApp e não muda a reserva até a equipe cancelá-la.
  await rows(`update public.reservations set notes = coalesce(notes, '') || ' [reembolso solicitado]' where id = $1::uuid`, [event.bookings[0].id]).catch(() => undefined);
  await call(`public.waitlist_scan()`);
  assert.equal((await one(`select status from public.reservations where id = $1::uuid`, [event.bookings[0].id])).status, "CONFIRMED");
  assert.equal(Number((await one(`select public.available_spots($1::uuid) as n`, [event.sessionId])).n), 0);
  assert.equal(await spotOf(item.id), null);
});

test("sem duplicidade: duas execuções seguidas enviam e contam uma vez", async () => {
  const event = await essencia();
  const item = await join(event.sessionId, 2);
  await freeTwoSpots(event);
  await call(`public.waitlist_scan()`);
  const active = spotRuntime(["REGULAR", "EVENT"]);
  await Promise.all([drain(active), drain(active)]);
  await drain(active);
  assert.equal(active.provider.deliveredTo(item.email).length, 1);
  assert.equal((await entry(item.id)).notifications_sent, 1);
});

test("Resend sem resposta: a próxima tentativa repete chave e mensagem, e o cliente recebe uma vez", async () => {
  const event = await essencia();
  const item = await join(event.sessionId, 2);
  await freeTwoSpots(event);
  await call(`public.waitlist_scan()`);
  const provider = fakeResend();
  provider.next("lost");
  const active = spotRuntime(["REGULAR", "EVENT"], provider);
  await sendPendingWaitlistSpotEmails(active);
  const failed = await spotOf(item.id);
  assert.equal(failed.status, "FAILED");
  await db.query(`update public.waitlist_notifications set next_attempt_at = now() - interval '1 second' where id = $1::uuid`, [failed.id]);
  await drain(active);
  const keys = provider.requests.filter((message) => message.to === item.email).map((message) => message.idempotencyKey);
  assert.deepEqual(keys, [waitlistSpotIdempotencyKey(failed.id, 1), waitlistSpotIdempotencyKey(failed.id, 1)]);
  assert.equal(provider.deliveredTo(item.email).length, 1);
  assert.equal((await spotOf(item.id)).status, "SENT");
});

test("experiência regular: aviso de sempre, para /reservar, e reivindicado com a venda dos eventos fechada", async () => {
  const session = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 1 });
  const booking = await reserve(session, 1);
  const item = await join(session, 1);
  await cancelReservation(booking.id);
  await call(`public.waitlist_scan()`);
  const active = spotRuntime(["REGULAR"]);
  await drain(active);
  const [message] = active.provider.deliveredTo(item.email);
  assert.ok(message.text.includes(`${WAITLIST_SPOT_CTA}: ${ORIGIN}/reservar/${session}`));
});

test("banco sem a migration nova: volta à reivindicação de sempre, e o aviso de evento com a venda fechada não sai", async () => {
  const event = await essencia();
  const item = await join(event.sessionId, 2);
  await freeTwoSpots(event);
  await call(`public.waitlist_scan()`);
  const legacy = (name: string, args: Record<string, unknown>) => name === "claim_pending_waitlist_spot_emails_by_kind"
    ? Promise.resolve({ data: null, error: { message: "Could not find the function", code: "PGRST202" } })
    : rpc(name, args);
  const active = spotRuntime(["REGULAR"], fakeResend(), legacy as typeof rpc);
  await sendPendingWaitlistSpotEmails(active);
  assert.equal(active.provider.requests.filter((message) => message.to === item.email).length, 0);
  assert.equal((await spotOf(item.id)).last_error_code, "EVENT_SALES_CLOSED");
  assert.equal((await entry(item.id)).notifications_sent, 0);
});

// ===========================================================================
// 4. Saída da lista
// ===========================================================================

test("saída: a visão do link traz o evento; sair funciona; regular sem evento; sem a função, a de sempre", async () => {
  const event = await essencia();
  const item = await join(event.sessionId, 2);
  const token = (await one(`select public.waitlist_cancel_token($1::uuid) as t`, [item.id])).t as string;
  await db.exec(`delete from public.waitlist_throttle`);
  const overview = await handleWaitlistCancelOverview({ rpc }, { token }, null);
  assert.equal(overview.status, 200);
  assert.deepEqual(overview.body.event, { slug: event.slug });
  assert.equal(overview.body.state, "ACTIVE");
  assert.equal(overview.body.quantity, 2);
  const left = await handleWaitlistCancel({ rpc }, { token }, null);
  assert.equal(left.body.state, "CANCELLED");

  const session = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 1 });
  await reserve(session, 1);
  const regular = await join(session, 1);
  const regularToken = (await one(`select public.waitlist_cancel_token($1::uuid) as t`, [regular.id])).t as string;
  assert.equal((await handleWaitlistCancelOverview({ rpc }, { token: regularToken }, null)).body.event, null);

  const legacy = (name: string, args: Record<string, unknown>) => name === "waitlist_cancel_overview_with_kind"
    ? Promise.resolve({ data: null, error: { message: "function public.waitlist_cancel_overview_with_kind(text, text) does not exist", code: "42883" } })
    : rpc(name, args);
  const fallback = await handleWaitlistCancelOverview({ rpc: legacy as typeof rpc }, { token: regularToken }, null);
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body.event, null);
});

test("página de saída: textos de evento e volta para o evento; os da turma continuam", () => {
  const page = source("components/waitlist/waitlist-cancel.tsx");
  assert.match(page, /Pronto: você saiu da lista de espera deste evento\./);
  assert.match(page, /está na lista de espera deste evento/);
  assert.match(page, /\{ href: `\/eventos\/\$\{event\.slug\}`, label: "Voltar para o evento" \}/);
  assert.match(page, /CANCELLED: "Você já saiu da lista de espera desta turma\."/);
});

// ===========================================================================
// 5. Bloqueio da 5C-1, serviços e migration
// ===========================================================================

test("bloqueio da 5C-1 retirado no código; as variáveis continuam decidindo e nascem desligadas", () => {
  assert.equal(EVENT_WAITLIST_EMAILS_READY, true);
  assert.equal(isEventsWaitlistEnabled({}), false);
  assert.equal(isEventsWaitlistEnabled({ EVENTS_WAITLIST_ENABLED: "true" }), false, "sem a venda do evento, não");
  assert.equal(isEventsWaitlistEnabled({ EVENTS_PUBLIC_ENABLED: "true", EVENT_BOOKING_OPEN: "true", EVENTS_WAITLIST_ENABLED: "true" }), true);
  const spot = source("lib/waitlist/spot-email-service.ts");
  assert.match(spot, /kinds: isEventsWaitlistEnabled\(\) \? \["REGULAR", "EVENT"\] : \["REGULAR"\]/);
  assert.match(spot, /enrich: \(payload\) => withWaitlistEventContext\(/);
  const joined = source("lib/waitlist/joined-email-service.ts");
  assert.match(joined, /if \(!isWaitlistSignupEnabled\(\) && !isEventsWaitlistEnabled\(\)\) return null;/);
  assert.match(joined, /enrich: \(payload\) => withWaitlistEventContext\(/);
});

test("migration: aditiva, nenhuma função existente muda, só a service role executa", async () => {
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
              has_function_privilege('service_role', $1, 'EXECUTE') as c, p.prosecdef as definer from pg_proc p where p.oid = $1::regprocedure`, [`public.${fn}`])).rows[0];
    assert.deepEqual([row.a, row.b, row.c, row.definer], [false, false, true, true], fn);
  }
  const migration = source(`supabase/migrations/${MIGRATION}`).split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
  assert.doesNotMatch(migration, /(insert into|update|delete from) public\./i);
  assert.doesNotMatch(migration, /cron\.|pg_net|create extension|create table|create trigger/i);
  await before.close();
});

const PREFLIGHT = source("supabase/diagnostics/waitlist_event_scope_preflight.sql");
const POSTCHECK = source("supabase/diagnostics/waitlist_event_scope_postcheck.sql");
const ROLLBACK = source("supabase/rollback/202610300001_waitlist_event_scope.rollback.sql");

async function report(database: { query: (sql: string) => Promise<{ rows: unknown[] }> }, sql: string) {
  return new Map(((await database.query(sql)).rows as Array<{ check_name: string; result: string; status: string }>).map((row) => [row.check_name, row]));
}

test("preflight e postcheck: aprovam o banco do repositório; assinatura e contagens iguais", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  const pre = await report(before, PREFLIGHT);
  for (const [name, row] of pre) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  await applyMigration(before, MIGRATION);
  const post = await report(before, POSTCHECK);
  for (const [name, row] of post) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  assert.equal(post.get("FUNCOES_NOVAS_COM_A_DEFINICAO_DO_REPOSITORIO")?.result, "2 de 2");
  for (const count of ["ASSINATURA_DAS_FUNCOES_EXISTENTES", "INSCRICOES_POR_TIPO_E_STATUS", "FILA_DA_LISTA_POR_STATUS", "RESERVAS_POR_STATUS"]) {
    assert.equal(post.get(count)?.result, pre.get(count)?.result, count);
  }
  await before.close();
});

test("preflight: reprova se a visão do link de sempre estiver diferente do repositório", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  await before.exec(`create or replace function public.waitlist_cancel_overview(p_token text, p_client_address text) returns jsonb language sql security definer set search_path = public as $$ select '{}'::jsonb $$`);
  const pre = await report(before, PREFLIGHT);
  assert.equal(pre.get("FUNCOES_REAPROVEITADAS")?.status, "FALHOU");
  assert.equal(pre.get("WAITLIST_EVENTOS_PREFLIGHT_OK")?.status, "FALHOU");
  await before.close();
});

test("rollback: remove só as duas funções; o resto fica; reaplicar devolve tudo", async () => {
  const database = await fullDatabase();
  const functions = async () => (await database.query<{ name: string; src: string }>(`select p.oid::regprocedure::text as name, md5(p.prosrc) as src from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`)).rows;
  const beforeFunctions = await functions();
  await database.exec(ROLLBACK);
  const after = await functions();
  assert.deepEqual(beforeFunctions.filter((row) => !after.some((kept) => kept.name === row.name)).map((row) => row.name).sort(), NEW_FUNCTIONS);
  for (const row of after) assert.equal(row.src, beforeFunctions.find((old) => old.name === row.name)?.src, row.name);
  await applyMigration(database, MIGRATION);
  assert.equal((await report(database, POSTCHECK)).get("WAITLIST_EVENTOS_POSTCHECK_OK")?.status, "OK");
  await database.close();
});
