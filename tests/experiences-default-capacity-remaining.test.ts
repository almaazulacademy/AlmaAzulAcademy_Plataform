/**
 * Capacidade padrão das quatro experiências regulares restantes (Cápsula Bar
 * 12, Lago Norte 24) — preflight, manutenção, postcheck e reversão.
 *
 * Roda os scripts manuais de verdade, num Postgres (PGlite) com todas as
 * migrations do repositório. O estado de partida imita produção em 23/11/2026:
 * as quatro com o valor antigo (24 no Cápsula Bar, 28 na Lua Cheia do Lago
 * Norte), um evento especial e sessões/reservas que não podem mudar.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { fullDatabase } from "./support/full-database.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const PREFLIGHT = read("supabase/diagnostics/experiences_default_capacity_restantes_2026_preflight.sql");
const MAINTENANCE = read("supabase/maintenance/experiences_default_capacity_restantes_2026.sql");
const POSTCHECK = read("supabase/diagnostics/experiences_default_capacity_restantes_2026_postcheck.sql");
const ROLLBACK = read("supabase/rollback/experiences_default_capacity_restantes_2026.rollback.sql");

const TARGETS = {
  "rota-prainha-do-congresso": [24, 12],
  "remada-lua-cheia-concha-acustica": [24, 12],
  "remada-nascer-do-sol-concha-acustica": [24, 12],
  "remada-lua-cheia": [28, 24],
} as const;

type Checks = Record<string, { result: string; status: string }>;

async function checks(db: PGlite, sql: string): Promise<Checks> {
  const result = await db.query<{ check_name: string; result: string; status: string }>(sql);
  return Object.fromEntries(result.rows.map((row) => [row.check_name, { result: row.result, status: row.status }]));
}

async function capacities(db: PGlite) {
  const result = await db.query<{ slug: string; default_capacity: number }>(`select slug, default_capacity from public.experiences order by slug`);
  return Object.fromEntries(result.rows.map((row) => [row.slug, row.default_capacity]));
}

async function fingerprint(db: PGlite, sql: string) {
  return (await db.query<{ value: string }>(sql)).rows[0].value;
}

const SESSIONS = `select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) as value from public.sessions s`;
const RESERVATIONS = `select md5(coalesce(string_agg(to_jsonb(r)::text, '|' order by r.id), '')) as value from public.reservations r`;

async function productionLikeDatabase() {
  const db = await fullDatabase();
  const slugs = (await db.query<{ slug: string }>(`select slug from public.experiences where slug = any($1)`, [Object.keys(TARGETS)])).rows.map((row) => row.slug);
  assert.deepEqual(slugs.sort(), Object.keys(TARGETS).sort(), "as quatro experiências existem nas migrations");
  for (const [slug, [from]] of Object.entries(TARGETS)) {
    await db.query(`update public.experiences set default_capacity = $2 where slug = $1`, [slug, from]);
  }
  // Evento especial com configuração própria: nunca pode entrar no plano.
  await db.query(`
    insert into public.experiences (slug, title, summary, description, status, kind, base_id, duration_minutes, price_cents, default_capacity, editorial_content)
    select 'essencia-teste', 'ESSÊNCIA teste', 'Evento', 'Evento especial de teste', 'DRAFT', 'EVENT', b.id, 210, 15000, 24, '{}'::jsonb
    from public.bases b where b.slug = 'concha-acustica'`);
  return db;
}

function assertRejects(promise: Promise<unknown>, code: string) {
  return assert.rejects(promise, (error: Error) => error.message.includes(code));
}

test("preflight: quatro regulares encontradas, quatro a alterar, evento fora do plano", async () => {
  const db = await productionLikeDatabase();
  const pre = await checks(db, PREFLIGHT);
  assert.equal(pre.targets_found.result, "4 de 4");
  assert.equal(pre.targets_not_regular.result, "0");
  assert.equal(pre.to_change.result, "4");
  assert.equal(pre.unexpected_values.status, "OK");
  assert.match(pre.special_events_preserved.result, /essencia-teste: DRAFT, padrão 24/);
  assert.doesNotMatch(pre.plan.result, /essencia/);
  assert.equal(pre.READY_TO_UPDATE_REMAINING_DEFAULT_CAPACITY.status, "OK");
});

test("manutenção: só os quatro padrões mudam; sessões, reservas, eventos e outras experiências ficam idênticos", async () => {
  const db = await productionLikeDatabase();
  const before = await capacities(db);
  const pre = await checks(db, PREFLIGHT);
  const sessionsBefore = await fingerprint(db, SESSIONS);
  const reservationsBefore = await fingerprint(db, RESERVATIONS);

  await db.exec(MAINTENANCE);

  const after = await capacities(db);
  for (const [slug, [, to]] of Object.entries(TARGETS)) assert.equal(after[slug], to, slug);
  for (const slug of Object.keys(before).filter((slug) => !(slug in TARGETS))) assert.equal(after[slug], before[slug], `${slug} não muda`);
  assert.equal(await fingerprint(db, SESSIONS), sessionsBefore);
  assert.equal(await fingerprint(db, RESERVATIONS), reservationsBefore);

  const post = await checks(db, POSTCHECK);
  assert.equal(post.REMAINING_DEFAULT_CAPACITY_OK.status, "OK");
  assert.equal(post.targets_updated.result, "4 de 4");
  assert.equal(post.audit_rows.result, "4 linha(s), 4 experiência(s)");
  assert.equal(post.audit_outside_plan.result, "0");
  assert.equal(post.sessions_fingerprint.result, pre.sessions_fingerprint.result);
  assert.equal(post.other_experiences_fingerprint.result, pre.other_experiences_fingerprint.result);
  assert.equal(post.targets_other_columns_fingerprint.result, pre.targets_other_columns_fingerprint.result);
  assert.equal(post.special_events_preserved.result, pre.special_events_preserved.result);

  // Reexecução: nada muda e nenhuma auditoria nova.
  await db.exec(MAINTENANCE);
  assert.equal((await checks(db, POSTCHECK)).audit_rows.result, "4 linha(s), 4 experiência(s)");
  assert.deepEqual(await capacities(db), after);
});

test("experiência já correta não é regravada nem auditada", async () => {
  const db = await productionLikeDatabase();
  await db.query(`update public.experiences set default_capacity = 12 where slug = 'rota-prainha-do-congresso'`);
  const pre = await checks(db, PREFLIGHT);
  assert.deepEqual([pre.to_change.result, pre.already_correct.result], ["3", "1"]);
  await db.exec(MAINTENANCE);
  const post = await checks(db, POSTCHECK);
  assert.equal(post.REMAINING_DEFAULT_CAPACITY_OK.status, "OK");
  assert.equal(post.audit_rows.result, "3 linha(s), 3 experiência(s)");
});

test("valor inesperado interrompe sem gravar nada", async () => {
  const db = await productionLikeDatabase();
  await db.query(`update public.experiences set default_capacity = 30 where slug = 'remada-lua-cheia'`);
  const before = await capacities(db);
  assert.equal((await checks(db, PREFLIGHT)).READY_TO_UPDATE_REMAINING_DEFAULT_CAPACITY.status, "REVIEW_REQUIRED");
  await assertRejects(db.exec(MAINTENANCE), "REMAINING_CAPACITY_UNEXPECTED");
  await db.exec("rollback");
  assert.deepEqual(await capacities(db), before);
});

test("experiência do plano que vire evento interrompe", async () => {
  const db = await productionLikeDatabase();
  await db.query(`update public.experiences set status = 'DRAFT', kind = 'EVENT' where slug = 'remada-lua-cheia'`);
  await assertRejects(db.exec(MAINTENANCE), "REMAINING_CAPACITY_NOT_REGULAR");
  await db.exec("rollback");
});

test("reversão volta exatamente aos valores antigos, com as mesmas proteções", async () => {
  const db = await productionLikeDatabase();
  const original = await capacities(db);
  await db.exec(MAINTENANCE);
  await db.exec(ROLLBACK);
  assert.deepEqual(await capacities(db), original);
  await db.exec(ROLLBACK);
  assert.deepEqual(await capacities(db), original, "reversão repetida não muda nada");
});

test("o script só escreve default_capacity e auditoria — nada de sessões, reservas ou eventos", () => {
  for (const sql of [MAINTENANCE, ROLLBACK]) {
    const writes = sql.match(/\b(update|insert into|delete from)\s+public\.\w+/gi) ?? [];
    assert.deepEqual([...new Set(writes.map((item) => item.toLowerCase().replace(/\s+/g, " ")))].sort(), ["insert into public.admin_audit_log", "update public.experiences"]);
    assert.match(sql, /update public\.experiences set default_capacity = target\.to_capacity where id = target\.id;/);
    assert.match(sql, /begin isolation level repeatable read;/);
    assert.doesNotMatch(sql, /'EVENT'\)|essencia/);
  }
  for (const sql of [PREFLIGHT, POSTCHECK]) assert.doesNotMatch(sql, /\b(update|insert into|delete from)\s+public\./i, "diagnósticos são só leitura");
});
