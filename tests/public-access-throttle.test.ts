/**
 * Limite de tentativas compartilhado: consulta pública da reserva e
 * autoatendimento de Stand-by.
 *
 * Roda contra o Postgres em memória (PGlite) com todas as migrations, pelas
 * RPCs de verdade. Cobre:
 *
 *   - o endereço do cliente: só o gravado pela Vercel, e nunca um cabeçalho que
 *     o cliente escreva;
 *   - a consulta pública com o limite, com o contrato de sempre;
 *   - os baldes compartilhados entre os três endpoints;
 *   - o comportamento antes da migration: consulta igual a hoje, autoatendimento
 *     fechado;
 *   - o que vai para log e para as respostas.
 *
 * A disputa entre sessões independentes do Postgres está em
 * `reservation-standby-self-service-concurrency.test.ts`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";
import { ADMIN, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";
import { isBehindVercelEdge, normalizeClientIp, trustedClientAddress } from "../lib/http/client-address.ts";
import { ACCESS_ATTEMPT_RPC, registerAccessAttempt } from "../lib/reservations/access-throttle.ts";
import { handlePublicLookup, LOOKUP_MESSAGES, lookupFailureSymbol, type PublicLookupDeps } from "../lib/reservations/public-lookup.ts";
import { handleSelfServiceOverview, handleSelfServiceReschedule, type SelfServiceDeps } from "../lib/reservations/standby-self-service.ts";
import type { ReservationDetails } from "../lib/reservations/types.ts";

const PREVIOUS = "202610150001_reservation_reschedule_email.sql";

// --- Banco e cenários ---------------------------------------------------------

let cpfSequence = 300_000_000;

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

async function setup(db: PGlite) {
  const admin = createPgliteAdmin(db);
  const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
  const call = fx.call;

  async function book(quantity = 1) {
    const session = await fx.makeSession(fx.IMERSAO.id, { price: fx.uniquePrice(), capacity: 10 });
    const cpf = nextCpf();
    const created = await call(
      `public.create_pre_reservation($1::uuid, $2, $3, $4, $5, $6, null, gen_random_uuid())`,
      [session, `Cliente Consulta ${cpf.slice(-4)}`, cpf, `+55619${cpf.slice(-8)}`, `consulta${cpf}@teste.local`, quantity],
    );
    await call(
      `public.confirm_reservation_payment($1::uuid, 'INFINITEPAY', $2, $3, 'https://recibo.teste/1', '{}'::jsonb)`,
      [created.reservationId, `tx-${cpf}`, created.totalCents],
    );
    return { id: created.reservationId as string, cpf, code: created.publicCode as string, session };
  }

  /** O mesmo `lookup_reservation` da rota, pelo mesmo formato de resposta. */
  async function lookup(cpf: string, publicCode: string): Promise<ReservationDetails | null> {
    const result = await admin.client.rpc("lookup_reservation", { p_cpf: cpf, p_public_code: publicCode });
    if (result.error) throw new Error(result.error.message);
    const rows = result.data as Row[];
    return rows[0] ? ({ publicCode: rows[0].public_code, status: rows[0].reservation_status } as unknown as ReservationDetails) : null;
  }

  const logged: string[] = [];
  const lookupDeps: PublicLookupDeps = {
    rpc: (name, args) => admin.client.rpc(name, args),
    lookup,
    logFailure: (symbol) => logged.push(symbol),
  };
  const selfServiceDeps: SelfServiceDeps = { rpc: (name, args) => admin.client.rpc(name, args) };

  return { admin, fx, book, lookup, lookupDeps, selfServiceDeps, logged };
}

const current = await setup(await fullDatabase());

const lookupBody = (cpf: string, publicCode: string) => ({ cpf, publicCode });
let clientSequence = 0;
const nextClient = () => `198.51.100.${(clientSequence += 1) % 250}`;

async function clearLimits(db = current) {
  await db.fx.rows(`delete from public.customer_access_throttle`);
}

// ===========================================================================
// 1. Endereço do cliente
// ===========================================================================

const VERCEL = { VERCEL: "1" };
const headers = (values: Record<string, string>) => new Headers(values);

test("fora da Vercel nenhum cabeçalho de IP é lido: o cliente não escolhe o próprio balde", () => {
  const spoofed = headers({
    "x-vercel-forwarded-for": "203.0.113.1",
    "x-real-ip": "203.0.113.2",
    "x-forwarded-for": "203.0.113.3, 10.0.0.1",
    "cf-connecting-ip": "203.0.113.4",
    forwarded: "for=203.0.113.5",
  });
  for (const env of [{}, { VERCEL: "0" }, { VERCEL: "true" }, { VERCEL_ENV: "production" }]) {
    assert.equal(isBehindVercelEdge(env), false);
    assert.equal(trustedClientAddress(spoofed, env), "", JSON.stringify(env));
  }
});

test("na Vercel: x-vercel-forwarded-for, depois x-real-ip; x-forwarded-for e outros não contam", () => {
  assert.equal(trustedClientAddress(headers({ "x-vercel-forwarded-for": "203.0.113.9", "x-real-ip": "198.51.100.1" }), VERCEL), "203.0.113.9");
  assert.equal(trustedClientAddress(headers({ "x-real-ip": "198.51.100.1" }), VERCEL), "198.51.100.1");
  assert.equal(trustedClientAddress(headers({ "x-forwarded-for": "198.51.100.7" }), VERCEL), "", "x-forwarded-for sozinho não é usado");
  assert.equal(trustedClientAddress(headers({ "x-vercel-forwarded-for": "203.0.113.9, 10.0.0.1" }), VERCEL), "203.0.113.9", "de uma lista, só o primeiro");
  assert.equal(trustedClientAddress(headers({}), VERCEL), "");
});

test("só IP literal: lixo, injeção ou texto enorme não viram balde", () => {
  for (const invalid of ["", "unknown", "999.1.1.1", "1.2.3", "1.2.3.4.5", "01.2.3.4", "1.2.3.4; drop table", "1.2.3.4 ", "x".repeat(300), "::g", "1::2::3", "1:2:3:4:5:6:7:8:9"]) {
    assert.equal(normalizeClientIp(invalid === "1.2.3.4 " ? "1.2.3.4 x" : invalid), null, invalid);
  }
  assert.equal(trustedClientAddress(headers({ "x-vercel-forwarded-for": "1.2.3.4; drop table", "x-real-ip": "198.51.100.2" }), VERCEL), "198.51.100.2");
});

test("IPv6 é agrupado por /64; IPv4 mapeado em IPv6 é o próprio IPv4", () => {
  assert.equal(normalizeClientIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(normalizeClientIp("2001:DB8:1:2::1"), "2001:db8:1:2::/64");
  assert.equal(normalizeClientIp("2001:db8:1:2:ffff::ffff"), normalizeClientIp("2001:db8:1:2::1"), "trocar dentro do /64 não muda o balde");
  assert.notEqual(normalizeClientIp("2001:db8:1:3::1"), normalizeClientIp("2001:db8:1:2::1"));
  assert.equal(normalizeClientIp("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(normalizeClientIp("::1"), "0:0:0:0::/64");
  assert.equal(normalizeClientIp("203.0.113.9"), "203.0.113.9");
});

// ===========================================================================
// 2. Consulta pública com o limite
// ===========================================================================

test("consulta: o contrato de sempre para quem consulta a própria reserva", async () => {
  await clearLimits();
  const booking = await current.book();
  const { admin, lookupDeps } = current;

  admin.reset();
  assert.deepEqual(await handlePublicLookup(lookupDeps, { cpf: "123", publicCode: "x" }, nextClient()), {
    status: 400,
    body: { errors: { cpf: "Informe um CPF válido.", publicCode: "Informe o código da reserva." } },
  });
  assert.deepEqual(admin.calls.rpc, [], "formato inválido não toca no banco nem gasta tentativa");

  const found = await handlePublicLookup(lookupDeps, lookupBody(booking.cpf, booking.code), nextClient());
  assert.equal(found.status, 200);
  assert.deepEqual(found.body, { reservation: await current.lookup(booking.cpf, booking.code) });
  assert.equal(found.retryAfterSeconds, undefined);

  const missing = await handlePublicLookup(lookupDeps, lookupBody(nextCpf(), booking.code), nextClient());
  assert.deepEqual([missing.status, missing.body], [404, { message: LOOKUP_MESSAGES.NOT_FOUND }]);
  // O limite vem antes da consulta.
  assert.deepEqual(admin.calls.rpc.slice(0, 2), [ACCESS_ATTEMPT_RPC, "lookup_reservation"]);
});

test("consulta: tentativas excessivas no mesmo código recebem 429 — e a reserva nem é consultada", async () => {
  await clearLimits();
  const booking = await current.book();
  const { admin, lookupDeps } = current;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const response = await handlePublicLookup(lookupDeps, lookupBody(nextCpf(), booking.code), nextClient());
    assert.equal(response.status, 404, `tentativa ${attempt}`);
  }
  admin.reset();
  const blocked = await handlePublicLookup(lookupDeps, lookupBody(booking.cpf, booking.code), nextClient());
  assert.equal(blocked.status, 429, "nem o CPF certo passa enquanto o código está travado");
  assert.deepEqual(blocked.body, { message: LOOKUP_MESSAGES.TOO_MANY_ATTEMPTS });
  assert.ok((blocked.retryAfterSeconds ?? 0) > 0 && (blocked.retryAfterSeconds ?? 0) <= 900);
  assert.deepEqual(admin.calls.rpc, [ACCESS_ATTEMPT_RPC]);

  // Passada a janela, o dono consulta normalmente.
  await current.fx.rows(`update public.customer_access_throttle set window_started_at = now() - interval '16 minutes'`);
  assert.equal((await handlePublicLookup(lookupDeps, lookupBody(booking.cpf, booking.code), nextClient())).status, 200);
});

test("consulta: o limite não revela se um código existe", async () => {
  await clearLimits();
  const booking = await current.book();
  const invented = "ZZ99ZZ99";
  const run = async (code: string) => {
    const statuses: number[] = [];
    let last: Row = {};
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await handlePublicLookup(current.lookupDeps, lookupBody(nextCpf(), code), nextClient());
      statuses.push(response.status);
      last = { body: response.body, hasRetry: (response.retryAfterSeconds ?? 0) > 0 };
    }
    return { statuses, last };
  };
  const real = await run(booking.code);
  const fake = await run(invented);
  assert.deepEqual(real.statuses, fake.statuses, "mesma sequência: 10 × 404 e depois 429");
  assert.deepEqual(real.statuses, [...Array(10).fill(404), 429, 429]);
  assert.deepEqual(real.last, fake.last);
});

test("consulta: um endereço da Vercel que procura muitos códigos para em 30, troque o que trocar nos outros cabeçalhos", async () => {
  await clearLimits();
  const statuses: number[] = [];
  for (let attempt = 1; attempt <= 32; attempt += 1) {
    const client = trustedClientAddress(
      headers({ "x-vercel-forwarded-for": "203.0.113.77", "x-forwarded-for": `10.0.${attempt}.1`, "x-real-ip": `10.1.${attempt}.1` }),
      VERCEL,
    );
    const response = await handlePublicLookup(current.lookupDeps, lookupBody(nextCpf(), `VARRE${String(attempt).padStart(3, "0")}`), client);
    statuses.push(response.status);
  }
  assert.deepEqual(statuses, [...Array(30).fill(404), 429, 429]);
});

test("consulta: fora da Vercel, cabeçalhos trocados a cada tentativa não escapam do limite da credencial", async () => {
  await clearLimits();
  const booking = await current.book();
  const statuses: number[] = [];
  for (let attempt = 1; attempt <= 11; attempt += 1) {
    const client = trustedClientAddress(headers({ "x-real-ip": `203.0.113.${attempt}`, "x-vercel-forwarded-for": `198.51.100.${attempt}` }), {});
    statuses.push((await handlePublicLookup(current.lookupDeps, lookupBody(nextCpf(), booking.code), client)).status);
  }
  assert.deepEqual(statuses, [...Array(10).fill(404), 429]);
  assert.equal(
    (await current.fx.one(`select count(*)::int as n from public.customer_access_throttle where bucket like 'client:%'`)).n,
    0,
    "nenhum balde de origem nasceu de cabeçalho do cliente",
  );
});

// ===========================================================================
// 3. Baldes compartilhados entre os endpoints
// ===========================================================================

test("tentativas distribuídas entre consulta, tela e escolha do autoatendimento somam no mesmo balde", async () => {
  await clearLimits();
  const booking = await current.book(2);
  await current.fx.setStandby(booking.id);
  const credential = { cpf: nextCpf(), publicCode: booking.code };
  const standbyId = "0b5f4a52-2d1e-4b6a-9b1e-2f2d6c9f1a10";
  const sessionId = "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f";

  const statuses: number[] = [];
  for (let round = 0; round < 4; round += 1) {
    statuses.push((await handlePublicLookup(current.lookupDeps, lookupBody(credential.cpf, credential.publicCode), nextClient())).status);
    statuses.push((await handleSelfServiceOverview(current.selfServiceDeps, { credential }, nextClient())).status);
    statuses.push((await handleSelfServiceReschedule(current.selfServiceDeps, { credential, standbyId, sessionId }, nextClient())).status);
  }
  // 10 tentativas passam pelo limite (e falham pela credencial); da 11ª em diante, 429 em qualquer endpoint.
  assert.deepEqual(statuses.slice(0, 10).filter((status) => status === 429), []);
  assert.deepEqual(statuses.slice(10), [429, 429]);

  // O dono, com o CPF certo, também espera a janela — em qualquer endpoint.
  const owner = { cpf: booking.cpf, publicCode: booking.code };
  assert.equal((await handlePublicLookup(current.lookupDeps, lookupBody(owner.cpf, owner.publicCode), nextClient())).status, 429);
  assert.equal((await handleSelfServiceOverview(current.selfServiceDeps, { credential: owner }, nextClient())).status, 429);
  assert.equal((await current.fx.reservation(booking.id)).status, "AWAITING_RESCHEDULE");
});

test("o link tem balde próprio: travar o código não trava o link, e vice-versa", async () => {
  await clearLimits();
  const booking = await current.book(1);
  await current.fx.setStandby(booking.id);
  const token = (await current.fx.call(`public.admin_generate_reservation_standby_link($1::uuid, $2::uuid)`, [ADMIN, booking.id])).token as string;
  for (let attempt = 0; attempt < 11; attempt += 1) await handlePublicLookup(current.lookupDeps, lookupBody(nextCpf(), booking.code), nextClient());
  const viaLink = await handleSelfServiceOverview(current.selfServiceDeps, { credential: { token } }, nextClient());
  assert.equal(viaLink.status, 200, "o dono ainda entra pelo link");
});

// ===========================================================================
// 4. Antes da migration
// ===========================================================================

test("antes da migration: a consulta pública funciona exatamente como hoje; o autoatendimento fica fechado", async () => {
  const before = await setup(await fullDatabase({ until: PREVIOUS }));
  const booking = await before.book();

  const statuses: number[] = [];
  for (let attempt = 0; attempt < 15; attempt += 1) {
    statuses.push((await handlePublicLookup(before.lookupDeps, lookupBody(attempt === 14 ? booking.cpf : nextCpf(), booking.code), "203.0.113.5")).status);
  }
  assert.deepEqual(statuses, [...Array(14).fill(404), 200], "sem limite, como antes — e sem 429");
  assert.deepEqual(before.logged, [], "a função ausente não enche o log a cada consulta");

  const attempt = await registerAccessAttempt(before.lookupDeps.rpc, "203.0.113.5", { p_cpf: booking.cpf, p_public_code: booking.code, p_link_token: null });
  assert.deepEqual(attempt, { status: "UNAVAILABLE", reason: "MISSING" });

  const overview = await handleSelfServiceOverview(before.selfServiceDeps, { credential: { cpf: booking.cpf, publicCode: booking.code } }, "203.0.113.5");
  assert.deepEqual([overview.status, overview.body.code], [503, "UNAVAILABLE"]);
});

test("limite fora do ar por outro motivo: a consulta segue e registra só um símbolo; o autoatendimento fecha", async () => {
  await clearLimits();
  const booking = await current.book();
  current.logged.length = 0;
  current.admin.failRpc(ACCESS_ATTEMPT_RPC, { code: "57014", message: `canceling statement due to statement timeout ${booking.cpf}` }, 2);
  const looked = await handlePublicLookup(current.lookupDeps, lookupBody(booking.cpf, booking.code), nextClient());
  assert.equal(looked.status, 200);
  assert.deepEqual(current.logged, ["ACCESS_THROTTLE_UNAVAILABLE"]);
  const overview = await handleSelfServiceOverview(current.selfServiceDeps, { credential: { cpf: booking.cpf, publicCode: booking.code } }, nextClient());
  assert.equal(overview.status, 503);
  current.admin.clearFailures();
});

// ===========================================================================
// 5. Logs e respostas
// ===========================================================================

test("nenhum log e nenhuma resposta de erro carregam CPF, código, token ou mensagem do banco", async () => {
  await clearLimits();
  const booking = await current.book();
  const logged: string[] = [];
  const failing: PublicLookupDeps = {
    ...current.lookupDeps,
    lookup: async (cpf, code) => { throw new Error(`invalid input syntax for type uuid: "${cpf}" (${code})`); },
    logFailure: (symbol) => logged.push(symbol),
  };
  const failed = await handlePublicLookup(failing, lookupBody(booking.cpf, booking.code), nextClient());
  assert.deepEqual([failed.status, failed.body], [500, { message: LOOKUP_MESSAGES.FAILED }]);
  assert.deepEqual(logged, ["LOOKUP_FAILED"]);
  assert.equal(lookupFailureSymbol(new Error("ACCESS_THROTTLE_UNAVAILABLE")), "ACCESS_THROTTLE_UNAVAILABLE");
  assert.equal(lookupFailureSymbol(new Error(`erro com ${booking.cpf}`)), "LOOKUP_FAILED");

  const responses = [
    failed,
    await handlePublicLookup(current.lookupDeps, lookupBody(nextCpf(), booking.code), nextClient()),
    await handleSelfServiceOverview(current.selfServiceDeps, { credential: { cpf: booking.cpf, publicCode: booking.code } }, nextClient()),
    await handleSelfServiceOverview(current.selfServiceDeps, { credential: { token: "e".repeat(64) } }, nextClient()),
  ];
  for (let attempt = 0; attempt < 10; attempt += 1) responses.push(await handlePublicLookup(current.lookupDeps, lookupBody(booking.cpf, booking.code), nextClient()));
  assert.equal(responses.at(-1)?.status, 429);
  // A resposta 200 é a reserva do próprio dono, com o código — o contrato de sempre.
  for (const response of responses.filter((candidate) => candidate.status !== 200)) {
    const text = JSON.stringify(response.body);
    for (const secret of [booking.cpf, booking.code, "e".repeat(64)]) assert.ok(!text.includes(secret), `${response.status} vazou credencial`);
  }

  // O segredo do HMAC nunca sai do banco: nenhuma função devolve, e a service role não lê.
  const secret = (await current.fx.one(`select encode(secret, 'hex') as s from public.customer_access_throttle_secret`)).s as string;
  const attempt = await registerAccessAttempt(current.lookupDeps.rpc, "203.0.113.200", { p_cpf: null, p_public_code: "SEGREDO1", p_link_token: null });
  assert.ok(!JSON.stringify(attempt).includes(secret));
  assert.equal((await current.fx.one(`select has_table_privilege('service_role', 'public.customer_access_throttle_secret', 'SELECT') as can`)).can, false);
});

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("no código: as três rotas usam o endereço confiável e não registram nada da credencial", () => {
  const lookup = source("app/api/reservations/lookup/route.ts");
  assert.match(lookup, /trustedClientAddress\(request\.headers\)/);
  assert.match(lookup, /logFailure: \(symbol\) => console\.error\("Falha ao recuperar reserva:", symbol\)/);
  assert.equal((lookup.match(/console\./g) ?? []).length, 1, "um único log, só com o símbolo");
  assert.match(source("lib/reservations/standby-self-service-http.ts"), /trustedClientAddress\(request\.headers\)/);
  for (const path of ["app/api/reservations/standby/route.ts", "app/api/reservations/standby/reschedule/route.ts"]) {
    assert.match(source(path), /selfServiceClient\(request\)/);
    assert.doesNotMatch(source(path), /console\.|x-forwarded-for|x-real-ip/);
  }
  for (const path of ["lib/reservations/public-lookup.ts", "lib/reservations/standby-self-service.ts", "lib/reservations/access-throttle.ts"]) {
    assert.doesNotMatch(source(path), /console\./, `${path} não loga`);
    assert.doesNotMatch(source(path), /headers\.get\(/, `${path} não lê cabeçalho`);
  }
  // Ninguém mais lê os cabeçalhos de IP por conta própria.
  assert.doesNotMatch(source("lib/reservations/standby-self-service.ts"), /x-real-ip|x-forwarded-for/);
});
