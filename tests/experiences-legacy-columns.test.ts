/**
 * Experiências — colunas do schema legado na criação (migration 202610310002).
 *
 * Produção tem, em `experiences`, sete colunas editoriais do schema legado
 * (fora do repositório), obrigatórias e sem valor padrão: `eyebrow`,
 * `short_description`, `location`, `cover_image`, `gallery`, `included` e
 * `active`. O banco de teste do repositório não as tem — por isso o cadastro do
 * ESSÊNCIA passou nos testes e falhou em produção (30/10/2026, `23502` em
 * "eyebrow"). Aqui o esquema de produção é reproduzido: a falha acontece sem a
 * migration e o cadastro completo passa com ela.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { eventBookingRejection, loadSessionBookingRules, type RulesQueryClient } from "../lib/events/booking.ts";
import { ESSENCIA_ADMIN_EMAIL } from "../scripts/events/essencia-cadastro-sql.ts";
import { applyMigration, fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";
import { ADMIN, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

const MIGRATION = "202610310002_experiences_legacy_columns_on_insert.sql";
const PREVIOUS = "202610310001_special_events_publication_switch.sql";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const CADASTRO = source("supabase/maintenance/essencia_cadastro.sql");
const CADASTRO_PREFLIGHT = source("supabase/diagnostics/essencia_cadastro_preflight.sql");
const CADASTRO_POSTCHECK = source("supabase/diagnostics/essencia_cadastro_postcheck.sql");
const PREFLIGHT = source("supabase/diagnostics/experiences_legacy_columns_preflight.sql");
const POSTCHECK = source("supabase/diagnostics/experiences_legacy_columns_postcheck.sql");
const ROLLBACK = source("supabase/rollback/202610310002_experiences_legacy_columns_on_insert.rollback.sql");

type Check = { check_name: string; result: string; status: string };

/**
 * As sete colunas como produção as tem: obrigatórias e sem valor padrão. As
 * linhas existentes recebem um valor (como em produção, onde já estão
 * preenchidas) e o padrão é retirado em seguida.
 */
const PRODUCTION_LEGACY_COLUMNS = `
  alter table public.experiences
    add column eyebrow text not null default 'legado',
    add column short_description text not null default 'legado',
    add column location text not null default 'legado',
    add column cover_image text not null default 'legado',
    add column gallery jsonb not null default '[]'::jsonb,
    add column included jsonb not null default '[]'::jsonb,
    add column active boolean not null default true;
  alter table public.experiences
    alter column eyebrow drop default, alter column short_description drop default, alter column location drop default,
    alter column cover_image drop default, alter column gallery drop default, alter column included drop default, alter column active drop default;
`;

async function productionLikeDatabase(until: string = PREVIOUS) {
  const db = await fullDatabase({ until });
  await db.exec(PRODUCTION_LEGACY_COLUMNS);
  const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
  await db.query(`update auth.users set email = $1 where id = $2::uuid`, [ESSENCIA_ADMIN_EMAIL, ADMIN]);
  return { db, fx };
}

async function report(db: { query: (sql: string) => Promise<{ rows: unknown[] }> }, sql: string) {
  return new Map(((await db.query(sql)).rows as Check[]).map((row) => [row.check_name, row]));
}

async function count(db: { query: (sql: string) => Promise<{ rows: unknown[] }> }, sql: string) {
  return Number(((await db.query(sql)).rows[0] as { n: number }).n);
}

test("reproduz a falha de produção: sem a migration, admin_create_event para em \"eyebrow\" e nada fica", async () => {
  const { db } = await productionLikeDatabase();
  // O que foi rodado em produção em 30/10 (sem a guarda nova do roteiro).
  const original = CADASTRO.replace(/ {2}-- Banco com as colunas do schema legado[\s\S]*?end if;\n/, "");
  assert.notEqual(original, CADASTRO);
  await assert.rejects(db.exec(original), (error: Error & { code?: string }) => error.code === "23502" && /eyebrow/.test(error.message));
  await db.exec("rollback").catch(() => undefined);
  assert.equal(await count(db, `select count(*)::int as n from public.experiences where slug = 'essencia'`), 0, "nada parcial");
  assert.equal(await count(db, `select count(*)::int as n from public.experiences where kind = 'EVENT'`), 0);
  assert.equal(await count(db, `select count(*)::int as n from public.admin_audit_log where action in ('EVENT_CREATED', 'EXPERIENCE_CREATED')`), 0);
  // O roteiro atualizado para antes, com a mensagem certa.
  await assert.rejects(db.exec(CADASTRO), /ESSENCIA_LEGADO/);
  await db.exec("rollback").catch(() => undefined);
  assert.equal((await report(db, CADASTRO_PREFLIGHT)).get("COLUNAS_LEGADAS_COBERTAS")?.status, "FALHOU");
  await db.close();
});

test("com a migration: o cadastro completo do ESSÊNCIA passa no esquema de produção — EVENT, rascunho, fechado, nada público", async () => {
  const { db } = await productionLikeDatabase();
  const before = await report(db, PREFLIGHT);
  for (const [name, row] of before) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  assert.equal(before.get("COLUNAS_OBRIGATORIAS_SEM_PADRAO")?.result.includes("eyebrow"), true);
  await applyMigration(db, MIGRATION);
  const after = await report(db, POSTCHECK);
  for (const [name, row] of after) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  for (const key of ["ASSINATURA_DAS_FUNCOES", "EXPERIENCIAS_POR_TIPO_E_STATUS", "RESERVAS_POR_STATUS"]) assert.equal(after.get(key)?.result, before.get(key)?.result, key);

  const pre = await report(db, CADASTRO_PREFLIGHT);
  for (const [name, row] of pre) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  await db.exec(CADASTRO);
  const post = await report(db, CADASTRO_POSTCHECK);
  for (const [name, row] of post) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  assert.equal(post.get("EVENTO_EM_RASCUNHO")?.result, "EVENT/DRAFT na base concha-acustica");
  assert.equal(post.get("SESSAO_FECHADA")?.result, "CLOSED 07/11/2026 05:30 210min 15000 centavos 24 vagas");
  assert.equal(post.get("LIMITE_POR_PEDIDO_E_PRAZO")?.result, "até 6 por pedido; cancelamento até 2026-11-05T12:00:00-03:00");
  for (const key of ["LISTAGENS_REGULARES", "RESERVAS_POR_STATUS", "INSCRICOES_DA_LISTA_POR_STATUS"]) assert.equal(post.get(key)?.result, pre.get(key)?.result, key);

  const row = (await db.query<Row>(`select kind, status, eyebrow, short_description, location, cover_image, gallery, included, active, editorial_content from public.experiences where slug = 'essencia'`)).rows[0];
  assert.deepEqual(
    [row.kind, row.status, row.eyebrow, row.short_description, row.cover_image, row.gallery, row.included, row.active],
    ["EVENT", "DRAFT", "Evento especial · 1ª edição", "Canoa havaiana ao nascer do sol, meditação sensorial e Superioga no Cápsula Bar.", "/images/bases/concha-acustica/concha-hero-nascer-do-sol-desktop.webp", [], [], false],
  );
  assert.ok(String(row.location).length > 0);
  const content = row.editorial_content as { event: { reservation: { maxPerOrder: number; notice: string }; info: { items: Array<{ id: string; body: string }> } } };
  assert.equal(content.event.reservation.maxPerOrder, 6);
  assert.match(content.event.reservation.notice, /Traga seu próprio tapete/);
  assert.match(content.event.info.items.find((item) => item.id === "o-que-levar")!.body, /traga seu próprio tapete/);
  assert.equal(await count(db, `select count(*)::int as n from public.list_public_events()`), 0, "nada público");
  assert.equal(await count(db, `select count(*)::int as n from public.reservations r join public.sessions s on s.id = r.session_id join public.experiences e on e.id = s.experience_id where e.slug = 'essencia'`), 0);

  const client = createPgliteAdmin(db).client as unknown as RulesQueryClient;
  const session = (await db.query<Row>(`select s.id from public.sessions s join public.experiences e on e.id = s.experience_id where e.slug = 'essencia'`)).rows[0].id as string;
  assert.equal(eventBookingRejection(await loadSessionBookingRules(client, session), 1, true)?.code, "EVENT_NOT_PUBLIC", "nem com a venda aberta");
  await db.close();
});

test("valor informado nunca é trocado; experiências existentes não mudam; experiência regular pelo painel também passa", async () => {
  const { db, fx } = await productionLikeDatabase();
  await applyMigration(db, MIGRATION);
  const snapshot = async () => (await db.query(`select id, eyebrow, short_description, location, cover_image, gallery, included, active, kind, status from public.experiences order by id`)).rows;
  const existing = await snapshot();

  const created = await fx.call(
    `public.admin_create_experience($1::uuid, 'remada-teste-legado', 'Remada Teste', 'Uma remada de teste para o legado.', 'DRAFT', null, 0, 'Uma remada de teste para o legado.', 90, 9000, 6, '{}'::jsonb, $2::uuid)`,
    [ADMIN, fx.SUNSET_CONCHA.base_id],
  );
  const regular = (await db.query<Row>(`select kind, eyebrow, short_description, cover_image, active from public.experiences where id = $1::uuid`, [created])).rows[0];
  assert.deepEqual([regular.kind, regular.eyebrow, regular.short_description, regular.cover_image, regular.active], ["REGULAR", "Remada Teste", "Uma remada de teste para o legado.", "", false]);

  await db.query(`insert into public.experiences (slug, title, summary, description, status, display_order, base_id, eyebrow, short_description, location, cover_image, gallery, included, active)
                  values ('valores-proprios', 'Valores', 'Resumo com valores próprios', 'Resumo com valores próprios', 'DRAFT', 0, $1::uuid, 'Meu eyebrow', 'Minha descrição', 'Meu local', '/x.webp', '["a"]'::jsonb, '["b"]'::jsonb, true)`, [fx.SUNSET_CONCHA.base_id]);
  const own = (await db.query<Row>(`select eyebrow, short_description, location, cover_image, gallery, included, active from public.experiences where slug = 'valores-proprios'`)).rows[0];
  assert.deepEqual(own, { eyebrow: "Meu eyebrow", short_description: "Minha descrição", location: "Meu local", cover_image: "/x.webp", gallery: ["a"], included: ["b"], active: true });

  const after = (await snapshot()).filter((row) => existing.some((old) => (old as Row).id === (row as Row).id));
  assert.deepEqual(after, existing, "linhas existentes intactas");
  await db.close();
});

test("banco sem colunas legadas (o do repositório): o gatilho não faz nada e o cadastro passa igual", async () => {
  const db = await fullDatabase();
  await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
  await db.query(`update auth.users set email = $1 where id = $2::uuid`, [ESSENCIA_ADMIN_EMAIL, ADMIN]);
  assert.equal(await count(db, `select count(*)::int as n from pg_trigger where tgname = 'experiences_fill_legacy_columns'`), 1);
  await db.exec(CADASTRO);
  assert.equal((await report(db, CADASTRO_POSTCHECK)).get("ESSENCIA_CADASTRO_POSTCHECK_OK")?.status, "OK");
  await db.close();
});

test("migration: aditiva — nenhuma função existente muda, só uma função e um gatilho novos, nada pela API", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  const snapshot = async () => (await before.query<{ name: string; src: string }>(`select p.oid::regprocedure::text as name, md5(p.prosrc) as src from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`)).rows;
  const old = await snapshot();
  await applyMigration(before, MIGRATION);
  await applyMigration(before, MIGRATION);
  const current = await snapshot();
  for (const row of old) assert.equal(current.find((item) => item.name === row.name)?.src, row.src, row.name);
  assert.deepEqual(current.filter((row) => !old.some((item) => item.name === row.name)).map((row) => row.name), ["experiences_fill_legacy_columns()"]);
  const migration = source(`supabase/migrations/${MIGRATION}`).split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
  assert.doesNotMatch(migration, /(insert into|update|delete from) public\./i);
  assert.doesNotMatch(migration, /alter table|drop constraint|drop not null|set default|cron\.|create extension/i);
  await before.close();
});

test("preflight reprova coluna obrigatória que nem o painel nem o gatilho preenchem", async () => {
  const { db } = await productionLikeDatabase();
  await db.exec(`alter table public.experiences add column coluna_surpresa text not null default 'x'; alter table public.experiences alter column coluna_surpresa drop default;`);
  const pre = await report(db, PREFLIGHT);
  assert.equal(pre.get("COLUNAS_OBRIGATORIAS_SEM_PADRAO")?.status, "FALHOU");
  assert.match(pre.get("COLUNAS_OBRIGATORIAS_SEM_PADRAO")!.result, /coluna_surpresa/);
  await db.close();
});

test("rollback: remove só o gatilho e a função; reaplicar devolve tudo", async () => {
  const { db } = await productionLikeDatabase();
  await applyMigration(db, MIGRATION);
  await db.exec(ROLLBACK);
  assert.equal(await count(db, `select count(*)::int as n from pg_trigger where tgname = 'experiences_fill_legacy_columns'`), 0);
  assert.equal(await count(db, `select count(*)::int as n from pg_proc where proname = 'experiences_fill_legacy_columns'`), 0);
  await applyMigration(db, MIGRATION);
  assert.equal((await report(db, POSTCHECK)).get("EXPERIENCIAS_LEGADO_POSTCHECK_OK")?.status, "OK");
  await db.close();
});
