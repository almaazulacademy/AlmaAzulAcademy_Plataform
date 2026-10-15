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

import { rescheduleEmailNeedsAttention, rescheduleEmailNotice } from "../lib/admin/standby.ts";
import { EmailProviderError, emailDeliveryOf } from "../lib/email/email-provider.ts";
import { ResendProvider } from "../lib/email/resend.ts";
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
import {
  ADMIN,
  fakeResend,
  INSTRUCTOR,
  LEASE_MINUTES,
  MAX_ATTEMPTS,
  rescheduleFixtures,
  STRANGER,
  WINDOW_MINUTES,
  type Query,
  type Row,
} from "./support/reschedule-email-fixtures.ts";

const PANEL_MIGRATION = "202610140001_reservation_standby_admin_panel.sql";
const EMAIL_MIGRATION = "202610150001_reservation_reschedule_email.sql";

const QUEUE_FUNCTIONS = [
  "admin_claim_reservation_reschedule_email",
  "admin_list_undelivered_reschedule_emails",
  "admin_reservation_reschedule_emails",
  "claim_pending_reservation_reschedule_emails",
  "claim_reservation_reschedule_email",
  "complete_reservation_reschedule_email",
  "fail_reservation_reschedule_email",
  "freeze_reservation_reschedule_email",
];
const INTERNAL_FUNCTIONS = [
  "enqueue_reservation_reschedule_email",
  "reservation_reschedule_email_fingerprint",
  "reservation_reschedule_email_payload",
  "reservation_reschedule_email_rejection",
  "reservation_reschedule_email_take",
];

const db = await fullDatabase();
const query: Query = async (sql, params = []) => (await db.query(sql, params)).rows as Row[];

const {
  rows, one, call,
  IMERSAO, SUNSET_CONCHA,
  uniquePrice, makeSession, reserve, setStandby, reschedule, reservation, rescheduled,
  emails, attempts, queueSize,
  claimFor, claimPending, adminClaim, freeze, complete, fail, messageFor, claimAndFreeze,
  expireLease, skipBackoff, settleQueue,
} = await rescheduleFixtures(query);

beforeEach(settleQueue);

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: Error) => {
    assert.match(error.message, pattern);
    return true;
  });
}

/** Sem espera entre tentativas: aqui o que se testa é a fila, não o relógio. */
const NO_BACKOFF = [0, 0, 0, 0, 0] as const;

function createRuntime() {
  const admin = createPgliteAdmin(db);
  const provider = fakeResend();
  const logs: Row[] = [];
  const runtime: RescheduleEmailRuntime = {
    queue: createRescheduleEmailQueue(admin.client, { maxAttempts: MAX_ATTEMPTS, leaseMinutes: LEASE_MINUTES, windowMinutes: WINDOW_MINUTES, backoffSeconds: NO_BACKOFF }),
    provider,
    log: (fields) => { logs.push(fields); },
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

test("a migration só acrescenta: duas tabelas, uma trigger e treze funções; nenhuma função anterior muda", async () => {
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

test("ninguém da API pública executa a fila; a service role só opera pelas oito RPCs e só lê as tabelas", async () => {
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
  assert.equal(provider.requests.length, 0);

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
  assert.equal(provider.delivered.length, 1);
  assert.match(provider.delivered[0].subject, /^Reagendamento confirmado — /);

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
  assert.equal(claim.generation, 1);
  assert.equal(claim.message, null, "primeira tentativa: a mensagem ainda vai ser montada");
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
  assert.equal(row.generation, 1);
  assert.equal(row.generation_uncertain, false);
  assert.ok(new Date(row.locked_until).getTime() > Date.now());
  assert.ok(new Date(row.locked_until).getTime() <= Date.now() + LEASE_MINUTES * 60_000 + 5_000, "o prazo é o da política");
  assert.deepEqual((await attempts(emailId)).map((item) => [item.attempt, item.generation, item.source, item.outcome]), [[1, 1, "RESCHEDULE", null]]);

  // Enquanto o prazo vale: nem de novo pelo reagendamento, nem pela rotina, nem pelo painel.
  assert.equal(await claimFor(changeId), null);
  assert.deepEqual(await claimPending(), []);
  assert.equal(await adminClaim(booking.id), null);
  assert.equal((await emails(booking.id))[0].attempts, 1);

  // Concluído: definitivo.
  assert.equal(await complete(emailId, claim.claimToken), true);
  const [sent] = await emails(booking.id);
  assert.equal(sent.status, "SENT");
  assert.ok(sent.sent_at);
  assert.equal(sent.locked_until, null);
  assert.equal(await claimFor(changeId), null);
  assert.deepEqual(await claimPending(), []);
  assert.equal(await adminClaim(booking.id), null);
  assert.deepEqual((await attempts(emailId)).map((item) => [item.attempt, item.outcome]), [[1, "SENT"]]);
});

test("reivindicações simultâneas — do reagendamento, da rotina e do painel — terminam em uma só", async () => {
  const { booking, changeId } = await rescheduled();

  const results = await Promise.all([
    claimFor(changeId),
    claimPending(),
    claimFor(changeId),
    adminClaim(booking.id),
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

test("a ordem de travas: reserva antes da fila, sempre — e a decisão só depois das duas", () => {
  const sql = source(`supabase/migrations/${EMAIL_MIGRATION}`).replace(/--.*$/gm, "");
  const body = (fn: string) => {
    const start = sql.indexOf(`create or replace function public.${fn}(`);
    assert.ok(start > 0, fn);
    return sql.slice(start, sql.indexOf("$$;", start));
  };

  // O núcleo: reserva (compartilhado) → linha da fila → decisão.
  const take = body("reservation_reschedule_email_take");
  const reservationLock = take.indexOf("from public.reservations r where r.id = owner_reservation for share");
  const queueLock = take.indexOf("from public.reservation_reschedule_emails where id = p_email_id for update skip locked");
  assert.ok(reservationLock > 0 && queueLock > reservationLock, "a reserva é travada antes da linha da fila");
  for (const decision of ["queued.status in ('SENT', 'SKIPPED')", "queued.locked_until > now()", "reservation_reschedule_email_rejection", "insert into public.reservation_reschedule_email_attempts", "set status = 'SENDING'"]) {
    assert.ok(take.indexOf(decision) > queueLock, `${decision} vem depois dos dois locks`);
  }
  // A espera pela reserva tem limite: uma transação presa não segura a fila.
  assert.match(take, /set lock_timeout = '3s'/);

  // A rotina só escolhe candidatos: não trava a linha da fila antes de o núcleo
  // travar a reserva, e uma reserva presa não derruba o lote.
  const batch = body("claim_pending_reservation_reschedule_emails");
  assert.doesNotMatch(batch, /for update|for share/);
  assert.match(batch, /exception when lock_not_available then/);

  // Congelar, concluir e falhar só travam a linha da fila — nunca a reserva.
  for (const fn of ["freeze_reservation_reschedule_email", "complete_reservation_reschedule_email", "fail_reservation_reschedule_email"]) {
    const code = body(fn);
    assert.ok(code.indexOf("where id = p_email_id for update") < code.indexOf("reservation_reschedule_email_attempts a"), fn);
    assert.doesNotMatch(code, /from public\.reservations[^;]*for (update|share)/, `${fn} não trava a reserva`);
  }
  // E nenhuma outra função da migration trava reserva ou fila.
  for (const fn of ["claim_reservation_reschedule_email", "admin_claim_reservation_reschedule_email", "admin_reservation_reschedule_emails", "admin_list_undelivered_reschedule_emails", "reservation_reschedule_email_rejection", "reservation_reschedule_email_payload", "reservation_reschedule_email_fingerprint", "enqueue_reservation_reschedule_email"]) {
    assert.doesNotMatch(body(fn), /for update|for share/, fn);
  }
});

test("falha: o erro vira símbolo curto, a espera é respeitada e o teto de tentativas também", async () => {
  const { booking, emailId, changeId } = await rescheduled();

  const first = await claimFor(changeId);
  // Mesmo que a aplicação mandasse a resposta inteira do provedor, nenhum pedaço dela é gravado.
  assert.equal(await fail(emailId, first.claimToken, 'http 422: {"message":"domain not verified","to":"cliente@exemplo.com"}', "REJECTED", 60), true);
  let [row] = await emails(booking.id);
  assert.equal(row.status, "FAILED");
  assert.equal(row.last_error_code, "UNKNOWN_ERROR");
  assert.equal(row.locked_until, null);
  assert.ok(new Date(row.next_attempt_at).getTime() > Date.now() + 50_000, "a espera pedida foi gravada");

  // Dentro da espera, ninguém tenta sozinho — nem pela requisição, nem pela rotina.
  assert.equal(await claimFor(changeId), null);
  assert.deepEqual(await claimPending(), []);
  assert.equal((await emails(booking.id))[0].attempts, 1);

  // Passada a espera, a rotina pega.
  await skipBackoff(emailId);
  const second = await claimPending();
  assert.equal(second.length, 1);
  assert.equal(second[0].attempt, 2);
  await fail(emailId, second[0].claimToken, " http_429 ", "REJECTED");

  for (let attempt = 3; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const claim = await claimFor(changeId);
    assert.equal(claim.attempt, attempt);
    await fail(emailId, claim.claimToken, "TIMEOUT", "UNKNOWN");
  }

  // Seis tentativas: para de tentar sozinho.
  assert.equal(await claimFor(changeId), null);
  assert.deepEqual(await claimPending(), []);
  [row] = await emails(booking.id);
  assert.equal(row.status, "FAILED");
  assert.equal(row.attempts, MAX_ATTEMPTS);
  assert.equal(row.last_error_code, "TIMEOUT");
  assert.deepEqual(
    (await attempts(emailId)).map((item) => [item.attempt, item.source, item.outcome, item.error_code]),
    [
      [1, "RESCHEDULE", "REJECTED", "UNKNOWN_ERROR"],
      [2, "RETRY", "REJECTED", "HTTP_429"],
      [3, "RESCHEDULE", "UNKNOWN", "TIMEOUT"],
      [4, "RESCHEDULE", "UNKNOWN", "TIMEOUT"],
      [5, "RESCHEDULE", "UNKNOWN", "TIMEOUT"],
      [6, "RESCHEDULE", "UNKNOWN", "TIMEOUT"],
    ],
  );
  for (const item of await attempts(emailId)) assert.ok(item.finished_at);
});

test("depois do teto, só uma pessoa da equipe reenvia — e isso fica na auditoria", async () => {
  const { booking, emailId, changeId } = await rescheduled();
  for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
    const claim = await claimFor(changeId);
    await fail(emailId, claim.claimToken, "HTTP_403", "REJECTED");
  }
  assert.equal(await claimFor(changeId), null);

  await rejects(adminClaim(booking.id, INSTRUCTOR), /ADMIN_FORBIDDEN/);
  await rejects(adminClaim(booking.id, STRANGER), /ADMIN_FORBIDDEN/);
  await rejects(call(`public.admin_reservation_reschedule_emails($1::uuid, $2::uuid)`, [INSTRUCTOR, booking.id]), /ADMIN_FORBIDDEN/);
  await rejects(call(`public.admin_list_undelivered_reschedule_emails($1::uuid, 20)`, [INSTRUCTOR]), /ADMIN_FORBIDDEN/);
  assert.equal((await emails(booking.id))[0].attempts, MAX_ATTEMPTS, "quem não é da equipe não gasta tentativa");

  // Uma pessoa pedindo: sem teto e sem espera.
  await rows(`update public.reservation_reschedule_emails set next_attempt_at = now() + interval '2 hours' where id = $1::uuid`, [emailId]);
  const manual = await adminClaim(booking.id);
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
  assert.deepEqual(audit[0].metadata, { emailId, attempt: MAX_ATTEMPTS + 1, generation: manual.generation, previousStatus: "FAILED", acceptedDuplicateRisk: false });

  assert.equal(await complete(emailId, manual.claimToken), true);
  assert.equal((await emails(booking.id))[0].status, "SENT");
  // Enviado: o painel não reenvia.
  assert.equal(await adminClaim(booking.id), null);
  const state = await call(`public.admin_reservation_reschedule_emails($1::uuid, $2::uuid)`, [ADMIN, booking.id]);
  assert.equal(state.length, 1);
  assert.equal(state[0].status, "SENT");
  assert.equal(state[0].attempts, MAX_ATTEMPTS + 1);
  assert.deepEqual(Object.keys(state[0]).sort(), ["actorType", "attempts", "changeId", "createdAt", "emailId", "inFlight", "lastAttemptAt", "lastErrorCode", "nextAttemptAt", "sentAt", "standbyId", "status"]);
});

test("instância que morre no meio do envio: o prazo vence, a tentativa fica registrada e outra assume", async () => {
  const { booking, emailId, changeId } = await rescheduled();

  const lost = await claimAndFreeze(changeId, booking.id);
  assert.deepEqual(await claimPending(), [], "dentro do prazo, ninguém assume");

  await expireLease(emailId);
  const retaken = await claimPending();
  assert.equal(retaken.length, 1);
  assert.equal(retaken[0].attempt, 2);
  assert.notEqual(retaken[0].claimToken, lost.claimToken);
  assert.deepEqual((await attempts(emailId)).map((item) => [item.attempt, item.outcome]), [[1, "LEASE_EXPIRED"], [2, null]]);

  // A falha tardia da tentativa antiga não solta o envio que está em curso.
  assert.equal(await fail(emailId, lost.claimToken, "TIMEOUT", "UNKNOWN"), true);
  let [row] = await emails(booking.id);
  assert.equal(row.status, "SENDING");
  assert.equal(row.attempts, 2);
  assert.deepEqual((await attempts(emailId)).map((item) => [item.attempt, item.outcome, item.error_code]), [[1, "UNKNOWN", "TIMEOUT"], [2, null, null]]);
  assert.equal(await claimFor(changeId), null);

  assert.equal(await complete(emailId, retaken[0].claimToken), true);
  [row] = await emails(booking.id);
  assert.equal(row.status, "SENT");

  // Um token que nunca existiu não congela, não conclui nem falha nada.
  const nobody = "00000000-0000-4000-8000-000000000000";
  assert.equal(await complete(emailId, nobody), false);
  assert.equal(await fail(emailId, nobody, "X", "REJECTED"), false);
  assert.equal(await freeze(emailId, nobody, await messageFor(booking.id)), false);
  // E uma falha tardia não desfaz um envio concluído.
  assert.equal(await fail(emailId, retaken[0].claimToken, "HTTP_500", "UNKNOWN"), false);
  assert.equal((await emails(booking.id))[0].status, "SENT");
});

test("a tentativa que respondeu depois do prazo e deu certo encerra o e-mail: ninguém mais envia", async () => {
  const { booking, emailId, changeId } = await rescheduled();

  const slow = await claimAndFreeze(changeId, booking.id);
  await expireLease(emailId);
  const second = await claimFor(changeId);
  assert.equal(second.attempt, 2);

  // A primeira, lenta, conclui: o e-mail saiu.
  assert.equal(await complete(emailId, slow.claimToken), true);
  let [row] = await emails(booking.id);
  assert.equal(row.status, "SENT");
  assert.equal(row.locked_until, null);
  assert.equal(row.frozen_message, null, "concluído: a mensagem guardada é apagada");

  // A segunda falha (o provedor ainda processava a primeira, por exemplo): o e-mail continua enviado.
  assert.equal(await fail(emailId, second.claimToken, "HTTP_409", "KEY_REFUSED"), true);
  [row] = await emails(booking.id);
  assert.equal(row.status, "SENT");
  assert.equal(row.last_error_code, null);
  assert.equal(await claimFor(changeId), null);
  assert.deepEqual(await claimPending(), []);
  assert.deepEqual((await attempts(emailId)).map((item) => [item.attempt, item.outcome]), [[1, "SENT"], [2, "KEY_REFUSED"]]);
});

test("prazo vencido na última tentativa vira erro visível, e não um envio preso para sempre", async () => {
  const { booking, emailId, changeId } = await rescheduled();
  for (let index = 0; index < MAX_ATTEMPTS - 1; index += 1) {
    const claim = await claimFor(changeId);
    await fail(emailId, claim.claimToken, "HTTP_403", "REJECTED");
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
  assert.equal(await fail(emailId, last.claimToken, "NETWORK_ERROR", "UNKNOWN"), true);
  [row] = await emails(booking.id);
  assert.equal(row.status, "FAILED");
  assert.equal(row.last_error_code, "NETWORK_ERROR");
});

test("a rotina pega o que nunca foi tentado, o que falhou e o que venceu — respeitando limite, ordem e espera", async () => {
  const never = await rescheduled();
  const failed = await rescheduled();
  const stale = await rescheduled();
  const inFlight = await rescheduled();
  const waiting = await rescheduled();

  const failedClaim = await claimFor(failed.changeId);
  await fail(failed.emailId, failedClaim.claimToken, "HTTP_500", "UNKNOWN");
  await claimFor(stale.changeId);
  await expireLease(stale.emailId);
  await claimFor(inFlight.changeId);
  const waitingClaim = await claimFor(waiting.changeId);
  await fail(waiting.emailId, waitingClaim.claimToken, "HTTP_429", "REJECTED", 300);

  const firstBatch = await claimPending(2);
  assert.deepEqual(firstBatch.map((claim: Row) => claim.emailId), [never.emailId, failed.emailId], "a mais antiga primeiro");
  const secondBatch = await claimPending(10);
  assert.deepEqual(secondBatch.map((claim: Row) => claim.emailId), [stale.emailId]);
  assert.deepEqual(await claimPending(10), [], "o envio em curso e o que ainda espera não são atropelados");
  assert.deepEqual(await claimPending(0), []);

  await skipBackoff(waiting.emailId);
  assert.deepEqual((await claimPending(10)).map((claim: Row) => claim.emailId), [waiting.emailId]);
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
  const first = await claimAndFreeze(changeId, booking.id);
  await fail(emailId, first.claimToken, "HTTP_500", "UNKNOWN");

  assert.equal(await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Cliente desistiu')`, [ADMIN, booking.id]), true);

  const { runtime, provider } = createRuntime();
  assert.deepEqual(await retryPendingRescheduleEmails(runtime), { outcome: "PROCESSED", processed: 0, sent: 0 });
  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, booking.id), { outcome: "SKIPPED" });
  assert.equal(provider.requests.length, 0);
  const [row] = await emails(booking.id);
  assert.deepEqual([row.status, row.last_error_code, row.attempts], ["SKIPPED", "RESERVATION_NOT_CONFIRMED", 1]);
  assert.equal(row.frozen_message, null, "descartado: a mensagem guardada é apagada");
});

test("turma que já começou: o e-mail atrasado não sai", async () => {
  const { booking, destination, emailId, changeId } = await rescheduled();
  const first = await claimFor(changeId);
  await fail(emailId, first.claimToken, "TIMEOUT", "UNKNOWN");

  // A rotina só roda depois de a turma ter acontecido.
  await rows(`update public.sessions set starts_at = now() - interval '2 hours' where id = $1::uuid`, [destination]);

  const { runtime, provider } = createRuntime();
  assert.deepEqual(await retryPendingRescheduleEmails(runtime), { outcome: "PROCESSED", processed: 0, sent: 0 });
  assert.equal(provider.requests.length, 0);
  const [row] = await emails(booking.id);
  assert.deepEqual([row.status, row.last_error_code], ["SKIPPED", "SESSION_STARTED"]);
  // SKIPPED é definitivo: nem a rotina nem o painel o reabrem.
  assert.deepEqual(await claimPending(), []);
  assert.equal(await adminClaim(booking.id), null);
});

// =============================================================================
// 5. Fluxo completo: reagendou, enviou
// =============================================================================

test("reagendamento confirmado no banco envia um e-mail, com a turma nova e a chave do reagendamento", async () => {
  const { booking, destination, emailId, changeId } = await rescheduled({ quantity: 3, name: "Marina <b>Albuquerque</b>" });
  const { runtime, provider, logs } = createRuntime();

  assert.deepEqual(await sendRescheduleEmailForChange(runtime, changeId), { outcome: "SENT" });

  assert.equal(provider.delivered.length, 1);
  const [message] = provider.delivered;
  assert.equal(message.to, booking.email);
  assert.equal(message.subject, `Reagendamento confirmado — ${booking.code}`);
  assert.equal(message.idempotencyKey, `reschedule-confirmation/${emailId}/1`);

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
  assert.equal(row.frozen_message, null);
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

  assert.equal(provider.requests.length, 1, "um único pedido ao provedor");
  assert.equal(provider.delivered.length, 1, "um único e-mail");
  const senders = [first, second, third, panel].filter((result) => result.outcome === "SENT").length + routine.sent;
  assert.equal(senders, 1, "um único chamador enviou");

  // Dez repetições depois, continua um.
  for (let index = 0; index < 10; index += 1) assert.deepEqual(await submit(), { outcome: "SKIPPED" });
  assert.deepEqual(await sendRescheduleEmailForChange(runtime, changeId), { outcome: "SKIPPED" });
  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, booking.id), { outcome: "SKIPPED" });
  assert.equal(provider.requests.length, 1);
  assert.equal((await emails(booking.id)).length, 1);
});

test("provedor fora do ar: o reagendamento continua valendo, o envio fica pendente e a rotina recupera", async () => {
  const { booking, destination, emailId, changeId } = await rescheduled();
  const { runtime, provider, logs } = createRuntime();

  provider.next(new EmailProviderError("HTTP_429", true, "NOT_SENT"));
  assert.deepEqual(await sendRescheduleEmailForChange(runtime, changeId), { outcome: "PENDING", errorCode: "HTTP_429", retryable: true });
  assert.equal(provider.delivered.length, 0);

  const stored = await reservation(booking.id);
  assert.equal(stored.status, "CONFIRMED", "a falha do e-mail não desfaz o reagendamento");
  assert.equal(stored.session_id, destination);
  let [row] = await emails(booking.id);
  assert.deepEqual([row.status, row.attempts, row.last_error_code], ["FAILED", 1, "HTTP_429"]);

  // Segunda tentativa, pela rotina: o pedido nem chega.
  provider.next("lost");
  assert.deepEqual(await retryPendingRescheduleEmails(runtime), { outcome: "PROCESSED", processed: 1, sent: 0 });
  [row] = await emails(booking.id);
  assert.deepEqual([row.status, row.attempts, row.last_error_code], ["FAILED", 2, "NETWORK_ERROR"]);

  // Terceira: o provedor voltou.
  assert.deepEqual(await retryPendingRescheduleEmails(runtime), { outcome: "PROCESSED", processed: 1, sent: 1 });
  assert.equal(provider.delivered.length, 1);
  [row] = await emails(booking.id);
  assert.deepEqual([row.status, row.attempts, row.last_error_code], ["SENT", 3, null]);
  assert.deepEqual(
    (await attempts(emailId)).map((item) => [item.attempt, item.source, item.outcome, item.error_code]),
    [[1, "RESCHEDULE", "REJECTED", "HTTP_429"], [2, "RETRY", "UNKNOWN", "NETWORK_ERROR"], [3, "RETRY", "SENT", null]],
  );
  assert.ok(logs.some((entry) => entry.outcome === "pending" && entry.errorCode === "HTTP_429"));

  // Nada mais a recuperar.
  assert.deepEqual(await retryPendingRescheduleEmails(runtime), { outcome: "PROCESSED", processed: 0, sent: 0 });
  assert.equal(provider.delivered.length, 1);
});

test("um envio bem-sucedido leva de carona até dois pendentes; com o provedor fora, não insiste", async () => {
  const old = [await rescheduled(), await rescheduled(), await rescheduled()];
  const fresh = await rescheduled();
  const { runtime, provider } = createRuntime();

  // Provedor fora: o envio principal falha e nenhuma carona é tentada.
  provider.next(new EmailProviderError("HTTP_403", false, "NOT_SENT"));
  assert.deepEqual(await sendRescheduleEmailForChange(runtime, fresh.changeId), { outcome: "PENDING", errorCode: "HTTP_403", retryable: false });
  assert.equal(provider.requests.length, 1);
  for (const item of old) assert.equal((await emails(item.booking.id))[0].status, "QUEUED");

  // Provedor de volta: o próximo reagendamento envia o dele e recupera dois.
  const next = await rescheduled();
  assert.deepEqual(await sendRescheduleEmailForChange(runtime, next.changeId), { outcome: "SENT" });
  assert.equal(provider.delivered.length, 3);
  assert.deepEqual(
    await Promise.all([...old, fresh, next].map(async (item) => (await emails(item.booking.id))[0].status)),
    ["SENT", "SENT", "QUEUED", "FAILED", "SENT"],
  );
});

test("reserva sem e-mail utilizável: nada é enviado e o erro fica visível", async () => {
  const { booking, changeId } = await rescheduled();
  await rows(`update public.reservations set email = 'sem-arroba' where id = $1::uuid`, [booking.id]);
  const { runtime, provider } = createRuntime();

  assert.deepEqual(await sendRescheduleEmailForChange(runtime, changeId), { outcome: "PENDING", errorCode: "PAYLOAD_EMPTY", retryable: false });
  assert.equal(provider.requests.length, 0);
  const [row] = await emails(booking.id);
  assert.deepEqual([row.status, row.last_error_code], ["FAILED", "PAYLOAD_EMPTY"]);

  // Cadastro corrigido: o reenvio pelo painel resolve.
  await rows(`update public.reservations set email = $2 where id = $1::uuid`, [booking.id, booking.email]);
  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, booking.id), { outcome: "SENT" });
  assert.equal(provider.delivered[0].to, booking.email);
});

test("banco indisponível: o envio não lança, não envia e continua na fila", async () => {
  const { booking, changeId } = await rescheduled();
  const { runtime, provider, admin } = createRuntime();

  admin.failRpc("claim_reservation_reschedule_email", { code: "PGRST202", message: "function not found" });
  assert.deepEqual(await sendRescheduleEmailForChange(runtime, changeId), { outcome: "PENDING", errorCode: "CLAIM_UNAVAILABLE", retryable: true });
  admin.failRpc("claim_pending_reservation_reschedule_emails", { message: "timeout" });
  assert.deepEqual(await retryPendingRescheduleEmails(runtime), { outcome: "FAILED", processed: 0, sent: 0, errorCode: "CLAIM_UNAVAILABLE" });
  admin.failRpc("admin_claim_reservation_reschedule_email", { message: "timeout" });
  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, booking.id), { outcome: "PENDING", errorCode: "CLAIM_UNAVAILABLE", retryable: true });

  assert.equal(provider.requests.length, 0);
  assert.equal((await emails(booking.id))[0].status, "QUEUED", "nada foi consumido");
});

test("se a mensagem não puder ser guardada antes do envio, nada é enviado", async () => {
  const { booking, emailId, changeId } = await rescheduled();
  const { runtime, provider, admin } = createRuntime();

  admin.failRpc("freeze_reservation_reschedule_email", { message: "connection reset" });
  assert.deepEqual(await sendRescheduleEmailForChange(runtime, changeId), { outcome: "PENDING", errorCode: "FREEZE_FAILED", retryable: true });
  assert.equal(provider.requests.length, 0, "sem a mensagem gravada não há como repetir o envio com segurança");

  let [row] = await emails(booking.id);
  assert.deepEqual([row.status, row.last_error_code, row.generation_uncertain], ["FAILED", "FREEZE_FAILED", false]);
  assert.deepEqual((await attempts(emailId)).map((item) => item.outcome), ["REJECTED"], "comprovadamente não enviado");

  // Na tentativa seguinte, com o banco de volta, sai normalmente.
  assert.deepEqual(await retryPendingRescheduleEmails(runtime), { outcome: "PROCESSED", processed: 1, sent: 1 });
  assert.equal(provider.delivered.length, 1);
  [row] = await emails(booking.id);
  assert.equal(row.status, "SENT");
});

test("o QR do e-mail é o da reserva e vale na turma nova", async () => {
  const { booking, destination, changeId } = await rescheduled();
  const { runtime, provider } = createRuntime();
  await sendRescheduleEmailForChange(runtime, changeId);

  const token = (await reservation(booking.id)).checkin_token as string;
  assert.ok(provider.delivered[0].html.includes(`/api/checkin/qr/${token}`));
  assert.ok(provider.delivered[0].text.includes(`/checkin/${token}`));

  const ticket = await call(`public.public_checkin_ticket($1::uuid)`, [token]);
  const target = await one(`select starts_at from public.sessions where id = $1::uuid`, [destination]);
  assert.equal(new Date(ticket.startsAt).getTime(), new Date(target.starts_at).getTime());
  assert.equal(ticket.baseName, SUNSET_CONCHA.base_name);
  // E o check-in com esse QR registra na turma nova.
  const checked = await call(`public.admin_register_checkin($1::uuid, $2::uuid, 2, 'MANUAL', $3::uuid, false)`, [ADMIN, booking.id, destination]);
  assert.ok(checked);
});

test("do Lago Norte para o Cápsula Bar — e o caminho de volta: o e-mail é inteiro da base nova", async () => {
  const { formatSessionDate, formatSessionTime } = await import("../lib/sessions/date-time.ts");
  const startsAt = async (sessionId: string) => new Date((await one(`select starts_at from public.sessions where id = $1::uuid`, [sessionId])).starts_at).toISOString();
  assert.notEqual(IMERSAO.base_id, SUNSET_CONCHA.base_id);
  assert.equal(IMERSAO.base_slug, "lago-norte");
  assert.equal(IMERSAO.maps_url, null, "o Lago Norte não tem link de mapa cadastrado");
  assert.ok(SUNSET_CONCHA.maps_url && SUNSET_CONCHA.meeting_point && SUNSET_CONCHA.address);

  // --- Lago Norte → Cápsula Bar ------------------------------------------------
  const toConcha = await rescheduled({ quantity: 2, startsIn: "14 days 5 hours" });
  const first = createRuntime();
  assert.deepEqual(await sendRescheduleEmailForChange(first.runtime, toConcha.changeId), { outcome: "SENT" });
  const [arrival] = first.provider.delivered;
  const oldStart = await startsAt(toConcha.origin);
  const newStart = await startsAt(toConcha.destination);
  assert.notEqual(formatSessionDate(oldStart), formatSessionDate(newStart), "o cenário precisa de datas diferentes");

  for (const body of [arrival.html, arrival.text]) {
    // Tudo da turma nova…
    assert.ok(body.includes(SUNSET_CONCHA.title), "nova experiência");
    assert.ok(body.includes(formatSessionDate(newStart)), "nova data");
    assert.ok(body.includes(formatSessionTime(newStart)), "novo horário");
    assert.ok(body.includes(SUNSET_CONCHA.base_name), "nova base");
    assert.ok(body.includes(SUNSET_CONCHA.meeting_point), "ponto de encontro da nova base");
    assert.ok(body.includes(SUNSET_CONCHA.address), "endereço da nova base");
    assert.ok(body.includes(SUNSET_CONCHA.maps_url), "link do mapa da nova base");
    assert.ok(body.includes(toConcha.booking.code), "o mesmo código");
    // …e nada da turma de onde a reserva saiu.
    assert.ok(!body.includes(IMERSAO.title), "a experiência anterior não aparece");
    assert.ok(!body.includes(IMERSAO.address), "o endereço do Lago Norte não aparece");
    assert.ok(!body.includes("Lago Norte"), "a base anterior não aparece");
    assert.ok(!body.includes(formatSessionDate(oldStart)), "a data anterior não aparece");
  }
  assert.match(arrival.text, new RegExp(`Base: ${SUNSET_CONCHA.base_name}`));
  assert.match(arrival.html, new RegExp(`<a href="${SUNSET_CONCHA.maps_url.replace(/[.?]/g, "\\$&")}"`), "o botão do mapa aponta para a base nova");

  // --- Cápsula Bar → Lago Norte ------------------------------------------------
  const price = uniquePrice();
  const origin = await makeSession(SUNSET_CONCHA.id, { price, startsIn: "9 days" });
  const destination = await makeSession(IMERSAO.id, { price, startsIn: "16 days 3 hours" });
  const booking = await reserve(origin, 4);
  await setStandby(booking.id);
  const back = await reschedule(booking.id, destination);
  const second = createRuntime();
  assert.deepEqual(await sendRescheduleEmailForChange(second.runtime, back.changeId), { outcome: "SENT" });
  const [returning] = second.provider.delivered;
  const lagoStart = await startsAt(destination);

  for (const body of [returning.html, returning.text]) {
    assert.ok(body.includes(IMERSAO.title));
    assert.ok(body.includes(formatSessionDate(lagoStart)));
    assert.ok(body.includes(formatSessionTime(lagoStart)));
    assert.ok(body.includes(IMERSAO.address), "endereço do Lago Norte");
    assert.ok(!body.includes(SUNSET_CONCHA.title));
    assert.ok(!body.includes(SUNSET_CONCHA.address), "o endereço do Cápsula Bar não aparece");
    assert.ok(!body.includes(SUNSET_CONCHA.meeting_point));
    assert.ok(!body.includes("Cápsula"), "a base anterior não aparece");
    assert.ok(!/maps\.|google\.com\/maps/.test(body), "sem link de mapa: o Lago Norte não tem um cadastrado");
  }
  assert.match(returning.text, /Base: Lago Norte/);
  assert.match(returning.text, /Participantes: 4/);

  // O QR é o mesmo nas duas direções: é o da reserva, não o da turma.
  for (const [message, reservationId] of [[arrival, toConcha.booking.id], [returning, booking.id]] as const) {
    const token = (await reservation(reservationId)).checkin_token as string;
    assert.ok(message.html.includes(`/api/checkin/qr/${token}`));
    assert.ok(message.text.includes(`/checkin/${token}`));
  }
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
  for (const fn of ["sendRescheduleConfirmationEmail", "followUpRescheduleConfirmationEmail", "retryPendingRescheduleConfirmationEmails", "resendRescheduleConfirmationEmail", "getRescheduleEmailStates", "getUndeliveredRescheduleEmails"]) {
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
    "app/admin/stand-by/page.tsx",
    "app/api/admin/reservations/[reservationId]/standby/reschedule-email/route.ts",
    "app/api/admin/reservations/[reservationId]/standby/reschedule/route.ts",
    "app/api/admin/reservations/[reservationId]/standby/route.ts",
    "app/api/cron/confirmation-emails/route.ts",
    "app/api/cron/reschedule-emails/route.ts",
    // Etapa 5: o reagendamento feito pelo próprio cliente. Ver o fim deste teste.
    "lib/reservations/standby-self-service-http.ts",
  ]);

  // Quem chama cada operação do serviço.
  const callers = (fn: string) => application.filter((path) => path !== "lib/reservations/reschedule-email-service.ts" && new RegExp(`\\b${fn}\\(`).test(source(path))).sort();
  const reschedule = "app/api/admin/reservations/[reservationId]/standby/reschedule/route.ts";
  assert.deepEqual(callers("sendRescheduleConfirmationEmail"), [reschedule]);
  assert.deepEqual(callers("followUpRescheduleConfirmationEmail"), [reschedule]);
  assert.deepEqual(callers("resendRescheduleConfirmationEmail"), ["app/api/admin/reservations/[reservationId]/standby/reschedule-email/route.ts"]);
  // A recuperação de pendências: as duas rotas de rotina e as duas páginas do
  // painel de Stand-by, que só a acionam depois de responder.
  assert.deepEqual(callers("retryPendingRescheduleConfirmationEmails"), [
    "app/admin/reservas/[reservationId]/page.tsx",
    "app/admin/stand-by/page.tsx",
    "app/api/cron/confirmation-emails/route.ts",
    "app/api/cron/reschedule-emails/route.ts",
  ]);
  for (const page of ["app/admin/reservas/[reservationId]/page.tsx", "app/admin/stand-by/page.tsx"]) {
    assert.match(source(page), /after\(\(\) => retryPendingRescheduleConfirmationEmails\(\)\)/, `${page}: a fila é acionada depois da resposta`);
    assert.doesNotMatch(source(page), /await retryPendingRescheduleConfirmationEmails/, `${page}: nunca segura a página`);
  }
  // A rota de leitura só pergunta se o e-mail está ativado: nunca envia.
  assert.doesNotMatch(source("app/api/admin/reservations/[reservationId]/standby/route.ts"), /\b(sendRescheduleConfirmationEmail|followUpRescheduleConfirmationEmail|resendRescheduleConfirmationEmail|retryPendingRescheduleConfirmationEmails)\b/);
  for (const path of ["app/api/admin/reservations/[reservationId]/standby/undo/route.ts", "app/api/admin/reservations/[reservationId]/standby/link/route.ts", "lib/admin/standby-data.ts"]) {
    assert.doesNotMatch(source(path), /reschedule-email|RescheduleEmail|sendReservationConfirmationEmail/, `${path} não envia e-mail`);
  }
  // Autoatendimento (etapa 5): a ligação só entrega o envio e a nova tentativa ao
  // fluxo, e só a escolha confirmada pelo banco os chama — a tela nunca.
  const selfServiceHttp = source("lib/reservations/standby-self-service-http.ts");
  assert.match(selfServiceHttp, /sendConfirmationEmail: sendRescheduleConfirmationEmail,/);
  assert.match(selfServiceHttp, /followUpConfirmationEmail: followUpRescheduleConfirmationEmail,/);
  assert.doesNotMatch(selfServiceHttp, /\b(resendRescheduleConfirmationEmail|retryPendingRescheduleConfirmationEmails)\b/);
  const selfService = source("lib/reservations/standby-self-service.ts");
  const sendCalls = [...selfService.matchAll(/deps\.sendConfirmationEmail\(/g)].map((match) => match.index ?? 0);
  assert.equal(sendCalls.length, 1);
  assert.ok(sendCalls[0] > selfService.indexOf("export async function handleSelfServiceReschedule"), "só a escolha confirmada envia");
  assert.ok(sendCalls[0] > selfService.indexOf("parseStandbyResolution(result.data)"), "e só depois de o banco devolver o reagendamento");

  // O reagendamento tradicional e as demais ações do painel não conhecem esta fila.
  assert.doesNotMatch(source("lib/admin/data.ts"), /reschedule-email|RescheduleEmail|reservation_reschedule_email/);

  // Na rota: o e-mail vem depois de o banco confirmar, e usa a chave que o banco devolveu.
  const route = source("app/api/admin/reservations/[reservationId]/standby/reschedule/route.ts");
  assert.ok(route.indexOf("await rescheduleReservationFromStandby(") < route.indexOf("sendRescheduleConfirmationEmail(resolution.changeId)"));
  assert.ok(route.indexOf("if (!resolution) return") < route.indexOf("sendRescheduleConfirmationEmail("));
  // As novas tentativas só acontecem depois da resposta, só quando a primeira
  // não deu certo, e só quando repetir pode resolver.
  assert.match(route, /if \(email\.outcome === "PENDING" && email\.retryable !== false\) \{\s+after\(\(\) => followUpRescheduleConfirmationEmail\(resolution\.changeId\)\);/);
  assert.match(route, /export const maxDuration = 60;/);
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
  // Nenhuma rotina agendada nova, e nenhum horário alterado: mudar o agendamento
  // depende de aprovação. A rota dedicada existe, mas ninguém a agenda.
  assert.deepEqual(JSON.parse(source("vercel.json")).crons, [
    { path: "/api/cron/payment-reconciliation", schedule: "20 12 * * *" },
    { path: "/api/cron/confirmation-emails", schedule: "0 12 * * *" },
  ]);
  const dedicated = source("app/api/cron/reschedule-emails/route.ts");
  assert.match(dedicated, /isAuthorizedCronRequest\(request, secret\)/);
  assert.match(dedicated, /status: 503/);
  assert.doesNotMatch(dedicated, /retryPendingConfirmationEmails/, "a rota dedicada não toca o e-mail de pagamento");
});

test("textos do painel: o que o admin lê sobre o e-mail de cada reagendamento", () => {
  assert.match(rescheduleEmailNotice("SENT"), /foi enviado ao cliente/);
  assert.match(rescheduleEmailNotice("PENDING"), /AINDA NÃO recebeu/);
  assert.match(rescheduleEmailNotice("SKIPPED"), /já foi enviado ou está em andamento/);
  for (const unknown of ["DISABLED", "", undefined, null, "QUALQUER"]) assert.equal(rescheduleEmailNotice(unknown), "Nenhum e-mail foi enviado: avise o cliente.");
  // Só o envio que não saiu vira alerta; os demais continuam como aviso comum.
  assert.equal(rescheduleEmailNeedsAttention("PENDING"), true);
  for (const calm of ["SENT", "SKIPPED", "DISABLED", undefined, null]) assert.equal(rescheduleEmailNeedsAttention(calm), false);

  const base = { emailId: "e", standbyId: "s", inFlight: false, attempts: 2, lastErrorCode: null, lastAttemptAt: null, nextAttemptAt: null, sentAt: null, createdAt: "2026-10-13T12:00:00Z" };
  const format = (value: string | null) => `<${value}>`;
  assert.equal(rescheduleEmailSummary({ ...base, status: "SENT", sentAt: "2026-10-13T12:01:00Z" }, format), "E-mail de confirmação enviado em <2026-10-13T12:01:00Z>.");
  assert.match(rescheduleEmailSummary({ ...base, status: "FAILED", lastErrorCode: "HTTP_422" }, format), /com erro \(HTTP_422\), após 2 tentativa\(s\)/);
  assert.match(rescheduleEmailSummary({ ...base, status: "UNCERTAIN" }, format), /não confirmada/);
  assert.match(rescheduleEmailSummary({ ...base, status: "SKIPPED", lastErrorCode: "SESSION_STARTED" }, format), /a turma começou antes do envio/);
  assert.match(rescheduleEmailSummary({ ...base, status: "SKIPPED", lastErrorCode: "SUPERSEDED" }, format), /mudou de turma de novo/);
  assert.match(rescheduleEmailSummary({ ...base, status: "SENDING", inFlight: true }, format), /em envio/);
  assert.match(rescheduleEmailSummary({ ...base, status: "QUEUED" }, format), /pendente/);

  // O botão de reenvio só aparece quando há o que reenviar.
  assert.equal(canResendRescheduleEmail({ status: "QUEUED", inFlight: false }), true);
  assert.equal(canResendRescheduleEmail({ status: "FAILED", inFlight: false }), true);
  assert.equal(canResendRescheduleEmail({ status: "UNCERTAIN", inFlight: false }), true);
  assert.equal(canResendRescheduleEmail({ status: "SENDING", inFlight: false }), true);
  assert.equal(canResendRescheduleEmail({ status: "SENDING", inFlight: true }), false);
  assert.equal(canResendRescheduleEmail({ status: "SENT", inFlight: false }), false);
  assert.equal(canResendRescheduleEmail({ status: "SKIPPED", inFlight: false }), false);

  assert.equal(parseRescheduleEmailClaim(null), null);
  assert.equal(parseRescheduleEmailClaim({ emailId: "x", generation: 1 }), null, "sem token não há direito de enviar");
  assert.equal(parseRescheduleEmailClaim({ emailId: "x", claimToken: "t" }), null, "sem geração não há chave de idempotência");
  assert.equal(rescheduleEmailIdempotencyKey("abc", 2), "reschedule-confirmation/abc/2");
});

// =============================================================================
// 8. Provedor: a chave de idempotência e o que cada falha diz sobre a entrega
// =============================================================================

async function withFetch<T>(respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>, run: (requests: Array<{ url: string; headers: Record<string, string>; body: string }>) => Promise<T>) {
  const requests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) });
    return respond(String(url), init);
  }) as typeof fetch;
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = original;
  }
}

const RESEND = () => new ResendProvider({ apiKey: "re_test_fake", from: "Alma Azul <teste@exemplo.com>", replyTo: null });

test("Resend: a chave vai exatamente como veio — nunca derivada do conteúdo — e o e-mail de pagamento segue sem ela", async () => {
  await withFetch(() => new Response(JSON.stringify({ id: "fake" }), { status: 200 }), async (requests) => {
    const provider = RESEND();
    const reschedule = buildReservationRescheduleEmail(CONCHA);

    await provider.send(buildReservationConfirmationEmail(CONCHA));
    await provider.send({ ...reschedule, idempotencyKey: "reschedule-confirmation/abc/1" });
    await provider.send({ ...reschedule, text: `${reschedule.text}\ncorrigido`, to: "outro@exemplo.com", idempotencyKey: "reschedule-confirmation/abc/1" });

    assert.equal(requests.length, 3);
    for (const request of requests) assert.equal(request.url, "https://api.resend.com/emails");

    // E-mail de pagamento: requisição igual à de sempre, sem o cabeçalho.
    assert.deepEqual(Object.keys(requests[0].headers).sort(), ["authorization", "content-type"]);
    assert.deepEqual(Object.keys(JSON.parse(requests[0].body)).sort(), ["from", "html", "subject", "text", "to"]);

    // Reagendamento: a mesma chave em qualquer corpo. Se a chave mudasse com o
    // conteúdo, o provedor trataria a segunda mensagem como um e-mail novo e a
    // entregaria — que é exatamente o que a chave existe para impedir.
    assert.equal(requests[1].headers["idempotency-key"], "reschedule-confirmation/abc/1");
    assert.equal(requests[2].headers["idempotency-key"], "reschedule-confirmation/abc/1");
    assert.notEqual(requests[2].body, requests[1].body);
    // A chave não vai no corpo, e o corpo não muda por causa dela.
    assert.ok(!requests[1].body.includes("idempotency"));
    assert.deepEqual(Object.keys(JSON.parse(requests[1].body)).sort(), ["from", "html", "subject", "text", "to"]);
  });
  assert.doesNotMatch(source("lib/email/resend.ts"), /createHash|sha256/, "nenhum resumo do conteúdo entra na chave");
});

test("Resend: recusa comprovada, resultado desconhecido e conflito de chave são coisas diferentes", async () => {
  const failure = async (respond: () => Response | Promise<Response>) => withFetch(respond, async () => {
    try {
      await RESEND().send({ ...buildReservationRescheduleEmail(CONCHA), idempotencyKey: "k" });
    } catch (error) {
      assert.ok(error instanceof EmailProviderError);
      return { code: error.causeCode, delivery: error.delivery, retryable: error.retryable };
    }
    return assert.fail("o envio precisava falhar");
  });
  const status = (code: number, body = "{}") => () => new Response(body, { status: code });

  // O provedor respondeu recusando: a mensagem não saiu.
  for (const code of [400, 401, 403, 404, 422]) {
    assert.deepEqual(await failure(status(code)), { code: `HTTP_${code}`, delivery: "NOT_SENT", retryable: false }, String(code));
  }
  assert.deepEqual(await failure(status(429)), { code: "HTTP_429", delivery: "NOT_SENT", retryable: true }, "limite de taxa: não saiu, e vale repetir");

  // Sem resposta conclusiva: pode ter saído.
  for (const code of [408, 500, 502, 503, 504]) {
    assert.deepEqual(await failure(status(code)), { code: `HTTP_${code}`, delivery: "UNKNOWN", retryable: true }, String(code));
  }
  assert.deepEqual(await failure(() => { throw new TypeError("fetch failed"); }), { code: "NETWORK_ERROR", delivery: "UNKNOWN", retryable: true });
  assert.deepEqual(
    await failure(() => { const timeout = new Error("aborted"); timeout.name = "TimeoutError"; throw timeout; }),
    { code: "TIMEOUT", delivery: "UNKNOWN", retryable: true },
  );

  // 409 é o provedor recusando a chave. Os dois casos documentados só se
  // distinguem pelo corpo da resposta, que pode citar o destinatário e por isso
  // não é lido: o resultado é o mesmo para os dois, e nunca "não enviado".
  for (const body of [
    JSON.stringify({ statusCode: 409, name: "invalid_idempotent_request", message: "used with a different payload: cliente@exemplo.com" }),
    JSON.stringify({ name: "concurrent_idempotent_requests" }),
    "<html>bad gateway</html>",
  ]) {
    assert.deepEqual(await failure(status(409, body)), { code: "HTTP_409", delivery: "KEY_REFUSED", retryable: true }, body);
  }
  assert.doesNotMatch(source("lib/email/resend.ts"), /response\.text\(\)|response\.json\(\)|console\./, "o corpo do erro do provedor nunca é lido nem registrado");

  // Um erro que não veio do provedor também é desconhecido.
  assert.equal(emailDeliveryOf(new Error("qualquer coisa")), "UNKNOWN");
  assert.equal(emailDeliveryOf("texto solto"), "UNKNOWN");
  assert.equal(emailDeliveryOf(new EmailProviderError("X", false)), "UNKNOWN", "sem informação, vale o mais prudente");
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
  assert.match(code, /const provider = fakeResend\(\);/);
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

/** As mesmas fábricas, ligadas a outro banco. */
function fixturesOf(database: typeof db) {
  return rescheduleFixtures(async (sql, params = []) => (await database.query(sql, params)).rows as Row[]);
}

/** Reserva paga → Stand-by → reagendada pelo painel, sem olhar para a fila. */
async function rescheduleOn(fx: Awaited<ReturnType<typeof fixturesOf>>) {
  const price = fx.uniquePrice();
  const origin = await fx.makeSession(fx.IMERSAO.id, { price });
  const destination = await fx.makeSession(fx.IMERSAO.id, { price, startsIn: "20 days" });
  const booking = await fx.reserve(origin);
  await fx.setStandby(booking.id);
  return { booking, resolution: await fx.reschedule(booking.id, destination) };
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

  const after = await diagnostic(db, PREFLIGHT);
  for (const expected of ["OBJETOS_DA_FILA_AINDA_NAO_EXISTEM=FALHOU", "STANDBY_EMAIL_PREFLIGHT_OK=FALHOU"]) {
    assert.ok(failing(after).includes(expected), `${expected} precisa acusar que a migration já foi aplicada`);
  }
  // Todo objeto que a migration cria é reconhecido pelo preflight.
  const existing = resultOf(after, "OBJETOS_DA_FILA_AINDA_NAO_EXISTEM");
  for (const fn of [...QUEUE_FUNCTIONS, ...INTERNAL_FUNCTIONS]) assert.ok(existing.includes(`função ${fn}`), fn);
  for (const other of ["tabela reservation_reschedule_emails", "tabela reservation_reschedule_email_attempts", "trigger reservation_session_changes_reschedule_email"]) {
    assert.ok(existing.includes(other), other);
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
  const fx = await fixturesOf(database);
  await rescheduleOn(fx);

  const before = await diagnostic(database, PREFLIGHT);
  assert.deepEqual(failing(before), ["REAGENDAMENTOS_DE_STANDBY_JA_FEITOS=ATENCAO"]);
  assert.equal(resultOf(before, "REAGENDAMENTOS_DE_STANDBY_JA_FEITOS"), "1");

  await applyMigration(database, EMAIL_MIGRATION);
  assert.equal(await fx.queueSize(), 0, "a migration não enfileira nada");

  const after = await diagnostic(database, POSTCHECK);
  assert.deepEqual(failing(after), ["REAGENDAMENTOS_SEM_LINHA_NA_FILA=ATENCAO"]);
  assert.equal(after.at(-1)?.result, "0 falha(s), 1 ponto(s) de atenção");
  // As contagens que não podem mudar com a migration, iguais nos dois lados.
  for (const name of ["RESERVAS_POR_STATUS", "EVENTOS_DE_PAGAMENTO", "HISTORICO_DE_TROCAS", "AUTORIZACOES_DE_STANDBY", "FILAS_EXISTENTES"]) {
    assert.equal(resultOf(after, name), resultOf(before, name), name);
  }

  // O próximo reagendamento, já com a migration, entra na fila.
  await rescheduleOn(fx);
  assert.equal(await fx.queueSize(), 1);
});

test("postcheck: aprovado depois da migration, com a fila em uso; antes dela, nem roda", async () => {
  // Um envio em curso com a mensagem guardada: estado legítimo, que o postcheck aceita.
  const inFlight = await rescheduled();
  await claimAndFreeze(inFlight.changeId, inFlight.booking.id);

  const approved = await diagnostic(db, POSTCHECK);
  assert.deepEqual(failing(approved), [], JSON.stringify(approved, null, 2));
  assert.equal(approved.at(-1)?.check_name, "STANDBY_EMAIL_POSTCHECK_OK");
  assert.equal(approved.at(-1)?.result, "0 falha(s), 0 ponto(s) de atenção");
  assert.equal(resultOf(approved, "FUNCOES_DA_FILA_COM_A_DEFINICAO_DO_REPOSITORIO"), "todas as 13 idênticas");
  assert.equal(resultOf(approved, "OPERACOES_EXECUTAVEIS_PELA_SERVICE_ROLE"), "8 de 8");
  assert.equal(resultOf(approved, "PECAS_INTERNAS_FORA_DO_ALCANCE"), "nenhuma executável pela service_role");
  assert.equal(resultOf(approved, "REIVINDICACAO_COM_ESPERA_LIMITADA"), "lock_timeout=3s");
  assert.equal(resultOf(approved, "TRIGGER_DO_EVENTO_ATIVA"), "estado=O, depois de inserir=true, só reagendamento de Stand-by=true");
  assert.equal(resultOf(approved, "FILA_SO_TEM_REAGENDAMENTO_DE_STANDBY"), "0 linha(s) fora da regra");
  assert.equal(resultOf(approved, "MENSAGEM_GUARDADA_SO_ENQUANTO_PRECISA"), "0 fora da regra, 1 em uso");
  assert.match(resultOf(approved, "FILA_DE_REAGENDAMENTO_POR_STATUS"), /SENT=\d+/);

  // O postcheck confere exatamente as funções que a migration cria.
  const sql = operationsFile(POSTCHECK);
  for (const fn of QUEUE_FUNCTIONS) assert.match(sql, new RegExp(`\\('${fn}', 'OPERACAO', '[0-9a-f]{32}', '[0-9a-f]{32}'\\)`), fn);
  for (const fn of INTERNAL_FUNCTIONS) assert.match(sql, new RegExp(`\\('${fn}', 'INTERNA', '[0-9a-f]{32}', '[0-9a-f]{32}'\\)`), fn);

  // Os postchecks das etapas anteriores continuam valendo com esta migration
  // aplicada. O da etapa 2 exige banco sem Stand-by em uso; o do painel, não.
  assert.deepEqual(failing(await diagnostic(await fullDatabase(), "diagnostics/reservation_standby_postcheck.sql")), []);
  assert.deepEqual(failing(await diagnostic(db, "diagnostics/reservation_standby_admin_panel_postcheck.sql")), []);

  // Sem a migration, as tabelas não existem: o postcheck falha em vez de aprovar.
  await rejects(diagnostic(await fullDatabase({ until: PANEL_MIGRATION }), POSTCHECK), /reservation_reschedule_email/);
});

test("postcheck: sensível a privilégio, conteúdo, trigger, espera e unicidade — e tolerante a formatação", async () => {
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
  const take = "public.reservation_reschedule_email_take(uuid, integer, integer, integer, text, uuid, boolean)";

  await expectFailure("peça interna ao alcance do servidor", `grant execute on function ${take} to service_role;`, `revoke execute on function ${take} from service_role;`, "PECAS_INTERNAS_FORA_DO_ALCANCE");
  await expectFailure(
    "operação executável pela API pública",
    `grant execute on function public.claim_reservation_reschedule_email(uuid, integer, integer, integer) to anon;`,
    `revoke execute on function public.claim_reservation_reschedule_email(uuid, integer, integer, integer) from anon;`,
    "NENHUMA_FUNCAO_EXECUTAVEL_PELA_API_PUBLICA",
  );
  await expectFailure(
    "service role sem a operação",
    `revoke execute on function public.freeze_reservation_reschedule_email(uuid, uuid, jsonb) from service_role;`,
    `grant execute on function public.freeze_reservation_reschedule_email(uuid, uuid, jsonb) to service_role;`,
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
  await expectFailure("reivindicação sem limite de espera", `alter function ${take} reset lock_timeout;`, `alter function ${take} set lock_timeout = '3s';`, "REIVINDICACAO_COM_ESPERA_LIMITADA");

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
  assert.equal(resultOf(formatted, "REIVINDICACAO_COM_ESPERA_LIMITADA"), "lock_timeout=3s", "recriar a função preserva o limite de espera");
});

test("relatório da fila: só leitura, só contagens e ids técnicos", async () => {
  const pending = await rescheduled();
  const broken = await rescheduled();
  const claim = await claimFor(broken.changeId);
  await fail(broken.emailId, claim.claimToken, "HTTP_422", "REJECTED");
  // A chave recusada duas vezes pelo provedor: entrega não confirmada.
  const unsure = await rescheduled();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const refused = await claimAndFreeze(unsure.changeId, unsure.booking.id);
    await fail(unsure.emailId, refused.claimToken, "HTTP_409", "KEY_REFUSED");
  }

  const sql = operationsFile(REPORT);
  assert.ok(!/\b(insert|update|delete|alter|create|drop|grant|revoke|truncate)\b/i.test(sql.replace(/--.*$/gm, "").replace(/'[^']*'/g, "''")), "somente leitura");
  const report = (await db.query(sql)).rows as Array<{ check_name: string; result: string }>;
  const value = (name: string) => report.find((row) => row.check_name === name)?.result;

  assert.equal(value("NA_FILA"), "1");
  assert.equal(value("COM_ERRO"), "1");
  assert.equal(value("ULTIMOS_ERROS"), "HTTP_422 ×1");
  assert.equal(value("ESGOTADOS_AGUARDANDO_REENVIO_MANUAL"), "0");
  assert.equal(value("ENTREGA_NAO_CONFIRMADA"), "1");
  assert.match(value("TENTATIVAS_REGISTRADAS") ?? "", /REJECTED=\d+/);
  assert.match(value("TENTATIVAS_REGISTRADAS") ?? "", /KEY_REFUSED=\d+/);
  assert.match(value("ABERTO_1") ?? "", new RegExp(`^reserva ${pending.booking.id} \\| QUEUED \\| tentativas=0 \\| erro=- \\|`));
  assert.match(value("ABERTO_2") ?? "", new RegExp(`^reserva ${broken.booking.id} \\| FAILED \\| tentativas=1 \\| erro=HTTP_422 \\|`));
  assert.match(value("ABERTO_3") ?? "", new RegExp(`^reserva ${unsure.booking.id} \\| UNCERTAIN \\| tentativas=2 \\| erro=IDEMPOTENCY_CONFLICT \\|`));
  assert.ok(report.length <= 90, "cabe no limite de linhas do SQL Editor");
  // A ordem das linhas é a do relatório, não a do banco.
  assert.deepEqual(report.slice(0, 3).map((row) => row.check_name), ["NA_FILA", "EM_ENVIO", "PRESOS_ALEM_DO_PRAZO"]);

  const dump = JSON.stringify(report);
  for (const booking of [pending.booking, broken.booking, unsure.booking]) {
    for (const secret of [booking.email, booking.name, booking.code, booking.cpf]) assert.ok(!dump.includes(secret), "nenhum dado do cliente");
  }
});

test("rollback: remove a trigger e as funções, mantém o registro, e o reagendamento volta a ser o da etapa 3", async () => {
  const database = await fullDatabase();
  const fx = await fixturesOf(database);
  const first = await fx.rescheduled();
  // Dois envios a meio caminho quando o rollback acontece: um com resultado
  // desconhecido, outro recusado pelo provedor.
  const unsure = await fx.rescheduled();
  const unsureClaim = await fx.claimAndFreeze(unsure.changeId, unsure.booking.id);
  await fx.fail(unsure.emailId, unsureClaim.claimToken, "TIMEOUT", "UNKNOWN");
  const refused = await fx.rescheduled();
  const refusedClaim = await fx.claimAndFreeze(refused.changeId, refused.booking.id);
  await fx.fail(refused.emailId, refusedClaim.claimToken, "HTTP_403", "REJECTED");
  assert.equal(await fx.queueSize(), 3);
  const before = await functionHashes(database);

  const rollback = operationsFile(ROLLBACK);
  assert.doesNotMatch(rollback.replace(/--.*$/gm, ""), /drop table|delete from|truncate|integration_sync_jobs|public\.reservations\b/i, "o rollback não apaga registro nem toca reserva");
  await database.exec(rollback);

  // Sobram exatamente as funções que existiam antes da migration.
  const after = await functionHashes(database);
  const removed = [...before.keys()].filter((fn) => !after.has(fn)).map((fn) => fn.replace(/\(.*$/, "")).sort();
  assert.deepEqual(removed, [...QUEUE_FUNCTIONS, ...INTERNAL_FUNCTIONS].sort());
  for (const [fn, hash] of after) assert.equal(before.get(fn), hash, `${fn} não pode mudar`);
  assert.equal((await fx.one(`select count(*)::int as n from pg_trigger where tgname = 'reservation_session_changes_reschedule_email'`)).n, 0);

  // O registro continua lá; as mensagens guardadas, não. E o envio de resultado
  // desconhecido passa à decisão de uma pessoa — nunca volta como "não enviado".
  assert.equal(await fx.queueSize(), 3);
  assert.equal((await fx.one(`select count(*)::int as n from public.reservation_reschedule_emails where frozen_message is not null`)).n, 0);
  assert.deepEqual([(await fx.email(unsure.emailId)).status, (await fx.email(unsure.emailId)).last_error_code], ["UNCERTAIN", "ROLLED_BACK"]);
  assert.deepEqual([(await fx.email(refused.emailId)).status, (await fx.email(refused.emailId)).last_error_code], ["FAILED", "HTTP_403"]);
  assert.equal((await fx.email(first.emailId)).status, "QUEUED");

  // A etapa anterior segue inteira, e reagendar funciona — sem enfileirar.
  assert.deepEqual(failing(await diagnostic(database, "diagnostics/reservation_standby_admin_panel_postcheck.sql")), []);
  const second = await rescheduleOn(fx);
  assert.equal(second.resolution.resolution, "RESCHEDULED");
  assert.equal(await fx.queueSize(), 3);
  assert.equal((await fx.reservation(first.booking.id)).status, "CONFIRMED");

  // Refazer o rollback não quebra; reaplicar a migration devolve tudo.
  await database.exec(rollback);
  await applyMigration(database, EMAIL_MIGRATION);
  const restored = await diagnostic(database, POSTCHECK);
  assert.deepEqual(failing(restored), ["REAGENDAMENTOS_SEM_LINHA_NA_FILA=ATENCAO"], "o reagendamento feito sem a trigger fica sem e-mail, e o postcheck avisa");
  assert.deepEqual([...(await functionHashes(database))], [...before]);
  await rescheduleOn(fx);
  assert.equal(await fx.queueSize(), 4);

  // Com a fila de volta: o recusado e o nunca tentado saem; o incerto continua esperando uma pessoa.
  const claimed = (await fx.claimPending(25)).map((item: Row) => item.emailId).sort();
  assert.ok(claimed.includes(first.emailId) && claimed.includes(refused.emailId));
  assert.ok(!claimed.includes(unsure.emailId), "resultado desconhecido não volta à fila sozinho");
  assert.deepEqual(await fx.adminClaim(unsure.booking.id), { needsConfirmation: true }, "nem com uma pessoa pedindo, sem aceitar o risco");
  assert.equal((await fx.adminClaim(unsure.booking.id, ADMIN, true)).generation, 2, "com o aceite, reenvia — com chave nova");
});
