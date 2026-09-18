import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { canManageTeam, canSendCheckinQr, homeForRole, isAdminRole, isStaffRole, loginDestination } from "../lib/admin/roles.ts";
import { generateInviteToken, hashInviteToken, inviteUrl, isInviteToken, validateSignupInput } from "../lib/team/invite.ts";
import { registerInstructor, type SignupDeps } from "../lib/team/signup.ts";

const ROOT = new URL("../", import.meta.url).pathname;

function source(path: string) {
  return readFileSync(join(ROOT, path), "utf8");
}

function files(dir: string, name: RegExp): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(join(ROOT, path)).isDirectory()) return files(path, name);
    return name.test(entry) ? [path] : [];
  });
}

// --- Papéis -----------------------------------------------------------------

test("papéis: instrutor é equipe, mas não é administrador", () => {
  assert.equal(isStaffRole("INSTRUCTOR"), true);
  assert.equal(isAdminRole("INSTRUCTOR"), false);
  assert.equal(isAdminRole("ADMIN"), true);
  assert.equal(isAdminRole("OPERATOR"), true);
  for (const value of ["admin", "ROOT", "", null, undefined, 1]) assert.equal(isStaffRole(value), false);
  assert.equal(canManageTeam("ADMIN"), true);
  assert.equal(canManageTeam("OPERATOR"), false);
  assert.equal(canManageTeam("INSTRUCTOR"), false);
  assert.equal(canSendCheckinQr("INSTRUCTOR"), false);
  assert.equal(homeForRole("INSTRUCTOR"), "/instrutor");
  assert.equal(homeForRole("ADMIN"), "/admin");
});

test("destino pós-login nunca leva o instrutor ao painel nem a outro site", () => {
  assert.equal(loginDestination("INSTRUCTOR", "/admin/reservas"), "/instrutor");
  assert.equal(loginDestination("INSTRUCTOR", "/instrutor/abc"), "/instrutor/abc");
  assert.equal(loginDestination("INSTRUCTOR", "//evil.com/instrutor"), "/instrutor");
  assert.equal(loginDestination("INSTRUCTOR", "https://evil.com"), "/instrutor");
  assert.equal(loginDestination("INSTRUCTOR", "/instrutor/cadastro?invite=x"), "/instrutor");
  assert.equal(loginDestination("ADMIN", "/admin/reservas"), "/admin/reservas");
  assert.equal(loginDestination("ADMIN", "/instrutor"), "/admin");
  assert.equal(loginDestination("ADMIN", null), "/admin");
});

// --- Token do convite -------------------------------------------------------

test("token do convite: 256 bits aleatórios, hash SHA-256, link sem hash", () => {
  const tokens = new Set(Array.from({ length: 200 }, generateInviteToken));
  assert.equal(tokens.size, 200);
  const token = [...tokens][0];
  assert.equal(isInviteToken(token), true);
  assert.equal(Buffer.from(token, "base64url").length, 32);
  assert.match(hashInviteToken(token), /^[0-9a-f]{64}$/);
  assert.notEqual(hashInviteToken(token), token);
  const url = inviteUrl(token, "https://www.almaazulacademy.com.br");
  assert.equal(url, `https://www.almaazulacademy.com.br/instrutor/cadastro?invite=${token}`);
  assert.ok(!url.includes(hashInviteToken(token)));
  for (const bad of ["", "abc", `${token}x`, token.replace(/.$/, "!"), null]) assert.equal(isInviteToken(bad), false);
});

test("cadastro: validação e role enviado pelo cliente é ignorado", () => {
  const token = generateInviteToken();
  const ok = validateSignupInput({ token, name: "  Ana   Lima ", email: " ANA@Exemplo.com ", password: "remada2026", passwordConfirmation: "remada2026", role: "ADMIN" });
  assert.equal(ok.success, true);
  if (ok.success) {
    assert.deepEqual(ok.data, { token, name: "Ana Lima", email: "ana@exemplo.com", password: "remada2026" });
    assert.ok(!("role" in ok.data));
  }
  const bad = validateSignupInput({ token: "x", name: "A", email: "nope", password: "curta", passwordConfirmation: "" });
  assert.equal(bad.success, false);
  if (!bad.success) assert.deepEqual(Object.keys(bad.errors).sort(), ["email", "form", "name", "password"]);
  const mismatch = validateSignupInput({ token, name: "Ana", email: "a@b.co", password: "remada2026", passwordConfirmation: "remada2027" });
  assert.equal(!mismatch.success && mismatch.errors.passwordConfirmation, "As senhas não conferem.");
  const noDigit = validateSignupInput({ token, name: "Ana", email: "a@b.co", password: "somenteletras", passwordConfirmation: "somenteletras" });
  assert.equal(noDigit.success, false);
});

// --- Orquestração do cadastro sobre banco real ------------------------------

const ADMIN = "00000000-0000-4000-8000-00000000000a";

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users (id uuid primary key default gen_random_uuid(), email text unique, last_sign_in_at timestamptz);
    create type public.reservation_status as enum ('PRE_RESERVED','CONFIRMED','EXPIRED','CANCELLED');
    create table public.bases (id uuid primary key, name text);
    create table public.experiences (id uuid primary key, title text not null, base_id uuid);
    create table public.sessions (id uuid primary key, experience_id uuid not null, starts_at timestamptz not null, capacity int not null default 10, status text not null default 'OPEN');
    create table public.reservations (id uuid primary key, public_code text not null, experience_id uuid not null, session_id uuid not null,
      status public.reservation_status not null, full_name text not null, email text, quantity int not null, updated_at timestamptz default now());
    create table public.admin_users (user_id uuid primary key references auth.users(id) on delete cascade, display_name text not null,
      role text not null default 'ADMIN' check (role in ('ADMIN', 'OPERATOR')), is_active boolean not null default true,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table public.admin_audit_log (id uuid primary key default gen_random_uuid(), actor_user_id uuid, action text not null,
      entity_type text not null, entity_id uuid, reason text, metadata jsonb not null default '{}', created_at timestamptz default now());
    create function public.is_active_admin(p_user_id uuid) returns boolean language sql stable as
      $$ select exists (select 1 from public.admin_users where user_id = p_user_id and is_active) $$;
    create function public.reservation_confirmation_email(p_reservation_id uuid) returns jsonb language sql as $$ select '{}'::jsonb $$;
    insert into auth.users (id, email) values ('${ADMIN}', 'admin@almaazul.com');
    insert into public.admin_users (user_id, display_name) values ('${ADMIN}', 'Admin');
  `);
  await db.exec(source("supabase/migrations/202609180001_reservation_checkin.sql"));
  await db.exec(source("supabase/migrations/202609200001_instructor_access.sql"));
  return db;
}

function pgliteDeps(db: PGlite, overrides: Partial<SignupDeps> = {}): SignupDeps {
  return {
    async inviteStatus(hash) {
      return (await db.query<{ s: string }>("select public.instructor_invite_status($1) as s", [hash])).rows[0].s;
    },
    async createUser(email) {
      try {
        const row = await db.query<{ id: string }>("insert into auth.users (email) values ($1) returning id", [email]);
        return { userId: row.rows[0].id };
      } catch {
        return { error: "EMAIL_EXISTS" };
      }
    },
    async claimInvite(hash, userId, name) {
      await db.query("select public.instructor_invite_claim($1, $2, $3)", [hash, userId, name]);
    },
    async deleteUser(userId) {
      await db.query("delete from auth.users where id = $1", [userId]);
    },
    ...overrides,
  };
}

async function invite(db: PGlite, days = 7) {
  const token = generateInviteToken();
  await db.query("select public.admin_create_instructor_invite($1, $2, $3)", [ADMIN, hashInviteToken(token), days]);
  return token;
}

const input = (token: string, email = "ana@exemplo.com") => ({ token, name: "Ana", email, password: "remada2026" });

async function count(db: PGlite, sql: string) {
  return (await db.query<{ n: number }>(`select (${sql})::int as n`)).rows[0].n;
}

test("cadastro com convite válido cria usuário INSTRUCTOR e consome o convite", async () => {
  const db = await database();
  const token = await invite(db);
  const result = await registerInstructor(input(token), pgliteDeps(db));
  assert.equal(result.ok, true);
  const row = await db.query<{ role: string; is_active: boolean }>("select role, is_active from public.admin_users au join auth.users u on u.id = au.user_id where u.email = 'ana@exemplo.com'");
  assert.deepEqual(row.rows, [{ role: "INSTRUCTOR", is_active: true }]);
  assert.equal(await count(db, "select count(*) from public.instructor_invites where used_at is not null"), 1);
});

test("sem convite, com convite reutilizado ou expirado: nada é criado", async () => {
  const db = await database();
  const unknown = await registerInstructor(input(generateInviteToken()), pgliteDeps(db));
  assert.equal(!unknown.ok && unknown.code, "INVITE_INVALID");

  const token = await invite(db);
  assert.equal((await registerInstructor(input(token), pgliteDeps(db))).ok, true);
  const reused = await registerInstructor(input(token, "outra@exemplo.com"), pgliteDeps(db));
  assert.equal(!reused.ok && reused.code, "INVITE_USED");

  const expired = await invite(db, 1);
  await db.exec("update public.instructor_invites set created_at = now() - interval '3 days', expires_at = now() - interval '1 day' where used_at is null");
  const late = await registerInstructor(input(expired, "tarde@exemplo.com"), pgliteDeps(db));
  assert.equal(!late.ok && late.code, "INVITE_EXPIRED");

  assert.equal(await count(db, "select count(*) from auth.users"), 2); // admin + primeira conta
});

test("dois cadastros simultâneos com o mesmo convite: só um vence e o outro não deixa usuário órfão", async () => {
  const db = await database();
  const token = await invite(db);
  const [first, second] = await Promise.all([
    registerInstructor(input(token, "um@exemplo.com"), pgliteDeps(db)),
    registerInstructor(input(token, "dois@exemplo.com"), pgliteDeps(db)),
  ]);
  assert.equal([first, second].filter((result) => result.ok).length, 1);
  const loser = [first, second].find((result) => !result.ok);
  assert.equal(loser && !loser.ok && loser.code, "INVITE_USED");
  assert.equal(await count(db, "select count(*) from auth.users"), 2);
  assert.equal(await count(db, "select count(*) from public.admin_users where role = 'INSTRUCTOR'"), 1);
  assert.equal(await count(db, "select count(*) from auth.users u where not exists (select 1 from public.admin_users au where au.user_id = u.id)"), 0);
});

test("falha ao consumir o convite desfaz o usuário e mantém o convite válido", async () => {
  const db = await database();
  const token = await invite(db);
  const result = await registerInstructor(input(token), pgliteDeps(db, {
    async claimInvite() { throw new Error("network down"); },
  }));
  assert.equal(!result.ok && result.code, "UNEXPECTED");
  assert.equal(await count(db, "select count(*) from auth.users"), 1);
  assert.equal(await count(db, "select count(*) from public.instructor_invites where used_at is null"), 1);
});

test("e-mail já cadastrado não consome o convite", async () => {
  const db = await database();
  const token = await invite(db);
  const result = await registerInstructor(input(token, "admin@almaazul.com"), pgliteDeps(db));
  assert.equal(!result.ok && result.code, "EMAIL_EXISTS");
  assert.equal(await count(db, "select count(*) from public.instructor_invites where used_at is null"), 1);
  assert.equal(await count(db, `select count(*) from public.admin_users where user_id = '${ADMIN}' and role = 'ADMIN'`), 1);
});

// --- Varredura das rotas: nenhuma fica sem guard ------------------------------

test("toda página do painel passa pelo layout com requireAdmin", () => {
  assert.match(source("app/admin/layout.tsx"), /await requireAdmin\(\)/);
  assert.match(source("app/admin/equipe/page.tsx"), /await requireTeamManager\(\)/);
});

test("toda rota /api/admin exige papel administrativo; só o check-in aceita instrutor", () => {
  const checkin = new Set(["app/api/admin/checkin/route.ts", "app/api/admin/checkin/lookup/route.ts"]);
  const team = /^app\/api\/admin\/team\//;
  const routes = files("app/api/admin", /^route\.ts$/).map((path) => relative(ROOT, join(ROOT, path)));
  assert.ok(routes.length > 15);
  for (const route of routes) {
    const text = source(route);
    const exported = [...text.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g)].length;
    if (checkin.has(route)) {
      assert.equal([...text.matchAll(/await authorizeCheckinApi\(\)/g)].length, exported, route);
    } else if (team.test(route)) {
      assert.equal([...text.matchAll(/await authorizeTeamManagerApi\(\)/g)].length, exported, route);
    } else {
      assert.ok(!text.includes("authorizeCheckinApi"), route);
      assert.ok(/authorizeAdminApi\(\)/.test(text), route);
    }
  }
});

test("área do instrutor exige sessão da equipe e não usa nada do painel restrito", () => {
  assert.match(source("app/instrutor/(area)/layout.tsx"), /await requireCheckinStaff\(\)/);
  for (const page of files("app/instrutor/(area)", /^page\.tsx$/)) {
    const text = source(page);
    assert.match(text, /await requireCheckinStaff\(\)/, page);
    assert.doesNotMatch(text, /listAdminReservations|getAdminDashboard|QrBulkSender|AdminShell/, page);
  }
  const middleware = source("middleware.ts");
  assert.match(middleware, /"\/instrutor\/:path\*"/);
});

test("papel nunca vem do cliente nem do Auth metadata", () => {
  const signupRoute = source("app/api/instrutor/cadastro/route.ts");
  assert.doesNotMatch(signupRoute, /body\.role|\.role\s*=/);
  const data = source("lib/team/data.ts");
  assert.match(data, /auth\.admin\.createUser\(\{ email, password, email_confirm: true \}\)/);
  const auth = source("lib/admin/auth.ts");
  assert.doesNotMatch(auth, /\.(user|app)_metadata/);
  assert.match(auth, /from\("admin_users"\)/);
});
