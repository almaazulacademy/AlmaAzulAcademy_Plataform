/**
 * Eventos especiais — infraestrutura para várias edições (PR A da 2ª edição
 * do ESSÊNCIA).
 *
 *   A. E-mail do ingresso genérico: orientações e benefícios com os títulos do
 *      conteúdo; alimentação deixou de ser obrigatória; a 1ª edição continua
 *      com o mesmo conteúdo.
 *   B. "Reservas abrem em breve" por edição (`event.reservation.comingSoon`),
 *      coerente com o servidor: página, `/reservar`, API, lista de espera e
 *      aviso de vaga recusam a edição em breve, mesmo com a variável global
 *      ligada e a sessão aberta.
 *   C. Registro de edições, prévia por slug e scripts de cadastro genéricos,
 *      rodados contra um banco montado como produção (interruptor ligado, 1ª
 *      edição publicada).
 *   D. Legendas das fotos.
 *
 * Nada fala com produção: banco em memória, provedor de e-mail falso.
 */

// Primeiro import: o relógio precisa estar no lugar antes de qualquer banco.
import "./support/essencia-clock.ts";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { eventBookingRejection, eventSalesOpen, loadSessionBookingRules, type RulesQueryClient } from "../lib/events/booking.ts";
import { DEMO_SLUG, editionDemoEvent, editionErrors, editionsErrors, type EventEdition } from "../lib/events/edition.ts";
import { EVENT_EDITIONS, getEventEdition } from "../lib/events/editions.ts";
import { parseEventContent, validateEventEditorial, type EventContent } from "../lib/events/editorial.ts";
import { emailInfoItems, eventEmailMissing, isEventEmailReady } from "../lib/events/email-readiness.ts";
import { CONCHA_ACUSTICA_LOCATION, ESSENCIA_EDITION, ESSENCIA_EDITORIAL, ESSENCIA_STARTS_AT, essenciaDemoEvent } from "../lib/events/fixtures/essencia.ts";
import { availabilityBadge, eventCta, type EventAvailability } from "../lib/events/presentation.ts";
import { isEventWaitlistVisible, resolveWaitlistScope } from "../lib/events/waitlist.ts";
import { buildReservationConfirmationEmail, type ReservationConfirmationData } from "../lib/reservations/confirmation-email.ts";
import { withWaitlistEventContext } from "../lib/events/waitlist-email.ts";
import { createWaitlistSpotQueue, sendPendingWaitlistSpotEmails, type WaitlistSpotRuntime } from "../lib/waitlist/spot-email.ts";
import {
  EDITION_ADMIN_EMAIL,
  editionCadastroErrors,
  editionCadastroFiles,
  editionCadastroPaths,
  editionCadastroSql,
  editionPostcheckSql,
  editionPreflightSql,
  editionRollbackSql,
} from "../scripts/events/edition-cadastro-sql.ts";
import { applyMigration, fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";
import { PRODUCTION_ONLY } from "./support/production-only-schema.ts";
import { ADMIN, fakeResend, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";
import { TEST_EDITION, testEditorial } from "./support/test-edition.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function content(editorial: unknown): EventContent {
  const parsed = validateEventEditorial(editorial);
  if (!parsed.success) throw new Error(parsed.errors.join("; "));
  return parsed.data.event;
}

const ESSENCIA = content(ESSENCIA_EDITORIAL);
const TEST = content(TEST_EDITION.editorial);

function emailData(event: EventContent, overrides: Partial<ReservationConfirmationData> = {}): ReservationConfirmationData {
  return {
    reservationId: "00000000-0000-4000-8000-0000000ed170",
    publicCode: "EDI7K2M9QX",
    fullName: "Marina Albuquerque",
    email: "marina@teste.local",
    quantity: 2,
    experienceTitle: "Evento de teste",
    startsAt: ESSENCIA_STARTS_AT,
    checkinToken: "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b",
    durationMinutes: 210,
    location: CONCHA_ACUSTICA_LOCATION,
    event,
    ...overrides,
  };
}

/** Títulos das seções do e-mail, na ordem, pelo texto puro (em caixa alta). */
function sectionTitles(text: string, candidates: string[]) {
  return candidates.filter((title) => text.includes(`\n${title.toUpperCase()}\n`)).sort((a, b) => text.indexOf(`\n${a.toUpperCase()}\n`) - text.indexOf(`\n${b.toUpperCase()}\n`));
}

// ===========================================================================
// A. E-mail do ingresso
// ===========================================================================

test("e-mail: a 1ª edição mantém as mesmas seções e textos, com o lanche, e os títulos vêm do conteúdo", () => {
  const email = buildReservationConfirmationEmail(emailData(ESSENCIA, { experienceTitle: "ESSÊNCIA — Corpo, Mente e Natureza" }));
  const titles = ["Programação", "O que levar", "Segurança durante a remada", "Alimentação inclusa", "Condições climáticas", "Política de cancelamento", "Preciso ter experiência anterior?", "Horário e chegada"];
  // Mesmas seções e mesma ordem de antes; só o título do lanche passa a ser o do conteúdo
  // ("Alimentação inclusa", o mesmo da página), em vez do fixo "Lanche incluso".
  assert.deepEqual(sectionTitles(email.text, titles), ["Programação", "O que levar", "Segurança durante a remada", "Alimentação inclusa", "Condições climáticas", "Política de cancelamento"]);
  for (const text of ["lanche saudável oferecido pela Nutre", "colete salva-vidas", "traga seu próprio tapete", "Prazo: 05/11/2026 às 12h00 (horário de Brasília)."]) {
    assert.ok(email.text.includes(text), `texto sem: ${text}`);
  }
  assert.ok(email.html.includes("Alimentação inclusa"));
  assert.deepEqual(eventEmailMissing(ESSENCIA), []);
});

test("e-mail: evento sem alimentação vende e envia, sem nenhuma seção de lanche", () => {
  const noFood = clone(ESSENCIA_EDITORIAL) as unknown as { event: { info: { items: Array<{ id?: string }> } } };
  noFood.event.info.items = noFood.event.info.items.filter((item) => item.id !== "alimentacao");
  const event = content(noFood);
  assert.ok(isEventEmailReady(event), "alimentação não é obrigatória");
  const email = buildReservationConfirmationEmail(emailData(event));
  for (const absent of ["ALIMENTAÇÃO", "Alimentação inclusa", "Lanche incluso", "LANCHE INCLUSO"]) {
    assert.ok(!email.text.includes(absent) && !email.html.includes(absent), `não pode citar: ${absent}`);
  }
  assert.ok(email.text.includes("O QUE LEVAR"));
});

test("e-mail: benefícios opcionais da edição entram pelo conteúdo, com o título dela; email:false tira um item", () => {
  assert.deepEqual(emailInfoItems(TEST).map((item) => item.title), ["O que levar", "Segurança na água", "Brinde de cortesia"]);
  const email = buildReservationConfirmationEmail(emailData(TEST, { startsAt: TEST_EDITION.startsAt, durationMinutes: 240 }));
  assert.ok(email.text.includes("BRINDE DE CORTESIA\nCada participante recebe um brinde de cortesia do local."));
  assert.ok(email.html.includes("Brinde de cortesia"));
  // "experiencia" não é orientação de e-mail por padrão; "clima" saiu com email:false.
  for (const absent of ["Preciso ter experiência?", "Condições climáticas", "Alimentação", "Lanche", "Nutre"]) {
    assert.ok(!email.text.includes(absent) && !email.html.includes(absent), `não pode citar: ${absent}`);
  }
  assert.ok(email.text.includes("Início: 15h00"));
  assert.ok(email.text.includes("Tolerância de chegada: até 15h20"));
});

test("e-mail: a segurança e o que levar continuam obrigatórios; nenhum título de edição fica fixo no código", () => {
  for (const id of ["seguranca", "o-que-levar", "cancelamento"]) {
    const without = clone(ESSENCIA_EDITORIAL) as unknown as { event: { info: { items: Array<{ id?: string }> } } };
    without.event.info.items = without.event.info.items.filter((item) => item.id !== id);
    const parsed = validateEventEditorial(without);
    if (parsed.success) assert.ok(eventEmailMissing(parsed.data.event).includes(`texto "${id}" confirmado`), id);
    else assert.equal(id, "cancelamento", "só a política é exigida pelo próprio validador (prazo cadastrado)");
  }
  const code = source("lib/reservations/event-email.ts") + source("lib/events/email-readiness.ts");
  for (const fixed of ["Lanche incluso", "Segurança durante a remada", "Nutre", "tapete", "Superioga", "drink", "Drink"]) {
    assert.ok(!code.includes(fixed), `texto de edição fixo no código: ${fixed}`);
  }
  assert.doesNotMatch(source("lib/events/email-readiness.ts"), /"alimentacao", "cancelamento"\] as const;/);
});

test("conteúdo: email e comingSoon são opcionais, com tipo conferido; conteúdo antigo segue igual", () => {
  assert.equal(ESSENCIA.reservation.comingSoon, false, "edição antiga sem o campo: comportamento anterior");
  assert.ok(ESSENCIA.info.items.every((item) => item.email === null));
  const bad = clone(TEST_EDITION.editorial) as { event: { reservation: Record<string, unknown>; info: { items: Array<Record<string, unknown>> } } };
  bad.event.reservation.comingSoon = "sim";
  bad.event.info.items[0].email = "sim";
  const parsed = parseEventContent(bad.event);
  assert.equal(parsed.content, null);
  assert.ok(parsed.errors.includes("O campo comingSoon da reserva deve ser verdadeiro ou falso."));
  assert.ok(parsed.errors.some((error) => error.startsWith("O campo email da informação 1")));
});

// ===========================================================================
// B. "Reservas abrem em breve" por edição
// ===========================================================================

function demo(edition: EventEdition, availability: EventAvailability) {
  return editionDemoEvent(edition, availability, 10);
}

test("em breve: a edição diz 'em breve' com a variável global ligada; a outra edição não muda", () => {
  const soon = demo(TEST_EDITION, "AVAILABLE");
  const regular = demo(ESSENCIA_EDITION, "AVAILABLE");
  assert.equal(eventSalesOpen(soon, true), false);
  assert.equal(eventSalesOpen(regular, true), true, "a 1ª edição (sem o campo) segue a variável global");
  assert.equal(eventSalesOpen(regular, false), false);

  const badge = (event: ReturnType<typeof demo>) => availabilityBadge(event.session.availability, event.session.remainingSpots, eventSalesOpen(event, true)).label;
  const cta = (event: ReturnType<typeof demo>, sessionId = "00000000-0000-4000-8000-000000000001") =>
    eventCta({ availability: event.session.availability, sessionId, ctaLabel: "Garantir minha vaga", bookingOpen: eventSalesOpen(event, true) });

  // Em breve: aberta ou fechada no painel, "Reservas abrem em breve" e nenhum link.
  for (const availability of ["AVAILABLE", "CLOSED"] as const) {
    assert.equal(badge(demo(TEST_EDITION, availability)), "Reservas abrem em breve", availability);
    assert.equal(cta(demo(TEST_EDITION, availability)).kind, "SOON", availability);
  }
  // Esgotado continua esgotado; realizado não vira "em breve".
  assert.equal(badge(demo(TEST_EDITION, "SOLD_OUT")), "Esgotado");
  assert.equal(cta(demo(TEST_EDITION, "SOLD_OUT")).kind, "UNAVAILABLE");
  assert.equal(badge(demo(TEST_EDITION, "ENDED")), "Evento realizado");
  assert.equal(cta(demo(TEST_EDITION, "ENDED")).label, "Evento realizado");

  // Sem o campo, como antes: aberta → botão; fechada com a venda ligada → encerradas.
  assert.equal(badge(demo(ESSENCIA_EDITION, "AVAILABLE")), "Vagas abertas");
  assert.equal(cta(demo(ESSENCIA_EDITION, "AVAILABLE")).kind, "BOOK");
  assert.equal(badge(demo(ESSENCIA_EDITION, "CLOSED")), "Reservas encerradas");
  assert.equal(badge(demo(ESSENCIA_EDITION, "SOLD_OUT")), "Esgotado");

  // Aberta a edição (comingSoon false), o mesmo conteúdo vende.
  const opened = clone(TEST_EDITION.editorial) as { event: { reservation: Record<string, unknown> } };
  opened.event.reservation.comingSoon = false;
  const openEdition = { ...TEST_EDITION, editorial: opened };
  assert.equal(cta(demo(openEdition, "AVAILABLE")).kind, "BOOK");
  assert.equal(badge(demo(openEdition, "CLOSED")), "Reservas encerradas");
});

test("em breve: o servidor recusa antes da pré-reserva, mesmo com venda ligada, sessão visível e e-mail pronto", () => {
  const rules = { kind: "EVENT" as const, maxPerOrder: 6, emailReady: true, visible: true, comingSoon: true as const };
  assert.equal(eventBookingRejection(rules, 1, true)?.code, "EVENT_BOOKING_CLOSED");
  assert.equal(eventBookingRejection(rules, 1, true)?.status, 409);
  assert.equal(eventBookingRejection({ kind: "EVENT", maxPerOrder: 6, emailReady: true, visible: true }, 1, true), null, "sem o campo: como antes");
  assert.equal(eventBookingRejection({ kind: "REGULAR" }, 1, true), null, "regular não muda");
});

test("em breve: todos os caminhos de venda usam a regra da edição", () => {
  assert.match(source("app/api/reservations/route.ts"), /eventBookingRejection\(rules, input\.quantity, isEventBookingOpen\(\)\)/);
  const reserve = source("app/reservar/[sessionId]/page.tsx");
  assert.match(reserve, /const editionSoon = Boolean\(event\?\.editorial\.event\.reservation\.comingSoon\);\n  if \(editionSoon\) session = null;/, "sem sessão, nada de formulário");
  assert.match(reserve, /event && bookingOpen && !editionSoon && isEventsWaitlistEnabled\(\)/);
  assert.match(reserve, /!bookingOpen \|\| \(editionSoon && event\.session\.availability !== "SOLD_OUT"\) \? "Reservas ainda não abertas"/);
  assert.match(source("components/events/event-page.tsx"), /const bookingOpen = eventSalesOpen\(event, globalBookingOpen\);/);
  assert.match(source("components/events/event-page.tsx"), /const waitlistOpen = globalWaitlistOpen && !event\.editorial\.event\.reservation\.comingSoon;/);
  for (const file of ["components/events/event-card.tsx", "components/events/event-highlight.tsx"]) {
    assert.match(source(file), /const bookingOpen = eventSalesOpen\(event, globalBookingOpen\);/, file);
  }
  assert.match(source("app/lista-de-espera/[sessionId]/page.tsx"), /found && !found\.editorial\.event\.reservation\.comingSoon \? found : null/);
  assert.match(source("lib/waitlist/spot-email.ts"), /event\.content\.reservation\.comingSoon\) return failed\("EVENT_SALES_CLOSED"/);
  // As variáveis globais não mudaram.
  const flags = source("lib/events/flags.ts");
  assert.match(flags, /return env\.EVENT_BOOKING_OPEN === "true" && isEventsPublicEnabled\(env\);/);
  assert.match(flags, /return env\.EVENTS_PUBLIC_ENABLED === "true";/);
});

test("em breve: lista de espera recusa a edição em breve (SESSION_UNAVAILABLE)", async () => {
  const event = demo(TEST_EDITION, "SOLD_OUT");
  const row = { id: "x", slug: TEST_EDITION.slug, title: TEST_EDITION.title, summary: "", editorial_content: TEST_EDITION.editorial, base_slug: "concha-acustica", base_name: "Cápsula Bar — Concha Acústica", session_id: "sessao-1", starts_at: TEST_EDITION.startsAt, duration_minutes: 240, price_cents: 15000, remaining_spots: 0, availability: "SOLD_OUT" };
  const rpc = async () => ({ data: [row], error: null });
  assert.equal(event.editorial.event.reservation.comingSoon, true);
  assert.equal(await isEventWaitlistVisible(rpc, TEST_EDITION.slug, "sessao-1"), false);
  const openRow = { ...row, editorial_content: (() => { const value = clone(TEST_EDITION.editorial) as { event: { reservation: Record<string, unknown> } }; value.event.reservation.comingSoon = false; return value; })() };
  assert.equal(await isEventWaitlistVisible(async () => ({ data: [openRow], error: null }), TEST_EDITION.slug, "sessao-1"), true);
  const scope = await resolveWaitlistScope({
    loadTarget: async () => ({ kind: "EVENT", slug: TEST_EDITION.slug, maxPerOrder: 6 }),
    eventVisible: (slug, sessionId) => isEventWaitlistVisible(rpc, slug, sessionId),
    regularEnabled: true,
    eventsEnabled: true,
  }, "sessao-1");
  assert.deepEqual(scope, { kind: "SESSION_UNAVAILABLE" });
});

// ===========================================================================
// B (banco). Reserva direta e aviso de vaga, contra o Postgres em memória
// ===========================================================================

test("banco: edição publicada, sessão ABERTA e em breve — a API recusa; aberta a edição, vende", async () => {
  const db = await fullDatabase();
  const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
  const client = createPgliteAdmin(db).client as unknown as RulesQueryClient;
  const created = await fx.call(
    `public.admin_create_event($1::uuid, $2::uuid, $3, $4, 'x', $5::jsonb, null, now() + interval '20 days', 240, 15000, 24)`,
    [ADMIN, fx.SUNSET_CONCHA.base_id, TEST_EDITION.slug, TEST_EDITION.title, JSON.stringify(TEST_EDITION.editorial)],
  );
  await fx.rows(`update public.special_event_settings set publication_enabled = true`);
  await fx.rows(`update public.experiences set status = 'PUBLISHED' where id = $1::uuid`, [created.experienceId]);
  // Alguém abre a sessão no painel antes da hora: a edição continua em breve.
  await fx.rows(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [created.sessionId]);

  const rules = await loadSessionBookingRules(client, created.sessionId);
  assert.deepEqual(rules, { kind: "EVENT", maxPerOrder: 6, emailReady: true, visible: true, comingSoon: true });
  assert.equal(eventBookingRejection(rules, 1, true)?.code, "EVENT_BOOKING_CLOSED", "pedido direto à API, com a venda global ligada");

  // Conteúdo quebrado com comingSoon: continua fechado (nunca abre por erro de conteúdo).
  const broken = clone(TEST_EDITION.editorial) as { event: Record<string, unknown> };
  delete broken.event.program;
  await fx.rows(`update public.experiences set editorial_content = $1::jsonb where id = $2::uuid`, [JSON.stringify(broken), created.experienceId]);
  const brokenRules = await loadSessionBookingRules(client, created.sessionId);
  assert.equal(brokenRules?.kind === "EVENT" && brokenRules.comingSoon, true);
  assert.equal(eventBookingRejection(brokenRules, 1, true)?.code, "EVENT_BOOKING_CLOSED");

  // A abertura explícita: comingSoon = false no conteúdo.
  const opened = clone(TEST_EDITION.editorial) as { event: { reservation: Record<string, unknown> } };
  opened.event.reservation.comingSoon = false;
  await fx.rows(`update public.experiences set editorial_content = $1::jsonb where id = $2::uuid`, [JSON.stringify(opened), created.experienceId]);
  const openRules = await loadSessionBookingRules(client, created.sessionId);
  assert.deepEqual(openRules, { kind: "EVENT", maxPerOrder: 6, emailReady: true, visible: true }, "aberta, as regras têm o formato de sempre");
  assert.equal(eventBookingRejection(openRules, 1, true), null);
  assert.equal(eventBookingRejection(openRules, 1, false)?.code, "EVENT_BOOKING_CLOSED", "a variável global continua valendo");
  await db.close();
});

test("banco: aviso de vaga de uma edição em breve não sai — nem com a lista dos eventos ligada", async () => {
  const db = await fullDatabase();
  const admin = createPgliteAdmin(db);
  const rpc = (name: string, args: Record<string, unknown>) => admin.client.rpc(name, args);
  const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
  await db.exec(`update public.waitlist_settings set detection_enabled = true, opening_grace_seconds = 0, wave_interval_minutes = 30`);
  const opened = clone(TEST_EDITION.editorial) as { event: { reservation: Record<string, unknown> } };
  opened.event.reservation.comingSoon = false;
  const created = await fx.call(
    `public.admin_create_event($1::uuid, $2::uuid, 'edicao-aviso', 'Edição do aviso', 'x', $3::jsonb, null, now() + interval '20 days', 240, 15000, 24)`,
    [ADMIN, fx.SUNSET_CONCHA.base_id, JSON.stringify(opened)],
  );
  await fx.rows(`update public.special_event_settings set publication_enabled = true`);
  await fx.rows(`update public.experiences set status = 'PUBLISHED' where id = $1::uuid`, [created.experienceId]);
  await fx.rows(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [created.sessionId]);
  const first = await fx.reserve(created.sessionId, 12);
  await fx.reserve(created.sessionId, 12);
  const answer = await fx.call(`public.waitlist_join($1::uuid, 'Marina Lista', 'lista-edicao@teste.local', '+5561960000001', 2, null, '')`, [created.sessionId]);
  assert.equal(answer.status, "ACCEPTED");
  // A organização volta a edição para "em breve" (ex.: reabertura adiada). Surge vaga.
  const soon = clone(opened);
  soon.event.reservation.comingSoon = true;
  await fx.rows(`update public.experiences set editorial_content = $1::jsonb where id = $2::uuid`, [JSON.stringify(soon), created.experienceId]);
  await fx.call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Libera a vaga')`, [ADMIN, first.id]);
  await fx.reserve(created.sessionId, 10);
  await fx.call(`public.waitlist_scan()`);
  const queued = await fx.rows(`select n.status from public.waitlist_notifications n join public.waitlist_entries we on we.id = n.entry_id
                                where we.session_id = $1::uuid and n.kind = 'SPOT_AVAILABLE'`, [created.sessionId]);
  assert.deepEqual(queued.map((row) => row.status), ["QUEUED"], "há um aviso de vaga na fila");

  const provider = fakeResend();
  const runtime: WaitlistSpotRuntime = {
    queue: createWaitlistSpotQueue({ rpc }),
    provider,
    origin: "https://www.almaazulacademy.com.br",
    pause: async () => undefined,
    kinds: ["REGULAR", "EVENT"],
    enrich: (payload) => withWaitlistEventContext(admin.client as unknown as RulesQueryClient, payload),
  } as WaitlistSpotRuntime;
  const report = await sendPendingWaitlistSpotEmails(runtime);
  assert.equal(report.outcome, "PROCESSED", report.errorCode);
  assert.equal(report.sent, 0);
  assert.equal(provider.requests.length, 0, "nenhum aviso enviado");
  const entry = await fx.one(`select notifications_sent from public.waitlist_entries where session_id = $1::uuid`, [created.sessionId]);
  assert.equal(Number(entry.notifications_sent), 0);
  const after = await fx.one(`select n.status, n.last_error_code from public.waitlist_notifications n join public.waitlist_entries we on we.id = n.entry_id
                              where we.session_id = $1::uuid and n.kind = 'SPOT_AVAILABLE'`, [created.sessionId]);
  assert.notEqual(after.status, "SENT");
  assert.equal(after.last_error_code, "EVENT_SALES_CLOSED", "barrado pela regra da edição em breve");
  await db.close();
});

// ===========================================================================
// C. Registro de edições, prévia e scripts de cadastro
// ===========================================================================

test("registro: carrega por slug, a 1ª edição é a de sempre e ninguém mais mexe nela", () => {
  assert.deepEqual(EVENT_EDITIONS.map((edition) => edition.slug), ["essencia"]);
  assert.equal(getEventEdition("essencia"), ESSENCIA_EDITION);
  assert.equal(getEventEdition("nao-existe"), null);
  assert.equal(getEventEdition(TEST_EDITION.slug, [ESSENCIA_EDITION, TEST_EDITION]), TEST_EDITION);
  assert.equal(ESSENCIA_EDITION.registered, true);
  assert.equal(ESSENCIA_EDITION.editorial, ESSENCIA_EDITORIAL, "o conteúdo da 1ª edição é o aprovado, sem cópia");
  // A prévia genérica dá exatamente o que a prévia da 1ª edição dava.
  assert.deepEqual(editionDemoEvent(ESSENCIA_EDITION), essenciaDemoEvent());
  for (const availability of ["SOLD_OUT", "CLOSED", "ENDED"] as const) assert.deepEqual(editionDemoEvent(ESSENCIA_EDITION, availability), essenciaDemoEvent(availability));
});

test("registro: conteúdos de edições diferentes não se misturam", () => {
  const first = editionDemoEvent(ESSENCIA_EDITION);
  const second = editionDemoEvent(TEST_EDITION);
  assert.notEqual(first.slug, second.slug);
  assert.notEqual(first.id, second.id);
  assert.equal(first.editorial.event.reservation.comingSoon, false);
  assert.equal(second.editorial.event.reservation.comingSoon, true);
  assert.ok(first.editorial.event.info.items.some((item) => item.id === "alimentacao"));
  assert.ok(!second.editorial.event.info.items.some((item) => item.id === "alimentacao"));
  // Mexer na prévia de uma não muda a outra nem o conteúdo aprovado.
  second.editorial.event.info.items.length = 0;
  assert.ok(editionDemoEvent(ESSENCIA_EDITION).editorial.event.info.items.length > 0);
  assert.ok(editionDemoEvent(TEST_EDITION).editorial.event.info.items.length > 0);
});

test("registro: validação recusa slug reservado ou repetido, limites, chegada e prazo incoerentes", () => {
  assert.deepEqual(editionErrors(TEST_EDITION), []);
  assert.deepEqual(editionErrors(ESSENCIA_EDITION), []);
  const bad = (patch: Partial<EventEdition>) => editionErrors({ ...TEST_EDITION, ...patch });
  assert.ok(bad({ slug: DEMO_SLUG }).some((error) => error.includes("reservado")));
  assert.ok(bad({ slug: "Com Espaço" }).some((error) => error.includes("letras minúsculas")));
  assert.ok(bad({ startsAt: "2026-12-12 15:00" }).some((error) => error.includes("ISO 8601")));
  assert.ok(bad({ capacity: 0 }).some((error) => error.includes("Capacidade")));
  assert.ok(bad({ capacity: 4 }).some((error) => error.includes("máximo por pedido")));
  assert.ok(bad({ priceCents: 0 }).some((error) => error.includes("Preço")));
  assert.ok(bad({ startsAt: "2026-12-12T19:00:00.000Z" }).some((error) => error.includes("chegada")), "início diferente da chegada");
  assert.ok(bad({ startsAt: "2026-12-09T18:00:00.000Z" }).some((error) => error.includes("prazo de cancelamento")), "prazo depois do início");
  const injected = testEditorial();
  injected.event.tagline = "texto com $json$ no meio";
  assert.ok(bad({ editorial: injected }).some((error) => error.includes("$json$")));
  assert.ok(editionsErrors([ESSENCIA_EDITION, ESSENCIA_EDITION]).includes("Slug repetido: essencia."));
  assert.deepEqual(editionsErrors(EVENT_EDITIONS), []);
});

test("prévia: rota por slug, só dev/Preview, sem banco e sem checkout", () => {
  const detail = source("app/eventos/demonstracao/[slug]/page.tsx");
  assert.match(detail, /const edition = getEventEdition\(\(await params\)\.slug\);\n  if \(!edition\) notFound\(\);/);
  assert.match(detail, /bookingOpen=\{false\}/);
  const index = source("app/eventos/demonstracao/page.tsx");
  assert.match(index, /EVENT_EDITIONS\.map/);
  for (const code of [detail, index]) {
    assert.match(code, /if \(!isEventsDemoEnabled\(\)\) notFound\(\);/);
    assert.doesNotMatch(code, /getSupabase|\.rpc\(/);
  }
});

test("gerador: recusa a 1ª edição, conteúdo sem 'em breve' e edição inválida, antes de gerar SQL", () => {
  assert.ok(editionCadastroErrors(ESSENCIA_EDITION).some((error) => error.includes("já está cadastrada")));
  assert.throws(() => editionCadastroSql(ESSENCIA_EDITION), /já está cadastrada/);
  const open = clone(TEST_EDITION.editorial) as { event: { reservation: Record<string, unknown> } };
  open.event.reservation.comingSoon = false;
  assert.throws(() => editionCadastroSql({ ...TEST_EDITION, editorial: open }), /comingSoon = true/);
  assert.throws(() => editionPreflightSql({ ...TEST_EDITION, slug: DEMO_SLUG }), /reservado/);
  assert.deepEqual(editionCadastroErrors(TEST_EDITION), []);

  const files = editionCadastroFiles(TEST_EDITION);
  assert.deepEqual(Object.keys(files), Object.values(editionCadastroPaths(TEST_EDITION.slug)));
  assert.deepEqual(Object.keys(files), [
    "supabase/diagnostics/evento_evento_teste_tarde_cadastro_preflight.sql",
    "supabase/maintenance/evento_evento_teste_tarde_cadastro.sql",
    "supabase/diagnostics/evento_evento_teste_tarde_cadastro_postcheck.sql",
    "supabase/rollback/evento_evento_teste_tarde_cadastro.rollback.sql",
  ]);
  const cadastro = editionCadastroSql(TEST_EDITION);
  assert.equal(cadastro, editionCadastroSql(TEST_EDITION), "determinístico");
  assert.deepEqual(JSON.parse(cadastro.match(/\$json\$([\s\S]*?)\$json\$/)?.[1] ?? ""), TEST_EDITION.editorial);
  assert.doesNotMatch(cadastro, /publication_enabled = true|status = 'OPEN'|'PUBLISHED'|update public\.special_event_settings/, "o cadastro não publica, não abre e não mexe no interruptor");
  // Os scripts históricos do ESSÊNCIA continuam como estavam.
  assert.match(source("supabase/maintenance/essencia_cadastro.sql"), /ESSENCIA_INTERRUPTOR/);
  assert.match(source("package.json"), /"events:edition-sql":/);
});

type Check = { check_name: string; result: string; status: string };

/** Banco como produção hoje: esquema legado, segurança dos eventos, 1ª edição cadastrada e PUBLICADA, interruptor ligado. */
async function productionLike(options: { security?: boolean } = {}) {
  const db = await fullDatabase({ until: "202610310003_experiences_active_on_insert.sql" });
  await db.exec(PRODUCTION_ONLY);
  if (options.security !== false) await applyMigration(db, "202610310004_event_publication_security.sql");
  const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
  await db.query(`update auth.users set email = $1 where id = $2::uuid`, [EDITION_ADMIN_EMAIL, ADMIN]);
  await db.exec(source("supabase/maintenance/essencia_cadastro.sql"));
  if (options.security !== false) await db.exec(source("supabase/maintenance/essencia_publicacao.sql"));
  else {
    await db.exec(`update public.special_event_settings set publication_enabled = true`);
    await db.exec(`update public.experiences set status = 'PUBLISHED' where slug = 'essencia'`);
  }
  return { db, fx };
}

async function report(db: Awaited<ReturnType<typeof productionLike>>["db"], sql: string) {
  return new Map(((await db.query<Check>(sql)).rows).map((row) => [row.check_name, row]));
}

function allOk(checks: Map<string, Check>) {
  for (const [name, row] of checks) assert.equal(row.status, "OK", `${name}: ${row.result}`);
}

async function essenciaSnapshot(db: Awaited<ReturnType<typeof productionLike>>["db"]) {
  return (await db.query<Row>(`select e.status, e.editorial_content::text as content, s.status as session_status, s.capacity, s.starts_at::text as starts_at
                               from public.experiences e join public.sessions s on s.experience_id = e.id where e.slug = 'essencia'`)).rows;
}

test("banco: com o interruptor ligado e a 1ª edição no ar, preflight → cadastro → postcheck aprovam; nada mais muda", async () => {
  const { db } = await productionLike();
  assert.equal((await db.query<Row>(`select publication_enabled from public.special_event_settings`)).rows[0].publication_enabled, true);
  const before = await essenciaSnapshot(db);

  const pre = await report(db, editionPreflightSql(TEST_EDITION));
  allOk(pre);
  assert.match(pre.get("INTERRUPTOR")!.result, /^ligado/);
  assert.match(pre.get("OUTROS_EVENTOS")!.result, /^1 evento\(s\) \[essencia=PUBLISHED\]/);

  await db.exec(editionCadastroSql(TEST_EDITION));
  const post = await report(db, editionPostcheckSql(TEST_EDITION));
  allOk(post);
  assert.equal(post.get("SESSAO_FECHADA")?.result, "CLOSED 12/12/2026 15:00 240min 15000 centavos 24 vagas");
  assert.equal(post.get("RESERVAS_EM_BREVE")?.result, "comingSoon=true; até 6 por pedido; cancelamento até 2026-12-10T12:00:00-03:00");
  assert.equal(post.get("EDICAO_FORA_DAS_LEITURAS_PUBLICAS")?.result, "0 na listagem, 0 na página, 0 sessão(ões) públicas");
  for (const key of ["OUTROS_EVENTOS", "LISTAGENS_REGULARES", "RESERVAS_POR_STATUS", "INSCRICOES_DA_LISTA_POR_STATUS"]) {
    assert.equal(post.get(key)?.result, pre.get(key)?.result, key);
  }
  assert.deepEqual(await essenciaSnapshot(db), before, "a 1ª edição não muda");

  // A chave pública não vê o rascunho, nem pela tabela.
  await db.exec("begin; set local role anon");
  const visible = (await db.query<Row>(`select count(*)::int as n from public.experiences where slug = $1`, [TEST_EDITION.slug])).rows[0].n;
  const sessions = (await db.query<Row>(`select count(*)::int as n from public.sessions s join public.experiences e on e.id = s.experience_id where e.slug = $1`, [TEST_EDITION.slug])).rows[0].n;
  await db.exec("rollback");
  assert.equal(visible, 0);
  assert.equal(sessions, 0);
  await db.close();
});

test("banco: cadastro repetido ou sessão duplicada param inteiros; sem a segurança dos eventos, nem começa", async () => {
  const { db } = await productionLike();
  await db.exec(editionCadastroSql(TEST_EDITION));
  const count = async () => (await db.query<Row>(`select count(*)::int as n from public.experiences where kind = 'EVENT'`)).rows[0].n;
  assert.equal(await count(), 2);

  await assert.rejects(db.exec(editionCadastroSql(TEST_EDITION)), /EVENTO_JA_EXISTE/);
  await db.exec("rollback");
  assert.equal((await report(db, editionPreflightSql(TEST_EDITION))).get("SLUG_LIVRE")?.status, "FALHOU");

  // Outro slug, mesma base e mesmo início: seria uma sessão duplicada.
  const twin: EventEdition = { ...TEST_EDITION, slug: "evento-teste-gemeo" };
  const twinPre = await report(db, editionPreflightSql(twin));
  assert.equal(twinPre.get("SESSAO_SEM_DUPLICIDADE")?.status, "FALHOU");
  await assert.rejects(db.exec(editionCadastroSql(twin)), /EVENTO_SESSAO_DUPLICADA/);
  await db.exec("rollback");
  assert.equal(await count(), 2, "nada parcial");
  await db.close();

  const insecure = await productionLike({ security: false });
  assert.equal((await report(insecure.db, editionPreflightSql(TEST_EDITION))).get("SEGURANCA_DOS_EVENTOS")?.status, "FALHOU");
  await assert.rejects(insecure.db.exec(editionCadastroSql(TEST_EDITION)), /EVENTO_SEGURANCA/);
  await insecure.db.exec("rollback");
  assert.equal((await insecure.db.query<Row>(`select count(*)::int as n from public.experiences where slug = $1`, [TEST_EDITION.slug])).rows[0].n, 0);
  await insecure.db.close();
});

test("banco: desfazer remove só a edição nova em rascunho; a 1ª edição fica", async () => {
  const { db } = await productionLike();
  const before = await essenciaSnapshot(db);
  await db.exec(editionCadastroSql(TEST_EDITION));
  await db.exec(editionRollbackSql(TEST_EDITION));
  assert.equal((await db.query<Row>(`select count(*)::int as n from public.experiences where slug = $1`, [TEST_EDITION.slug])).rows[0].n, 0);
  assert.deepEqual(await essenciaSnapshot(db), before);
  await db.exec(editionRollbackSql(TEST_EDITION)); // nada a desfazer: não falha

  await db.exec(editionCadastroSql(TEST_EDITION));
  await db.exec(`update public.sessions s set status = 'OPEN' from public.experiences e where e.id = s.experience_id and e.slug = '${TEST_EDITION.slug}'`);
  await assert.rejects(db.exec(editionRollbackSql(TEST_EDITION)), /EVENTO_DESFAZER_RECUSADO/);
  await db.exec("rollback");
  assert.equal((await db.query<Row>(`select count(*)::int as n from public.experiences where slug = $1`, [TEST_EDITION.slug])).rows[0].n, 1);
  await db.close();
});

// ===========================================================================
// D. Legendas das fotos
// ===========================================================================

test("legendas: o crédito da foto chega à página; sem crédito, nada é desenhado", () => {
  const program = TEST.program.items.find((item) => item.image);
  assert.equal(program?.image?.credit, "Registro de uma edição anterior · teste");
  assert.equal(ESSENCIA.intro.image?.credit, undefined, "foto sem legenda continua sem legenda");

  const parts = source("components/events/event-parts.tsx");
  assert.match(parts, /export function EventImageCaption\(\{ credit, className \}: \{ credit\?: string \| null; className\?: string \}\) \{\n  if \(!credit\) return null;/);
  assert.match(parts, /<figcaption className=\{cn\("pointer-events-none absolute bottom-3 left-3 z-10/);

  const page = source("components/events/event-page.tsx");
  // Cada foto de conteúdo é um <figure> com a legenda dentro, por cima da foto: sem espaço extra.
  assert.match(page, /<EventImageCaption credit=\{extra\.intro\.image\.credit\} \/>/);
  assert.match(page, /<EventImageCaption credit=\{item\.image\.credit\} \/>/);
  assert.match(page, /<EventImageCaption credit=\{content\.hero\.image\.credit\}/);
  assert.match(page, /<EventImageCaption credit=\{extra\.heroImageMobile\.credit\} className="left-auto right-3 sm:hidden" \/>/);
  assert.equal((page.match(/<figure className="relative m-0 aspect-/g) ?? []).length, 2);
  // A foto de fundo da reserva é decorativa (alt vazio): sem legenda.
  assert.match(page, /<Image src=\{extra\.reservation\.image\.src\} alt="" fill/);
});
