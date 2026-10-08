import { readdirSync, readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const MIGRATIONS = new URL("../../supabase/migrations/", import.meta.url);

/**
 * Banco completo em memória: todas as migrations do repositório, em ordem,
 * sobre um Postgres real (PGlite). Só o que o Supabase fornece de fábrica é
 * simulado — papéis, `auth.users` e o agendador `cron`.
 *
 * `until` aplica só as migrations com nome menor ou igual ao informado, para
 * montar o estado "antes" de uma migration.
 */
export async function fullDatabase(options: { until?: string } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create schema extensions; create extension pgcrypto with schema extensions;
    create schema cron;
    create table cron.job (jobid bigint, jobname text);
    create function cron.schedule(text, text, text) returns bigint language sql as $$ select 1::bigint $$;
    create function cron.unschedule(text) returns boolean language sql as $$ select true $$;
  `);
  for (const file of migrationFiles()) {
    if (options.until && file > options.until) break;
    await applyMigration(db, file);
  }
  return db;
}

export function migrationFiles() {
  return readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql")).sort();
}

export async function applyMigration(db: PGlite, file: string) {
  const sql = readFileSync(new URL(file, MIGRATIONS), "utf8").replace(/create extension if not exists pg_cron;/g, "");
  await db.exec(sql);
}
