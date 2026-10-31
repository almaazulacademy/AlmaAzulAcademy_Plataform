/**
 * Programação fluida do ESSÊNCIA, decidida em 31/10/2026: nenhum ponto anuncia
 * "até 09h" e a atualização do rascunho já cadastrado troca só o conteúdo. A sessão
 * técnica continua com 210 minutos, preço, vagas e status de antes.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { eventBookingContext } from "../lib/events/booking.ts";
import { validateEventEditorial } from "../lib/events/editorial.ts";
import { ESSENCIA_EDITORIAL, essenciaDemoEvent } from "../lib/events/fixtures/essencia.ts";
import { eventScheduleLabel, programItemTime } from "../lib/events/presentation.ts";
import { eventTimes } from "../lib/reservations/event-email.ts";
import { ESSENCIA_ADMIN_EMAIL } from "../scripts/events/essencia-cadastro-sql.ts";
import {
  editorialPostcheckSql,
  editorialPreflightSql,
  editorialRollbackSql,
  editorialUpdateSql,
} from "../scripts/events/essencia-editorial-sql.ts";
import { publicacaoPreflightSql, publicacaoSql } from "../scripts/events/essencia-publicacao-sql.ts";
import { applyMigration, fullDatabase } from "./support/full-database.ts";
import { PRODUCTION_ONLY } from "./support/production-only-schema.ts";
import { ADMIN, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const PREFLIGHT = source("supabase/diagnostics/essencia_editorial_preflight.sql");
const UPDATE = source("supabase/maintenance/essencia_editorial_update.sql");
const POSTCHECK = source("supabase/diagnostics/essencia_editorial_postcheck.sql");
const ROLLBACK = source("supabase/rollback/essencia_editorial_update.rollback.sql");
const V1 = JSON.parse(source("scripts/events/essencia-editorial-v1.json"));
const CONTENT = JSON.stringify(ESSENCIA_EDITORIAL);

type Check = { check_name: string; result: string; status: string };

/** Como está em produção: cadastrado com a versão anterior. */
async function registeredWithV1() {
  const db = await fullDatabase({ until: "202610310003_experiences_active_on_insert.sql" });
  await db.exec(PRODUCTION_ONLY);
  await applyMigration(db, "202610310004_event_publication_security.sql");
  await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
  await db.query(`update auth.users set email = $1 where id = $2::uuid`, [ESSENCIA_ADMIN_EMAIL, ADMIN]);
  await db.exec(source("supabase/maintenance/essencia_cadastro.sql"));
  await db.query(`update public.experiences set editorial_content = $1::jsonb where slug = 'essencia'`, [JSON.stringify(V1)]);
  return db;
}

type Db = Awaited<ReturnType<typeof registeredWithV1>>;

async function report(db: Db, sql: string) {
  return new Map((await db.query<Check>(sql)).rows.map((row) => [row.check_name, row]));
}

const sessionOf = async (db: Db) => (await db.query<Row>(`select s.* from public.sessions s join public.experiences e on e.id = s.experience_id where e.slug = 'essencia'`)).rows;
const contentOf = async (db: Db) => (await db.query<Row>(`select editorial_content, status, title, summary, image_url, display_order from public.experiences where slug = 'essencia'`)).rows[0];

test("programação como decidida: início fixo só na canoa, referências flexíveis no resto", () => {
  const editorial = validateEventEditorial(ESSENCIA_EDITORIAL);
  assert.ok(editorial.success);
  const items = editorial.data.event.program.items;
  assert.deepEqual(items.map((item) => [programItemTime(item), item.title]), [
    ["05h30", "Canoa havaiana ao nascer do sol"],
    ["Por volta das 07h30", "Meditação sensorial e aromaterapia"],
    ["Na sequência", "Superioga"],
    ["Por volta das 09h", "Happy Hour de Conexões"],
  ]);
  assert.deepEqual(items.map((item) => item.hosts), [["Alma Azul Academy"], ["Rapha Dantas", "Fernanda Garcia"], ["Rapha Dantas"], []]);
  assert.match(items[1].description, /aromaterapia com óleos essenciais, com a participação de Fernanda Garcia/);
  assert.equal(items[2].time, null);
});

test("nenhum texto anuncia fim às 09h nem usa os nomes antigos; lanche segue incluso", () => {
  assert.doesNotMatch(CONTENT, /às 09h|até 09h|Congelados|Refeições|Encerramento/);
  assert.match(CONTENT, /aproximadamente entre 08h30 e 09h/);
  const included = validateEventEditorial(ESSENCIA_EDITORIAL);
  assert.ok(included.success);
  assert.ok(included.data.event.included.items.includes("Lanche saudável da Nutre"));
  assert.ok(included.data.event.included.items.includes("Happy Hour de Conexões"));
  const partners = included.data.event.partners.items.map((item) => [item.name, item.role]);
  assert.ok(partners.some(([name, role]) => name === "Fernanda Garcia" && /aromaterapia com óleos essenciais · Cure-se Bem/.test(role ?? "")));
  assert.ok(partners.some(([name, role]) => name === "Rapha Dantas" && role === "Superioga e meditação sensorial"));
  assert.ok(partners.some(([name]) => name === "Nutre"));
});

test("página, reserva e e-mail: sem horário final, com a duração técnica de 210 minutos", () => {
  const event = essenciaDemoEvent("CLOSED");
  assert.equal(event.session.durationMinutes, 210);
  const context = eventBookingContext(event);
  assert.equal(context.timeRange, "A PARTIR DAS 05H30");
  assert.equal(context.program[2].time, "Na sequência");
  assert.ok(event.session.startsAt);
  const times = eventTimes({ startsAt: event.session.startsAt, durationMinutes: 210 } as never, event.editorial.event);
  assert.equal(times.end, null, "sem 'Encerramento previsto'");
  assert.equal(times.start, "05h30");
  assert.equal(times.tolerance, "05h50");
  const noLabel = eventTimes({ startsAt: event.session.startsAt, durationMinutes: 210 } as never, { ...event.editorial.event, scheduleLabel: null });
  assert.equal(noLabel.end, "09h00", "evento sem rótulo continua com o fim calculado");
});

test("evento sem os campos novos continua igual: intervalo calculado e horário obrigatório", () => {
  assert.equal(eventScheduleLabel(null, "2026-11-07T08:30:00.000Z", 210), "05H30 ÀS 09H");
  assert.equal(programItemTime({ time: "07:45", timeLabel: null }), "07h45");
  const legacy = validateEventEditorial(V1);
  assert.ok(legacy.success, "a versão anterior continua válida");
  assert.equal(legacy.data.event.scheduleLabel, null);
  const content = JSON.parse(CONTENT);
  delete content.event.program.items[2].timeLabel;
  const invalid = validateEventEditorial(content);
  assert.ok(!invalid.success);
  assert.ok(invalid.errors.some((error) => /Horário 3/.test(error)));
});

test("os arquivos são os gerados; a atualização não abre, não publica e não mexe na sessão", () => {
  assert.equal(PREFLIGHT, editorialPreflightSql(), "rode pnpm events:essencia-editorial-sql");
  assert.equal(UPDATE, editorialUpdateSql());
  assert.equal(POSTCHECK, editorialPostcheckSql());
  assert.equal(ROLLBACK, editorialRollbackSql());
  for (const sql of [UPDATE, ROLLBACK]) {
    const code = sql.split("\n").filter((line) => !line.startsWith("--")).join("\n");
    assert.doesNotMatch(code, /'PUBLISHED'|publication_enabled = true|update public\.sessions|insert into|delete from/i);
  }
  for (const sql of [PREFLIGHT, POSTCHECK]) assert.doesNotMatch(sql, /\b(insert into|delete from|commit;)/i);
});

test("preflight → atualização → postcheck: só o conteúdo muda; depois, a publicação aceita", async () => {
  const db = await registeredWithV1();
  const before = { session: await sessionOf(db), event: await contentOf(db) };
  const pre = await report(db, PREFLIGHT);
  for (const [name, row] of pre) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  await db.exec(UPDATE);
  const post = await report(db, POSTCHECK);
  for (const [name, row] of post) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  for (const key of ["ASSINATURA_DAS_FUNCOES", "LISTAGENS_REGULARES", "RESERVAS_POR_STATUS", "SESSAO_INALTERADA"]) assert.equal(post.get(key)?.result, pre.get(key)?.result, key);
  assert.deepEqual(await sessionOf(db), before.session);
  const after = await contentOf(db);
  assert.deepEqual(after.editorial_content, ESSENCIA_EDITORIAL);
  assert.deepEqual({ ...after, editorial_content: null }, { ...before.event, editorial_content: null });
  assert.equal(after.status, "DRAFT");
  assert.equal((await db.query(`select 1 from public.get_public_event('essencia')`)).rows.length, 0, "continua fora do ar");
  assert.equal((await report(db, publicacaoPreflightSql())).get("ESSENCIA_PUBLICACAO_PREFLIGHT_OK")?.status, "OK");
  await db.exec(publicacaoSql());
  assert.equal((await contentOf(db)).status, "PUBLISHED");
  await db.close();
});

test("a publicação recusa o conteúdo anterior: não dá para pular a atualização", async () => {
  const db = await registeredWithV1();
  assert.equal((await report(db, publicacaoPreflightSql())).get("ESSENCIA_PUBLICACAO_PREFLIGHT_OK")?.status, "FALHOU");
  await assert.rejects(db.exec(publicacaoSql()), /ESSENCIA_CONTEUDO/);
  await db.exec("rollback");
  assert.equal((await contentOf(db)).status, "DRAFT");
  await db.close();
});

test("rollback devolve exatamente a versão anterior; recusa depois de publicado", async () => {
  const db = await registeredWithV1();
  const session = await sessionOf(db);
  await db.exec(UPDATE);
  assert.equal((await report(db, PREFLIGHT)).get("CONTEUDO_DE_ORIGEM")?.status, "ATENCAO", "já atualizado");
  await assert.rejects(db.exec(UPDATE), /ESSENCIA_EDITORIAL_CONTEUDO/, "não reaplica");
  await db.exec("rollback");
  await db.exec(ROLLBACK);
  assert.deepEqual((await contentOf(db)).editorial_content, V1);
  assert.deepEqual(await sessionOf(db), session);
  for (const [name, row] of await report(db, PREFLIGHT)) assert.equal(row.status, "OK", name);

  await db.exec(UPDATE);
  await db.exec(publicacaoSql());
  await assert.rejects(db.exec(ROLLBACK), /ESSENCIA_EDITORIAL_DESFAZER_ESTADO/);
  await db.exec("rollback");
  assert.equal((await contentOf(db)).status, "PUBLISHED");
  await db.close();
});

test("atualização recusa estados inesperados, sem mudar nada", async () => {
  const cases: Array<[string, RegExp]> = [
    [`update public.special_event_settings set publication_enabled = true`, /ESSENCIA_EDITORIAL_INTERRUPTOR/],
    [`update public.sessions set status = 'OPEN' where experience_id = (select id from public.experiences where slug = 'essencia')`, /ESSENCIA_EDITORIAL_SESSAO/],
    [`update public.sessions set duration_minutes = 240 where experience_id = (select id from public.experiences where slug = 'essencia')`, /ESSENCIA_EDITORIAL_SESSAO/],
    [`update public.experiences set editorial_content = editorial_content || '{"x":1}'::jsonb where slug = 'essencia'`, /ESSENCIA_EDITORIAL_CONTEUDO/],
  ];
  for (const [change, error] of cases) {
    const db = await registeredWithV1();
    await db.exec(change);
    await assert.rejects(db.exec(UPDATE), error, change);
    await db.exec("rollback");
    await db.close();
  }
});
