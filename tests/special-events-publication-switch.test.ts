/**
 * Eventos especiais — o interruptor de publicação também nas leituras.
 *
 * Com `special_event_settings.publication_enabled = false`, um evento já
 * publicado some das leituras públicas (`list_public_events`,
 * `get_public_event`, `list_public_event_sessions`), a reserva é recusada no
 * servidor mesmo com a venda aberta e o id em mãos, a página de reserva não cai
 * na tela regular, a inscrição na lista de espera é recusada e nenhum aviso de
 * vaga do evento é reivindicado — sem gastar tentativa. Religado, volta o que
 * ainda for elegível; rascunho e venda fechada continuam como estão. As
 * experiências regulares não mudam.
 *
 * Postgres em memória com todas as migrations; provedor de e-mail falso.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { eventBookingRejection, isEventSessionPublic, loadSessionBookingRules, type RulesQueryClient } from "../lib/events/booking.ts";
import { ESSENCIA_CAPACITY, ESSENCIA_EDITORIAL } from "../lib/events/fixtures/essencia.ts";
import { isEventWaitlistVisible, loadWaitlistTarget, resolveWaitlistScope } from "../lib/events/waitlist.ts";
import { withWaitlistEventContext } from "../lib/events/waitlist-email.ts";
import { mapPublicEvent } from "../lib/events/public.ts";
import { handleWaitlistSignup } from "../lib/waitlist/signup.ts";
import { createWaitlistSpotQueue, sendPendingWaitlistSpotEmails, type WaitlistSpotRuntime } from "../lib/waitlist/spot-email.ts";
import { applyMigration, fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";
import { ADMIN, fakeResend, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

const MIGRATION = "202610310001_special_events_publication_switch.sql";
const PREVIOUS = "202610300001_waitlist_event_scope.sql";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const db = await fullDatabase();
const admin = createPgliteAdmin(db);
const client = admin.client as unknown as RulesQueryClient;
const rpc = (name: string, args: Record<string, unknown>) => admin.client.rpc(name, args);
const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
const { one, rows, call, SUNSET_CONCHA, IMERSAO, makeSession, reserve, uniquePrice } = fx;

await db.exec(`update public.waitlist_settings set detection_enabled = true, opening_grace_seconds = 0, wave_interval_minutes = 30`);

let sequence = 0;

async function setSwitch(on: boolean) {
  await rows(`update public.special_event_settings set publication_enabled = $1`, [on]);
}

/** O ESSÊNCIA publicado (interruptor ligado para publicar), sessão aberta, 24 vagas. */
async function essencia() {
  sequence += 1;
  const slug = `essencia-interruptor-${sequence}`;
  const created = await call(
    `public.admin_create_event($1::uuid, $2::uuid, $3, 'ESSÊNCIA — Corpo, Mente e Natureza', 'x', $4::jsonb, null, now() + interval '9 days', 210, 15000, $5)`,
    [ADMIN, SUNSET_CONCHA.base_id, slug, JSON.stringify(ESSENCIA_EDITORIAL), ESSENCIA_CAPACITY],
  );
  await setSwitch(true);
  await rows(`update public.experiences set status = 'PUBLISHED' where id = $1::uuid`, [created.experienceId]);
  await rows(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [created.sessionId]);
  return { slug, experienceId: created.experienceId as string, sessionId: created.sessionId as string };
}

async function visibleSlugs() {
  return (await rows(`select slug from public.list_public_events()`)).map((row) => row.slug as string);
}

async function getEvent(slug: string) {
  return (await rows(`select * from public.get_public_event($1)`, [slug]))[0] ?? null;
}

async function eventSessions(slug: string) {
  return rows(`select id from public.list_public_event_sessions($1)`, [slug]);
}

async function regularListings() {
  return {
    experiences: await rows(`select * from public.list_public_regular_experiences()`),
    catalog: await rows(`select * from public.list_public_regular_catalog()`),
  };
}

function person() {
  sequence += 1;
  return { fullName: `Pessoa Interruptor ${sequence}`, email: `interruptor${sequence}@teste.local`, phone: `(61) 98${String(200 + sequence).slice(-3)}-${String(1000 + sequence).slice(-4)}` };
}

function signupDeps() {
  return {
    rpc,
    sendConfirmation: async () => ({ outcome: "SENT" }),
    followUpConfirmation: async () => undefined,
    afterResponse: () => undefined,
    scope: (sessionId: string) => resolveWaitlistScope({
      loadTarget: (id) => loadWaitlistTarget(client, id),
      eventVisible: (slug, id) => isEventWaitlistVisible(rpc, slug, id),
      regularEnabled: false,
      eventsEnabled: true,
    }, sessionId),
  };
}

function spotRuntime(provider = fakeResend()): WaitlistSpotRuntime & { provider: ReturnType<typeof fakeResend> } {
  return {
    queue: createWaitlistSpotQueue({ rpc }), provider, pause: async () => undefined,
    kinds: ["REGULAR", "EVENT"],
    enrich: (payload) => withWaitlistEventContext(client, payload),
    eventPublic: (slug, sessionId) => isEventSessionPublic(client, slug, sessionId),
  };
}

// ===========================================================================
// 1. Leituras públicas
// ===========================================================================

test("publicado e elegível: as três leituras mostram o evento", async () => {
  const event = await essencia();
  assert.ok((await visibleSlugs()).includes(event.slug));
  assert.ok(mapPublicEvent(await getEvent(event.slug)));
  assert.deepEqual((await eventSessions(event.slug)).map((row) => row.id), [event.sessionId]);
});

test("interruptor desligado: as três leituras escondem o evento já publicado; religado, volta", async () => {
  const event = await essencia();
  await setSwitch(false);
  assert.ok(!(await visibleSlugs()).includes(event.slug));
  assert.equal(await getEvent(event.slug), null);
  assert.deepEqual(await eventSessions(event.slug), []);
  // O evento continua publicado no banco: só não aparece.
  assert.equal((await one(`select status from public.experiences where id = $1::uuid`, [event.experienceId])).status, "PUBLISHED");
  await setSwitch(true);
  assert.ok((await visibleSlugs()).includes(event.slug));
  assert.ok(await getEvent(event.slug));
});

test("religar não reabre rascunho nem sessão fechada", async () => {
  const draft = await essencia();
  await rows(`update public.experiences set status = 'DRAFT' where id = $1::uuid`, [draft.experienceId]);
  const closed = await essencia();
  await rows(`update public.sessions set status = 'CLOSED' where id = $1::uuid`, [closed.sessionId]);
  await setSwitch(false);
  await setSwitch(true);
  assert.equal(await getEvent(draft.slug), null, "rascunho continua fora");
  assert.equal(mapPublicEvent(await getEvent(closed.slug))?.session.availability, "CLOSED", "venda fechada continua fechada");
});

test("experiências regulares: listagens idênticas com o interruptor ligado ou desligado", async () => {
  await setSwitch(true);
  const on = await regularListings();
  await setSwitch(false);
  const off = await regularListings();
  assert.deepEqual(off, on);
  assert.ok(on.experiences.length > 0);
  await setSwitch(true);
});

// ===========================================================================
// 2. Reserva
// ===========================================================================

test("API de reservas: com a venda aberta e o id em mãos, evento escondido é recusado (EVENT_NOT_PUBLIC)", async () => {
  const event = await essencia();
  const open = await loadSessionBookingRules(client, event.sessionId);
  assert.deepEqual(open, { kind: "EVENT", maxPerOrder: 6, emailReady: true, visible: true });
  assert.equal(eventBookingRejection(open, 2, true), null);

  await setSwitch(false);
  const hidden = await loadSessionBookingRules(client, event.sessionId);
  assert.deepEqual(hidden, { kind: "EVENT", maxPerOrder: 6, emailReady: true, visible: false });
  assert.equal(eventBookingRejection(hidden, 2, true)?.code, "EVENT_NOT_PUBLIC");
  assert.equal(eventBookingRejection(hidden, 2, true)?.status, 409);
  // A recusa vem antes de qualquer pré-reserva: nada foi gravado.
  assert.equal((await rows(`select id from public.reservations where session_id = $1::uuid`, [event.sessionId])).length, 0);
  await setSwitch(true);
});

test("API de reservas: evento em rascunho e sessão arquivada também ficam fora; regular nunca é afetada", async () => {
  const draft = await essencia();
  await rows(`update public.experiences set status = 'DRAFT' where id = $1::uuid`, [draft.experienceId]);
  assert.equal(eventBookingRejection(await loadSessionBookingRules(client, draft.sessionId), 1, true)?.code, "EVENT_NOT_PUBLIC");

  const archived = await essencia();
  await rows(`update public.sessions set status = 'ARCHIVED' where id = $1::uuid`, [archived.sessionId]);
  assert.equal(eventBookingRejection(await loadSessionBookingRules(client, archived.sessionId), 1, true)?.code, "EVENT_NOT_PUBLIC");

  await setSwitch(false);
  const regular = await makeSession(IMERSAO.id, { price: uniquePrice() });
  assert.deepEqual(await loadSessionBookingRules(client, regular), { kind: "REGULAR" });
  assert.equal(eventBookingRejection({ kind: "REGULAR" }, 2, true), null);
  await setSwitch(true);
});

test("sem como conferir a visibilidade (sem rpc): falha fechada; erro de leitura lança", async () => {
  const event = await essencia();
  const noRpc = { from: client.from.bind(client) } as RulesQueryClient;
  assert.equal(await isEventSessionPublic(noRpc, event.slug, event.sessionId), false);
  const broken = { ...client, rpc: async () => ({ data: null, error: { message: "timeout" } }) } as RulesQueryClient;
  await assert.rejects(isEventSessionPublic(broken, event.slug, event.sessionId), /BOOKING_RULES_FAILED/);
});

test("página de reserva: lê o tipo real da sessão e nunca mostra a tela regular para evento escondido", () => {
  const page = source("app/reservar/[sessionId]/page.tsx");
  assert.match(page, /loadWaitlistTarget\(admin as unknown as RulesQueryClient, sessionId\)/);
  assert.match(page, /const hiddenEvent = !event && kind\?\.kind === "EVENT";/);
  assert.match(page, /if \(hiddenEvent\) session = null;/);
  assert.ok(page.indexOf("{hiddenEvent ? (") < page.indexOf(") : event ? ("), "o bloqueio vem antes de qualquer tela");
  const route = source("app/api/reservations/route.ts");
  assert.ok(route.indexOf("loadSessionBookingRules(") < route.indexOf("create_pre_reservation"), "regra antes da pré-reserva");
});

// ===========================================================================
// 3. Lista de espera
// ===========================================================================

test("inscrição na lista de espera: evento escondido é recusado; religado e esgotado, aceita", async () => {
  const event = await essencia();
  await reserve(event.sessionId, 12);
  await reserve(event.sessionId, 12);
  await db.exec(`delete from public.waitlist_throttle`);
  await setSwitch(false);
  const who = person();
  const hidden = await handleWaitlistSignup(signupDeps(), { sessionId: event.sessionId, ...who, quantity: 2, website: "" }, null);
  assert.equal(hidden.status, 409);
  assert.equal(hidden.body.code, "SESSION_UNAVAILABLE");
  assert.equal((await rows(`select id from public.waitlist_entries where session_id = $1::uuid`, [event.sessionId])).length, 0);
  await setSwitch(true);
  const back = await handleWaitlistSignup(signupDeps(), { sessionId: event.sessionId, ...person(), quantity: 2, website: "" }, null);
  assert.equal(back.status, 200);
});

test("aviso de vaga: com o evento escondido não é reivindicado (sem tentativa); religado, sai uma vez", async () => {
  const event = await essencia();
  const first = await reserve(event.sessionId, 12);
  await reserve(event.sessionId, 12);
  await db.exec(`delete from public.waitlist_throttle`);
  const who = person();
  assert.equal((await call(`public.waitlist_join($1::uuid, $2, $3, '+5561970000001', 2, null, '')`, [event.sessionId, who.fullName, who.email])).status, "ACCEPTED");
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Libera a vaga')`, [ADMIN, first.id]);
  await reserve(event.sessionId, 10);
  await call(`public.waitlist_scan()`);
  const notice = await one(`select n.id from public.waitlist_notifications n join public.waitlist_entries we on we.id = n.entry_id where we.email = $1 and n.kind = 'SPOT_AVAILABLE'`, [who.email]);

  await setSwitch(false);
  const active = spotRuntime();
  assert.equal((await sendPendingWaitlistSpotEmails(active)).outcome, "PROCESSED");
  const queued = await one(`select status, attempts from public.waitlist_notifications where id = $1::uuid`, [notice.id]);
  assert.deepEqual([queued.status, queued.attempts], ["QUEUED", 0]);
  assert.equal(active.provider.requests.length, 0);

  await setSwitch(true);
  await sendPendingWaitlistSpotEmails(active);
  await sendPendingWaitlistSpotEmails(active);
  assert.equal(active.provider.deliveredTo(who.email).length, 1);
  assert.equal((await one(`select notifications_sent from public.waitlist_entries where email = $1`, [who.email])).notifications_sent, 1);
});

test("segunda barreira no envio: aviso já reivindicado de evento que ficou escondido não sai", async () => {
  const provider = fakeResend();
  const failed: string[] = [];
  const claim = { notificationId: "00000000-0000-4000-8000-0000000a0001", claimToken: "t", attempt: 1, generation: 1, message: null, payload: { sessionId: "00000000-0000-4000-8000-0000000a0002" } };
  const runtime: WaitlistSpotRuntime = {
    provider, pause: async () => undefined, kinds: ["REGULAR", "EVENT"],
    queue: {
      claimPending: async () => (failed.length ? [] : [claim]),
      freeze: async () => true,
      complete: async () => undefined,
      fail: async (_claim, code) => { failed.push(code); },
    },
    enrich: async () => ({
      notificationId: claim.notificationId, fullName: "Pessoa Teste", email: "p@teste.local", quantity: 1, sessionId: claim.payload.sessionId,
      experienceTitle: "ESSÊNCIA", startsAt: "2026-11-07T08:30:00.000Z", baseName: "B", priceCents: 15000, remainingSpots: 1, cancelToken: "a".repeat(64),
      experienceKind: "EVENT", eventSlug: "essencia", eventEditorial: ESSENCIA_EDITORIAL,
    }),
    eventPublic: async () => false,
  };
  await sendPendingWaitlistSpotEmails(runtime);
  assert.deepEqual(failed, ["EVENT_NOT_PUBLIC"]);
  assert.equal(provider.requests.length, 0);
});

// ===========================================================================
// 4. Migrations: ordem, preflight, postcheck e rollback
// ===========================================================================

const PREFLIGHT = source("supabase/diagnostics/special_events_publication_switch_preflight.sql");
const POSTCHECK = source("supabase/diagnostics/special_events_publication_switch_postcheck.sql");
const ROLLBACK = source("supabase/rollback/202610310001_special_events_publication_switch.rollback.sql");

async function report(database: { query: (sql: string) => Promise<{ rows: unknown[] }> }, sql: string) {
  return new Map(((await database.query(sql)).rows as Array<{ check_name: string; result: string; status: string }>).map((row) => [row.check_name, row]));
}

test("migration: só muda as duas leituras; assinaturas, permissões e as outras funções iguais", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  const snapshot = async () => (await before.query<{ name: string; src: string; anon: boolean; definer: boolean }>(
    `select p.oid::regprocedure::text as name, md5(p.prosrc) as src, has_function_privilege('anon', p.oid, 'execute') as anon, p.prosecdef as definer
     from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`,
  )).rows;
  const old = await snapshot();
  await applyMigration(before, MIGRATION);
  const current = await snapshot();
  assert.deepEqual(current.map((row) => row.name), old.map((row) => row.name), "nenhuma função nova ou removida");
  const changed = current.filter((row) => old.find((item) => item.name === row.name)?.src !== row.src).map((row) => row.name).sort();
  assert.deepEqual(changed, ["list_public_event_sessions(text)", "list_public_events()"]);
  for (const row of current) {
    const was = old.find((item) => item.name === row.name)!;
    assert.deepEqual([row.anon, row.definer], [was.anon, was.definer], row.name);
  }
  await applyMigration(before, MIGRATION);
  const migration = source(`supabase/migrations/${MIGRATION}`).split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
  assert.doesNotMatch(migration, /(insert into|update|delete from) public\./i);
  assert.doesNotMatch(migration, /cron\.|pg_net|create extension|create table|create trigger|grant |revoke /i);
  await before.close();
});

test("ordem: a correção não depende da 202610300001 — vale aplicada antes ou depois dela", async () => {
  const onlyFoundation = await fullDatabase({ until: "202610280001_special_events_foundation.sql" });
  await applyMigration(onlyFoundation, MIGRATION);
  assert.equal((await report(onlyFoundation, POSTCHECK)).get("EVENTOS_INTERRUPTOR_POSTCHECK_OK")?.status, "OK");
  await applyMigration(onlyFoundation, PREVIOUS);
  assert.equal(((await onlyFoundation.query(`select count(*)::int as n from pg_proc where proname = 'claim_pending_waitlist_spot_emails_by_kind'`)).rows[0] as { n: number }).n, 1);
  assert.equal((await report(onlyFoundation, POSTCHECK)).get("LEITURAS_COM_A_DEFINICAO_DO_REPOSITORIO")?.status, "OK");
  assert.match(source(`supabase/migrations/${PREVIOUS}`), /e\.kind <> 'EVENT' or coalesce\(\(select ses\.publication_enabled from public\.special_event_settings ses where ses\.singleton\), false\)/);
  await onlyFoundation.close();
});

test("preflight e postcheck: aprovam nas duas pontas; contagens e listagens regulares iguais", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  const pre = await report(before, PREFLIGHT);
  for (const [name, row] of pre) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  assert.match(pre.get("LEITURAS_DE_EVENTOS")!.result, /list_public_events=CORPO_DA_FUNDACAO/);
  await applyMigration(before, MIGRATION);
  const post = await report(before, POSTCHECK);
  for (const [name, row] of post) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  assert.equal(post.get("LEITURAS_COM_A_DEFINICAO_DO_REPOSITORIO")?.result, "3 de 3");
  for (const count of ["ASSINATURA_DAS_OUTRAS_FUNCOES", "LISTAGENS_REGULARES", "EVENTOS_POR_STATUS", "RESERVAS_POR_STATUS"]) {
    assert.equal(post.get(count)?.result, pre.get(count)?.result, count);
  }
  // Reaplicar a preflight depois: ATENCAO, não FALHOU.
  assert.equal((await report(before, PREFLIGHT)).get("LEITURAS_DE_EVENTOS")?.status, "ATENCAO");
  await before.close();
});

test("preflight: reprova leitura alterada à mão", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  await before.exec(`create or replace function public.list_public_event_sessions(p_slug text) returns table (id uuid, experience_id uuid, experience_slug text, experience_title text, starts_at timestamptz, duration_minutes integer, price_cents integer, remaining_spots integer, availability text) language sql stable security definer set search_path = public as $$ select null::uuid, null::uuid, null, null, null::timestamptz, 0, 0, 0, null where false $$`);
  assert.equal((await report(before, PREFLIGHT)).get("EVENTOS_INTERRUPTOR_PREFLIGHT_OK")?.status, "FALHOU");
  await before.close();
});

test("rollback: devolve o corpo da fundação às duas leituras, e mais nada; reaplicar devolve tudo", async () => {
  const database = await fullDatabase();
  const foundation = await fullDatabase({ until: PREVIOUS });
  const bodies = async (d: typeof database) => (await d.query<{ name: string; src: string }>(`select p.oid::regprocedure::text as name, md5(p.prosrc) as src from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`)).rows;
  const original = await bodies(foundation);
  await database.exec(ROLLBACK);
  const rolled = await bodies(database);
  for (const name of ["list_public_events()", "list_public_event_sessions(text)", "get_public_event(text)"]) {
    assert.equal(rolled.find((row) => row.name === name)?.src, original.find((row) => row.name === name)?.src, name);
  }
  await applyMigration(database, MIGRATION);
  assert.equal((await report(database, POSTCHECK)).get("EVENTOS_INTERRUPTOR_POSTCHECK_OK")?.status, "OK");
  await database.close();
  await foundation.close();
});
