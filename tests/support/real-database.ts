/**
 * Banco de teste em um Postgres de verdade, com várias conexões.
 *
 * O PGlite dos outros testes tem uma conexão só: ele exercita a ordem de chegada
 * de duas requisições, mas não a espera real de uma sessão pelo lock de outra.
 * Aqui cada conexão é uma sessão independente do Postgres, e os locks são os de
 * produção.
 *
 * Usa `TEST_DATABASE_URL`, que precisa apontar para um servidor **descartável**
 * — no CI, o contêiner `postgres` do próprio job. Cada execução cria um banco
 * novo com nome aleatório, aplica todas as migrations do repositório e o apaga
 * no fim. Só o que o Supabase fornece de fábrica é simulado, do mesmo jeito que
 * em `full-database.ts`.
 *
 * Nunca aponte para o Supabase: este módulo recusa qualquer endereço que não
 * seja local.
 */

import { randomBytes } from "node:crypto";

import pg from "pg";

import { migrationFiles, migrationSql } from "./full-database.ts";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]);

/** O endereço do servidor de teste, ou null quando não há um configurado. */
export function realDatabaseUrl(env: Record<string, string | undefined> = process.env) {
  const url = env.TEST_DATABASE_URL?.trim();
  if (!url) return null;
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`TEST_DATABASE_URL precisa ser um Postgres local e descartável; recusado: ${host}`);
  }
  return url;
}

const BOOTSTRAP = `
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
  create schema auth; create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $f$ select null::uuid $f$;
  create schema extensions; create extension pgcrypto with schema extensions;
  create schema cron;
  create table cron.job (jobid bigint, jobname text);
  create function cron.schedule(text, text, text) returns bigint language sql as $f$ select 1::bigint $f$;
  create function cron.unschedule(text) returns boolean language sql as $f$ select true $f$;
`;

export type RealDatabase = {
  /** Uma sessão nova e independente no banco de teste. */
  connect(): Promise<pg.Client>;
  /** Fecha todas as sessões e apaga o banco. */
  destroy(): Promise<void>;
};

export async function realDatabase(url: string): Promise<RealDatabase> {
  const name = `alma_azul_test_${randomBytes(6).toString("hex")}`;
  const server = new pg.Client({ connectionString: url });
  await server.connect();
  await server.query(`create database ${name}`);

  const target = new URL(url);
  target.pathname = `/${name}`;
  const clients: pg.Client[] = [];

  async function connect() {
    const client = new pg.Client({ connectionString: target.toString() });
    // Um aviso do servidor (uma transação desfeita, por exemplo) não é um erro do teste.
    client.on("error", () => undefined);
    await client.connect();
    clients.push(client);
    return client;
  }

  try {
    const setup = await connect();
    await setup.query(BOOTSTRAP);
    for (const file of migrationFiles()) await setup.query(migrationSql(file));
  } catch (error) {
    await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
    await server.query(`drop database if exists ${name} with (force)`).catch(() => undefined);
    await server.end().catch(() => undefined);
    throw error;
  }

  return {
    connect,
    async destroy() {
      await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
      await server.query(`drop database if exists ${name} with (force)`);
      await server.end();
    },
  };
}
