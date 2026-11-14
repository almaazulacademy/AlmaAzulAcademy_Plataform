/**
 * Lançamento de uma edição cadastrada (PR D): publicação com vendas bloqueadas
 * e abertura das vendas, com preflight, postcheck e desfazer.
 *
 * Tudo roda num banco PGlite montado como produção (migrations até a de
 * segurança dos eventos, schema só de produção, 1ª edição cadastrada e
 * publicada pelo seu próprio roteiro). Nada fala com o Supabase de produção.
 */

// Primeiro import: o relógio precisa estar no lugar antes de qualquer banco.
import "./support/essencia-clock.ts";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { eventBookingRejection, loadSessionBookingRules, type RulesQueryClient } from "../lib/events/booking.ts";
import { ESSENCIA_LUA_CHEIA_EDITION, ESSENCIA_LUA_CHEIA_EDITORIAL, ESSENCIA_LUA_CHEIA_SLUG } from "../lib/events/fixtures/essencia-lua-cheia.ts";
import { EDITION_ADMIN_EMAIL, editionCadastroPaths, editionCadastroSql } from "../scripts/events/edition-cadastro-sql.ts";
import {
  aberturaPreflightSql,
  aberturaRollbackSql,
  aberturaSql,
  editionLaunchErrors,
  editionLaunchFiles,
  editionLaunchPaths,
  openedEditorial,
  publicacaoPreflightSql,
  publicacaoSql,
} from "../scripts/events/edition-launch-sql.ts";
import { editorialFiles, publishedEditorialFiles } from "../scripts/events/essencia-lua-cheia-editorial-sql.ts";
import { applyMigration, fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";
import { PRODUCTION_ONLY } from "./support/production-only-schema.ts";
import { ADMIN, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const EDITION = ESSENCIA_LUA_CHEIA_EDITION;
const SLUG = ESSENCIA_LUA_CHEIA_SLUG;
const PATHS = editionLaunchPaths(SLUG);
type Check = { check_name: string; result: string; status: string };

// ===========================================================================
// Arquivos gerados
// ===========================================================================

test("lançamento: os nove arquivos do repositório são exatamente os gerados da edição", () => {
  const files = editionLaunchFiles(EDITION);
  assert.equal(Object.keys(files).length, 9);
  for (const [path, sql] of Object.entries(files)) assert.equal(source(path), sql, `${path}: rode pnpm events:edition-launch-sql ${SLUG}`);
  assert.deepEqual(Object.values(PATHS).sort(), Object.keys(files).sort());
});

test("lançamento: nenhum script mexe no interruptor, em reserva, pagamento, lista ou outra edição; tudo numa transação", () => {
  for (const [path, sql] of Object.entries(editionLaunchFiles(EDITION))) {
    assert.doesNotMatch(sql, /update public\.special_event_settings|publication_enabled\s*=\s*(true|false)/i, `${path}: interruptor`);
    assert.doesNotMatch(sql, /(delete from|update|insert into) public\.(reservations|payments|payment_events|waitlist_entries|reservation_participants)/i, `${path}: dados de clientes`);
    assert.doesNotMatch(sql, /\btruncate\b|\bdrop\b/i, path);
    assert.doesNotMatch(sql, /update public\.(experiences|sessions)\b/i, `${path}: só pelas RPCs do painel`);
    if (path.startsWith("supabase/maintenance/") || path.startsWith("supabase/rollback/")) {
      assert.match(sql, /^begin;\nset local lock_timeout = '5s';$/m, path);
      assert.match(sql, /\ncommit;\n$/, path);
      assert.match(sql, /for update/, `${path}: trava as linhas`);
    } else {
      assert.doesNotMatch(sql, /admin_update_|commit;/, `${path}: só leitura`);
    }
  }
  assert.match(source(PATHS.publicacao), /'PUBLISHED'/);
  assert.doesNotMatch(source(PATHS.publicacao), /'OPEN'|jsonb_set|admin_update_session/, "a publicação não abre a sessão nem tira o em breve");
  assert.match(source(PATHS.abertura), /jsonb_set\(target\.editorial_content, '\{event,reservation,comingSoon\}', 'false'::jsonb\)/);
});

test("lançamento: o conteúdo aberto só muda comingSoon; conteúdo sem em breve não gera nada", () => {
  const opened = openedEditorial(EDITION);
  assert.equal(opened.event.reservation.comingSoon, false);
  const back = JSON.parse(JSON.stringify(opened));
  back.event.reservation.comingSoon = true;
  assert.deepEqual(back, ESSENCIA_LUA_CHEIA_EDITORIAL);
  assert.equal(ESSENCIA_LUA_CHEIA_EDITORIAL.event.reservation.comingSoon, true, "o fixture segue em breve");
  assert.deepEqual(editionLaunchErrors(EDITION), []);
  const alreadyOpen = { ...EDITION, editorial: openedEditorial(EDITION) } as typeof EDITION;
  assert.ok(editionLaunchErrors(alreadyOpen).some((error) => /comingSoon = true/.test(error)));
  assert.throws(() => editionLaunchFiles(alreadyOpen), /não pode gerar o lançamento/);
});

// ===========================================================================
// Sequência completa num banco como produção
// ===========================================================================

let cpfSeed = 20_000_000_000;

async function productionLike() {
  const db = await fullDatabase({ until: "202610310003_experiences_active_on_insert.sql" });
  await db.exec(PRODUCTION_ONLY);
  await applyMigration(db, "202610310004_event_publication_security.sql");
  await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
  await db.query(`update auth.users set email = $1 where id = $2::uuid`, [EDITION_ADMIN_EMAIL, ADMIN]);
  await db.exec(source("supabase/maintenance/essencia_cadastro.sql"));
  await db.exec(source("supabase/maintenance/essencia_publicacao.sql"));
  return db;
}

async function report(db: PGlite, sql: string) {
  return new Map((await db.query<Check>(sql)).rows.map((row) => [row.check_name, row]));
}

/** Script que precisa recusar: lança a mensagem esperada e o banco desfaz a transação. */
async function refuses(db: PGlite, sql: string, message: RegExp) {
  await assert.rejects(db.exec(sql), message);
  await db.exec("rollback");
}

async function notices(db: PGlite, sql: string) {
  const seen: string[] = [];
  const results = await db.exec(sql, { onNotice: (notice) => seen.push(notice.message ?? "") });
  assert.ok(results.length > 0);
  return seen;
}

async function state(db: PGlite) {
  const row = (await db.query<Row>(
    `select e.status, e.editorial_content -> 'event' -> 'reservation' ->> 'comingSoon' as coming_soon, s.id as session_id, s.status as session_status,
            public.available_spots(s.id) as spots, (select count(*)::int from public.get_public_event($1)) as page,
            (select count(*)::int from public.get_booking_session(s.id)) as bookable,
            (select string_agg(x.availability, ',') from public.list_public_event_sessions($1) x) as availability
       from public.experiences e join public.sessions s on s.experience_id = e.id where e.slug = $1`,
    [SLUG],
  )).rows[0];
  return row;
}

/** O que não pode mudar: a 1ª edição inteira, o interruptor, o catálogo regular, reservas e lista. */
async function untouched(db: PGlite) {
  return (await db.query<Row>(
    `select (select md5(string_agg(e.id::text || e.status || e.editorial_content::text || s.id || s.status || s.starts_at || s.capacity || s.price_cents, '|'))
               from public.experiences e join public.sessions s on s.experience_id = e.id where e.slug = 'essencia') as first_edition,
            (select publication_enabled from public.special_event_settings where singleton) as switch,
            (select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.list_public_regular_catalog() x) as catalog,
            (select md5(coalesce(string_agg(r.id::text || r.status || r.quantity, '|' order by r.id), '')) from public.reservations r
               join public.sessions s on s.id = r.session_id join public.experiences e on e.id = s.experience_id where e.slug <> $1) as other_reservations,
            (select count(*)::int from public.waitlist_entries) as waitlist`,
    [SLUG],
  )).rows[0];
}

async function bookingRules(db: PGlite, sessionId: string) {
  return loadSessionBookingRules(createPgliteAdmin(db).client as unknown as RulesQueryClient, sessionId);
}

async function preReserve(db: PGlite, sessionId: string, quantity: number) {
  cpfSeed += 1;
  return (await db.query<Row>("select public.create_pre_reservation($1,$2,$3,$4,$5,$6,$7,$8) as data", [
    sessionId, "Cliente de Teste", String(cpfSeed), "61999990000", "cliente@exemplo.com", quantity, "", randomUUID(),
  ])).rows[0].data as { reservationId: string };
}

test("banco como produção: cadastro → publicação (em breve) → abertura → desfazer seguro; a 1ª edição não muda", async () => {
  const db = await productionLike();
  const baseline = await untouched(db);
  const cadastro = editionCadastroPaths(SLUG);

  // Sem cadastro: os preflights reprovam e os scripts recusam.
  assert.equal((await report(db, publicacaoPreflightSql(EDITION))).get("EVENTO_PUBLICACAO_PREFLIGHT_OK")?.status, "FALHOU");
  await refuses(db, publicacaoSql(EDITION), /EVENTO_AUSENTE/);
  await refuses(db, aberturaSql(EDITION), /EVENTO_ESTADO/);

  await db.exec(source(cadastro.cadastro));
  const registered = await state(db);
  const sessionId = registered.session_id as string;
  assert.deepEqual({ ...registered, session_id: null }, { status: "DRAFT", coming_soon: "true", session_id: null, session_status: "CLOSED", spots: 24, page: 0, bookable: 0, availability: null });

  // Abertura fora de ordem (ainda em rascunho): recusa sem mudar nada.
  await refuses(db, aberturaSql(EDITION), /EVENTO_ESTADO/);
  assert.equal((await report(db, aberturaPreflightSql(EDITION))).get("EVENTO_ABERTURA_PREFLIGHT_OK")?.status, "FALHOU");
  assert.equal((await state(db)).status, "DRAFT");

  // --- Publicação ---------------------------------------------------------
  const pre = await report(db, source(PATHS.publicacaoPreflight));
  for (const [name, row] of pre) assert.notEqual(row.status, "FALHOU", `${name}: ${row.result}`);
  assert.equal(pre.get("EVENTO_PUBLICACAO_PREFLIGHT_OK")?.status, "OK");
  assert.equal(pre.get("TURMAS_REGULARES_SOBREPOSTAS")?.status, "OK");
  assert.match(pre.get("RESERVAS_E_INSCRICOES_DA_EDICAO")?.result ?? "", /^nenhuma reserva; 0 inscrição\(ões\) na lista; 24 vaga\(s\) livre\(s\)$/);

  assert.ok((await notices(db, source(PATHS.publicacao))).includes("EVENTO_PUBLICADO_COM_VENDAS_BLOQUEADAS"));
  const published = await state(db);
  assert.deepEqual([published.status, published.coming_soon, published.session_status, published.page, published.bookable, published.spots], ["PUBLISHED", "true", "CLOSED", 1, 0, 24]);
  assert.notEqual(published.availability, "AVAILABLE");

  // Duplicada: recusa.
  await refuses(db, source(PATHS.publicacao), /EVENTO_ESTADO: esperado DRAFT, encontrado PUBLISHED/);

  const post = await report(db, source(PATHS.publicacaoPostcheck));
  for (const [name, row] of post) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  for (const key of ["OUTROS_EVENTOS", "LISTAGENS_REGULARES", "RESERVAS_POR_STATUS", "INSCRICOES_DA_LISTA_POR_STATUS"]) assert.equal(post.get(key)?.result, pre.get(key)?.result, key);

  const anon = (await db.exec(source(PATHS.publicacaoAnon))).flatMap((result) => result.rows as Row[]);
  assert.equal((await db.query<Row>("select current_user as who")).rows[0].who, "postgres", "o script volta o papel (rollback)");
  assert.deepEqual(anon.at(-1), { evento_visivel: 1, sessao_aberta_visivel: 0, sessao_reservavel: 0, pode_pre_reservar: false });

  // Publicada e em breve: o servidor recusa o checkout (API e /reservar) e o banco recusa pré-reserva na sessão fechada.
  const closedRules = await bookingRules(db, sessionId);
  assert.ok(closedRules?.kind === "EVENT" && closedRules.comingSoon === true, "em breve");
  assert.equal(eventBookingRejection(closedRules, 1, true)?.code, "EVENT_BOOKING_CLOSED");
  await assert.rejects(preReserve(db, sessionId, 1));

  // Desfazer a publicação (sem reservas): volta a rascunho; de novo, não faz nada; publicar de novo funciona.
  assert.ok((await notices(db, source(PATHS.publicacaoRollback))).includes("EVENTO_PUBLICACAO_DESFEITA"));
  assert.deepEqual([(await state(db)).status, (await state(db)).page], ["DRAFT", 0]);
  assert.ok((await notices(db, source(PATHS.publicacaoRollback))).some((notice) => /já está em rascunho/.test(notice)));
  await db.exec(source(PATHS.publicacao));
  assert.deepEqual(await untouched(db), baseline, "publicação e desfazer não tocam a 1ª edição, o interruptor, o catálogo, reservas ou lista");

  // --- Abertura -----------------------------------------------------------
  const openPre = await report(db, source(PATHS.aberturaPreflight));
  for (const [name, row] of openPre) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  assert.equal(openPre.get("VAGAS_LIVRES")?.result, "24 de 24");
  assert.equal(openPre.get("SESSAO_NO_FUTURO")?.result, "23/11/2026 16:30");

  assert.ok((await notices(db, source(PATHS.abertura))).includes(`EVENTO_VENDAS_ABERTAS sessionId=${sessionId}`));
  const opened = await state(db);
  assert.deepEqual([opened.status, opened.coming_soon, opened.session_status, opened.spots, opened.page, opened.bookable, opened.availability], ["PUBLISHED", "false", "OPEN", 24, 1, 1, "AVAILABLE"]);
  await refuses(db, source(PATHS.abertura), /EVENTO_CONTEUDO: esperado o conteúdo aprovado com "em breve"/);

  const openPost = await report(db, source(PATHS.aberturaPostcheck));
  for (const [name, row] of openPost) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  assert.equal(openPost.get("SESSAO_ABERTA")?.result, "OPEN 23/11/2026 16:30 210min 16000 centavos 24 vagas");
  assert.equal(openPost.get("VAGAS")?.result, "24 livre(s) de 24");
  for (const key of ["OUTROS_EVENTOS", "LISTAGENS_REGULARES", "RESERVAS_POR_STATUS", "INSCRICOES_DA_LISTA_POR_STATUS"]) assert.equal(openPost.get(key)?.result, pre.get(key)?.result, key);

  const openRules = await bookingRules(db, sessionId);
  assert.deepEqual(openRules, { kind: "EVENT", maxPerOrder: 6, emailReady: true, visible: true });
  assert.equal(eventBookingRejection(openRules, 1, true), null, "com EVENT_BOOKING_OPEN ligada, o checkout passa");
  assert.equal(eventBookingRejection(openRules, 7, true)?.code, "EVENT_ORDER_LIMIT", "mais de 6 por pedido recusa");
  assert.deepEqual(await untouched(db), baseline, "a abertura só toca esta edição");

  // Desfazer a abertura sem reservas: fecha e volta o em breve; de novo, não faz nada; abrir de novo funciona.
  assert.ok((await notices(db, source(PATHS.aberturaRollback))).includes("EVENTO_ABERTURA_DESFEITA"));
  const reclosed = await state(db);
  assert.deepEqual([reclosed.status, reclosed.coming_soon, reclosed.session_status, reclosed.bookable], ["PUBLISHED", "true", "CLOSED", 0]);
  assert.ok((await notices(db, source(PATHS.aberturaRollback))).some((notice) => /nada a fazer/.test(notice)));
  await db.exec(source(PATHS.abertura));

  // Com uma reserva (mesmo só pré-reservada): os dois desfazer recusam e nada some.
  const reservation = await preReserve(db, sessionId, 2);
  assert.equal((await state(db)).spots, 22);
  await refuses(db, source(PATHS.aberturaRollback), /EVENTO_DESFAZER_RECUSADO: já existem reservas/);
  await refuses(db, source(PATHS.publicacaoRollback), /EVENTO_DESFAZER_RECUSADO/);
  await refuses(db, source(PATHS.abertura), /EVENTO_CONTEUDO/);
  assert.equal((await db.query<Row>("select count(*)::int as n from public.reservations where id = $1::uuid", [reservation.reservationId])).rows[0].n, 1);
  const afterSale = await state(db);
  assert.deepEqual([afterSale.session_status, afterSale.coming_soon, afterSale.spots], ["OPEN", "false", 22]);
  const salePost = await report(db, source(PATHS.aberturaPostcheck));
  assert.equal(salePost.get("EVENTO_ABERTURA_POSTCHECK_OK")?.status, "OK", "depois das vendas o postcheck segue OK, só informa");
  assert.match(salePost.get("RESERVAS_E_INSCRICOES_DA_EDICAO")?.result ?? "", /PRE_RESERVED=1; 0 inscrição\(ões\) na lista; 22 vaga\(s\) livre\(s\)/);

  // Cadastro de novo: recusa (slug já usado), sem mexer no que existe.
  await refuses(db, source(cadastro.cadastro), /EVENTO/);
  assert.deepEqual(await untouched(db), baseline, "do começo ao fim, a 1ª edição, o interruptor e o resto não mudam");
  await db.close();
});

test("banco como produção: mudança fora do roteiro (preço, vagas ou conteúdo) faz os scripts recusarem", async () => {
  const db = await productionLike();
  await db.exec(source(editionCadastroPaths(SLUG).cadastro));
  const sessionId = (await state(db)).session_id as string;

  await db.query("update public.sessions set price_cents = 15000 where id = $1::uuid", [sessionId]);
  assert.equal((await report(db, publicacaoPreflightSql(EDITION))).get("SESSAO_FECHADA")?.status, "FALHOU");
  await refuses(db, publicacaoSql(EDITION), /EVENTO_SESSAO/);
  await db.query("update public.sessions set price_cents = $2 where id = $1::uuid", [sessionId, EDITION.priceCents]);

  await db.query(`update public.experiences set editorial_content = jsonb_set(editorial_content, '{event,subtitle}', '"Outro"') where slug = $1`, [SLUG]);
  await refuses(db, publicacaoSql(EDITION), /EVENTO_CONTEUDO/);
  await db.query(`update public.experiences set editorial_content = $2::jsonb where slug = $1`, [SLUG, JSON.stringify(ESSENCIA_LUA_CHEIA_EDITORIAL)]);

  await db.exec(publicacaoSql(EDITION));
  await db.query("update public.sessions set capacity = 20 where id = $1::uuid", [sessionId]);
  assert.equal((await report(db, aberturaPreflightSql(EDITION))).get("EVENTO_ABERTURA_PREFLIGHT_OK")?.status, "FALHOU");
  await refuses(db, aberturaSql(EDITION), /EVENTO_SESSAO/);
  assert.equal((await state(db)).session_status, "CLOSED");

  // O rollback de abertura com a venda já fechada e em breve não faz nada.
  assert.ok((await notices(db, aberturaRollbackSql(EDITION))).some((notice) => /nada a fazer/.test(notice)));
  await db.close();
});


test("correção editorial: atualiza o rascunho original, preserva IDs e sessão e permite o novo preflight", async (t) => {
  const db = await productionLike();
  t.after(() => db.close());
  for (const [path, sql] of Object.entries(editorialFiles)) assert.equal(source(path), sql, path);
  const [preflight, update, postcheck, rollback] = Object.values(editorialFiles);
  const oldEditorial = update.match(/expected_content constant jsonb := \$json\$(.*?)\$json\$/)?.[1];
  assert.ok(oldEditorial);
  const publishedEditorial = JSON.parse(update.match(/replacement_content constant jsonb := \$json\$(.*?)\$json\$/)?.[1] ?? "");
  const initialEdition = { ...EDITION, editorial: publishedEditorial };
  assert.equal(createHash("sha256").update(oldEditorial).digest("hex"),
    "2e7424366ea4c3fd393f9a29d058755acc1d20edb9a87dc77c0c4e3d00e073ed",
    "JSON exato do cadastro em 8b0c96c");
  const originalTitle = "ESSÊNCIA — Experiência Relax | Celebração da Lua Cheia";
  await refuses(db, update, /EVENTO_EDITORIAL_ESTADO/);
  await db.exec(editionCadastroSql({ ...EDITION, registered: false, title: originalTitle, editorial: JSON.parse(oldEditorial) }));

  const snapshot = async () => (await db.query<Row>(`
    select to_jsonb(e) - 'updated_at' as experience, to_jsonb(s) as session
    from public.experiences e join public.sessions s on s.experience_id = e.id where e.slug = $1
  `, [SLUG])).rows[0];
  const baseline = await untouched(db);
  const initial = await report(db, preflight);
  for (const [name, row] of initial) assert.equal(row.status, "OK", name);
  assert.equal((await report(db, source(PATHS.publicacaoPreflight))).get("EVENTO_PUBLICACAO_PREFLIGHT_OK")?.status, "FALHOU");
  await refuses(db, rollback, /EVENTO_EDITORIAL_ORIGEM/);
  await db.query("update public.sessions set price_cents = 15000 where experience_id = (select id from public.experiences where slug = $1)", [SLUG]);
  await refuses(db, update, /EVENTO_EDITORIAL_SESSAO/);
  await db.query("update public.sessions set price_cents = 16000 where experience_id = (select id from public.experiences where slug = $1)", [SLUG]);
  const original = await snapshot();

  assert.ok((await notices(db, update)).some((note) => note.startsWith("EVENTO_EDITORIAL_ATUALIZADO")));
  const corrected = await snapshot();
  assert.deepEqual(corrected, {
    experience: { ...(original.experience as object), title: EDITION.title, editorial_content: publishedEditorial },
    session: original.session,
  });
  const final = await report(db, postcheck);
  for (const [name, row] of final) assert.equal(row.status, "OK", name);
  for (const name of ["SESSAO_FECHADA", "OUTROS_EVENTOS", "LISTAGENS_REGULARES", "RESERVAS_POR_STATUS", "INSCRICOES_DA_LISTA_POR_STATUS"]) {
    assert.equal(final.get(name)?.result, initial.get(name)?.result, name);
  }
  const publication = await report(db, publicacaoPreflightSql(initialEdition));
  for (const [name, row] of publication) assert.equal(row.status, "OK", name);
  await refuses(db, update, /EVENTO_EDITORIAL_ORIGEM/);
  assert.ok((await notices(db, rollback)).some((note) => note.startsWith("EVENTO_EDITORIAL_REVERTIDO")));
  assert.deepEqual(await snapshot(), original);
  assert.deepEqual(await untouched(db), baseline);

  await db.exec(update);
  await db.exec(publicacaoSql(initialEdition));
  await refuses(db, rollback, /EVENTO_EDITORIAL_ESTADO/);
  assert.deepEqual(await untouched(db), baseline);
});


test("editorial publicado: preserva publicação e sessão fechada, libera o preflight de abertura e reverte só os ajustes", async (t) => {
  const db = await productionLike();
  t.after(() => db.close());
  for (const [path, sql] of Object.entries(publishedEditorialFiles)) assert.equal(source(path), sql, path);
  const [preflight, update, postcheck, rollback] = Object.values(publishedEditorialFiles);
  const originalEditorial = update.match(/expected_content constant jsonb := \$json\$(.*?)\$json\$/)?.[1];
  assert.ok(originalEditorial);
  assert.equal(createHash("sha256").update(originalEditorial).digest("hex"),
    "2c4c1a922679073df37c27c779025dfd96740804eb359c2a7557546bfec72fa3",
    "JSON exato aprovado e publicado desde 2b386d8");
  const originalEdition = { ...EDITION, editorial: JSON.parse(originalEditorial) };
  await db.exec(editionCadastroSql({ ...originalEdition, registered: false }));
  await refuses(db, update, /EVENTO_EDITORIAL_ESTADO/);
  await db.exec(publicacaoSql(originalEdition));

  const snapshot = async () => (await db.query<Row>(`
    select to_jsonb(e) - 'updated_at' as experience, to_jsonb(s) as session
    from public.experiences e join public.sessions s on s.experience_id = e.id where e.slug = $1
  `, [SLUG])).rows[0];
  const original = await snapshot();
  const baseline = await untouched(db);
  const before = await report(db, preflight);
  for (const [name, row] of before) assert.equal(row.status, "OK", name);
  await refuses(db, rollback, /EVENTO_EDITORIAL_ORIGEM/);
  assert.equal((await report(db, source(PATHS.aberturaPreflight))).get("EVENTO_ABERTURA_PREFLIGHT_OK")?.status, "FALHOU");

  assert.ok((await notices(db, update)).some((note) => note.startsWith("EVENTO_EDITORIAL_ATUALIZADO")));
  assert.deepEqual(await snapshot(), {
    experience: { ...(original.experience as object), editorial_content: EDITION.editorial },
    session: original.session,
  });
  const after = await report(db, postcheck);
  for (const [name, row] of after) assert.equal(row.status, "OK", name);
  for (const name of ["SESSAO_FECHADA", "OUTROS_EVENTOS", "LISTAGENS_REGULARES", "RESERVAS_POR_STATUS", "INSCRICOES_DA_LISTA_POR_STATUS"]) {
    assert.equal(after.get(name)?.result, before.get(name)?.result, name);
  }
  assert.equal((await report(db, source(PATHS.aberturaPreflight))).get("EVENTO_ABERTURA_PREFLIGHT_OK")?.status, "OK");
  await refuses(db, update, /EVENTO_EDITORIAL_ORIGEM/);
  assert.ok((await notices(db, rollback)).some((note) => note.startsWith("EVENTO_EDITORIAL_REVERTIDO")));
  assert.deepEqual(await snapshot(), original);
  assert.deepEqual(await untouched(db), baseline);

  await db.exec(update);
  await db.exec(source(PATHS.abertura));
  await refuses(db, rollback, /EVENTO_EDITORIAL_ORIGEM|EVENTO_EDITORIAL_SESSAO/);
});
