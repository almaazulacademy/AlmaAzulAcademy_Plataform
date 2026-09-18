import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

// Reproduz o schema legado de produção (`initial_schema`, fora do repositório)
// e prova que 202609200000 fecha a promoção a admin via `profiles.role`.

const ADMIN = "00000000-0000-4000-8000-00000000000a";
const USER = "00000000-0000-4000-8000-00000000000b";
const EXP = "00000000-0000-4000-8000-0000000000e1";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

async function legacy() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
    grant usage on schema public to anon, authenticated;
    create type public.profile_role as enum ('customer', 'admin');
    create table public.profiles (id uuid primary key references auth.users(id) on delete cascade, full_name text, phone text,
      role public.profile_role not null default 'customer', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table public.admin_users (user_id uuid primary key, display_name text not null, role text not null default 'ADMIN', is_active boolean not null default true);
    create table public.experiences (id uuid primary key, title text not null);
    create table public.sessions (id uuid primary key, experience_id uuid not null);
    create function public.is_active_admin(p_user_id uuid) returns boolean language sql stable security definer set search_path = public as
      $$ select exists (select 1 from public.admin_users where user_id = p_user_id and is_active and role in ('ADMIN', 'OPERATOR')) $$;
    revoke all on function public.is_active_admin(uuid) from public, anon, authenticated;
    create function public.is_admin() returns boolean language sql stable security definer set search_path = '' as
      $$ select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') $$;

    alter table public.profiles enable row level security;
    alter table public.experiences enable row level security;
    alter table public.sessions enable row level security;
    grant all on public.profiles, public.experiences, public.sessions to anon, authenticated;
    create policy "Admins manage profiles" on public.profiles for all using (public.is_admin()) with check (public.is_admin());
    create policy "Users update own profile" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
    create policy "Users view own profile" on public.profiles for select using (id = auth.uid() or public.is_admin());
    create policy "Admins manage experiences" on public.experiences for all using (public.is_admin()) with check (public.is_admin());
    create policy "Public can view active experiences" on public.experiences for select using (true);

    insert into auth.users values ('${ADMIN}'), ('${USER}');
    insert into public.profiles (id) values ('${ADMIN}'), ('${USER}');
    insert into public.admin_users (user_id, display_name) values ('${ADMIN}', 'Admin');
    insert into public.experiences values ('${EXP}', 'Imersão');
  `);
  return db;
}

async function as<T = Record<string, unknown>>(db: PGlite, uid: string, sql: string) {
  await db.exec(`set test.uid = '${uid}'; set role authenticated;`);
  try {
    return await db.query<T>(sql);
  } finally {
    await db.exec("reset role; reset test.uid;");
  }
}

test("antes da correção: usuário comum se promove e altera experiências (reprodução)", async () => {
  const db = await legacy();
  await as(db, USER, "update public.profiles set role = 'admin' where id = auth.uid()");
  await as(db, USER, `update public.experiences set title = 'invadido' where id = '${EXP}'`);
  const title = await db.query<{ title: string }>("select title from public.experiences");
  assert.equal(title.rows[0].title, "invadido");
});

test("depois da correção: role não é gravável e is_admin segue admin_users", async () => {
  const db = await legacy();
  await db.exec(source("supabase/migrations/202609200000_profiles_role_lockdown.sql"));
  await db.exec(source("supabase/migrations/202609200000_profiles_role_lockdown.sql")); // idempotente

  await assert.rejects(as(db, USER, "update public.profiles set role = 'admin' where id = auth.uid()"), /permission denied/);
  await assert.rejects(as(db, USER, `insert into public.profiles (id, role) values (gen_random_uuid(), 'admin')`), /permission denied/);
  await assert.rejects(as(db, USER, `update public.experiences set title = 'invadido' where id = '${EXP}'`), /permission denied/);
  await assert.rejects(as(db, USER, `delete from public.sessions`), /permission denied/);

  // Mesmo que alguém já tenha role = 'admin' em profiles, isso não vale mais nada.
  await db.exec(`update public.profiles set role = 'admin' where id = '${USER}'`);
  assert.equal((await as<{ ok: boolean }>(db, USER, "select public.is_admin() as ok")).rows[0].ok, false);
  assert.equal((await as<{ ok: boolean }>(db, ADMIN, "select public.is_admin() as ok")).rows[0].ok, true);

  // O que continua funcionando: editar o próprio nome/telefone e a leitura pública.
  await as(db, USER, "update public.profiles set full_name = 'Nome', phone = '61' where id = auth.uid()");
  assert.equal((await as<{ n: number }>(db, USER, "select count(*)::int as n from public.experiences")).rows[0].n, 1);
});

test("ambiente sem o schema legado: a migration não falha", async () => {
  const db = new PGlite();
  await db.exec(source("supabase/migrations/202609200000_profiles_role_lockdown.sql"));
});
