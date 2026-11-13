/**
 * Atualização do conteúdo do ESSÊNCIA já publicado, com a sessão aberta e reservas
 * reais. Os scripts rodam como estão no repositório, sobre o esquema de produção: só o
 * conteúdo muda; sessão, reservas, pagamentos e regulares ficam iguais, e a compra continua.
 */

// Primeiro import: o relógio precisa estar no lugar antes de qualquer banco.
import "./support/essencia-clock.ts";

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { eventBookingContext } from "../lib/events/booking.ts";
import { validateEventEditorial } from "../lib/events/editorial.ts";
import { isEventEmailReady } from "../lib/events/email-readiness.ts";
import { ESSENCIA_EDITORIAL, essenciaDemoEvent } from "../lib/events/fixtures/essencia.ts";
import { ESSENCIA_ADMIN_EMAIL } from "../scripts/events/essencia-cadastro-sql.ts";
import {
  publicadoPostcheckSql,
  publicadoPreflightSql,
  publicadoRollbackSql,
  publicadoUpdateSql,
} from "../scripts/events/essencia-editorial-publicado-sql.ts";
import { applyMigration, fullDatabase } from "./support/full-database.ts";
import { PRODUCTION_ONLY } from "./support/production-only-schema.ts";
import { ADMIN, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const PREFLIGHT = source("supabase/diagnostics/essencia_editorial_publicado_preflight.sql");
const UPDATE = source("supabase/maintenance/essencia_editorial_publicado_update.sql");
const POSTCHECK = source("supabase/diagnostics/essencia_editorial_publicado_postcheck.sql");
const ROLLBACK = source("supabase/rollback/essencia_editorial_publicado_update.rollback.sql");
const V2 = JSON.parse(source("scripts/events/essencia-editorial-v2.json"));

type Check = { check_name: string; result: string; status: string };

/** Como em produção: publicado na versão anterior, sessão aberta, reserva paga. */
async function published() {
  const db = await fullDatabase({ until: "202610310003_experiences_active_on_insert.sql" });
  await db.exec(PRODUCTION_ONLY);
  await applyMigration(db, "202610310004_event_publication_security.sql");
  const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
  await db.query(`update auth.users set email = $1 where id = $2::uuid`, [ESSENCIA_ADMIN_EMAIL, ADMIN]);
  await db.exec(source("supabase/maintenance/essencia_cadastro.sql"));
  await db.query(`update public.experiences set editorial_content = $1::jsonb where slug = 'essencia'`, [JSON.stringify(V2)]);
  await db.exec(`update public.special_event_settings set publication_enabled = true`);
  await db.exec(`update public.experiences set status = 'PUBLISHED' where slug = 'essencia'`);
  await db.exec(`update public.sessions set status = 'OPEN' where experience_id = (select id from public.experiences where slug = 'essencia')`);
  const session = (await db.query<Row>(`select s.id from public.sessions s join public.experiences e on e.id = s.experience_id where e.slug = 'essencia'`)).rows[0].id as string;
  const paid = await fx.reserve(session, 1);
  return { db, fx, session, paid };
}

type Db = Awaited<ReturnType<typeof published>>["db"];

async function report(db: Db, sql: string) {
  return new Map((await db.query<Check>(sql)).rows.map((row) => [row.check_name, row]));
}

const experience = async (db: Db) => (await db.query<Row>(`select editorial_content, status, title, summary, image_url, display_order, base_id, kind from public.experiences where slug = 'essencia'`)).rows[0];
const sessionRow = async (db: Db, id: string) => (await db.query<Row>(`select * from public.sessions where id = $1::uuid`, [id])).rows[0];
const reservationRows = async (db: Db, id: string) => (await db.query<Row>(`select * from public.reservations where session_id = $1::uuid order by id`, [id])).rows;
const paymentRows = async (db: Db) => (await db.query<Row>(`select * from public.payment_events order by id`)).rows;
const regular = async (db: Db) => (await db.query<Row>(`select * from public.list_public_regular_catalog()`)).rows;

test("textos aprovados: responsáveis, encerramento, incluso e nenhuma menção ao nome antigo", () => {
  const result = validateEventEditorial(ESSENCIA_EDITORIAL);
  assert.ok(result.success);
  const event = result.data.event;
  const [canoe, meditation, yoga, closing] = event.program.items;
  assert.deepEqual([canoe.title, canoe.time], ["Canoa havaiana ao nascer do sol", "05:30"]);
  assert.deepEqual([meditation.title, meditation.timeLabel, meditation.hosts], ["Meditação sensorial e aromaterapia", "Por volta das 07h30", ["Fernanda Garcia"]]);
  assert.equal(meditation.description, "Um momento para desacelerar, respirar e se conectar com o presente, acompanhado por uma experiência sensorial com óleos essenciais.");
  assert.deepEqual([yoga.title, yoga.hosts], ["Superioga", ["Rapha Dantas"]]);
  assert.deepEqual([closing.title, closing.timeLabel], ["Encerramento com lanche saudável", "Por volta das 09h"]);
  assert.equal(closing.description, "Para fechar nossa manhã, um momento de integração e troca de experiências, acompanhado de um lanche saudável oferecido pela Nutre.");
  assert.deepEqual(event.included.items, ["Canoa havaiana ao nascer do sol", "Meditação sensorial com aromaterapia", "Superioga", "Momento de integração e troca de experiências", "Lanche saudável da Nutre"]);
  assert.doesNotMatch(JSON.stringify(ESSENCIA_EDITORIAL), /Happy Hour/);
  assert.ok(isEventEmailReady(event), "o e-mail do evento continua completo");
  assert.ok(eventBookingContext(essenciaDemoEvent()).program.some((item) => item.title === "Encerramento com lanche saudável"));
});

test("cards: logo, nome e descrição; Rapha com a Superioga, Fernanda com o Cure-se Bem, ordem preservada", () => {
  const result = validateEventEditorial(ESSENCIA_EDITORIAL);
  assert.ok(result.success);
  const partners = result.data.event.partners.items;
  assert.deepEqual(partners.map((item) => item.name), ["Cure-se Bem", "Alma Azul Academy", "Cápsula Bar", "Rapha Dantas", "Fernanda Garcia", "Nutre"]);
  const by = (name: string) => partners.find((item) => item.name === name);
  assert.deepEqual([by("Rapha Dantas")?.role, by("Rapha Dantas")?.logo?.src], ["Superioga", "/images/eventos/essencia/logo-superioga-rapha-dantas.jpg"]);
  assert.deepEqual([by("Fernanda Garcia")?.role, by("Fernanda Garcia")?.logo?.src], ["Meditação sensorial e aromaterapia com óleos essenciais", by("Cure-se Bem")?.logo?.src]);
  for (const partner of partners) assert.ok(partner.logo && existsSync(new URL(`../public${partner.logo.src}`, import.meta.url)), partner.name);
  const page = source("components/events/event-page.tsx");
  assert.ok(page.indexOf("partner.logo ?") < page.indexOf("{partner.name}</p>"), "logo acima do nome");
  assert.match(page, /object-contain/);
});

test("os arquivos são os gerados; a atualização não mexe em sessão, reserva, interruptor nem status", () => {
  assert.equal(PREFLIGHT, publicadoPreflightSql(), "rode pnpm events:essencia-editorial-publicado-sql");
  assert.equal(UPDATE, publicadoUpdateSql());
  assert.equal(POSTCHECK, publicadoPostcheckSql());
  assert.equal(ROLLBACK, publicadoRollbackSql());
  for (const sql of [UPDATE, ROLLBACK]) {
    const code = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    assert.doesNotMatch(code, /'DRAFT'|update public\.|insert into|delete from|publication_enabled\s*=\s*(true|false)\s*,/i);
    assert.match(code, /for no key update/, "não bloqueia reserva em andamento");
    assert.match(code, /admin_update_event\(actor, target\.id, target\.title, target\.summary, 'PUBLISHED'/);
  }
  for (const sql of [PREFLIGHT, POSTCHECK]) assert.doesNotMatch(sql, /\b(insert into|delete from|commit;|update public\.)/i);
});

test("com reserva paga e sessão aberta: só o conteúdo muda e a compra continua", async () => {
  const { db, fx, session } = await published();
  const before = { session: await sessionRow(db, session), reservations: await reservationRows(db, session), payments: await paymentRows(db), regular: await regular(db), event: await experience(db) };
  const pre = await report(db, PREFLIGHT);
  for (const [name, row] of pre) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  assert.match(pre.get("RESERVAS_DO_EVENTO")!.result, /CONFIRMED=1; 23 vagas/);

  await db.exec(UPDATE);

  const post = await report(db, POSTCHECK);
  for (const [name, row] of post) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  for (const key of ["ASSINATURA_DAS_FUNCOES", "LISTAGENS_REGULARES", "SESSAO", "RESERVAS_DO_EVENTO", "LEITURA_PUBLICA"]) assert.equal(post.get(key)?.result, pre.get(key)?.result, key);
  assert.deepEqual(await sessionRow(db, session), before.session);
  assert.deepEqual(await reservationRows(db, session), before.reservations);
  assert.deepEqual(await paymentRows(db), before.payments);
  assert.deepEqual(await regular(db), before.regular);
  const after = await experience(db);
  assert.deepEqual(after.editorial_content, ESSENCIA_EDITORIAL);
  assert.deepEqual({ ...after, editorial_content: null }, { ...before.event, editorial_content: null });
  assert.equal((await db.query<Row>(`select count(*)::int as n from public.admin_audit_log where action = 'EVENT_UPDATED'`)).rows[0].n, 1, "fica na auditoria");
  assert.equal((await db.query<Row>(`select status from public.get_public_event('essencia') e, public.experiences x where x.slug = e.slug`)).rows[0].status, "PUBLISHED");

  const next = await fx.reserve(session, 2);
  assert.equal((await db.query<Row>(`select status::text as s from public.reservations where id = $1::uuid`, [next.id])).rows[0].s, "CONFIRMED", "venda segue depois da atualização");
  assert.equal((await db.query<Row>(`select public.available_spots($1::uuid) as n`, [session])).rows[0].n, 21);
  await db.close();
});

test("rollback devolve exatamente a versão anterior, com evento publicado e reservas intactas", async () => {
  const { db, session } = await published();
  const reservations = await reservationRows(db, session);
  await db.exec(UPDATE);
  assert.equal((await report(db, PREFLIGHT)).get("CONTEUDO_DE_ORIGEM")?.status, "ATENCAO", "já atualizado");
  await assert.rejects(db.exec(UPDATE), /ESSENCIA_PUBLICADO_CONTEUDO/, "não reaplica");
  await db.exec("rollback");
  await db.exec(ROLLBACK);
  const back = await experience(db);
  assert.deepEqual(back.editorial_content, V2);
  assert.equal(back.status, "PUBLISHED");
  assert.deepEqual(await reservationRows(db, session), reservations);
  assert.equal((await report(db, PREFLIGHT)).get("ESSENCIA_PUBLICADO_PREFLIGHT_OK")?.status, "OK");
  await assert.rejects(db.exec(ROLLBACK), /ESSENCIA_PUBLICADO_DESFAZER_CONTEUDO/);
  await db.exec("rollback");
  await db.close();
});

test("recusa estados inesperados sem mudar nada; sessão fechada pela operação é aceita e preservada", async () => {
  const cases: Array<[string, RegExp]> = [
    [`update public.experiences set status = 'DRAFT' where slug = 'essencia'`, /ESSENCIA_PUBLICADO_ESTADO/],
    [`update public.experiences set editorial_content = editorial_content || '{"x":1}'::jsonb where slug = 'essencia'`, /ESSENCIA_PUBLICADO_CONTEUDO/],
    [`update public.special_event_settings set publication_enabled = false`, /ESSENCIA_PUBLICADO_INTERRUPTOR/],
    [`update public.sessions set capacity = 30 where experience_id = (select id from public.experiences where slug = 'essencia')`, /ESSENCIA_PUBLICADO_SESSAO/],
  ];
  for (const [change, error] of cases) {
    const { db } = await published();
    await db.exec(change);
    assert.equal((await report(db, PREFLIGHT)).get("ESSENCIA_PUBLICADO_PREFLIGHT_OK")?.status, "FALHOU", change);
    await assert.rejects(db.exec(UPDATE), error, change);
    await db.exec("rollback");
    await db.close();
  }
  const { db, session } = await published();
  await db.query(`update public.sessions set status = 'CLOSED' where id = $1::uuid`, [session]);
  assert.equal((await report(db, PREFLIGHT)).get("SESSAO")?.status, "ATENCAO");
  await db.exec(UPDATE);
  assert.equal((await sessionRow(db, session)).status, "CLOSED");
  await db.close();
});
