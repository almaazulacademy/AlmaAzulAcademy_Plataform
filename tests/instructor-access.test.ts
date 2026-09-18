import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

// =============================================================================
// Banco real (PGlite): migrations de check-in + acesso de instrutores sobre um
// schema mínimo. Cobre as regras que valem mesmo se o app for contornado.
// =============================================================================

const ADMIN = "00000000-0000-4000-8000-00000000000a";
const OPERATOR = "00000000-0000-4000-8000-00000000000c";
const INSTRUCTOR = "00000000-0000-4000-8000-00000000000d";
const NEWCOMER = "00000000-0000-4000-8000-00000000000e";
const OTHER = "00000000-0000-4000-8000-00000000000f";
const SESSION = "00000000-0000-4000-8000-000000000051";
const EXP = "00000000-0000-4000-8000-0000000000e1";
const RES = "00000000-0000-4000-8000-000000000101";
const HASH = (char: string) => char.repeat(64);

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users (id uuid primary key, email text, last_sign_in_at timestamptz);
    create type public.reservation_status as enum ('PRE_RESERVED','CONFIRMED','EXPIRED','CANCELLED');
    create table public.bases (id uuid primary key default gen_random_uuid(), name text);
    create table public.experiences (id uuid primary key, title text not null, base_id uuid);
    create table public.sessions (id uuid primary key, experience_id uuid not null, starts_at timestamptz not null, capacity int not null default 10, status text not null default 'OPEN');
    create table public.reservations (
      id uuid primary key, public_code text not null, experience_id uuid not null, session_id uuid not null,
      status public.reservation_status not null, full_name text not null, email text, quantity int not null,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table public.admin_users (
      user_id uuid primary key references auth.users(id), display_name text not null,
      role text not null default 'ADMIN' check (role in ('ADMIN', 'OPERATOR')),
      is_active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table public.admin_audit_log (id uuid primary key default gen_random_uuid(), actor_user_id uuid, action text not null,
      entity_type text not null, entity_id uuid, reason text, metadata jsonb not null default '{}', created_at timestamptz default now());
    create function public.is_active_admin(p_user_id uuid) returns boolean language sql stable as
      $$ select exists (select 1 from public.admin_users where user_id = p_user_id and is_active) $$;
    create function public.reservation_confirmation_email(p_reservation_id uuid) returns jsonb language sql as $$ select '{}'::jsonb $$;

    insert into auth.users values
      ('${ADMIN}', 'admin@almaazul.com', null), ('${OPERATOR}', 'op@almaazul.com', null),
      ('${INSTRUCTOR}', 'instrutor@exemplo.com', now()), ('${NEWCOMER}', 'novo@exemplo.com', null),
      ('${OTHER}', 'outro@exemplo.com', null);
    insert into public.admin_users (user_id, display_name, role) values ('${ADMIN}', 'Admin', 'ADMIN'), ('${OPERATOR}', 'Op', 'OPERATOR');
    insert into public.experiences values ('${EXP}', 'Imersão Paranoá', null);
    insert into public.sessions (id, experience_id, starts_at) values ('${SESSION}', '${EXP}', '2026-09-20 12:00+00');
    insert into public.reservations (id, public_code, experience_id, session_id, status, full_name, email, quantity)
      values ('${RES}', 'AZ1', '${EXP}', '${SESSION}', 'CONFIRMED', 'Cliente', 'cliente@exemplo.com', 2);
  `);
  await db.exec(source("supabase/migrations/202609180001_reservation_checkin.sql"));
  await db.exec(source("supabase/migrations/202609200001_instructor_access.sql"));
  // O instrutor "veterano" entra pelo próprio fluxo de convite.
  await db.query("select public.admin_create_instructor_invite($1, $2, 7)", [ADMIN, HASH("a")]);
  await db.query("select public.instructor_invite_claim($1, $2, 'Instrutor')", [HASH("a"), INSTRUCTOR]);
  return db;
}

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: Error) => pattern.test(error.message));
}

async function scalar<T>(db: PGlite, sql: string, params: unknown[] = []) {
  const result = await db.query<{ value: T }>(`select (${sql}) as value`, params);
  return result.rows[0]?.value as T;
}

test("migration é idempotente e preserva o admin atual", async () => {
  const db = await database();
  await db.exec(source("supabase/migrations/202609200001_instructor_access.sql"));
  assert.equal(await scalar(db, "public.is_active_admin($1)", [ADMIN]), true);
  assert.equal(await scalar(db, "public.is_active_admin($1)", [OPERATOR]), true);
  assert.equal(await scalar(db, "public.is_active_owner_admin($1)", [ADMIN]), true);
  assert.equal(await scalar(db, "public.is_active_owner_admin($1)", [OPERATOR]), false);
  await rejects(db.query(`insert into public.admin_users (user_id, display_name, role) values ('${OTHER}', 'X', 'ROOT')`), /admin_users_role_allowed/);
});

test("instrutor não passa em is_active_admin: nenhuma RPC administrativa o aceita", async () => {
  const db = await database();
  assert.equal(await scalar(db, "public.is_active_admin($1)", [INSTRUCTOR]), false);
  assert.equal(await scalar(db, "public.is_active_checkin_staff($1)", [INSTRUCTOR]), true);
  await rejects(db.query("select public.admin_reservation_qr_email($1, $2)", [INSTRUCTOR, RES]), /ADMIN_FORBIDDEN/);
  await rejects(db.query("select public.admin_list_instructors($1)", [INSTRUCTOR]), /ADMIN_FORBIDDEN/);
  await rejects(db.query("select public.admin_create_instructor_invite($1, $2, 7)", [INSTRUCTOR, HASH("b")]), /ADMIN_FORBIDDEN/);
  await rejects(db.query("select public.admin_set_instructor_active($1, $2, false)", [INSTRUCTOR, INSTRUCTOR]), /ADMIN_FORBIDDEN/);
  await rejects(db.query("select public.admin_revoke_instructor_invite($1, gen_random_uuid())", [INSTRUCTOR]), /ADMIN_FORBIDDEN/);
});

test("todas as RPCs admin_* dependem de is_active_admin ou de uma checagem mais estrita", () => {
  // Varredura estática: nenhuma migration pode ter criado uma RPC administrativa
  // que se autorize só por `is_active` sem passar pelas funções de role.
  const migration = source("supabase/migrations/202609200001_instructor_access.sql");
  const staffOnly = ["admin_attendance_sessions", "admin_attendance_session", "admin_checkin_lookup", "admin_register_checkin"];
  for (const name of staffOnly) {
    const start = migration.indexOf(`function public.${name}(`);
    const body = migration.slice(start, migration.indexOf("$$;", migration.indexOf("$$", start) + 2));
    assert.match(body, /is_active_checkin_staff\(p_actor_id\)/, name);
  }
  assert.doesNotMatch(migration, /grant execute on function public\.[a-z_]+\([^)]*\) to [^;]*(anon|authenticated)/);
});

test("instrutor usa a lista de presença e faz check-in; o e-mail do cliente não é exposto", async () => {
  const db = await database();
  const sessions = await db.query("select * from public.admin_attendance_sessions($1, '2026-09-20')", [INSTRUCTOR]);
  assert.equal(sessions.rows.length, 1);
  const board = await scalar<{ reservations: unknown[] }>(db, "public.admin_attendance_session($1, $2)", [INSTRUCTOR, SESSION]);
  assert.equal(board.reservations.length, 1);

  const token = await scalar<string>(db, `(select checkin_token::text from public.reservations where id = '${RES}')`);
  const lookup = await scalar<Record<string, unknown>>(db, "public.admin_checkin_lookup($1, $2::uuid, null)", [INSTRUCTOR, token]);
  assert.equal(lookup.reservationId, RES);
  assert.equal(lookup.email, null);
  const adminLookup = await scalar<Record<string, unknown>>(db, "public.admin_checkin_lookup($1, null, $2)", [ADMIN, RES]);
  assert.equal(adminLookup.email, "cliente@exemplo.com");

  const done = await scalar<Record<string, unknown>>(db, "public.admin_register_checkin($1, $2, 2, 'QR', $3, false)", [INSTRUCTOR, RES, SESSION]);
  assert.equal(done.checkedInCount, 2);
  assert.equal(done.checkedInByName, "Instrutor");
  const audit = await db.query("select actor_user_id from public.admin_audit_log where action = 'CHECKIN_REGISTERED'");
  assert.deepEqual(audit.rows, [{ actor_user_id: INSTRUCTOR }]);
});

test("admin continua usando o check-in normalmente", async () => {
  const db = await database();
  const done = await scalar<Record<string, unknown>>(db, "public.admin_register_checkin($1, $2, 0, 'MANUAL', null, false)", [ADMIN, RES]);
  assert.equal(done.checkedInCount, 0);
});

test("instrutor desativado perde o check-in no banco e é reativável", async () => {
  const db = await database();
  assert.equal(await scalar(db, "public.admin_set_instructor_active($1, $2, false)", [ADMIN, INSTRUCTOR]), true);
  await rejects(db.query("select * from public.admin_attendance_sessions($1, '2026-09-20')", [INSTRUCTOR]), /ADMIN_FORBIDDEN/);
  await rejects(db.query("select public.admin_register_checkin($1, $2, 1, 'MANUAL', null, false)", [INSTRUCTOR, RES]), /ADMIN_FORBIDDEN/);
  assert.equal(await scalar(db, "public.admin_set_instructor_active($1, $2, true)", [ADMIN, INSTRUCTOR]), true);
  assert.equal(await scalar(db, "public.is_active_checkin_staff($1)", [INSTRUCTOR]), true);
  const actions = await db.query<{ action: string }>("select action from public.admin_audit_log where entity_id = $1 order by created_at", [INSTRUCTOR]);
  assert.deepEqual(actions.rows.map((row) => row.action).filter((a) => a.endsWith("ACTIVATED")), ["INSTRUCTOR_DEACTIVATED", "INSTRUCTOR_REACTIVATED"]);
});

test("a gestão de equipe nunca alcança um admin", async () => {
  const db = await database();
  await rejects(db.query("select public.admin_set_instructor_active($1, $2, false)", [ADMIN, OPERATOR]), /INSTRUCTOR_NOT_FOUND/);
  assert.equal(await scalar(db, "public.is_active_admin($1)", [OPERATOR]), true);
});

test("convite: uso único, role sempre INSTRUCTOR e auditoria", async () => {
  const db = await database();
  await db.query("select public.admin_create_instructor_invite($1, $2, 7)", [ADMIN, HASH("c")]);
  assert.equal(await scalar(db, "public.instructor_invite_status($1)", [HASH("c")]), "VALID");
  const claimed = await scalar<Record<string, unknown>>(db, "public.instructor_invite_claim($1, $2, 'Nova')", [HASH("c"), NEWCOMER]);
  assert.equal(claimed.role, "INSTRUCTOR");
  assert.equal(await scalar(db, "(select role from public.admin_users where user_id = $1)", [NEWCOMER]), "INSTRUCTOR");
  assert.equal(await scalar(db, "public.instructor_invite_status($1)", [HASH("c")]), "USED");
  await rejects(db.query("select public.instructor_invite_claim($1, $2, 'De novo')", [HASH("c"), OTHER]), /INVITE_USED/);
  assert.equal(await scalar(db, "(select count(*)::int from public.admin_users where user_id = $1)", [OTHER]), 0);

  const actions = await db.query<{ action: string }>("select action from public.admin_audit_log where action like 'INSTRUCTOR_%' order by action");
  assert.ok(actions.rows.some((row) => row.action === "INSTRUCTOR_INVITE_CREATED"));
  assert.ok(actions.rows.some((row) => row.action === "INSTRUCTOR_INVITE_USED"));
  assert.ok(actions.rows.some((row) => row.action === "INSTRUCTOR_REGISTERED"));
});

test("convite inexistente, expirado ou revogado não cadastra ninguém", async () => {
  const db = await database();
  assert.equal(await scalar(db, "public.instructor_invite_status($1)", [HASH("f")]), "INVALID");
  await rejects(db.query("select public.instructor_invite_claim($1, $2, 'X')", [HASH("f"), OTHER]), /INVITE_INVALID/);

  await db.query("select public.admin_create_instructor_invite($1, $2, 1)", [ADMIN, HASH("d")]);
  await db.exec(`update public.instructor_invites set created_at = now() - interval '9 days', expires_at = now() - interval '2 days' where token_hash = '${HASH("d")}'`);
  assert.equal(await scalar(db, "public.instructor_invite_status($1)", [HASH("d")]), "EXPIRED");
  await rejects(db.query("select public.instructor_invite_claim($1, $2, 'X')", [HASH("d"), OTHER]), /INVITE_EXPIRED/);

  const created = await scalar<{ inviteId: string }>(db, "public.admin_create_instructor_invite($1, $2, 7)", [ADMIN, HASH("e")]);
  assert.equal(await scalar(db, "public.admin_revoke_instructor_invite($1, $2)", [ADMIN, created.inviteId]), true);
  await rejects(db.query("select public.instructor_invite_claim($1, $2, 'X')", [HASH("e"), OTHER]), /INVITE_REVOKED/);
  assert.equal(await scalar(db, "(select count(*)::int from public.admin_users where user_id = $1)", [OTHER]), 0);
});

test("convite não transforma um admin existente em instrutor", async () => {
  const db = await database();
  await db.query("select public.admin_create_instructor_invite($1, $2, 7)", [ADMIN, HASH("b")]);
  await rejects(db.query("select public.instructor_invite_claim($1, $2, 'X')", [HASH("b"), ADMIN]), /INVITE_ACCOUNT_EXISTS/);
  assert.equal(await scalar(db, "(select role from public.admin_users where user_id = $1)", [ADMIN]), "ADMIN");
  assert.equal(await scalar(db, "public.instructor_invite_status($1)", [HASH("b")]), "VALID");
});

test("admin lista instrutores e convites com e-mail e último acesso", async () => {
  const db = await database();
  const team = await scalar<{ instructors: Array<Record<string, unknown>>; invites: Array<Record<string, unknown>> }>(db, "public.admin_list_instructors($1)", [ADMIN]);
  assert.equal(team.instructors.length, 1);
  assert.equal(team.instructors[0].email, "instrutor@exemplo.com");
  assert.ok(team.instructors[0].lastSignInAt);
  assert.equal(team.invites[0].state, "USED");
  assert.equal(team.invites[0].usedByName, "Instrutor");
  assert.ok(!JSON.stringify(team).includes("token"));
});

test("anon e authenticated não executam as RPCs nem leem convites", async () => {
  const db = await database();
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    await rejects(db.query("select public.instructor_invite_claim($1, $2, 'X')", [HASH("a"), OTHER]), /permission denied/);
    await rejects(db.query("select public.admin_list_instructors($1)", [ADMIN]), /permission denied/);
    await rejects(db.query("select public.admin_register_checkin($1, $2, 1, 'MANUAL', null, false)", [ADMIN, RES]), /permission denied/);
    await rejects(db.query("select * from public.instructor_invites"), /permission denied/);
    await db.exec("reset role");
  }
});
