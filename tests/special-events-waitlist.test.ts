/**
 * Eventos especiais — etapa 5C-1: lista de espera do evento, com escopo próprio.
 *
 * A inscrição do evento é a de sempre (`handleWaitlistSignup` → `waitlist_join`),
 * com o escopo decidido no servidor: `EVENTS_WAITLIST_ENABLED` só vale para
 * sessão de evento publicado e esgotado, a inscrição regular só para sessão
 * regular, e o evento respeita o máximo por pedido. Contra o Postgres em
 * memória com todas as migrations; nenhum e-mail sai (o envio é falso).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { RulesQueryClient } from "../lib/events/booking.ts";
import { ESSENCIA_CAPACITY, ESSENCIA_EDITORIAL } from "../lib/events/fixtures/essencia.ts";
import { EVENT_WAITLIST_EMAILS_READY, isEventBookingOpen, isEventsWaitlistEnabled } from "../lib/events/flags.ts";
import { eventCta } from "../lib/events/presentation.ts";
import {
  EVENT_WAITLIST_INVITE,
  EVENT_WAITLIST_MESSAGES,
  isEventWaitlistVisible,
  loadWaitlistTarget,
  resolveWaitlistScope,
  type WaitlistTarget,
} from "../lib/events/waitlist.ts";
import { handleWaitlistCancel, handleWaitlistSignup, isWaitlistSignupEnabled, WAITLIST_MESSAGES, type WaitlistSignupDeps } from "../lib/waitlist/signup.ts";
import { fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";
import { ADMIN, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const db = await fullDatabase();
const admin = createPgliteAdmin(db);
const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
const { one, rows, call, IMERSAO, SUNSET_CONCHA, makeSession, reserve, uniquePrice } = fx;
const rpc = (name: string, args: Record<string, unknown>) => admin.client.rpc(name, args);
const rulesClient = admin.client as unknown as RulesQueryClient;

let sequence = 0;

/** O ESSÊNCIA no banco de teste: publicado, sessão aberta, 24 vagas, R$ 150. */
async function essencia() {
  sequence += 1;
  const slug = `essencia-lista-${sequence}`;
  const created = await call(
    `public.admin_create_event($1::uuid, $2::uuid, $3, 'ESSÊNCIA — Corpo, Mente e Natureza', 'Canoa, meditação e Superioga', $4::jsonb, null, now() + interval '9 days', 210, 15000, $5)`,
    [ADMIN, SUNSET_CONCHA.base_id, slug, JSON.stringify(ESSENCIA_EDITORIAL), ESSENCIA_CAPACITY],
  );
  await rows(`update public.special_event_settings set publication_enabled = true`);
  await rows(`update public.experiences set status = 'PUBLISHED' where id = $1::uuid`, [created.experienceId]);
  await rows(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [created.sessionId]);
  return { slug, experienceId: created.experienceId as string, sessionId: created.sessionId as string };
}

/** 24 de 24 ocupadas, por reservas pagas pelo caminho real. */
async function soldOutEssencia() {
  const event = await essencia();
  await reserve(event.sessionId, 12);
  await reserve(event.sessionId, 12);
  return event;
}

function person() {
  sequence += 1;
  return { fullName: `Marina Espera ${sequence}`, email: `essencia${sequence}@teste.local`, phone: `(61) 98${String(100_000 + sequence).slice(-3)}-${String(1000 + sequence).slice(-4)}` };
}

function body(sessionId: string, who: ReturnType<typeof person>, quantity = 1) {
  return { sessionId, fullName: who.fullName, email: who.email, phone: who.phone, quantity, website: "" };
}

/** A rota de verdade, sem Next: escopo pelo banco, com as duas variáveis escolhidas. */
function deps(flags: { regularEnabled: boolean; eventsEnabled: boolean }, loadTarget?: (id: string) => Promise<WaitlistTarget | null>) {
  const sent: string[] = [];
  const result: WaitlistSignupDeps & { sent: string[] } = {
    rpc,
    sendConfirmation: async (_sessionId, email) => { sent.push(email); return { outcome: "SENT" }; },
    followUpConfirmation: async () => undefined,
    afterResponse: (task) => { void task(); },
    scope: (sessionId) => resolveWaitlistScope({
      loadTarget: loadTarget ?? ((id) => loadWaitlistTarget(rulesClient, id)),
      eventVisible: (slug, id) => isEventWaitlistVisible(rpc, slug, id),
      ...flags,
    }, sessionId),
    sent,
  };
  return result;
}

const EVENTS_ONLY = { regularEnabled: false, eventsEnabled: true };
const REGULAR_ONLY = { regularEnabled: true, eventsEnabled: false };

async function entries(sessionId: string) {
  return rows(`select * from public.waitlist_entries where session_id = $1::uuid order by queue_sequence`, [sessionId]);
}

async function resetThrottle() {
  await db.exec(`delete from public.waitlist_throttle`);
}

// ===========================================================================
// 1. Variáveis: cada tipo com a sua
// ===========================================================================

test("variável: desligada por padrão, a trava do código ainda fecha, e independente da regular", () => {
  const all = { EVENTS_PUBLIC_ENABLED: "true", EVENT_BOOKING_OPEN: "true", EVENTS_WAITLIST_ENABLED: "true" };
  assert.equal(isEventsWaitlistEnabled({}), false);
  // 5C-2: os e-mails do evento existem e a trava saiu; voltar a `false` fecha tudo de novo.
  assert.equal(EVENT_WAITLIST_EMAILS_READY, true);
  assert.equal(isEventsWaitlistEnabled(all), true);
  assert.equal(isEventsWaitlistEnabled(all, false), false);
  assert.equal(isEventsWaitlistEnabled(all, true), true);
  // Exige a venda do evento aberta.
  assert.equal(isEventsWaitlistEnabled({ ...all, EVENT_BOOKING_OPEN: undefined }, true), false);
  assert.equal(isEventsWaitlistEnabled({ ...all, EVENTS_PUBLIC_ENABLED: undefined }, true), false);
  assert.equal(isEventsWaitlistEnabled({ ...all, EVENTS_WAITLIST_ENABLED: "1" }, true), false);
  // Uma não liga a outra.
  assert.equal(isWaitlistSignupEnabled(all), false, "a variável dos eventos não abre a lista regular");
  assert.equal(isEventsWaitlistEnabled({ WAITLIST_PUBLIC_ENABLED: "true", WAITLIST_SIGNUP_ENABLED: "true", ...{ EVENTS_PUBLIC_ENABLED: "true", EVENT_BOOKING_OPEN: "true" } }, true), false, "a regular não abre a dos eventos");
  assert.equal(isEventBookingOpen(all), true);
});

// ===========================================================================
// 2. Inscrição no evento
// ===========================================================================

test("evento com vagas: não entra na lista — o caminho é garantir o ingresso", async () => {
  const event = await essencia();
  const response = await handleWaitlistSignup(deps(EVENTS_ONLY), body(event.sessionId, person()), null);
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "NOT_SOLD_OUT");
  assert.equal(response.body.message, EVENT_WAITLIST_MESSAGES.NOT_SOLD_OUT);
  assert.equal(response.body.reserveHref, `/reservar/${event.sessionId}`);
  assert.equal((await entries(event.sessionId)).length, 0);
});

test("evento esgotado (24 de 24): entra na lista, com texto de evento e confirmação na fila", async () => {
  const event = await soldOutEssencia();
  assert.equal(Number((await one(`select public.available_spots($1::uuid) as n`, [event.sessionId])).n), 0);
  const harness = deps(EVENTS_ONLY);
  const who = person();
  const response = await handleWaitlistSignup(harness, body(event.sessionId, who, 2), "203.0.113.90");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: "ACCEPTED", message: EVENT_WAITLIST_MESSAGES.ACCEPTED });
  assert.doesNotMatch(String(response.body.message), /turma/i);
  const [entry] = await entries(event.sessionId);
  assert.deepEqual([entry.status, entry.quantity, entry.email], ["ACTIVE", 2, who.email]);
  const joined = await one(`select kind, status from public.waitlist_notifications where entry_id = $1::uuid`, [entry.id]);
  assert.deepEqual(joined, { kind: "JOINED", status: "QUEUED" });
  // A lista não reserva nem bloqueia vaga: as reservas são as mesmas 2 de antes.
  assert.equal((await rows(`select id from public.reservations where session_id = $1::uuid`, [event.sessionId])).length, 2);
});

test("até 6 por pedido: 7 é recusado antes do banco; 6 entra", async () => {
  const event = await soldOutEssencia();
  await resetThrottle();
  const tooMany = await handleWaitlistSignup(deps(EVENTS_ONLY), body(event.sessionId, person(), 7), null);
  assert.equal(tooMany.status, 400);
  assert.deepEqual(tooMany.body.errors, { quantity: "Cada pedido deste evento aceita até 6 participantes." });
  assert.equal((await entries(event.sessionId)).length, 0);
  const six = await handleWaitlistSignup(deps(EVENTS_ONLY), body(event.sessionId, person(), 6), null);
  assert.equal(six.status, 200);
  assert.equal((await entries(event.sessionId))[0].quantity, 6);
});

test("saída da lista: o link de sempre tira a inscrição do evento", async () => {
  const event = await soldOutEssencia();
  await resetThrottle();
  const who = person();
  await handleWaitlistSignup(deps(EVENTS_ONLY), body(event.sessionId, who, 2), null);
  const [entry] = await entries(event.sessionId);
  const token = (await one(`select public.waitlist_cancel_token($1::uuid) as t`, [entry.id])).t as string;
  const cancelled = await handleWaitlistCancel({ rpc }, { token }, null);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.state, "CANCELLED");
  assert.equal((await entries(event.sessionId))[0].status, "CANCELLED");
});

// ===========================================================================
// 3. Escopo no servidor: chamada direta à API
// ===========================================================================

test("variável dos eventos desligada: API direta com o id da sessão do evento responde 404 e não grava", async () => {
  const event = await soldOutEssencia();
  await resetThrottle();
  const response = await handleWaitlistSignup(deps(REGULAR_ONLY), body(event.sessionId, person(), 2), null);
  assert.equal(response.status, 404);
  assert.equal((await entries(event.sessionId)).length, 0);
  const both = await handleWaitlistSignup(deps({ regularEnabled: false, eventsEnabled: false }), body(event.sessionId, person(), 2), null);
  assert.equal(both.status, 404);
});

test("experiência regular com a lista regular desligada: a variável dos eventos não a abre", async () => {
  const session = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 2 });
  await reserve(session, 2);
  await resetThrottle();
  const response = await handleWaitlistSignup(deps(EVENTS_ONLY), body(session, person(), 1), null);
  assert.equal(response.status, 404);
  assert.equal((await entries(session)).length, 0);
  // Com a regular ligada, a regular é a de sempre — textos de turma inclusive.
  const regular = await handleWaitlistSignup(deps(REGULAR_ONLY), body(session, person(), 1), null);
  assert.deepEqual(regular.body, { status: "ACCEPTED", message: WAITLIST_MESSAGES.ACCEPTED });
});

test("evento fora do site: outra edição ou despublicado — 409, sem gravar", async () => {
  const event = await soldOutEssencia();
  await resetThrottle();

  // Uma segunda edição, mais adiante: não é a que o site mostra.
  const later = await makeSession(event.experienceId, { price: 15_000, capacity: 2, startsIn: "40 days" });
  await reserve(later, 2);
  const otherEdition = await handleWaitlistSignup(deps(EVENTS_ONLY), body(later, person(), 1), null);
  assert.equal(otherEdition.status, 409);
  assert.equal(otherEdition.body.code, "SESSION_UNAVAILABLE");
  assert.equal(otherEdition.body.message, EVENT_WAITLIST_MESSAGES.SESSION_UNAVAILABLE);

  await rows(`update public.experiences set status = 'DRAFT' where id = $1::uuid`, [event.experienceId]);
  const unpublished = await handleWaitlistSignup(deps(EVENTS_ONLY), body(event.sessionId, person(), 1), null);
  assert.equal(unpublished.status, 409);
  assert.equal((await entries(event.sessionId)).length, 0);
  assert.equal((await entries(later)).length, 0);
});

test("sem conseguir ler o tipo da sessão: 503, nunca inscrição às cegas", async () => {
  const event = await soldOutEssencia();
  const broken = deps(EVENTS_ONLY, async () => { throw new Error("fetch failed"); });
  const response = await handleWaitlistSignup(broken, body(event.sessionId, person(), 1), null);
  assert.equal(response.status, 503);
  assert.equal((await entries(event.sessionId)).length, 0);
});

test("tipo da sessão: lido do banco — evento com slug e máximo por pedido; regular; inexistente", async () => {
  const event = await essencia();
  assert.deepEqual(await loadWaitlistTarget(rulesClient, event.sessionId), { kind: "EVENT", slug: event.slug, maxPerOrder: 6 });
  const regular = await makeSession(IMERSAO.id, { price: uniquePrice() });
  assert.deepEqual(await loadWaitlistTarget(rulesClient, regular), { kind: "REGULAR" });
  assert.equal(await loadWaitlistTarget(rulesClient, "00000000-0000-4000-8000-000000000000"), null);
});

// ===========================================================================
// 4. Página do evento e links
// ===========================================================================

test("página do evento: esgotado com a lista ligada mostra o convite e leva à lista desta edição", () => {
  const waitlist = eventCta({ availability: "SOLD_OUT", sessionId: "s-1", ctaLabel: "Garantir minha vaga", bookingOpen: true, waitlistHref: "/lista-de-espera/s-1" });
  assert.deepEqual(waitlist, { kind: "WAITLIST", label: "Entrar na lista de espera", href: "/lista-de-espera/s-1", title: "Evento esgotado", note: EVENT_WAITLIST_INVITE });
  assert.equal(EVENT_WAITLIST_INVITE, "Todas as vagas desta edição foram preenchidas. Entre para a lista de espera e seja avisado caso surja uma oportunidade.");
  // Sem a lista, o esgotado de sempre; com vaga, nada muda.
  assert.deepEqual(eventCta({ availability: "SOLD_OUT", sessionId: "s-1", ctaLabel: "x", bookingOpen: true }), { kind: "UNAVAILABLE", label: "Esgotado", note: "Todas as vagas desta edição foram reservadas." });
  assert.equal(eventCta({ availability: "AVAILABLE", sessionId: "s-1", ctaLabel: "Garantir minha vaga", bookingOpen: true, waitlistHref: "/lista-de-espera/s-1" }).kind, "BOOK");
  assert.equal(eventCta({ availability: "CLOSED", sessionId: "s-1", ctaLabel: "x", bookingOpen: true, waitlistHref: "/lista-de-espera/s-1" }).kind, "UNAVAILABLE");

  const page = source("components/events/event-page.tsx");
  assert.match(page, /!waitlistOpen \? null : preview \? "#reserva" : session\.id \? `\/lista-de-espera\/\$\{session\.id\}` : null/);
  assert.match(source("app/eventos/[slug]/page.tsx"), /waitlistOpen=\{isEventsWaitlistEnabled\(\)\}/);
  assert.match(source("components/events/event-parts.tsx"), /cta\.kind === "BOOK" \|\| cta\.kind === "WAITLIST"/);
});

test("lista do evento: página com textos de evento, até 6, volta para o evento; regular intocada", () => {
  const page = source("app/lista-de-espera/[sessionId]/page.tsx");
  assert.match(page, /loadWaitlistTarget\(admin as unknown as RulesQueryClient, sessionId\)/);
  assert.match(page, /if \(!eventsEnabled\) notFound\(\);/);
  assert.match(page, /event && event\.session\.id === sessionId \? event : null/);
  assert.match(page, /href=\{`\/eventos\/\$\{slug\}`\}[^>]*>.*Voltar para o evento/);
  const form = source("components/waitlist/waitlist-signup-form.tsx");
  assert.match(form, /event \? "Participantes" : "Quantidade de pessoas"/);
  assert.match(form, /Até \{event\.maxPerOrder\} por pedido\./);
  assert.match(form, /href=\{`\/eventos\/\$\{event\.slug\}`\}/);
  // O texto regular continua o mesmo.
  assert.match(form, /Se abrir uma vaga nesta turma, você recebe um aviso por e-mail\./);

  const reserve = source("app/reservar/[sessionId]/page.tsx");
  assert.match(reserve, /href=\{`\/lista-de-espera\/\$\{event\.session\.id\}`\}/);
  assert.match(reserve, /isEventsWaitlistEnabled\(\) && event\.session\.availability === "SOLD_OUT"/);
});

test("rota: 404 sem nenhuma das variáveis, sem tocar no banco; escopo sempre passado", () => {
  const http = source("lib/waitlist/signup-http.ts");
  assert.match(http, /if \(!regularEnabled && !eventsEnabled\) return \{ deps: null, response: refuse\(404/);
  assert.match(http, /scope: \(sessionId\) => resolveWaitlistScope\(/);
  assert.ok(http.indexOf("!regularEnabled && !eventsEnabled") < http.indexOf("getSupabaseAdminClient()"));
  assert.match(source(".env.example"), /^# EVENTS_WAITLIST_ENABLED=true$/m);
  assert.doesNotMatch(source("lib/events/waitlist.ts"), /create_pre_reservation|createCheckout|NEXT_PUBLIC_/);
});
