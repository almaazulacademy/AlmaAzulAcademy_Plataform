/**
 * Lista de espera — fase 1: fundação no banco.
 *
 * Roda contra o Postgres em memória (PGlite) com **todas** as migrations do
 * repositório. As turmas esgotam pelo caminho real — pré-reserva e pagamento —
 * e a lista é operada só pelas funções que o servidor vai chamar. Nenhum e-mail
 * sai: nesta fase nada envia, e a suíte confere que a fila só acumula.
 *
 * A espera real entre duas sessões do Postgres (o mesmo e-mail em duas abas, a
 * inscrição ao lado de uma pré-reserva em curso) está em
 * `waitlist-foundation-concurrency.test.ts`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { applyMigration, fullDatabase } from "./support/full-database.ts";
import { ADMIN, INSTRUCTOR, STRANGER, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

const MIGRATION = "202610250001_waitlist_foundation.sql";
const PREVIOUS = "202610240001_remada_lua_cheia_capsula_bar.sql";

const db = await fullDatabase();
const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
const { one, rows, call, IMERSAO, SUNSET_CONCHA, makeSession, reserve, setStandby, uniquePrice } = fx;

const NEW_FUNCTIONS = [
  "admin_list_waitlist_entries_page(uuid,uuid,uuid,text,text,integer,integer)",
  "admin_remove_waitlist_entry(uuid,uuid,text)",
  "admin_waitlist_entry(uuid,uuid)",
  "admin_waitlist_sessions(uuid,boolean)",
  "list_public_sessions(text)",
  "register_waitlist_attempt(text,text,text)",
  "waitlist_anonymize_entries(integer)",
  "waitlist_cancel(text,text)",
  "waitlist_cancel_overview(text,text)",
  "waitlist_cancel_token(uuid)",
  "waitlist_effective_status(text,timestamp with time zone,session_status)",
  "waitlist_eligible_entries(uuid,integer)",
  "waitlist_expire_entries(integer)",
  "waitlist_join(uuid,text,text,text,integer,text,text)",
  "waitlist_mark_conversions(integer)",
  "waitlist_skip_pending_notifications(uuid,text)",
  "waitlist_token_hash(text)",
  "waitlist_wave_size(integer)",
];

const NEW_TABLES = [
  "waitlist_entries",
  "waitlist_notification_attempts",
  "waitlist_notifications",
  "waitlist_openings",
  "waitlist_throttle",
  "waitlist_throttle_secret",
];

const PUBLIC_FUNCTIONS = new Set(["list_public_sessions(text)"]);
const SERVER_FUNCTIONS = new Set([
  "waitlist_join(uuid,text,text,text,integer,text,text)",
  "waitlist_cancel_overview(text,text)",
  "waitlist_cancel(text,text)",
  "admin_waitlist_sessions(uuid,boolean)",
  "admin_list_waitlist_entries_page(uuid,uuid,uuid,text,text,integer,integer)",
  "admin_waitlist_entry(uuid,uuid)",
  "admin_remove_waitlist_entry(uuid,uuid,text)",
]);

const PREFLIGHT = readFileSync(new URL("../supabase/diagnostics/waitlist_foundation_preflight.sql", import.meta.url), "utf8");
const POSTCHECK = readFileSync(new URL("../supabase/diagnostics/waitlist_foundation_postcheck.sql", import.meta.url), "utf8");
const ROLLBACK = readFileSync(new URL("../supabase/rollback/202610250001_waitlist_foundation.rollback.sql", import.meta.url), "utf8");

type Check = { check_name: string; result: string; status: string };

async function report(database: { query: (sql: string) => Promise<{ rows: unknown[] }> }, sql: string) {
  const result = (await database.query(sql)).rows as Check[];
  return new Map(result.map((row) => [row.check_name, row]));
}

// --- Cenários -----------------------------------------------------------------

let emailSequence = 0;

function nextEmail(prefix = "espera") {
  emailSequence += 1;
  return `${prefix}${emailSequence}@teste.local`;
}

type Person = { fullName: string; email: string; phone: string };

function person(overrides: Partial<Person> = {}): Person {
  emailSequence += 1;
  return {
    fullName: `Lia Esperança ${emailSequence}`,
    email: nextEmail(),
    phone: `+55619${String(80_000_000 + emailSequence)}`,
    ...overrides,
  };
}

/** Turma aberta e futura, esgotada por reservas pagas. */
async function soldOutSession(options: { capacity?: number; experienceId?: string; startsIn?: string } = {}) {
  const capacity = options.capacity ?? 2;
  const session = await makeSession(options.experienceId ?? IMERSAO.id, { price: uniquePrice(), capacity, startsIn: options.startsIn });
  const booking = await reserve(session, capacity);
  return { session, booking, capacity };
}

async function join(sessionId: string, who: Person, quantity = 1, options: { client?: string | null; trap?: string } = {}) {
  return call(`public.waitlist_join($1::uuid, $2, $3, $4, $5, $6, $7)`, [
    sessionId, who.fullName, who.email, who.phone, quantity, options.client ?? null, options.trap ?? "",
  ]);
}

async function entriesOf(sessionId: string) {
  return rows(`select * from public.waitlist_entries where session_id = $1::uuid order by created_at, id`, [sessionId]);
}

async function entryOf(sessionId: string, email: string) {
  return one(`select * from public.waitlist_entries where session_id = $1::uuid and email = $2 order by created_at desc limit 1`, [sessionId, email]);
}

async function tokenOf(entryId: string) {
  return call(`public.waitlist_cancel_token($1::uuid)`, [entryId]) as Promise<string>;
}

async function resetThrottle() {
  await db.exec(`delete from public.waitlist_throttle`);
}

// ===========================================================================
// 1. A migration
// ===========================================================================

test("migration: aditiva — não substitui o corpo de nenhuma função existente", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  const snapshot = async () => (await before.query<{ name: string; src: string }>(
    `select p.oid::regprocedure::text as name, md5(p.prosrc) as src from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`,
  )).rows;
  const old = await snapshot();
  await applyMigration(before, MIGRATION);
  const current = new Map((await snapshot()).map((row) => [row.name, row.src]));
  for (const row of old) assert.equal(current.get(row.name), row.src, `${row.name} não pode mudar`);
  const created = [...current.keys()].filter((name) => !old.some((row) => row.name === name)).sort();
  assert.deepEqual(created, NEW_FUNCTIONS);

  // Idempotente: aplicar de novo não falha e não troca o segredo.
  const secret = (await before.query<{ s: string }>(`select encode(secret, 'hex') as s from public.waitlist_throttle_secret`)).rows;
  await applyMigration(before, MIGRATION);
  assert.deepEqual((await before.query(`select encode(secret, 'hex') as s from public.waitlist_throttle_secret`)).rows, secret);
  assert.equal(secret.length, 1);
  assert.equal(secret[0].s.length, 64);
  await before.close();
});

test("migration: nenhuma reserva, sessão, pagamento, Stand-by ou trigger existente muda", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  const local = await rescheduleFixtures(async (sql, params = []) => (await before.query(sql, params)).rows as Row[]);
  const session = await local.makeSession(local.IMERSAO.id, { price: local.uniquePrice(), capacity: 4 });
  await local.reserve(session, 2);
  const parked = await local.reserve(session, 1);
  await local.setStandby(parked.id);
  const digest = async () => (await before.query(
    `select md5(string_agg(t, '|' order by t)) as h from (
       select r::text as t from public.reservations r
       union all select s::text from public.sessions s
       union all select e::text from public.experiences e
       union all select p::text from public.payment_events p
       union all select sb::text from public.reservation_standby sb
       union all select c::text from public.reservation_session_changes c
       union all select m::text from public.reservation_reschedule_emails m) x`,
  )).rows[0];
  const triggers = async () => (await before.query(
    `select tgrelid::regclass::text || '.' || tgname as t from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where not tgisinternal and c.relname not like 'waitlist\\_%' order by 1`,
  )).rows;
  const oldDigest = await digest();
  const oldTriggers = await triggers();
  await applyMigration(before, MIGRATION);
  assert.deepEqual(await digest(), oldDigest);
  assert.deepEqual(await triggers(), oldTriggers, "nenhuma trigger nova em tabela existente");
  await before.close();
});

test("acesso: tabelas fechadas para a API, inclusive para a service role", async () => {
  for (const table of NEW_TABLES) {
    const row = await one(
      `select c.relrowsecurity as rls, (select count(*)::int from pg_policy where polrelid = c.oid) as policies,
              exists (
                select 1 from unnest(array['anon', 'authenticated', 'service_role']) r(role),
                              unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p(priv)
                where has_table_privilege(r.role, c.oid, p.priv)
              ) as api
       from pg_class c where c.oid = $1::regclass`,
      [`public.${table}`],
    );
    assert.deepEqual([row.rls, row.policies, row.api], [true, 0, false], table);
  }
});

test("acesso: com os privilégios padrão do Supabase, nada novo fica aberto à API", async () => {
  // O Supabase concede tudo a anon, authenticated e service_role em toda tabela,
  // sequência e função nova do schema public. O PGlite não faz isso sozinho: aqui
  // o padrão é ligado antes da migration, como em produção.
  const before = await fullDatabase({ until: PREVIOUS });
  await before.exec(`
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `);
  await applyMigration(before, MIGRATION);
  const opened = (await before.query<{ name: string }>(
    `select c.relname as name from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relname like 'waitlist\\_%' and c.relkind in ('r', 'S')
       and exists (
         select 1 from unnest(array['anon', 'authenticated', 'service_role']) r(role)
         where (c.relkind = 'r' and (has_table_privilege(r.role, c.oid, 'SELECT') or has_table_privilege(r.role, c.oid, 'INSERT')
                                     or has_table_privilege(r.role, c.oid, 'UPDATE') or has_table_privilege(r.role, c.oid, 'DELETE')))
            or (c.relkind = 'S' and (has_sequence_privilege(r.role, c.oid, 'USAGE') or has_sequence_privilege(r.role, c.oid, 'UPDATE')))
       )
     order by 1`,
  )).rows.map((row) => row.name);
  assert.deepEqual(opened, []);
  const executable = (await before.query<{ name: string; anon: boolean; service: boolean }>(
    `select p.oid::regprocedure::text as name, has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
            has_function_privilege('service_role', p.oid, 'EXECUTE') as service
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.oid::regprocedure::text = any($1::text[])`,
    [NEW_FUNCTIONS],
  )).rows;
  assert.equal(executable.length, NEW_FUNCTIONS.length);
  for (const row of executable) {
    const expected = PUBLIC_FUNCTIONS.has(row.name) ? [true, true] : SERVER_FUNCTIONS.has(row.name) ? [false, true] : [false, false];
    assert.deepEqual([row.anon, row.service], expected, row.name);
  }
  const post = await report(before, POSTCHECK);
  assert.equal(post.get("SEQUENCIA_DA_FILA_FECHADA")?.status, "OK");
  assert.equal(post.get("TABELAS_FECHADAS")?.status, "OK");
  assert.equal(post.get("PERMISSOES_DAS_FUNCOES")?.status, "OK");
  await before.close();
});

test("acesso: pública só a listagem; cliente e painel só pela service role; apoio para ninguém", async () => {
  for (const fn of NEW_FUNCTIONS) {
    const row = await one(
      `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated,
              has_function_privilege('service_role', $1, 'EXECUTE') as service,
              p.prosecdef as definer, p.proconfig as config
       from pg_proc p where p.oid = $1::regprocedure`,
      [`public.${fn}`],
    );
    const expected = PUBLIC_FUNCTIONS.has(fn) ? [true, true, true] : SERVER_FUNCTIONS.has(fn) ? [false, false, true] : [false, false, false];
    assert.deepEqual([row.anon, row.authenticated, row.service], expected, fn);
    assert.equal(row.definer, true, fn);
    assert.ok((row.config as string[]).some((entry) => entry.startsWith("search_path=")), fn);
  }
  // As leituras públicas de sempre continuam como eram.
  for (const fn of ["list_open_sessions(text)", "get_booking_session(uuid)", "available_spots(uuid)"]) {
    const row = await one(`select has_function_privilege('anon', $1, 'EXECUTE') as anon`, [`public.${fn}`]);
    assert.equal(row.anon, true, fn);
  }
});

// ===========================================================================
// 2. Turmas públicas, inclusive as esgotadas
// ===========================================================================

test("list_public_sessions: as turmas de list_open_sessions, mais as esgotadas, com as mesmas colunas", async () => {
  const columns = async (fn: string) => (await rows(
    `select unnest(proargnames[2:]) as name from pg_proc where oid = $1::regprocedure`, [`public.${fn}`],
  )).map((row) => row.name);
  const open = await columns("list_open_sessions(text)");
  assert.deepEqual(await columns("list_public_sessions(text)"), [...open, "sold_out"]);

  const withSpots = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 6 });
  await reserve(withSpots, 2);
  const { session: full } = await soldOutSession();

  const listed = await rows(`select * from public.list_public_sessions('imersao-paranoa')`);
  const openRows = await rows(`select * from public.list_open_sessions('imersao-paranoa')`);
  const available = listed.filter((row) => !row.sold_out).map((row) => {
    const copy = { ...row };
    delete copy.sold_out;
    return copy;
  });
  assert.deepEqual(
    available.sort((a, b) => String(a.id).localeCompare(String(b.id))),
    openRows.sort((a, b) => String(a.id).localeCompare(String(b.id))),
    "com vaga, as duas listagens são idênticas",
  );
  assert.deepEqual(listed.find((row) => row.id === withSpots), { ...openRows.find((row) => row.id === withSpots), sold_out: false });
  const soldOut = listed.find((row) => row.id === full);
  assert.ok(soldOut, "a turma esgotada aparece");
  assert.equal(soldOut.sold_out, true);
  assert.equal(soldOut.remaining_spots, 0);
  assert.ok(!openRows.some((row) => row.id === full), "list_open_sessions continua sem ela");

  // Reservar continua impossível: get_booking_session não muda.
  assert.equal((await rows(`select * from public.get_booking_session($1::uuid)`, [full])).length, 0);
  await assert.rejects(
    call(`public.create_pre_reservation($1::uuid, 'Pessoa Teste', '52998224725', '+5561999999999', 'x@y.z', 1, null, gen_random_uuid())`, [full]),
    /INSUFFICIENT_SPOTS/,
  );
});

test("list_public_sessions: as mesmas regras de publicação, status e data", async () => {
  const closed = await makeSession(IMERSAO.id, { price: uniquePrice() });
  await db.query(`update public.sessions set status = 'CLOSED' where id = $1::uuid`, [closed]);
  const cancelled = await makeSession(IMERSAO.id, { price: uniquePrice() });
  await db.query(`update public.sessions set status = 'CANCELLED' where id = $1::uuid`, [cancelled]);
  const past = await makeSession(IMERSAO.id, { price: uniquePrice(), startsIn: "-2 days" });
  const ids = (await rows(`select id from public.list_public_sessions('imersao-paranoa')`)).map((row) => row.id);
  for (const hidden of [closed, cancelled, past]) assert.ok(!ids.includes(hidden), hidden);
  assert.equal((await rows(`select * from public.list_public_sessions('nao-existe')`)).length, 0);
});

test("list_public_sessions: pré-reserva válida esgota; vencida ou em Stand-by devolve a vaga", async () => {
  const session = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 2 });
  const held = await call(
    `public.create_pre_reservation($1::uuid, 'Pessoa Retida', '52998224725', '+5561999999998', 'retida@teste.local', 2, null, gen_random_uuid())`,
    [session],
  );
  const state = async () => one(`select remaining_spots, sold_out from public.list_public_sessions('imersao-paranoa') where id = $1::uuid`, [session]);
  assert.deepEqual(await state(), { remaining_spots: 0, sold_out: true });
  await db.query(`update public.reservations set created_at = now() - interval '3 hours', expires_at = now() - interval '1 minute' where id = $1::uuid`, [held.reservationId]);
  assert.deepEqual(await state(), { remaining_spots: 2, sold_out: false });

  const { session: full, booking } = await soldOutSession();
  await setStandby(booking.id);
  assert.deepEqual(
    await one(`select remaining_spots, sold_out from public.list_public_sessions('imersao-paranoa') where id = $1::uuid`, [full]),
    { remaining_spots: 2, sold_out: false },
  );
});

// ===========================================================================
// 3. Inscrição
// ===========================================================================

test("inscrição: só em turma com zero vagas (D4)", async () => {
  const session = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 3 });
  await reserve(session, 2);
  assert.deepEqual(await join(session, person()), { status: "NOT_SOLD_OUT", remainingSpots: 1 });
  assert.equal((await entriesOf(session)).length, 0);
});

test("inscrição: turma indisponível — inexistente, fechada, cancelada, arquivada, iniciada ou não publicada", async () => {
  const unavailable = async (sessionId: string) => assert.deepEqual(await join(sessionId, person()), { status: "SESSION_UNAVAILABLE" }, sessionId);
  await unavailable("00000000-0000-4000-8000-000000000000");
  for (const status of ["CLOSED", "CANCELLED", "ARCHIVED"]) {
    const { session } = await soldOutSession();
    await db.query(`update public.sessions set status = $2::public.session_status where id = $1::uuid`, [session, status]);
    await unavailable(session);
  }
  const { session: started } = await soldOutSession();
  await db.query(`update public.sessions set starts_at = now() - interval '1 minute' where id = $1::uuid`, [started]);
  await unavailable(started);

  const sunrise = await one(`select id from public.experiences where slug = 'remada-nascer-do-sol'`);
  const draftSession = await makeSession(sunrise.id, { price: uniquePrice(), capacity: 1 });
  await reserve(draftSession, 1);
  await db.query(`update public.experiences set status = 'DRAFT' where id = $1::uuid`, [sunrise.id]);
  try {
    await unavailable(draftSession);
  } finally {
    await db.query(`update public.experiences set status = 'PUBLISHED' where id = $1::uuid`, [sunrise.id]);
  }
});

test("inscrição: valida nome, e-mail, WhatsApp e quantidade antes de gravar", async () => {
  const { session } = await soldOutSession({ capacity: 4 });
  const cases: Array<[Partial<Person>, number, string]> = [
    [{ fullName: "Ana" }, 1, "fullName"],
    [{ fullName: "Anasemsobrenome" }, 1, "fullName"],
    [{ fullName: `Ana ${"x".repeat(130)}` }, 1, "fullName"],
    [{ email: "sem-arroba" }, 1, "email"],
    [{ email: `${"a".repeat(250)}@t.co` }, 1, "email"],
    [{ phone: "61999999999" }, 1, "phone"],
    [{ phone: "+5561999" }, 1, "phone"],
    [{}, 0, "quantity"],
    [{}, 21, "quantity"],
    [{}, 5, "quantity"], // maior que a turma inteira: nunca seria avisado
  ];
  for (const [overrides, quantity, field] of cases) {
    assert.deepEqual(await join(session, person(overrides), quantity), { status: "INVALID", field }, JSON.stringify({ overrides, quantity }));
  }
  assert.equal((await entriesOf(session)).length, 0);
  assert.equal((await join(session, person(), 4)).status, "ACCEPTED", "a turma inteira cabe");
});

test("inscrição: grava a inscrição normalizada e a confirmação na fila, sem enviar", async () => {
  const { session } = await soldOutSession();
  const who = person({ fullName: "  Lia   Mar   Azul ", email: "  Lia.Azul@Teste.Local " });
  assert.deepEqual(await join(session, who, 2), { status: "ACCEPTED" });

  const [entry] = await entriesOf(session);
  assert.equal(entry.status, "ACTIVE");
  assert.equal(entry.full_name, "Lia Mar Azul");
  assert.equal(entry.email, "lia.azul@teste.local");
  assert.equal(entry.quantity, 2);
  assert.equal(entry.notifications_sent, 0);
  assert.match(entry.cancel_token_hash, /^[0-9a-f]{64}$/);

  const queued = await rows(`select * from public.waitlist_notifications where entry_id = $1::uuid`, [entry.id]);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, "JOINED");
  assert.equal(queued[0].status, "QUEUED");
  assert.equal(queued[0].attempts, 0);
  assert.equal(queued[0].frozen_message, null);
  assert.equal((await one(`select count(*)::int as n from public.waitlist_notification_attempts`)).n, 0, "ninguém tentou enviar");
});

test("inscrição: o mesmo e-mail na mesma turma não duplica e recebe a mesma resposta", async () => {
  const { session } = await soldOutSession({ capacity: 3 });
  const who = person();
  const first = await join(session, who, 1);
  const again = await join(session, { ...who, email: who.email.toUpperCase(), fullName: "Outro Nome Qualquer" }, 3);
  assert.deepEqual(again, first, "a resposta não revela que o e-mail já estava inscrito");
  const entries = await entriesOf(session);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].quantity, 1, "a segunda tentativa não altera a inscrição");
  assert.equal((await one(`select count(*)::int as n from public.waitlist_notifications where entry_id = $1::uuid`, [entries[0].id])).n, 1, "uma confirmação só");

  // Outra turma, mesmo e-mail: outra inscrição.
  const { session: other } = await soldOutSession();
  assert.equal((await join(other, who)).status, "ACCEPTED");
  assert.equal((await entriesOf(other)).length, 1);

  // A barreira final é o índice único: nem uma escrita direta passa.
  await assert.rejects(
    db.query(`insert into public.waitlist_entries (session_id, full_name, email, phone, quantity, cancel_token_hash) values ($1::uuid, 'Dup Licada', $2, '+5561999999999', 1, repeat('a', 64))`, [session, who.email]),
    /waitlist_entries_active_email_key/,
  );
});

test("inscrição: depois de cancelar, a pessoa pode entrar de novo", async () => {
  const { session } = await soldOutSession();
  const who = person();
  await join(session, who);
  const first = await entryOf(session, who.email);
  assert.equal((await call(`public.waitlist_cancel($1, null)`, [await tokenOf(first.id)])).status, "CANCELLED");
  assert.equal((await join(session, who)).status, "ACCEPTED");
  const entries = await entriesOf(session);
  assert.deepEqual(entries.map((entry) => entry.status), ["CANCELLED", "ACTIVE"]);
  assert.notEqual(entries[0].cancel_token_hash, entries[1].cancel_token_hash, "cada inscrição tem o próprio link");
});

test("inscrição: campo isca preenchido responde sucesso e não grava nada", async () => {
  const { session } = await soldOutSession();
  assert.deepEqual(await join(session, person(), 1, { trap: "https://spam.example" }), { status: "ACCEPTED" });
  assert.equal((await entriesOf(session)).length, 0);
});

test("inscrição: no máximo 10 inscrições ativas por e-mail e 100 por turma", async () => {
  await resetThrottle();
  const who = person();
  for (let index = 0; index < 10; index += 1) {
    const { session } = await soldOutSession({ capacity: 1 });
    if (index % 5 === 0) await resetThrottle(); // o limite por hora não é o que está em teste aqui
    assert.equal((await join(session, who)).status, "ACCEPTED", `inscrição ${index + 1}`);
  }
  await resetThrottle();
  const { session: eleventh } = await soldOutSession({ capacity: 1 });
  assert.deepEqual(await join(eleventh, who), { status: "LIMIT_REACHED" });

  const { session: crowded } = await soldOutSession({ capacity: 1 });
  for (let index = 0; index < 100; index += 1) {
    assert.equal((await join(crowded, person())).status, "ACCEPTED", `pessoa ${index + 1}`);
  }
  assert.deepEqual(await join(crowded, person()), { status: "WAITLIST_FULL" });
  assert.equal((await entriesOf(crowded)).length, 100);
  await resetThrottle();
});

test("inscrição: os tetos contam só quem ainda espera, sem depender da rotina de expiração", async () => {
  await resetThrottle();
  const who = person();
  const sessions: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const { session } = await soldOutSession({ capacity: 1 });
    if (index % 5 === 0) await resetThrottle();
    assert.equal((await join(session, who)).status, "ACCEPTED");
    sessions.push(session);
  }
  await resetThrottle();

  // Três turmas passam, uma é cancelada e uma é arquivada. Ninguém rodou
  // waitlist_expire_entries: as linhas continuam gravadas como ACTIVE.
  for (const session of sessions.slice(0, 3)) {
    await db.query(`update public.sessions set starts_at = now() - interval '1 day' where id = $1::uuid`, [session]);
  }
  await db.query(`update public.sessions set status = 'CANCELLED' where id = $1::uuid`, [sessions[3]]);
  await db.query(`update public.sessions set status = 'ARCHIVED' where id = $1::uuid`, [sessions[4]]);
  assert.equal((await one(`select count(*)::int as n from public.waitlist_entries where email = $1 and status = 'ACTIVE'`, [who.email])).n, 10);

  // Sobram 5 esperando de verdade: cabem mais 5, e a 6ª passa do teto.
  for (let index = 0; index < 5; index += 1) {
    const { session } = await soldOutSession({ capacity: 1 });
    assert.equal((await join(session, who)).status, "ACCEPTED", `nova inscrição ${index + 1}`);
  }
  await resetThrottle();
  const { session: extra } = await soldOutSession({ capacity: 1 });
  assert.deepEqual(await join(extra, who), { status: "LIMIT_REACHED" });

  // Cancelar e remover também liberam lugar no teto.
  const latest = await entryOf(sessions[9], who.email);
  await call(`public.waitlist_cancel($1, null)`, [await tokenOf(latest.id)]);
  assert.equal((await join(extra, who)).status, "ACCEPTED");
  await resetThrottle();
});

test("inscrição: não pede lock na turma nem escreve em reservas", async () => {
  const { session } = await soldOutSession();
  const reservations = async () => (await one(`select md5(string_agg(r::text, '|' order by r.id)) as h from public.reservations r`)).h;
  const sessionRow = async () => (await one(`select s::text as t from public.sessions s where id = $1::uuid`, [session])).t;
  const before = [await reservations(), await sessionRow()];
  await join(session, person());
  assert.deepEqual([await reservations(), await sessionRow()], before);
  const source = readFileSync(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), "utf8");
  assert.doesNotMatch(source, /from public\.sessions[^;]*for (update|share|no key update|key share)/i, "nenhuma função da lista pede lock em sessões");
  assert.doesNotMatch(source, /(insert into|update|delete from) public\.(reservations|sessions|payment_events|reservation_standby)\b/i);
});

// ===========================================================================
// 4. Limite de tentativas
// ===========================================================================

test("limite: 30 inscrições por origem a cada hora; a barrada também conta", async () => {
  await resetThrottle();
  const { session } = await soldOutSession({ capacity: 3 });
  for (let index = 0; index < 30; index += 1) {
    assert.equal((await join(session, person(), 1, { client: "203.0.113.10" })).status, "ACCEPTED");
  }
  const blocked = await join(session, person(), 1, { client: "203.0.113.10" });
  assert.equal(blocked.status, "RATE_LIMITED");
  assert.ok(blocked.retryAfterSeconds > 3000 && blocked.retryAfterSeconds <= 3600, String(blocked.retryAfterSeconds));
  assert.equal((await entriesOf(session)).length, 30, "a tentativa barrada não grava");

  // Outra origem não é afetada; sem origem, só vale o limite do e-mail.
  assert.equal((await join(session, person(), 1, { client: "203.0.113.11" })).status, "ACCEPTED");
  assert.equal((await join(session, person(), 1, { client: null })).status, "ACCEPTED");

  // Passada a janela, recomeça.
  await db.exec(`update public.waitlist_throttle set window_started_at = now() - interval '61 minutes'`);
  assert.equal((await join(session, person(), 1, { client: "203.0.113.10" })).status, "ACCEPTED");
  await resetThrottle();
});

test("limite: 6 tentativas por e-mail a cada hora, de qualquer origem — inclusive inválidas", async () => {
  await resetThrottle();
  const { session } = await soldOutSession();
  const email = nextEmail("caixa");
  for (let index = 0; index < 6; index += 1) {
    const result = await join(session, person({ email, phone: "invalido" }), 1, { client: `198.51.100.${index}` });
    assert.deepEqual(result, { status: "INVALID", field: "phone" });
  }
  const blocked = await join(session, person({ email }), 1, { client: "198.51.100.99" });
  assert.equal(blocked.status, "RATE_LIMITED");
  assert.equal((await entriesOf(session)).length, 0);
  await resetThrottle();
});

test("limite: baldes guardados em HMAC, sem endereço nem e-mail legíveis", async () => {
  await resetThrottle();
  const { session } = await soldOutSession();
  const who = person({ email: "visivel@teste.local" });
  await join(session, who, 1, { client: "192.0.2.77" });
  const buckets = await rows(`select bucket from public.waitlist_throttle order by bucket`);
  assert.equal(buckets.length, 2);
  for (const { bucket } of buckets) {
    assert.match(bucket, /^(signup-client|signup-email):[0-9a-f]{64}$/);
    assert.ok(!bucket.includes("192.0.2.77") && !bucket.includes("visivel"), bucket);
  }
  await assert.rejects(db.query(`insert into public.waitlist_throttle (bucket, attempts) values ('signup-email:texto', 1)`), /waitlist_throttle_bucket_format/);
  await resetThrottle();
});

test("limite: cancelamento tem balde próprio, 30 por origem a cada 15 minutos", async () => {
  await resetThrottle();
  for (let index = 0; index < 30; index += 1) {
    assert.equal((await call(`public.waitlist_cancel_overview($1, '192.0.2.200')`, ["f".repeat(64)])).status, "NOT_FOUND");
  }
  const blocked = await call(`public.waitlist_cancel($1, '192.0.2.200')`, ["f".repeat(64)]);
  assert.equal(blocked.status, "RATE_LIMITED");
  assert.ok(blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= 900);
  // Não consome as inscrições da mesma origem.
  const { session } = await soldOutSession();
  assert.equal((await join(session, person(), 1, { client: "192.0.2.200" })).status, "ACCEPTED");
  await assert.rejects(call(`public.register_waitlist_attempt('OUTRA', null, null)`), /WAITLIST_INVALID_ACTION/);
  await resetThrottle();
});

// ===========================================================================
// 5. Cancelamento pelo link
// ===========================================================================

test("cancelamento: ver e cancelar são dois passos; a leitura não traz contato nem sobrenome", async () => {
  const { session } = await soldOutSession({ capacity: 3 });
  const who = person({ fullName: "Marina Sobrenome Secreto" });
  await join(session, who, 3);
  const entry = await entryOf(session, who.email);
  const token = await tokenOf(entry.id);
  assert.match(token, /^[0-9a-f]{64}$/);

  const overview = await call(`public.waitlist_cancel_overview($1, null)`, [token]);
  assert.equal(overview.status, "ACTIVE");
  assert.equal(overview.firstName, "Marina");
  assert.equal(overview.quantity, 3);
  assert.equal(overview.session.experienceTitle, IMERSAO.title);
  const text = JSON.stringify(overview);
  for (const leaked of [who.email, who.phone, "Sobrenome", "Secreto", entry.id, entry.cancel_token_hash]) assert.ok(!text.includes(leaked), leaked);
  assert.equal((await entryOf(session, who.email)).status, "ACTIVE", "ler não cancela");

  // Maiúsculas e espaços vindos de um cliente de e-mail não atrapalham.
  assert.deepEqual(await call(`public.waitlist_cancel($1, null)`, [`  ${token.toUpperCase()} `]), { status: "CANCELLED" });
  const cancelled = await entryOf(session, who.email);
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelled.closed_reason, "CUSTOMER");
  assert.ok(cancelled.closed_at);

  assert.deepEqual(await call(`public.waitlist_cancel($1, null)`, [token]), { status: "ALREADY_CLOSED", state: "CANCELLED" }, "idempotente");
  assert.equal((await call(`public.waitlist_cancel_overview($1, null)`, [token])).status, "CANCELLED");
});

test("cancelamento: a confirmação ainda na fila é descartada", async () => {
  const { session } = await soldOutSession();
  const who = person();
  await join(session, who);
  const entry = await entryOf(session, who.email);
  await call(`public.waitlist_cancel($1, null)`, [await tokenOf(entry.id)]);
  const [notification] = await rows(`select * from public.waitlist_notifications where entry_id = $1::uuid`, [entry.id]);
  assert.equal(notification.status, "SKIPPED");
  assert.equal(notification.skip_reason, "ENTRY_CLOSED");
  assert.ok(notification.skipped_at);
});

test("cancelamento: token inválido, desconhecido ou de outra inscrição não revela nada", async () => {
  const { session } = await soldOutSession({ capacity: 3 });
  const a = person();
  const b = person();
  await join(session, a);
  await join(session, b);
  for (const token of ["", "abc", "z".repeat(64), "0".repeat(64), null]) {
    assert.deepEqual(await call(`public.waitlist_cancel($1, null)`, [token]), { status: "NOT_FOUND" }, String(token));
    assert.deepEqual(await call(`public.waitlist_cancel_overview($1, null)`, [token]), { status: "NOT_FOUND" }, String(token));
  }
  const entryA = await entryOf(session, a.email);
  await call(`public.waitlist_cancel($1, null)`, [await tokenOf(entryA.id)]);
  assert.equal((await entryOf(session, b.email)).status, "ACTIVE", "o link de uma não cancela a outra");
});

test("cancelamento: o token não é guardado; só o hash dele", async () => {
  const { session } = await soldOutSession();
  const who = person();
  await join(session, who);
  const entry = await entryOf(session, who.email);
  const token = await tokenOf(entry.id);
  const everything = await one(
    `select (select string_agg(e::text, '|') from public.waitlist_entries e) || (select string_agg(n::text, '|') from public.waitlist_notifications n) as t`,
  );
  assert.ok(!String(everything.t).includes(token));
  assert.equal(entry.cancel_token_hash, await call(`public.waitlist_token_hash($1)`, [token]));
  assert.equal(await tokenOf(entry.id), token, "recalculável para montar o e-mail");
});

test("cancelamento: depois do início da turma a inscrição já está encerrada", async () => {
  const { session } = await soldOutSession();
  const who = person();
  await join(session, who);
  const entry = await entryOf(session, who.email);
  await db.query(`update public.sessions set starts_at = now() - interval '5 minutes' where id = $1::uuid`, [session]);
  const token = await tokenOf(entry.id);
  assert.equal((await call(`public.waitlist_cancel_overview($1, null)`, [token])).status, "EXPIRED");
  assert.deepEqual(await call(`public.waitlist_cancel($1, null)`, [token]), { status: "ALREADY_CLOSED", state: "EXPIRED" });
  const closed = await entryOf(session, who.email);
  assert.equal(closed.status, "EXPIRED");
  assert.equal(closed.closed_reason, "SESSION_STARTED");
});

// ===========================================================================
// 6. Painel
// ===========================================================================

test("painel: só ADMIN ou OPERATOR ativos", async () => {
  const { session } = await soldOutSession();
  await join(session, person());
  const entry = (await entriesOf(session))[0];
  for (const actor of [INSTRUCTOR, STRANGER]) {
    await assert.rejects(call(`public.admin_waitlist_sessions($1::uuid, false)`, [actor]), /ADMIN_FORBIDDEN/);
    await assert.rejects(call(`public.admin_list_waitlist_entries_page($1::uuid, null, null, null, null, 25, 0)`, [actor]), /ADMIN_FORBIDDEN/);
    await assert.rejects(call(`public.admin_waitlist_entry($1::uuid, $2::uuid)`, [actor, entry.id]), /ADMIN_FORBIDDEN/);
    await assert.rejects(call(`public.admin_remove_waitlist_entry($1::uuid, $2::uuid, 'Motivo válido')`, [actor, entry.id]), /ADMIN_FORBIDDEN/);
  }
  assert.equal((await entriesOf(session))[0].status, "ACTIVE");
});

test("painel: lista na ordem da fila, com posição, filtros, busca e totais", async () => {
  const { session } = await soldOutSession({ capacity: 4, experienceId: SUNSET_CONCHA.id, startsIn: "40 days" });
  const people = [person({ fullName: "Primeira Pessoa Fila" }), person({ fullName: "Segunda Pessoa Fila" }), person({ fullName: "Terceira Pessoa Fila" })];
  for (const [index, who] of people.entries()) await join(session, who, index + 1);
  const second = await entryOf(session, people[1].email);
  await call(`public.admin_remove_waitlist_entry($1::uuid, $2::uuid, 'Pediu por telefone')`, [ADMIN, second.id]);

  const page = await call(`public.admin_list_waitlist_entries_page($1::uuid, $2::uuid, null, null, null, 25, 0)`, [ADMIN, session]);
  assert.equal(page.total, 3);
  assert.equal(page.totalParticipants, 6);
  assert.deepEqual(page.items.map((item: Row) => [item.fullName, item.status, item.position]), [
    ["Primeira Pessoa Fila", "ACTIVE", 1],
    ["Segunda Pessoa Fila", "REMOVED", null],
    ["Terceira Pessoa Fila", "ACTIVE", 2],
  ]);
  const first = page.items[0];
  assert.equal(first.experienceTitle, SUNSET_CONCHA.title);
  assert.equal(first.baseName, SUNSET_CONCHA.base_name);
  assert.equal(first.email, people[0].email);
  assert.equal(first.phone, people[0].phone);
  assert.equal(first.quantity, 1);
  assert.ok(first.createdAt);
  for (const hidden of ["cancel_token_hash", "cancelTokenHash", "frozen_message"]) assert.ok(!(hidden in first), hidden);

  const active = await call(`public.admin_list_waitlist_entries_page($1::uuid, $2::uuid, null, 'active', null, 25, 0)`, [ADMIN, session]);
  assert.equal(active.total, 2);
  const byBase = await call(`public.admin_list_waitlist_entries_page($1::uuid, null, $2::uuid, null, 'Terceira', 25, 0)`, [ADMIN, SUNSET_CONCHA.base_id]);
  assert.deepEqual(byBase.items.map((item: Row) => item.fullName), ["Terceira Pessoa Fila"]);
  const byPhone = await call(`public.admin_list_waitlist_entries_page($1::uuid, null, null, null, $2, 25, 0)`, [ADMIN, people[2].phone.slice(-6)]);
  assert.deepEqual(byPhone.items.map((item: Row) => item.fullName), ["Terceira Pessoa Fila"]);
  const literal = await call(`public.admin_list_waitlist_entries_page($1::uuid, $2::uuid, null, null, '%', 25, 0)`, [ADMIN, session]);
  assert.equal(literal.total, 0, "% é comparado literalmente");

  const paged = await call(`public.admin_list_waitlist_entries_page($1::uuid, $2::uuid, null, null, null, 2, 2)`, [ADMIN, session]);
  assert.deepEqual([paged.total, paged.items.length, paged.limit, paged.offset], [3, 1, 2, 2]);

  await assert.rejects(call(`public.admin_list_waitlist_entries_page($1::uuid, null, null, 'QUALQUER', null, 25, 0)`, [ADMIN]), /WAITLIST_INVALID_FILTER/);
  await assert.rejects(call(`public.admin_list_waitlist_entries_page($1::uuid, null, null, null, $2, 25, 0)`, [ADMIN, "x".repeat(121)]), /WAITLIST_INVALID_FILTER/);
});

test("painel: turma que já começou aparece encerrada, antes de qualquer rotina gravar", async () => {
  const { session } = await soldOutSession();
  const who = person();
  await join(session, who);
  await db.query(`update public.sessions set starts_at = now() - interval '1 hour' where id = $1::uuid`, [session]);
  const page = await call(`public.admin_list_waitlist_entries_page($1::uuid, $2::uuid, null, null, null, 25, 0)`, [ADMIN, session]);
  assert.equal(page.items[0].status, "EXPIRED");
  assert.equal(page.items[0].position, null);
  assert.equal((await entryOf(session, who.email)).status, "ACTIVE", "o status gravado só muda com a rotina");

  const upcoming = await call(`public.admin_waitlist_sessions($1::uuid, false)`, [ADMIN]);
  assert.ok(!upcoming.some((item: Row) => item.sessionId === session));
  const all = await call(`public.admin_waitlist_sessions($1::uuid, true)`, [ADMIN]);
  const listed = all.find((item: Row) => item.sessionId === session);
  assert.deepEqual([listed.activeEntries, listed.totalEntries], [0, 1]);
});

test("painel: resumo por turma com inscrições e pessoas esperando", async () => {
  const { session, capacity } = await soldOutSession({ capacity: 5 });
  await join(session, person(), 2);
  await join(session, person(), 3);
  const summary = (await call(`public.admin_waitlist_sessions($1::uuid, false)`, [ADMIN])).find((item: Row) => item.sessionId === session);
  assert.equal(summary.activeEntries, 2);
  assert.equal(summary.activeParticipants, 5);
  assert.equal(summary.totalEntries, 2);
  assert.equal(summary.remainingSpots, 0);
  assert.equal(summary.capacity, capacity);
  assert.equal(summary.experienceTitle, IMERSAO.title);
});

test("painel: remover exige motivo, é idempotente e fica na auditoria sem dado pessoal", async () => {
  const { session } = await soldOutSession();
  const who = person();
  await join(session, who);
  const entry = await entryOf(session, who.email);
  for (const reason of ["", "  ", "ab", "x".repeat(501)]) {
    await assert.rejects(call(`public.admin_remove_waitlist_entry($1::uuid, $2::uuid, $3)`, [ADMIN, entry.id, reason]), /WAITLIST_INVALID_REASON/);
  }
  await assert.rejects(call(`public.admin_remove_waitlist_entry($1::uuid, gen_random_uuid(), 'Motivo válido')`, [ADMIN]), /WAITLIST_ENTRY_NOT_FOUND/);

  assert.deepEqual(await call(`public.admin_remove_waitlist_entry($1::uuid, $2::uuid, ' Inscrição de teste ')`, [ADMIN, entry.id]), { removed: true, status: "REMOVED" });
  assert.deepEqual(await call(`public.admin_remove_waitlist_entry($1::uuid, $2::uuid, 'De novo')`, [ADMIN, entry.id]), { removed: false, status: "REMOVED" });

  const removed = await entryOf(session, who.email);
  assert.equal(removed.closed_reason, "ADMIN");
  const notification = await one(`select status, skip_reason from public.waitlist_notifications where entry_id = $1::uuid`, [entry.id]);
  assert.deepEqual(notification, { status: "SKIPPED", skip_reason: "ENTRY_CLOSED" });

  const audit = await rows(`select * from public.admin_audit_log where entity_type = 'waitlist_entry' and entity_id = $1::uuid`, [entry.id]);
  assert.equal(audit.length, 1, "a repetição não grava de novo");
  assert.equal(audit[0].action, "WAITLIST_ENTRY_REMOVED");
  assert.equal(audit[0].actor_user_id, ADMIN);
  assert.equal(audit[0].reason, "Inscrição de teste");
  const metadata = JSON.stringify(audit[0].metadata);
  for (const leaked of [who.email, who.phone, who.fullName]) assert.ok(!metadata.includes(leaked), leaked);

  // O link do cliente para de valer para cancelar.
  assert.deepEqual(await call(`public.waitlist_cancel($1, null)`, [await tokenOf(entry.id)]), { status: "ALREADY_CLOSED", state: "REMOVED" });
});

test("painel: detalhe com avisos, tentativas e ações da equipe — sem hash do link nem mensagem", async () => {
  const { session } = await soldOutSession();
  const who = person();
  await join(session, who);
  const entry = await entryOf(session, who.email);
  await call(`public.admin_remove_waitlist_entry($1::uuid, $2::uuid, 'Duplicada no WhatsApp')`, [ADMIN, entry.id]);
  const detail = await call(`public.admin_waitlist_entry($1::uuid, $2::uuid)`, [ADMIN, entry.id]);
  assert.equal(detail.status, "REMOVED");
  assert.equal(detail.email, who.email);
  assert.equal(detail.notifications.length, 1);
  assert.equal(detail.notifications[0].kind, "JOINED");
  assert.equal(detail.notifications[0].status, "SKIPPED");
  assert.deepEqual(detail.notifications[0].tries, []);
  assert.deepEqual(detail.events.map((event: Row) => [event.action, event.reason, event.actorName]), [["WAITLIST_ENTRY_REMOVED", "Duplicada no WhatsApp", "Admin Teste"]]);
  const text = JSON.stringify(detail);
  assert.ok(!text.includes(entry.cancel_token_hash));
  assert.ok(!text.includes("frozen"));
  assert.equal(await call(`public.admin_waitlist_entry($1::uuid, gen_random_uuid())`, [ADMIN]), null);
});

// ===========================================================================
// 7. Manutenção e régua dos avisos (preparadas)
// ===========================================================================

test("expiração: grava EXPIRED para turma iniciada, cancelada ou arquivada; o resto fica", async () => {
  const started = await soldOutSession();
  const cancelled = await soldOutSession();
  const kept = await soldOutSession();
  for (const target of [started, cancelled, kept]) await join(target.session, person());
  await db.query(`update public.sessions set starts_at = now() - interval '1 minute' where id = $1::uuid`, [started.session]);
  await db.query(`update public.sessions set status = 'CANCELLED' where id = $1::uuid`, [cancelled.session]);

  assert.ok((await call(`public.waitlist_expire_entries(1000)`)) >= 2);
  assert.deepEqual((await entriesOf(started.session)).map((entry) => [entry.status, entry.closed_reason]), [["EXPIRED", "SESSION_STARTED"]]);
  assert.deepEqual((await entriesOf(cancelled.session)).map((entry) => [entry.status, entry.closed_reason]), [["EXPIRED", "SESSION_UNAVAILABLE"]]);
  assert.deepEqual((await entriesOf(kept.session)).map((entry) => entry.status), ["ACTIVE"]);
  assert.equal(await call(`public.waitlist_expire_entries(1000)`), 0, "idempotente");
});

test("conversão: reserva paga com o mesmo e-mail, depois da inscrição, encerra a inscrição", async () => {
  const { session, booking } = await soldOutSession({ capacity: 2 });
  const who = person();
  const before = person({ email: booking.email }); // reservou antes de se inscrever: não conta
  await join(session, who);
  await join(session, before);
  // O relógio do PGlite tem resolução de milissegundo: a inscrição fica
  // claramente antes da reserva que vem a seguir.
  await db.query(`update public.waitlist_entries set created_at = now() - interval '1 minute' where email = $1`, [who.email]);
  await setStandby(booking.id); // libera as duas vagas
  const created = await call(
    `public.create_pre_reservation($1::uuid, $2, '52998224725', $3, $4, 1, null, gen_random_uuid())`,
    [session, who.fullName, who.phone, who.email.toUpperCase()],
  );
  assert.equal(await call(`public.waitlist_mark_conversions(1000)`), 0, "pré-reserva não é conversão");
  await call(`public.confirm_reservation_payment($1::uuid, 'INFINITEPAY', $2, $3, 'https://recibo.teste/1', '{}'::jsonb)`, [created.reservationId, `tx-${created.reservationId}`, created.totalCents]);
  assert.equal(await call(`public.waitlist_mark_conversions(1000)`), 1);
  const converted = await entryOf(session, who.email);
  assert.equal(converted.status, "CONVERTED");
  assert.equal(converted.converted_reservation_id, created.reservationId);
  assert.equal((await entryOf(session, before.email)).status, "ACTIVE");
});

test("retenção: 90 dias depois da turma, nome, e-mail e telefone somem (D6)", async () => {
  const old = await soldOutSession();
  const recent = await soldOutSession();
  const oldPerson = person();
  await join(old.session, oldPerson);
  await join(recent.session, person());
  await db.query(`update public.waitlist_notifications set frozen_message = '{"to":"x"}'::jsonb where entry_id in (select id from public.waitlist_entries where session_id = $1::uuid)`, [old.session]);
  await db.query(`update public.sessions set starts_at = now() - interval '91 days' where id = $1::uuid`, [old.session]);
  await db.query(`update public.sessions set starts_at = now() - interval '89 days' where id = $1::uuid`, [recent.session]);

  assert.equal(await call(`public.waitlist_anonymize_entries(1000)`), 1);
  const [anonymized] = await entriesOf(old.session);
  assert.deepEqual([anonymized.full_name, anonymized.email, anonymized.phone, anonymized.status], [null, null, null, "EXPIRED"]);
  assert.ok(anonymized.anonymized_at);
  const notification = await one(`select status, frozen_message from public.waitlist_notifications where entry_id = $1::uuid`, [anonymized.id]);
  assert.deepEqual(notification, { status: "SKIPPED", frozen_message: null });
  assert.equal((await entriesOf(recent.session))[0].anonymized_at, null);
  assert.equal(await call(`public.waitlist_anonymize_entries(1000)`), 0, "idempotente");

  const listed = (await call(`public.admin_list_waitlist_entries_page($1::uuid, $2::uuid, null, null, null, 25, 0)`, [ADMIN, old.session])).items[0];
  assert.deepEqual([listed.fullName, listed.email, listed.phone, listed.anonymized], [null, null, null, true]);
  assert.ok(!JSON.stringify(await rows(`select * from public.waitlist_entries where id = $1::uuid`, [anonymized.id])).includes(oldPerson.email));
});

test("régua: onda de até max(5, 3 × vagas), na ordem da fila, só quem cabe nas vagas (D2)", async () => {
  const sizes = [];
  for (const spots of [0, 1, 2, 3, 10]) sizes.push(await call(`public.waitlist_wave_size($1)`, [spots]));
  assert.deepEqual(sizes, [0, 5, 6, 9, 30]);
  const { session } = await soldOutSession({ capacity: 4 });
  const queue: Array<[Person, number]> = [[person(), 1], [person(), 3], [person(), 2], [person(), 1], [person(), 1], [person(), 1], [person(), 1], [person(), 4]];
  for (const [who, quantity] of queue) await join(session, who, quantity);
  const eligible = async (spots: number) => (await rows(`select * from public.waitlist_eligible_entries($1::uuid, $2)`, [session, spots])).map((row) => row.quantity);
  assert.deepEqual(await eligible(0), []);
  assert.deepEqual(await eligible(1), [1, 1, 1, 1, 1], "1 vaga: os cinco primeiros grupos de 1, na ordem");
  assert.deepEqual(await eligible(2), [1, 2, 1, 1, 1, 1], "2 vagas: até 6, e o grupo de 3 fica de fora");
  assert.deepEqual(await eligible(4), [1, 3, 2, 1, 1, 1, 1, 4]);
});

test("régua: no máximo 3 avisos por inscrição, 12 horas entre eles, nenhum com outro pendente (D3)", async () => {
  const { session } = await soldOutSession();
  const who = person();
  await join(session, who);
  const entry = await entryOf(session, who.email);
  const eligible = async () => (await rows(`select entry_id from public.waitlist_eligible_entries($1::uuid, 1)`, [session])).map((row) => row.entry_id);
  assert.deepEqual(await eligible(), [entry.id]);

  await db.query(`update public.waitlist_entries set notifications_sent = 1, last_notified_at = now() - interval '11 hours' where id = $1::uuid`, [entry.id]);
  assert.deepEqual(await eligible(), [], "menos de 12 horas desde o último aviso");
  await db.query(`update public.waitlist_entries set last_notified_at = now() - interval '12 hours 1 minute' where id = $1::uuid`, [entry.id]);
  assert.deepEqual(await eligible(), [entry.id]);
  await db.query(`update public.waitlist_entries set notifications_sent = 3 where id = $1::uuid`, [entry.id]);
  assert.deepEqual(await eligible(), [], "três avisos já enviados");

  await db.query(`update public.waitlist_entries set notifications_sent = 0, last_notified_at = null where id = $1::uuid`, [entry.id]);
  const opening = await one(`insert into public.waitlist_openings (session_id, spots_at_open) values ($1::uuid, 1) returning id`, [session]);
  await db.query(`insert into public.waitlist_notifications (entry_id, kind, opening_id, spots_at_queue) values ($1::uuid, 'SPOT_AVAILABLE', $2::uuid, 1)`, [entry.id, opening.id]);
  assert.deepEqual(await eligible(), [], "um aviso de vaga ainda pendente");
  await db.query(`delete from public.waitlist_notifications where kind = 'SPOT_AVAILABLE' and entry_id = $1::uuid`, [entry.id]);
  await db.query(`delete from public.waitlist_openings where id = $1::uuid`, [opening.id]);
});

// ===========================================================================
// 8. Integridade
// ===========================================================================

test("integridade: as constraints recusam estados impossíveis", async () => {
  const { session } = await soldOutSession();
  const who = person();
  await join(session, who);
  const entry = await entryOf(session, who.email);
  const rejects = (sql: string, params: unknown[], constraint: RegExp) => assert.rejects(db.query(sql, params), constraint);

  await rejects(`update public.waitlist_entries set closed_at = now() where id = $1::uuid`, [entry.id], /waitlist_entries_closed_consistency/);
  await rejects(`update public.waitlist_entries set status = 'CANCELLED' where id = $1::uuid`, [entry.id], /waitlist_entries_closed_consistency/);
  await rejects(`update public.waitlist_entries set status = 'OUTRO', closed_at = now() where id = $1::uuid`, [entry.id], /waitlist_entries_status_check/);
  await rejects(`update public.waitlist_entries set quantity = 21 where id = $1::uuid`, [entry.id], /waitlist_entries_quantity_range/);
  await rejects(`update public.waitlist_entries set email = 'Maiuscula@Teste.Local' where id = $1::uuid`, [entry.id], /waitlist_entries_email_format/);
  await rejects(`update public.waitlist_entries set phone = '61999999999' where id = $1::uuid`, [entry.id], /waitlist_entries_phone_format/);
  await rejects(`update public.waitlist_entries set email = null where id = $1::uuid`, [entry.id], /waitlist_entries_personal_data/);
  await rejects(
    `update public.waitlist_entries set full_name = null, email = null, phone = null, anonymized_at = now() where id = $1::uuid`,
    [entry.id], /waitlist_entries_anonymized_closed/,
  );

  const [joined] = await rows(`select * from public.waitlist_notifications where entry_id = $1::uuid`, [entry.id]);
  await rejects(`insert into public.waitlist_notifications (entry_id, kind) values ($1::uuid, 'JOINED')`, [entry.id], /waitlist_notifications_joined_key/);
  await rejects(`update public.waitlist_notifications set status = 'SENT', sent_at = now(), frozen_message = '{}'::jsonb where id = $1::uuid`, [joined.id], /waitlist_notifications_no_message_when_final/);
  await rejects(`update public.waitlist_notifications set status = 'SENT' where id = $1::uuid`, [joined.id], /waitlist_notifications_sent_consistency/);
  await rejects(`update public.waitlist_notifications set status = 'SKIPPED', skipped_at = now() where id = $1::uuid`, [joined.id], /waitlist_notifications_skipped_consistency/);
  await rejects(`update public.waitlist_notifications set last_error_code = 'erro com texto do provedor' where id = $1::uuid`, [joined.id], /waitlist_notifications_error_code_format/);
  await rejects(`insert into public.waitlist_notifications (entry_id, kind) values ($1::uuid, 'SPOT_AVAILABLE')`, [entry.id], /waitlist_notifications_opening_kind/);

  const opening = await one(`insert into public.waitlist_openings (session_id, spots_at_open) values ($1::uuid, 1) returning id`, [session]);
  await rejects(`insert into public.waitlist_openings (session_id, spots_at_open) values ($1::uuid, 1)`, [session], /waitlist_openings_open_session_key/);
  await db.query(`insert into public.waitlist_notifications (entry_id, kind, opening_id) values ($1::uuid, 'SPOT_AVAILABLE', $2::uuid)`, [entry.id, opening.id]);
  await rejects(`insert into public.waitlist_notifications (entry_id, kind, opening_id) values ($1::uuid, 'SPOT_AVAILABLE', $2::uuid)`, [entry.id, opening.id], /waitlist_notifications_opening_key/);
  await rejects(`insert into public.waitlist_notification_attempts (notification_id, attempt, generation, outcome) values ($1::uuid, 1, 1, 'TALVEZ')`, [joined.id], /waitlist_notification_attempts_outcome_check/);
  await db.query(`delete from public.waitlist_notifications where opening_id = $1::uuid`, [opening.id]);
  await db.query(`delete from public.waitlist_openings where id = $1::uuid`, [opening.id]);
});

test("integridade: a lista não impede excluir uma sessão", async () => {
  // Pela regra, só se entra em turma esgotada — que sempre tem reservas e por
  // isso é arquivada, não excluída. Ainda assim, uma exclusão nunca falha por
  // causa da lista.
  const session = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 1 });
  await db.query(
    `insert into public.waitlist_entries (session_id, full_name, email, phone, quantity, cancel_token_hash) values ($1::uuid, 'Pessoa Avulsa', 'avulsa@teste.local', '+5561999999999', 1, repeat('b', 64))`,
    [session],
  );
  await call(`public.admin_delete_session($1::uuid, $2::uuid)`, [ADMIN, session]);
  assert.equal((await rows(`select 1 from public.sessions where id = $1::uuid`, [session])).length, 0);
  assert.equal((await entriesOf(session)).length, 0);
});

test("integridade: reservar uma vaga que reabriu continua igual, com ou sem lista", async () => {
  const { session, booking } = await soldOutSession({ capacity: 2 });
  await join(session, person(), 2);
  await setStandby(booking.id);
  const created = await call(
    `public.create_pre_reservation($1::uuid, 'Quem Chegou Primeiro', '52998224725', '+5561988887777', 'primeiro@teste.local', 2, null, gen_random_uuid())`,
    [session],
  );
  assert.ok(created.reservationId, "a vaga é de quem reservar primeiro (opção A)");
  assert.equal((await one(`select sold_out from public.list_public_sessions('imersao-paranoa') where id = $1::uuid`, [session])).sold_out, true);
  assert.equal((await entriesOf(session))[0].status, "ACTIVE", "a lista não muda por causa da reserva de outra pessoa");
});

// ===========================================================================
// 9. Preflight, postcheck e rollback
// ===========================================================================

const COUNTS = ["ASSINATURA_DAS_FUNCOES_EXISTENTES", "RESERVAS_POR_STATUS", "SESSOES_POR_STATUS", "EVENTOS_DE_PAGAMENTO", "AUDITORIA"];

test("preflight e postcheck: aprovam o banco do repositório, nas duas pontas da migration", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  const local = await rescheduleFixtures(async (sql, params = []) => (await before.query(sql, params)).rows as Row[]);
  const full = await local.makeSession(local.IMERSAO.id, { price: local.uniquePrice(), capacity: 1 });
  await local.reserve(full, 1);

  const pre = await report(before, PREFLIGHT);
  for (const [name, row] of pre) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  assert.equal(pre.get("WAITLIST_FUNDACAO_PREFLIGHT_OK")?.result, "0 falha(s), 0 ponto(s) de atenção");
  assert.match(pre.get("FUNCOES_QUE_A_LISTA_ESPELHA_OU_CHAMA")!.result, /^(\w+=IDENTICA(, )?){3}$/);
  await assert.rejects(before.query(POSTCHECK), /does not exist/, "antes da migration o postcheck falha, não aprova");

  await applyMigration(before, MIGRATION);
  const post = await report(before, POSTCHECK);
  for (const [name, row] of post) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  assert.equal(post.get("WAITLIST_FUNDACAO_POSTCHECK_OK")?.result, "0 falha(s), 0 ponto(s) de atenção");
  assert.equal(post.get("FUNCOES_NOVAS_COM_A_DEFINICAO_DO_REPOSITORIO")?.result, "18 de 18");
  assert.equal(post.get("PERMISSOES_DAS_FUNCOES")?.result, "1 pública, 7 do servidor, 10 internas");
  assert.equal(post.get("SEGREDO_DA_LISTA")?.result, "1 linha(s), 32 bytes");
  assert.equal(post.get("TURMAS_ESGOTADAS_VISIVEIS")?.result, "1");
  assert.equal(post.get("LISTA_DE_ESPERA")?.result, "0 inscrição(ões), 0 aviso(s), 0 abertura(s)");
  for (const count of COUNTS) assert.equal(post.get(count)?.result, pre.get(count)?.result, count);

  // Reaplicação: o preflight avisa, sem bloquear, e a assinatura continua a mesma.
  const again = await report(before, PREFLIGHT);
  assert.equal(again.get("OBJETOS_NOVOS_AINDA_AUSENTES")?.status, "ATENCAO");
  assert.equal(again.get("WAITLIST_FUNDACAO_PREFLIGHT_OK")?.status, "OK");
  assert.equal(again.get("ASSINATURA_DAS_FUNCOES_EXISTENTES")?.result, pre.get("ASSINATURA_DAS_FUNCOES_EXISTENTES")?.result);
  await before.close();
});

test("preflight: reprova com vagas calculadas de outro jeito; avisa com função de apoio diferente", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  await before.exec(`create or replace function public.available_spots(p_session_id uuid) returns integer language sql stable security definer set search_path = public as $$ select 99 $$`);
  await before.exec(`create or replace function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end; $$`);
  const pre = await report(before, PREFLIGHT);
  assert.equal(pre.get("FUNCOES_QUE_A_LISTA_ESPELHA_OU_CHAMA")?.status, "FALHOU");
  assert.match(pre.get("FUNCOES_QUE_A_LISTA_ESPELHA_OU_CHAMA")!.result, /available_spots=DIFERENTE/);
  assert.equal(pre.get("FUNCOES_DE_APOIO")?.status, "ATENCAO");
  assert.equal(pre.get("WAITLIST_FUNDACAO_PREFLIGHT_OK")?.status, "FALHOU");
  await before.close();
});

test("postcheck: reprova se uma função nova ficar exposta ou divergir do repositório", async () => {
  const database = await fullDatabase();
  await database.exec(`grant execute on function public.waitlist_cancel_token(uuid) to anon`);
  await database.exec(`grant select on public.waitlist_entries to service_role`);
  await database.exec(`grant usage on sequence public.waitlist_entries_queue_sequence_seq to anon`);
  const post = await report(database, POSTCHECK);
  assert.equal(post.get("PERMISSOES_DAS_FUNCOES")?.status, "FALHOU");
  assert.match(post.get("PERMISSOES_DAS_FUNCOES")!.result, /waitlist_cancel_token/);
  assert.equal(post.get("TABELAS_FECHADAS")?.status, "FALHOU");
  assert.equal(post.get("SEQUENCIA_DA_FILA_FECHADA")?.status, "FALHOU");
  assert.equal(post.get("WAITLIST_FUNDACAO_POSTCHECK_OK")?.status, "FALHOU");
  await database.close();
});

test("rollback: recusa com inscrição ativa; vazio, remove só o que a migration criou; reaplicar devolve tudo", async () => {
  const database = await fullDatabase();
  const local = await rescheduleFixtures(async (sql, params = []) => (await database.query(sql, params)).rows as Row[]);
  const session = await local.makeSession(local.IMERSAO.id, { price: local.uniquePrice(), capacity: 1 });
  const booking = await local.reserve(session, 1);
  await database.query(`select public.waitlist_join($1::uuid, 'Pessoa Rollback', 'rollback@teste.local', '+5561999990000', 1, null, '')`, [session]);

  await assert.rejects(database.exec(ROLLBACK), /WAITLIST_ROLLBACK_REFUSED/);
  await database.exec("rollback");
  assert.notEqual((await database.query<{ t: string | null }>(`select to_regclass('public.waitlist_entries')::text as t`)).rows[0].t, null, "nada foi removido");

  const entry = (await database.query<{ id: string }>(`select id from public.waitlist_entries`)).rows[0];
  await database.query(`select public.admin_remove_waitlist_entry($1::uuid, $2::uuid, 'Limpeza antes do rollback')`, [ADMIN, entry.id]);

  const functions = async () => (await database.query<{ name: string; src: string }>(
    `select p.oid::regprocedure::text as name, md5(p.prosrc) as src from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`,
  )).rows;
  const data = async () => (await database.query(`select md5(string_agg(r::text, '|' order by r.id)) as h from public.reservations r`)).rows[0];
  const beforeFunctions = await functions();
  const beforeData = await data();

  await database.exec(ROLLBACK);
  const after = await functions();
  assert.deepEqual(beforeFunctions.filter((row) => !after.some((kept) => kept.name === row.name)).map((row) => row.name).sort(), NEW_FUNCTIONS);
  for (const row of after) assert.equal(row.src, beforeFunctions.find((old) => old.name === row.name)?.src, row.name);
  for (const table of NEW_TABLES) {
    assert.equal((await database.query<{ t: string | null }>(`select to_regclass($1)::text as t`, [`public.${table}`])).rows[0].t, null, table);
  }
  assert.deepEqual(await data(), beforeData);
  assert.equal((await database.query<{ status: string }>(`select status::text from public.reservations where id = $1::uuid`, [booking.id])).rows[0].status, "CONFIRMED");
  assert.equal((await database.query<{ n: number }>(`select count(*)::int as n from public.admin_audit_log where entity_type = 'waitlist_entry'`)).rows[0].n, 1, "a auditoria fica");
  await assert.rejects(database.query(POSTCHECK), /does not exist/);

  await applyMigration(database, MIGRATION);
  const post = await report(database, POSTCHECK);
  assert.equal(post.get("WAITLIST_FUNDACAO_POSTCHECK_OK")?.status, "OK");
  await database.close();
});

test("nada é enviado nem agendado: nenhuma referência a cron, pg_net ou provedor de e-mail", () => {
  const source = readFileSync(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), "utf8");
  const code = source.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
  assert.doesNotMatch(code, /cron\.|pg_net|net\.http|resend|http_post/i);
  assert.doesNotMatch(code, /create extension/i);
});
