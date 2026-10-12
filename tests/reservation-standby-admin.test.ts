/**
 * Painel de Stand-by (etapa 3): banco e planilha.
 *
 * Roda contra um Postgres real em memória (PGlite) com todas as migrations
 * aplicadas, exatamente como `reservation-standby.test.ts`. Aqui ficam as
 * funções de `202610140001_reservation_standby_admin_panel.sql`, a autorização
 * de cada operação que o painel chama e a proteção da planilha: snapshots de
 * verdade, lidos do banco, sincronizados contra a planilha falsa em memória.
 *
 * Nenhum teste fala com o Supabase de produção nem com o Google.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseSnapshot } from "../lib/integrations/google-sheets/mapping.ts";
import { ACTIVE_NO, ACTIVE_YES, RESERVATION_HEADERS, RESERVATIONS_TAB, SESSIONS_TAB, SPOT_COLUMN, SPOTS_TAB } from "../lib/integrations/google-sheets/schema.ts";
import { isStandbyOriginUpdateOnly, parseStandbyOriginRows } from "../lib/integrations/google-sheets/standby-guard.ts";
import { syncSnapshot } from "../lib/integrations/google-sheets/sync.ts";
import { createFakeSheets, type FakeSheets } from "./support/fake-sheets.ts";
import { applyMigration, fullDatabase } from "./support/full-database.ts";

const STANDBY_MIGRATION = "202610130002_reservation_standby.sql";
const PANEL_MIGRATION = "202610140001_reservation_standby_admin_panel.sql";
const PANEL_FUNCTIONS = [
  "admin_list_standby_reservations_page",
  "admin_reschedule_standby_same_price",
  "admin_reservation_standby_history",
  "admin_standby_reschedule_options",
];

const db = await fullDatabase();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function rows(sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query(sql, params)).rows as Row[];
}

async function one(sql: string, params: unknown[] = []): Promise<Row> {
  const result = await rows(sql, params);
  assert.ok(result.length >= 1, `sem linhas: ${sql}`);
  return result[0];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(expression: string, params: unknown[] = []): Promise<any> {
  return (await one(`select ${expression} as value`, params)).value;
}

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: Error) => {
    assert.match(error.message, pattern);
    return true;
  });
}

// --- Equipe -------------------------------------------------------------------

const ADMIN = "b0000000-0000-4000-8000-000000000001";
const OPERATOR = "b0000000-0000-4000-8000-000000000002";
const INSTRUCTOR = "b0000000-0000-4000-8000-000000000003";
const INACTIVE_ADMIN = "b0000000-0000-4000-8000-000000000004";
const STRANGER = "b0000000-0000-4000-8000-000000000005";

await db.exec(`
  insert into auth.users (id, email) values
    ('${ADMIN}', 'admin@teste.local'), ('${OPERATOR}', 'operador@teste.local'),
    ('${INSTRUCTOR}', 'instrutor@teste.local'), ('${INACTIVE_ADMIN}', 'inativo@teste.local'),
    ('${STRANGER}', 'estranho@teste.local');
  insert into public.admin_users (user_id, display_name, role, is_active) values
    ('${ADMIN}', 'Admin Teste', 'ADMIN', true),
    ('${OPERATOR}', 'Operador Teste', 'OPERATOR', true),
    ('${INSTRUCTOR}', 'Instrutor Teste', 'INSTRUCTOR', true),
    ('${INACTIVE_ADMIN}', 'Admin Inativo', 'ADMIN', false);
`);

// --- Catálogo e fábricas ------------------------------------------------------

async function experience(slug: string) {
  return one(
    `select e.id, e.base_id, e.title, b.name as base_name from public.experiences e join public.bases b on b.id = e.base_id where e.slug = $1`,
    [slug],
  );
}

const IMERSAO = await experience("imersao-paranoa"); // Lago Norte, publicada
const SUNSET_CONCHA = await experience("remada-sunset-concha-acustica"); // outra base, publicada
const ROTA = await experience("rota-ermida-ponte-jk"); // não publicada

assert.notEqual(IMERSAO.base_id, SUNSET_CONCHA.base_id, "os testes entre bases precisam de duas bases");

let sequence = 0;

/** Cada teste usa um preço próprio: a régua do mesmo valor isola as listas. */
function uniquePrice() {
  sequence += 1;
  return 30_000 + sequence * 100;
}

async function makeSession(
  experienceId: string,
  options: { price?: number; capacity?: number; startsIn?: string; status?: string } = {},
) {
  sequence += 1;
  const created = await one(
    `insert into public.sessions (experience_id, starts_at, duration_minutes, price_cents, capacity, status)
     values ($1::uuid, now() + $2::interval + make_interval(secs => $3), 90, $4, $5, $6::public.session_status)
     returning id`,
    [experienceId, options.startsIn ?? "10 days", sequence, options.price ?? 7000, options.capacity ?? 4, options.status ?? "OPEN"],
  );
  return created.id as string;
}

type Booking = { id: string; cpf: string; code: string; total: number; quantity: number; name: string };

async function preReserve(sessionId: string, quantity = 2, name?: string): Promise<Booking> {
  sequence += 1;
  const cpf = String(20_000_000_000 + sequence);
  const fullName = name ?? `Cliente Painel ${sequence}`;
  const created = await call(
    `public.create_pre_reservation($1::uuid, $2, $3, $4, $5, $6, null, gen_random_uuid())`,
    [sessionId, fullName, cpf, `+55619${String(10_000_000 + sequence)}`, `painel${sequence}@teste.local`, quantity],
  );
  return { id: created.reservationId, cpf, code: created.publicCode, total: created.totalCents, quantity, name: fullName };
}

/** Reserva confirmada pelo caminho real de pagamento. */
async function reserve(sessionId: string, quantity = 2, name?: string): Promise<Booking> {
  const booking = await preReserve(sessionId, quantity, name);
  const confirmed = await call(
    `public.confirm_reservation_payment($1::uuid, 'INFINITEPAY', $2, $3, 'https://recibo.teste/1', '{}'::jsonb)`,
    [booking.id, `tx-${booking.cpf}`, booking.total],
  );
  assert.equal(confirmed, true);
  return booking;
}

async function reservation(id: string) {
  return one(`select * from public.reservations where id = $1::uuid`, [id]);
}

async function spots(sessionId: string): Promise<number> {
  return call(`public.available_spots($1::uuid)`, [sessionId]);
}

const REASON = "Turma cancelada por mau tempo";

function setStandby(reservationId: string, actor = ADMIN, reason = REASON) {
  return call(`public.admin_set_reservation_standby($1::uuid, $2::uuid, $3)`, [actor, reservationId, reason]);
}

function undoStandby(reservationId: string, actor = ADMIN) {
  return call(`public.admin_undo_reservation_standby($1::uuid, $2::uuid, 'Stand-by criado por engano')`, [actor, reservationId]);
}

/** O reagendamento que o painel usa: mesma régua do cliente, inclusive o preço. */
function reschedule(reservationId: string, sessionId: string, actor = ADMIN, reason: string | null = "Cliente escolheu por telefone") {
  return call(`public.admin_reschedule_standby_same_price($1::uuid, $2::uuid, $3::uuid, $4)`, [actor, reservationId, sessionId, reason]);
}

function options(reservationId: string, actor = ADMIN) {
  return call(`public.admin_standby_reschedule_options($1::uuid, $2::uuid)`, [actor, reservationId]);
}

function history(reservationId: string, actor = ADMIN) {
  return call(`public.admin_reservation_standby_history($1::uuid, $2::uuid)`, [actor, reservationId]);
}

function listPage(filters: { query?: string | null; baseId?: string | null; link?: string | null; limit?: number; offset?: number } = {}, actor = ADMIN) {
  return call(`public.admin_list_standby_reservations_page($1::uuid, $2, $3::uuid, $4, $5, $6)`, [
    actor, filters.query ?? null, filters.baseId ?? null, filters.link ?? null, filters.limit ?? 25, filters.offset ?? 0,
  ]);
}

function generateLink(reservationId: string, actor = ADMIN) {
  return call(`public.admin_generate_reservation_standby_link($1::uuid, $2::uuid)`, [actor, reservationId]);
}

function revokeLink(reservationId: string, actor = ADMIN) {
  return call(`public.admin_revoke_reservation_standby_link($1::uuid, $2::uuid)`, [actor, reservationId]);
}

function checkin(reservationId: string, count: number | null) {
  return call(`public.admin_register_checkin($1::uuid, $2::uuid, $3, 'MANUAL', null::uuid, false)`, [ADMIN, reservationId, count]);
}

async function functionHashes(database: typeof db) {
  const result = await database.query(
    `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn, md5(p.prosrc) as hash
     from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`,
  );
  return new Map((result.rows as Row[]).map((row) => [row.fn as string, row.hash as string]));
}

// =============================================================================
// 1. Migration: aditiva, idempotente e sem tocar o que já existia
// =============================================================================

test("a migration do painel só cria quatro funções; todas as anteriores ficam idênticas", async () => {
  const before = await fullDatabase({ until: STANDBY_MIGRATION });
  const previous = await functionHashes(before);
  await applyMigration(before, PANEL_MIGRATION);
  const after = await functionHashes(before);

  for (const [fn, hash] of previous) assert.equal(after.get(fn), hash, `${fn} não pode mudar`);
  const created = [...after.keys()].filter((fn) => !previous.has(fn)).map((fn) => fn.slice(0, fn.indexOf("("))).sort();
  assert.deepEqual(created, PANEL_FUNCTIONS);

  // Idempotente: aplicar de novo não cria sobrecarga nem altera definição.
  await applyMigration(before, PANEL_MIGRATION);
  assert.deepEqual([...(await functionHashes(before)).entries()], [...after.entries()]);
});

test("a migration não tem DML nem DDL de tabela: só funções e grants", () => {
  const sql = readFileSync(new URL(`../supabase/migrations/${PANEL_MIGRATION}`, import.meta.url), "utf8").replace(/--.*$/gm, "");
  const outside = sql.replace(/\$\$[\s\S]*?\$\$/g, "$$BODY$$");
  for (const statement of outside.split(";").map((part) => part.trim()).filter(Boolean)) {
    assert.match(statement, /^(create or replace function|revoke all on function|grant execute on function)\b/i, statement.slice(0, 80));
  }
  assert.doesNotMatch(sql, /\b(insert into|update public\.|delete from|alter table|create table|drop )/i);
});

test("funções do painel: security definer, search_path fixo, só a service role executa", async () => {
  const functions = await rows(
    `select p.proname, p.prosecdef, p.proconfig,
            has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
            has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1) order by 1`,
    [PANEL_FUNCTIONS],
  );
  assert.equal(functions.length, 4);
  for (const fn of functions) {
    assert.equal(fn.prosecdef, true, `${fn.proname} security definer`);
    assert.ok((fn.proconfig as string[]).some((entry) => entry === "search_path=public"), `${fn.proname} search_path`);
    assert.equal(fn.anon, false, `${fn.proname} anon`);
    assert.equal(fn.authenticated, false, `${fn.proname} authenticated`);
    assert.equal(fn.service_role, true, `${fn.proname} service_role`);
  }
});

// =============================================================================
// 2. Autorização
// =============================================================================

test("ADMIN e OPERATOR operam o painel; instrutor, admin inativo e desconhecido são recusados em tudo", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const target = await makeSession(IMERSAO.id, { price });
  const booking = await reserve(origin);

  const operations: Array<[string, (actor: string) => Promise<unknown>]> = [
    ["colocar em Stand-by", (actor) => setStandby(booking.id, actor)],
    ["lista", (actor) => listPage({}, actor)],
    ["opções", (actor) => options(booking.id, actor)],
    ["histórico", (actor) => history(booking.id, actor)],
    ["gerar link", (actor) => generateLink(booking.id, actor)],
    ["revogar link", (actor) => revokeLink(booking.id, actor)],
    ["reagendar", (actor) => reschedule(booking.id, target, actor)],
    ["desfazer", (actor) => undoStandby(booking.id, actor)],
  ];

  for (const actor of [INSTRUCTOR, INACTIVE_ADMIN, STRANGER]) {
    for (const [label, run] of operations) {
      await rejects(run(actor), /ADMIN_FORBIDDEN/).catch((error) => { throw new Error(`${label} deveria recusar ${actor}: ${error}`); });
    }
  }
  assert.equal((await reservation(booking.id)).status, "CONFIRMED", "nenhuma tentativa recusada alterou a reserva");
  assert.equal((await rows(`select 1 from public.reservation_standby where reservation_id = $1::uuid`, [booking.id])).length, 0);

  // O operador percorre o fluxo inteiro.
  await setStandby(booking.id, OPERATOR);
  assert.equal((await listPage({ query: booking.code }, OPERATOR)).total, 1);
  assert.equal((await options(booking.id, OPERATOR)).publicCode, booking.code);
  assert.match((await generateLink(booking.id, OPERATOR)).token, /^[0-9a-f]{64}$/);
  assert.equal(await revokeLink(booking.id, OPERATOR), true);
  assert.equal((await reschedule(booking.id, target, OPERATOR)).resolution, "RESCHEDULED");
  assert.equal((await history(booking.id, OPERATOR)).cycles.length, 1);
});

// =============================================================================
// 3. Entrada em Stand-by
// =============================================================================

test("entrada: libera as vagas, preserva pagamento, código e QR, e aparece na lista com os dados da tela", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price, capacity: 4 });
  const booking = await reserve(origin, 3, "Marina Lopes Azevedo");
  const before = await reservation(booking.id);
  assert.equal(await spots(origin), 1);

  await setStandby(booking.id);
  const after = await reservation(booking.id);
  assert.equal(after.status, "AWAITING_RESCHEDULE");
  assert.equal(await spots(origin), 4, "as três vagas voltam para a turma original");
  for (const field of ["public_code", "quantity", "unit_price_cents", "total_cents", "checkin_token", "provider_reference"]) {
    assert.deepEqual(after[field], before[field], `${field} não pode mudar`);
  }
  assert.deepEqual(after.confirmed_at, before.confirmed_at);

  const page = await listPage({ query: booking.code });
  assert.equal(page.total, 1);
  const [item] = page.items;
  assert.equal(item.fullName, "Marina Lopes Azevedo");
  assert.equal(item.publicCode, booking.code);
  assert.equal(item.originalExperienceTitle, IMERSAO.title);
  assert.equal(item.originalBaseName, IMERSAO.base_name);
  assert.equal(item.quantity, 3);
  assert.equal(item.totalCents, price * 3);
  assert.equal(item.reason, REASON);
  assert.equal(item.enteredByName, "Admin Teste");
  assert.ok(item.originalStartsAt && item.enteredAt);
  assert.equal(item.hasActiveLink, false);

  // Sem CPF, hash de CPF ou hash de link em lugar nenhum da resposta.
  const serialized = JSON.stringify(page);
  assert.ok(!serialized.includes(booking.cpf));
  assert.ok(!serialized.includes(before.cpf_hash));
  assert.doesNotMatch(serialized, /cpf|token|hash/i);
});

test("reservas com check-in parcial ou completo são bloqueadas; sem registro e ausência entram", async () => {
  const price = uniquePrice();
  const session = await makeSession(IMERSAO.id, { price, capacity: 12 });
  const partial = await reserve(session, 3);
  const complete = await reserve(session, 2);
  const absent = await reserve(session, 2);
  const untouched = await reserve(session, 2);

  await checkin(partial.id, 1);
  await checkin(complete.id, 2);
  await checkin(absent.id, 0);

  await rejects(setStandby(partial.id), /STANDBY_CHECKIN_REGISTERED/);
  await rejects(setStandby(complete.id), /STANDBY_CHECKIN_REGISTERED/);
  assert.equal((await reservation(partial.id)).status, "CONFIRMED");
  assert.equal((await reservation(complete.id)).status, "CONFIRMED");

  await setStandby(absent.id);
  await setStandby(untouched.id);
  assert.equal((await reservation(absent.id)).status, "AWAITING_RESCHEDULE");
  assert.equal((await reservation(untouched.id)).status, "AWAITING_RESCHEDULE");
});

test("sessão passada sem presença registrada entra em Stand-by; pré-reserva, cancelada e sem pagamento não", async () => {
  const price = uniquePrice();
  const session = await makeSession(IMERSAO.id, { price, capacity: 10 });
  const past = await reserve(session);
  const cancelled = await reserve(session);
  const pending = await preReserve(session);
  await db.query(`update public.sessions set starts_at = now() - interval '3 days' where id = $1::uuid`, [session]);
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Cliente desistiu')`, [ADMIN, cancelled.id]);

  await setStandby(past.id);
  assert.equal((await reservation(past.id)).status, "AWAITING_RESCHEDULE");
  await rejects(setStandby(cancelled.id), /RESERVATION_NOT_CONFIRMED/);
  await rejects(setStandby(pending.id), /RESERVATION_NOT_CONFIRMED/);
  await rejects(setStandby(past.id), /RESERVATION_ALREADY_IN_STANDBY/);
  await rejects(setStandby(past.id, ADMIN, " x "), /REASON_REQUIRED/);

  // Sessão passada: desfazer não é possível, e a tela já sabe disso.
  const view = await options(past.id);
  assert.equal(view.restore.allowed, false);
  assert.equal(view.restore.rejection, "SESSION_MUST_BE_FUTURE");
  await rejects(undoStandby(past.id), /SESSION_MUST_BE_FUTURE/);
  assert.equal((await reservation(past.id)).status, "AWAITING_RESCHEDULE", "a recusa não altera o Stand-by");
});

// =============================================================================
// 4. Opções de reagendamento
// =============================================================================

test("opções: só turma futura, aberta, publicada, com vagas e do mesmo valor — de qualquer base", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price, capacity: 6 });
  const booking = await reserve(origin, 3);
  await setStandby(booking.id);

  const sameBase = await makeSession(IMERSAO.id, { price, capacity: 4, startsIn: "12 days" });
  const otherBase = await makeSession(SUNSET_CONCHA.id, { price, capacity: 5, startsIn: "14 days" });
  const otherPrice = await makeSession(IMERSAO.id, { price: price + 1 });
  const cheaper = await makeSession(IMERSAO.id, { price: price - 1 });
  const closed = await makeSession(IMERSAO.id, { price, status: "CLOSED" });
  const past = await makeSession(IMERSAO.id, { price, startsIn: "-2 days" });
  const unpublished = await makeSession(ROTA.id, { price });
  const tooSmall = await makeSession(IMERSAO.id, { price, capacity: 2 });
  const almostFull = await makeSession(IMERSAO.id, { price, capacity: 4 });
  await reserve(almostFull, 2);

  const view = await options(booking.id);
  const offered = view.options.map((option: Row) => option.sessionId);
  assert.deepEqual([...offered].sort(), [origin, sameBase, otherBase].sort());
  for (const excluded of [otherPrice, cheaper, closed, past, unpublished, tooSmall, almostFull]) {
    assert.ok(!offered.includes(excluded), "turma inelegível não pode ser oferecida");
  }
  assert.equal(view.hiddenForCapacity, 2, "as duas turmas do mesmo valor sem vaga para o grupo são contadas à parte");
  assert.equal(view.options.find((option: Row) => option.sessionId === origin).isOriginal, true);
  assert.equal(view.options.find((option: Row) => option.sessionId === otherBase).baseName, SUNSET_CONCHA.base_name);
  for (const option of view.options) assert.equal(option.priceCents, price);

  assert.equal(view.quantity, 3);
  assert.equal(view.unitPriceCents, price);
  assert.equal(view.totalCents, price * 3);
  assert.equal(view.original.sessionId, origin);
  assert.equal(view.restore.allowed, true);
  assert.equal(view.reason, REASON);
  assert.doesNotMatch(JSON.stringify(view), /cpf|token_hash|"token"/i);
});

test("reserva sem nenhuma data elegível: a lista vem vazia e a reserva continua em Stand-by", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const booking = await reserve(origin);
  await setStandby(booking.id);
  await db.query(`update public.sessions set status = 'CLOSED' where id = $1::uuid`, [origin]);
  await makeSession(IMERSAO.id, { price: price + 500 });

  const view = await options(booking.id);
  assert.deepEqual(view.options, []);
  assert.equal(view.hiddenForCapacity, 0);
  assert.equal(view.restore.allowed, false);
  assert.equal(view.restore.rejection, "SESSION_NOT_OPEN");
  assert.equal((await reservation(booking.id)).status, "AWAITING_RESCHEDULE");
});

test("opções só existem para reserva em Stand-by", async () => {
  const session = await makeSession(IMERSAO.id, { price: uniquePrice() });
  const confirmed = await reserve(session);
  await rejects(options(confirmed.id), /RESERVATION_NOT_IN_STANDBY/);
  assert.equal(await options("00000000-0000-4000-8000-00000000dead"), null);
});

// =============================================================================
// 5. Reagendamento
// =============================================================================

test("reagendar entre bases: mesma reserva, mesma quantidade, mesmo pagamento, mesmo QR, sem evento financeiro novo", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price, capacity: 4 });
  const target = await makeSession(SUNSET_CONCHA.id, { price, capacity: 4 });
  const booking = await reserve(origin, 3);
  const before = await reservation(booking.id);
  const eventsBefore = await rows(`select id from public.payment_events where reservation_id = $1::uuid order by id`, [booking.id]);
  const revenueBefore = (await call(`public.admin_dashboard_metrics($1::uuid)`, [ADMIN])).confirmedRevenueCents;
  await setStandby(booking.id);
  assert.equal((await call(`public.admin_dashboard_metrics($1::uuid)`, [ADMIN])).confirmedRevenueCents, revenueBefore, "Stand-by continua na receita");

  const result = await reschedule(booking.id, target);
  assert.equal(result.resolution, "RESCHEDULED");
  assert.equal(result.replayed, false);
  assert.equal(result.previousSessionId, origin);
  assert.equal(result.targetSessionId, target);
  assert.equal(result.experienceChanged, true);

  const after = await reservation(booking.id);
  assert.equal(after.status, "CONFIRMED");
  assert.equal(after.session_id, target);
  assert.equal(after.experience_id, SUNSET_CONCHA.id);
  for (const field of ["public_code", "quantity", "unit_price_cents", "total_cents", "checkin_token", "provider_reference", "cpf_hash"]) {
    assert.deepEqual(after[field], before[field], `${field} não pode mudar`);
  }
  assert.deepEqual(after.confirmed_at, before.confirmed_at);
  assert.equal(await spots(origin), 4);
  assert.equal(await spots(target), 1);
  assert.deepEqual(await rows(`select id from public.payment_events where reservation_id = $1::uuid order by id`, [booking.id]), eventsBefore);
  assert.equal((await call(`public.admin_dashboard_metrics($1::uuid)`, [ADMIN])).confirmedRevenueCents, revenueBefore, "o reagendamento não duplica nem perde receita");

  const change = await one(`select * from public.reservation_session_changes where reservation_id = $1::uuid`, [booking.id]);
  assert.equal(change.origin, "STANDBY_RESCHEDULE");
  assert.equal(change.actor_type, "ADMIN");
  assert.equal(change.actor_user_id, ADMIN);
  assert.equal(change.reason, "Cliente escolheu por telefone");
});

test("reagendar exige preço unitário exatamente igual ao pago e recusa sem alterar nada", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const booking = await reserve(origin);
  await setStandby(booking.id);

  const targets: Array<[string, RegExp]> = [
    [await makeSession(IMERSAO.id, { price: price + 100 }), /PRICE_NOT_ELIGIBLE/],
    [await makeSession(IMERSAO.id, { price: price - 100 }), /PRICE_NOT_ELIGIBLE/],
    [await makeSession(IMERSAO.id, { price, status: "CLOSED" }), /SESSION_NOT_OPEN/],
    [await makeSession(IMERSAO.id, { price, startsIn: "-1 day" }), /SESSION_MUST_BE_FUTURE/],
    [await makeSession(ROTA.id, { price }), /EXPERIENCE_NOT_AVAILABLE/],
    [await makeSession(IMERSAO.id, { price, capacity: 1 }), /INSUFFICIENT_SPOTS/],
    ["00000000-0000-4000-8000-00000000beef", /SESSION_NOT_FOUND/],
  ];
  for (const [target, pattern] of targets) await rejects(reschedule(booking.id, target), pattern);

  const after = await reservation(booking.id);
  assert.equal(after.status, "AWAITING_RESCHEDULE");
  assert.equal(after.session_id, origin);
  const standby = await one(`select * from public.reservation_standby where reservation_id = $1::uuid`, [booking.id]);
  assert.equal(standby.resolved_at, null, "a autorização continua aberta depois de toda recusa");
  assert.equal((await rows(`select 1 from public.reservation_session_changes where reservation_id = $1::uuid`, [booking.id])).length, 0);
});

test("reagendar é de uso único: repetir devolve o mesmo resultado; outro destino é recusado", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const target = await makeSession(IMERSAO.id, { price });
  const other = await makeSession(IMERSAO.id, { price });
  const booking = await reserve(origin);
  await setStandby(booking.id);

  const first = await reschedule(booking.id, target);
  const again = await reschedule(booking.id, target);
  assert.equal(again.replayed, true);
  assert.equal(again.changeId, first.changeId);
  await rejects(reschedule(booking.id, other), /STANDBY_ALREADY_USED/);
  assert.equal((await rows(`select 1 from public.reservation_session_changes where reservation_id = $1::uuid`, [booking.id])).length, 1);
  assert.equal((await reservation(booking.id)).session_id, target);

  const neverInStandby = await reserve(await makeSession(IMERSAO.id, { price }));
  await rejects(reschedule(neverInStandby.id, target), /RESERVATION_NOT_IN_STANDBY/);
  assert.equal(await reschedule("00000000-0000-4000-8000-00000000dead", target), null);
});

test("concorrência e capacidade: duas reservas em Stand-by disputam a última vaga e não há overbooking", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price, capacity: 8 });
  const target = await makeSession(IMERSAO.id, { price, capacity: 3 });
  const first = await reserve(origin, 2);
  const second = await reserve(origin, 2);
  await setStandby(first.id);
  await setStandby(second.id);

  // As duas viram a turma com vaga na mesma leitura.
  assert.ok((await options(first.id)).options.some((option: Row) => option.sessionId === target));
  assert.ok((await options(second.id)).options.some((option: Row) => option.sessionId === target));

  await reschedule(first.id, target);
  await rejects(reschedule(second.id, target), /INSUFFICIENT_SPOTS/);
  assert.equal(await spots(target), 1);
  assert.equal((await reservation(second.id)).status, "AWAITING_RESCHEDULE");
  assert.ok(!(await options(second.id)).options.some((option: Row) => option.sessionId === target), "a turma some da lista de quem não cabe mais");

  // Pré-reserva válida de outro cliente também ocupa.
  const held = await makeSession(IMERSAO.id, { price, capacity: 3 });
  await preReserve(held, 2);
  await rejects(reschedule(second.id, held), /INSUFFICIENT_SPOTS/);
  const confirmedInTarget = await one(
    `select coalesce(sum(quantity), 0)::int as total from public.reservations where session_id = $1::uuid and status = 'CONFIRMED'`,
    [target],
  );
  assert.ok(confirmedInTarget.total <= 3);
});

// =============================================================================
// 6. Desfazer
// =============================================================================

test("desfazer só com a turma original aberta, futura e com vagas; senão o Stand-by continua intacto", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price, capacity: 4 });
  const booking = await reserve(origin, 3);
  const before = await reservation(booking.id);
  await setStandby(booking.id);

  // Outra pessoa ocupa as vagas liberadas: não cabe mais.
  const intruder = await reserve(origin, 2);
  let view = await options(booking.id);
  assert.equal(view.restore.allowed, false);
  assert.equal(view.restore.rejection, "INSUFFICIENT_SPOTS");
  await rejects(undoStandby(booking.id), /INSUFFICIENT_SPOTS/);
  assert.equal((await reservation(booking.id)).status, "AWAITING_RESCHEDULE");

  // Turma fechada: também não.
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Liberar a vaga')`, [ADMIN, intruder.id]);
  await db.query(`update public.sessions set status = 'CLOSED' where id = $1::uuid`, [origin]);
  await rejects(undoStandby(booking.id), /SESSION_NOT_OPEN/);

  // Aberta, futura e com vagas: volta.
  await db.query(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [origin]);
  view = await options(booking.id);
  assert.equal(view.restore.allowed, true);
  const result = await undoStandby(booking.id);
  assert.equal(result.resolution, "RESTORED");
  const after = await reservation(booking.id);
  assert.equal(after.status, "CONFIRMED");
  assert.equal(after.session_id, origin);
  assert.deepEqual(after.checkin_token, before.checkin_token);
  assert.deepEqual(after.confirmed_at, before.confirmed_at);
  assert.equal(await spots(origin), 1);
  await rejects(options(booking.id), /RESERVATION_NOT_IN_STANDBY/);
});

// =============================================================================
// 7. Link individual
// =============================================================================

test("link: gerar, substituir e revogar — o token nunca aparece em lista, opções, histórico ou auditoria", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const booking = await reserve(origin);
  await setStandby(booking.id);
  await rejects(generateLink((await reserve(origin)).id), /RESERVATION_NOT_IN_STANDBY/);

  const first = await generateLink(booking.id);
  assert.match(first.token, /^[0-9a-f]{64}$/);
  assert.equal((await listPage({ query: booking.code })).items[0].hasActiveLink, true);
  assert.equal((await listPage({ query: booking.code, link: "WITH" })).total, 1);
  assert.equal((await listPage({ query: booking.code, link: "WITHOUT" })).total, 0);
  assert.equal((await options(booking.id)).hasActiveLink, true);

  // Gerar de novo invalida o anterior na hora.
  const second = await generateLink(booking.id);
  assert.notEqual(second.token, first.token);
  assert.equal(await call(`public.customer_reschedule_options(null, null, $1)`, [first.token]), null);
  assert.equal((await call(`public.customer_reschedule_options(null, null, $1)`, [second.token])).publicCode, booking.code);

  // Revogar: o link para de funcionar e a reserva continua em Stand-by.
  assert.equal(await revokeLink(booking.id), true);
  assert.equal(await call(`public.customer_reschedule_options(null, null, $1)`, [second.token]), null);
  assert.equal(await revokeLink(booking.id), false, "revogar de novo não tem o que revogar");
  assert.equal((await reservation(booking.id)).status, "AWAITING_RESCHEDULE");
  assert.equal((await listPage({ query: booking.code, link: "WITHOUT" })).total, 1);

  const stored = await one(`select link_token_hash, link_revoked_at from public.reservation_standby where reservation_id = $1::uuid`, [booking.id]);
  assert.equal(stored.link_token_hash, null);
  assert.ok(stored.link_revoked_at);

  const trail = await history(booking.id);
  const audit = await rows(`select action, metadata, reason from public.admin_audit_log where entity_id = $1::uuid`, [booking.id]);
  const everything = JSON.stringify([await listPage({ query: booking.code }), await options(booking.id), trail, audit]);
  for (const secret of [first.token, second.token]) assert.ok(!everything.includes(secret), "o token não pode aparecer em nenhuma leitura");
  assert.doesNotMatch(JSON.stringify(trail), /[0-9a-f]{64}/, "nem token nem hash no histórico");
  assert.deepEqual(
    trail.events.map((event: Row) => event.action).sort(),
    ["RESERVATION_STANDBY_LINK_GENERATED", "RESERVATION_STANDBY_LINK_GENERATED", "RESERVATION_STANDBY_LINK_REVOKED", "RESERVATION_STANDBY_SET"],
  );
  assert.ok(trail.cycles[0].linkRevokedAt);
  assert.equal(trail.cycles[0].hasActiveLink, false);
});

test("reagendar ou cancelar encerra o link junto com o Stand-by", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const target = await makeSession(IMERSAO.id, { price });
  const moved = await reserve(origin);
  const cancelled = await reserve(origin);
  await setStandby(moved.id);
  await setStandby(cancelled.id);
  const movedLink = await generateLink(moved.id);
  const cancelledLink = await generateLink(cancelled.id);

  await reschedule(moved.id, target);
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Cliente pediu o cancelamento')`, [ADMIN, cancelled.id]);

  assert.equal(await call(`public.customer_reschedule_options(null, null, $1)`, [movedLink.token]), null);
  assert.equal(await call(`public.customer_reschedule_options(null, null, $1)`, [cancelledLink.token]), null);
  await rejects(generateLink(moved.id), /RESERVATION_NOT_IN_STANDBY/);
  await rejects(revokeLink(cancelled.id), /RESERVATION_NOT_IN_STANDBY/);

  const trail = await history(cancelled.id);
  assert.equal(trail.cycles[0].resolution, "CANCELLED");
  assert.equal(trail.cycles[0].hasActiveLink, false);
  assert.equal((await reservation(cancelled.id)).status, "CANCELLED");
});

// =============================================================================
// 8. Auditoria
// =============================================================================

test("histórico: quem colocou, motivo, data, reagendamento e desfazimento, um ciclo por entrada", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price, capacity: 6 });
  const target = await makeSession(SUNSET_CONCHA.id, { price, capacity: 6 });
  const booking = await reserve(origin);

  assert.deepEqual(await history(booking.id), { cycles: [], events: [] });
  assert.equal(await history("00000000-0000-4000-8000-00000000dead"), null);

  await setStandby(booking.id, ADMIN, "Primeira entrada");
  await undoStandby(booking.id, OPERATOR);
  await setStandby(booking.id, OPERATOR, "Segunda entrada");
  await reschedule(booking.id, target, ADMIN, "Nova data combinada");

  const trail = await history(booking.id);
  assert.equal(trail.cycles.length, 2);
  const restored = trail.cycles.find((cycle: Row) => cycle.resolution === "RESTORED");
  const rescheduled = trail.cycles.find((cycle: Row) => cycle.resolution === "RESCHEDULED");
  assert.ok(restored && rescheduled);
  assert.equal(restored.enteredByName, "Admin Teste");
  assert.equal(restored.reason, "Primeira entrada");
  assert.equal(restored.resolution, "RESTORED");
  assert.equal(restored.resolvedByName, "Operador Teste");
  assert.equal(restored.open, false);
  assert.ok(restored.enteredAt && restored.resolvedAt);

  assert.equal(rescheduled.enteredByName, "Operador Teste");
  assert.equal(rescheduled.reason, "Segunda entrada");
  assert.equal(rescheduled.resolution, "RESCHEDULED");
  assert.equal(rescheduled.resolvedByType, "ADMIN");
  assert.equal(rescheduled.resolvedByName, "Admin Teste");
  assert.equal(rescheduled.resolvedReason, "Nova data combinada");
  assert.equal(rescheduled.originalExperienceTitle, IMERSAO.title);
  assert.equal(rescheduled.targetExperienceTitle, SUNSET_CONCHA.title);
  assert.equal(rescheduled.targetBaseName, SUNSET_CONCHA.base_name);

  // Comparado sem depender da ordem: o relógio do banco de teste pode repetir
  // o mesmo instante entre duas ações.
  assert.deepEqual(
    trail.events.map((event: Row) => `${event.action} · ${event.actorName}`).sort(),
    [
      "RESERVATION_STANDBY_RESCHEDULED · Admin Teste",
      "RESERVATION_STANDBY_RESTORED · Operador Teste",
      "RESERVATION_STANDBY_SET · Admin Teste",
      "RESERVATION_STANDBY_SET · Operador Teste",
    ],
  );
  // Os metadados da auditoria não saem: só o tipo de ator e a forma de acesso.
  for (const event of trail.events) assert.deepEqual(Object.keys(event).sort(), ["access", "action", "actorName", "actorType", "at", "id", "reason"]);
});

// =============================================================================
// 9. Lista: busca, filtros e paginação
// =============================================================================

test("lista: busca por nome, código e telefone, filtro por base, e curingas tratados como texto", async () => {
  const price = uniquePrice();
  const lago = await makeSession(IMERSAO.id, { price, capacity: 10 });
  const concha = await makeSession(SUNSET_CONCHA.id, { price, capacity: 10 });
  const ana = await reserve(lago, 2, "Anabela Quintanilha Busca");
  const bruno = await reserve(concha, 3, "Brunildo Quintanilha Busca");
  const percent = await reserve(lago, 1, "Cem%Porcento Busca");
  for (const booking of [ana, bruno, percent]) await setStandby(booking.id);
  // O relógio do banco de teste pode repetir o mesmo instante; a ordem da fila
  // é a de entrada, então a entrada da Ana é deixada explicitamente mais antiga.
  await db.query(`update public.reservation_standby set created_at = created_at - interval '2 hours' where reservation_id = $1::uuid`, [ana.id]);

  const byName = await listPage({ query: "quintanilha busca" });
  assert.deepEqual(byName.items.map((item: Row) => item.publicCode), [ana.code, bruno.code], "a mais antiga primeiro");
  assert.equal(byName.total, 2);
  assert.equal(byName.totalParticipants, 5);
  assert.equal(byName.totalCents, price * 5);

  assert.equal((await listPage({ query: bruno.code.toLowerCase() })).items[0].fullName, "Brunildo Quintanilha Busca");
  const phone = (await reservation(ana.id)).phone.replace(/\D/g, "").slice(-8);
  assert.deepEqual((await listPage({ query: phone })).items.map((item: Row) => item.publicCode), [ana.code]);

  assert.deepEqual((await listPage({ query: "Quintanilha Busca", baseId: SUNSET_CONCHA.base_id })).items.map((item: Row) => item.publicCode), [bruno.code]);
  assert.deepEqual((await listPage({ query: "Quintanilha Busca", baseId: IMERSAO.base_id })).items.map((item: Row) => item.publicCode), [ana.code]);

  // % e _ são texto, não curinga.
  assert.deepEqual((await listPage({ query: "Cem%Porcento" })).items.map((item: Row) => item.publicCode), [percent.code]);
  assert.equal((await listPage({ query: "Cem_Porcento" })).total, 0);
  assert.equal((await listPage({ query: "%%%" })).total, 0);

  await rejects(listPage({ link: "TALVEZ" }), /STANDBY_INVALID_FILTER/);
  await rejects(listPage({ query: "x".repeat(121) }), /STANDBY_INVALID_FILTER/);

  // Resolvida, sai da lista.
  await reschedule(ana.id, await makeSession(IMERSAO.id, { price, capacity: 4 }));
  assert.deepEqual((await listPage({ query: "Quintanilha Busca" })).items.map((item: Row) => item.publicCode), [bruno.code]);
});

test("paginação: mais de 500 reservas em Stand-by são todas alcançáveis, sem repetir nem perder nenhuma", async () => {
  const price = uniquePrice();
  const session = await makeSession(IMERSAO.id, { price, capacity: 5000 });
  const TOTAL = 520;

  await db.query(
    `with created as (
       insert into public.reservations (
         public_code, idempotency_key, experience_id, session_id, full_name, cpf_hash, cpf_last4,
         phone, email, quantity, unit_price_cents, expires_at, status, confirmed_at
       )
       select 'LT' || lpad(n::text, 8, '0'), gen_random_uuid(), $1::uuid, $2::uuid, 'Lote Paginacao ' || lpad(n::text, 4, '0'),
              encode(extensions.digest('3' || lpad(n::text, 10, '0'), 'sha256'), 'hex'), lpad((n % 10000)::text, 4, '0'),
              '+5561900000000', 'lote' || n || '@teste.local', 1, $3, now() + interval '2 hours', 'CONFIRMED', now()
       from generate_series(1, $4::int) n
       returning id, total_cents
     )
     insert into public.payment_events (reservation_id, provider, provider_event_id, event_type, amount_cents, payload)
     select id, 'INFINITEPAY', 'lote-' || id, 'PAYMENT_CONFIRMED', total_cents, '{}'::jsonb from created`,
    [IMERSAO.id, session, price, TOTAL],
  );
  const entered = await one(
    `select count(*)::int as total from (
       select public.admin_set_reservation_standby($1::uuid, r.id, 'Lote de paginação')
       from public.reservations r where r.full_name like 'Lote Paginacao %'
     ) done`,
    [ADMIN],
  );
  assert.equal(entered.total, TOTAL);

  // A função da etapa anterior para em 500 e não tem página seguinte.
  const capped = await call(`public.admin_list_standby_reservations($1::uuid)`, [ADMIN]);
  assert.equal(capped.length, 500);

  const seen = new Set<string>();
  let offset = 0;
  let pages = 0;
  let total = 0;
  for (;;) {
    const page = await listPage({ query: "Lote Paginacao", limit: 100, offset });
    total = page.total;
    assert.equal(page.limit, 100);
    assert.equal(page.offset, offset);
    if (page.items.length === 0) break;
    for (const item of page.items) {
      assert.ok(!seen.has(item.standbyId), "nenhuma reserva aparece em duas páginas");
      seen.add(item.standbyId);
    }
    pages += 1;
    offset += 100;
  }
  assert.equal(total, TOTAL);
  assert.equal(seen.size, TOTAL, "todas as 520 são alcançadas");
  assert.equal(pages, 6);

  const summary = await listPage({ query: "Lote Paginacao", limit: 1 });
  assert.equal(summary.totalParticipants, TOTAL, "os totais são do conjunto filtrado, não da página");
  assert.equal(summary.totalCents, price * TOTAL);

  // O limite por página é contido pelo banco.
  assert.equal((await listPage({ query: "Lote Paginacao", limit: 9999 })).items.length, 100);
  assert.equal((await listPage({ query: "Lote Paginacao", limit: 0 })).items.length, 1);
  assert.equal((await listPage({ query: "Lote Paginacao", limit: 25, offset: -10 })).offset, 0);
});

// =============================================================================
// 10. Compatibilidade
// =============================================================================

test("reagendamento tradicional continua igual: sem régua de preço e sem alcançar reserva em Stand-by", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const dearer = await makeSession(SUNSET_CONCHA.id, { price: price + 5000 });
  const confirmed = await reserve(origin);
  const parked = await reserve(origin);
  await setStandby(parked.id);

  const change = await call(`public.admin_change_reservation_session($1::uuid, $2::uuid, $3::uuid, 'Pedido do cliente')`, [ADMIN, confirmed.id, dearer]);
  assert.ok(change);
  const moved = await reservation(confirmed.id);
  assert.equal(moved.session_id, dearer, "a troca direta aceita turma de outro preço, como sempre");
  assert.equal(moved.unit_price_cents, price);
  assert.equal(moved.status, "CONFIRMED");
  const direct = await one(`select origin, standby_id from public.reservation_session_changes where reservation_id = $1::uuid`, [confirmed.id]);
  assert.equal(direct.origin, "DIRECT");
  assert.equal(direct.standby_id, null);

  await rejects(
    call(`public.admin_change_reservation_session($1::uuid, $2::uuid, $3::uuid, 'Tentativa')`, [ADMIN, parked.id, dearer]),
    /RESERVATION_NOT_CONFIRMED/,
  );
});

test("pagamento e QR durante o Stand-by: nada reconfirma, e o QR só vale depois de reagendar", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const target = await makeSession(IMERSAO.id, { price });
  const booking = await reserve(origin);
  await setStandby(booking.id);

  assert.equal(await call(`public.reconcile_reservation_payment($1::uuid, 'INFINITEPAY', 'tx-repetido', $2, null, '{}'::jsonb)`, [booking.id, booking.total]), "AWAITING_RESCHEDULE");
  assert.equal(await call(`public.confirm_reservation_payment($1::uuid, 'INFINITEPAY', 'tx-repetido', $2, null, '{}'::jsonb)`, [booking.id, booking.total]), false);
  await rejects(call(`public.admin_confirm_reservation($1::uuid, $2::uuid, 'Tentativa')`, [ADMIN, booking.id]), /RESERVATION_AWAITING_RESCHEDULE/);
  await rejects(checkin(booking.id, 1), /RESERVATION_NOT_CONFIRMED/);
  assert.equal((await reservation(booking.id)).status, "AWAITING_RESCHEDULE");

  await reschedule(booking.id, target);
  await checkin(booking.id, 2);
  assert.equal((await reservation(booking.id)).checked_in_count, 2);
});

// =============================================================================
// 11. Google Sheets: modo "somente atualizar"
// =============================================================================
//
// Os snapshots vêm do banco de verdade e a decisão do modo é tomada como o
// serviço toma: lendo `reservation_standby` pela turma do snapshot. A planilha é
// a falsa, em memória.

const SYNCED_AT = "2026-10-14T12:00:00.000Z";

async function standbyOrigins(sessionId: string) {
  return parseStandbyOriginRows(await rows(
    `select reservation_id, resolved_at, resolution, resolved_session_id from public.reservation_standby where original_session_id = $1::uuid`,
    [sessionId],
  ));
}

/** O mesmo caminho de `runJob`: snapshot → modo → motor. */
async function syncAsService(sheets: FakeSheets, entity: "RESERVATION" | "SESSION", entityId: string) {
  const raw = entity === "SESSION"
    ? await call(`public.google_sheets_session_snapshot($1::uuid)`, [entityId])
    : await call(`public.google_sheets_reservation_snapshot($1::uuid)`, [entityId]);
  const snapshot = parseSnapshot(raw);
  assert.ok(snapshot, "snapshot");
  const updateOnly = isStandbyOriginUpdateOnly(entity, entityId, snapshot.session.id, await standbyOrigins(snapshot.session.id));
  const report = await syncSnapshot(sheets, snapshot, { syncedAt: SYNCED_AT, reconcileSession: entity === "SESSION", updateOnly });
  return { report, updateOnly };
}

function sessionIds(sheets: FakeSheets) {
  return sheets.dataRows(SESSIONS_TAB).map((row) => String(row[0]));
}

function reservationRowOf(sheets: FakeSheets, reservationId: string) {
  return sheets.dataRows(RESERVATIONS_TAB).find((row) => row[0] === reservationId);
}

function activeSpots(sheets: FakeSheets, reservationId: string) {
  return sheets.dataRows(SPOTS_TAB).filter((row) => String(row[0]).startsWith(`${reservationId}:`) && row[SPOT_COLUMN.active - 1] === ACTIVE_YES).length;
}

function frozen(sheets: FakeSheets) {
  return JSON.stringify([sheets.grid(SESSIONS_TAB), sheets.grid(RESERVATIONS_TAB), sheets.grid(SPOTS_TAB)]);
}

const STATUS_COLUMN = RESERVATION_HEADERS.findIndex((header) => /status da reserva/i.test(header));

test("planilha: o cabeçalho de status existe (pré-condição dos testes abaixo)", () => {
  assert.ok(STATUS_COLUMN >= 0, `coluna de status não encontrada em ${RESERVATION_HEADERS.join(" | ")}`);
});

test("planilha: sessão histórica fora da planilha não é recriada por Stand-by, cancelamento nem botão manual", async () => {
  const price = uniquePrice();
  // Uma das "14 sessões": aconteceu, tem reservas confirmadas e nunca entrou na planilha.
  const historical = await makeSession(IMERSAO.id, { price, capacity: 10 });
  const parked = await reserve(historical, 2);
  const cancelled = await reserve(historical, 3);
  await reserve(historical, 1);
  await db.query(`update public.sessions set starts_at = now() - interval '60 days' where id = $1::uuid`, [historical]);

  // A planilha tem outra turma, para provar que "nada mudou" não é "estava vazia".
  const sheets = createFakeSheets();
  const current = await makeSession(IMERSAO.id, { price, capacity: 6 });
  const regular = await reserve(current, 2);
  await syncAsService(sheets, "RESERVATION", regular.id);
  const before = frozen(sheets);
  assert.deepEqual(sessionIds(sheets), [current]);

  // 1. Entrada em Stand-by.
  await setStandby(parked.id);
  let outcome = await syncAsService(sheets, "RESERVATION", parked.id);
  assert.equal(outcome.updateOnly, true);
  assert.equal(outcome.report.skipped, true);
  assert.equal(frozen(sheets), before);

  // 2. Botão manual "Sincronizar planilha" na reserva em Stand-by, repetido.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    outcome = await syncAsService(sheets, "RESERVATION", parked.id);
    assert.equal(outcome.report.skipped, true);
  }
  assert.equal(frozen(sheets), before);

  // 3. Cancelamento de reserva em Stand-by.
  await setStandby(cancelled.id);
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Cliente pediu o cancelamento')`, [ADMIN, cancelled.id]);
  outcome = await syncAsService(sheets, "RESERVATION", cancelled.id);
  assert.equal(outcome.updateOnly, true);
  assert.equal(outcome.report.skipped, true);
  assert.equal(frozen(sheets), before);

  // 4. Botão manual "Sincronizar lista da sessão" na turma de origem.
  outcome = await syncAsService(sheets, "SESSION", historical);
  assert.equal(outcome.updateOnly, true);
  assert.equal(outcome.report.skipped, true);
  assert.equal(frozen(sheets), before);

  assert.deepEqual(sessionIds(sheets), [current], "a sessão histórica continua fora da planilha");
  assert.equal(reservationRowOf(sheets, parked.id), undefined);
  assert.equal(reservationRowOf(sheets, cancelled.id), undefined);
  assert.equal(sheets.ensureRowsCalls(), 1, "nenhuma chamada de estrutura além da primeira reserva");
});

test("planilha: reagendar a partir de sessão histórica cria só a turma nova; a de origem continua fora", async () => {
  const price = uniquePrice();
  const historical = await makeSession(IMERSAO.id, { price, capacity: 10 });
  const booking = await reserve(historical, 2);
  await reserve(historical, 1);
  await db.query(`update public.sessions set starts_at = now() - interval '45 days' where id = $1::uuid`, [historical]);
  const target = await makeSession(SUNSET_CONCHA.id, { price, capacity: 5 });

  const sheets = createFakeSheets();
  await setStandby(booking.id);
  assert.equal((await syncAsService(sheets, "RESERVATION", booking.id)).report.skipped, true);

  await reschedule(booking.id, target);

  // As duas escritas de `syncReservationSessionChange`: a reserva, depois a turma antiga.
  const moved = await syncAsService(sheets, "RESERVATION", booking.id);
  assert.equal(moved.updateOnly, false, "a reserva está confirmada em uma turma futura: sincronização normal");
  assert.equal(moved.report.skipped, false);
  const previous = await syncAsService(sheets, "SESSION", historical);
  assert.equal(previous.updateOnly, true);
  assert.equal(previous.report.skipped, true);

  assert.deepEqual(sessionIds(sheets), [target], "só a turma nova entra");
  assert.equal(activeSpots(sheets, booking.id), 2);
  assert.equal(reservationRowOf(sheets, booking.id)?.[STATUS_COLUMN], "Confirmada");
  assert.equal(sheets.dataRows(RESERVATIONS_TAB).length, 1, "a outra reserva da sessão histórica não foi escrita");

  // A ordem inversa e a repetição convergem para o mesmo resultado.
  const snapshotAfter = frozen(sheets);
  await syncAsService(sheets, "SESSION", historical);
  await syncAsService(sheets, "RESERVATION", booking.id);
  assert.equal(frozen(sheets), snapshotAfter);
});

test("planilha: turma que já está na planilha é atualizada — Stand-by, reagendamento, desfazer e cancelamento", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price, capacity: 6 });
  const target = await makeSession(IMERSAO.id, { price, capacity: 6 });
  const moved = await reserve(origin, 2);
  const restored = await reserve(origin, 1);
  const cancelled = await reserve(origin, 1);

  const sheets = createFakeSheets();
  for (const booking of [moved, restored, cancelled]) await syncAsService(sheets, "RESERVATION", booking.id);
  assert.deepEqual(sessionIds(sheets), [origin]);
  assert.equal(activeSpots(sheets, moved.id), 2);

  // Entrada: mesma linha, status novo, vagas inativas, sem linha nova.
  const rowsBefore = sheets.dataRows(RESERVATIONS_TAB).length;
  await setStandby(moved.id);
  let outcome = await syncAsService(sheets, "RESERVATION", moved.id);
  assert.equal(outcome.updateOnly, true);
  assert.equal(outcome.report.skipped, false);
  assert.equal(outcome.report.rowsAppended, 0);
  assert.equal(reservationRowOf(sheets, moved.id)?.[STATUS_COLUMN], "Aguardando reagendamento");
  assert.equal(activeSpots(sheets, moved.id), 0);
  assert.equal(sheets.dataRows(RESERVATIONS_TAB).length, rowsBefore);
  assert.ok(sheets.dataRows(SPOTS_TAB).filter((row) => String(row[0]).startsWith(`${moved.id}:`)).every((row) => row[SPOT_COLUMN.active - 1] === ACTIVE_NO));

  // Reagendamento: a reserva vai para a turma nova e a antiga tem os totais corrigidos.
  await reschedule(moved.id, target);
  await syncAsService(sheets, "RESERVATION", moved.id);
  outcome = await syncAsService(sheets, "SESSION", origin);
  assert.equal(outcome.report.skipped, false);
  assert.deepEqual(sessionIds(sheets).sort(), [origin, target].sort());
  assert.equal(activeSpots(sheets, moved.id), 2);
  assert.equal(reservationRowOf(sheets, moved.id)?.[STATUS_COLUMN], "Confirmada");

  // Desfazer: volta a ficar ativa na turma original.
  await setStandby(restored.id);
  await syncAsService(sheets, "RESERVATION", restored.id);
  assert.equal(activeSpots(sheets, restored.id), 0);
  await undoStandby(restored.id);
  outcome = await syncAsService(sheets, "RESERVATION", restored.id);
  assert.equal(outcome.updateOnly, false);
  assert.equal(activeSpots(sheets, restored.id), 1);

  // Cancelamento em Stand-by: o histórico fica, sem vaga ativa.
  await setStandby(cancelled.id);
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Cliente pediu o cancelamento')`, [ADMIN, cancelled.id]);
  outcome = await syncAsService(sheets, "RESERVATION", cancelled.id);
  assert.equal(outcome.updateOnly, true);
  assert.equal(outcome.report.skipped, false);
  assert.equal(reservationRowOf(sheets, cancelled.id)?.[STATUS_COLUMN], "Cancelada");
  assert.equal(activeSpots(sheets, cancelled.id), 0);

  // Nenhuma reserva duplicada em nenhum momento.
  const ids = sheets.dataRows(RESERVATIONS_TAB).map((row) => row[0]);
  assert.equal(new Set(ids).size, ids.length);
});

test("planilha: o fluxo normal não muda — turma nova continua sendo criada pela primeira reserva", async () => {
  const price = uniquePrice();
  const session = await makeSession(IMERSAO.id, { price, capacity: 6 });
  const booking = await reserve(session, 2);
  const sheets = createFakeSheets();

  const first = await syncAsService(sheets, "RESERVATION", booking.id);
  assert.equal(first.updateOnly, false);
  assert.equal(first.report.skipped, false);
  assert.deepEqual(sessionIds(sheets), [session]);

  // Cancelamento comum (nunca esteve em Stand-by) e reconstrução manual: como antes.
  const other = await reserve(session, 1);
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Cliente desistiu')`, [ADMIN, other.id]);
  assert.equal((await syncAsService(createFakeSheets(), "RESERVATION", other.id)).updateOnly, false);
  assert.equal((await syncAsService(createFakeSheets(), "SESSION", session)).updateOnly, false);
});

// =============================================================================
// 12. Material de publicação
// =============================================================================

function operationsFile(path: string) {
  return readFileSync(new URL(`../supabase/${path}`, import.meta.url), "utf8");
}

async function diagnostic(database: typeof db, path: string) {
  const sql = operationsFile(path);
  assert.ok(!/\b(insert|update|delete|alter|create|drop|grant|revoke|truncate)\b/i.test(sql.replace(/--.*$/gm, "").replace(/'[^']*'/g, "''")), `${path} é somente leitura`);
  return (await database.query(sql)).rows as Array<{ check_name: string; result: string; status: string }>;
}

test("preflight do painel: aprovado antes da migration, reprovado depois e sem a etapa anterior", async () => {
  const before = await fullDatabase({ until: STANDBY_MIGRATION });
  const approved = await diagnostic(before, "diagnostics/reservation_standby_admin_panel_preflight.sql");
  assert.deepEqual(approved.filter((row) => row.status !== "OK"), [], JSON.stringify(approved, null, 2));
  assert.equal(approved.at(-1)?.check_name, "STANDBY_PAINEL_PREFLIGHT_OK");

  const after = (await diagnostic(db, "diagnostics/reservation_standby_admin_panel_preflight.sql")).filter((row) => row.status !== "OK").map((row) => row.check_name);
  assert.deepEqual(after, ["FUNCOES_DO_PAINEL_AINDA_NAO_EXISTEM", "STANDBY_PAINEL_PREFLIGHT_OK"]);

  // Função da etapa anterior alterada à mão: o preflight acusa.
  await before.exec(`create or replace function public.reservation_latest_standby(p_reservation_id uuid) returns uuid language sql stable security definer set search_path = public as $$ select null::uuid $$;`);
  const tampered = (await diagnostic(before, "diagnostics/reservation_standby_admin_panel_preflight.sql")).filter((row) => row.status !== "OK").map((row) => row.check_name);
  assert.deepEqual(tampered, ["FUNCOES_DE_QUE_O_PAINEL_DEPENDE", "STANDBY_PAINEL_PREFLIGHT_OK"]);
});

test("postcheck do painel: aprovado depois da migration, com Stand-by em uso, e sensível a definição alterada", async () => {
  // `db` já tem centenas de reservas em Stand-by dos testes acima: o postcheck
  // do painel não depende de a tabela estar vazia.
  const approved = await diagnostic(db, "diagnostics/reservation_standby_admin_panel_postcheck.sql");
  assert.deepEqual(approved.filter((row) => row.status !== "OK"), [], JSON.stringify(approved, null, 2));
  assert.equal(approved.at(-1)?.check_name, "STANDBY_PAINEL_POSTCHECK_OK");

  const fresh = await fullDatabase();
  await fresh.exec(`grant execute on function public.admin_standby_reschedule_options(uuid, uuid) to authenticated;`);
  const exposed = (await diagnostic(fresh, "diagnostics/reservation_standby_admin_panel_postcheck.sql")).filter((row) => row.status !== "OK").map((row) => row.check_name);
  assert.deepEqual(exposed, ["NENHUMA_FUNCAO_EXECUTAVEL_PELA_API_PUBLICA", "STANDBY_PAINEL_POSTCHECK_OK"]);

  // O postcheck da etapa anterior continua aprovado depois desta migration.
  const clean = await fullDatabase();
  const previous = await diagnostic(clean, "diagnostics/reservation_standby_postcheck.sql");
  assert.deepEqual(previous.filter((row) => row.status !== "OK"), [], JSON.stringify(previous, null, 2));
});

test("rollback do painel: remove só as quatro funções, não depende de Stand-by vazio e pode ser refeito", async () => {
  const database = await fullDatabase();
  const before = await functionHashes(database);
  await database.exec(operationsFile("rollback/202610140001_reservation_standby_admin_panel.rollback.sql"));
  const after = await functionHashes(database);

  const removed = [...before.keys()].filter((fn) => !after.has(fn)).map((fn) => fn.slice(0, fn.indexOf("("))).sort();
  assert.deepEqual(removed, PANEL_FUNCTIONS);
  for (const [fn, hash] of after) assert.equal(before.get(fn), hash, `${fn} não pode mudar`);

  // A etapa anterior segue inteira, e a migration pode ser reaplicada.
  const standby = await diagnostic(database, "diagnostics/reservation_standby_postcheck.sql");
  assert.deepEqual(standby.filter((row) => row.status !== "OK"), []);
  await applyMigration(database, PANEL_MIGRATION);
  assert.deepEqual([...(await functionHashes(database)).entries()], [...before.entries()]);
});
