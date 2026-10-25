/**
 * Lista de espera — fase 3: inscrição gratuita, e-mail de confirmação e saída
 * pelo link.
 *
 * Roda contra o Postgres em memória (PGlite) com **todas** as migrations. As
 * turmas esgotam pelo caminho real (pré-reserva e pagamento) e o fluxo do
 * servidor — `handleWaitlistSignup`, `handleWaitlistCancel*` e a fila do e-mail —
 * fala com as funções de verdade pelo formato `rpc(nome, argumentos)`. O
 * provedor é o falso que segue o contrato de idempotência do Resend: nenhum
 * e-mail sai, e `delivered` conta o que chegaria a uma caixa de entrada.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { EmailProviderError } from "../lib/email/email-provider.ts";
import { applyMigration, fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";
import { fakeResend, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";
import {
  buildWaitlistJoinedEmail,
  parseWaitlistJoinedEmailData,
  waitlistCancelUrl,
  WAITLIST_NOT_A_RESERVATION_NOTE,
} from "../lib/waitlist/joined-email-content.ts";
import {
  createWaitlistEmailQueue,
  followUpWaitlistJoinedEmail,
  retryPendingWaitlistEmails,
  sendWaitlistJoinedEmail,
  waitlistEmailIdempotencyKey,
  type WaitlistEmailRuntime,
} from "../lib/waitlist/joined-email.ts";
import {
  handleWaitlistCancel,
  handleWaitlistCancelOverview,
  handleWaitlistSignup,
  isWaitlistSignupEnabled,
  validateWaitlistSignup,
  waitlistTokenFromHash,
  type WaitlistSignupDeps,
} from "../lib/waitlist/signup.ts";

const MIGRATION = "202610250002_waitlist_signup_email.sql";
const PREVIOUS = "202610250001_waitlist_foundation.sql";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function code(path: string) {
  return source(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
}

const db = await fullDatabase();
const admin = createPgliteAdmin(db);
const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
const { one, rows, call, IMERSAO, makeSession, reserve, uniquePrice } = fx;
const rpc = (name: string, args: Record<string, unknown>) => admin.client.rpc(name, args);

const NEW_FUNCTIONS = [
  "claim_pending_waitlist_emails(integer,integer,integer,integer)",
  "claim_waitlist_joined_email(uuid,text,integer,integer,integer)",
  "complete_waitlist_email(uuid,uuid)",
  "fail_waitlist_email(uuid,uuid,text,text,integer)",
  "freeze_waitlist_email(uuid,uuid,jsonb)",
  "waitlist_notification_payload(uuid)",
  "waitlist_notification_rejection(uuid)",
  "waitlist_notification_take(uuid,integer,integer,integer)",
];
const SERVER_FUNCTIONS = new Set(NEW_FUNCTIONS.filter((name) => !name.startsWith("waitlist_notification_")));

// --- Cenários -----------------------------------------------------------------

let sequence = 0;

function person(overrides: Partial<{ fullName: string; email: string; phone: string }> = {}) {
  sequence += 1;
  return {
    fullName: `Clara Espera ${sequence}`,
    email: `inscrita${sequence}@teste.local`,
    phone: `(61) 9${String(8_100_0000 + sequence).slice(0, 4)}-${String(1000 + sequence).slice(-4)}`,
    ...overrides,
  };
}

async function soldOut(capacity = 2) {
  const session = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity });
  await reserve(session, capacity);
  return session;
}

function runtime(provider = fakeResend()): WaitlistEmailRuntime & { provider: ReturnType<typeof fakeResend> } {
  return { queue: createWaitlistEmailQueue({ rpc }), provider, wait: async () => undefined, origin: "https://www.almaazulacademy.com.br" };
}

type Harness = WaitlistSignupDeps & { tasks: Array<() => Promise<unknown>>; runAfter: () => Promise<void> };

function harness(active: WaitlistEmailRuntime = runtime()): Harness {
  const tasks: Array<() => Promise<unknown>> = [];
  return {
    rpc,
    sendConfirmation: (sessionId, email) => sendWaitlistJoinedEmail(active, sessionId, email),
    followUpConfirmation: (sessionId, email) => followUpWaitlistJoinedEmail(active, sessionId, email),
    afterResponse: (task) => { tasks.push(task); },
    tasks,
    async runAfter() { while (tasks.length) await tasks.shift()!(); },
  };
}

function signupBody(sessionId: string, who: ReturnType<typeof person>, quantity = 1, website = "") {
  return { sessionId, fullName: who.fullName, email: who.email, phone: who.phone, quantity, website };
}

async function notificationOf(sessionId: string, email: string) {
  return one(
    `select n.* from public.waitlist_notifications n join public.waitlist_entries we on we.id = n.entry_id
     where we.session_id = $1::uuid and we.email = $2 and n.kind = 'JOINED' order by n.created_at desc limit 1`,
    [sessionId, email.toLowerCase()],
  );
}

async function entryOf(sessionId: string, email: string) {
  return one(`select * from public.waitlist_entries where session_id = $1::uuid and email = $2 order by created_at desc limit 1`, [sessionId, email.toLowerCase()]);
}

async function release(notificationId: string) {
  await db.query(`update public.waitlist_notifications set next_attempt_at = now() - interval '1 second' where id = $1::uuid`, [notificationId]);
}

async function resetThrottle() {
  await db.exec(`delete from public.waitlist_throttle`);
}

// ===========================================================================
// 1. Variável e formato
// ===========================================================================

test("variável: a inscrição só existe com as duas variáveis ligadas", () => {
  assert.equal(isWaitlistSignupEnabled({}), false);
  assert.equal(isWaitlistSignupEnabled({ WAITLIST_SIGNUP_ENABLED: "true" }), false, "sem a exibição das esgotadas, não há onde se inscrever");
  assert.equal(isWaitlistSignupEnabled({ WAITLIST_PUBLIC_ENABLED: "true" }), false);
  assert.equal(isWaitlistSignupEnabled({ WAITLIST_PUBLIC_ENABLED: "true", WAITLIST_SIGNUP_ENABLED: "1" }), false);
  assert.equal(isWaitlistSignupEnabled({ WAITLIST_PUBLIC_ENABLED: "true", WAITLIST_SIGNUP_ENABLED: " TRUE " }), true);
  assert.equal(isWaitlistSignupEnabled({ WAITLIST_PUBLIC_ENABLED: "true", NEXT_PUBLIC_WAITLIST_SIGNUP_ENABLED: "true" }), false);
});

test("formato: nome, e-mail, WhatsApp e quantidade conferidos antes do banco", () => {
  const ok = validateWaitlistSignup({ sessionId: "6c212186-5809-4eb6-8f52-5c3bc6570d33", fullName: "  Ana   Souza ", email: " ANA@X.COM ", phone: "(61) 99999-0000", quantity: 2 });
  assert.ok(ok.success);
  assert.deepEqual(ok.data, { sessionId: "6c212186-5809-4eb6-8f52-5c3bc6570d33", fullName: "Ana Souza", email: "ana@x.com", phone: "+5561999990000", quantity: 2, trap: "" });
  const bad = validateWaitlistSignup({ sessionId: "x", fullName: "Ana", email: "a@", phone: "123", quantity: 21 });
  assert.ok(!bad.success);
  assert.deepEqual(Object.keys(bad.errors).sort(), ["email", "form", "fullName", "phone", "quantity"]);
  assert.equal(validateWaitlistSignup(null).success, false);
  assert.equal(waitlistTokenFromHash(`#t=${"A".repeat(64)}`), "a".repeat(64));
  assert.equal(waitlistTokenFromHash("#t=curto"), null);
  assert.equal(waitlistTokenFromHash(""), null);
});

// ===========================================================================
// 2. A migration
// ===========================================================================

test("migration: aditiva — nenhuma função existente muda, nem as da fase 1", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  const snapshot = async () => (await before.query<{ name: string; src: string }>(
    `select p.oid::regprocedure::text as name, md5(p.prosrc) as src from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`,
  )).rows;
  const old = await snapshot();
  await applyMigration(before, MIGRATION);
  const current = new Map((await snapshot()).map((row) => [row.name, row.src]));
  for (const row of old) assert.equal(current.get(row.name), row.src, `${row.name} não pode mudar`);
  assert.deepEqual([...current.keys()].filter((name) => !old.some((row) => row.name === name)).sort(), NEW_FUNCTIONS);
  await applyMigration(before, MIGRATION); // idempotente
  const triggers = (await before.query(`select count(*)::int as n from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and t.tgname ilike '%waitlist%' and c.relname not like 'waitlist\\_%'`)).rows[0] as Row;
  assert.equal(triggers.n, 0);
  await before.close();
});

test("migration: só a service role opera a fila; o núcleo e o payload ninguém alcança", async () => {
  for (const fn of NEW_FUNCTIONS) {
    const row = await one(
      `select has_function_privilege('anon', $1, 'EXECUTE') as anon, has_function_privilege('authenticated', $1, 'EXECUTE') as auth,
              has_function_privilege('service_role', $1, 'EXECUTE') as service, p.prosecdef as definer, p.proconfig as config
       from pg_proc p where p.oid = $1::regprocedure`,
      [`public.${fn}`],
    );
    assert.deepEqual([row.anon, row.auth, row.service], [false, false, SERVER_FUNCTIONS.has(fn)], fn);
    assert.equal(row.definer, true, fn);
    assert.ok((row.config as string[]).some((entry) => entry.startsWith("search_path=")), fn);
  }
  for (const table of ["waitlist_notifications", "waitlist_notification_attempts"]) {
    const row = await one(`select has_table_privilege('service_role', $1, 'SELECT') as s, has_table_privilege('anon', $1, 'SELECT') as a`, [`public.${table}`]);
    assert.deepEqual([row.s, row.a], [false, false], table);
  }
});

// ===========================================================================
// 3. Inscrição pelo fluxo do servidor
// ===========================================================================

test("inscrição: grava, responde sem dado pessoal e envia uma confirmação depois da resposta", async () => {
  await resetThrottle();
  const session = await soldOut();
  const active = runtime();
  const deps = harness(active);
  const who = person({ fullName: "Helena Sobrenome Secreto" });

  const response = await handleWaitlistSignup(deps, signupBody(session, who, 2), "203.0.113.70");
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "ACCEPTED");
  for (const leaked of [who.email, "Sobrenome", "Secreto", "+55", session]) assert.ok(!JSON.stringify(response.body).includes(leaked), leaked);

  assert.equal(active.provider.requests.length, 0, "nada sai antes da resposta");
  assert.equal(deps.tasks.length, 1);
  await deps.runAfter();

  assert.equal(active.provider.delivered.length, 1);
  const [message] = active.provider.delivered;
  assert.equal(message.to, who.email);
  assert.match(message.subject, /lista de espera/i);
  assert.match(message.text, /não garante vaga/);
  const entry = await entryOf(session, who.email);
  assert.equal(entry.quantity, 2);
  const notification = await notificationOf(session, who.email);
  assert.equal(notification.status, "SENT");
  assert.equal(notification.frozen_message, null, "a mensagem guardada some depois do envio");
  assert.equal(message.idempotencyKey, waitlistEmailIdempotencyKey(notification.id, 1));
});

test("inscrição repetida: mesma resposta e nenhum e-mail novo", async () => {
  await resetThrottle();
  const session = await soldOut();
  const active = runtime();
  const deps = harness(active);
  const who = person();
  const first = await handleWaitlistSignup(deps, signupBody(session, who), null);
  await deps.runAfter();
  const again = await handleWaitlistSignup(deps, signupBody(session, { ...who, email: who.email.toUpperCase() }, 2), null);
  await deps.runAfter();
  assert.deepEqual(again, first);
  assert.equal(active.provider.delivered.length, 1);
  assert.equal((await rows(`select id from public.waitlist_entries where session_id = $1::uuid`, [session])).length, 1);
});

test("campo isca: responde igual, não grava e não envia", async () => {
  await resetThrottle();
  const session = await soldOut();
  const active = runtime();
  const deps = harness(active);
  const response = await handleWaitlistSignup(deps, signupBody(session, person(), 1, "https://spam.example"), null);
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "ACCEPTED");
  assert.equal(deps.tasks.length, 0);
  assert.equal((await rows(`select id from public.waitlist_entries where session_id = $1::uuid`, [session])).length, 0);
  assert.equal(active.provider.requests.length, 0);
});

test("inscrição recusada: formato, turma com vaga, turma indisponível, limite e grupo maior que a turma", async () => {
  await resetThrottle();
  const deps = harness();
  const calls: string[] = [];
  const counting: WaitlistSignupDeps = { ...deps, rpc: (name, args) => { calls.push(name); return rpc(name, args); } };

  const invalid = await handleWaitlistSignup(counting, { sessionId: "x", fullName: "A", email: "b", phone: "1", quantity: 0 }, null);
  assert.equal(invalid.status, 400);
  assert.deepEqual(calls, [], "formato errado não chega ao banco");

  const open = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 5 });
  const withSpots = await handleWaitlistSignup(counting, signupBody(open, person()), null);
  assert.equal(withSpots.status, 409);
  assert.equal(withSpots.body.code, "NOT_SOLD_OUT");
  assert.equal(withSpots.body.reserveHref, `/reservar/${open}`);

  const unknown = await handleWaitlistSignup(counting, signupBody("00000000-0000-4000-8000-000000000000", person()), null);
  assert.deepEqual([unknown.status, unknown.body.code], [409, "SESSION_UNAVAILABLE"]);

  const small = await soldOut(2);
  const tooMany = await handleWaitlistSignup(counting, signupBody(small, person(), 3), null);
  assert.deepEqual([tooMany.status, Object.keys(tooMany.body.errors as object)], [400, ["quantity"]]);
  assert.equal(deps.tasks.length, 0, "nenhuma recusa dispara e-mail");

  await resetThrottle();
  const limited = await soldOut();
  for (let index = 0; index < 30; index += 1) await handleWaitlistSignup(counting, signupBody(limited, person()), "198.51.100.80");
  const blocked = await handleWaitlistSignup(counting, signupBody(limited, person()), "198.51.100.80");
  assert.equal(blocked.status, 429);
  assert.ok((blocked.retryAfterSeconds ?? 0) > 0);
  await resetThrottle();
});

test("banco fora do ar ou sem a função: 503, nunca sucesso", async () => {
  const broken: WaitlistSignupDeps = { ...harness(), rpc: async () => ({ data: null, error: { message: "function does not exist", code: "PGRST202" } }) };
  const response = await handleWaitlistSignup(broken, signupBody("6c212186-5809-4eb6-8f52-5c3bc6570d33", person()), null);
  assert.equal(response.status, 503);
  const thrown: WaitlistSignupDeps = { ...harness(), rpc: () => { throw new Error("rede"); } };
  assert.equal((await handleWaitlistSignup(thrown, signupBody("6c212186-5809-4eb6-8f52-5c3bc6570d33", person()), null)).status, 503);
});

// ===========================================================================
// 4. A fila do e-mail
// ===========================================================================

async function signedUp(capacity = 2) {
  await resetThrottle();
  const session = await soldOut(capacity);
  const who = person();
  const answer = await call(`public.waitlist_join($1::uuid, $2, $3, $4, 1, null, '')`, [session, who.fullName, who.email, `+5561${String(900000000 + sequence)}`]);
  assert.equal(answer.status, "ACCEPTED");
  return { session, who };
}

test("resultado desconhecido: a nova tentativa repete a mesma chave e a mesma mensagem — o cliente recebe uma vez", async () => {
  const { session, who } = await signedUp();
  const active = runtime();
  active.provider.next("accepted-then-timeout");
  const first = await sendWaitlistJoinedEmail(active, session, who.email);
  assert.equal(first.outcome, "PENDING");
  const notification = await notificationOf(session, who.email);
  assert.equal(notification.status, "FAILED");
  assert.equal(notification.generation_uncertain, true);
  assert.ok(notification.frozen_message);

  await release(notification.id);
  const second = await followUpWaitlistJoinedEmail(active, session, who.email, { attempts: 1, backoffSeconds: [0] });
  assert.equal(second.outcome, "SENT");
  assert.equal(active.provider.requests.length, 2);
  assert.equal(active.provider.requests[0].idempotencyKey, active.provider.requests[1].idempotencyKey);
  assert.equal(active.provider.requests[0].html, active.provider.requests[1].html);
  assert.equal(active.provider.deliveredTo(who.email).length, 1, "o provedor reconhece a repetição");
});

test("recusa comprovada: geração nova, chave nova", async () => {
  const { session, who } = await signedUp();
  const active = runtime();
  active.provider.next(new EmailProviderError("HTTP_429", true, "NOT_SENT"));
  assert.equal((await sendWaitlistJoinedEmail(active, session, who.email)).outcome, "PENDING");
  const notification = await notificationOf(session, who.email);
  assert.deepEqual([notification.status, notification.generation_uncertain], ["FAILED", false]);
  await release(notification.id);
  assert.equal((await sendWaitlistJoinedEmail(active, session, who.email)).outcome, "SENT");
  const keys = active.provider.requests.map((request) => request.idempotencyKey);
  assert.notEqual(keys[0], keys[1]);
  assert.equal((await notificationOf(session, who.email)).generation, 2);
});

test("chave recusada duas vezes na mesma geração: para em UNCERTAIN e nada mais sai sozinho", async () => {
  const { session, who } = await signedUp();
  const active = runtime();
  active.provider.next("accepted-then-timeout", "in-progress", "in-progress");
  await sendWaitlistJoinedEmail(active, session, who.email);
  const notification = await notificationOf(session, who.email);
  await release(notification.id);
  await sendWaitlistJoinedEmail(active, session, who.email);
  await release(notification.id);
  await sendWaitlistJoinedEmail(active, session, who.email);
  const after = await notificationOf(session, who.email);
  assert.equal(after.status, "UNCERTAIN");
  assert.equal(after.last_error_code, "IDEMPOTENCY_CONFLICT");
  assert.equal(after.frozen_message, null);
  const toThisClient = () => active.provider.requests.filter((request) => request.to === who.email).length;
  const requests = toThisClient();
  await release(notification.id);
  assert.equal((await sendWaitlistJoinedEmail(active, session, who.email)).outcome, "SKIPPED");
  await retryPendingWaitlistEmails(active);
  assert.equal(toThisClient(), requests);
});

test("janela de 23 horas vencida com resultado desconhecido: UNCERTAIN, sem reenvio às cegas", async () => {
  const { session, who } = await signedUp();
  const active = runtime();
  active.provider.next("lost");
  await sendWaitlistJoinedEmail(active, session, who.email);
  const notification = await notificationOf(session, who.email);
  await db.query(`update public.waitlist_notifications set generation_started_at = now() - interval '24 hours', next_attempt_at = now() - interval '1 second' where id = $1::uuid`, [notification.id]);
  assert.equal((await sendWaitlistJoinedEmail(active, session, who.email)).outcome, "SKIPPED");
  const after = await notificationOf(session, who.email);
  assert.deepEqual([after.status, after.last_error_code], ["UNCERTAIN", "IDEMPOTENCY_WINDOW_EXPIRED"]);
  assert.equal(active.provider.requests.length, 1);
});

test("prazo vencido no meio do envio: outra instância assume com a mesma mensagem", async () => {
  const { session, who } = await signedUp();
  const claim = await call(`public.claim_waitlist_joined_email($1::uuid, $2, 6, 2, 1380)`, [session, who.email]);
  assert.ok(claim);
  const message = { to: who.email, subject: "s", html: "<p>h</p>", text: "t" };
  assert.equal(await call(`public.freeze_waitlist_email($1::uuid, $2::uuid, $3::jsonb)`, [claim.notificationId, claim.claimToken, JSON.stringify(message)]), true);
  assert.equal(await call(`public.claim_waitlist_joined_email($1::uuid, $2, 6, 2, 1380)`, [session, who.email]), null, "envio em curso não é reivindicado de novo");

  await db.query(`update public.waitlist_notifications set locked_until = now() - interval '1 second' where id = $1::uuid`, [claim.notificationId]);
  const taken = await call(`public.claim_waitlist_joined_email($1::uuid, $2, 6, 2, 1380)`, [session, who.email]);
  assert.ok(taken);
  assert.deepEqual(taken.message, message, "a nova tentativa recebe a mensagem congelada");
  assert.equal(taken.generation, claim.generation);

  // A tentativa antiga responde depois, com sucesso: vale.
  assert.equal(await call(`public.complete_waitlist_email($1::uuid, $2::uuid)`, [claim.notificationId, claim.claimToken]), true);
  assert.equal((await notificationOf(session, who.email)).status, "SENT");
  // E a falha da tentativa nova, depois disso, não desfaz o envio.
  assert.equal(await call(`public.fail_waitlist_email($1::uuid, $2::uuid, 'TIMEOUT', 'UNKNOWN', 0)`, [taken.notificationId, taken.claimToken]), true);
  assert.equal((await notificationOf(session, who.email)).status, "SENT");
});

test("congelar: só a tentativa em curso, uma vez, e só para o e-mail da inscrição", async () => {
  const { session, who } = await signedUp();
  const claim = await call(`public.claim_waitlist_joined_email($1::uuid, $2, 6, 2, 1380)`, [session, who.email]);
  const freeze = (token: string, to: string) => call(`public.freeze_waitlist_email($1::uuid, $2::uuid, $3::jsonb)`, [claim.notificationId, token, JSON.stringify({ to, subject: "s", html: "h", text: "t" })]);
  assert.equal(await freeze(claim.claimToken, "outra@pessoa.local"), false);
  assert.equal(await freeze("00000000-0000-4000-8000-000000000000", who.email), false);
  assert.equal(await freeze(claim.claimToken, who.email.toUpperCase()), true);
  assert.equal(await freeze(claim.claimToken, who.email), false, "uma vez só");
});

test("só se ainda fizer sentido: cancelada, turma iniciada ou arquivada — descartada, nunca enviada", async () => {
  const active = runtime();
  const cancelled = await signedUp();
  const entry = await entryOf(cancelled.session, cancelled.who.email);
  await call(`public.waitlist_cancel($1, null)`, [await call(`public.waitlist_cancel_token($1::uuid)`, [entry.id])]);
  assert.equal((await sendWaitlistJoinedEmail(active, cancelled.session, cancelled.who.email)).outcome, "SKIPPED");
  assert.deepEqual(
    Object.values(await one(`select status, skip_reason from public.waitlist_notifications where entry_id = $1::uuid`, [entry.id])),
    ["SKIPPED", "ENTRY_CLOSED"],
  );

  const started = await signedUp();
  await db.query(`update public.sessions set starts_at = now() - interval '1 minute' where id = $1::uuid`, [started.session]);
  assert.equal((await sendWaitlistJoinedEmail(active, started.session, started.who.email)).outcome, "SKIPPED");
  assert.deepEqual(Object.values(await one(`select n.status, n.skip_reason from public.waitlist_notifications n join public.waitlist_entries we on we.id = n.entry_id where we.session_id = $1::uuid`, [started.session])), ["SKIPPED", "SESSION_STARTED"]);

  const archived = await signedUp();
  await db.query(`update public.sessions set status = 'ARCHIVED' where id = $1::uuid`, [archived.session]);
  assert.equal((await sendWaitlistJoinedEmail(active, archived.session, archived.who.email)).outcome, "SKIPPED");
  assert.deepEqual(Object.values(await one(`select n.status, n.skip_reason from public.waitlist_notifications n join public.waitlist_entries we on we.id = n.entry_id where we.session_id = $1::uuid`, [archived.session])), ["SKIPPED", "SESSION_UNAVAILABLE"]);
  assert.equal(active.provider.requests.length, 0);
});

test("tentativas esgotadas: a fila para sozinha", async () => {
  const { session, who } = await signedUp();
  const active = runtime();
  for (let index = 0; index < 8; index += 1) active.provider.next(new EmailProviderError("HTTP_500_X", true, "NOT_SENT"));
  for (let index = 0; index < 8; index += 1) {
    await sendWaitlistJoinedEmail(active, session, who.email);
    await release((await notificationOf(session, who.email)).id);
  }
  const notification = await notificationOf(session, who.email);
  assert.deepEqual([notification.status, notification.attempts], ["FAILED", 6]);
  assert.equal(active.provider.requests.length, 6);
  assert.equal((await rows(`select * from public.waitlist_notification_attempts where notification_id = $1::uuid`, [notification.id])).length, 6);
});

test("recuperação: a rotina envia o que ficou na fila, sem duplicar", async () => {
  const pending = await signedUp();
  const active = runtime();
  // O banco é compartilhado entre os testes: a rotina pega até 10 por vez, na
  // ordem da fila, até esvaziar.
  for (let round = 0; round < 20; round += 1) {
    const report = await retryPendingWaitlistEmails(active);
    assert.equal(report.outcome, "PROCESSED");
    if (report.processed === 0) break;
  }
  assert.equal(active.provider.deliveredTo(pending.who.email).length, 1);
  assert.equal((await retryPendingWaitlistEmails(active)).processed, 0, "nada mais a enviar");
  assert.equal(active.provider.deliveredTo(pending.who.email).length, 1);
});

test("só JOINED: avisos de vaga (fase 6) não são tocados por esta fila", async () => {
  const { session, who } = await signedUp();
  const entry = await entryOf(session, who.email);
  const opening = await one(`insert into public.waitlist_openings (session_id, spots_at_open) values ($1::uuid, 1) returning id`, [session]);
  const spot = await one(`insert into public.waitlist_notifications (entry_id, kind, opening_id, spots_at_queue) values ($1::uuid, 'SPOT_AVAILABLE', $2::uuid, 1) returning id`, [entry.id, opening.id]);
  const active = runtime();
  await retryPendingWaitlistEmails(active);
  assert.equal((await one(`select status from public.waitlist_notifications where id = $1::uuid`, [spot.id])).status, "QUEUED");
  assert.equal(await call(`public.waitlist_notification_take($1::uuid, 6, 2, 1380)`, [spot.id]), null);
  await db.query(`delete from public.waitlist_notifications where id = $1::uuid`, [spot.id]);
  await db.query(`delete from public.waitlist_openings where id = $1::uuid`, [opening.id]);
});

// ===========================================================================
// 5. Conteúdo do e-mail e o link de cancelamento
// ===========================================================================

test("e-mail: deixa claro que não reserva nem cobra, e o link do e-mail tira o cliente da lista", async () => {
  await resetThrottle();
  const session = await soldOut();
  const active = runtime();
  const deps = harness(active);
  const who = person({ fullName: "Bia <script>alert(1)</script> Mar" });
  await handleWaitlistSignup(deps, signupBody(session, who, 2), null);
  await deps.runAfter();
  const [message] = active.provider.delivered;
  assert.match(message.text, new RegExp(WAITLIST_NOT_A_RESERVATION_NOTE.slice(0, 40)));
  assert.match(message.text, /fica com quem concluir primeiro a reserva/);
  assert.doesNotMatch(message.html, /<script>/, "o nome é escapado");
  assert.doesNotMatch(message.text + message.html, /cpf|pix|pagamento confirmado|reserva confirmada/i);

  const link = /https:\/\/www\.almaazulacademy\.com\.br\/lista-de-espera#t=([0-9a-f]{64})/.exec(message.text);
  assert.ok(link, "o link vai no fragmento");
  assert.ok(message.html.includes(waitlistCancelUrl(link[1], "https://www.almaazulacademy.com.br")));

  const cancelDeps = { rpc };
  const overview = await handleWaitlistCancelOverview(cancelDeps, { token: link[1] }, null);
  assert.equal(overview.status, 200);
  assert.equal(overview.body.state, "ACTIVE");
  assert.equal(overview.body.quantity, 2);
  for (const leaked of [who.email, "Mar", session]) assert.ok(!JSON.stringify(overview.body).includes(leaked), leaked);

  assert.deepEqual((await handleWaitlistCancel(cancelDeps, { token: link[1] }, null)).body.state, "CANCELLED");
  assert.deepEqual((await handleWaitlistCancel(cancelDeps, { token: link[1] }, null)).body.state, "CANCELLED", "idempotente");
  assert.equal((await entryOf(session, who.email)).status, "CANCELLED");
});

test("cancelamento: token com formato errado nem chega ao banco; desconhecido responde igual", async () => {
  const calls: string[] = [];
  const deps = { rpc: (name: string, args: Record<string, unknown>) => { calls.push(name); return rpc(name, args); } };
  for (const body of [null, {}, { token: "curto" }, { token: "z".repeat(64) }]) {
    assert.equal((await handleWaitlistCancel(deps, body, null)).status, 404);
    assert.equal((await handleWaitlistCancelOverview(deps, body, null)).status, 404);
  }
  assert.deepEqual(calls, []);
  const unknown = await handleWaitlistCancel(deps, { token: "0".repeat(64) }, null);
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, (await handleWaitlistCancel(deps, { token: "curto" }, null)).body, "a mesma resposta");
});

test("conteúdo: payload incompleto não vira e-mail", () => {
  const base = { fullName: "Ana Souza", email: "ana@x.com", quantity: 1, experienceTitle: "Imersão", startsAt: "2026-11-07T12:00:00.000Z", baseName: "Lago Norte", cancelToken: "a".repeat(64) };
  assert.ok(parseWaitlistJoinedEmailData(base));
  for (const broken of [{ cancelToken: "x" }, { email: "" }, { quantity: 0 }, { startsAt: "ontem" }]) {
    assert.equal(parseWaitlistJoinedEmailData({ ...base, ...broken }), null, JSON.stringify(broken));
  }
  const email = buildWaitlistJoinedEmail(parseWaitlistJoinedEmailData(base)!, "https://www.almaazulacademy.com.br");
  assert.match(email.text, /Horário: 09:00/);
  assert.match(email.text, /Participantes: 1 pessoa/);
});

// ===========================================================================
// 6. Rotas e telas, no código-fonte
// ===========================================================================

test("rotas: inscrição atrás da variável; cancelamento só com origem; tudo sem cache e por POST", () => {
  const http = code("lib/waitlist/signup-http.ts");
  const signupGate = http.match(/export function waitlistSignupGate[\s\S]*?\n}\n/)?.[0] ?? "";
  const order = ["isWaitlistSignupEnabled()", "isSameOriginRequest(request)", "getSupabaseAdminClient()"].map((marker) => signupGate.indexOf(marker));
  assert.ok(order.every((index) => index > 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  const cancelGate = http.match(/export function waitlistCancelGate[\s\S]*?\n}\n/)?.[0] ?? "";
  assert.match(cancelGate, /isSameOriginRequest\(request\)/);
  assert.doesNotMatch(cancelGate, /isWaitlistSignupEnabled/, "links já enviados continuam valendo");
  assert.match(http, /"cache-control": "no-store"/);
  assert.match(http, /trustedClientAddress\(request\.headers\)/);
  for (const path of ["app/api/waitlist/route.ts", "app/api/waitlist/cancel/route.ts", "app/api/waitlist/cancel/overview/route.ts"]) {
    const route = code(path);
    assert.match(route, /export async function POST/, path);
    assert.doesNotMatch(route, /export async function GET/, path);
  }
});

test("nada de pagamento, reserva ou bloqueio de vaga em nenhum arquivo da lista", () => {
  const files = [
    "lib/waitlist/signup.ts", "lib/waitlist/signup-http.ts", "lib/waitlist/joined-email.ts", "lib/waitlist/joined-email-service.ts",
    "lib/waitlist/joined-email-content.ts", "app/api/waitlist/route.ts", "app/api/waitlist/cancel/route.ts", "app/api/waitlist/cancel/overview/route.ts",
    "app/lista-de-espera/page.tsx", "app/lista-de-espera/[sessionId]/page.tsx", "components/waitlist/waitlist-signup-form.tsx",
    "components/waitlist/waitlist-cancel.tsx", "components/waitlist/join-link.tsx",
  ];
  for (const path of files) {
    const file = code(path);
    assert.doesNotMatch(file, /create_pre_reservation|attach_payment_checkout|createCheckout|getPaymentProvider|confirm_reservation_payment|\/api\/reservations"/, path);
    assert.doesNotMatch(file, /NEXT_PUBLIC_WAITLIST/, path);
  }
  const migration = source(`supabase/migrations/${MIGRATION}`).split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
  assert.doesNotMatch(migration, /(insert into|update|delete from) public\.(reservations|sessions|payment_events|reservation_standby)\b/i);
  assert.doesNotMatch(migration, /cron\.|pg_net|create extension/i);
});

test("telas: botão só com a inscrição ligada; formulário com isca invisível; páginas fora da busca", () => {
  for (const path of ["components/sessions-section.tsx", "components/agenda-sessions.tsx", "app/reservar/[sessionId]/page.tsx", "components/reservation/reservation-form.tsx"]) {
    const file = code(path);
    const actions = file.match(/action=\{[^}]*\}/g) ?? [];
    assert.ok(actions.length >= 1, path);
    for (const action of actions) assert.match(action, /action=\{waitlistSignup \? <WaitlistJoinLink/, `${path}: ${action}`);
  }
  assert.match(code("components/sessions-section.tsx"), /waitlistSignup=\{isWaitlistSignupEnabled\(\)\}/);
  assert.match(code("components/agenda-sessions.tsx"), /const waitlistSignup = isWaitlistSignupEnabled\(\);/);

  const form = code("components/waitlist/waitlist-signup-form.tsx");
  assert.match(form, /name="website" type="text" tabIndex=\{-1\} autoComplete="off"/);
  assert.match(form, /aria-hidden="true" className="absolute -left-\[9999px\]/);
  for (const field of ["fullName", "phone", "email", "quantity"]) assert.match(form, new RegExp(`name="${field}"`));
  assert.match(form, /fetch\("\/api\/waitlist"/);

  const signupPage = code("app/lista-de-espera/[sessionId]/page.tsx");
  assert.match(signupPage, /if \(!isWaitlistSignupEnabled\(\)\) notFound\(\);/);
  assert.match(signupPage, /session && !isSessionBookable\(session\) \? \(/);
  for (const path of ["app/lista-de-espera/page.tsx", "app/lista-de-espera/[sessionId]/page.tsx"]) {
    assert.match(code(path), /robots: \{ index: false, follow: false \}/, path);
  }
  const cancel = code("components/waitlist/waitlist-cancel.tsx");
  assert.match(cancel, /waitlistTokenFromHash\(window\.location\.hash\)/);
  assert.match(cancel, /window\.history\.replaceState\(null, "", window\.location\.pathname\)/);
  assert.match(cancel, /onClick=\{confirm\}/, "cancelar exige um clique");
});

test("rotina diária recupera também a confirmação da lista, e vercel.json não muda", () => {
  const cron = code("app/api/cron/confirmation-emails/route.ts");
  assert.match(cron, /const waitlist = await retryPendingWaitlistConfirmationEmails\(\);/);
  assert.ok(cron.indexOf("retryPendingRescheduleConfirmationEmails()") < cron.indexOf("retryPendingWaitlistConfirmationEmails()"));
  assert.doesNotMatch(source("vercel.json"), /waitlist/i);
  assert.match(source(".env.example"), /^# WAITLIST_SIGNUP_ENABLED=true$/m);
});

// ===========================================================================
// 7. Preflight, postcheck e rollback
// ===========================================================================

const PREFLIGHT = readFileSync(new URL("../supabase/diagnostics/waitlist_signup_email_preflight.sql", import.meta.url), "utf8");
const POSTCHECK = readFileSync(new URL("../supabase/diagnostics/waitlist_signup_email_postcheck.sql", import.meta.url), "utf8");
const ROLLBACK = readFileSync(new URL("../supabase/rollback/202610250002_waitlist_signup_email.rollback.sql", import.meta.url), "utf8");

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
  assert.equal(post.get("FUNCOES_NOVAS_COM_A_DEFINICAO_DO_REPOSITORIO")?.result, "8 de 8");
  assert.equal(post.get("PERMISSOES_DAS_FUNCOES")?.result, "5 do servidor, 3 internas");
  for (const count of ["ASSINATURA_DAS_FUNCOES_EXISTENTES", "INSCRICOES_POR_STATUS", "FILA_DA_LISTA_POR_STATUS", "RESERVAS_POR_STATUS"]) {
    assert.equal(post.get(count)?.result, pre.get(count)?.result, count);
  }
  assert.equal((await report(before, PREFLIGHT)).get("OBJETOS_NOVOS_AINDA_AUSENTES")?.status, "ATENCAO");
  await before.close();
});

test("preflight: reprova se a inscrição da fase 1 estiver diferente do repositório", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  await before.exec(`create or replace function public.waitlist_cancel_token(p_entry_id uuid) returns text language sql stable security definer set search_path = public as $$ select 'x' $$`);
  const pre = await report(before, PREFLIGHT);
  assert.equal(pre.get("FUNCOES_DA_FASE_1_USADAS")?.status, "FALHOU");
  assert.match(pre.get("FUNCOES_DA_FASE_1_USADAS")!.result, /waitlist_cancel_token=DIFERENTE/);
  assert.equal(pre.get("WAITLIST_EMAIL_PREFLIGHT_OK")?.status, "FALHOU");
  await before.close();
});

test("rollback: remove só o que a migration criou; inscrições e fila ficam; reaplicar devolve tudo", async () => {
  const database = await fullDatabase();
  const local = await rescheduleFixtures(async (sql, params = []) => (await database.query(sql, params)).rows as Row[]);
  const session = await local.makeSession(local.IMERSAO.id, { price: local.uniquePrice(), capacity: 1 });
  await local.reserve(session, 1);
  await database.query(`select public.waitlist_join($1::uuid, 'Pessoa Rollback', 'rb@teste.local', '+5561999990000', 1, null, '')`, [session]);
  const functions = async () => (await database.query<{ name: string; src: string }>(`select p.oid::regprocedure::text as name, md5(p.prosrc) as src from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`)).rows;
  const beforeFunctions = await functions();
  await database.exec(ROLLBACK);
  const after = await functions();
  assert.deepEqual(beforeFunctions.filter((row) => !after.some((kept) => kept.name === row.name)).map((row) => row.name).sort(), NEW_FUNCTIONS);
  for (const row of after) assert.equal(row.src, beforeFunctions.find((old) => old.name === row.name)?.src, row.name);
  assert.equal((await database.query<{ n: number }>(`select count(*)::int as n from public.waitlist_notifications where status = 'QUEUED'`)).rows[0].n, 1);
  await assert.rejects(database.query(POSTCHECK), /does not exist/);
  await applyMigration(database, MIGRATION);
  assert.equal((await report(database, POSTCHECK)).get("WAITLIST_EMAIL_POSTCHECK_OK")?.status, "OK");
  await database.close();
});

test("a última migration é a desta fase", () => {
  const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((file) => file.endsWith(".sql")).sort();
  assert.equal(migrations.at(-1), MIGRATION);
});

