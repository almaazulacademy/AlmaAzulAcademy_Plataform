/**
 * E-mail de confirmação do reagendamento vindo de Stand-by (etapa 4).
 *
 * Roda contra um Postgres real em memória (PGlite) com todas as migrations
 * aplicadas. O fluxo de envio é o de produção — `reschedule-email.ts`, com a
 * fila de verdade — ligado a um provedor de e-mail falso, que só guarda as
 * mensagens.
 *
 * Nenhum teste fala com o Supabase de produção nem com o Resend. Nenhum e-mail
 * é enviado.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test, { beforeEach } from "node:test";

import { rescheduleEmailNotice } from "../lib/admin/standby.ts";
import { EmailProviderError, sanitizeEmailErrorCode, type EmailMessage } from "../lib/email/email-provider.ts";
import { ResendProvider, resendIdempotencyKey } from "../lib/email/resend.ts";
import {
  buildReservationConfirmationEmail,
  buildReservationRescheduleEmail,
  CANCELLATION_NOTE,
  MEETING_TOLERANCE_NOTE,
  parseReservationConfirmationData,
  RESCHEDULE_INTRO,
  RESCHEDULE_PAYMENT_HEADLINE,
  RESCHEDULE_PAYMENT_NOTE,
  RESCHEDULE_QR_NOTE,
  rescheduleConfirmationSubject,
  type ReservationConfirmationData,
} from "../lib/reservations/confirmation-email.ts";
import {
  canResendRescheduleEmail,
  createRescheduleEmailQueue,
  isRescheduleEmailEnabled,
  parseRescheduleEmailClaim,
  rescheduleEmailIdempotencyKey,
  rescheduleEmailSummary,
  resendRescheduleEmail,
  retryPendingRescheduleEmails,
  sendRescheduleEmailForChange,
  type RescheduleEmailRuntime,
} from "../lib/reservations/reschedule-email.ts";
import { applyMigration, fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";

const PANEL_MIGRATION = "202610140001_reservation_standby_admin_panel.sql";
const EMAIL_MIGRATION = "202610150001_reservation_reschedule_email.sql";

const QUEUE_FUNCTIONS = [
  "admin_claim_reservation_reschedule_email",
  "admin_reservation_reschedule_emails",
  "claim_pending_reservation_reschedule_emails",
  "claim_reservation_reschedule_email",
  "complete_reservation_reschedule_email",
  "fail_reservation_reschedule_email",
];
const INTERNAL_FUNCTIONS = [
  "enqueue_reservation_reschedule_email",
  "reservation_reschedule_email_payload",
  "reservation_reschedule_email_rejection",
  "reservation_reschedule_email_take",
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

const ADMIN = "c0000000-0000-4000-8000-000000000001";
const INSTRUCTOR = "c0000000-0000-4000-8000-000000000002";
const STRANGER = "c0000000-0000-4000-8000-000000000003";

await db.exec(`
  insert into auth.users (id, email) values
    ('${ADMIN}', 'admin@teste.local'), ('${INSTRUCTOR}', 'instrutor@teste.local'), ('${STRANGER}', 'estranho@teste.local');
  insert into public.admin_users (user_id, display_name, role, is_active) values
    ('${ADMIN}', 'Admin Teste', 'ADMIN', true),
    ('${INSTRUCTOR}', 'Instrutor Teste', 'INSTRUCTOR', true);
`);

// --- Catálogo e fábricas ------------------------------------------------------

async function experience(slug: string) {
  return one(
    `select e.id, e.title, b.slug as base_slug, b.name as base_name, b.address, b.meeting_point, b.maps_url
     from public.experiences e join public.bases b on b.id = e.base_id where e.slug = $1`,
    [slug],
  );
}

const IMERSAO = await experience("imersao-paranoa"); // Lago Norte
const SUNSET_CONCHA = await experience("remada-sunset-concha-acustica"); // Cápsula Bar — Concha Acústica

let sequence = 0;

/** Cada cenário usa um preço próprio: a régua do mesmo valor isola as turmas. */
function uniquePrice() {
  sequence += 1;
  return 40_000 + sequence * 100;
}

async function makeSession(experienceId: string, options: { price: number; capacity?: number; startsIn?: string }) {
  sequence += 1;
  const created = await one(
    `insert into public.sessions (experience_id, starts_at, duration_minutes, price_cents, capacity, status)
     values ($1::uuid, now() + $2::interval + make_interval(secs => $3), 90, $4, $5, 'OPEN')
     returning id`,
    [experienceId, options.startsIn ?? "10 days", sequence, options.price, options.capacity ?? 6],
  );
  return created.id as string;
}

type Booking = { id: string; cpf: string; code: string; total: number; quantity: number; name: string; email: string };

/** Reserva confirmada pelo caminho real de pagamento. */
async function reserve(sessionId: string, quantity = 2, name?: string): Promise<Booking> {
  sequence += 1;
  const cpf = String(30_000_000_000 + sequence);
  const fullName = name ?? `Cliente Reagendado ${sequence}`;
  const email = `reagendado${sequence}@teste.local`;
  const created = await call(
    `public.create_pre_reservation($1::uuid, $2, $3, $4, $5, $6, null, gen_random_uuid())`,
    [sessionId, fullName, cpf, `+55619${String(20_000_000 + sequence)}`, email, quantity],
  );
  const confirmed = await call(
    `public.confirm_reservation_payment($1::uuid, 'INFINITEPAY', $2, $3, 'https://recibo.teste/1', '{}'::jsonb)`,
    [created.reservationId, `tx-${cpf}`, created.totalCents],
  );
  assert.equal(confirmed, true);
  return { id: created.reservationId, cpf, code: created.publicCode, total: created.totalCents, quantity, name: fullName, email };
}

function setStandby(reservationId: string) {
  return call(`public.admin_set_reservation_standby($1::uuid, $2::uuid, 'Turma cancelada por mau tempo')`, [ADMIN, reservationId]);
}

/** O reagendamento que o painel usa. */
function reschedule(reservationId: string, sessionId: string) {
  return call(`public.admin_reschedule_standby_same_price($1::uuid, $2::uuid, $3::uuid, 'Cliente escolheu por telefone')`, [ADMIN, reservationId, sessionId]);
}

async function reservation(id: string) {
  return one(`select * from public.reservations where id = $1::uuid`, [id]);
}

function emails(reservationId: string) {
  return rows(`select * from public.reservation_reschedule_emails where reservation_id = $1::uuid order by created_at, id`, [reservationId]);
}

function attempts(emailId: string) {
  return rows(`select * from public.reservation_reschedule_email_attempts where email_id = $1::uuid order by attempt`, [emailId]);
}

async function queueSize() {
  return (await one(`select count(*)::int as n from public.reservation_reschedule_emails`)).n as number;
}

/**
 * Uma reserva confirmada, colocada em Stand-by e reagendada pelo painel para
 * uma turma de outra base. É o ponto de partida da maioria dos cenários.
 */
async function rescheduled(options: { quantity?: number; name?: string; targetExperienceId?: string } = {}) {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const destination = await makeSession(options.targetExperienceId ?? SUNSET_CONCHA.id, { price, startsIn: "14 days" });
  const booking = await reserve(origin, options.quantity ?? 2, options.name);
  await setStandby(booking.id);
  const resolution = await reschedule(booking.id, destination);
  const [queued] = await emails(booking.id);
  return { booking, origin, destination, price, resolution, emailId: queued.id as string, changeId: resolution.changeId as string };
}

// --- Fila e provedor de teste -------------------------------------------------

const MAX_ATTEMPTS = 3;
const LEASE_MINUTES = 15;

function claimFor(changeId: string) {
  return call(`public.claim_reservation_reschedule_email($1::uuid, $2, $3)`, [changeId, MAX_ATTEMPTS, LEASE_MINUTES]);
}

function claimPending(limit = 25) {
  return call(`public.claim_pending_reservation_reschedule_emails($1, $2, $3)`, [limit, MAX_ATTEMPTS, LEASE_MINUTES]);
}

function complete(emailId: string, token: string) {
  return call(`public.complete_reservation_reschedule_email($1::uuid, $2::uuid)`, [emailId, token]);
}

function fail(emailId: string, token: string, code: string) {
  return call(`public.fail_reservation_reschedule_email($1::uuid, $2::uuid, $3)`, [emailId, token, code]);
}

/** Simula a passagem do prazo de uma reivindicação. */
async function expireLease(emailId: string) {
  await db.query(`update public.reservation_reschedule_emails set locked_until = now() - interval '1 minute' where id = $1::uuid and status = 'SENDING'`, [emailId]);
}

/** Encerra tudo o que ficou aberto na fila: cada cenário começa com ela vazia. */
async function settleQueue() {
  await db.exec(`
    update public.reservation_reschedule_emails
    set status = 'SKIPPED', last_error_code = 'TEST_CLEANUP', locked_until = null
    where status in ('QUEUED', 'SENDING', 'FAILED');
  `);
}

beforeEach(settleQueue);

function fakeProvider() {
  const sent: EmailMessage[] = [];
  const failures: unknown[] = [];
  return {
    name: "FAKE",
    sent,
    /** As próximas chamadas falham com estes erros, na ordem. */
    failWith(...errors: unknown[]) {
      failures.push(...errors);
    },
    async send(message: EmailMessage) {
      const failure = failures.shift();
      if (failure) throw failure;
      sent.push(message);
    },
  };
}

function createRuntime() {
  const admin = createPgliteAdmin(db);
  const provider = fakeProvider();
  const logs: Row[] = [];
  const runtime: RescheduleEmailRuntime = {
    queue: createRescheduleEmailQueue(admin.client, { maxAttempts: MAX_ATTEMPTS, leaseMinutes: LEASE_MINUTES }),
    provider,
    sanitizeError: sanitizeEmailErrorCode,
    log: (fields) => logs.push(fields),
  };
  return { runtime, provider, admin, logs };
}

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function files(directory: string): string[] {
  return readdirSync(new URL(`../${directory}`, import.meta.url)).flatMap((entry) => {
    const path = `${directory}/${entry}`;
    return statSync(new URL(`../${path}`, import.meta.url)).isDirectory() ? files(path) : [path];
  });
}

// =============================================================================
// 1. Migration: aditiva, idempotente e sem tocar o que já existia
// =============================================================================

async function functionHashes(database: typeof db) {
  const result = await database.query(
    `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn, md5(p.prosrc) as hash
     from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`,
  );
  return new Map((result.rows as Row[]).map((row) => [row.fn as string, row.hash as string]));
}

async function schemaSnapshot(database: typeof db) {
  const tables = await database.query(`select tablename from pg_tables where schemaname = 'public' order by 1`);
  const triggers = await database.query(
    `select c.relname || '.' || t.tgname as name from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where not t.tgisinternal and c.relnamespace = 'public'::regnamespace order by 1`,
  );
  const constraints = await database.query(
    `select c.conrelid::regclass::text || '.' || c.conname || ':' || pg_get_constraintdef(c.oid) as name
     from pg_constraint c where c.connamespace = 'public'::regnamespace order by 1`,
  );
  return {
    tables: (tables.rows as Row[]).map((row) => row.tablename as string).sort(),
    triggers: (triggers.rows as Row[]).map((row) => row.name as string).sort(),
    constraints: (constraints.rows as Row[]).map((row) => row.name as string).sort(),
  };
}

test("a migration só acrescenta: duas tabelas, uma trigger e dez funções; nenhuma função anterior muda", async () => {
  const database = await fullDatabase({ until: PANEL_MIGRATION });
  const functionsBefore = await functionHashes(database);
  const schemaBefore = await schemaSnapshot(database);

  await applyMigration(database, EMAIL_MIGRATION);
  const functionsAfter = await functionHashes(database);
  const schemaAfter = await schemaSnapshot(database);

  for (const [fn, hash] of functionsBefore) assert.equal(functionsAfter.get(fn), hash, `${fn} não pode mudar`);
  const created = [...functionsAfter.keys()].filter((fn) => !functionsBefore.has(fn)).map((fn) => fn.replace(/\(.*$/, "")).sort();
  assert.deepEqual(created, [...QUEUE_FUNCTIONS, ...INTERNAL_FUNCTIONS].sort());

  assert.deepEqual(schemaAfter.tables.filter((table) => !schemaBefore.tables.includes(table)), [
    "reservation_reschedule_email_attempts",
    "reservation_reschedule_emails",
  ]);
  assert.deepEqual(schemaAfter.triggers.filter((trigger) => !schemaBefore.triggers.includes(trigger)), [
    "reservation_reschedule_emails.reservation_reschedule_emails_set_updated_at",
    "reservation_session_changes.reservation_session_changes_reschedule_email",
  ]);
  // Nenhuma constraint de tabela existente foi criada, removida ou alterada —
  // inclusive as da fila do e-mail de pagamento e da planilha.
  const untouched = (list: string[]) => list.filter((name) => !name.includes("reservation_reschedule_email"));
  assert.deepEqual(untouched(schemaAfter.constraints), untouched(schemaBefore.constraints));

  // Reaplicar não muda nada.
  await applyMigration(database, EMAIL_MIGRATION);
  assert.deepEqual(await schemaSnapshot(database), schemaAfter);
  assert.deepEqual([...(await functionHashes(database))], [...functionsAfter]);
});

test("a migration não substitui nenhuma função e não escreve em reserva, pagamento, sessão nem na fila do e-mail de pagamento", () => {
  const sql = source(`supabase/migrations/${EMAIL_MIGRATION}`).replace(/--.*$/gm, "");
  const replaced = [...sql.matchAll(/create or replace function public\.([a-z_]+)/g)].map((match) => match[1]).sort();
  assert.deepEqual(replaced, [...QUEUE_FUNCTIONS, ...INTERNAL_FUNCTIONS].sort());

  assert.doesNotMatch(sql, /integration_sync_jobs/, "a fila do e-mail de pagamento não é tocada");
  assert.doesNotMatch(sql, /payment_events/);
  assert.doesNotMatch(sql, /(update|delete from|insert into) public\.(reservations|sessions|experiences|reservation_standby|reservation_session_changes)\b/);
  assert.doesNotMatch(sql, /alter table public\.(reservations|sessions|reservation_standby|reservation_session_changes|integration_sync_jobs)\b/);
  assert.doesNotMatch(sql, /\b(commit|rollback)\b/i);
});

test("ninguém da API pública executa a fila; a service role só opera pelas seis RPCs e só lê as tabelas", async () => {
  for (const fn of [...QUEUE_FUNCTIONS, ...INTERNAL_FUNCTIONS]) {
    const access = await one(
      `select has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as service,
              p.prosecdef, p.proconfig
       from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`,
      [fn],
    );
    assert.equal(access.anon, false, `${fn}: anon`);
    assert.equal(access.authenticated, false, `${fn}: authenticated`);
    assert.equal(access.service, QUEUE_FUNCTIONS.includes(fn), `${fn}: service_role`);
    assert.equal(access.prosecdef, true, `${fn}: security definer`);
    assert.ok((access.proconfig as string[]).some((entry) => entry.startsWith("search_path=")), `${fn}: search_path fixo`);
  }

  for (const table of ["reservation_reschedule_emails", "reservation_reschedule_email_attempts"]) {
    const access = await one(
      `select c.relrowsecurity as rls,
              has_table_privilege('service_role', c.oid, 'SELECT') as service_select,
              has_table_privilege('service_role', c.oid, 'INSERT') or has_table_privilege('service_role', c.oid, 'UPDATE') or has_table_privilege('service_role', c.oid, 'DELETE') as service_write,
              has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'SELECT') as public_read,
              (select count(*)::int from pg_policy where polrelid = c.oid) as policies
       from pg_class c where c.oid = ('public.' || $1)::regclass`,
      [table],
    );
    assert.deepEqual(access, { rls: true, service_select: true, service_write: false, public_read: false, policies: 0 }, table);
  }
});

// =============================================================================
// 2. O evento: nasce com o reagendamento, e só com ele
// =============================================================================

test("reagendar pelo painel enfileira exatamente um e-mail, ligado àquele reagendamento", async () => {
  const before = await queueSize();
  const { booking, destination, resolution } = await rescheduled();

  assert.equal(await queueSize(), before + 1);
  const [queued, ...others] = await emails(booking.id);
  assert.deepEqual(others, []);
  assert.equal(queued.status, "QUEUED");
  assert.equal(queued.attempts, 0);
  assert.equal(queued.actor_type, "ADMIN");
  assert.equal(queued.change_id, resolution.changeId);
  assert.equal(queued.standby_id, resolution.standbyId);
  assert.equal(queued.target_session_id, destination);
  assert.equal(queued.sent_at, null);
  assert.deepEqual(await attempts(queued.id), []);

  // A linha do histórico é a do reagendamento vindo de Stand-by.
  const change = await one(`select origin, actor_type, standby_id from public.reservation_session_changes where id = $1::uuid`, [queued.change_id]);
  assert.deepEqual(change, { origin: "STANDBY_RESCHEDULE", actor_type: "ADMIN", standby_id: resolution.standbyId });
});

test("o reagendamento pelo cliente — CPF e código, ou link — enfileira do mesmo jeito", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const destination = await makeSession(IMERSAO.id, { price, startsIn: "20 days" });

  const byCode = await reserve(origin);
  await setStandby(byCode.id);
  const options = await call(`public.customer_reschedule_options($1, $2, null)`, [byCode.cpf, byCode.code]);
  const first = await call(`public.customer_reschedule_reservation($1, $2, null, $3::uuid, $4::uuid)`, [byCode.cpf, byCode.code, options.standbyId, destination]);
  const [queuedByCode, ...none] = await emails(byCode.id);
  assert.deepEqual(none, []);
  assert.equal(queuedByCode.actor_type, "CUSTOMER");
  assert.equal(queuedByCode.change_id, first.changeId);
  assert.equal(queuedByCode.status, "QUEUED");

  const byLink = await reserve(origin);
  await setStandby(byLink.id);
  const link = await call(`public.admin_generate_reservation_standby_link($1::uuid, $2::uuid)`, [ADMIN, byLink.id]);
  const linkOptions = await call(`public.customer_reschedule_options(null, null, $1)`, [link.token]);
  await call(`public.customer_reschedule_reservation(null, null, $1, $2::uuid, $3::uuid)`, [link.token, linkOptions.standbyId, destination]);
  const [queuedByLink, ...extra] = await emails(byLink.id);
  assert.deepEqual(extra, []);
  assert.equal(queuedByLink.actor_type, "CUSTOMER");
});

test("colocar em Stand-by, gerar link, revogar link e desfazer não enfileiram nada", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const booking = await reserve(origin);
  const before = await queueSize();

  await setStandby(booking.id);
  assert.equal(await queueSize(), before, "colocar em Stand-by");

  await call(`public.admin_generate_reservation_standby_link($1::uuid, $2::uuid)`, [ADMIN, booking.id]);
  assert.equal(await queueSize(), before, "gerar link");
  await call(`public.admin_generate_reservation_standby_link($1::uuid, $2::uuid)`, [ADMIN, booking.id]);
  assert.equal(await queueSize(), before, "substituir link");
  assert.equal(await call(`public.admin_revoke_reservation_standby_link($1::uuid, $2::uuid)`, [ADMIN, booking.id]), true);
  assert.equal(await queueSize(), before, "revogar link");

  const undone = await call(`public.admin_undo_reservation_standby($1::uuid, $2::uuid, 'Stand-by criado por engano')`, [ADMIN, booking.id]);
  assert.equal(undone.resolution, "RESTORED");
  assert.equal((await reservation(booking.id)).status, "CONFIRMED");
  assert.equal(await queueSize(), before, "desfazer o Stand-by");
  assert.deepEqual(await emails(booking.id), []);

  // O desfazer grava histórico — com outra origem, que a trigger ignora.
  const change = await one(`select origin from public.reservation_session_changes where id = $1::uuid`, [undone.changeId]);
  assert.equal(change.origin, "STANDBY_RESTORE");
});

test("o reagendamento administrativo tradicional continua sem e-mail", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const destination = await makeSession(IMERSAO.id, { price, startsIn: "12 days" });
  const booking = await reserve(origin);
  const before = await queueSize();

  await call(`public.admin_change_reservation_session($1::uuid, $2::uuid, $3::uuid, 'Troca direta')`, [ADMIN, booking.id, destination]);

  assert.equal((await reservation(booking.id)).session_id, destination);
  assert.equal(await queueSize(), before);
  assert.deepEqual(await emails(booking.id), []);
  const change = await one(`select origin, standby_id from public.reservation_session_changes where reservation_id = $1::uuid`, [booking.id]);
  assert.deepEqual(change, { origin: "DIRECT", standby_id: null });
});

test("a requisição repetida devolve o mesmo reagendamento e não cria um segundo evento", async () => {
  const { booking, destination, resolution } = await rescheduled();
  const before = await queueSize();

  for (let index = 0; index < 5; index += 1) {
    const replay = await reschedule(booking.id, destination);
    assert.equal(replay.replayed, true);
    assert.equal(replay.changeId, resolution.changeId, "a repetição devolve a mesma chave do e-mail");
  }
  // Outro destino sobre a mesma autorização é recusado — e também não enfileira.
  const other = await makeSession(IMERSAO.id, { price: (await reservation(booking.id)).unit_price_cents });
  await rejects(reschedule(booking.id, other), /STANDBY_ALREADY_USED/);

  assert.equal(await queueSize(), before);
  assert.equal((await emails(booking.id)).length, 1);
});

test("reagendamento recusado pela régua não enfileira: preço diferente, sem vaga, turma passada", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const otherPrice = await makeSession(IMERSAO.id, { price: price + 50 });
  const full = await makeSession(IMERSAO.id, { price, capacity: 1 });
  const booking = await reserve(origin, 2);
  await setStandby(booking.id);
  const before = await queueSize();

  await rejects(reschedule(booking.id, otherPrice), /PRICE_NOT_ELIGIBLE/);
  await rejects(reschedule(booking.id, full), /INSUFFICIENT_SPOTS/);
  await rejects(reschedule(booking.id, "00000000-0000-4000-8000-00000000dead"), /SESSION_NOT_FOUND/);

  assert.equal(await queueSize(), before);
  assert.equal((await reservation(booking.id)).status, "AWAITING_RESCHEDULE");
});

test("se a transação do reagendamento falhar depois de gravar o histórico, nada sobra — nem o e-mail", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const destination = await makeSession(IMERSAO.id, { price, startsIn: "9 days" });
  const booking = await reserve(origin);
  await setStandby(booking.id);
  const before = await queueSize();
  const changesBefore = (await one(`select count(*)::int as n from public.reservation_session_changes`)).n;

  // A auditoria é gravada depois do histórico, que é quando a trigger já
  // enfileirou. Uma falha ali precisa desfazer as duas coisas.
  await db.exec(`
    create function public.test_break_audit() returns trigger language plpgsql as $$
    begin
      if new.action = 'RESERVATION_STANDBY_RESCHEDULED' then raise exception 'AUDIT_DOWN'; end if;
      return new;
    end $$;
    create trigger test_break_audit before insert on public.admin_audit_log
      for each row execute function public.test_break_audit();
  `);
  try {
    await rejects(reschedule(booking.id, destination), /AUDIT_DOWN/);
  } finally {
    await db.exec(`drop trigger test_break_audit on public.admin_audit_log; drop function public.test_break_audit();`);
  }

  assert.equal(await queueSize(), before, "nenhuma linha na fila");
  assert.equal((await one(`select count(*)::int as n from public.reservation_session_changes`)).n, changesBefore, "nenhum histórico");
  const still = await reservation(booking.id);
  assert.equal(still.status, "AWAITING_RESCHEDULE");
  assert.equal(still.session_id, origin);

  // Sem reagendamento gravado não há o que reivindicar nem o que enviar.
  const { runtime, provider } = createRuntime();
  assert.deepEqual(await sendRescheduleEmailForChange(runtime, "00000000-0000-4000-8000-00000000beef"), { outcome: "SKIPPED" });
  assert.deepEqual(await retryPendingRescheduleEmails(runtime), { outcome: "PROCESSED", processed: 0, sent: 0 });
  assert.equal(provider.sent.length, 0);

  // E a mesma reserva reagenda normalmente depois.
  const done = await reschedule(booking.id, destination);
  assert.equal(done.replayed, false);
  assert.equal((await emails(booking.id)).length, 1);
});

test("se a fila não puder ser gravada, o reagendamento também não é", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const destination = await makeSession(IMERSAO.id, { price, startsIn: "9 days" });
  const booking = await reserve(origin);
  await setStandby(booking.id);

  await db.exec(`alter table public.reservation_reschedule_emails add constraint test_block check (actor_type <> 'ADMIN') not valid;`);
  try {
    await rejects(reschedule(booking.id, destination), /test_block/);
  } finally {
    await db.exec(`alter table public.reservation_reschedule_emails drop constraint test_block;`);
  }

  const still = await reservation(booking.id);
  assert.equal(still.status, "AWAITING_RESCHEDULE");
  assert.equal(still.session_id, origin);
  assert.deepEqual(await emails(booking.id), []);
});

test("cada reagendamento efetivo é um evento: a mesma reserva reagendada duas vezes tem dois e-mails", async () => {
  const { booking, price, emailId: firstEmail } = await rescheduled();
  const third = await makeSession(IMERSAO.id, { price, startsIn: "21 days" });

  await setStandby(booking.id);
  const second = await reschedule(booking.id, third);

  const queued = await emails(booking.id);
  assert.equal(queued.length, 2);
  assert.equal(queued[0].id, firstEmail);
  assert.equal(queued[1].change_id, second.changeId);
  assert.notEqual(queued[0].change_id, queued[1].change_id);
  assert.notEqual(queued[0].standby_id, queued[1].standby_id);
});

test("o e-mail de pagamento tem a fila dele, e o reagendamento não a lê nem a escreve", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const destination = await makeSession(IMERSAO.id, { price, startsIn: "11 days" });
  const booking = await reserve(origin);

  // O e-mail de pagamento já foi enviado para esta reserva.
  const paymentJob = await call(`public.claim_reservation_confirmation_email($1::uuid, 3)`, [booking.id]);
  await call(`public.complete_integration_sync_job($1::uuid)`, [paymentJob]);
  const jobs = () => rows(
    `select id, integration, entity_type, entity_id, operation, status, attempts, last_error_code, synced_at, updated_at
     from public.integration_sync_jobs where entity_id = $1::uuid`,
    [booking.id],
  );
  const before = await jobs();
  assert.equal(before.length, 1);
  assert.equal(before[0].status, "SYNCED");

  await setStandby(booking.id);
  const resolution = await reschedule(booking.id, destination);

  // 1. O e-mail de pagamento enviado não bloqueia o do reagendamento.
  const { runtime, provider } = createRuntime();
  assert.deepEqual(await sendRescheduleEmailForChange(runtime, resolution.changeId), { outcome: "SENT" });
  assert.equal(provider.sent.length, 1);
  assert.match(provider.sent[0].subject, /^Reagendamento confirmado — /);

  // 2. A linha do e-mail de pagamento continua byte a byte igual…
  assert.deepEqual(await jobs(), before);
  // 3. …e ele não pode ser reivindicado de novo: reagendar não reenvia o original.
  assert.equal(await call(`public.claim_reservation_confirmation_email($1::uuid, 3)`, [booking.id]), null);
  assert.deepEqual(await rows(`select * from public.claim_pending_confirmation_emails(25, 3, 15)`), []);
  // 4. Nenhuma integração nova apareceu na fila antiga.
  assert.deepEqual(
    (await rows(`select distinct integration from public.integration_sync_jobs order by 1`)).map((row) => row.integration),
    ["RESERVATION_CONFIRMATION_EMAIL"],
  );

  // No código: o módulo do reagendamento não conhece a fila nem as RPCs do e-mail de pagamento.
  for (const path of ["lib/reservations/reschedule-email.ts", "lib/reservations/reschedule-email-service.ts"]) {
    const code = source(path).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.doesNotMatch(code, /integration_sync_jobs|claim_reservation_confirmation_email|claim_pending_confirmation_emails|complete_integration_sync_job|fail_integration_sync_job|RESERVATION_CONFIRMATION_EMAIL|sendReservationConfirmationEmail|buildReservationConfirmationEmail/, path);
  }
});

// =============================================================================
// 3. Reivindicação: um envio por vez, uma vez só
// =============================================================================

test("a reivindicação devolve o conteúdo da turma nova e ninguém mais reivindica enquanto ela vale", async () => {
  const { booking, destination, emailId, changeId } = await rescheduled({ quantity: 3, name: "Marina Albuquerque" });

  const claim = await claimFor(changeId);
  assert.equal(claim.emailId, emailId);
  assert.equal(claim.attempt, 1);
  assert.equal(claim.reservationId, booking.id);
  assert.match(claim.claimToken, /^[0-9a-f-]{36}$/);

  const target = await one(`select starts_at from public.sessions where id = $1::uuid`, [destination]);
  const stored = await reservation(booking.id);
  assert.equal(claim.payload.status, "CONFIRMED");
  assert.equal(claim.payload.publicCode, booking.code);
  assert.equal(claim.payload.fullName, "Marina Albuquerque");
  assert.equal(claim.payload.email, booking.email);
  assert.equal(claim.payload.quantity, 3);
  assert.equal(claim.payload.experienceTitle, SUNSET_CONCHA.title);
  assert.equal(new Date(claim.payload.startsAt).getTime(), new Date(target.starts_at).getTime());
  assert.equal(claim.payload.baseName, SUNSET_CONCHA.base_name);
  assert.equal(claim.payload.address, SUNSET_CONCHA.address);
  assert.equal(claim.payload.mapsUrl, SUNSET_CONCHA.maps_url);
  assert.equal(claim.payload.checkinToken, stored.checkin_token);
  assert.equal(claim.payload.changeId, changeId);
  // Nada além do necessário para escrever a mensagem.
  for (const forbidden of ["cpf", "cpfHash", "cpf_hash", "cpfLast4", "phone", "checkoutUrl", "providerReference", "totalCents", "unitPriceCents"]) {
    assert.ok(!(forbidden in claim.payload), `${forbidden} não pode estar no payload`);
  }

  const [row] = await emails(booking.id);
  assert.equal(row.status, "SENDING");
  assert.equal(row.attempts, 1);
  assert.ok(new Date(row.locked_until).getTime() > Date.now());
  assert.deepEqual((await attempts(emailId)).map((item) => [item.attempt, item.source, item.outcome]), [[1, "RESCHEDULE", null]]);

  // Enquanto o prazo vale: nem de novo pelo reagendamento, nem pela rotina, nem pelo painel.
  assert.equal(await claimFor(changeId), null);
  assert.deepEqual(await claimPending(), []);
  assert.equal(await call(`public.admin_claim_reservation_reschedule_email($1::uuid, $2::uuid, 15)`, [ADMIN, booking.id]), null);
  assert.equal((await emails(booking.id))[0].attempts, 1);

  // Concluído: definitivo.
  assert.equal(await complete(emailId, claim.claimToken), true);
  const [sent] = await emails(booking.id);
  assert.equal(sent.status, "SENT");
  assert.ok(sent.sent_at);
  assert.equal(sent.locked_until, null);
  assert.equal(await claimFor(changeId), null);
  assert.deepEqual(await claimPending(), []);
  assert.equal(await call(`public.admin_claim_reservation_reschedule_email($1::uuid, $2::uuid, 15)`, [ADMIN, booking.id]), null);
  assert.deepEqual((await attempts(emailId)).map((item) => [item.attempt, item.outcome]), [[1, "SENT"]]);
});

test("reivindicações simultâneas — do reagendamento, da rotina e do painel — terminam em uma só", async () => {
  const { booking, changeId } = await rescheduled();

  const results = await Promise.all([
    claimFor(changeId),
    claimPending(),
    claimFor(changeId),
    call(`public.admin_claim_reservation_reschedule_email($1::uuid, $2::uuid, 15)`, [ADMIN, booking.id]),
    claimPending(),
    claimFor(changeId),
    claimFor(changeId),
  ]);
  const obtained = results.flatMap((result) => (Array.isArray(result) ? result : result ? [result] : []));

  assert.equal(obtained.length, 1, "exatamente um chamador recebe o direito de enviar");
  const [row] = await emails(booking.id);
  assert.equal(row.status, "SENDING");
  assert.equal(row.attempts, 1);
  assert.equal((await attempts(row.id)).length, 1);
});

test("a ordem de travas da reivindicação: a linha da fila é travada antes de qualquer decisão", () => {
  const sql = source(`supabase/migrations/${EMAIL_MIGRATION}`);
  const take = sql.slice(sql.indexOf("create or replace function public.reservation_reschedule_email_take"), sql.indexOf("-- 5. Operações da fila"));
  const lock = take.indexOf("from public.reservation_reschedule_emails where id = p_email_id for update");
  assert.ok(lock > 0);
  for (const decision of ["queued.status in ('SENT', 'SKIPPED')", "queued.locked_until > now()", "reservation_reschedule_email_rejection", "insert into public.reservation_reschedule_email_attempts", "set status = 'SENDING'"]) {
    assert.ok(take.indexOf(decision) > lock, `${decision} vem depois do lock`);
  }
  // A rotina nunca espera por uma linha que outra execução já pegou.
  assert.match(sql, /order by q\.created_at, q\.id\s+limit [^\n]+\s+for update skip locked/);
  // Concluir e falhar travam a mesma linha antes de olhar para a tentativa.
  for (const fn of ["complete_reservation_reschedule_email", "fail_reservation_reschedule_email"]) {
    const body = sql.slice(sql.indexOf(`create or replace function public.${fn}`));
    assert.ok(body.indexOf("where id = p_email_id for update") < body.indexOf("reservation_reschedule_email_attempts a"), fn);
  }
});

test("falha: o erro é registrado como símbolo curto, a tentativa volta à fila e o teto de tentativas é respeitado", async () => {
  const { booking, emailId, changeId } = await rescheduled();

  const first = await claimFor(changeId);
  // Mesmo que a aplicação mandasse a resposta inteira do provedor, nenhum pedaço dela é gravado.
  assert.equal(await fail(emailId, first.claimToken, 'http 422: {"message":"domain not verified","to":"cliente@exemplo.com"}'), true);
  let [row] = await emails(booking.id);
  assert.equal(row.status, "FAILED");
  assert.equal(row.last_error_code, "UNKNOWN_ERROR");
  assert.equal(row.locked_until, null);

  // Falhou: volta à fila na hora, sem esperar prazo.
  const second = await claimPending();
  assert.equal(second.length, 1);
  assert.equal(second[0].attempt, 2);
  await fail(emailId, second[0].claimToken, " http_429 ");

  const third = await claimFor(changeId);
  assert.equal(third.attempt, 3);
  await fail(emailId, third.claimToken, "TIMEOUT");

  // Três tentativas: para de tentar sozinho.
  assert.equal(await claimFor(changeId), null);
  assert.deepEqual(await claimPending(), []);
  [row] = await emails(booking.id);
  assert.equal(row.status, "FAILED");
  assert.equal(row.attempts, 3);
  assert.equal(row.last_error_code, "TIMEOUT");
  assert.deepEqual(
    (await attempts(emailId)).map((item) => [item.attempt, item.source, item.outcome, item.error_code]),
    [
      [1, "RESCHEDULE", "FAILED", "UNKNOWN_ERROR"],
      [2, "RETRY", "FAILED", "HTTP_429"],
      [3, "RESCHEDULE", "FAILED", "TIMEOUT"],
    ],
  );
  for (const item of await attempts(emailId)) assert.ok(item.finished_at);
});

test("depois do teto, só uma pessoa da equipe reenvia — e isso fica na auditoria", async () => {
  const { booking, emailId, changeId } = await rescheduled();
  for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
    const claim = await claimFor(changeId);
    await fail(emailId, claim.claimToken, "HTTP_500");
  }
  assert.equal(await claimFor(changeId), null);

  await rejects(call(`public.admin_claim_reservation_reschedule_email($1::uuid, $2::uuid, 15)`, [INSTRUCTOR, booking.id]), /ADMIN_FORBIDDEN/);
  await rejects(call(`public.admin_claim_reservation_reschedule_email($1::uuid, $2::uuid, 15)`, [STRANGER, booking.id]), /ADMIN_FORBIDDEN/);
  await rejects(call(`public.admin_reservation_reschedule_emails($1::uuid, $2::uuid)`, [INSTRUCTOR, booking.id]), /ADMIN_FORBIDDEN/);
  assert.equal((await emails(booking.id))[0].attempts, MAX_ATTEMPTS, "quem não é da equipe não gasta tentativa");

  const manual = await call(`public.admin_claim_reservation_reschedule_email($1::uuid, $2::uuid, 15)`, [ADMIN, booking.id]);
  assert.equal(manual.attempt, MAX_ATTEMPTS + 1);
  const last = (await attempts(emailId)).at(-1)!;
  assert.equal(last.source, "ADMIN");
  assert.equal(last.actor_user_id, ADMIN);

  const audit = await rows(
    `select actor_user_id, entity_id, metadata from public.admin_audit_log where action = 'RESERVATION_RESCHEDULE_EMAIL_RESEND' and entity_id = $1::uuid`,
    [booking.id],
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_user_id, ADMIN);
  assert.deepEqual(audit[0].metadata, { emailId, attempt: MAX_ATTEMPTS + 1 });

  assert.equal(await complete(emailId, manual.claimToken), true);
  assert.equal((await emails(booking.id))[0].status, "SENT");
  // Enviado: o painel não reenvia.
  assert.equal(await call(`public.admin_claim_reservation_reschedule_email($1::uuid, $2::uuid, 15)`, [ADMIN, booking.id]), null);
  const state = await call(`public.admin_reservation_reschedule_emails($1::uuid, $2::uuid)`, [ADMIN, booking.id]);
  assert.equal(state.length, 1);
  assert.equal(state[0].status, "SENT");
  assert.equal(state[0].attempts, MAX_ATTEMPTS + 1);
  assert.deepEqual(Object.keys(state[0]).sort(), ["actorType", "attempts", "changeId", "createdAt", "emailId", "inFlight", "lastAttemptAt", "lastErrorCode", "sentAt", "standbyId", "status"]);
});

test("instância que morre no meio do envio: o prazo vence, a tentativa fica registrada e outra assume", async () => {
  const { booking, emailId, changeId } = await rescheduled();

  const lost = await claimFor(changeId);
  assert.deepEqual(await claimPending(), [], "dentro do prazo, ninguém assume");

  await expireLease(emailId);
  const retaken = await claimPending();
  assert.equal(retaken.length, 1);
  assert.equal(retaken[0].attempt, 2);
  assert.notEqual(retaken[0].claimToken, lost.claimToken);
  assert.deepEqual((await attempts(emailId)).map((item) => [item.attempt, item.outcome]), [[1, "LEASE_EXPIRED"], [2, null]]);

  // A falha tardia da tentativa antiga não solta o envio que está em curso.
  assert.equal(await fail(emailId, lost.claimToken, "TIMEOUT"), true);
  let [row] = await emails(booking.id);
  assert.equal(row.status, "SENDING");
  assert.equal(row.attempts, 2);
  assert.deepEqual((await attempts(emailId)).map((item) => [item.attempt, item.outcome, item.error_code]), [[1, "FAILED", "TIMEOUT"], [2, null, null]]);
  assert.equal(await claimFor(changeId), null);

  assert.equal(await complete(emailId, retaken[0].claimToken), true);
  [row] = await emails(booking.id);
  assert.equal(row.status, "SENT");

  // Um token que nunca existiu não conclui nem falha nada.
  assert.equal(await complete(emailId, "00000000-0000-4000-8000-000000000000"), false);
  assert.equal(await fail(emailId, "00000000-0000-4000-8000-000000000000", "X"), false);
  // E uma falha tardia não desfaz um envio concluído.
  assert.equal(await fail(emailId, retaken[0].claimToken, "HTTP_500"), false);
  assert.equal((await emails(booking.id))[0].status, "SENT");
});

test("a tentativa que respondeu depois do prazo e deu certo encerra o e-mail: ninguém mais envia", async () => {
  const { booking, emailId, changeId } = await rescheduled();

  const slow = await claimFor(changeId);
  await expireLease(emailId);
  const second = await claimFor(changeId);
  assert.equal(second.attempt, 2);

  // A primeira, lenta, conclui: o e-mail saiu.
  assert.equal(await complete(emailId, slow.claimToken), true);
  let [row] = await emails(booking.id);
  assert.equal(row.status, "SENT");
  assert.equal(row.locked_until, null);

  // A segunda falha (o provedor recusou a duplicata, por exemplo): o e-mail continua enviado.
  assert.equal(await fail(emailId, second.claimToken, "HTTP_409"), true);
  [row] = await emails(booking.id);
  assert.equal(row.status, "SENT");
  assert.equal(row.last_error_code, null);
  assert.equal(await claimFor(changeId), null);
  assert.deepEqual(await claimPending(), []);
  assert.deepEqual((await attempts(emailId)).map((item) => [item.attempt, item.outcome]), [[1, "SENT"], [2, "FAILED"]]);
});

test("prazo vencido na última tentativa vira erro visível, e não um envio preso para sempre", async () => {
  const { booking, emailId, changeId } = await rescheduled();
  for (let index = 0; index < MAX_ATTEMPTS - 1; index += 1) {
    const claim = await claimFor(changeId);
    await fail(emailId, claim.claimToken, "HTTP_500");
  }
  const last = await claimFor(changeId);
  assert.equal(last.attempt, MAX_ATTEMPTS);
  await expireLease(emailId);

  assert.deepEqual(await claimPending(), []);
  let [row] = await emails(booking.id);
  assert.equal(row.status, "FAILED");
  assert.equal(row.last_error_code, "LEASE_EXPIRED");
  assert.equal(row.attempts, MAX_ATTEMPTS);
  assert.equal((await attempts(emailId)).at(-1)!.outcome, "LEASE_EXPIRED");

  // O erro real, quando chega atrasado, substitui o "prazo vencido".
  assert.equal(await fail(emailId, last.claimToken, "NETWORK_ERROR"), true);
  [row] = await emails(booking.id);
  assert.equal(row.status, "FAILED");
  assert.equal(row.last_error_code, "NETWORK_ERROR");
});

test("a rotina pega o que nunca foi tentado, o que falhou e o que venceu — respeitando o limite e a ordem", async () => {
  const never = await rescheduled();
  const failed = await rescheduled();
  const stale = await rescheduled();
  const inFlight = await rescheduled();

  const failedClaim = await claimFor(failed.changeId);
  await fail(failed.emailId, failedClaim.claimToken, "HTTP_500");
  await claimFor(stale.changeId);
  await expireLease(stale.emailId);
  await claimFor(inFlight.changeId);

  const firstBatch = await claimPending(2);
  assert.deepEqual(firstBatch.map((claim: Row) => claim.emailId), [never.emailId, failed.emailId], "a mais antiga primeiro");
  const secondBatch = await claimPending(10);
  assert.deepEqual(secondBatch.map((claim: Row) => claim.emailId), [stale.emailId]);
  assert.deepEqual(await claimPending(10), [], "o envio em curso não é atropelado");
  assert.deepEqual(await claimPending(0), []);
});

// =============================================================================
// 4. O e-mail só sai se ainda descrever a reserva
// =============================================================================

test("reserva que voltou ao Stand-by, foi reagendada de novo ou trocou de turma: o e-mail antigo não sai", async () => {
  // a) Voltou ao Stand-by antes do envio.
  const parked = await rescheduled();
  await setStandby(parked.booking.id);
  assert.equal(await claimFor(parked.changeId), null);
  let [row] = await emails(parked.booking.id);
  assert.deepEqual([row.status, row.last_error_code, row.attempts], ["SKIPPED", "RESERVATION_NOT_CONFIRMED", 0]);

  // b) Reagendada de novo, para a MESMA turma: sem a regra, sairiam dois e-mails iguais.
  const twice = await rescheduled();
  await setStandby(twice.booking.id);
  await reschedule(twice.booking.id, twice.destination);
  const queued = await emails(twice.booking.id);
  assert.equal(queued.length, 2);
  assert.equal(queued[0].target_session_id, queued[1].target_session_id, "mesma turma, dois reagendamentos");
  assert.equal(await claimFor(queued[0].change_id), null);
  const latest = await claimFor(queued[1].change_id);
  assert.equal(latest.emailId, queued[1].id);
  const after = await emails(twice.booking.id);
  assert.deepEqual([after[0].status, after[0].last_error_code], ["SKIPPED", "SUPERSEDED"]);
  assert.equal(after[1].status, "SENDING");

  // c) Troca administrativa tradicional depois do reagendamento.
  const moved = await rescheduled();
  const elsewhere = await makeSession(IMERSAO.id, { price: moved.price, startsIn: "30 days" });
  await call(`public.admin_change_reservation_session($1::uuid, $2::uuid, $3::uuid, null)`, [ADMIN, moved.booking.id, elsewhere]);
  assert.equal(await claimFor(moved.changeId), null);
  [row] = await emails(moved.booking.id);
  assert.deepEqual([row.status, row.last_error_code], ["SKIPPED", "SUPERSEDED"]);
  assert.equal((await emails(moved.booking.id)).length, 1, "a troca tradicional não enfileira outro");
});

test("reserva cancelada depois do reagendamento não recebe o e-mail em uma tentativa posterior", async () => {
  const { booking, emailId, changeId } = await rescheduled();
  const first = await claimFor(changeId);
  await fail(emailId, first.claimToken, "HTTP_500");

  assert.equal(await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Cliente desistiu')`, [ADMIN, booking.id]), true);

  const { runtime, provider } = createRuntime();
  assert.deepEqual(await retryPendingRescheduleEmails(runtime), { outcome: "PROCESSED", processed: 0, sent: 0 });
  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, booking.id), { outcome: "SKIPPED" });
  assert.equal(provider.sent.length, 0);
  const [row] = await emails(booking.id);
  assert.deepEqual([row.status, row.last_error_code, row.attempts], ["SKIPPED", "RESERVATION_NOT_CONFIRMED", 1]);
});

test("turma que já começou: o e-mail atrasado não sai", async () => {
  const { booking, destination, emailId, changeId } = await rescheduled();
  const first = await claimFor(changeId);
  await fail(emailId, first.claimToken, "TIMEOUT");

  // A rotina só roda depois de a turma ter acontecido.
  await db.query(`update public.sessions set starts_at = now() - interval '2 hours' where id = $1::uuid`, [destination]);

  const { runtime, provider } = createRuntime();
  assert.deepEqual(await retryPendingRescheduleEmails(runtime), { outcome: "PROCESSED", processed: 0, sent: 0 });
  assert.equal(provider.sent.length, 0);
  const [row] = await emails(booking.id);
  assert.deepEqual([row.status, row.last_error_code], ["SKIPPED", "SESSION_STARTED"]);
  // SKIPPED é definitivo: nem a rotina nem o painel o reabrem.
  assert.deepEqual(await claimPending(), []);
  assert.equal(await call(`public.admin_claim_reservation_reschedule_email($1::uuid, $2::uuid, 15)`, [ADMIN, booking.id]), null);
});

// =============================================================================
// 5. Fluxo completo: reagendou, enviou
// =============================================================================

test("reagendamento confirmado no banco envia um e-mail, com a turma nova e a chave do reagendamento", async () => {
  const { booking, destination, emailId, changeId } = await rescheduled({ quantity: 3, name: "Marina <b>Albuquerque</b>" });
  const { runtime, provider, logs } = createRuntime();

  assert.deepEqual(await sendRescheduleEmailForChange(runtime, changeId), { outcome: "SENT" });

  assert.equal(provider.sent.length, 1);
  const [message] = provider.sent;
  assert.equal(message.to, booking.email);
  assert.equal(message.subject, `Reagendamento confirmado — ${booking.code}`);
  assert.equal(message.idempotencyKey, `reschedule-confirmation/${emailId}`);

  const target = await one(`select starts_at from public.sessions where id = $1::uuid`, [destination]);
  const expected = buildReservationRescheduleEmail(parseReservationConfirmationData({
    status: "CONFIRMED", reservationId: booking.id, publicCode: booking.code, fullName: booking.name, email: booking.email, quantity: 3,
    experienceTitle: SUNSET_CONCHA.title, startsAt: new Date(target.starts_at).toISOString(), durationMinutes: 90,
    checkinToken: (await reservation(booking.id)).checkin_token,
    baseSlug: SUNSET_CONCHA.base_slug, baseName: SUNSET_CONCHA.base_name, meetingPoint: SUNSET_CONCHA.meeting_point, address: SUNSET_CONCHA.address, mapsUrl: SUNSET_CONCHA.maps_url,
  })!);
  assert.equal(message.text, expected.text, "o e-mail é o da turma nova, montado a partir do banco");
  assert.equal(message.html, expected.html);

  const [row] = await emails(booking.id);
  assert.equal(row.status, "SENT");
  assert.equal(row.attempts, 1);
  assert.deepEqual((await attempts(emailId)).map((item) => [item.source, item.outcome]), [["RESCHEDULE", "SENT"]]);

  // O log não leva destinatário, nome, código nem corpo.
  const dump = JSON.stringify(logs);
  assert.match(dump, /"outcome":"sent"/);
  for (const secret of [booking.email, booking.name, booking.code, booking.cpf]) assert.ok(!dump.includes(secret), "o log não expõe dado do cliente");

  // A reserva é a mesma: nenhuma reserva nova, nenhum evento financeiro novo.
  const stored = await reservation(booking.id);
  assert.equal(stored.public_code, booking.code);
  assert.equal(stored.total_cents, booking.total);
  assert.equal((await one(`select count(*)::int as n from public.reservations where email = $1`, [booking.email])).n, 1);
  assert.equal((await one(`select count(*)::int as n from public.payment_events where reservation_id = $1::uuid`, [booking.id])).n, 1);
});

test("requisição repetida, clique duplo e rotina no mesmo instante: um e-mail", async () => {
  const { booking, destination, changeId } = await rescheduled();
  const { runtime, provider } = createRuntime();

  // Clique duplo: duas requisições de reagendamento ao mesmo tempo, cada uma
  // seguida do envio — exatamente o que a rota faz — e a rotina no meio.
  const submit = async () => {
    const resolution = await reschedule(booking.id, destination);
    return sendRescheduleEmailForChange(runtime, resolution.changeId);
  };
  const [first, second, routine, third, panel] = await Promise.all([
    submit(), submit(), retryPendingRescheduleEmails(runtime), submit(), resendRescheduleEmail(runtime, ADMIN, booking.id),
  ]);

  assert.equal(provider.sent.length, 1, "um único e-mail");
  const senders = [first, second, third, panel].filter((result) => result.outcome === "SENT").length + routine.sent;
  assert.equal(senders, 1, "um único chamador enviou");

  // Dez repetições depois, continua um.
  for (let index = 0; index < 10; index += 1) assert.deepEqual(await submit(), { outcome: "SKIPPED" });
  assert.deepEqual(await sendRescheduleEmailForChange(runtime, changeId), { outcome: "SKIPPED" });
  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, booking.id), { outcome: "SKIPPED" });
  assert.equal(provider.sent.length, 1);
  assert.equal((await emails(booking.id)).length, 1);
});

test("provedor fora do ar: o reagendamento continua valendo, o envio fica pendente e a rotina recupera", async () => {
  const { booking, destination, emailId, changeId } = await rescheduled();
  const { runtime, provider, logs } = createRuntime();

  provider.failWith(new EmailProviderError("HTTP_503", true));
  assert.deepEqual(await sendRescheduleEmailForChange(runtime, changeId), { outcome: "PENDING", errorCode: "HTTP_503" });
  assert.equal(provider.sent.length, 0);

  const stored = await reservation(booking.id);
  assert.equal(stored.status, "CONFIRMED", "a falha do e-mail não desfaz o reagendamento");
  assert.equal(stored.session_id, destination);
  let [row] = await emails(booking.id);
  assert.deepEqual([row.status, row.attempts, row.last_error_code], ["FAILED", 1, "HTTP_503"]);

  // Segunda tentativa, pela rotina: timeout.
  const timeout = new Error("aborted");
  timeout.name = "TimeoutError";
  provider.failWith(timeout);
  assert.deepEqual(await retryPendingRescheduleEmails(runtime), { outcome: "PROCESSED", processed: 1, sent: 0 });
  [row] = await emails(booking.id);
  assert.deepEqual([row.status, row.attempts, row.last_error_code], ["FAILED", 2, "TIMEOUT"]);

  // Terceira: o provedor voltou.
  assert.deepEqual(await retryPendingRescheduleEmails(runtime), { outcome: "PROCESSED", processed: 1, sent: 1 });
  assert.equal(provider.sent.length, 1);
  assert.equal(provider.sent[0].idempotencyKey, `reschedule-confirmation/${emailId}`, "a mesma chave em toda tentativa");
  [row] = await emails(booking.id);
  assert.deepEqual([row.status, row.attempts, row.last_error_code], ["SENT", 3, null]);
  assert.deepEqual(
    (await attempts(emailId)).map((item) => [item.attempt, item.source, item.outcome, item.error_code]),
    [[1, "RESCHEDULE", "FAILED", "HTTP_503"], [2, "RETRY", "FAILED", "TIMEOUT"], [3, "RETRY", "SENT", null]],
  );
  assert.ok(logs.some((entry) => entry.outcome === "pending" && entry.errorCode === "HTTP_503"));

  // Nada mais a recuperar.
  assert.deepEqual(await retryPendingRescheduleEmails(runtime), { outcome: "PROCESSED", processed: 0, sent: 0 });
  assert.equal(provider.sent.length, 1);
});

test("um envio bem-sucedido leva de carona até dois pendentes; com o provedor fora, não insiste", async () => {
  const old = [await rescheduled(), await rescheduled(), await rescheduled()];
  const fresh = await rescheduled();
  const { runtime, provider } = createRuntime();

  // Provedor fora: o envio principal falha e nenhuma carona é tentada.
  provider.failWith(new EmailProviderError("HTTP_500", true));
  assert.equal((await sendRescheduleEmailForChange(runtime, fresh.changeId)).outcome, "PENDING");
  assert.equal(provider.sent.length, 0);
  for (const item of old) assert.equal((await emails(item.booking.id))[0].status, "QUEUED");

  // Provedor de volta: o próximo reagendamento envia o dele e recupera dois.
  const next = await rescheduled();
  assert.deepEqual(await sendRescheduleEmailForChange(runtime, next.changeId), { outcome: "SENT" });
  assert.equal(provider.sent.length, 3);
  assert.deepEqual(
    await Promise.all([...old, fresh, next].map(async (item) => (await emails(item.booking.id))[0].status)),
    ["SENT", "SENT", "QUEUED", "FAILED", "SENT"],
  );
});

test("enviado mas não registrado: nunca vira FAILED, e a nova tentativa reusa a chave que o provedor deduplica", async () => {
  const { booking, emailId, changeId } = await rescheduled();
  const { runtime, provider, admin, logs } = createRuntime();

  // O provedor aceita; o banco fica indisponível na hora de registrar.
  admin.failRpc("complete_reservation_reschedule_email", { message: "connection reset" }, 3);
  assert.deepEqual(await sendRescheduleEmailForChange(runtime, changeId), { outcome: "SENT", errorCode: "SENT_NOT_RECORDED" });
  assert.equal(provider.sent.length, 1);
  assert.equal(admin.calls.rpc.filter((name) => name === "complete_reservation_reschedule_email").length, 3, "o registro é repetido");
  assert.ok(!admin.calls.rpc.includes("fail_reservation_reschedule_email"), "um envio aceito nunca é devolvido à fila como falha");
  assert.ok(logs.some((entry) => entry.errorCode === "SENT_NOT_RECORDED" && entry.outcome === "failed"), "o estado ambíguo é registrado em log de erro");

  let [row] = await emails(booking.id);
  assert.equal(row.status, "SENDING", "fica reivindicado até o prazo vencer");
  assert.deepEqual(await retryPendingRescheduleEmails(runtime), { outcome: "PROCESSED", processed: 0, sent: 0 });
  assert.equal(provider.sent.length, 1);

  // Prazo vencido: a rotina tenta de novo com a MESMA chave. No Resend, a mesma
  // chave com o mesmo corpo devolve a resposta do primeiro envio em vez de
  // entregar outra vez — é a última linha de defesa deste caso.
  await expireLease(emailId);
  assert.deepEqual(await retryPendingRescheduleEmails(runtime), { outcome: "PROCESSED", processed: 1, sent: 1 });
  assert.equal(provider.sent.length, 2);
  assert.equal(provider.sent[1].idempotencyKey, provider.sent[0].idempotencyKey);
  assert.equal(provider.sent[1].html, provider.sent[0].html, "mesmo corpo: é o que faz o provedor reconhecer a repetição");
  assert.equal(provider.sent[1].text, provider.sent[0].text);
  [row] = await emails(booking.id);
  assert.equal(row.status, "SENT");
});

test("reserva sem e-mail utilizável: nada é enviado e o erro fica visível", async () => {
  const { booking, changeId } = await rescheduled();
  await db.query(`update public.reservations set email = 'sem-arroba' where id = $1::uuid`, [booking.id]);
  const { runtime, provider } = createRuntime();

  assert.deepEqual(await sendRescheduleEmailForChange(runtime, changeId), { outcome: "PENDING", errorCode: "PAYLOAD_EMPTY" });
  assert.equal(provider.sent.length, 0);
  const [row] = await emails(booking.id);
  assert.deepEqual([row.status, row.last_error_code], ["FAILED", "PAYLOAD_EMPTY"]);

  // Cadastro corrigido: o reenvio pelo painel resolve.
  await db.query(`update public.reservations set email = $2 where id = $1::uuid`, [booking.id, booking.email]);
  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, booking.id), { outcome: "SENT" });
  assert.equal(provider.sent[0].to, booking.email);
});

test("banco indisponível: o envio não lança, não envia e continua na fila", async () => {
  const { booking, changeId } = await rescheduled();
  const { runtime, provider, admin } = createRuntime();

  admin.failRpc("claim_reservation_reschedule_email", { code: "PGRST202", message: "function not found" });
  assert.deepEqual(await sendRescheduleEmailForChange(runtime, changeId), { outcome: "PENDING", errorCode: "CLAIM_UNAVAILABLE" });
  admin.failRpc("claim_pending_reservation_reschedule_emails", { message: "timeout" });
  assert.deepEqual(await retryPendingRescheduleEmails(runtime), { outcome: "FAILED", processed: 0, sent: 0, errorCode: "CLAIM_UNAVAILABLE" });
  admin.failRpc("admin_claim_reservation_reschedule_email", { message: "timeout" });
  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, booking.id), { outcome: "PENDING", errorCode: "CLAIM_UNAVAILABLE" });

  assert.equal(provider.sent.length, 0);
  assert.equal((await emails(booking.id))[0].status, "QUEUED", "nada foi consumido");
});

test("o QR do e-mail é o da reserva e vale na turma nova", async () => {
  const { booking, destination, changeId } = await rescheduled();
  const { runtime, provider } = createRuntime();
  await sendRescheduleEmailForChange(runtime, changeId);

  const token = (await reservation(booking.id)).checkin_token as string;
  assert.ok(provider.sent[0].html.includes(`/api/checkin/qr/${token}`));
  assert.ok(provider.sent[0].text.includes(`/checkin/${token}`));

  const ticket = await call(`public.public_checkin_ticket($1::uuid)`, [token]);
  const target = await one(`select starts_at from public.sessions where id = $1::uuid`, [destination]);
  assert.equal(new Date(ticket.startsAt).getTime(), new Date(target.starts_at).getTime());
  assert.equal(ticket.baseName, SUNSET_CONCHA.base_name);
  // E o check-in com esse QR registra na turma nova.
  const checked = await call(`public.admin_register_checkin($1::uuid, $2::uuid, 2, 'MANUAL', $3::uuid, false)`, [ADMIN, booking.id, destination]);
  assert.ok(checked);
});

// =============================================================================
// 6. Conteúdo
// =============================================================================

const CONCHA: ReservationConfirmationData = {
  reservationId: "11110000-0000-4000-8000-000000000002",
  publicCode: "CB4T8N2WQ7",
  fullName: "Marina Albuquerque",
  email: "marina@exemplo.com",
  quantity: 3,
  experienceTitle: "Remada Sunset",
  startsAt: "2026-11-08T20:00:00.000Z",
  checkinToken: "7c1e2d3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f",
  durationMinutes: 90,
  location: {
    baseSlug: "concha-acustica",
    baseName: "Cápsula Bar — Concha Acústica",
    meetingPoint: "Em frente ao Cápsula Bar — Concha Acústica",
    address: "SHTN Trecho 1, Lote 8 — Brasília/DF",
    mapsUrl: "https://maps.app.goo.gl/ueSCiLvHAggrzuAX7",
  },
};

const LAGO_NORTE: ReservationConfirmationData = {
  ...CONCHA,
  publicCode: "AZ7K2M9QX1",
  experienceTitle: "Imersão Paranoá",
  startsAt: "2026-11-07T12:00:00.000Z",
  location: { baseSlug: "lago-norte", baseName: "Lago Norte", meetingPoint: null, address: "QL 5 Conjunto 5 - Lago Norte", mapsUrl: null },
};

test("o e-mail traz tudo o que o cliente precisa da turma nova, em HTML e em texto", () => {
  const email = buildReservationRescheduleEmail(CONCHA);
  assert.equal(email.to, "marina@exemplo.com");
  assert.equal(email.subject, "Reagendamento confirmado — CB4T8N2WQ7");
  assert.equal(rescheduleConfirmationSubject("CB4T8N2WQ7"), email.subject);

  for (const body of [email.html, email.text]) {
    assert.ok(body.includes("Olá, Marina!"), "nome do cliente");
    assert.ok(body.includes("CB4T8N2WQ7"), "código original da reserva");
    assert.ok(body.includes("Remada Sunset"), "nova experiência");
    assert.ok(body.includes("08/11/2026") || /8 de novembro/.test(body), "nova data");
    assert.ok(body.includes("17:00"), "novo horário, em Brasília");
    assert.ok(body.includes("Cápsula Bar — Concha Acústica"), "nova base");
    assert.ok(body.includes("SHTN Trecho 1, Lote 8 — Brasília/DF"), "endereço");
    assert.ok(body.includes("https://maps.app.goo.gl/ueSCiLvHAggrzuAX7"), "link do mapa");
    assert.ok(body.includes("7c1e2d3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f"), "QR Code da reserva");
    assert.ok(body.includes(RESCHEDULE_INTRO));
    assert.ok(body.includes(RESCHEDULE_PAYMENT_NOTE), "o pagamento continua válido");
    assert.ok(body.includes(RESCHEDULE_QR_NOTE));
    assert.ok(body.includes(MEETING_TOLERANCE_NOTE));
  }
  assert.ok(email.html.includes(RESCHEDULE_PAYMENT_HEADLINE));
  assert.ok(email.text.includes(RESCHEDULE_PAYMENT_HEADLINE.toUpperCase()));
  assert.match(email.text, /Participantes: 3/);
  assert.match(email.html, />Participantes<\/td>\s*<td[^>]*>3<\/td>/);
  assert.match(email.html, /<img src="[^"]+\/api\/checkin\/qr\/7c1e2d3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f"/);
  assert.match(email.html, /<a href="https:\/\/maps\.app\.goo\.gl\/ueSCiLvHAggrzuAX7"/);
});

test("usa a identidade dos e-mails existentes: mesma moldura, mesmo rodapé, mesmo bloco do QR", () => {
  const reschedule = buildReservationRescheduleEmail(CONCHA).html;
  const confirmation = buildReservationConfirmationEmail(CONCHA).html;

  const header = (html: string) => html.slice(html.indexOf("<body"), html.indexOf("<h1"));
  const footer = (html: string) => html.slice(html.lastIndexOf('<td style="padding:20px 28px 28px'));
  const qr = (html: string) => html.slice(html.indexOf("border:2px solid"), html.indexOf("Se a imagem não carregar"));
  assert.equal(header(reschedule).replace(/<div style="display:none[^>]*>[^<]*<\/div>/, ""), header(confirmation).replace(/<div style="display:none[^>]*>[^<]*<\/div>/, ""));
  assert.equal(footer(reschedule), footer(confirmation));
  assert.equal(qr(reschedule), qr(confirmation));

  assert.match(reschedule, /<h1[^>]*>Reagendamento confirmado<\/h1>/);
  assert.match(reschedule, /max-width:560px/);
  assert.doesNotMatch(reschedule, /<script|<link|display:\s*(flex|grid)|@media/i);
});

test("Lago Norte: endereço em texto, sem inventar link de mapa", () => {
  const email = buildReservationRescheduleEmail(LAGO_NORTE);
  for (const body of [email.html, email.text]) {
    assert.ok(body.includes("QL 5 Conjunto 5 - Lago Norte"));
    assert.ok(body.includes("Lago Norte"));
    assert.ok(body.includes("09:00"));
    assert.ok(!/maps\.|google\.com\/maps/.test(body), "a base não tem link oficial cadastrado");
  }
  assert.match(email.text, /Base: Lago Norte/);
});

test("não é o e-mail de pagamento de novo, não promete reembolso e não leva dado sensível", () => {
  const reschedule = buildReservationRescheduleEmail(CONCHA);
  const confirmation = buildReservationConfirmationEmail(CONCHA);
  assert.notEqual(reschedule.subject, confirmation.subject);
  assert.notEqual(reschedule.html, confirmation.html);
  for (const body of [reschedule.html, reschedule.text]) {
    assert.ok(!body.includes("Sua reserva está confirmada!"), "não repete a abertura do e-mail de pagamento");
    assert.ok(!body.includes(CANCELLATION_NOTE), "a política de cancelamento de reserva reagendada não é decidida aqui");
    assert.doesNotMatch(body, /reembolso|estorno|cobran[çc]a adicional|pagar a diferen[çc]a/i);
    assert.doesNotMatch(body, /cpf|checkout|infinitepay|\bR\$/i);
    assert.doesNotMatch(body, /\/cancelar|\/acompanhar-reserva#r=/);
  }
});

test("nome do cliente é escapado e reserva sem QR sai sem a seção, não quebrada", () => {
  const html = buildReservationRescheduleEmail({ ...CONCHA, fullName: "<script>alert(1)</script> Silva" }).html;
  assert.ok(!html.includes("<script>alert(1)"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));

  const withoutQr = buildReservationRescheduleEmail({ ...CONCHA, checkinToken: null });
  for (const body of [withoutQr.html, withoutQr.text]) {
    assert.ok(!body.includes("QR Code"));
    assert.ok(body.includes(RESCHEDULE_PAYMENT_NOTE));
  }
});

// =============================================================================
// 7. Ativação e pontos de chamada
// =============================================================================

test("o e-mail de reagendamento só existe com STANDBY_RESCHEDULE_EMAIL_ENABLED=true", () => {
  assert.equal(isRescheduleEmailEnabled({}), false);
  for (const value of ["", "1", "yes", "on", "false", "TRUE ", " true"]) {
    assert.equal(isRescheduleEmailEnabled({ STANDBY_RESCHEDULE_EMAIL_ENABLED: value }), value.trim().toLowerCase() === "true", JSON.stringify(value));
  }
  assert.equal(isRescheduleEmailEnabled({ STANDBY_RESCHEDULE_EMAIL_ENABLED: "true" }), true);
  // Ligar o painel não liga o e-mail, e vice-versa.
  assert.equal(isRescheduleEmailEnabled({ STANDBY_ADMIN_ENABLED: "true" }), false);
  assert.equal(isRescheduleEmailEnabled({ NEXT_PUBLIC_STANDBY_RESCHEDULE_EMAIL_ENABLED: "true" }), false);

  // Desligado, o serviço responde DISABLED antes de tocar no banco ou no provedor.
  const service = source("lib/reservations/reschedule-email-service.ts");
  const gate = service.slice(service.indexOf("function runtime()"), service.indexOf("export function isRescheduleEmailActive"));
  assert.ok(gate.indexOf("!isRescheduleEmailEnabled()") < gate.indexOf("getEmailProvider()"));
  assert.ok(gate.indexOf("!isRescheduleEmailEnabled()") < gate.indexOf("getSupabaseAdminClient()"));
  for (const fn of ["sendRescheduleConfirmationEmail", "retryPendingRescheduleConfirmationEmails", "resendRescheduleConfirmationEmail", "getRescheduleEmailStates"]) {
    const body = service.slice(service.indexOf(`export async function ${fn}`));
    assert.match(body.slice(0, body.indexOf("\n}\n")), /try \{[\s\S]*runtime\(\)[\s\S]*\} catch/, `${fn} nunca lança`);
  }
  assert.match(source(".env.example"), /^# STANDBY_RESCHEDULE_EMAIL_ENABLED=true$/m, "documentada e desligada por padrão");
});

test("só o reagendamento envia: nenhuma outra ação de Stand-by alcança o serviço de e-mail", () => {
  const application = [...files("app"), ...files("lib"), ...files("components")].filter((path) => /\.tsx?$/.test(path));
  const importers = application.filter((path) => /reschedule-email-service/.test(source(path))).sort();
  assert.deepEqual(importers, [
    "app/admin/reservas/[reservationId]/page.tsx",
    "app/api/admin/reservations/[reservationId]/standby/reschedule-email/route.ts",
    "app/api/admin/reservations/[reservationId]/standby/reschedule/route.ts",
    "app/api/admin/reservations/[reservationId]/standby/route.ts",
    "app/api/cron/confirmation-emails/route.ts",
  ]);

  // Quem chama cada operação do serviço.
  const callers = (fn: string) => application.filter((path) => path !== "lib/reservations/reschedule-email-service.ts" && new RegExp(`\\b${fn}\\(`).test(source(path)));
  assert.deepEqual(callers("sendRescheduleConfirmationEmail"), ["app/api/admin/reservations/[reservationId]/standby/reschedule/route.ts"]);
  assert.deepEqual(callers("resendRescheduleConfirmationEmail"), ["app/api/admin/reservations/[reservationId]/standby/reschedule-email/route.ts"]);
  assert.deepEqual(callers("retryPendingRescheduleConfirmationEmails"), ["app/api/cron/confirmation-emails/route.ts"]);
  // A tela e a rota de leitura só perguntam o estado: nunca enviam.
  for (const path of ["app/admin/reservas/[reservationId]/page.tsx", "app/api/admin/reservations/[reservationId]/standby/route.ts"]) {
    assert.doesNotMatch(source(path), /\b(sendRescheduleConfirmationEmail|resendRescheduleConfirmationEmail|retryPendingRescheduleConfirmationEmails)\b/, path);
  }
  for (const path of ["app/api/admin/reservations/[reservationId]/standby/undo/route.ts", "app/api/admin/reservations/[reservationId]/standby/link/route.ts", "lib/admin/standby-data.ts"]) {
    assert.doesNotMatch(source(path), /reschedule-email|RescheduleEmail|sendReservationConfirmationEmail/, `${path} não envia e-mail`);
  }
  // O reagendamento tradicional e as demais ações do painel não conhecem esta fila.
  assert.doesNotMatch(source("lib/admin/data.ts"), /reschedule-email|RescheduleEmail|reservation_reschedule_email/);

  // Na rota: o e-mail vem depois de o banco confirmar, e usa a chave que o banco devolveu.
  const route = source("app/api/admin/reservations/[reservationId]/standby/reschedule/route.ts");
  assert.ok(route.indexOf("await rescheduleReservationFromStandby(") < route.indexOf("sendRescheduleConfirmationEmail(resolution.changeId)"));
  assert.ok(route.indexOf("if (!resolution) return") < route.indexOf("sendRescheduleConfirmationEmail("));
  // E o reagendamento tradicional continua como estava: sem e-mail.
  assert.doesNotMatch(source("app/api/admin/reservations/[reservationId]/change-session/route.ts"), /reschedule-email|RescheduleEmail|sendReservationConfirmationEmail/);
});

test("o e-mail de pagamento continua exatamente como era", () => {
  // Mesma mensagem, mesmo assunto: o template novo é uma função à parte.
  const confirmation = buildReservationConfirmationEmail(LAGO_NORTE);
  assert.equal(confirmation.subject, "Reserva confirmada — AZ7K2M9QX1");
  assert.ok(!("idempotencyKey" in confirmation), "o e-mail de pagamento não ganha chave de idempotência");

  // O serviço dele não foi tocado: mesmas RPCs, mesma fila, nenhuma referência ao reagendamento.
  const service = source("lib/reservations/confirmation-email-service.ts");
  assert.doesNotMatch(service, /reschedule-email|RescheduleEmail|reservation_reschedule_email/);
  assert.match(service, /claim_reservation_confirmation_email/);
  assert.doesNotMatch(source("lib/reservations/payment-confirmation.ts"), /reschedule-email|RescheduleEmail|reservation_reschedule_email/);

  // A rotina agendada roda a recuperação dele primeiro, com a mesma resposta de antes.
  const cron = source("app/api/cron/confirmation-emails/route.ts");
  assert.ok(cron.indexOf("await retryPendingConfirmationEmails()") < cron.indexOf("await retryPendingRescheduleConfirmationEmails()"));
  assert.match(cron, /outcome: report\.outcome,\s+processed: report\.processed,\s+sent: report\.sent,\s+errorCode: report\.errorCode,/);
  // Nenhuma rotina agendada nova.
  assert.deepEqual(JSON.parse(source("vercel.json")).crons.map((cron: { path: string }) => cron.path), ["/api/cron/payment-reconciliation", "/api/cron/confirmation-emails"]);
});

test("textos do painel: o que o admin lê sobre o e-mail de cada reagendamento", () => {
  assert.match(rescheduleEmailNotice("SENT"), /foi enviado ao cliente/);
  assert.match(rescheduleEmailNotice("PENDING"), /será tentado de novo/);
  assert.match(rescheduleEmailNotice("SKIPPED"), /já foi enviado ou está em andamento/);
  for (const unknown of ["DISABLED", "", undefined, null, "QUALQUER"]) assert.equal(rescheduleEmailNotice(unknown), "Nenhum e-mail foi enviado: avise o cliente.");

  const base = { emailId: "e", standbyId: "s", inFlight: false, attempts: 2, lastErrorCode: null, lastAttemptAt: null, sentAt: null, createdAt: "2026-10-13T12:00:00Z" };
  const format = (value: string | null) => `<${value}>`;
  assert.equal(rescheduleEmailSummary({ ...base, status: "SENT", sentAt: "2026-10-13T12:01:00Z" }, format), "E-mail de confirmação enviado em <2026-10-13T12:01:00Z>.");
  assert.match(rescheduleEmailSummary({ ...base, status: "FAILED", lastErrorCode: "HTTP_422" }, format), /com erro \(HTTP_422\), após 2 tentativa\(s\)/);
  assert.match(rescheduleEmailSummary({ ...base, status: "SKIPPED", lastErrorCode: "SESSION_STARTED" }, format), /a turma começou antes do envio/);
  assert.match(rescheduleEmailSummary({ ...base, status: "SKIPPED", lastErrorCode: "SUPERSEDED" }, format), /mudou de turma de novo/);
  assert.match(rescheduleEmailSummary({ ...base, status: "SENDING", inFlight: true }, format), /em envio/);
  assert.match(rescheduleEmailSummary({ ...base, status: "QUEUED" }, format), /pendente/);

  // O botão de reenvio só aparece quando há o que reenviar.
  assert.equal(canResendRescheduleEmail({ status: "QUEUED", inFlight: false }), true);
  assert.equal(canResendRescheduleEmail({ status: "FAILED", inFlight: false }), true);
  assert.equal(canResendRescheduleEmail({ status: "SENDING", inFlight: false }), true);
  assert.equal(canResendRescheduleEmail({ status: "SENDING", inFlight: true }), false);
  assert.equal(canResendRescheduleEmail({ status: "SENT", inFlight: false }), false);
  assert.equal(canResendRescheduleEmail({ status: "SKIPPED", inFlight: false }), false);

  assert.equal(parseRescheduleEmailClaim(null), null);
  assert.equal(parseRescheduleEmailClaim({ emailId: "x" }), null, "sem token não há direito de enviar");
  assert.equal(rescheduleEmailIdempotencyKey("abc"), "reschedule-confirmation/abc");
});

// =============================================================================
// 8. Provedor: a chave de idempotência
// =============================================================================

test("Resend: a chave só vai quando informada, muda com o conteúdo e nunca aparece no e-mail de pagamento", async () => {
  const requests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) });
    return new Response(JSON.stringify({ id: "fake" }), { status: 200 });
  }) as typeof fetch;

  try {
    const provider = new ResendProvider({ apiKey: "re_test_fake", from: "Alma Azul <teste@exemplo.com>", replyTo: null });
    const reschedule = buildReservationRescheduleEmail(CONCHA);

    await provider.send(buildReservationConfirmationEmail(CONCHA));
    await provider.send({ ...reschedule, idempotencyKey: "reschedule-confirmation/abc" });
    await provider.send({ ...reschedule, idempotencyKey: "reschedule-confirmation/abc" });
    await provider.send({ ...reschedule, text: `${reschedule.text}\ncorrigido`, idempotencyKey: "reschedule-confirmation/abc" });
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(requests.length, 4);
  for (const request of requests) assert.equal(request.url, "https://api.resend.com/emails");

  // E-mail de pagamento: requisição igual à de sempre, sem o cabeçalho.
  assert.deepEqual(Object.keys(requests[0].headers).sort(), ["authorization", "content-type"]);
  assert.deepEqual(Object.keys(JSON.parse(requests[0].body)).sort(), ["from", "html", "subject", "text", "to"]);

  // Reagendamento: a mesma mensagem leva a mesma chave; a mensagem corrigida, outra.
  const key = (index: number) => requests[index].headers["idempotency-key"];
  assert.match(key(1), /^reschedule-confirmation\/abc\/[0-9a-f]{32}$/);
  assert.equal(key(2), key(1));
  assert.notEqual(key(3), key(1));
  assert.equal(key(1), resendIdempotencyKey("reschedule-confirmation/abc", requests[1].body));
  assert.ok(key(1).length <= 256, "limite do Resend");
  // A chave não vai no corpo, e o corpo não muda por causa dela.
  assert.ok(!requests[1].body.includes("idempotency"));
  assert.deepEqual(Object.keys(JSON.parse(requests[1].body)).sort(), ["from", "html", "subject", "text", "to"]);
});

test("Resend: 409 da chave de idempotência é falha que vale repetir", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 409 })) as typeof fetch;
  try {
    const provider = new ResendProvider({ apiKey: "re_test_fake", from: "Alma Azul <teste@exemplo.com>", replyTo: null });
    await assert.rejects(
      provider.send({ ...buildReservationRescheduleEmail(CONCHA), idempotencyKey: "k" }),
      (error: unknown) => error instanceof EmailProviderError && error.causeCode === "HTTP_409" && error.retryable === true,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("nenhum teste envia e-mail de verdade nem toca o banco de produção", () => {
  const code = source("tests/reservation-reschedule-email.test.ts");
  const imports = [...code.matchAll(/^import [\s\S]*?from "([^"]+)";$/gm)].map((match) => match[1]);
  // Nem o cliente do Supabase, nem a seleção do provedor real, nem o serviço que os liga.
  for (const forbidden of ["lib/supabase/", "lib/email/index", "reschedule-email-service", "confirmation-email-service"]) {
    assert.ok(!imports.some((path) => path.includes(forbidden)), `o teste não importa ${forbidden}`);
  }
  assert.doesNotMatch(code, /re_[a-zA-Z0-9]{20,}/, "nenhuma chave real do Resend");
  assert.match(code, /const db = await fullDatabase\(\);/);
  assert.match(code, /const provider = fakeProvider\(\);/);
});

// =============================================================================
// 9. Preflight, postcheck, relatório e rollback
// =============================================================================

const STANDBY_MIGRATION = "202610130002_reservation_standby.sql";
const PREFLIGHT = "diagnostics/reservation_reschedule_email_preflight.sql";
const POSTCHECK = "diagnostics/reservation_reschedule_email_postcheck.sql";
const REPORT = "diagnostics/reservation_reschedule_email_report.sql";
const ROLLBACK = "rollback/202610150001_reservation_reschedule_email.rollback.sql";

type Check = { check_name: string; result: string; status: string };

function operationsFile(path: string) {
  return source(`supabase/${path}`);
}

async function diagnostic(database: typeof db, path: string) {
  const sql = operationsFile(path);
  assert.ok(!/\b(insert|update|delete|alter|create|drop|grant|revoke|truncate)\b/i.test(sql.replace(/--.*$/gm, "").replace(/'[^']*'/g, "''")), `${path} é somente leitura`);
  return (await database.query(sql)).rows as Check[];
}

function failing(result: Check[]) {
  return result.filter((row) => row.status !== "OK").map((row) => `${row.check_name}=${row.status}`);
}

function resultOf(result: Check[], name: string) {
  return result.find((row) => row.check_name === name)?.result ?? "";
}

/** Recria a função com outro texto, preservando dono e privilégios. */
async function redefine(database: typeof db, name: string, transform: (definition: string) => string) {
  const result = await database.query(
    `select pg_get_functiondef(p.oid) as definition from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`,
    [name],
  );
  const definition = (result.rows[0] as Row).definition as string;
  const changed = transform(definition);
  assert.notEqual(changed, definition, `${name}: a alteração de teste precisa mudar o texto`);
  await database.exec(changed);
}

/** Só formatação: CRLF, tabulação e recuo diferentes. Nenhuma palavra muda. */
const reformat = (definition: string) => definition.replace(/\n/g, "\r\n\t   ");

/**
 * Um reagendamento de Stand-by completo em outro banco, pelas mesmas RPCs:
 * reserva paga → Stand-by → reagendada pelo painel.
 */
async function seedRescheduled(database: typeof db, tag: number) {
  const query = async (sql: string, params: unknown[] = []) => ((await database.query(sql, params)).rows[0] as Row).value;
  const actor = `d0000000-0000-4000-8000-00000000000${tag}`;
  await database.query(`insert into auth.users (id, email) values ($1::uuid, $2)`, [actor, `seed${tag}@teste.local`]);
  await database.query(`insert into public.admin_users (user_id, display_name, role, is_active) values ($1::uuid, 'Seed', 'ADMIN', true)`, [actor]);
  const experienceId = await query(`select id as value from public.experiences where slug = 'imersao-paranoa'`);
  const session = (days: number) => query(
    `insert into public.sessions (experience_id, starts_at, duration_minutes, price_cents, capacity, status)
     values ($1::uuid, now() + make_interval(days => $2), 90, $3, 6, 'OPEN') returning id as value`,
    [experienceId, days, 51_000 + tag],
  );
  const origin = await session(10 + tag);
  const destination = await session(20 + tag);
  const created = await query(
    `select public.create_pre_reservation($1::uuid, 'Cliente Seed', $2, $3, $4, 2, null, gen_random_uuid()) as value`,
    [origin, String(40_000_000_000 + tag), `+5561930000${String(100 + tag)}`, `seed-cliente${tag}@teste.local`],
  );
  await query(`select public.confirm_reservation_payment($1::uuid, 'INFINITEPAY', $2, $3, 'https://recibo.teste/1', '{}'::jsonb) as value`, [created.reservationId, `tx-seed-${tag}`, created.totalCents]);
  await query(`select public.admin_set_reservation_standby($1::uuid, $2::uuid, 'Turma cancelada') as value`, [actor, created.reservationId]);
  const resolution = await query(`select public.admin_reschedule_standby_same_price($1::uuid, $2::uuid, $3::uuid, null) as value`, [actor, created.reservationId, destination]);
  return { actor, reservationId: created.reservationId as string, origin, destination, resolution };
}

test("preflight: aprovado antes da migration e reprovado depois dela", async () => {
  const before = await fullDatabase({ until: PANEL_MIGRATION });
  const approved = await diagnostic(before, PREFLIGHT);
  assert.deepEqual(failing(approved), [], JSON.stringify(approved, null, 2));
  assert.equal(approved.at(-1)?.check_name, "STANDBY_EMAIL_PREFLIGHT_OK");
  assert.equal(approved.at(-1)?.result, "0 falha(s), 0 ponto(s) de atenção");
  assert.equal(resultOf(approved, "OBJETOS_DA_FILA_AINDA_NAO_EXISTEM"), "nenhum");
  assert.equal(resultOf(approved, "TRIGGERS_NO_HISTORICO_DE_TROCAS"), "nenhuma");
  assert.match(resultOf(approved, "FUNCAO_QUE_GRAVA_O_REAGENDAMENTO"), /^reservation_standby_resolve=IDENTICA$/);
  for (const row of approved) assert.ok(["OK", "ATENCAO", "FALHOU"].includes(row.status), `${row.check_name}: ${row.status}`);

  const after = failing(await diagnostic(db, PREFLIGHT));
  for (const expected of ["OBJETOS_DA_FILA_AINDA_NAO_EXISTEM=FALHOU", "STANDBY_EMAIL_PREFLIGHT_OK=FALHOU"]) {
    assert.ok(after.includes(expected), `${expected} precisa acusar que a migration já foi aplicada`);
  }

  // Sem a etapa 3, a migration não deve ser aplicada.
  const early = failing(await diagnostic(await fullDatabase({ until: STANDBY_MIGRATION }), PREFLIGHT));
  assert.deepEqual(early, ["ETAPAS_ANTERIORES_APLICADAS=FALHOU", "STANDBY_EMAIL_PREFLIGHT_OK=FALHOU"]);
});

test("preflight: formatação não bloqueia; conteúdo diferente bloqueia onde importa e pede atenção onde não", async () => {
  // 1. Só formatação — na função que grava o reagendamento e em uma de apoio.
  const formatted = await fullDatabase({ until: PANEL_MIGRATION });
  await redefine(formatted, "reservation_standby_resolve", reformat);
  await redefine(formatted, "reservation_confirmation_email", reformat);
  const formatOnly = await diagnostic(formatted, PREFLIGHT);
  assert.deepEqual(failing(formatOnly), []);
  assert.equal(resultOf(formatOnly, "FUNCAO_QUE_GRAVA_O_REAGENDAMENTO"), "reservation_standby_resolve=IDENTICA_SO_FORMATACAO");
  assert.match(resultOf(formatOnly, "FUNCOES_DE_APOIO"), /reservation_confirmation_email=IDENTICA_SO_FORMATACAO/);

  // 2. Conteúdo diferente na função que grava o reagendamento: bloqueia.
  const origin = await fullDatabase({ until: PANEL_MIGRATION });
  await redefine(origin, "reservation_standby_resolve", (definition) => definition.replace("else 'STANDBY_RESCHEDULE' end", "else 'STANDBY_RESTORE' end"));
  const blocked = await diagnostic(origin, PREFLIGHT);
  assert.deepEqual(failing(blocked), ["FUNCAO_QUE_GRAVA_O_REAGENDAMENTO=FALHOU", "STANDBY_EMAIL_PREFLIGHT_OK=FALHOU"]);

  // 3. Conteúdo diferente em função de apoio: não bloqueia, mas aparece.
  const support = await fullDatabase({ until: PANEL_MIGRATION });
  await redefine(support, "reservation_confirmation_email", (definition) => definition.replace("'mapsUrl', b.maps_url", "'mapsUrl', null"));
  const attention = await diagnostic(support, PREFLIGHT);
  assert.deepEqual(failing(attention), ["FUNCOES_DE_APOIO=ATENCAO"]);
  assert.match(resultOf(attention, "FUNCOES_DE_APOIO"), /reservation_confirmation_email=DIFERENTE/);
  assert.equal(attention.at(-1)?.status, "OK", "ATENCAO não reprova a linha final");
  assert.equal(attention.at(-1)?.result, "0 falha(s), 1 ponto(s) de atenção");

  // 4. Função de apoio ausente: bloqueia.
  const missing = await fullDatabase({ until: PANEL_MIGRATION });
  await missing.exec(`drop function public.reservation_confirmation_email(uuid);`);
  assert.deepEqual(failing(await diagnostic(missing, PREFLIGHT)), ["FUNCOES_DE_APOIO=FALHOU", "STANDBY_EMAIL_PREFLIGHT_OK=FALHOU"]);
});

test("reagendamento anterior à migration não vira e-mail retroativo — e os dois diagnósticos dizem isso", async () => {
  const database = await fullDatabase({ until: PANEL_MIGRATION });
  await seedRescheduled(database, 1);

  const before = await diagnostic(database, PREFLIGHT);
  assert.deepEqual(failing(before), ["REAGENDAMENTOS_DE_STANDBY_JA_FEITOS=ATENCAO"]);
  assert.equal(resultOf(before, "REAGENDAMENTOS_DE_STANDBY_JA_FEITOS"), "1");

  await applyMigration(database, EMAIL_MIGRATION);
  assert.equal(((await database.query(`select count(*)::int as n from public.reservation_reschedule_emails`)).rows[0] as Row).n, 0, "a migration não enfileira nada");

  const after = await diagnostic(database, POSTCHECK);
  assert.deepEqual(failing(after), ["REAGENDAMENTOS_SEM_LINHA_NA_FILA=ATENCAO"]);
  assert.equal(after.at(-1)?.result, "0 falha(s), 1 ponto(s) de atenção");
  // As contagens que não podem mudar com a migration, iguais nos dois lados.
  for (const name of ["RESERVAS_POR_STATUS", "EVENTOS_DE_PAGAMENTO", "HISTORICO_DE_TROCAS", "AUTORIZACOES_DE_STANDBY", "FILAS_EXISTENTES"]) {
    assert.equal(resultOf(after, name), resultOf(before, name), name);
  }

  // O próximo reagendamento, já com a migration, entra na fila.
  await seedRescheduled(database, 2);
  assert.equal(((await database.query(`select count(*)::int as n from public.reservation_reschedule_emails`)).rows[0] as Row).n, 1);
});

test("postcheck: aprovado depois da migration, com a fila em uso; antes dela, nem roda", async () => {
  const approved = await diagnostic(db, POSTCHECK);
  assert.deepEqual(failing(approved), [], JSON.stringify(approved, null, 2));
  assert.equal(approved.at(-1)?.check_name, "STANDBY_EMAIL_POSTCHECK_OK");
  assert.equal(approved.at(-1)?.result, "0 falha(s), 0 ponto(s) de atenção");
  assert.equal(resultOf(approved, "FUNCOES_DA_FILA_COM_A_DEFINICAO_DO_REPOSITORIO"), "todas as 10 idênticas");
  assert.equal(resultOf(approved, "OPERACOES_EXECUTAVEIS_PELA_SERVICE_ROLE"), "6 de 6");
  assert.equal(resultOf(approved, "TRIGGER_DO_EVENTO_ATIVA"), "estado=O, depois de inserir=true, só reagendamento de Stand-by=true");
  assert.equal(resultOf(approved, "FILA_SO_TEM_REAGENDAMENTO_DE_STANDBY"), "0 linha(s) fora da regra");
  assert.match(resultOf(approved, "FILA_DE_REAGENDAMENTO_POR_STATUS"), /SENT=\d+/);

  // Os postchecks das etapas anteriores continuam valendo com esta migration
  // aplicada. O da etapa 2 exige banco sem Stand-by em uso; o do painel, não.
  assert.deepEqual(failing(await diagnostic(await fullDatabase(), "diagnostics/reservation_standby_postcheck.sql")), []);
  assert.deepEqual(failing(await diagnostic(db, "diagnostics/reservation_standby_admin_panel_postcheck.sql")), []);

  // Sem a migration, as tabelas não existem: o postcheck falha em vez de aprovar.
  await rejects(diagnostic(await fullDatabase({ until: PANEL_MIGRATION }), POSTCHECK), /reservation_reschedule_email/);
});

test("postcheck: sensível a privilégio, conteúdo, trigger e unicidade — e tolerante a formatação", async () => {
  const database = await fullDatabase();
  const expectFailure = async (label: string, breakIt: string, fixIt: string, expected: string) => {
    await database.exec(breakIt);
    try {
      assert.deepEqual(failing(await diagnostic(database, POSTCHECK)), [`${expected}=FALHOU`, "STANDBY_EMAIL_POSTCHECK_OK=FALHOU"], label);
    } finally {
      await database.exec(fixIt);
    }
    assert.deepEqual(failing(await diagnostic(database, POSTCHECK)), [], `${label}: desfeito`);
  };

  await expectFailure(
    "peça interna ao alcance do servidor",
    `grant execute on function public.reservation_reschedule_email_take(uuid, integer, integer, text, uuid) to service_role;`,
    `revoke execute on function public.reservation_reschedule_email_take(uuid, integer, integer, text, uuid) from service_role;`,
    "PECAS_INTERNAS_FORA_DO_ALCANCE",
  );
  await expectFailure(
    "operação executável pela API pública",
    `grant execute on function public.claim_reservation_reschedule_email(uuid, integer, integer) to anon;`,
    `revoke execute on function public.claim_reservation_reschedule_email(uuid, integer, integer) from anon;`,
    "NENHUMA_FUNCAO_EXECUTAVEL_PELA_API_PUBLICA",
  );
  await expectFailure(
    "service role sem a operação",
    `revoke execute on function public.complete_reservation_reschedule_email(uuid, uuid) from service_role;`,
    `grant execute on function public.complete_reservation_reschedule_email(uuid, uuid) to service_role;`,
    "OPERACOES_EXECUTAVEIS_PELA_SERVICE_ROLE",
  );
  await expectFailure(
    "service role escrevendo direto na fila",
    `grant insert on public.reservation_reschedule_emails to service_role;`,
    `revoke insert on public.reservation_reschedule_emails from service_role;`,
    "TABELAS_DA_FILA_PROTEGIDAS",
  );
  await expectFailure(
    "RLS desligada",
    `alter table public.reservation_reschedule_email_attempts disable row level security;`,
    `alter table public.reservation_reschedule_email_attempts enable row level security;`,
    "TABELAS_DA_FILA_PROTEGIDAS",
  );
  await expectFailure(
    "trigger desligada",
    `alter table public.reservation_session_changes disable trigger reservation_session_changes_reschedule_email;`,
    `alter table public.reservation_session_changes enable trigger reservation_session_changes_reschedule_email;`,
    "TRIGGER_DO_EVENTO_ATIVA",
  );
  await expectFailure(
    "unicidade removida",
    `drop index public.reservation_reschedule_emails_change_key;`,
    `create unique index reservation_reschedule_emails_change_key on public.reservation_reschedule_emails (change_id);`,
    "UM_EMAIL_POR_REAGENDAMENTO",
  );

  // Conteúdo: um operador trocado na função central da fila reprova.
  await redefine(database, "reservation_reschedule_email_take", (definition) => definition.replace("queued.locked_until > now()", "queued.locked_until >= now()"));
  const changed = await diagnostic(database, POSTCHECK);
  assert.deepEqual(failing(changed), ["FUNCOES_DA_FILA_COM_A_DEFINICAO_DO_REPOSITORIO=FALHOU", "STANDBY_EMAIL_POSTCHECK_OK=FALHOU"]);
  assert.equal(resultOf(changed, "FUNCOES_DA_FILA_COM_A_DEFINICAO_DO_REPOSITORIO"), "reservation_reschedule_email_take=DIFERENTE");

  // Só formatação: aprova, e diz qual.
  await redefine(database, "reservation_reschedule_email_take", (definition) => reformat(definition.replace("queued.locked_until >= now()", "queued.locked_until > now()")));
  const formatted = await diagnostic(database, POSTCHECK);
  assert.deepEqual(failing(formatted), []);
  assert.equal(resultOf(formatted, "FUNCOES_DA_FILA_COM_A_DEFINICAO_DO_REPOSITORIO"), "reservation_reschedule_email_take=IDENTICA_SO_FORMATACAO");
});

test("relatório da fila: só leitura, só contagens e ids técnicos", async () => {
  const pending = await rescheduled();
  const broken = await rescheduled();
  const claim = await claimFor(broken.changeId);
  await fail(broken.emailId, claim.claimToken, "HTTP_422");

  const sql = operationsFile(REPORT);
  assert.ok(!/\b(insert|update|delete|alter|create|drop|grant|revoke|truncate)\b/i.test(sql.replace(/--.*$/gm, "").replace(/'[^']*'/g, "''")), "somente leitura");
  const report = (await db.query(sql)).rows as Array<{ check_name: string; result: string }>;
  const value = (name: string) => report.find((row) => row.check_name === name)?.result;

  assert.equal(value("NA_FILA"), "1");
  assert.equal(value("COM_ERRO"), "1");
  assert.equal(value("ULTIMOS_ERROS"), "HTTP_422 ×1");
  assert.equal(value("ESGOTADOS_AGUARDANDO_REENVIO_MANUAL"), "0");
  assert.match(value("TENTATIVAS_REGISTRADAS") ?? "", /FAILED=\d+/);
  assert.match(value("ABERTO_1") ?? "", new RegExp(`^reserva ${pending.booking.id} \\| QUEUED \\| tentativas=0 \\| erro=- \\|`));
  assert.match(value("ABERTO_2") ?? "", new RegExp(`^reserva ${broken.booking.id} \\| FAILED \\| tentativas=1 \\| erro=HTTP_422 \\|`));
  assert.ok(report.length <= 90, "cabe no limite de linhas do SQL Editor");

  const dump = JSON.stringify(report);
  for (const booking of [pending.booking, broken.booking]) {
    for (const secret of [booking.email, booking.name, booking.code, booking.cpf]) assert.ok(!dump.includes(secret), "nenhum dado do cliente");
  }
});

test("rollback: remove a trigger e as funções, mantém o registro, e o reagendamento volta a ser o da etapa 3", async () => {
  const database = await fullDatabase();
  const first = await seedRescheduled(database, 1);
  const count = async (sql: string) => ((await database.query(sql)).rows[0] as Row).n as number;
  assert.equal(await count(`select count(*)::int as n from public.reservation_reschedule_emails`), 1);
  const before = await functionHashes(database);

  const rollback = operationsFile(ROLLBACK);
  assert.doesNotMatch(rollback.replace(/--.*$/gm, ""), /drop table|delete from|truncate|integration_sync_jobs|public\.reservations\b/i, "o rollback não apaga dado");
  await database.exec(rollback);

  // Sobram exatamente as funções que existiam antes da migration.
  const after = await functionHashes(database);
  const removed = [...before.keys()].filter((fn) => !after.has(fn)).map((fn) => fn.replace(/\(.*$/, "")).sort();
  assert.deepEqual(removed, [...QUEUE_FUNCTIONS, ...INTERNAL_FUNCTIONS].sort());
  for (const [fn, hash] of after) assert.equal(before.get(fn), hash, `${fn} não pode mudar`);
  assert.equal(await count(`select count(*)::int as n from pg_trigger where tgname = 'reservation_session_changes_reschedule_email'`), 0);

  // O registro do que já tinha sido enfileirado continua lá.
  assert.equal(await count(`select count(*)::int as n from public.reservation_reschedule_emails`), 1);

  // A etapa anterior segue inteira, e reagendar funciona — sem enfileirar.
  assert.deepEqual(failing(await diagnostic(database, "diagnostics/reservation_standby_admin_panel_postcheck.sql")), []);
  const second = await seedRescheduled(database, 2);
  assert.equal(second.resolution.resolution, "RESCHEDULED");
  assert.equal(await count(`select count(*)::int as n from public.reservation_reschedule_emails`), 1);
  assert.equal(((await database.query(`select status from public.reservations where id = $1::uuid`, [first.reservationId])).rows[0] as Row).status, "CONFIRMED");

  // Refazer o rollback não quebra; reaplicar a migration devolve tudo.
  await database.exec(rollback);
  await applyMigration(database, EMAIL_MIGRATION);
  const restored = await diagnostic(database, POSTCHECK);
  assert.deepEqual(failing(restored), ["REAGENDAMENTOS_SEM_LINHA_NA_FILA=ATENCAO"], "o reagendamento feito sem a trigger fica sem e-mail, e o postcheck avisa");
  assert.deepEqual([...(await functionHashes(database))], [...before]);
  await seedRescheduled(database, 3);
  assert.equal(await count(`select count(*)::int as n from public.reservation_reschedule_emails`), 2);
});
