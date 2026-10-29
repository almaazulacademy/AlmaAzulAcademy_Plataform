/**
 * Roteiro de cadastro do ESSÊNCIA em estado fechado.
 *
 * Os quatro scripts (`supabase/maintenance/essencia_cadastro.sql`, preflight,
 * postcheck e o desfazer) são gerados da fixture aprovada por
 * `scripts/events/essencia-cadastro-sql.ts`. Aqui eles rodam como estão no
 * repositório, contra o Postgres em memória com todas as migrations: o evento
 * nasce em rascunho, com a sessão fechada e os dados aprovados, nada fica
 * público, e só a abertura posterior (interruptor, publicação, sessão aberta)
 * deixa a venda passar.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { eventBookingRejection, loadSessionBookingRules, type RulesQueryClient } from "../lib/events/booking.ts";
import { ESSENCIA_CAPACITY, ESSENCIA_EDITORIAL, ESSENCIA_STARTS_AT } from "../lib/events/fixtures/essencia.ts";
import {
  ESSENCIA_ADMIN_EMAIL,
  essenciaCadastroSql,
  essenciaPostcheckSql,
  essenciaPreflightSql,
  essenciaRollbackSql,
} from "../scripts/events/essencia-cadastro-sql.ts";
import { fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";
import { ADMIN, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const CADASTRO = source("supabase/maintenance/essencia_cadastro.sql");
const PREFLIGHT = source("supabase/diagnostics/essencia_cadastro_preflight.sql");
const POSTCHECK = source("supabase/diagnostics/essencia_cadastro_postcheck.sql");
const ROLLBACK = source("supabase/rollback/essencia_cadastro.rollback.sql");

type Check = { check_name: string; result: string; status: string };

async function freshDatabase() {
  const db = await fullDatabase();
  const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
  await db.query(`update auth.users set email = $1 where id = $2::uuid`, [ESSENCIA_ADMIN_EMAIL, ADMIN]);
  return { db, fx };
}

async function report(db: { query: (sql: string) => Promise<{ rows: unknown[] }> }, sql: string) {
  return new Map(((await db.query(sql)).rows as Check[]).map((row) => [row.check_name, row]));
}

test("os arquivos do repositório são exatamente os gerados da fixture aprovada", () => {
  assert.equal(CADASTRO, essenciaCadastroSql(), "rode pnpm events:essencia-sql");
  assert.equal(PREFLIGHT, essenciaPreflightSql());
  assert.equal(POSTCHECK, essenciaPostcheckSql());
  assert.equal(ROLLBACK, essenciaRollbackSql());
  const json = CADASTRO.match(/\$json\$([\s\S]*?)\$json\$/)?.[1] ?? "";
  assert.deepEqual(JSON.parse(json), ESSENCIA_EDITORIAL);
  assert.match(CADASTRO, /'2026-11-07T08:30:00\.000Z'::timestamptz,\n {4}210,\n {4}15000,\n {4}24\n/);
  assert.doesNotMatch(CADASTRO, /publication_enabled = true|status = 'OPEN'|'PUBLISHED'/, "o cadastro não publica nem abre");
});

test("preflight → cadastro → postcheck: evento em rascunho, sessão fechada, dados aprovados, nada público", async () => {
  const { db } = await freshDatabase();
  const pre = await report(db, PREFLIGHT);
  for (const [name, row] of pre) assert.equal(row.status, "OK", `${name}: ${row.result}`);

  await db.exec(CADASTRO);
  const post = await report(db, POSTCHECK);
  for (const [name, row] of post) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  assert.equal(post.get("SESSAO_FECHADA")?.result, "CLOSED 07/11/2026 05:30 210min 15000 centavos 24 vagas");
  assert.equal(post.get("LIMITE_POR_PEDIDO_E_PRAZO")?.result, "até 6 por pedido; cancelamento até 2026-11-05T12:00:00-03:00");
  assert.equal(post.get("CONTEUDO_EDITORIAL_APROVADO")?.result, "idêntico ao aprovado");
  for (const count of ["LISTAGENS_REGULARES", "RESERVAS_POR_STATUS", "INSCRICOES_DA_LISTA_POR_STATUS"]) {
    assert.equal(post.get(count)?.result, pre.get(count)?.result, count);
  }
  // Rodar de novo o preflight agora reprova (slug ocupado) e mostra o evento.
  const again = await report(db, PREFLIGHT);
  assert.equal(again.get("SLUG_LIVRE")?.status, "FALHOU");
  assert.equal(again.get("ESSENCIA_CADASTRO_PREFLIGHT_OK")?.status, "FALHOU");
  await db.close();
});

test("cadastro repetido, ator ausente ou interruptor ligado: para inteiro, sem cadastro parcial", async () => {
  const { db } = await freshDatabase();
  await db.exec(CADASTRO);
  await assert.rejects(db.exec(CADASTRO), /ESSENCIA_JA_EXISTE/);
  await db.exec("rollback").catch(() => undefined);
  assert.equal((await db.query<Row>(`select count(*)::int as n from public.experiences where slug = 'essencia'`)).rows[0].n, 1);
  await db.close();

  const other = await freshDatabase();
  await other.db.query(`update auth.users set email = 'outra@teste.local' where id = $1::uuid`, [ADMIN]);
  await assert.rejects(other.db.exec(CADASTRO), /ESSENCIA_ATOR/);
  await other.db.exec("rollback").catch(() => undefined);
  await other.db.query(`update auth.users set email = $1 where id = $2::uuid`, [ESSENCIA_ADMIN_EMAIL, ADMIN]);
  await other.db.exec(`update public.special_event_settings set publication_enabled = true`);
  await assert.rejects(other.db.exec(CADASTRO), /ESSENCIA_INTERRUPTOR/);
  await other.db.exec("rollback").catch(() => undefined);
  assert.equal((await other.db.query<Row>(`select count(*)::int as n from public.experiences where kind = 'EVENT'`)).rows[0].n, 0);
  await other.db.close();
});

test("cadastrado e fechado: a venda é recusada no servidor; só a abertura completa libera", async () => {
  const { db } = await freshDatabase();
  const admin = createPgliteAdmin(db);
  const client = admin.client as unknown as RulesQueryClient;
  await db.exec(CADASTRO);
  const session = (await db.query<Row>(`select s.id from public.sessions s join public.experiences e on e.id = s.experience_id where e.slug = 'essencia'`)).rows[0].id as string;
  const experience = (await db.query<Row>(`select id from public.experiences where slug = 'essencia'`)).rows[0].id as string;

  const closed = await loadSessionBookingRules(client, session);
  assert.deepEqual(closed, { kind: "EVENT", maxPerOrder: 6, emailReady: true, visible: false });
  assert.equal(eventBookingRejection(closed, 1, true)?.code, "EVENT_NOT_PUBLIC", "rascunho: nem com a venda aberta");

  // A abertura (cada passo com autorização): interruptor, publicação, sessão aberta.
  await db.exec(`update public.special_event_settings set publication_enabled = true`);
  await db.query(`select public.admin_update_event($1::uuid, $2::uuid, 'ESSÊNCIA — Corpo, Mente e Natureza', $3, 'PUBLISHED', $4, 0, $5::jsonb)`, [
    ADMIN, experience, "Canoa havaiana ao nascer do sol, meditação sensorial e Superioga no Cápsula Bar.", ESSENCIA_EDITORIAL.event.cardImage.src, JSON.stringify(ESSENCIA_EDITORIAL),
  ]);
  const published = await loadSessionBookingRules(client, session);
  assert.equal(published?.kind === "EVENT" && published.visible, true);
  assert.equal(eventBookingRejection(published, 1, false)?.code, "EVENT_BOOKING_CLOSED", "sem as variáveis, fechado");
  assert.equal(eventBookingRejection(published, 7, true)?.code, "EVENT_ORDER_LIMIT");
  assert.equal(eventBookingRejection(published, 6, true), null);
  // A sessão continua fechada no banco até a equipe abrir: a pré-reserva recusa.
  await assert.rejects(db.query(`select public.create_pre_reservation($1::uuid, 'Pessoa Teste', '52998224725', '+5561988887777', 'p@teste.local', 1, null, gen_random_uuid())`, [session]));
  assert.equal(ESSENCIA_CAPACITY, 24);
  assert.equal(ESSENCIA_STARTS_AT, "2026-11-07T08:30:00.000Z");
  await db.close();
});

test("desfazer: remove só enquanto está em rascunho, fechado e sem reserva; senão recusa sem mudar nada", async () => {
  const { db, fx } = await freshDatabase();
  await db.exec(ROLLBACK);
  await db.exec(CADASTRO);
  await db.exec(ROLLBACK);
  assert.equal((await db.query<Row>(`select count(*)::int as n from public.experiences where slug = 'essencia'`)).rows[0].n, 0);
  assert.equal((await report(db, PREFLIGHT)).get("ESSENCIA_CADASTRO_PREFLIGHT_OK")?.status, "OK", "volta ao ponto de partida");

  await db.exec(CADASTRO);
  const session = (await db.query<Row>(`select s.id from public.sessions s join public.experiences e on e.id = s.experience_id where e.slug = 'essencia'`)).rows[0].id as string;
  await db.query(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [session]);
  await fx.reserve(session, 1).catch(() => undefined);
  await assert.rejects(db.exec(ROLLBACK), /ESSENCIA_DESFAZER_RECUSADO/);
  await db.exec("rollback").catch(() => undefined);
  assert.equal((await db.query<Row>(`select count(*)::int as n from public.experiences where slug = 'essencia'`)).rows[0].n, 1);
  await db.close();
});
