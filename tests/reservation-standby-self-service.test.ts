/**
 * Autoatendimento do reagendamento de Stand-by (etapa 5).
 *
 * Roda contra o Postgres em memória (PGlite) com **todas** as migrations do
 * repositório, e o fluxo do servidor — `handleSelfServiceOverview` e
 * `handleSelfServiceReschedule` — fala com as RPCs de verdade pelo mesmo
 * formato `rpc(nome, argumentos)` do supabase-js. O que a rota acrescenta além
 * disso (recurso ligado, origem, cache) é conferido no fim, no código-fonte.
 *
 * As reservas nascem pelo caminho real: pré-reserva, pagamento, Stand-by pelo
 * painel. Nenhum e-mail sai: o envio é um duplo que só registra o changeId.
 *
 * A espera real entre duas sessões do Postgres — duas pessoas na última vaga,
 * a mesma autorização em duas abas — está em
 * `reservation-standby-self-service-concurrency.test.ts`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { applyMigration, fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";
import { ADMIN, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";
import {
  clientAddress,
  credentialArgs,
  handleSelfServiceOverview,
  handleSelfServiceReschedule,
  isStandbySelfServiceEnabled,
  parseCredential,
  parseOverview,
  parseRescheduleChoice,
  SELF_SERVICE_MESSAGES,
  selfServiceRescheduleError,
  standbyTokenFromHash,
  type SelfServiceCredential,
  type SelfServiceDeps,
} from "../lib/reservations/standby-self-service.ts";

const MIGRATION = "202610160001_reservation_standby_self_service.sql";
const PREVIOUS = "202610150001_reservation_reschedule_email.sql";

const db = await fullDatabase();
const admin = createPgliteAdmin(db);
const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
const { one, rows, call, IMERSAO, SUNSET_CONCHA, makeSession, uniquePrice, setStandby, reservation, emails } = fx;

// --- Cenários -----------------------------------------------------------------

let cpfSequence = 100_000_000;

/** CPF com dígitos verificadores válidos: a rota recusa qualquer outro antes do banco. */
function nextCpf() {
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

type Booking = { id: string; cpf: string; code: string; quantity: number; fullName: string };

/** Reserva paga pelo caminho real, com um CPF válido. */
async function book(sessionId: string, quantity = 2): Promise<Booking> {
  const cpf = nextCpf();
  const fullName = `Marina Autoatendimento ${cpf.slice(-4)}`;
  const created = await call(
    `public.create_pre_reservation($1::uuid, $2, $3, $4, $5, $6, null, gen_random_uuid())`,
    [sessionId, fullName, cpf, `+55619${cpf.slice(-8)}`, `cliente${cpf}@teste.local`, quantity],
  );
  const confirmed = await call(
    `public.confirm_reservation_payment($1::uuid, 'INFINITEPAY', $2, $3, 'https://recibo.teste/1', '{}'::jsonb)`,
    [created.reservationId, `tx-${cpf}`, created.totalCents],
  );
  assert.equal(confirmed, true);
  return { id: created.reservationId, cpf, code: created.publicCode, quantity, fullName };
}

/** Reserva confirmada, colocada em Stand-by pelo painel, e uma turma elegível em outra base. */
async function inStandby(options: { quantity?: number; price?: number; capacity?: number } = {}) {
  const price = options.price ?? uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price, capacity: 10 });
  const booking = await book(origin, options.quantity ?? 2);
  await setStandby(booking.id);
  const target = await makeSession(SUNSET_CONCHA.id, { price, capacity: options.capacity ?? 6 });
  return { booking, origin, target, price };
}

async function generateLink(reservationId: string): Promise<string> {
  const link = await call(`public.admin_generate_reservation_standby_link($1::uuid, $2::uuid)`, [ADMIN, reservationId]);
  return link.token as string;
}

const byCpf = (booking: Booking): SelfServiceCredential => ({ kind: "CPF_CODE", cpf: booking.cpf, publicCode: booking.code });
const byLink = (token: string): SelfServiceCredential => ({ kind: "LINK", token });
const body = (credential: SelfServiceCredential) =>
  credential.kind === "LINK" ? { token: credential.token } : { cpf: credential.cpf, publicCode: credential.publicCode };

type Harness = SelfServiceDeps & { sent: string[]; after: Array<() => Promise<unknown>>; synced: Array<[string, string]> };

function harness(emailOutcome: { outcome: string; retryable?: boolean } = { outcome: "DISABLED" }): Harness {
  const sent: string[] = [];
  const after: Array<() => Promise<unknown>> = [];
  const synced: Array<[string, string]> = [];
  return {
    rpc: (name, args) => admin.client.rpc(name, args),
    sendConfirmationEmail: async (changeId) => { sent.push(changeId); return emailOutcome; },
    followUpConfirmationEmail: async () => ({ outcome: "PENDING" }),
    afterResponse: (task) => { after.push(task); },
    syncSheet: async (reservationId, previous) => { synced.push([reservationId, previous]); },
    sent,
    after,
    synced,
  };
}

/** Cada cenário vem de um endereço próprio: o limite por origem é testado à parte. */
let clientSequence = 0;
const nextClient = () => `198.51.100.${(clientSequence += 1) % 250}-${clientSequence}`;

type Response = { status: number; body: Row; retryAfterSeconds?: number };

async function overview(credential: SelfServiceCredential, deps: SelfServiceDeps = harness(), client = nextClient()): Promise<Response> {
  return handleSelfServiceOverview(deps, { credential: body(credential) }, client);
}

async function choose(credential: SelfServiceCredential, standbyId: string, sessionId: string, deps: SelfServiceDeps = harness(), client = nextClient()): Promise<Response> {
  return handleSelfServiceReschedule(deps, { credential: body(credential), standbyId, sessionId }, client);
}

function openOverview(response: Response) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.overview.state, "OPEN");
  return response.body.overview;
}

async function counts(reservationId: string) {
  return one(
    `select
       (select count(*)::int from public.payment_events where reservation_id = $1::uuid) as payments,
       (select count(*)::int from public.reservation_session_changes where reservation_id = $1::uuid) as changes,
       (select count(*)::int from public.reservation_reschedule_emails where reservation_id = $1::uuid) as emails,
       (select count(*)::int from public.admin_audit_log where entity_id = $1::uuid) as audits`,
    [reservationId],
  );
}

// ===========================================================================
// 1. Ativação, formato e tradução — sem banco
// ===========================================================================

test("o autoatendimento só existe com STANDBY_SELF_SERVICE_ENABLED=true", () => {
  assert.equal(isStandbySelfServiceEnabled({}), false);
  assert.equal(isStandbySelfServiceEnabled({ STANDBY_SELF_SERVICE_ENABLED: "" }), false);
  assert.equal(isStandbySelfServiceEnabled({ STANDBY_SELF_SERVICE_ENABLED: "1" }), false);
  assert.equal(isStandbySelfServiceEnabled({ STANDBY_SELF_SERVICE_ENABLED: "yes" }), false);
  assert.equal(isStandbySelfServiceEnabled({ STANDBY_SELF_SERVICE_ENABLED: "true" }), true);
  assert.equal(isStandbySelfServiceEnabled({ STANDBY_SELF_SERVICE_ENABLED: " TRUE " }), true);
  // Independente das outras variáveis do Stand-by.
  assert.equal(isStandbySelfServiceEnabled({ STANDBY_ADMIN_ENABLED: "true", STANDBY_RESCHEDULE_EMAIL_ENABLED: "true" }), false);
});

test("credencial: CPF válido + código, ou o token exato do link — nunca as duas, nunca outra coisa", () => {
  const token = "a".repeat(64);
  assert.deepEqual(parseCredential({ token }), { kind: "LINK", token });
  assert.deepEqual(parseCredential({ token: ` ${"A".repeat(64)} ` }), { kind: "LINK", token });
  assert.deepEqual(parseCredential({ cpf: "529.982.247-25", publicCode: " az7k2m9q " }), { kind: "CPF_CODE", cpf: "52998224725", publicCode: "AZ7K2M9Q" });

  for (const invalid of [
    null, [], "texto", {},
    { token: "a".repeat(63) }, { token: "g".repeat(64) }, { token, cpf: "52998224725", publicCode: "AZ7K2M9Q" },
    { cpf: "11111111111", publicCode: "AZ7K2M9Q" }, { cpf: "52998224724", publicCode: "AZ7K2M9Q" },
    { cpf: "52998224725", publicCode: "AZ7" }, { cpf: "52998224725", publicCode: "AZ7K2M9Q'--" },
  ]) {
    assert.equal(parseCredential(invalid), null, JSON.stringify(invalid));
  }

  assert.deepEqual(credentialArgs({ kind: "LINK", token }), { p_cpf: null, p_public_code: null, p_link_token: token });
  assert.deepEqual(credentialArgs({ kind: "CPF_CODE", cpf: "52998224725", publicCode: "AZ7K2M9Q" }), { p_cpf: "52998224725", p_public_code: "AZ7K2M9Q", p_link_token: null });
});

test("a escolha traz só a credencial, a autorização e a turma", () => {
  const credential = { cpf: "52998224725", publicCode: "AZ7K2M9Q" };
  const standbyId = "0b5f4a52-2d1e-4b6a-9b1e-2f2d6c9f1a10";
  const sessionId = "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f";
  assert.deepEqual(parseRescheduleChoice({ credential, standbyId, sessionId }), {
    credential: { kind: "CPF_CODE", cpf: "52998224725", publicCode: "AZ7K2M9Q" }, standbyId, sessionId,
  });
  assert.equal(parseRescheduleChoice({ credential, standbyId, sessionId: "1" }), null);
  assert.equal(parseRescheduleChoice({ credential, standbyId: "x", sessionId }), null);
  assert.equal(parseRescheduleChoice({ credential: {}, standbyId, sessionId }), null);
});

test("o token do link é lido do fragmento, só no formato exato", () => {
  const token = "0123456789abcdef".repeat(4);
  assert.equal(standbyTokenFromHash(`#r=${token}`), token);
  assert.equal(standbyTokenFromHash(`#r=${token.toUpperCase()}`), token);
  assert.equal(standbyTokenFromHash(`r=${token}`), token);
  assert.equal(standbyTokenFromHash(""), null);
  assert.equal(standbyTokenFromHash("#r=abc"), null);
  assert.equal(standbyTokenFromHash(`#x=${token}`), null);
  assert.equal(standbyTokenFromHash(`#r=${token}z`), null);
});

test("o endereço do cliente vem dos cabeçalhos gravados pela Vercel", () => {
  const headers = (values: Record<string, string>) => new Headers(values);
  assert.equal(clientAddress(headers({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "10.0.0.1" })), "203.0.113.9");
  assert.equal(clientAddress(headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })), "203.0.113.7");
  assert.equal(clientAddress(headers({})), "");
  assert.equal(clientAddress(headers({ "x-real-ip": "x".repeat(300) })).length, 128);
});

test("cada recusa do banco vira uma mensagem para o cliente, sem detalhe interno", () => {
  const cpf: SelfServiceCredential = { kind: "CPF_CODE", cpf: "52998224725", publicCode: "AZ7K2M9Q" };
  const link: SelfServiceCredential = { kind: "LINK", token: "a".repeat(64) };
  const cases: Array<[string, number, string]> = [
    ["STANDBY_NOT_AUTHORIZED", 404, "NOT_FOUND"],
    ["STANDBY_ALREADY_USED", 409, "ALREADY_USED"],
    ["INSUFFICIENT_SPOTS", 409, "NO_SPOTS"],
    ["PRICE_NOT_ELIGIBLE", 409, "SESSION_UNAVAILABLE"],
    ["SESSION_NOT_OPEN", 409, "SESSION_UNAVAILABLE"],
    ["SESSION_MUST_BE_FUTURE", 409, "SESSION_UNAVAILABLE"],
    ["SESSION_NOT_FOUND", 409, "SESSION_UNAVAILABLE"],
    ["EXPERIENCE_NOT_AVAILABLE", 409, "SESSION_UNAVAILABLE"],
    ["BASE_NOT_AVAILABLE", 409, "SESSION_UNAVAILABLE"],
    ["STANDBY_INVARIANT_VIOLATION", 500, "FAILED"],
    ["connection reset by peer at 10.0.0.3", 500, "FAILED"],
  ];
  for (const [symbol, status, code] of cases) {
    const failure = selfServiceRescheduleError(new Error(symbol), cpf);
    assert.deepEqual([failure.status, failure.code], [status, code], symbol);
    assert.doesNotMatch(failure.message, /[A-Z]{3,}_[A-Z]/, "nenhum símbolo do banco chega ao cliente");
    assert.doesNotMatch(failure.message, /10\.0\.0\.3/);
  }
  assert.equal(selfServiceRescheduleError(new Error("STANDBY_NOT_AUTHORIZED"), cpf).message, SELF_SERVICE_MESSAGES.NOT_FOUND_CPF);
  assert.equal(selfServiceRescheduleError(new Error("STANDBY_NOT_AUTHORIZED"), link).message, SELF_SERVICE_MESSAGES.NOT_FOUND_LINK);
  assert.equal(selfServiceRescheduleError(new Error("PRICE_NOT_ELIGIBLE"), cpf).message, SELF_SERVICE_MESSAGES.PRICE_NOT_ELIGIBLE);
});

test("a leitura da tela não deixa passar nada além do que a tela usa", () => {
  const parsed = parseOverview({
    state: "OPEN", standbyId: "s", publicCode: "AZ7K2M9Q", firstName: "Marina", quantity: 2, totalCents: 40000,
    cpf: "52998224725", phone: "+5561999999999", email: "x@y.z", fullName: "Marina Lopes",
    original: { startsAt: "2026-10-20T12:00:00Z", experienceTitle: "Imersão", baseName: "Lago Norte", sessionId: "o" },
    hiddenForCapacity: 1,
    options: [{ sessionId: "a", experienceTitle: "Sunset", baseSlug: "concha", baseName: "Concha", startsAt: "2026-10-21T21:00:00Z", durationMinutes: 90, remainingSpots: 4, isOriginal: false, priceCents: 20000 }],
  });
  assert.ok(parsed && parsed.state === "OPEN");
  const text = JSON.stringify(parsed);
  for (const leaked of ["52998224725", "+5561999999999", "x@y.z", "Lopes"]) assert.ok(!text.includes(leaked), leaked);
  assert.equal(parseOverview({ state: "SOMETHING" }), null);
  assert.equal(parseOverview(null), null);
});

// ===========================================================================
// 2. A migration
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
  assert.deepEqual(created, [
    "customer_reschedule_overview(text,text,text)",
    "customer_reschedule_throttle(text,text,text,text)",
  ]);

  // Idempotente: aplicar de novo não falha e não troca o segredo.
  const secret = (await before.query<{ s: string }>(`select encode(secret, 'hex') as s from public.customer_access_throttle_secret`)).rows;
  await applyMigration(before, MIGRATION);
  assert.deepEqual((await before.query(`select encode(secret, 'hex') as s from public.customer_access_throttle_secret`)).rows, secret);
  assert.equal(secret.length, 1);
  assert.equal(secret[0].s.length, 64);
  await before.close();
});

test("migration: nenhuma reserva, sessão, pagamento ou autorização muda ao aplicar", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  const local = await rescheduleFixtures(async (sql, params = []) => (await before.query(sql, params)).rows as Row[]);
  const session = await local.makeSession(local.IMERSAO.id, { price: local.uniquePrice(), capacity: 10 });
  const kept = await local.reserve(session, 2);
  const parked = await local.reserve(session, 1);
  await local.setStandby(parked.id);
  const digest = async () => (await before.query(
    `select md5(string_agg(t::text, '|' order by t::text)) as h from (
       select r::text as t from public.reservations r
       union all select s::text from public.sessions s
       union all select p::text from public.payment_events p
       union all select sb::text from public.reservation_standby sb
       union all select c::text from public.reservation_session_changes c) x`,
  )).rows[0];
  const old = await digest();
  await applyMigration(before, MIGRATION);
  assert.deepEqual(await digest(), old);
  assert.ok(kept.id);
  await before.close();
});

test("migration: só a service role executa; ninguém lê as tabelas do limite pela API", async () => {
  for (const fn of ["customer_reschedule_throttle(text,text,text,text)", "customer_reschedule_overview(text,text,text)"]) {
    const row = await one(
      `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated,
              has_function_privilege('service_role', $1, 'EXECUTE') as service,
              p.prosecdef as definer, p.proconfig as config
       from pg_proc p where p.oid = $1::regprocedure`,
      [`public.${fn}`],
    );
    assert.deepEqual([row.anon, row.authenticated, row.service, row.definer], [false, false, true, true], fn);
    assert.ok((row.config as string[]).some((entry) => entry.startsWith("search_path=")), fn);
  }
  for (const table of ["customer_access_throttle", "customer_access_throttle_secret"]) {
    const row = await one(
      `select c.relrowsecurity as rls, (select count(*)::int from pg_policy where polrelid = c.oid) as policies,
              has_table_privilege('service_role', c.oid, 'SELECT') as service_reads,
              has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'SELECT') as public_reads
       from pg_class c where c.oid = $1::regclass`,
      [`public.${table}`],
    );
    assert.deepEqual([row.rls, row.policies, row.service_reads, row.public_reads], [true, 0, false, false], table);
  }
  // As RPCs da etapa 2 continuam como eram: só a service role.
  for (const fn of ["customer_reschedule_options(text,text,text)", "customer_reschedule_reservation(text,text,text,uuid,uuid)"]) {
    const row = await one(`select has_function_privilege('anon', $1, 'EXECUTE') as anon, has_function_privilege('service_role', $1, 'EXECUTE') as service`, [`public.${fn}`]);
    assert.deepEqual([row.anon, row.service], [false, true], fn);
  }
});

const PREFLIGHT = readFileSync(new URL("../supabase/diagnostics/reservation_standby_self_service_preflight.sql", import.meta.url), "utf8");
const POSTCHECK = readFileSync(new URL("../supabase/diagnostics/reservation_standby_self_service_postcheck.sql", import.meta.url), "utf8");
const ROLLBACK = readFileSync(new URL("../supabase/rollback/202610160001_reservation_standby_self_service.rollback.sql", import.meta.url), "utf8");

type Check = { check_name: string; result: string; status: string };

async function report(database: { query: (sql: string) => Promise<{ rows: unknown[] }> }, sql: string) {
  const result = (await database.query(sql)).rows as Check[];
  return new Map(result.map((row) => [row.check_name, row]));
}

test("preflight e postcheck: aprovam o banco do repositório, nas duas pontas da migration", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  const pre = await report(before, PREFLIGHT);
  assert.equal(pre.get("STANDBY_AUTOATENDIMENTO_PREFLIGHT_OK")?.status, "OK");
  assert.equal(pre.get("STANDBY_AUTOATENDIMENTO_PREFLIGHT_OK")?.result, "0 falha(s), 0 ponto(s) de atenção");
  assert.match(pre.get("FUNCOES_DO_AUTOATENDIMENTO")!.result, /^(\w+=IDENTICA(, )?){6}$/);
  await assert.rejects(before.query(POSTCHECK), /does not exist/, "antes da migration o postcheck falha, não aprova");

  await applyMigration(before, MIGRATION);
  const post = await report(before, POSTCHECK);
  for (const [name, row] of post) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  assert.equal(post.get("STANDBY_AUTOATENDIMENTO_POSTCHECK_OK")?.result, "0 falha(s), 0 ponto(s) de atenção");
  assert.equal(post.get("SEGREDO_DO_LIMITE")?.result, "1 linha(s), 32 bytes");
  for (const count of ["RESERVAS_POR_STATUS", "EVENTOS_DE_PAGAMENTO", "HISTORICO_DE_TROCAS", "AUTORIZACOES_DE_STANDBY", "FILA_DE_REAGENDAMENTO"]) {
    assert.equal(post.get(count)?.result, pre.get(count)?.result, count);
  }

  // Reaplicação: o preflight avisa, sem bloquear.
  const again = await report(before, PREFLIGHT);
  assert.equal(again.get("OBJETOS_NOVOS_AINDA_AUSENTES")?.status, "ATENCAO");
  assert.equal(again.get("STANDBY_AUTOATENDIMENTO_PREFLIGHT_OK")?.status, "OK");
  await before.close();
});

test("preflight: reprova sem a etapa 4 ou com função da etapa 2 diferente do repositório", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  await before.exec(`alter table public.reservation_session_changes disable trigger reservation_session_changes_reschedule_email`);
  await before.exec(`create or replace function public.reservation_latest_standby(p_reservation_id uuid) returns uuid language sql stable security definer set search_path = public as $$ select null::uuid $$`);
  const pre = await report(before, PREFLIGHT);
  assert.equal(pre.get("ETAPA_4_APLICADA")?.status, "FALHOU");
  assert.equal(pre.get("FUNCOES_DO_AUTOATENDIMENTO")?.status, "FALHOU");
  assert.match(pre.get("FUNCOES_DO_AUTOATENDIMENTO")!.result, /reservation_latest_standby=DIFERENTE/);
  assert.equal(pre.get("STANDBY_AUTOATENDIMENTO_PREFLIGHT_OK")?.status, "FALHOU");
  await before.close();
});

test("rollback: remove só o que a migration criou; reaplicar devolve tudo", async () => {
  const database = await fullDatabase();
  const local = await rescheduleFixtures(async (sql, params = []) => (await database.query(sql, params)).rows as Row[]);
  const session = await local.makeSession(local.IMERSAO.id, { price: local.uniquePrice(), capacity: 10 });
  const parked = await local.reserve(session, 1);
  await local.setStandby(parked.id);
  await database.query(`select public.customer_reschedule_throttle('203.0.113.1', null, 'ROLLBACK', null)`);

  const functions = async () => (await database.query<{ name: string; src: string }>(
    `select p.oid::regprocedure::text as name, md5(p.prosrc) as src from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`,
  )).rows;
  const data = async () => (await database.query(`select md5(string_agg(r::text, '|' order by r.id)) as h from public.reservations r`)).rows[0];
  const beforeFunctions = await functions();
  const beforeData = await data();

  await database.exec(ROLLBACK);
  const after = await functions();
  assert.deepEqual(
    beforeFunctions.filter((row) => !after.some((kept) => kept.name === row.name)).map((row) => row.name).sort(),
    ["customer_reschedule_overview(text,text,text)", "customer_reschedule_throttle(text,text,text,text)"],
  );
  for (const row of after) assert.equal(row.src, beforeFunctions.find((old) => old.name === row.name)?.src, row.name);
  assert.equal((await database.query<{ t: string | null }>(`select to_regclass('public.customer_access_throttle')::text as t`)).rows[0].t, null);
  assert.deepEqual(await data(), beforeData);
  assert.equal((await database.query<{ status: string }>(`select status::text from public.reservations where id = $1::uuid`, [parked.id])).rows[0].status, "AWAITING_RESCHEDULE");
  await assert.rejects(database.query(POSTCHECK), /does not exist/);

  await applyMigration(database, MIGRATION);
  const post = await report(database, POSTCHECK);
  assert.equal(post.get("STANDBY_AUTOATENDIMENTO_POSTCHECK_OK")?.status, "OK");
  await database.close();
});

// ===========================================================================
// 3. Limite de tentativas
// ===========================================================================

async function hit(client: string, credential: { cpf?: string; code?: string; token?: string }) {
  return call(`public.customer_reschedule_throttle($1, $2, $3, $4)`, [client, credential.cpf ?? null, credential.code ?? null, credential.token ?? null]);
}

test("limite: 10 tentativas por código a cada 15 minutos, venham de onde vierem", async () => {
  const code = "LIMITE01";
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const result = await hit(`203.0.113.${attempt}`, { cpf: nextCpf(), code });
    assert.equal(result.allowed, true, `tentativa ${attempt}`);
  }
  const blocked = await hit("203.0.113.99", { cpf: nextCpf(), code: ` ${code.toLowerCase()} ` });
  assert.equal(blocked.allowed, false, "trocar de endereço, de CPF ou de caixa não abre o código");
  assert.ok(blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= 900);

  // Outro código, do mesmo endereço, segue livre.
  assert.equal((await hit("203.0.113.99", { cpf: nextCpf(), code: "LIMITE02" })).allowed, true);
});

test("limite: 30 tentativas por endereço, para qualquer credencial", async () => {
  const client = "192.0.2.77";
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    assert.equal((await hit(client, { code: `END${String(attempt).padStart(5, "0")}` })).allowed, true, `tentativa ${attempt}`);
  }
  assert.equal((await hit(client, { code: "OUTRO001" })).allowed, false);
  assert.equal((await hit(client, { token: "b".repeat(64) })).allowed, false, "o link também conta no endereço");
  assert.equal((await hit("192.0.2.78", { code: "OUTRO001" })).allowed, true);
});

test("limite: sem endereço, todos dividem o mesmo balde", async () => {
  await rows(`delete from public.customer_access_throttle`);
  for (let attempt = 1; attempt <= 30; attempt += 1) await hit("", { code: `SEMIP${String(attempt).padStart(3, "0")}` });
  assert.equal((await hit("   ", { code: "SEMIP999" })).allowed, false);
});

test("limite: a janela vence e o contador recomeça; baldes parados há um dia são apagados", async () => {
  const code = "JANELA01";
  for (let attempt = 1; attempt <= 11; attempt += 1) await hit(`198.18.0.${attempt}`, { code });
  assert.equal((await hit("198.18.0.50", { code })).allowed, false);
  await rows(`update public.customer_access_throttle set window_started_at = now() - interval '16 minutes'`);
  assert.equal((await hit("198.18.0.51", { code })).allowed, true, "nova janela");

  await rows(`update public.customer_access_throttle set window_started_at = now() - interval '2 days'`);
  const stale = (await one(`select count(*)::int as n from public.customer_access_throttle`)).n;
  assert.ok(stale > 1);
  await hit("198.18.0.52", { code: "FAXINA01" });
  const left = (await one(`select count(*)::int as n from public.customer_access_throttle where window_started_at < now() - interval '1 day'`)).n;
  assert.ok(left < stale, "a faxina apaga baldes vencidos a cada chamada");
});

test("limite: nem o endereço, nem o código, nem o token ficam legíveis no banco", async () => {
  const token = "c".repeat(64);
  await hit("203.0.113.200", { cpf: "52998224725", code: "LEGIVEL1", token: null as unknown as string });
  await hit("203.0.113.201", { token });
  const stored = JSON.stringify(await rows(`select * from public.customer_access_throttle`));
  for (const raw of ["203.0.113.200", "203.0.113.201", "LEGIVEL1", "52998224725", token]) {
    assert.ok(!stored.includes(raw), raw);
  }
  for (const row of await rows(`select bucket from public.customer_access_throttle`)) {
    assert.match(row.bucket, /^(client|credential):[0-9a-f]{64}$/);
  }
});

// ===========================================================================
// 4. O que o cliente vê
// ===========================================================================

test("CPF + código e link levam à mesma tela, só com turmas elegíveis — de qualquer base", async () => {
  const price = uniquePrice();
  const { booking, origin, target } = await inStandby({ price, quantity: 2 });

  // Elegível em outra base, a turma original e uma da mesma base.
  const sameBase = await makeSession(IMERSAO.id, { price, capacity: 4 });
  // Fora: outro valor, sem vaga para o grupo, fechada, já começou.
  const otherPrice = await makeSession(SUNSET_CONCHA.id, { price: price + 100, capacity: 6 });
  const tooSmall = await makeSession(SUNSET_CONCHA.id, { price, capacity: 1 });
  const closed = await makeSession(SUNSET_CONCHA.id, { price, capacity: 6 });
  await rows(`update public.sessions set status = 'CLOSED' where id = $1::uuid`, [closed]);
  const started = await makeSession(SUNSET_CONCHA.id, { price, capacity: 6, startsIn: "1 hour" });
  await rows(`update public.sessions set starts_at = now() - interval '5 minutes' where id = $1::uuid`, [started]);

  const viaCpf = openOverview(await overview(byCpf(booking)));
  const viaLink = openOverview(await overview(byLink(await generateLink(booking.id))));
  assert.deepEqual(viaLink.options, viaCpf.options);
  assert.equal(viaCpf.standbyId, viaLink.standbyId);

  const ids = viaCpf.options.map((option: Row) => option.sessionId);
  for (const eligible of [origin, target, sameBase]) assert.ok(ids.includes(eligible), `elegível: ${eligible}`);
  for (const excluded of [otherPrice, tooSmall, closed, started]) assert.ok(!ids.includes(excluded), `fora: ${excluded}`);
  assert.equal(viaCpf.hiddenForCapacity, 1, "a turma sem vaga para o grupo é contada, não oferecida");
  assert.ok(viaCpf.options.some((option: Row) => option.sessionId === origin && option.isOriginal));
  assert.deepEqual(new Set(viaCpf.options.map((option: Row) => option.baseName)), new Set([IMERSAO.base_name, SUNSET_CONCHA.base_name]));

  assert.equal(viaCpf.publicCode, booking.code);
  assert.equal(viaCpf.quantity, 2);
  assert.equal(viaCpf.firstName, "Marina");
});

test("experiência despublicada ou base fora de operação: some da lista e a escolha é recusada", async () => {
  const { booking, price } = await inStandby();
  const sunsetLago = await one(`select id from public.experiences where slug = 'remada-sunset'`);
  const unpublished = await makeSession(sunsetLago.id, { price, capacity: 6 });
  const otherBase = await makeSession(SUNSET_CONCHA.id, { price, capacity: 6 });
  const opened = openOverview(await overview(byCpf(booking)));
  assert.ok(opened.options.some((option: Row) => option.sessionId === unpublished));
  assert.ok(opened.options.some((option: Row) => option.sessionId === otherBase));

  await rows(`update public.experiences set status = 'DRAFT' where id = $1::uuid`, [sunsetLago.id]);
  // A trava do painel impede tirar de operação uma base com experiência publicada;
  // aqui ela é suspensa só para simular a base fechada.
  await rows(`alter table public.bases disable trigger bases_status_guard`);
  await rows(`update public.bases set status = 'INACTIVE' where id = $1::uuid`, [SUNSET_CONCHA.base_id]);
  try {
    const now = openOverview(await overview(byCpf(booking)));
    assert.ok(!now.options.some((option: Row) => option.sessionId === unpublished), "experiência em rascunho");
    assert.ok(!now.options.some((option: Row) => option.sessionId === otherBase), "base inativa");
    for (const sessionId of [unpublished, otherBase]) {
      const response = await choose(byCpf(booking), opened.standbyId, sessionId);
      assert.deepEqual([response.status, response.body.code], [409, "SESSION_UNAVAILABLE"]);
    }
    assert.equal((await reservation(booking.id)).status, "AWAITING_RESCHEDULE");
  } finally {
    await rows(`update public.bases set status = 'ACTIVE' where id = $1::uuid`, [SUNSET_CONCHA.base_id]);
    await rows(`alter table public.bases enable trigger bases_status_guard`);
    await rows(`update public.experiences set status = 'PUBLISHED' where id = $1::uuid`, [sunsetLago.id]);
  }
});

test("a tela nunca devolve CPF, telefone, e-mail, sobrenome ou ids internos da reserva", async () => {
  const { booking } = await inStandby();
  const token = await generateLink(booking.id);
  for (const credential of [byCpf(booking), byLink(token)]) {
    const response = await overview(credential);
    const text = JSON.stringify(response.body);
    const row = await reservation(booking.id);
    for (const leaked of [booking.cpf, row.phone, row.email, "Autoatendimento", booking.id, row.checkin_token, token]) {
      assert.ok(!text.includes(String(leaked)), `vazou ${leaked}`);
    }
  }
});

test("credencial errada, de reserva fora do Stand-by ou link revogado: a mesma resposta, sem confirmar nada", async () => {
  const { booking } = await inStandby();
  const session = await makeSession(IMERSAO.id, { price: uniquePrice() });
  const confirmed = await book(session, 1);
  const token = await generateLink(booking.id);
  await call(`public.admin_revoke_reservation_standby_link($1::uuid, $2::uuid)`, [ADMIN, booking.id]);

  const cases: SelfServiceCredential[] = [
    { kind: "CPF_CODE", cpf: nextCpf(), publicCode: booking.code },
    { kind: "CPF_CODE", cpf: booking.cpf, publicCode: "ZZZZZZZZ" },
    byCpf(confirmed),
    byLink(token),
    byLink("d".repeat(64)),
  ];
  const responses = await Promise.all(cases.map((credential) => overview(credential)));
  for (const [index, response] of responses.entries()) {
    assert.equal(response.status, 404, `caso ${index}`);
    assert.equal(response.body.code, "NOT_FOUND");
    assert.ok(!("overview" in response.body));
  }
  // As três de CPF + código dizem exatamente o mesmo; os dois links também.
  assert.equal(new Set(responses.slice(0, 3).map((response) => response.body.message)).size, 1);
  assert.equal(new Set(responses.slice(3).map((response) => response.body.message)).size, 1);
});

test("depois de encerrada: já reagendada (pelo cliente ou pela equipe), cancelada, link substituído", async () => {
  // Reagendada pelo próprio cliente.
  const first = await inStandby();
  const firstLink = await generateLink(first.booking.id);
  const opened = openOverview(await overview(byLink(firstLink)));
  assert.equal((await choose(byLink(firstLink), opened.standbyId, first.target)).status, 200);
  const done = await overview(byLink(firstLink));
  assert.equal(done.body.overview.state, "RESCHEDULED");
  assert.equal(done.body.overview.resolvedBy, "CUSTOMER");
  assert.equal(done.body.overview.session.experienceTitle, SUNSET_CONCHA.title);
  assert.equal((await overview(byCpf(first.booking))).body.overview.state, "RESCHEDULED");

  // Reagendada pela equipe.
  const second = await inStandby();
  await call(`public.admin_reschedule_standby_same_price($1::uuid, $2::uuid, $3::uuid, null)`, [ADMIN, second.booking.id, second.target]);
  const byTeam = await overview(byCpf(second.booking));
  assert.equal(byTeam.body.overview.state, "RESCHEDULED");
  assert.equal(byTeam.body.overview.resolvedBy, "ADMIN");

  // Cancelada durante o Stand-by.
  const third = await inStandby();
  const thirdLink = await generateLink(third.booking.id);
  await rows(`update public.reservations set status = 'CANCELLED', updated_at = now() where id = $1::uuid`, [third.booking.id]);
  assert.equal((await overview(byLink(thirdLink))).body.overview.state, "CANCELLED");
  assert.equal((await overview(byCpf(third.booking))).body.overview.state, "CANCELLED");

  // Voltou ao Stand-by depois de reagendada: o link antigo não abre a autorização nova.
  await setStandby(first.booking.id);
  const replaced = await overview(byLink(firstLink));
  assert.equal(replaced.body.overview.state, "LINK_REPLACED");
  assert.ok(!("options" in replaced.body.overview));
  assert.equal((await overview(byCpf(first.booking))).body.overview.state, "OPEN", "CPF + código alcançam a autorização aberta");
});

// ===========================================================================
// 5. A escolha
// ===========================================================================

test("reagendar: a reserva volta a CONFIRMED na turma nova, com código, QR, quantidade e pagamento intactos", async () => {
  const { booking, origin, target } = await inStandby({ quantity: 3 });
  const before = await reservation(booking.id);
  const beforeCounts = await counts(booking.id);
  const deps = harness();
  const opened = openOverview(await overview(byCpf(booking)));

  const response = await choose(byCpf(booking), opened.standbyId, target, deps);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.emailSent, false);
  assert.deepEqual(Object.keys(response.body.rescheduled as Row).sort(), ["experienceTitle", "publicCode", "quantity", "replayed", "startsAt"]);

  const after = await reservation(booking.id);
  assert.equal(after.status, "CONFIRMED");
  assert.equal(after.session_id, target);
  assert.equal(after.experience_id, SUNSET_CONCHA.id);
  for (const column of ["public_code", "checkin_token", "quantity", "unit_price_cents", "total_cents", "confirmed_at", "cpf_hash", "email", "full_name", "phone"]) {
    assert.deepEqual(after[column], before[column], column);
  }
  assert.notEqual(after.session_id, origin);

  const afterCounts = await counts(booking.id);
  assert.equal(afterCounts.payments, beforeCounts.payments, "nenhum evento de pagamento");
  assert.equal(afterCounts.changes, beforeCounts.changes + 1);
  assert.equal(afterCounts.emails, beforeCounts.emails + 1, "a fila da etapa 4 recebeu uma linha, pela transação");
  assert.equal(afterCounts.audits, beforeCounts.audits + 1);

  const [change] = await rows(`select * from public.reservation_session_changes where reservation_id = $1::uuid order by created_at desc limit 1`, [booking.id]);
  assert.deepEqual([change.origin, change.actor_type, change.actor_user_id, change.previous_session_id, change.target_session_id], ["STANDBY_RESCHEDULE", "CUSTOMER", null, origin, target]);
  const [audit] = await rows(`select * from public.admin_audit_log where entity_id = $1::uuid and action = 'RESERVATION_STANDBY_RESCHEDULED'`, [booking.id]);
  assert.deepEqual([audit.actor_user_id, audit.metadata.actorType, audit.metadata.access], [null, "CUSTOMER", "CPF_CODE"]);
  const [queued] = await emails(booking.id);
  assert.deepEqual([queued.status, queued.change_id, queued.actor_type], ["QUEUED", change.id, "CUSTOMER"]);

  // O servidor chamou o envio da etapa 4 com o changeId gravado, e a planilha em segundo plano.
  assert.deepEqual(deps.sent, [change.id]);
  assert.equal(deps.after.length, 1);
  await deps.after[0]();
  assert.deepEqual(deps.synced, [[booking.id, origin]]);

  // O check-in passa a valer na turma nova, com o mesmo QR.
  const ticket = await call(`public.public_checkin_ticket($1::uuid)`, [before.checkin_token]);
  assert.equal(new Date(ticket.startsAt).getTime(), new Date((await one(`select starts_at from public.sessions where id = $1::uuid`, [target])).starts_at).getTime());
});

test("reagendar pelo link registra o acesso LINK; o e-mail enviado aparece na resposta", async () => {
  const { booking, target } = await inStandby();
  const token = await generateLink(booking.id);
  const opened = openOverview(await overview(byLink(token)));
  const deps = harness({ outcome: "SENT" });
  const response = await choose(byLink(token), opened.standbyId, target, deps);
  assert.equal(response.status, 200);
  assert.equal(response.body.emailSent, true);
  const [audit] = await rows(`select metadata from public.admin_audit_log where entity_id = $1::uuid and action = 'RESERVATION_STANDBY_RESCHEDULED'`, [booking.id]);
  assert.equal(audit.metadata.access, "LINK");
  // Falha passageira do e-mail: mais tentativas depois da resposta, sem desfazer nada.
  const pending = await inStandby();
  const pendingOpen = openOverview(await overview(byCpf(pending.booking)));
  const retrying = harness({ outcome: "PENDING", retryable: true });
  assert.equal((await choose(byCpf(pending.booking), pendingOpen.standbyId, pending.target, retrying)).status, 200);
  assert.equal(retrying.after.length, 2, "follow-up do e-mail e planilha");
  assert.equal((await reservation(pending.booking.id)).status, "CONFIRMED");
});

test("uso único: a mesma escolha repetida devolve o resultado gravado; outra escolha é recusada", async () => {
  const { booking, target, price } = await inStandby();
  const other = await makeSession(SUNSET_CONCHA.id, { price, capacity: 6 });
  const opened = openOverview(await overview(byCpf(booking)));

  assert.equal((await choose(byCpf(booking), opened.standbyId, target)).status, 200);
  const snapshot = await counts(booking.id);

  const repeat = harness();
  const replay = await choose(byCpf(booking), opened.standbyId, target, repeat);
  assert.equal(replay.status, 200);
  assert.equal((replay.body.rescheduled as Row).replayed, true);
  assert.equal(repeat.synced.length + repeat.after.length, 0, "a repetição não sincroniza nada");
  assert.deepEqual(await counts(booking.id), snapshot, "nada escrito, nenhum segundo e-mail");

  const second = await choose(byCpf(booking), opened.standbyId, other);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "ALREADY_USED");
  assert.equal((await reservation(booking.id)).session_id, target);
  assert.deepEqual(await counts(booking.id), snapshot);
});

test("recusas desfazem tudo: outro valor, sem vaga, fechada, já começou", async () => {
  const { booking, price } = await inStandby({ quantity: 2 });
  const opened = openOverview(await overview(byCpf(booking)));
  const snapshot = await counts(booking.id);

  const otherPrice = await makeSession(SUNSET_CONCHA.id, { price: price + 100, capacity: 6 });
  const full = await makeSession(SUNSET_CONCHA.id, { price, capacity: 3 });
  await book(full, 2);
  const closed = await makeSession(SUNSET_CONCHA.id, { price, capacity: 6 });
  await rows(`update public.sessions set status = 'CLOSED' where id = $1::uuid`, [closed]);
  const started = await makeSession(SUNSET_CONCHA.id, { price, capacity: 6 });
  await rows(`update public.sessions set starts_at = now() - interval '1 minute' where id = $1::uuid`, [started]);

  const expectations: Array<[string, string, string]> = [
    [otherPrice, "SESSION_UNAVAILABLE", SELF_SERVICE_MESSAGES.PRICE_NOT_ELIGIBLE],
    [full, "NO_SPOTS", SELF_SERVICE_MESSAGES.NO_SPOTS],
    [closed, "SESSION_UNAVAILABLE", SELF_SERVICE_MESSAGES.SESSION_UNAVAILABLE],
    [started, "SESSION_UNAVAILABLE", SELF_SERVICE_MESSAGES.SESSION_UNAVAILABLE],
    ["7d1b2c3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e", "SESSION_UNAVAILABLE", SELF_SERVICE_MESSAGES.SESSION_UNAVAILABLE],
  ];
  for (const [sessionId, code, message] of expectations) {
    const response = await choose(byCpf(booking), opened.standbyId, sessionId);
    assert.equal(response.status, 409, `${code} ${sessionId}`);
    assert.deepEqual([response.body.code, response.body.message], [code, message]);
  }
  const row = await reservation(booking.id);
  assert.equal(row.status, "AWAITING_RESCHEDULE");
  assert.deepEqual(await counts(booking.id), snapshot);
  assert.equal(openOverview(await overview(byCpf(booking))).standbyId, opened.standbyId, "a autorização continua aberta");
});

test("uma credencial só alcança a própria autorização", async () => {
  const mine = await inStandby();
  const theirs = await inStandby();
  const theirOpen = openOverview(await overview(byCpf(theirs.booking)));
  const myToken = await generateLink(mine.booking.id);

  for (const credential of [byCpf(mine.booking), byLink(myToken)]) {
    const response = await choose(credential, theirOpen.standbyId, theirs.target);
    assert.equal(response.status, 404);
    assert.equal(response.body.code, "NOT_FOUND");
  }
  assert.equal((await reservation(theirs.booking.id)).status, "AWAITING_RESCHEDULE");
  assert.equal((await reservation(mine.booking.id)).status, "AWAITING_RESCHEDULE");
});

test("o limite vem antes de qualquer consulta da credencial", async () => {
  const { booking, target } = await inStandby();
  const opened = openOverview(await overview(byCpf(booking)));
  const client = "203.0.113.250";
  for (let attempt = 0; attempt < 9; attempt += 1) await overview(byCpf(booking), harness(), client);

  admin.reset();
  const blocked = await choose(byCpf(booking), opened.standbyId, target, harness(), client);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, "TOO_MANY_ATTEMPTS");
  assert.ok((blocked.retryAfterSeconds ?? 0) > 0);
  assert.deepEqual(admin.calls.rpc, ["customer_reschedule_throttle"], "a RPC de reagendamento nem foi chamada");
  assert.equal((await reservation(booking.id)).status, "AWAITING_RESCHEDULE");

  admin.reset();
  const overviewBlocked = await overview(byCpf(booking), harness(), "203.0.113.251");
  assert.equal(overviewBlocked.status, 429, "o limite é do código, não só do endereço");
  assert.deepEqual(admin.calls.rpc, ["customer_reschedule_throttle"]);
});

test("sem o limite funcionando, o autoatendimento fica indisponível — nunca liberado", async () => {
  const { booking, target } = await inStandby();
  admin.failRpc("customer_reschedule_throttle", { message: "function public.customer_reschedule_throttle does not exist" }, 2);
  admin.reset();
  const looked = await overview(byCpf(booking));
  const chosen = await choose(byCpf(booking), "0b5f4a52-2d1e-4b6a-9b1e-2f2d6c9f1a10", target);
  assert.deepEqual([looked.status, looked.body.code], [503, "UNAVAILABLE"]);
  assert.deepEqual([chosen.status, chosen.body.code], [503, "UNAVAILABLE"]);
  assert.deepEqual(admin.calls.rpc, ["customer_reschedule_throttle", "customer_reschedule_throttle"]);
  admin.clearFailures();
});

test("pedido malformado é recusado sem tocar no banco nem gastar tentativa", async () => {
  admin.reset();
  for (const payload of [null, {}, { credential: { cpf: "123", publicCode: "X" } }, { credential: { token: "z" } }]) {
    assert.equal((await handleSelfServiceOverview(harness(), payload, "203.0.113.1")).status, 400);
    assert.equal((await handleSelfServiceReschedule(harness(), payload, "203.0.113.1")).status, 400);
  }
  assert.deepEqual(admin.calls.rpc, []);
});

// ===========================================================================
// 6. O que não muda
// ===========================================================================

test("colocar em Stand-by não enfileira mensagem nenhuma", async () => {
  const session = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 6 });
  const booking = await book(session, 1);
  await setStandby(booking.id);
  await generateLink(booking.id);
  assert.deepEqual(await emails(booking.id), []);
});

test("fluxos existentes: pré-reserva, pagamento, consulta pública e check-in seguem iguais", async () => {
  const session = await makeSession(SUNSET_CONCHA.id, { price: uniquePrice(), capacity: 4 });
  const booking = await book(session, 2);
  const [looked] = await rows(`select * from public.lookup_reservation($1, $2)`, [booking.cpf, booking.code]);
  assert.equal(looked.reservation_status, "CONFIRMED");
  const row = await reservation(booking.id);
  const ticket = await call(`public.public_checkin_ticket($1::uuid)`, [row.checkin_token]);
  assert.ok(ticket);
  // Uma reserva confirmada comum não é alcançada pelo autoatendimento.
  assert.equal((await overview(byCpf(booking))).status, 404);
  assert.equal((await counts(booking.id)).emails, 0);
});

// ===========================================================================
// 7. Rotas e tela, no código-fonte
// ===========================================================================

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("rotas: só POST, recurso ligado antes de tudo, origem conferida, sem cache", () => {
  const gate = source("lib/reservations/standby-self-service-http.ts");
  const enabled = gate.indexOf("isStandbySelfServiceEnabled()");
  const origin = gate.indexOf("isSameOriginRequest(request)");
  const database = gate.indexOf("getSupabaseAdminClient()", origin);
  assert.ok(enabled > 0 && enabled < origin && origin < database, "404 antes da origem, origem antes do banco");
  assert.match(gate, /"cache-control": "no-store"/);
  assert.match(gate, /retry-after/);

  for (const path of ["app/api/reservations/standby/route.ts", "app/api/reservations/standby/reschedule/route.ts"]) {
    const route = source(path);
    assert.match(route, /export async function POST/);
    assert.doesNotMatch(route, /export async function (GET|PUT|PATCH|DELETE)/);
    assert.match(route, /selfServiceGate\(request\)/);
    assert.doesNotMatch(route, /console\./, "nada da credencial vai para log");
  }
  assert.match(source("app/api/reservations/standby/reschedule/route.ts"), /maxDuration = 60/);
});

test("tela: o token só é lido do fragmento, e só com o autoatendimento ligado", () => {
  const lookup = source("components/reservation/reservation-lookup.tsx");
  assert.match(lookup, /if \(!selfService\) return;\s*const token = standbyTokenFromHash\(window\.location\.hash\)/);
  assert.match(source("app/acompanhar-reserva/page.tsx"), /selfService=\{isStandbySelfServiceEnabled\(\)\}/);
  const screen = source("components/reservation/standby-reschedule.tsx");
  assert.match(screen, /\/api\/reservations\/standby\/reschedule/);
  assert.doesNotMatch(screen, /localStorage|sessionStorage|document\.cookie/, "a credencial não é guardada no navegador");
});
