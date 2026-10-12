/**
 * Stand-by de reservas — banco de verdade.
 *
 * Todas as migrations do repositório são aplicadas, em ordem, sobre um Postgres
 * real em memória (PGlite). O que roda aqui é o plpgsql que vai para produção:
 * as RPCs, as triggers, as constraints e os grants. Nada é reproduzido em
 * TypeScript.
 *
 * As reservas dos testes nascem pelo caminho real — `create_pre_reservation` e
 * `confirm_reservation_payment` — para que cada uma tenha o `payment_events`, o
 * `checkin_token` e o `confirmed_at` que uma reserva de produção tem.
 *
 * ## O que esta suíte não prova
 *
 * O PGlite tem uma única conexão: duas transações nunca ficam abertas ao mesmo
 * tempo. Os testes de "duas tentativas" exercitam a ordem em que as requisições
 * chegam e o estado que cada uma encontra — que é o que decide o resultado — mas
 * não a espera no `FOR UPDATE` entre duas sessões do Postgres. Os locks estão
 * verificados como contrato do SQL no fim do arquivo.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { applyMigration, fullDatabase } from "./support/full-database.ts";

const ENUM_MIGRATION = "202610130001_reservation_status_awaiting_reschedule.sql";
const STANDBY_MIGRATION = "202610130002_reservation_standby.sql";

const db = await fullDatabase();

// As linhas vêm do banco sem tipo; os testes afirmam o formato campo a campo.
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

/** Chama uma função e devolve o valor, já convertido (jsonb vira objeto). */
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

const ADMIN = "a0000000-0000-4000-8000-000000000001";
const OPERATOR = "a0000000-0000-4000-8000-000000000002";
const INSTRUCTOR = "a0000000-0000-4000-8000-000000000003";
const INACTIVE_ADMIN = "a0000000-0000-4000-8000-000000000004";
const STRANGER = "a0000000-0000-4000-8000-000000000005";

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

// --- Catálogo semeado pelas migrations ----------------------------------------

async function experience(slug: string) {
  return one(
    `select e.id, e.base_id, e.status, b.slug as base_slug from public.experiences e join public.bases b on b.id = e.base_id where e.slug = $1`,
    [slug],
  );
}

const IMERSAO = await experience("imersao-paranoa"); // Lago Norte, publicada
const SUNSET_LAGO = await experience("remada-sunset"); // Lago Norte, publicada
const SUNSET_CONCHA = await experience("remada-sunset-concha-acustica"); // outra base, publicada
const ROTA = await experience("rota-ermida-ponte-jk"); // em breve

assert.notEqual(IMERSAO.base_id, SUNSET_CONCHA.base_id, "os testes entre bases precisam de duas bases");

// --- Fábricas -----------------------------------------------------------------

let sequence = 0;

/** Cada teste usa um preço próprio: a regra do mesmo valor isola as listas. */
function uniquePrice() {
  sequence += 1;
  return 20_000 + sequence * 100;
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

type Booking = { id: string; cpf: string; code: string; total: number; quantity: number };

async function preReserve(sessionId: string, quantity = 2): Promise<Booking> {
  sequence += 1;
  const cpf = String(10_000_000_000 + sequence);
  const created = await call(
    `public.create_pre_reservation($1::uuid, $2, $3, '+5561999990000', $4, $5, null, gen_random_uuid())`,
    [sessionId, `Cliente Teste ${sequence}`, cpf, `cliente${sequence}@teste.local`, quantity],
  );
  return { id: created.reservationId, cpf, code: created.publicCode, total: created.totalCents, quantity };
}

/** Reserva confirmada pelo caminho real de pagamento. */
async function reserve(sessionId: string, quantity = 2): Promise<Booking> {
  const booking = await preReserve(sessionId, quantity);
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

async function eventTypes(reservationId: string): Promise<string[]> {
  return (await rows(`select event_type from public.payment_events where reservation_id = $1::uuid order by processed_at, event_type`, [reservationId]))
    .map((row) => row.event_type);
}

async function standbyRows(reservationId: string) {
  return rows(`select * from public.reservation_standby where reservation_id = $1::uuid order by created_at, id`, [reservationId]);
}

async function changes(reservationId: string) {
  return rows(`select * from public.reservation_session_changes where reservation_id = $1::uuid order by created_at, id`, [reservationId]);
}

async function auditActions(reservationId: string): Promise<string[]> {
  // Ordem alfabética: o relógio do banco de teste pode repetir o mesmo instante.
  return (await rows(`select action from public.admin_audit_log where entity_id = $1::uuid order by action`, [reservationId]))
    .map((row) => row.action);
}

const REASON = "Chuva forte na data original";

function setStandby(reservationId: string, actor = ADMIN, reason = REASON) {
  return call(`public.admin_set_reservation_standby($1::uuid, $2::uuid, $3)`, [actor, reservationId, reason]);
}

function undoStandby(reservationId: string, actor = ADMIN) {
  return call(`public.admin_undo_reservation_standby($1::uuid, $2::uuid, 'Stand-by criado por engano')`, [actor, reservationId]);
}

function adminReschedule(reservationId: string, sessionId: string, actor = ADMIN) {
  return call(`public.admin_reschedule_reservation_from_standby($1::uuid, $2::uuid, $3::uuid, 'Cliente pediu por telefone')`, [actor, reservationId, sessionId]);
}

function customerOptions(access: { cpf?: string; code?: string; token?: string }) {
  return call(`public.customer_reschedule_options($1, $2, $3)`, [access.cpf ?? null, access.code ?? null, access.token ?? null]);
}

function customerReschedule(access: { cpf?: string; code?: string; token?: string }, standbyId: string, sessionId: string) {
  return call(`public.customer_reschedule_reservation($1, $2, $3, $4::uuid, $5::uuid)`, [
    access.cpf ?? null, access.code ?? null, access.token ?? null, standbyId, sessionId,
  ]);
}

function checkin(reservationId: string, count: number | null, expectedSessionId: string | null = null, allowUpdate = false) {
  return call(`public.admin_register_checkin($1::uuid, $2::uuid, $3, 'MANUAL', $4::uuid, $5)`, [ADMIN, reservationId, count, expectedSessionId, allowUpdate]);
}

/** Campos que nenhuma operação de Stand-by pode alterar. */
const PRESERVED = ["id", "public_code", "idempotency_key", "full_name", "cpf_hash", "cpf_last4", "phone", "email", "quantity",
  "unit_price_cents", "total_cents", "payment_provider", "provider_reference", "checkout_url", "checkin_token", "created_at"] as const;

function assertPreserved(before: Row, after: Row) {
  for (const field of PRESERVED) {
    assert.deepEqual(after[field], before[field], `${field} não pode mudar`);
  }
  assert.deepEqual(after.confirmed_at, before.confirmed_at, "confirmed_at não pode mudar: é ele que data a receita");
}

// =============================================================================
// 1. Migrations e segurança
// =============================================================================

test("o enum ganha AWAITING_RESCHEDULE em migration própria, sem mais nada dentro", async () => {
  const labels = (await rows(
    `select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'reservation_status' order by e.enumsortorder`,
  )).map((row) => row.enumlabel);
  assert.deepEqual(labels, ["PRE_RESERVED", "CONFIRMED", "EXPIRED", "CANCELLED", "AWAITING_RESCHEDULE"]);

  const statements = readFileSync(new URL(`../supabase/migrations/${ENUM_MIGRATION}`, import.meta.url), "utf8")
    .split("\n").filter((line) => line.trim() && !line.trim().startsWith("--"));
  assert.deepEqual(statements, ["alter type public.reservation_status add value if not exists 'AWAITING_RESCHEDULE';"]);
});

test("as duas migrations são idempotentes e não tocam nenhuma reserva existente", async () => {
  const fresh = await fullDatabase({ until: "202610120002_rota_ermida_texto.sql" });
  await fresh.exec(`
    insert into auth.users (id, email) values ('${ADMIN}', 'admin@teste.local');
    insert into public.admin_users (user_id, display_name, role, is_active) values ('${ADMIN}', 'Admin', 'ADMIN', true);
  `);
  const sessionId = (await fresh.query(
    `insert into public.sessions (experience_id, starts_at, duration_minutes, price_cents, capacity, status)
     select id, now() + interval '5 days', 90, 7000, 4, 'OPEN' from public.experiences where slug = 'imersao-paranoa' returning id`,
  )).rows[0] as Row;
  const created = (await fresh.query(
    `select public.create_pre_reservation($1::uuid, 'Cliente Antigo', '12345678901', '+5561999990000', 'antigo@teste.local', 2, null, gen_random_uuid()) as value`,
    [sessionId.id],
  )).rows[0] as Row;
  await fresh.query(`select public.confirm_reservation_payment($1::uuid, 'INFINITEPAY', 'tx-antigo', 14000, '', '{}'::jsonb)`, [created.value.reservationId]);
  // Troca administrativa anterior à migration: o histórico já existente precisa caber no novo formato.
  const other = (await fresh.query(
    `insert into public.sessions (experience_id, starts_at, duration_minutes, price_cents, capacity, status)
     select id, now() + interval '6 days', 90, 7000, 4, 'OPEN' from public.experiences where slug = 'imersao-paranoa' returning id`,
  )).rows[0] as Row;
  await fresh.query(`select public.admin_change_reservation_session($1::uuid, $2::uuid, $3::uuid, null)`, [ADMIN, created.value.reservationId, other.id]);

  const before = (await fresh.query(`select * from public.reservations order by id`)).rows;
  const eventsBefore = (await fresh.query(`select count(*)::int as n from public.payment_events`)).rows[0] as Row;

  await applyMigration(fresh, ENUM_MIGRATION);
  await applyMigration(fresh, STANDBY_MIGRATION);
  await applyMigration(fresh, ENUM_MIGRATION);
  await applyMigration(fresh, STANDBY_MIGRATION);

  assert.deepEqual((await fresh.query(`select * from public.reservations order by id`)).rows, before);
  assert.deepEqual((await fresh.query(`select count(*)::int as n from public.payment_events`)).rows[0], eventsBefore);
  assert.deepEqual(
    (await fresh.query(`select actor_type, origin, standby_id from public.reservation_session_changes`)).rows,
    [{ actor_type: "ADMIN", origin: "DIRECT", standby_id: null }],
    "o histórico anterior é descrito como troca administrativa direta",
  );
  assert.equal(((await fresh.query(`select count(*)::int as n from public.reservation_standby`)).rows[0] as Row).n, 0);
});

test("as travas financeiras só acrescentam uma instrução a cada função; o resto é idêntico", async () => {
  const previous = await fullDatabase({ until: ENUM_MIGRATION });
  const source = async (database: typeof db, name: string) =>
    ((await database.query(`select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = $1`, [name])).rows as Row[])
      .map((row) => row.prosrc as string);

  const additions: Record<string, string> = {
    reconcile_reservation_payment: "  if target.status = 'AWAITING_RESCHEDULE' then return 'AWAITING_RESCHEDULE'; end if;\n",
    confirm_reservation_payment: "  if target.status = 'AWAITING_RESCHEDULE' then return false; end if;\n",
    admin_confirm_reservation:
      "  if target.status = 'AWAITING_RESCHEDULE' then\n    raise exception 'RESERVATION_AWAITING_RESCHEDULE' using errcode = 'P0001';\n  end if;\n",
  };
  for (const [name, addition] of Object.entries(additions)) {
    const [before] = await source(previous, name);
    const [after] = await source(db, name);
    assert.equal(after.split(addition).length - 1, 1, `${name}: a trava aparece exatamente uma vez`);
    assert.equal(after.replace(addition, ""), before, `${name}: fora a trava, o corpo é o mesmo`);
  }

  // Funções que esta etapa não pode tocar.
  for (const name of [
    "admin_change_reservation_session", "admin_reservation_session_options", "available_spots", "lookup_reservation",
    "create_pre_reservation", "expire_pre_reservations", "admin_cancel_reservation", "claim_payment_reconciliation",
    "admin_register_checkin", "public_checkin_ticket", "reservation_confirmation_email", "claim_reservation_confirmation_email",
    "google_sheets_reservation_block", "google_sheets_session_block", "admin_list_reservations", "admin_get_reservation",
  ]) {
    assert.deepEqual(await source(db, name), await source(previous, name), `${name} não pode ter mudado`);
  }
});

test("a tabela de Stand-by tem RLS, nenhuma policy e nenhum acesso para anon ou authenticated", async () => {
  const table = await one(`select relrowsecurity from pg_class where oid = 'public.reservation_standby'::regclass`);
  assert.equal(table.relrowsecurity, true);
  assert.deepEqual(await rows(`select policyname from pg_policies where schemaname = 'public' and tablename = 'reservation_standby'`), []);

  for (const role of ["anon", "authenticated"]) {
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      assert.equal(await call(`has_table_privilege($1, 'public.reservation_standby', $2)`, [role, privilege]), false, `${role} ${privilege}`);
    }
  }
  assert.equal(await call(`has_table_privilege('service_role', 'public.reservation_standby', 'SELECT')`), true);
  for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
    assert.equal(await call(`has_table_privilege('service_role', 'public.reservation_standby', $1)`, [privilege]), false, `service_role ${privilege}`);
  }
  assert.deepEqual(
    await rows(`select grantee from information_schema.role_table_grants where table_schema = 'public' and table_name = 'reservation_standby' and grantee = 'PUBLIC'`),
    [],
  );
});

const INTERNAL_FUNCTIONS = [
  "enforce_reservation_standby_transition", "reservation_has_confirmed_payment", "reservation_standby_target_rejection",
  "reservation_standby_result", "reservation_standby_resolve", "reservation_standby_access", "reservation_latest_standby",
];
const SERVER_FUNCTIONS = [
  "admin_set_reservation_standby", "admin_undo_reservation_standby", "admin_reschedule_reservation_from_standby",
  "admin_list_standby_reservations", "admin_generate_reservation_standby_link", "admin_revoke_reservation_standby_link",
  "customer_reschedule_options", "customer_reschedule_reservation",
];

test("funções: internas não são executáveis por ninguém; RPCs só pela service role; todas com search_path fixo", async () => {
  const functions = await rows(
    `select p.oid::int as oid, p.proname, p.prosecdef, p.proconfig, p.proacl::text as acl
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1)`,
    [[...INTERNAL_FUNCTIONS, ...SERVER_FUNCTIONS]],
  );
  assert.equal(functions.length, INTERNAL_FUNCTIONS.length + SERVER_FUNCTIONS.length, "sem sobrecargas escondidas");

  for (const fn of functions) {
    assert.equal(fn.prosecdef, true, `${fn.proname}: security definer`);
    assert.ok((fn.proconfig as string[] | null)?.some((setting) => setting.startsWith("search_path=")), `${fn.proname}: search_path explícito`);
    assert.ok(!(fn.proconfig as string[]).some((setting) => /search_path=.*(\$user|pg_temp)/.test(setting)), `${fn.proname}: search_path sem schema gravável pelo chamador`);
    // "=X/" no ACL é o grant a PUBLIC.
    assert.ok(!/(^|[{,])=X/.test(fn.acl ?? ""), `${fn.proname}: sem execute para PUBLIC`);

    for (const role of ["anon", "authenticated"]) {
      assert.equal(await call(`has_function_privilege($1, $2::oid, 'EXECUTE')`, [role, fn.oid]), false, `${fn.proname} × ${role}`);
    }
    const serviceRole = await call(`has_function_privilege('service_role', $1::oid, 'EXECUTE')`, [fn.oid]);
    // `202610140001` retira de propósito o privilégio do reagendamento sem
    // régua de preço: o painel só alcança o que exige o mesmo valor.
    const reachable = SERVER_FUNCTIONS.includes(fn.proname) && fn.proname !== "admin_reschedule_reservation_from_standby";
    assert.equal(serviceRole, reachable, `${fn.proname} × service_role`);
  }

  // As funções substituídas continuam restritas.
  for (const name of ["reconcile_reservation_payment", "confirm_reservation_payment", "admin_confirm_reservation",
    "admin_payments_needing_review", "payment_review_counters", "admin_dashboard_metrics", "admin_base_dashboard_metrics"]) {
    const fn = await one(`select p.oid::int as oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`, [name]);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await call(`has_function_privilege($1, $2::oid, 'EXECUTE')`, [role, fn.oid]), false, `${name} × ${role}`);
    }
    assert.equal(await call(`has_function_privilege('service_role', $1::oid, 'EXECUTE')`, [fn.oid]), true, `${name} × service_role`);
  }
});

test("só ADMIN e OPERATOR ativos operam o Stand-by — a service role sozinha não basta", async () => {
  const sessionId = await makeSession(IMERSAO.id);
  const booking = await reserve(sessionId);

  for (const actor of [INSTRUCTOR, INACTIVE_ADMIN, STRANGER]) {
    await rejects(setStandby(booking.id, actor), /ADMIN_FORBIDDEN/);
    await rejects(undoStandby(booking.id, actor), /ADMIN_FORBIDDEN/);
    await rejects(adminReschedule(booking.id, sessionId, actor), /ADMIN_FORBIDDEN/);
    await rejects(call(`public.admin_list_standby_reservations($1::uuid)`, [actor]), /ADMIN_FORBIDDEN/);
    await rejects(call(`public.admin_generate_reservation_standby_link($1::uuid, $2::uuid)`, [actor, booking.id]), /ADMIN_FORBIDDEN/);
    await rejects(call(`public.admin_revoke_reservation_standby_link($1::uuid, $2::uuid)`, [actor, booking.id]), /ADMIN_FORBIDDEN/);
  }
  await rejects(call(`public.admin_set_reservation_standby(null, $1::uuid, $2)`, [booking.id, REASON]), /ADMIN_FORBIDDEN/);
  assert.equal((await reservation(booking.id)).status, "CONFIRMED");

  const entered = await setStandby(booking.id, OPERATOR);
  assert.equal(entered.status, "AWAITING_RESCHEDULE");
});

// =============================================================================
// 2. Entrada em Stand-by
// =============================================================================

test("entrar em Stand-by libera exatamente as vagas da reserva e preserva todo o resto", async () => {
  const sessionId = await makeSession(IMERSAO.id, { capacity: 5 });
  const booking = await reserve(sessionId, 3);
  const neighbour = await reserve(sessionId, 1);
  const before = await reservation(booking.id);
  const eventsBefore = await eventTypes(booking.id);
  const jobsBefore = (await one(`select count(*)::int as n from public.integration_sync_jobs`)).n;
  assert.equal(await spots(sessionId), 1);

  const entered = await setStandby(booking.id);

  const after = await reservation(booking.id);
  assert.equal(after.status, "AWAITING_RESCHEDULE");
  assert.equal(await spots(sessionId), 4, "liberou 3 vagas: nem mais, nem menos");
  assertPreserved(before, after);
  assert.equal(after.session_id, before.session_id, "o vínculo com a turma original fica como referência");
  assert.equal(after.experience_id, before.experience_id);
  assert.equal(after.cancelled_at, null);
  assert.deepEqual(await eventTypes(booking.id), eventsBefore, "nenhum evento financeiro");
  assert.deepEqual(eventsBefore, ["PAYMENT_CONFIRMED"]);
  assert.equal((await reservation(neighbour.id)).status, "CONFIRMED", "a outra reserva da turma não é tocada");
  assert.equal((await one(`select count(*)::int as n from public.integration_sync_jobs`)).n, jobsBefore, "nenhum job de planilha ou e-mail");

  const [standby] = await standbyRows(booking.id);
  assert.equal(standby.id, entered.standbyId);
  assert.equal(standby.original_session_id, sessionId);
  assert.equal(standby.original_experience_id, IMERSAO.id);
  assert.equal(standby.original_base_id, IMERSAO.base_id);
  assert.equal(standby.quantity, 3);
  assert.equal(standby.unit_price_cents, 7000);
  assert.equal(standby.total_cents, 21000);
  assert.equal(standby.created_by, ADMIN);
  assert.equal(standby.reason, REASON);
  assert.equal(standby.resolved_at, null);
  assert.equal(standby.link_token_hash, null);
  assert.deepEqual(await auditActions(booking.id), ["RESERVATION_STANDBY_SET"]);
  assert.deepEqual(await changes(booking.id), [], "entrar em Stand-by não é uma troca de turma");
});

test("só reserva confirmada entra; motivo é obrigatório; não existe segunda entrada", async () => {
  const sessionId = await makeSession(IMERSAO.id, { capacity: 10 });

  const pending = await preReserve(sessionId);
  await rejects(setStandby(pending.id), /RESERVATION_NOT_CONFIRMED/);

  const cancelled = await reserve(sessionId);
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Cliente desistiu')`, [ADMIN, cancelled.id]);
  await rejects(setStandby(cancelled.id), /RESERVATION_NOT_CONFIRMED/);
  assert.deepEqual(await eventTypes(cancelled.id), ["PAYMENT_CONFIRMED"], "cancelada depois de paga continua fora do Stand-by");

  const expired = await preReserve(sessionId);
  await db.query(`update public.reservations set created_at = now() - interval '5 hours', expires_at = now() - interval '3 hours' where id = $1::uuid`, [expired.id]);
  await call(`public.expire_pre_reservations()`);
  assert.equal((await reservation(expired.id)).status, "EXPIRED");
  await rejects(setStandby(expired.id), /RESERVATION_NOT_CONFIRMED/);

  const booking = await reserve(sessionId);
  await rejects(setStandby(booking.id, ADMIN, "  "), /REASON_REQUIRED/);
  await rejects(setStandby(booking.id, ADMIN, "x".repeat(501)), /REASON_TOO_LONG/);
  assert.equal(await setStandby("00000000-0000-4000-8000-00000000dead"), null, "reserva inexistente não é erro, é ausência");

  await setStandby(booking.id);
  await rejects(setStandby(booking.id), /RESERVATION_ALREADY_IN_STANDBY/);
  assert.equal((await standbyRows(booking.id)).length, 1);
});

test("elegibilidade financeira: confirmada sem evento de pagamento confirmado não entra", async () => {
  const sessionId = await makeSession(IMERSAO.id);
  const booking = await preReserve(sessionId);
  // Estado que nenhum caminho do sistema produz; a regra precisa valer mesmo assim.
  await db.query(`update public.reservations set status = 'CONFIRMED', confirmed_at = now() where id = $1::uuid`, [booking.id]);

  await rejects(setStandby(booking.id), /RESERVATION_PAYMENT_NOT_CONFIRMED/);
  assert.equal((await reservation(booking.id)).status, "CONFIRMED");

  const manual = await preReserve(sessionId);
  await call(`public.admin_confirm_reservation($1::uuid, $2::uuid, 'Pago em dinheiro')`, [ADMIN, manual.id]);
  assert.equal((await setStandby(manual.id)).status, "AWAITING_RESCHEDULE", "confirmação manual é pagamento confirmado");
});

test("check-in: sem registro e ausência entram; presença parcial ou completa exige resolução antes", async () => {
  const sessionId = await makeSession(IMERSAO.id, { capacity: 12 });

  const absent = await reserve(sessionId, 2);
  await checkin(absent.id, 0);
  const absentBefore = await reservation(absent.id);
  assert.equal(absentBefore.checked_in_count, 0);
  await setStandby(absent.id);
  const absentAfter = await reservation(absent.id);
  assert.equal(absentAfter.checked_in_count, null, "os campos ativos de presença são limpos");
  assert.equal(absentAfter.checked_in_at, null);
  assert.equal(absentAfter.checked_in_by, null);
  assert.equal(absentAfter.checkin_method, null);
  const [absentStandby] = await standbyRows(absent.id);
  assert.equal(absentStandby.previous_checked_in_count, 0, "o que havia fica registrado");
  assert.equal(absentStandby.previous_checkin_method, "MANUAL");
  assert.equal(absentStandby.previous_checked_in_by, ADMIN);
  assert.deepEqual(absentStandby.previous_checked_in_at, absentBefore.checked_in_at);

  const partial = await reserve(sessionId, 3);
  await checkin(partial.id, 1);
  await rejects(setStandby(partial.id), /STANDBY_CHECKIN_REGISTERED/);

  const complete = await reserve(sessionId, 2);
  await checkin(complete.id, 2);
  await rejects(setStandby(complete.id), /STANDBY_CHECKIN_REGISTERED/);
  assert.equal((await reservation(complete.id)).status, "CONFIRMED");
  assert.equal((await reservation(complete.id)).checked_in_count, 2, "a recusa não altera a presença");

  // Resolução administrativa: desfazer o check-in. Daí em diante a reserva é elegível.
  await checkin(complete.id, null, null, true);
  assert.equal((await setStandby(complete.id)).status, "AWAITING_RESCHEDULE");
});

test("reserva de sessão passada, fechada ou arquivada também entra em Stand-by", async () => {
  for (const change of [
    `starts_at = now() - interval '3 days'`,
    `status = 'CLOSED'`,
    `status = 'ARCHIVED', starts_at = now() - interval '40 days'`,
  ]) {
    const sessionId = await makeSession(IMERSAO.id);
    const booking = await reserve(sessionId);
    await db.exec(`update public.sessions set ${change} where id = '${sessionId}'`);

    const entered = await setStandby(booking.id);
    assert.equal(entered.status, "AWAITING_RESCHEDULE", change);
    assert.equal((await standbyRows(booking.id))[0].original_session_id, sessionId);
  }
});

test("o banco garante uma única autorização aberta por reserva", async () => {
  const sessionId = await makeSession(IMERSAO.id);
  const booking = await reserve(sessionId);
  await setStandby(booking.id);

  await rejects(
    db.query(
      `insert into public.reservation_standby (reservation_id, original_session_id, original_experience_id, original_starts_at, quantity, unit_price_cents, total_cents)
       values ($1::uuid, $2::uuid, $3::uuid, now(), 2, 7000, 14000)`,
      [booking.id, sessionId, IMERSAO.id],
    ),
    /reservation_standby_one_open_per_reservation/,
  );
});

test("invariante do status: nenhuma escrita direta entra ou sai de Stand-by por fora das operações", async () => {
  const sessionId = await makeSession(IMERSAO.id, { capacity: 10 });

  const confirmed = await reserve(sessionId);
  await rejects(db.query(`update public.reservations set status = 'AWAITING_RESCHEDULE' where id = $1::uuid`, [confirmed.id]), /STANDBY_AUTHORIZATION_REQUIRED/);

  const pending = await preReserve(sessionId);
  await rejects(db.query(`update public.reservations set status = 'AWAITING_RESCHEDULE' where id = $1::uuid`, [pending.id]), /STANDBY_REQUIRES_CONFIRMED_RESERVATION/);

  await rejects(
    db.query(
      `insert into public.reservations (public_code, idempotency_key, experience_id, session_id, status, full_name, cpf_hash, cpf_last4, phone, email, quantity, unit_price_cents, expires_at)
       values ('STANDBYX01', gen_random_uuid(), $1::uuid, $2::uuid, 'AWAITING_RESCHEDULE', 'Cliente Direto', 'hash', '0000', '+5561999990000', 'd@teste.local', 1, 7000, now() + interval '2 hours')`,
      [IMERSAO.id, sessionId],
    ),
    /STANDBY_REQUIRES_CONFIRMED_RESERVATION/,
  );

  const inStandby = await reserve(sessionId);
  await setStandby(inStandby.id);
  // É exatamente o que uma função de pagamento esquecida faria.
  await rejects(db.query(`update public.reservations set status = 'CONFIRMED' where id = $1::uuid`, [inStandby.id]), /STANDBY_STILL_OPEN/);
  await rejects(db.query(`update public.reservations set status = 'EXPIRED' where id = $1::uuid`, [inStandby.id]), /STANDBY_INVALID_TRANSITION/);
  await rejects(db.query(`update public.reservations set status = 'PRE_RESERVED' where id = $1::uuid`, [inStandby.id]), /STANDBY_INVALID_TRANSITION/);
  assert.equal((await reservation(inStandby.id)).status, "AWAITING_RESCHEDULE");
  assert.equal((await standbyRows(inStandby.id))[0].resolved_at, null);
});

test("cancelar uma reserva em Stand-by continua possível e encerra a autorização", async () => {
  const sessionId = await makeSession(IMERSAO.id, { capacity: 2 });
  const booking = await reserve(sessionId, 2);
  const entered = await setStandby(booking.id);

  assert.equal(await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Cliente pediu estorno')`, [ADMIN, booking.id]), true);

  assert.equal((await reservation(booking.id)).status, "CANCELLED");
  const [standby] = await standbyRows(booking.id);
  assert.equal(standby.resolution, "CANCELLED");
  assert.ok(standby.resolved_at);
  assert.equal(await spots(sessionId), 2);
  assert.deepEqual(await eventTypes(booking.id), ["PAYMENT_CONFIRMED"]);

  await rejects(undoStandby(booking.id), /STANDBY_ALREADY_USED/);
  await rejects(adminReschedule(booking.id, sessionId), /STANDBY_ALREADY_USED/);
  await rejects(customerReschedule({ cpf: booking.cpf, code: booking.code }, entered.standbyId, sessionId), /STANDBY_ALREADY_USED/);
  assert.equal(await customerOptions({ cpf: booking.cpf, code: booking.code }), null);
});

// =============================================================================
// 3. Proteção financeira
// =============================================================================

test("reconciliação, confirmação e confirmação manual não reconfirmam nem gravam evento", async () => {
  const sessionId = await makeSession(IMERSAO.id, { capacity: 2 });
  const booking = await reserve(sessionId, 2);
  await setStandby(booking.id);
  const before = await reservation(booking.id);
  const events = await eventTypes(booking.id);
  const auditBefore = await auditActions(booking.id);

  // Webhook repetido com a mesma transação e com outra, valor certo e valor errado.
  for (const [eventId, amount] of [[`tx-${booking.cpf}`, booking.total], ["tx-novo", booking.total], ["tx-errado", 1]] as const) {
    assert.equal(
      await call(`public.reconcile_reservation_payment($1::uuid, 'INFINITEPAY', $2, $3, 'https://recibo', '{}'::jsonb)`, [booking.id, eventId, amount]),
      "AWAITING_RESCHEDULE",
    );
    assert.equal(
      await call(`public.confirm_reservation_payment($1::uuid, 'INFINITEPAY', $2, $3, 'https://recibo', '{}'::jsonb)`, [booking.id, eventId, amount]),
      false,
    );
  }
  await rejects(call(`public.admin_confirm_reservation($1::uuid, $2::uuid, 'Confirmando de novo')`, [ADMIN, booking.id]), /RESERVATION_AWAITING_RESCHEDULE/);

  assert.deepEqual(await reservation(booking.id), before, "a linha da reserva está byte a byte igual");
  assert.deepEqual(await eventTypes(booking.id), events, "nenhum evento financeiro novo");
  assert.deepEqual(await auditActions(booking.id), auditBefore);
  assert.equal(await spots(sessionId), 2, "a turma antiga continua com as vagas livres");
});

test("os demais status continuam com o comportamento de antes nas funções de pagamento", async () => {
  const sessionId = await makeSession(IMERSAO.id, { capacity: 10 });

  const confirmed = await reserve(sessionId);
  assert.equal(await call(`public.reconcile_reservation_payment($1::uuid, 'INFINITEPAY', 'x', $2, '', '{}'::jsonb)`, [confirmed.id, confirmed.total]), "ALREADY_CONFIRMED");
  assert.equal(await call(`public.confirm_reservation_payment($1::uuid, 'INFINITEPAY', 'x', $2, '', '{}'::jsonb)`, [confirmed.id, confirmed.total]), true);
  assert.equal(await call(`public.admin_confirm_reservation($1::uuid, $2::uuid, 'Já estava')`, [ADMIN, confirmed.id]), true);

  const cancelled = await preReserve(sessionId);
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Desistiu')`, [ADMIN, cancelled.id]);
  assert.equal(await call(`public.reconcile_reservation_payment($1::uuid, 'INFINITEPAY', 'y', $2, '', '{}'::jsonb)`, [cancelled.id, cancelled.total]), "CANCELLED");
  await rejects(call(`public.admin_confirm_reservation($1::uuid, $2::uuid, 'Tentando')`, [ADMIN, cancelled.id]), /CANCELLED_RESERVATION/);

  // Pagamento atrasado: vencida, depois recuperada pela reconciliação.
  const late = await preReserve(sessionId);
  await db.query(`update public.reservations set created_at = now() - interval '5 hours', expires_at = now() - interval '3 hours' where id = $1::uuid`, [late.id]);
  assert.equal(await call(`public.confirm_reservation_payment($1::uuid, 'INFINITEPAY', 'tx-late', $2, '', '{}'::jsonb)`, [late.id, late.total]), false);
  assert.equal((await reservation(late.id)).status, "EXPIRED");
  assert.equal(await call(`public.reconcile_reservation_payment($1::uuid, 'INFINITEPAY', 'tx-late', $2, '', '{}'::jsonb)`, [late.id, late.total]), "RECONCILED");
  assert.equal((await reservation(late.id)).status, "CONFIRMED");

  const manual = await preReserve(sessionId);
  assert.equal(await call(`public.admin_confirm_reservation($1::uuid, $2::uuid, 'Pix conferido')`, [ADMIN, manual.id]), true);
  assert.deepEqual(await eventTypes(manual.id), ["PAYMENT_CONFIRMED_MANUAL"]);
});

test("expiração automática e fila da reconciliação ignoram reserva em Stand-by", async () => {
  const sessionId = await makeSession(IMERSAO.id);
  const booking = await reserve(sessionId);
  await setStandby(booking.id);
  // Pior caso: prazo de retenção vencido há muito tempo e checkout gravado.
  await db.query(
    `update public.reservations set created_at = now() - interval '9 days', expires_at = now() - interval '8 days', checkout_url = 'https://checkout.teste/x' where id = $1::uuid`,
    [booking.id],
  );
  const before = await reservation(booking.id);

  await call(`public.expire_pre_reservations()`);
  const claimed = await rows(`select * from public.claim_payment_reconciliation(50, 1, 720)`);

  assert.ok(!claimed.some((row) => row.reservation_id === booking.id));
  assert.deepEqual(await reservation(booking.id), before);
});

test("'Pagamentos para revisar' não lista reserva em Stand-by, mesmo com sinais antigos de pagamento", async () => {
  const sessionId = await makeSession(IMERSAO.id, { capacity: 10 });
  const late = async () => {
    const booking = await preReserve(sessionId);
    await db.query(`update public.reservations set created_at = now() - interval '5 hours', expires_at = now() - interval '3 hours' where id = $1::uuid`, [booking.id]);
    await call(`public.confirm_reservation_payment($1::uuid, 'INFINITEPAY', $2, $3, '', '{}'::jsonb)`, [booking.id, `late-${booking.cpf}`, booking.total]);
    return booking;
  };
  const review = async () => {
    const result = await call(`public.admin_payments_needing_review($1::uuid, 200, 30)`, [ADMIN]);
    return (result.items as Row[]).map((item) => item.reservationId as string);
  };
  const counters = () => call(`public.payment_review_counters()`);

  // Controle: paga depois de vencer e ainda não recuperada — precisa aparecer.
  const stuck = await late();
  assert.ok((await review()).includes(stuck.id));

  // Recuperada pela reconciliação: carrega PAYMENT_AFTER_EXPIRATION para sempre.
  const recovered = await late();
  await call(`public.reconcile_reservation_payment($1::uuid, 'INFINITEPAY', $2, $3, '', '{}'::jsonb)`, [recovered.id, `late-${recovered.cpf}`, recovered.total]);
  assert.ok((await eventTypes(recovered.id)).includes("PAYMENT_AFTER_EXPIRATION"));
  assert.ok(!(await review()).includes(recovered.id));
  const countersBefore = await counters();

  await setStandby(recovered.id);

  assert.ok(!(await review()).includes(recovered.id), "Stand-by não é pendência de pagamento");
  assert.ok((await review()).includes(stuck.id), "o caso real de revisão continua listado");
  assert.deepEqual(await counters(), countersBefore);
  assert.equal(await call(`public.reservation_payment_status($1::uuid)`, [recovered.id]), "PAID");
});

// =============================================================================
// 4. Desfazer
// =============================================================================

test("desfazer devolve a reserva à turma original, reocupa as vagas e encerra a autorização", async () => {
  const sessionId = await makeSession(IMERSAO.id, { capacity: 3 });
  const booking = await reserve(sessionId, 2);
  const before = await reservation(booking.id);
  const entered = await setStandby(booking.id);
  await call(`public.admin_generate_reservation_standby_link($1::uuid, $2::uuid)`, [ADMIN, booking.id]);
  assert.equal(await spots(sessionId), 3);

  const result = await undoStandby(booking.id, OPERATOR);

  assert.equal(result.resolution, "RESTORED");
  assert.equal(result.replayed, false);
  assert.equal(result.targetSessionId, sessionId);
  const after = await reservation(booking.id);
  assert.equal(after.status, "CONFIRMED");
  assert.equal(after.session_id, sessionId);
  assertPreserved(before, after);
  assert.equal(await spots(sessionId), 1);
  assert.deepEqual(await eventTypes(booking.id), ["PAYMENT_CONFIRMED"]);

  const [standby] = await standbyRows(booking.id);
  assert.equal(standby.id, entered.standbyId);
  assert.equal(standby.resolution, "RESTORED");
  assert.equal(standby.resolved_by_type, "ADMIN");
  assert.equal(standby.resolved_by, OPERATOR);
  assert.equal(standby.resolved_access, "ADMIN");
  assert.equal(standby.resolved_session_id, sessionId);

  const [change] = await changes(booking.id);
  assert.equal(standby.resolved_change_id, change.id);
  assert.equal(change.origin, "STANDBY_RESTORE");
  assert.equal(change.actor_type, "ADMIN");
  assert.equal(change.previous_session_id, sessionId);
  assert.equal(change.target_session_id, sessionId, "voltar para a mesma turma cabe no histórico");
  assert.equal(change.total_cents, 14000);
  assert.deepEqual(await auditActions(booking.id), ["RESERVATION_STANDBY_LINK_GENERATED", "RESERVATION_STANDBY_RESTORED", "RESERVATION_STANDBY_SET"]);

  assert.equal(await customerOptions({ cpf: booking.cpf, code: booking.code }), null, "a autorização acabou");
});

test("desfazer é recusado sem alterar nada quando a turma original não pode receber a reserva", async () => {
  // Sem vagas: outra reserva ocupou o lugar liberado.
  const full = await makeSession(IMERSAO.id, { capacity: 2 });
  const booking = await reserve(full, 2);
  await setStandby(booking.id);
  await reserve(full, 1);
  const before = await reservation(booking.id);

  await rejects(undoStandby(booking.id), /INSUFFICIENT_SPOTS/);
  assert.deepEqual(await reservation(booking.id), before);
  assert.equal((await standbyRows(booking.id))[0].resolved_at, null, "o Stand-by continua aberto");
  assert.equal(await spots(full), 1, "sem overbooking");
  assert.deepEqual(await changes(booking.id), []);

  // Já começou.
  const started = await makeSession(IMERSAO.id);
  const late = await reserve(started);
  await setStandby(late.id);
  await db.exec(`update public.sessions set starts_at = now() - interval '1 minute' where id = '${started}'`);
  await rejects(undoStandby(late.id), /SESSION_MUST_BE_FUTURE/);
  assert.equal((await reservation(late.id)).status, "AWAITING_RESCHEDULE");

  // Fechada.
  const closed = await makeSession(IMERSAO.id);
  const other = await reserve(closed);
  await setStandby(other.id);
  await db.exec(`update public.sessions set status = 'CLOSED' where id = '${closed}'`);
  await rejects(undoStandby(other.id), /SESSION_NOT_OPEN/);
  assert.equal((await standbyRows(other.id))[0].resolved_at, null);

  // Nunca esteve em Stand-by.
  const never = await reserve(await makeSession(IMERSAO.id));
  await rejects(undoStandby(never.id), /RESERVATION_NOT_IN_STANDBY/);
  assert.equal(await undoStandby("00000000-0000-4000-8000-00000000dead"), null);
});

test("desfazer é idempotente: repetir devolve o mesmo resultado e não grava de novo", async () => {
  const sessionId = await makeSession(IMERSAO.id);
  const booking = await reserve(sessionId);
  await setStandby(booking.id);

  const first = await undoStandby(booking.id);
  const second = await undoStandby(booking.id);

  assert.equal(second.replayed, true);
  assert.equal(second.changeId, first.changeId);
  assert.equal((await changes(booking.id)).length, 1);
  assert.equal((await auditActions(booking.id)).filter((action) => action === "RESERVATION_STANDBY_RESTORED").length, 1);
});

// =============================================================================
// 5. Reagendamento a partir do Stand-by
// =============================================================================

test("admin reagenda para outra experiência, de outra base e de outro preço, sem tocar o pagamento", async () => {
  const origin = await makeSession(IMERSAO.id, { price: 7000, capacity: 4 });
  const destination = await makeSession(SUNSET_CONCHA.id, { price: 9000, capacity: 4 });
  const booking = await reserve(origin, 2);
  const before = await reservation(booking.id);
  await setStandby(booking.id);

  const result = await adminReschedule(booking.id, destination);

  assert.equal(result.resolution, "RESCHEDULED");
  assert.equal(result.actorType, "ADMIN");
  assert.equal(result.experienceChanged, true);
  assert.equal(result.unitPriceCents, 7000);
  assert.equal(result.targetSessionPriceCents, 9000);
  for (const personal of ["fullName", "email", "phone", "cpf"]) assert.ok(!(personal in result));

  const after = await reservation(booking.id);
  assert.equal(after.status, "CONFIRMED");
  assert.equal(after.session_id, destination);
  assert.equal(after.experience_id, SUNSET_CONCHA.id, "a experiência acompanha a sessão");
  assertPreserved(before, after);
  assert.equal(after.unit_price_cents, 7000, "o valor pago não é recalculado");
  assert.equal(await spots(origin), 4);
  assert.equal(await spots(destination), 2);
  assert.deepEqual(await eventTypes(booking.id), ["PAYMENT_CONFIRMED"]);

  const [change] = await changes(booking.id);
  assert.equal(change.origin, "STANDBY_RESCHEDULE");
  assert.equal(change.actor_type, "ADMIN");
  assert.equal(change.actor_user_id, ADMIN);
  assert.equal(change.previous_experience_id, IMERSAO.id);
  assert.equal(change.target_experience_id, SUNSET_CONCHA.id);
  assert.equal(change.previous_session_price_cents, 7000);
  assert.equal(change.target_session_price_cents, 9000);
});

test("admin não reagenda para turma fechada, passada, lotada ou de experiência não publicada", async () => {
  const origin = await makeSession(IMERSAO.id);
  const booking = await reserve(origin, 2);
  await setStandby(booking.id);

  await rejects(adminReschedule(booking.id, await makeSession(SUNSET_LAGO.id, { status: "CLOSED" })), /SESSION_NOT_OPEN/);
  await rejects(adminReschedule(booking.id, await makeSession(SUNSET_LAGO.id, { startsIn: "-2 days" })), /SESSION_MUST_BE_FUTURE/);
  await rejects(adminReschedule(booking.id, await makeSession(SUNSET_LAGO.id, { capacity: 1 })), /INSUFFICIENT_SPOTS/);
  await rejects(adminReschedule(booking.id, await makeSession(ROTA.id)), /EXPERIENCE_NOT_AVAILABLE/);
  await rejects(adminReschedule(booking.id, "00000000-0000-4000-8000-00000000dead"), /SESSION_NOT_FOUND/);

  assert.equal((await reservation(booking.id)).status, "AWAITING_RESCHEDULE");
  assert.equal((await standbyRows(booking.id))[0].resolved_at, null);
});

test("cliente (CPF + código) só vê turmas abertas, futuras, publicadas, com vaga e do mesmo valor", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price, capacity: 4 });
  const booking = await reserve(origin, 2);
  const entered = await setStandby(booking.id);

  const sameBase = await makeSession(SUNSET_LAGO.id, { price, startsIn: "3 days" });
  const otherBase = await makeSession(SUNSET_CONCHA.id, { price, startsIn: "4 days" });
  const soon = await makeSession(SUNSET_LAGO.id, { price, startsIn: "20 minutes" });
  const cheaper = await makeSession(SUNSET_LAGO.id, { price: price - 100 });
  const pricier = await makeSession(SUNSET_LAGO.id, { price: price + 100 });
  const closed = await makeSession(SUNSET_LAGO.id, { price, status: "CLOSED" });
  const past = await makeSession(SUNSET_LAGO.id, { price, startsIn: "-1 hour" });
  const comingSoon = await makeSession(ROTA.id, { price });
  const tooSmall = await makeSession(SUNSET_LAGO.id, { price, capacity: 1 });

  const view = await customerOptions({ cpf: booking.cpf, code: booking.code.toLowerCase() });

  assert.equal(view.standbyId, entered.standbyId);
  assert.equal(view.access, "CPF_CODE");
  assert.equal(view.status, "AWAITING_RESCHEDULE");
  assert.equal(view.publicCode, booking.code);
  assert.equal(view.firstName, "Cliente");
  assert.equal(view.quantity, 2);
  assert.equal(view.unitPriceCents, price);
  assert.equal(view.totalCents, price * 2);
  assert.equal(view.original.sessionId, origin);
  for (const personal of ["fullName", "email", "phone", "cpf", "cpfHash"]) assert.ok(!(personal in view));

  const offered = (view.options as Row[]).map((option) => option.sessionId);
  assert.deepEqual([...offered].sort(), [origin, sameBase, otherBase, soon].sort(), "sem antecedência mínima; a turma original também é opção");
  for (const hidden of [cheaper, pricier, closed, past, comingSoon, tooSmall]) assert.ok(!offered.includes(hidden));
  assert.equal(view.hiddenForCapacity, 1, "a turma sem vaga para o grupo é contada, não oferecida");
  assert.equal((view.options as Row[]).find((option) => option.sessionId === origin)?.isOriginal, true);
  assert.equal((view.options as Row[]).find((option) => option.sessionId === otherBase)?.baseSlug, SUNSET_CONCHA.base_slug);
  assert.ok((view.options as Row[]).every((option) => option.priceCents === price));

  // A lista não é a autorização: cada recusa vale também na confirmação.
  const access = { cpf: booking.cpf, code: booking.code };
  await rejects(customerReschedule(access, entered.standbyId, cheaper), /PRICE_NOT_ELIGIBLE/);
  await rejects(customerReschedule(access, entered.standbyId, pricier), /PRICE_NOT_ELIGIBLE/);
  await rejects(customerReschedule(access, entered.standbyId, closed), /SESSION_NOT_OPEN/);
  await rejects(customerReschedule(access, entered.standbyId, past), /SESSION_MUST_BE_FUTURE/);
  await rejects(customerReschedule(access, entered.standbyId, comingSoon), /EXPERIENCE_NOT_AVAILABLE/);
  await rejects(customerReschedule(access, entered.standbyId, tooSmall), /INSUFFICIENT_SPOTS/);
  assert.equal((await reservation(booking.id)).status, "AWAITING_RESCHEDULE");
  assert.deepEqual(await changes(booking.id), []);
});

test("cliente reagenda para outra base do mesmo valor: confirmado, sem cobrança, com histórico próprio", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price, capacity: 4 });
  const destination = await makeSession(SUNSET_CONCHA.id, { price, capacity: 4 });
  const booking = await reserve(origin, 2);
  const before = await reservation(booking.id);
  const entered = await setStandby(booking.id);

  const result = await customerReschedule({ cpf: booking.cpf, code: booking.code }, entered.standbyId, destination);

  assert.equal(result.resolved, true);
  assert.equal(result.replayed, false);
  assert.equal(result.resolution, "RESCHEDULED");
  assert.equal(result.actorType, "CUSTOMER");
  assert.equal(result.access, "CPF_CODE");
  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.quantity, 2);
  assert.equal(result.totalCents, price * 2);
  assert.equal(result.targetSessionId, destination);
  for (const personal of ["fullName", "email", "phone", "cpf"]) assert.ok(!(personal in result));

  const after = await reservation(booking.id);
  assert.equal(after.status, "CONFIRMED");
  assert.equal(after.session_id, destination);
  assert.equal(after.experience_id, SUNSET_CONCHA.id);
  assertPreserved(before, after);
  assert.equal(await spots(origin), 4);
  assert.equal(await spots(destination), 2, "ocupou exatamente a quantidade da reserva");
  assert.deepEqual(await eventTypes(booking.id), ["PAYMENT_CONFIRMED"], "pagamento adicional: nenhum");

  const [standby] = await standbyRows(booking.id);
  assert.equal(standby.resolution, "RESCHEDULED");
  assert.equal(standby.resolved_by_type, "CUSTOMER");
  assert.equal(standby.resolved_by, null);
  assert.equal(standby.resolved_access, "CPF_CODE");
  const [change] = await changes(booking.id);
  assert.equal(change.actor_type, "CUSTOMER");
  assert.equal(change.actor_user_id, null);
  assert.equal(change.origin, "STANDBY_RESCHEDULE");
  assert.equal(change.standby_id, entered.standbyId);
  const audit = await one(`select actor_user_id, metadata from public.admin_audit_log where entity_id = $1::uuid and action = 'RESERVATION_STANDBY_RESCHEDULED'`, [booking.id]);
  assert.equal(audit.actor_user_id, null);
  assert.equal(audit.metadata.actorType, "CUSTOMER");
  assert.equal(audit.metadata.access, "CPF_CODE");

  // A página de acompanhamento passa a mostrar a nova turma, confirmada.
  const lookup = await one(`select * from public.lookup_reservation($1, $2)`, [booking.cpf, booking.code]);
  assert.equal(lookup.reservation_status, "CONFIRMED");
  assert.equal(lookup.session_id, destination);
});

test("cliente pode voltar para a própria turma original, se ela ainda couber", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price, capacity: 2 });
  const booking = await reserve(origin, 2);
  const entered = await setStandby(booking.id);

  const result = await customerReschedule({ cpf: booking.cpf, code: booking.code }, entered.standbyId, origin);

  assert.equal(result.resolution, "RESCHEDULED");
  assert.equal(result.experienceChanged, false);
  assert.equal((await reservation(booking.id)).session_id, origin);
  assert.equal(await spots(origin), 0);
  const [change] = await changes(booking.id);
  assert.equal(change.previous_session_id, origin);
  assert.equal(change.target_session_id, origin);
});

test("reserva de R$ 1: só turmas de R$ 1 são elegíveis, e sem nenhuma a lista vem vazia", async () => {
  const origin = await makeSession(IMERSAO.id, { price: 100, capacity: 2 });
  const booking = await reserve(origin, 1);
  assert.equal(booking.total, 100);
  const entered = await setStandby(booking.id);
  await db.exec(`update public.sessions set status = 'CLOSED' where id = '${origin}'`);
  const regular = await makeSession(SUNSET_LAGO.id, { price: 7000 });

  const view = await customerOptions({ cpf: booking.cpf, code: booking.code });
  assert.deepEqual(view.options, [], "sem turma de mesmo valor, o cliente não tem o que escolher");
  await rejects(customerReschedule({ cpf: booking.cpf, code: booking.code }, entered.standbyId, regular), /PRICE_NOT_ELIGIBLE/);

  // O admin continua podendo resolver, sem regra de preço.
  const result = await adminReschedule(booking.id, regular);
  assert.equal(result.unitPriceCents, 100);
  assert.equal((await reservation(booking.id)).total_cents, 100);
});

test("credencial errada, de outra reserva ou sem Stand-by aberto não autoriza nada", async () => {
  const price = uniquePrice();
  const session = await makeSession(IMERSAO.id, { price, capacity: 8 });
  const destination = await makeSession(SUNSET_LAGO.id, { price, capacity: 8 });
  const mine = await reserve(session);
  const theirs = await reserve(session);
  const idle = await reserve(session);
  const myStandby = await setStandby(mine.id);
  const theirStandby = await setStandby(theirs.id);

  assert.equal(await customerOptions({ cpf: "99999999999", code: mine.code }), null);
  assert.equal(await customerOptions({ cpf: mine.cpf, code: "ZZZZZZZZZZ" }), null);
  assert.equal(await customerOptions({ cpf: mine.cpf, code: theirs.code }), null);
  assert.equal(await customerOptions({ cpf: mine.cpf }), null, "só CPF não basta");
  assert.equal(await customerOptions({ code: mine.code }), null, "só código não basta");
  assert.equal(await customerOptions({}), null);
  assert.equal(await customerOptions({ cpf: idle.cpf, code: idle.code }), null, "reserva confirmada não tem autoatendimento");

  // Minha credencial com a autorização de outra pessoa.
  await rejects(customerReschedule({ cpf: mine.cpf, code: mine.code }, theirStandby.standbyId, destination), /STANDBY_NOT_AUTHORIZED/);
  await rejects(customerReschedule({ cpf: "99999999999", code: mine.code }, myStandby.standbyId, destination), /STANDBY_NOT_AUTHORIZED/);
  await rejects(customerReschedule({}, myStandby.standbyId, destination), /STANDBY_NOT_AUTHORIZED/);
  await rejects(call(`public.customer_reschedule_reservation($1, $2, null, null, $3::uuid)`, [mine.cpf, mine.code, destination]), /STANDBY_NOT_AUTHORIZED/);
  // Reserva que nunca entrou em Stand-by não reagenda nem conhecendo CPF e código.
  await rejects(customerReschedule({ cpf: idle.cpf, code: idle.code }, myStandby.standbyId, destination), /STANDBY_NOT_AUTHORIZED/);

  for (const booking of [mine, theirs]) assert.equal((await reservation(booking.id)).status, "AWAITING_RESCHEDULE");
  assert.equal((await reservation(idle.id)).session_id, session);
});

test("a autorização é de uso único: repetir a mesma requisição devolve o mesmo resultado; mudar o destino é recusado", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const first = await makeSession(SUNSET_LAGO.id, { price });
  const second = await makeSession(SUNSET_CONCHA.id, { price });
  const booking = await reserve(origin, 2);
  const entered = await setStandby(booking.id);
  const access = { cpf: booking.cpf, code: booking.code };

  const done = await customerReschedule(access, entered.standbyId, first);
  // Falha de conexão depois do sucesso: o navegador repete a mesma requisição.
  const replay = await customerReschedule(access, entered.standbyId, first);

  assert.equal(replay.replayed, true);
  assert.equal(replay.changeId, done.changeId);
  assert.equal(replay.targetSessionId, first);
  assert.equal((await changes(booking.id)).length, 1, "uma única troca gravada");
  assert.equal(await spots(first), 2, "a vaga não foi ocupada duas vezes");

  await rejects(customerReschedule(access, entered.standbyId, second), /STANDBY_ALREADY_USED/);
  await rejects(customerReschedule(access, entered.standbyId, origin), /STANDBY_ALREADY_USED/);
  await rejects(adminReschedule(booking.id, second), /STANDBY_ALREADY_USED/);
  await rejects(undoStandby(booking.id), /STANDBY_ALREADY_USED/);
  assert.equal((await reservation(booking.id)).session_id, first);
  assert.equal(await customerOptions(access), null);

  // Depois que o admin move a reserva, nem a repetição "igual" vale mais.
  const third = await makeSession(SUNSET_LAGO.id, { price });
  await call(`public.admin_change_reservation_session($1::uuid, $2::uuid, $3::uuid, null)`, [ADMIN, booking.id, third]);
  await rejects(customerReschedule(access, entered.standbyId, first), /STANDBY_ALREADY_USED/);
  assert.equal((await reservation(booking.id)).session_id, third);
});

test("duas tentativas na mesma reserva: uma vence, a outra é recusada, a reserva termina em uma turma só", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const a = await makeSession(SUNSET_LAGO.id, { price });
  const b = await makeSession(SUNSET_CONCHA.id, { price });
  const booking = await reserve(origin, 2);
  const entered = await setStandby(booking.id);
  const access = { cpf: booking.cpf, code: booking.code };

  // Cliente com a página aberta e admin reagendando ao mesmo tempo.
  const results = await Promise.allSettled([
    customerReschedule(access, entered.standbyId, a),
    adminReschedule(booking.id, b),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.match(String(rejected.reason?.message), /STANDBY_ALREADY_USED/);
  const final = await reservation(booking.id);
  assert.equal(final.status, "CONFIRMED");
  assert.equal((await changes(booking.id)).length, 1);
  assert.equal((await spots(a)) + (await spots(b)), 6, "duas vagas ocupadas em uma turma, nenhuma na outra");
  assert.equal(await spots(origin), 4);
});

test("última vaga disputada por duas reservas em Stand-by: sem overbooking", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price, capacity: 6 });
  const last = await makeSession(SUNSET_LAGO.id, { price, capacity: 2 });
  const first = await reserve(origin, 2);
  const second = await reserve(origin, 2);
  const firstStandby = await setStandby(first.id);
  const secondStandby = await setStandby(second.id);
  // Os dois enxergam a turma como disponível.
  for (const booking of [first, second]) {
    const view = await customerOptions({ cpf: booking.cpf, code: booking.code });
    assert.ok((view.options as Row[]).some((option) => option.sessionId === last));
  }

  const results = await Promise.allSettled([
    customerReschedule({ cpf: first.cpf, code: first.code }, firstStandby.standbyId, last),
    customerReschedule({ cpf: second.cpf, code: second.code }, secondStandby.standbyId, last),
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.match(String(rejected.reason?.message), /INSUFFICIENT_SPOTS/);
  assert.equal(await spots(last), 0);
  const occupied = await one(`select coalesce(sum(quantity), 0)::int as n from public.reservations where session_id = $1::uuid and status = 'CONFIRMED'`, [last]);
  assert.equal(occupied.n, 2, "capacidade 2, ocupação 2");

  const statuses = [(await reservation(first.id)).status, (await reservation(second.id)).status].sort();
  assert.deepEqual(statuses, ["AWAITING_RESCHEDULE", "CONFIRMED"], "quem perdeu continua em Stand-by, com a autorização intacta");
  const loser = (await reservation(first.id)).status === "AWAITING_RESCHEDULE" ? first : second;
  assert.equal((await standbyRows(loser.id))[0].resolved_at, null);
  const view = await customerOptions({ cpf: loser.cpf, code: loser.code });
  assert.ok(!(view.options as Row[]).some((option) => option.sessionId === last), "a turma esgotada some da lista");
});

test("pré-reserva válida de outro cliente também conta na disputa pela vaga", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const destination = await makeSession(SUNSET_LAGO.id, { price, capacity: 2 });
  const booking = await reserve(origin, 2);
  const entered = await setStandby(booking.id);
  const holder = await preReserve(destination, 1);

  await rejects(customerReschedule({ cpf: booking.cpf, code: booking.code }, entered.standbyId, destination), /INSUFFICIENT_SPOTS/);

  // A retenção vence: a vaga volta e o reagendamento passa, expirando a retenção na mesma transação.
  await db.query(`update public.reservations set created_at = now() - interval '5 hours', expires_at = now() - interval '3 hours' where id = $1::uuid`, [holder.id]);
  const result = await customerReschedule({ cpf: booking.cpf, code: booking.code }, entered.standbyId, destination);
  assert.equal(result.targetSessionId, destination);
  assert.equal((await reservation(holder.id)).status, "EXPIRED");
});

test("falha no meio da operação desfaz tudo: status, turma, autorização, histórico e auditoria", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const destination = await makeSession(SUNSET_LAGO.id, { price });
  const booking = await reserve(origin, 2);
  const entered = await setStandby(booking.id);
  const before = await reservation(booking.id);
  const standbyBefore = await standbyRows(booking.id);
  const auditBefore = await auditActions(booking.id);

  // Quebra a penúltima escrita da transação: a reserva e a autorização já foram alteradas.
  await db.exec(`
    create function public.test_break_history() returns trigger language plpgsql as $$ begin raise exception 'FALHA_SIMULADA'; end $$;
    create trigger test_break_history before insert on public.reservation_session_changes for each row execute function public.test_break_history();
  `);
  try {
    await rejects(customerReschedule({ cpf: booking.cpf, code: booking.code }, entered.standbyId, destination), /FALHA_SIMULADA/);
    await rejects(undoStandby(booking.id), /FALHA_SIMULADA/);
  } finally {
    await db.exec(`drop trigger test_break_history on public.reservation_session_changes; drop function public.test_break_history();`);
  }

  assert.deepEqual(await reservation(booking.id), before);
  assert.deepEqual(await standbyRows(booking.id), standbyBefore);
  assert.deepEqual(await auditActions(booking.id), auditBefore);
  assert.deepEqual(await changes(booking.id), []);
  assert.equal(await spots(destination), 4);

  // A autorização continua válida e a operação funciona na tentativa seguinte.
  const result = await customerReschedule({ cpf: booking.cpf, code: booking.code }, entered.standbyId, destination);
  assert.equal(result.replayed, false);
});

test("cada entrada em Stand-by é uma autorização nova; as anteriores não voltam a valer", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const first = await makeSession(SUNSET_LAGO.id, { price });
  const second = await makeSession(SUNSET_CONCHA.id, { price });
  const booking = await reserve(origin, 2);
  const access = { cpf: booking.cpf, code: booking.code };

  const firstEntry = await setStandby(booking.id);
  await customerReschedule(access, firstEntry.standbyId, first);
  const secondEntry = await setStandby(booking.id, ADMIN, "Cliente pediu de novo");

  assert.notEqual(secondEntry.standbyId, firstEntry.standbyId);
  assert.equal(secondEntry.originalSessionId, first, "a turma original da nova autorização é a turma de onde a reserva saiu agora");
  assert.equal((await customerOptions(access)).standbyId, secondEntry.standbyId);

  await rejects(customerReschedule(access, firstEntry.standbyId, second), /STANDBY_ALREADY_USED/);
  await rejects(customerReschedule(access, firstEntry.standbyId, first), /STANDBY_ALREADY_USED/);
  assert.equal((await reservation(booking.id)).status, "AWAITING_RESCHEDULE");

  await customerReschedule(access, secondEntry.standbyId, second);
  const history = await standbyRows(booking.id);
  assert.deepEqual(history.map((row) => row.resolution), ["RESCHEDULED", "RESCHEDULED"]);
  assert.equal((await changes(booking.id)).length, 2);
  assert.deepEqual(await eventTypes(booking.id), ["PAYMENT_CONFIRMED"]);
});

// =============================================================================
// 6. Link individual
// =============================================================================

function generateLink(reservationId: string, actor = ADMIN) {
  return call(`public.admin_generate_reservation_standby_link($1::uuid, $2::uuid)`, [actor, reservationId]);
}

test("link: token de 256 bits, só o hash no banco, nada do token na auditoria", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const booking = await reserve(origin);
  await rejects(generateLink(booking.id), /RESERVATION_NOT_IN_STANDBY/);
  const entered = await setStandby(booking.id);

  const link = await generateLink(booking.id);

  assert.match(link.token, /^[0-9a-f]{64}$/);
  assert.equal(link.standbyId, entered.standbyId);
  const [standby] = await standbyRows(booking.id);
  assert.equal(standby.link_token_hash, createHash("sha256").update(link.token).digest("hex"));
  assert.notEqual(standby.link_token_hash, link.token);
  assert.equal(standby.link_created_by, ADMIN);

  const everything = JSON.stringify([
    await rows(`select * from public.admin_audit_log where entity_id = $1::uuid`, [booking.id]),
    await standbyRows(booking.id),
    await call(`public.admin_list_standby_reservations($1::uuid)`, [ADMIN]),
  ]);
  assert.ok(!everything.includes(link.token), "o texto do token não é guardado em lugar nenhum");

  const other = await reserve(origin);
  await setStandby(other.id);
  assert.notEqual((await generateLink(other.id)).token, link.token);
});

test("link dá acesso só à própria reserva, e pelos mesmos critérios do CPF + código", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price, capacity: 8 });
  const destination = await makeSession(SUNSET_CONCHA.id, { price, capacity: 8 });
  const pricier = await makeSession(SUNSET_LAGO.id, { price: price + 100 });
  const mine = await reserve(origin);
  const theirs = await reserve(origin);
  const myStandby = await setStandby(mine.id);
  const theirStandby = await setStandby(theirs.id);
  const link = await generateLink(mine.id);

  const view = await customerOptions({ token: link.token });
  assert.equal(view.standbyId, myStandby.standbyId);
  assert.equal(view.access, "LINK");
  assert.equal(view.publicCode, mine.code);
  assert.deepEqual(
    (view.options as Row[]).map((option) => option.sessionId).sort(),
    ((await customerOptions({ cpf: mine.cpf, code: mine.code })).options as Row[]).map((option) => option.sessionId).sort(),
    "os dois acessos enxergam exatamente as mesmas turmas",
  );
  assert.equal(await customerOptions({ token: link.token.toUpperCase() }) !== null, true, "maiúsculas não mudam o token");

  for (const bad of ["", "abc", "g".repeat(64), "0".repeat(64), `${link.token}0`, "' or 1=1 --"]) {
    assert.equal(await customerOptions({ token: bad }), null, `token inválido: ${bad.slice(0, 12)}`);
  }
  await rejects(customerReschedule({ token: link.token }, theirStandby.standbyId, destination), /STANDBY_NOT_AUTHORIZED/);
  await rejects(customerReschedule({ token: link.token }, myStandby.standbyId, pricier), /PRICE_NOT_ELIGIBLE/);

  const result = await customerReschedule({ token: link.token }, myStandby.standbyId, destination);
  assert.equal(result.access, "LINK");
  assert.equal(result.actorType, "CUSTOMER");
  assert.equal((await reservation(mine.id)).session_id, destination);
  assert.equal((await reservation(theirs.id)).status, "AWAITING_RESCHEDULE");
});

test("link deixa de autorizar depois do reagendamento, da revogação ou de um novo link", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price, capacity: 8 });
  const first = await makeSession(SUNSET_LAGO.id, { price, capacity: 8 });
  const second = await makeSession(SUNSET_CONCHA.id, { price, capacity: 8 });

  // Novo link invalida o anterior.
  const rotated = await reserve(origin);
  const rotatedStandby = await setStandby(rotated.id);
  const oldLink = await generateLink(rotated.id);
  const newLink = await generateLink(rotated.id);
  assert.equal(await customerOptions({ token: oldLink.token }), null);
  await rejects(customerReschedule({ token: oldLink.token }, rotatedStandby.standbyId, first), /STANDBY_NOT_AUTHORIZED/);
  assert.equal((await customerOptions({ token: newLink.token })).standbyId, rotatedStandby.standbyId);

  // Revogação.
  assert.equal(await call(`public.admin_revoke_reservation_standby_link($1::uuid, $2::uuid)`, [ADMIN, rotated.id]), true);
  assert.equal(await call(`public.admin_revoke_reservation_standby_link($1::uuid, $2::uuid)`, [ADMIN, rotated.id]), false, "nada a revogar na segunda vez");
  assert.equal(await customerOptions({ token: newLink.token }), null);
  await rejects(customerReschedule({ token: newLink.token }, rotatedStandby.standbyId, first), /STANDBY_NOT_AUTHORIZED/);
  const [revoked] = await standbyRows(rotated.id);
  assert.equal(revoked.link_token_hash, null);
  assert.ok(revoked.link_revoked_at);
  assert.equal((await reservation(rotated.id)).status, "AWAITING_RESCHEDULE", "revogar o link não encerra o Stand-by");
  assert.ok(await customerOptions({ cpf: rotated.cpf, code: rotated.code }), "CPF + código continuam valendo");

  // Reagendamento consome a autorização: o link não mostra nem altera mais nada.
  const used = await reserve(origin);
  const usedStandby = await setStandby(used.id);
  const usedLink = await generateLink(used.id);
  await customerReschedule({ token: usedLink.token }, usedStandby.standbyId, first);
  assert.equal(await customerOptions({ token: usedLink.token }), null);
  await rejects(customerReschedule({ token: usedLink.token }, usedStandby.standbyId, second), /STANDBY_ALREADY_USED/);
  const replay = await customerReschedule({ token: usedLink.token }, usedStandby.standbyId, first);
  assert.equal(replay.replayed, true, "só a repetição idêntica é reconhecida, e não escreve nada");
  assert.equal((await reservation(used.id)).session_id, first);

  // Um novo Stand-by da mesma reserva não ressuscita o link antigo.
  const again = await setStandby(used.id, ADMIN, "Segunda remarcação");
  assert.equal(await customerOptions({ token: usedLink.token }), null);
  await rejects(customerReschedule({ token: usedLink.token }, again.standbyId, second), /STANDBY_NOT_AUTHORIZED/);
  await rejects(generateLink(rotated.id, INSTRUCTOR), /ADMIN_FORBIDDEN/);
});

test("os dois acessos ao mesmo tempo produzem um único reagendamento", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const a = await makeSession(SUNSET_LAGO.id, { price });
  const b = await makeSession(SUNSET_CONCHA.id, { price });
  const booking = await reserve(origin, 2);
  const entered = await setStandby(booking.id);
  const link = await generateLink(booking.id);

  const results = await Promise.allSettled([
    customerReschedule({ token: link.token }, entered.standbyId, a),
    customerReschedule({ cpf: booking.cpf, code: booking.code }, entered.standbyId, b),
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal((await changes(booking.id)).length, 1);
  assert.equal((await standbyRows(booking.id)).length, 1);
  assert.equal((await spots(a)) + (await spots(b)), 6);
});

// =============================================================================
// 7. QR Code e check-in
// =============================================================================

test("o mesmo QR não vale na turma antiga durante o Stand-by e passa a valer só na nova", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const destination = await makeSession(SUNSET_CONCHA.id, { price });
  const booking = await reserve(origin, 2);
  const token = (await reservation(booking.id)).checkin_token as string;
  const attendees = async (sessionId: string) =>
    ((await call(`public.admin_attendance_session($1::uuid, $2::uuid)`, [ADMIN, sessionId])).reservations as Row[]).map((row) => row.reservationId);

  assert.ok(token);
  assert.equal((await call(`public.public_checkin_ticket($1::uuid)`, [token])).quantity, 2);
  assert.deepEqual(await attendees(origin), [booking.id]);

  const entered = await setStandby(booking.id);

  assert.equal(await call(`public.public_checkin_ticket($1::uuid)`, [token]), null, "o QR não identifica mais uma participação");
  assert.deepEqual(await attendees(origin), [], "fora da lista de presença da turma original");
  await rejects(checkin(booking.id, 2, origin), /RESERVATION_NOT_CONFIRMED/);
  await rejects(checkin(booking.id, 2), /RESERVATION_NOT_CONFIRMED/);
  assert.equal((await call(`public.admin_checkin_lookup($1::uuid, $2::uuid, null)`, [ADMIN, token])).status, "AWAITING_RESCHEDULE");
  assert.equal(await call(`public.checkin_qr_bulk_eligibility($1::uuid)`, [booking.id]), "NOT_CONFIRMED");
  await rejects(call(`public.admin_reservation_qr_email_payload($1::uuid, $2::uuid)`, [ADMIN, booking.id]), /RESERVATION_NOT_CONFIRMED/);

  await customerReschedule({ cpf: booking.cpf, code: booking.code }, entered.standbyId, destination);

  assert.equal((await reservation(booking.id)).checkin_token, token, "nenhum token novo foi gerado");
  const ticket = await call(`public.public_checkin_ticket($1::uuid)`, [token]);
  assert.equal(ticket.baseSlug, SUNSET_CONCHA.base_slug, "o mesmo QR agora aponta para a nova turma e a nova base");
  assert.equal(ticket.checkedIn, false);
  assert.deepEqual(await attendees(origin), []);
  assert.deepEqual(await attendees(destination), [booking.id]);
  await rejects(checkin(booking.id, 2, origin), /CHECKIN_WRONG_SESSION/);
  const done = await checkin(booking.id, 2, destination);
  assert.equal(done.checkedInCount, 2);
  assert.equal(done.sessionId, destination);
});

test("ausência registrada na turma antiga não acompanha a reserva para a nova", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price });
  const destination = await makeSession(SUNSET_LAGO.id, { price });
  const booking = await reserve(origin, 2);
  await checkin(booking.id, 0);
  await setStandby(booking.id);
  await adminReschedule(booking.id, destination);

  const after = await reservation(booking.id);
  assert.equal(after.checked_in_count, null, "chega à nova turma aguardando check-in");
  const session = await call(`public.admin_attendance_session($1::uuid, $2::uuid)`, [ADMIN, destination]);
  assert.equal((session.reservations as Row[])[0].checkedInCount, null);
});

// =============================================================================
// 8. Receita e métricas
// =============================================================================

test("receita: o valor pago continua contado, a vaga não, e o reagendamento não duplica nada", async () => {
  const price = uniquePrice();
  const origin = await makeSession(IMERSAO.id, { price, capacity: 4 });
  const destination = await makeSession(SUNSET_CONCHA.id, { price, capacity: 4 });
  const booking = await reserve(origin, 2);
  const total = price * 2;
  const global = () => call(`public.admin_dashboard_metrics($1::uuid)`, [ADMIN]);
  const base = (baseId: string) => call(`public.admin_base_dashboard_metrics($1::uuid, $2::uuid)`, [ADMIN, baseId]);
  const lastMonth = (metrics: Row) => (metrics.revenueByMonth as Row[]).at(-1)!.revenueCents as number;

  const before = { global: await global(), lago: await base(IMERSAO.base_id), concha: await base(SUNSET_CONCHA.base_id) };
  await setStandby(booking.id);
  const during = { global: await global(), lago: await base(IMERSAO.base_id), concha: await base(SUNSET_CONCHA.base_id) };

  // Dinheiro: igual.
  for (const field of ["confirmedRevenueCents", "expectedRevenueCents", "monthlyRevenueCents", "averageTicketCents"]) {
    assert.equal(during.global[field], before.global[field], `global.${field}`);
    assert.equal(during.lago[field], before.lago[field], `lago.${field}: em Stand-by a receita fica na base de origem`);
    assert.equal(during.concha[field], before.concha[field], `concha.${field}`);
  }
  assert.equal(lastMonth(during.global), lastMonth(before.global));
  assert.equal(lastMonth(during.lago), lastMonth(before.lago));
  // Presença e vaga: sai.
  assert.equal(during.global.confirmedReservations, before.global.confirmedReservations - 1);
  assert.equal(during.global.totalParticipants, before.global.totalParticipants - 2);
  assert.equal(during.lago.totalParticipants, before.lago.totalParticipants - 2);
  assert.equal(during.global.totalReservations, before.global.totalReservations);
  assert.equal(during.global.preReservations, before.global.preReservations, "não é pagamento pendente");
  // Indicador novo.
  assert.equal(during.global.awaitingReschedule.reservations, before.global.awaitingReschedule.reservations + 1);
  assert.equal(during.global.awaitingReschedule.participants, before.global.awaitingReschedule.participants + 2);
  assert.equal(during.global.awaitingReschedule.totalCents, before.global.awaitingReschedule.totalCents + total);
  assert.equal(during.lago.awaitingReschedule.totalCents, before.lago.awaitingReschedule.totalCents + total);
  assert.equal(during.concha.awaitingReschedule.totalCents, before.concha.awaitingReschedule.totalCents);
  assert.deepEqual(during.global.paymentReview, before.global.paymentReview);

  await adminReschedule(booking.id, destination);
  const after = { global: await global(), lago: await base(IMERSAO.base_id), concha: await base(SUNSET_CONCHA.base_id) };

  assert.equal(after.global.confirmedRevenueCents, before.global.confirmedRevenueCents, "total geral inalterado do começo ao fim");
  assert.equal(lastMonth(after.global), lastMonth(before.global));
  assert.equal(after.lago.confirmedRevenueCents, before.lago.confirmedRevenueCents - total, "o valor sai inteiro da base de origem");
  assert.equal(after.concha.confirmedRevenueCents, before.concha.confirmedRevenueCents + total, "e entra inteiro na base de destino");
  assert.equal(
    after.lago.confirmedRevenueCents + after.concha.confirmedRevenueCents,
    before.lago.confirmedRevenueCents + before.concha.confirmedRevenueCents,
    "a soma das bases não muda: sem dupla contagem",
  );
  assert.equal(after.global.totalParticipants, before.global.totalParticipants);
  assert.equal(after.global.confirmedReservations, before.global.confirmedReservations);
  assert.deepEqual(after.global.awaitingReschedule, before.global.awaitingReschedule);
});

// =============================================================================
// 9. Leituras existentes: painel, acompanhamento público, e-mail e planilha
// =============================================================================

test("lista administrativa de Stand-by: só autorizações abertas, com contato e sem CPF", async () => {
  const session = await makeSession(IMERSAO.id, { capacity: 8 });
  const waiting = await reserve(session, 3);
  const resolved = await reserve(session, 1);
  await setStandby(waiting.id);
  await setStandby(resolved.id);
  await undoStandby(resolved.id);
  await generateLink(waiting.id);

  const list = (await call(`public.admin_list_standby_reservations($1::uuid)`, [ADMIN])) as Row[];
  const item = list.find((entry) => entry.reservationId === waiting.id)!;

  assert.ok(item);
  assert.ok(!list.some((entry) => entry.reservationId === resolved.id));
  assert.equal(item.publicCode, waiting.code);
  assert.equal(item.quantity, 3);
  assert.equal(item.totalCents, 21000);
  assert.equal(item.originalSessionId, session);
  assert.equal(item.originalExperienceTitle.length > 0, true);
  assert.equal(item.originalBaseName.length > 0, true);
  assert.equal(item.enteredByName, "Admin Teste");
  assert.equal(item.reason, REASON);
  assert.equal(item.hasActiveLink, true);
  assert.ok(item.phone && item.email && item.fullName);
  assert.ok(!JSON.stringify(item).match(/cpf|hash|token/i));
  assert.deepEqual(list.map((entry) => entry.enteredAt), [...list.map((entry) => entry.enteredAt)].sort(), "a mais antiga primeiro");
});

test("painel e acompanhamento público leem a reserva em Stand-by com o status certo e pagamento 'Pago'", async () => {
  const session = await makeSession(IMERSAO.id);
  const booking = await reserve(session);
  await setStandby(booking.id);

  const lookup = await one(`select * from public.lookup_reservation($1, $2)`, [booking.cpf, booking.code]);
  assert.equal(lookup.reservation_status, "AWAITING_RESCHEDULE");
  assert.equal(lookup.checkout_url, null);

  const detail = await one(`select * from public.admin_get_reservation($1::uuid, $2::uuid)`, [ADMIN, booking.id]);
  assert.equal(detail.reservation_status, "AWAITING_RESCHEDULE");
  assert.equal(detail.payment_status, "PAID");

  const listed = await rows(
    `select id, reservation_status, payment_status from public.admin_list_reservations($1::uuid, null, null, 'AWAITING_RESCHEDULE', null, null, null, null, null, null, null)`,
    [ADMIN],
  );
  assert.ok(listed.some((row) => row.id === booking.id && row.payment_status === "PAID"));
  const confirmedOnly = await rows(
    `select id from public.admin_list_reservations($1::uuid, null, null, 'CONFIRMED', null, null, null, $2::uuid, null, null, null)`,
    [ADMIN, session],
  );
  assert.ok(!confirmedOnly.some((row) => row.id === booking.id));
});

test("reagendamento administrativo tradicional continua igual e não alcança reserva em Stand-by", async () => {
  const origin = await makeSession(IMERSAO.id, { price: 7000 });
  const destination = await makeSession(SUNSET_CONCHA.id, { price: 9000 });
  const direct = await reserve(origin, 2);
  const before = await reservation(direct.id);

  const moved = await call(`public.admin_change_reservation_session($1::uuid, $2::uuid, $3::uuid, 'Troca direta')`, [ADMIN, direct.id, destination]);

  assert.equal(moved.moved, true);
  assert.equal(moved.experienceChanged, true);
  const after = await reservation(direct.id);
  assert.equal(after.status, "CONFIRMED");
  assert.equal(after.session_id, destination);
  assertPreserved(before, after);
  const [change] = await changes(direct.id);
  assert.equal(change.origin, "DIRECT");
  assert.equal(change.actor_type, "ADMIN");
  assert.equal(change.standby_id, null);
  assert.deepEqual(await standbyRows(direct.id), [], "a troca direta não passa pelo Stand-by");
  await rejects(call(`public.admin_change_reservation_session($1::uuid, $2::uuid, $3::uuid, null)`, [ADMIN, direct.id, destination]), /SAME_SESSION/);

  const waiting = await reserve(origin, 1);
  await setStandby(waiting.id);
  await rejects(call(`public.admin_change_reservation_session($1::uuid, $2::uuid, $3::uuid, null)`, [ADMIN, waiting.id, destination]), /RESERVATION_NOT_CONFIRMED/);
  assert.equal((await reservation(waiting.id)).status, "AWAITING_RESCHEDULE");
});

test("e-mail de confirmação não é reivindicado nem montado para reserva em Stand-by", async () => {
  const session = await makeSession(IMERSAO.id);
  const booking = await reserve(session);
  assert.ok(await call(`public.reservation_confirmation_email($1::uuid)`, [booking.id]));
  await setStandby(booking.id);

  assert.equal(await call(`public.claim_reservation_confirmation_email($1::uuid, 3)`, [booking.id]), null);
  assert.equal(await call(`public.reservation_confirmation_email($1::uuid)`, [booking.id]), null);
  assert.deepEqual(await rows(`select 1 from public.integration_sync_jobs where entity_id = $1::uuid`, [booking.id]), []);
});

test("planilha: o snapshot mostra a reserva paga e fora da turma, sem contar a vaga", async () => {
  const session = await makeSession(IMERSAO.id, { capacity: 4 });
  const booking = await reserve(session, 2);
  const stays = await reserve(session, 1);
  await setStandby(booking.id);

  const snapshot = await call(`public.google_sheets_session_snapshot($1::uuid)`, [session]);
  assert.equal(snapshot.session.confirmedSpots, 1);
  assert.equal(snapshot.session.remainingSpots, 3);
  const mine = (snapshot.reservations as Row[]).find((row) => row.id === booking.id)!;
  assert.equal(mine.status, "AWAITING_RESCHEDULE");
  assert.equal(mine.paymentStatus, "PAID");
  assert.equal(mine.cancelledAt, null);
  assert.equal((snapshot.reservations as Row[]).find((row) => row.id === stays.id)!.status, "CONFIRMED");
});

test("fluxo normal intacto: pré-reserva, pagamento, capacidade e cancelamento", async () => {
  const session = await makeSession(IMERSAO.id, { capacity: 2 });
  const first = await reserve(session, 1);
  const second = await preReserve(session, 1);
  assert.equal(await spots(session), 0);
  await rejects(preReserve(session, 1), /INSUFFICIENT_SPOTS/);

  assert.equal(await call(`public.cancel_pre_reservation($1::uuid)`, [second.id]), true);
  assert.equal(await spots(session), 1);
  assert.equal((await reservation(first.id)).status, "CONFIRMED");
  assert.ok((await reservation(first.id)).checkin_token);
  assert.equal(await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Cancelamento normal')`, [ADMIN, first.id]), true);
  assert.equal(await spots(session), 2);
  assert.deepEqual(await standbyRows(first.id), []);
});

// =============================================================================
// 10. Material de publicação: preflight, postcheck e rollback
// =============================================================================

function operationsFile(path: string) {
  return readFileSync(new URL(`../supabase/${path}`, import.meta.url), "utf8");
}

async function diagnostic(database: typeof db, path: string) {
  const sql = operationsFile(path);
  assert.ok(!/\b(insert|update|delete|alter|create|drop|grant|revoke|truncate)\b/i.test(sql.replace(/--.*$/gm, "").replace(/'[^']*'/g, "''")), `${path} é somente leitura`);
  return (await database.query(sql)).rows as Array<{ check_name: string; result: string; status: string }>;
}

/** O postcheck é para logo depois da migration; com o Stand-by já usado, só estas linhas acusam. */
const AFTER_USE = ["NENHUMA_RESERVA_EM_STANDBY", "HISTORICO_ANTERIOR_DESCRITO_COMO_TROCA_DIRETA", "STANDBY_POSTCHECK_OK"];

test("preflight: aprovado no banco anterior à entrega e reprovado depois dela", async () => {
  const previous = await fullDatabase({ until: "202610120002_rota_ermida_texto.sql" });
  const before = await diagnostic(previous, "diagnostics/reservation_standby_preflight.sql");
  assert.deepEqual(before.filter((row) => row.status !== "OK"), [], JSON.stringify(before, null, 2));
  assert.equal(before.at(-1)?.check_name, "STANDBY_PREFLIGHT_OK");

  const after = await diagnostic(db, "diagnostics/reservation_standby_preflight.sql");
  const failed = after.filter((row) => row.status !== "OK").map((row) => row.check_name);
  for (const expected of ["ENUM_AINDA_SEM_O_STATUS_NOVO", "TABELA_DE_STANDBY_AINDA_NAO_EXISTE", "FUNCOES_A_SUBSTITUIR", "STANDBY_PREFLIGHT_OK"]) {
    assert.ok(failed.includes(expected), `${expected} precisa acusar que a migration já foi aplicada`);
  }
});

test("preflight: aceita os quatro status em qualquer ordem, como no enum legado de produção, e reprova um quinto", async () => {
  const legacy = await fullDatabase({ until: "202610120002_rota_ermida_texto.sql" });
  // Produção: o enum nasceu no schema legado e teve os rótulos renomeados, então
  // CANCELLED vem antes de EXPIRED.
  await legacy.exec(`
    update pg_enum e set enumsortorder = 2.5
    from pg_type t where t.oid = e.enumtypid and t.typname = 'reservation_status' and e.enumlabel = 'CANCELLED';
  `);

  const reordered = await diagnostic(legacy, "diagnostics/reservation_standby_preflight.sql");
  const enumRow = reordered.find((row) => row.check_name === "ENUM_AINDA_SEM_O_STATUS_NOVO");
  assert.equal(enumRow?.result, "PRE_RESERVED, CONFIRMED, CANCELLED, EXPIRED");
  assert.deepEqual(reordered.filter((row) => row.status !== "OK"), [], JSON.stringify(reordered, null, 2));

  // A ordem não interfere na migration: o valor novo entra no fim.
  const migrated = await fullDatabase({ until: "202610120002_rota_ermida_texto.sql" });
  await migrated.exec(`
    update pg_enum e set enumsortorder = 2.5
    from pg_type t where t.oid = e.enumtypid and t.typname = 'reservation_status' and e.enumlabel = 'CANCELLED';
  `);
  await applyMigration(migrated, "202610130001_reservation_status_awaiting_reschedule.sql");
  await applyMigration(migrated, "202610130002_reservation_standby.sql");
  const labels = (await migrated.query(
    "select string_agg(e.enumlabel, ', ' order by e.enumsortorder) as labels from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'reservation_status'",
  )).rows as Array<{ labels: string }>;
  assert.equal(labels[0].labels, "PRE_RESERVED, CONFIRMED, CANCELLED, EXPIRED, AWAITING_RESCHEDULE");
  const postcheck = await diagnostic(migrated, "diagnostics/reservation_standby_postcheck.sql");
  assert.deepEqual(postcheck.filter((row) => row.status !== "OK"), [], JSON.stringify(postcheck, null, 2));

  // Valor a mais continua reprovando, esteja onde estiver.
  await legacy.exec("alter type public.reservation_status add value 'OUTRO_STATUS' before 'CONFIRMED'");
  const extra = await diagnostic(legacy, "diagnostics/reservation_standby_preflight.sql");
  const failed = extra.filter((row) => row.status !== "OK").map((row) => row.check_name);
  assert.deepEqual(failed, ["ENUM_AINDA_SEM_O_STATUS_NOVO", "STANDBY_PREFLIGHT_OK"]);
});

test("postcheck: aprovado logo após as migrations e sensível a Stand-by em uso e a definição alterada", async () => {
  const fresh = await fullDatabase();
  const clean = await diagnostic(fresh, "diagnostics/reservation_standby_postcheck.sql");
  assert.deepEqual(clean.filter((row) => row.status !== "OK"), [], JSON.stringify(clean, null, 2));
  assert.equal(clean.at(-1)?.check_name, "STANDBY_POSTCHECK_OK");

  // No banco dos testes o Stand-by já foi usado: só as linhas de "ainda sem uso" acusam.
  const used = await diagnostic(db, "diagnostics/reservation_standby_postcheck.sql");
  assert.deepEqual(used.filter((row) => row.status !== "OK").map((row) => row.check_name), AFTER_USE);

  // Definição mexida à mão e função exposta: os dois precisam aparecer.
  await fresh.exec(`
    create or replace function public.reservation_latest_standby(p_reservation_id uuid) returns uuid language sql stable security definer set search_path = public as $$ select null::uuid $$;
    grant execute on function public.reservation_standby_resolve(uuid, uuid, text, uuid, text, text) to anon;
  `);
  const tampered = (await diagnostic(fresh, "diagnostics/reservation_standby_postcheck.sql")).filter((row) => row.status !== "OK").map((row) => row.check_name);
  assert.ok(tampered.includes("FUNCOES_COM_A_DEFINICAO_DO_REPOSITORIO"));
  assert.ok(tampered.includes("NENHUMA_FUNCAO_EXECUTAVEL_PELA_API_PUBLICA"));

  const before = await fullDatabase({ until: ENUM_MIGRATION });
  await rejects(before.query(operationsFile("diagnostics/reservation_standby_postcheck.sql")), /reservation_standby/);
});

test("rollback: recusa com Stand-by aberto; sem nenhum, devolve as funções ao texto anterior e pode ser refeito", async () => {
  const rollback = operationsFile("rollback/202610130002_reservation_standby.rollback.sql");
  const replaced = ["reconcile_reservation_payment", "confirm_reservation_payment", "admin_confirm_reservation",
    "admin_payments_needing_review", "payment_review_counters", "admin_dashboard_metrics", "admin_base_dashboard_metrics"];
  const sources = async (database: typeof db) =>
    (await database.query(`select proname, prosrc, proacl::text as acl from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1) order by proname`, [replaced])).rows;

  // Com reserva em Stand-by, nada é revertido.
  const busy = await fullDatabase();
  await busy.exec(`
    insert into auth.users (id, email) values ('${ADMIN}', 'admin@teste.local');
    insert into public.admin_users (user_id, display_name, role, is_active) values ('${ADMIN}', 'Admin', 'ADMIN', true);
  `);
  const sessionId = ((await busy.query(
    `insert into public.sessions (experience_id, starts_at, duration_minutes, price_cents, capacity, status)
     select id, now() + interval '5 days', 90, 7000, 4, 'OPEN' from public.experiences where slug = 'imersao-paranoa' returning id`,
  )).rows[0] as Row).id;
  const created = ((await busy.query(
    `select public.create_pre_reservation($1::uuid, 'Cliente Aguardando', '12345678901', '+5561999990000', 'a@teste.local', 2, null, gen_random_uuid()) as value`, [sessionId],
  )).rows[0] as Row).value;
  await busy.query(`select public.confirm_reservation_payment($1::uuid, 'INFINITEPAY', 'tx-rb', 14000, '', '{}'::jsonb)`, [created.reservationId]);
  await busy.query(`select public.admin_set_reservation_standby($1::uuid, $2::uuid, 'Chuva')`, [ADMIN, created.reservationId]);
  const withStandby = await sources(busy);

  await rejects(busy.exec(rollback), /ROLLBACK_BLOCKED_OPEN_STANDBY/);
  await busy.exec("rollback");
  assert.deepEqual(await sources(busy), withStandby);
  assert.equal(((await busy.query(`select count(*)::int as n from pg_trigger where tgname = 'reservations_standby_guard'`)).rows[0] as Row).n, 1);

  // Resolvido o Stand-by, o rollback passa.
  await busy.query(`select public.admin_undo_reservation_standby($1::uuid, $2::uuid, 'Antes do rollback')`, [ADMIN, created.reservationId]);
  await busy.exec(rollback);

  const previous = await fullDatabase({ until: ENUM_MIGRATION });
  assert.deepEqual(await sources(busy), await sources(previous), "texto e grants iguais aos de antes da migration");
  const leftovers = (await busy.query(
    `select proname from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1)`, [[...INTERNAL_FUNCTIONS, ...SERVER_FUNCTIONS]],
  )).rows;
  assert.deepEqual(leftovers, []);
  assert.equal(((await busy.query(`select count(*)::int as n from pg_trigger where tgname = 'reservations_standby_guard'`)).rows[0] as Row).n, 0);
  // Histórico preservado, reserva intacta.
  assert.equal(((await busy.query(`select count(*)::int as n from public.reservation_standby`)).rows[0] as Row).n, 1);
  assert.equal(((await busy.query(`select status from public.reservations where id = $1::uuid`, [created.reservationId])).rows[0] as Row).status, "CONFIRMED");
  assert.equal(((await busy.query(`select count(*)::int as n from public.reservation_session_changes`)).rows[0] as Row).n, 1);

  // E a migration pode ser reaplicada por cima.
  await applyMigration(busy, STANDBY_MIGRATION);
  const again = await diagnostic(busy, "diagnostics/reservation_standby_postcheck.sql");
  assert.deepEqual(again.filter((row) => row.status !== "OK").map((row) => row.check_name), AFTER_USE,
    "só acusa o histórico de Stand-by que ficou gravado");
});

// =============================================================================
// 11. Contrato do SQL: o que o PGlite não executa
// =============================================================================

test("o núcleo trava a reserva, a autorização e a sessão de destino, nessa ordem", async () => {
  const source = (await one(`select prosrc from pg_proc where proname = 'reservation_standby_resolve'`)).prosrc as string;
  const lockReservation = source.indexOf("from public.reservations where id = standby.reservation_id for update");
  const lockStandby = source.indexOf("from public.reservation_standby where id = p_standby_id for update");
  const lockSession = source.indexOf("from public.sessions where id = p_target_session_id for update");
  const capacity = source.indexOf("occupied + target.quantity > destination_session.capacity");
  const closeStandby = source.indexOf("update public.reservation_standby\n  set resolved_at = now()");
  const move = source.indexOf("set status = 'CONFIRMED',\n      session_id = destination_session.id");

  for (const position of [lockReservation, lockStandby, lockSession, capacity, closeStandby, move]) assert.ok(position > 0);
  assert.ok(lockReservation < lockStandby && lockStandby < lockSession, "reserva → autorização → sessão");
  assert.ok(lockSession < capacity, "a ocupação é recontada com a sessão travada");
  assert.ok(capacity < closeStandby && closeStandby < move, "a autorização é encerrada antes de a reserva voltar a CONFIRMED");
  assert.equal((source.match(/for update/g) ?? []).length, 3, "uma única sessão é travada: sem ciclo de espera com a troca administrativa");

  const entry = (await one(`select prosrc from pg_proc where proname = 'admin_set_reservation_standby'`)).prosrc as string;
  assert.ok(entry.includes("from public.reservations where id = p_reservation_id for update"));
  for (const name of ["admin_set_reservation_standby", "reservation_standby_resolve", "admin_undo_reservation_standby", "admin_reschedule_reservation_from_standby"]) {
    const body = (await one(`select prosrc from pg_proc where proname = $1`, [name])).prosrc as string;
    assert.ok(!/insert into public\.payment_events|unit_price_cents\s*=|integration_sync_jobs/.test(body), `${name} não cobra, não reprecifica e não enfileira`);
  }
});
