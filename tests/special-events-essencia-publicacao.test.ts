/**
 * Roteiro de publicação do ESSÊNCIA sem vendas. Os scripts rodam como estão no
 * repositório, sobre o cadastro real e o esquema de produção: o evento fica
 * legível, a sessão continua CLOSED, nenhum caminho reserva e as regulares não mudam.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { eventBookingRejection, loadSessionBookingRules, type RulesQueryClient } from "../lib/events/booking.ts";
import { ESSENCIA_EDITORIAL } from "../lib/events/fixtures/essencia.ts";
import { isEventBookingOpen, isEventsWaitlistEnabled } from "../lib/events/flags.ts";
import { ESSENCIA_ADMIN_EMAIL } from "../scripts/events/essencia-cadastro-sql.ts";
import {
  publicacaoAnonCheckSql,
  publicacaoPostcheckSql,
  publicacaoPreflightSql,
  publicacaoRollbackSql,
  publicacaoSql,
} from "../scripts/events/essencia-publicacao-sql.ts";
import { applyMigration, fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";
import { PRODUCTION_ONLY } from "./support/production-only-schema.ts";
import { ADMIN, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const CADASTRO = source("supabase/maintenance/essencia_cadastro.sql");
const PREFLIGHT = source("supabase/diagnostics/essencia_publicacao_preflight.sql");
const PUBLISH = source("supabase/maintenance/essencia_publicacao.sql");
const POSTCHECK = source("supabase/diagnostics/essencia_publicacao_postcheck.sql");
const ANON = source("supabase/diagnostics/essencia_publicacao_anon_check.sql");
const ROLLBACK = source("supabase/rollback/essencia_publicacao.rollback.sql");

type Check = { check_name: string; result: string; status: string };

async function registered() {
  // A ordem de produção: o esquema legado já existia quando a 202610310004 revogou create_reservation.
  const db = await fullDatabase({ until: "202610310003_experiences_active_on_insert.sql" });
  await db.exec(PRODUCTION_ONLY);
  await applyMigration(db, "202610310004_event_publication_security.sql");
  const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
  await db.query(`update auth.users set email = $1 where id = $2::uuid`, [ESSENCIA_ADMIN_EMAIL, ADMIN]);
  await db.exec(CADASTRO);
  const session = (await db.query<Row>(`select s.id from public.sessions s join public.experiences e on e.id = s.experience_id where e.slug = 'essencia'`)).rows[0].id as string;
  return { db, fx, session };
}

type Db = Awaited<ReturnType<typeof registered>>["db"];

async function report(db: Db, sql: string) {
  return new Map(((await db.query<Check>(sql)).rows).map((row) => [row.check_name, row]));
}

function allOk(checks: Map<string, Check>) {
  for (const [name, row] of checks) assert.equal(row.status, "OK", `${name}: ${row.result}`);
}

const EQUAL = ["ASSINATURA_DAS_FUNCOES", "LISTAGENS_REGULARES", "RESERVAS_POR_STATUS", "INSCRICOES_DA_LISTA_POR_STATUS", "SESSAO_FECHADA", "CONTEUDO_EDITORIAL_APROVADO"];

test("os arquivos do repositório são os gerados; nada abre sessão nem toca variável", () => {
  assert.equal(PREFLIGHT, publicacaoPreflightSql(), "rode pnpm events:essencia-publicacao-sql");
  assert.equal(PUBLISH, publicacaoSql());
  assert.equal(POSTCHECK, publicacaoPostcheckSql());
  assert.equal(ANON, publicacaoAnonCheckSql());
  assert.equal(ROLLBACK, publicacaoRollbackSql());
  const code = PUBLISH.split("\n").filter((line) => !line.startsWith("--")).join("\n");
  assert.doesNotMatch(code, /status\s*=\s*'OPEN'|update public\.sessions|insert into|delete from/i);
  for (const sql of [PREFLIGHT, POSTCHECK, ANON]) assert.doesNotMatch(sql.split("\n").filter((line) => !line.startsWith("--")).join("\n"), /\b(update|insert into|delete from|commit)\b/i);
});

test("preflight → publicação → postcheck: evento legível, sessão CLOSED, regulares idênticas", async () => {
  const { db } = await registered();
  const pre = await report(db, PREFLIGHT);
  allOk(pre);
  await db.exec(PUBLISH);
  const post = await report(db, POSTCHECK);
  allOk(post);
  for (const key of EQUAL) assert.equal(post.get(key)?.result, pre.get(key)?.result, key);
  assert.match(post.get("SEM_CAMINHO_DE_RESERVA")!.result, /^0 /);
  assert.match(post.get("LEITURA_DO_EVENTO")!.result, /^1 evento/);
  assert.equal((await report(db, PREFLIGHT)).get("ESSENCIA_PUBLICACAO_PREFLIGHT_OK")?.status, "FALHOU", "já publicado");
  await assert.rejects(db.exec(PUBLISH), /ESSENCIA_ESTADO/);
  await db.exec("rollback");
  await db.close();
});

test("conferência como anon: evento visível, nada para reservar, regulares visíveis", async () => {
  const { db } = await registered();
  await db.exec(PUBLISH);
  const before = (await db.query<Row>(`select count(*)::int as n from public.experiences where kind = 'REGULAR' and status = 'PUBLISHED'`)).rows[0].n;
  await db.exec("begin");
  const results = await db.exec(ANON);
  await db.exec("rollback");
  const row = results.at(-1)!.rows[0] as Row;
  assert.equal(Number(row.evento_visivel), 1);
  assert.equal(Number(row.sessao_aberta_visivel), 0);
  assert.equal(Number(row.regulares_visiveis), before);
  assert.equal(row.pode_pre_reservar, false);
  assert.equal(row.create_reservation_executavel, false);
  await db.close();
});

test("publicado e sem variáveis: nenhum papel reserva nem entra na lista", async () => {
  const { db, session } = await registered();
  await db.exec(PUBLISH);
  const reserve = `select public.create_pre_reservation($1::uuid, 'Pessoa Teste', '52998224725', '+5561988887777', 'p@teste.local', 1, null, gen_random_uuid())`;
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    await assert.rejects(db.query(reserve, [session]), /permission denied/, role);
    await assert.rejects(db.query(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [session]), /permission denied/, role);
    await db.exec("reset role");
  }
  await db.exec("set role service_role");
  await assert.rejects(db.query(reserve, [session]), /SESSION|UNAVAILABLE|CLOSED/i, "sessão CLOSED recusa no banco");
  await db.exec("reset role");
  assert.equal((await db.query(`select 1 from public.reservations where session_id = $1::uuid`, [session])).rows.length, 0);

  const env = {};
  assert.equal(isEventBookingOpen(env), false);
  assert.equal(isEventsWaitlistEnabled(env), false);
  assert.equal(isEventBookingOpen({ EVENTS_PUBLIC_ENABLED: "true" }), false, "EVENTS_PUBLIC_ENABLED sozinha não abre venda");
  assert.equal(isEventsWaitlistEnabled({ EVENTS_PUBLIC_ENABLED: "true", EVENTS_WAITLIST_ENABLED: "true" }), false);

  const client = createPgliteAdmin(db).client as unknown as RulesQueryClient;
  const rules = await loadSessionBookingRules(client, session);
  assert.equal(eventBookingRejection(rules, 1, false)?.code, "EVENT_BOOKING_CLOSED", "a API recusa mesmo que alguém abra a sessão");
  await db.close();
});

test("desfazer: volta a rascunho e interruptor desligado, some das leituras; recusa com sessão aberta", async () => {
  const { db, session } = await registered();
  const pre = await report(db, PREFLIGHT);
  await db.exec(PUBLISH);
  await db.exec(ROLLBACK);
  const again = await report(db, PREFLIGHT);
  allOk(again);
  for (const key of EQUAL) assert.equal(again.get(key)?.result, pre.get(key)?.result, key);
  assert.equal((await db.query(`select 1 from public.get_public_event('essencia')`)).rows.length, 0);

  await db.exec(PUBLISH);
  await db.query(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [session]);
  await assert.rejects(db.exec(ROLLBACK), /ESSENCIA_DESFAZER_RECUSADO/);
  await db.exec("rollback");
  assert.equal((await db.query<Row>(`select status from public.experiences where slug = 'essencia'`)).rows[0].status, "PUBLISHED");
  await db.close();
});

test("publicação recusa conteúdo alterado, interruptor ligado e sessão aberta, sem mudar nada", async () => {
  const cases: Array<[string, string, RegExp]> = [
    ["conteúdo", `update public.experiences set editorial_content = editorial_content || '{"x":1}'::jsonb where slug = 'essencia'`, /ESSENCIA_CONTEUDO/],
    ["interruptor", `update public.special_event_settings set publication_enabled = true`, /ESSENCIA_INTERRUPTOR/],
    ["sessão", `update public.sessions set status = 'OPEN' where experience_id = (select id from public.experiences where slug = 'essencia')`, /ESSENCIA_SESSAO/],
  ];
  for (const [label, change, error] of cases) {
    const { db } = await registered();
    await db.exec(change);
    assert.equal((await report(db, PREFLIGHT)).get("ESSENCIA_PUBLICACAO_PREFLIGHT_OK")?.status, "FALHOU", label);
    await assert.rejects(db.exec(PUBLISH), error, label);
    await db.exec("rollback");
    assert.equal((await db.query<Row>(`select status from public.experiences where slug = 'essencia'`)).rows[0].status, "DRAFT", label);
    await db.close();
  }
});

test("toda imagem do conteúdo aprovado existe no repositório", () => {
  const paths = [...new Set(JSON.stringify(ESSENCIA_EDITORIAL).match(/\/images\/[^"]+/g) ?? [])];
  assert.ok(paths.length > 0);
  for (const path of paths) assert.ok(existsSync(new URL(`../public${path}`, import.meta.url)), path);
});
