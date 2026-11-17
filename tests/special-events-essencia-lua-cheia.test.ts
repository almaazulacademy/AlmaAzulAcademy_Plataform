/** Conteúdo aprovado e integração da segunda edição do ESSÊNCIA. */
import "./support/essencia-clock.ts";

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { eventBookingContext, eventBookingRejection, eventSalesOpen, loadSessionBookingRules, type RulesQueryClient } from "../lib/events/booking.ts";
import { editionDemoEvent, editionErrors } from "../lib/events/edition.ts";
import { EVENT_EDITIONS, getEventEdition } from "../lib/events/editions.ts";
import { parseEventContent, validateEventEditorial, type EventContent } from "../lib/events/editorial.ts";
import { emailInfoItems, eventEmailMissing } from "../lib/events/email-readiness.ts";
import { ESSENCIA_EDITION, ESSENCIA_EDITORIAL } from "../lib/events/fixtures/essencia.ts";
import { ESSENCIA_LUA_CHEIA_EDITION, ESSENCIA_LUA_CHEIA_EDITORIAL, ESSENCIA_LUA_CHEIA_SLUG } from "../lib/events/fixtures/essencia-lua-cheia.ts";
import { arrivalMatchesSession, sessionStartClock } from "../lib/events/policy.ts";
import { availabilityBadge, eventCta, eventScheduleLabel, programItemTime } from "../lib/events/presentation.ts";
import {
  EDITION_ADMIN_EMAIL,
  editionCadastroErrors,
  editionCadastroPaths,
  editionCadastroSql,
  editionPostcheckSql,
  editionPreflightSql,
  editionRollbackSql,
} from "../scripts/events/edition-cadastro-sql.ts";
import { editionPreviewEmails } from "../scripts/email/event-edition-preview.ts";
import { applyMigration, fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";
import { PRODUCTION_ONLY } from "./support/production-only-schema.ts";
import { ADMIN, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const EDITION = ESSENCIA_LUA_CHEIA_EDITION;
const parsed = validateEventEditorial(EDITION.editorial);
if (!parsed.success) throw new Error(parsed.errors.join("; "));
const CONTENT: EventContent = parsed.data.event;
const JSON_TEXT = JSON.stringify(ESSENCIA_LUA_CHEIA_EDITORIAL);
const FIRST_EDITION = "Registro da 1ª edição do ESSÊNCIA · 07/11/2026";
const body = (id: string) => CONTENT.info.items.find((item) => item.id === id)?.body ?? "";

// ===========================================================================
// Identidade e parâmetros
// ===========================================================================

test("identidade oficial: ESSÊNCIA — Corpo, Mente e Natureza · Celebração da Lua Cheia · Especial de Confraternização de Fim de Ano", () => {
  const OFFICIAL = "ESSÊNCIA — Corpo, Mente e Natureza";
  assert.equal(EDITION.title, OFFICIAL, "checkout, e-mails, planilha e painel");
  assert.equal(parsed.success && parsed.data.seo.title, OFFICIAL, "metadados");
  assert.equal(parsed.success && parsed.data.hero.title, OFFICIAL);
  assert.equal(CONTENT.subtitle, "Celebração da Lua Cheia");
  assert.equal(CONTENT.intro.title, "Lua Cheia, Movimento e Autocuidado");
  assert.doesNotMatch(JSON_TEXT, /NutreDF/);
  assert.equal(CONTENT.badge, "Especial de Confraternização de Fim de Ano!");
  assert.equal(parsed.success && parsed.data.hero.eyebrow, CONTENT.badge);
  assert.match(EDITION.summary, /^Especial de Confraternização de Fim de Ano:/);
  assert.match(parsed.success ? parsed.data.seo.description : "", /^Especial de Confraternização de Fim de Ano/);
  assert.equal(CONTENT.intro.eyebrow, "Corpo, mente e natureza");
  assert.equal(CONTENT.tagline, "Que tal celebrar a vida, compartilhar boas energias e receber os novos ciclos?");
  assert.doesNotMatch(JSON_TEXT, /Experiência Relax|2ª edição ·|Edição especial · Celebração/);
});

test("parâmetros: segunda 23/11/2026, 17h15 às 20h30, R$ 160, 24 vagas, até 6 por pedido, modelo de prévia com reservas bloqueadas", () => {
  assert.equal(EDITION.slug, "essencia-lua-cheia");
  assert.equal(getEventEdition(ESSENCIA_LUA_CHEIA_SLUG), EDITION);
  assert.deepEqual(EVENT_EDITIONS.map((edition) => edition.slug), ["essencia", "essencia-lua-cheia"]);
  assert.deepEqual(editionErrors(EDITION), []);
  assert.match(editionCadastroErrors(EDITION).join(" "), /já está cadastrada/);
  assert.equal(EDITION.registered, true);
  assert.equal(EDITION.startsAt, "2026-11-23T20:15:00.000Z");
  assert.equal(sessionStartClock(EDITION.startsAt), "17:15");
  assert.equal(new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long" }).format(new Date(EDITION.startsAt)), "segunda-feira");
  assert.equal(EDITION.durationMinutes, 195);
  assert.equal(eventScheduleLabel(CONTENT.scheduleLabel, EDITION.startsAt, EDITION.durationMinutes), "17H15 ÀS 20H30");
  assert.equal(EDITION.priceCents, 16_000);
  assert.equal(EDITION.capacity, 24);
  assert.equal(CONTENT.reservation.maxPerOrder, 6);
  assert.equal(CONTENT.reservation.comingSoon, true);
  assert.equal(EDITION.baseSlug, "concha-acustica");
});

// ===========================================================================
// Programação e atividades simultâneas
// ===========================================================================

test("programação: horários, simultaneidade e responsabilidades", () => {
  const [reception, rowing, parallel, snack, care] = CONTENT.program.items;
  assert.deepEqual(CONTENT.program.items.map(programItemTime), ["17h15", "17h30", "18h30", "19h30", "19h30 às 20h30"]);
  assert.equal(reception.title, "Recepção e acolhimento");
  assert.deepEqual(rowing.hosts, ["Alma Azul Academy"]);
  assert.match(rowing.description, /conforme as condições naturais/);
  assert.match(rowing.description, /Não é necessário ter experiência prévia/);
  assert.equal(rowing.note, "Colete salva-vidas obrigatório, inclusive para crianças.");
  assert.deepEqual(parallel.parallel.map((activity) => [activity.title, activity.hosts]), [
    ["Superioga", ["Rapha Dantas"]],
    ["Dinâmica educativa sobre a fauna e a flora do Cerrado", ["Instituto Equilibraí", "Fernanda Garcia"]],
  ]);
  assert.match(parallel.description, /opcional.*crianças e adolescentes.*supervisão adequada/);
  assert.match(parallel.parallel[0].description, /Traga seu próprio tapete/);
  assert.equal(snack.note, "Incluído no ingresso, sem cobrança adicional.");
  assert.equal(snack.time, care.time);
  assert.deepEqual(care.hosts, ["Cure-se Bem"]);
  assert.match(care.description, /massagem terapêutica ou reflexologia podal, conforme a disponibilidade dos profissionais/);
});

test("sem drink e sem música; lanche da Nutre - DF incluso, sem cardápio inventado", () => {
  assert.doesNotMatch(JSON_TEXT, /drink|álcool|música|musica|show|couvert/i);
  assert.ok(CONTENT.spotlight === null, "o destaque do drink saiu");
  assert.ok(CONTENT.included.items.includes("Lanche saudável da Nutre - DF"));
  assert.match(body("alimentacao"), /lanche saudável da Nutre - DF, servido às 19h30, sem cobrança adicional/);
  assert.doesNotMatch(JSON_TEXT, /cardápio|ingrediente|vegano|vegetariano|glúten|lactose|caloria|restriç/i);
  assert.equal(CONTENT.included.items.length, 6);
});

// ===========================================================================
// Informações operacionais
// ===========================================================================

test("chegada: recepção 17h15, tolerância até 17h30, remada às 17h30; nada da versão anterior", () => {
  assert.deepEqual(CONTENT.arrival, { startTime: "17:15", toleranceUntil: "17:30" });
  assert.ok(arrivalMatchesSession(CONTENT.arrival!, EDITION.startsAt, EDITION.durationMinutes));
  assert.match(body("chegada"), /17h15/);
  assert.match(body("chegada"), /até as 17h30/);
  assert.match(body("chegada"), /horário de início da remada/);
  assert.doesNotMatch(JSON_TEXT, /14h50|15h15|15h00|22 de novembro|24 de novembro|24\/11|R\$ ?150/);
});

test("o que levar, crianças, segurança, clima e cancelamento conforme aprovados", () => {
  for (const thing of ["Roupas confortáveis que possam molhar", "muda de roupa", "toalha", "tapete próprio para a Superioga", "garrafa de água", "repelente", "agasalho leve para a noite"]) {
    assert.match(body("o-que-levar"), new RegExp(thing));
  }
  assert.match(body("criancas"), /somente acompanhadas por um responsável/);
  assert.match(body("criancas"), /mesmo ingresso \(R\$ 160\) e conta na capacidade total de 24 participantes/);
  assert.match(body("criancas"), /colete salva-vidas adequado é obrigatório/);
  assert.doesNotMatch(JSON_TEXT, /idade mínima|a partir de \d+ anos|anos de idade/i, "nenhuma idade mínima inventada");
  assert.match(body("seguranca"), /inclusive crianças, com colete adequado/);
  assert.match(body("seguranca"), /condições seguras de navegação/);
  assert.match(body("clima"), /o evento inteiro será reagendado — remada, Superioga, lanche saudável, massagem e reflexologia e Educação Ambiental/);
  assert.match(body("clima"), /não é realizado em versão parcial/);
  assert.deepEqual(CONTENT.cancellation, { deadline: "2026-11-21T12:00:00-03:00", timeZone: "America/Sao_Paulo", summary: "crédito para outra experiência da Alma Azul Academy ou reembolso, pelo atendimento da nossa equipe" });
  assert.match(body("cancelamento"), /21 de novembro de 2026, às 12h00 \(horário de Brasília\)/);
  assert.doesNotMatch(JSON_TEXT, /automátic/i);
  assert.equal(CONTENT.reservation.notice, "Traga seu próprio tapete para a Superioga. Crianças participam somente acompanhadas por um responsável.");
  assert.ok(CONTENT.info.items.every((item) => !item.pending));
});

// ===========================================================================
// E-mails e resumo antes do pagamento
// ===========================================================================

test("e-mails: confirmação com programação, simultâneas, lanche, crianças e prazo; sem drink nem música", () => {
  assert.deepEqual(eventEmailMissing(CONTENT), []);
  assert.deepEqual(emailInfoItems(CONTENT).map((item) => item.title), ["O que levar", "Participação de crianças", "Segurança na remada", "Lanche saudável", "Condições climáticas"]);
  const emails = new Map(editionPreviewEmails(ESSENCIA_LUA_CHEIA_SLUG));
  const confirmation = emails.get("confirmacao")!;
  assert.equal(confirmation.subject, "Ingresso confirmado — ESSÊNCIA — Corpo, Mente e Natureza · DEMOEDICAO");
  assert.ok(confirmation.text.includes("Seu ingresso para o ESSÊNCIA — Corpo, Mente e Natureza está confirmado!"));
  for (const text of [
    "Data: segunda-feira, 23 de novembro de 2026",
    "Início: 17h15",
    "Tolerância de chegada: até 17h30",
    "Encerramento previsto: 20h30",
    "- 17h15 — Recepção e acolhimento",
    "- 17h30 — Remada Alma Azul (com Alma Azul Academy)",
    "- 18h30 — Superioga e dinâmica educativa. Ao mesmo tempo: Superioga; Dinâmica educativa sobre a fauna e a flora do Cerrado.",
    "- 19h30 — Lanche saudável (com Nutre - DF)",
    "- 19h30 às 20h30 — Autocuidado com Cure-se Bem (com Cure-se Bem)",
    "PARTICIPAÇÃO DE CRIANÇAS",
    "LANCHE SAUDÁVEL",
    "repelente",
    "Prazo: 21/11/2026 às 12h00 (horário de Brasília).",
  ]) assert.ok(confirmation.text.includes(text), `confirmação sem: ${text}`);
  const reschedule = emails.get("reagendamento")!;
  assert.ok(reschedule.text.includes("Ao mesmo tempo: Superioga; Dinâmica educativa sobre a fauna e a flora do Cerrado."));
  for (const [name, message] of emails) {
    if (!message) continue;
    for (const absent of ["drink", "Drink", "música", "Música", "couvert", "1 dia antes", "roupa de banho", "Experiência Relax"]) {
      assert.ok(!message.text.includes(absent) && !message.html.includes(absent), `${name} não pode citar: ${absent}`);
    }
  }
  assert.doesNotMatch(source("scripts/email/event-edition-preview.ts"), /getEmailProvider|\.send\(|getSupabase|\.rpc\(/);
});

test("resumo antes do pagamento: o momento das 18h30 mostra as duas atividades juntas", () => {
  const context = eventBookingContext(editionDemoEvent(EDITION));
  assert.deepEqual(context.program.map((item) => [item.time, item.title]), [
    ["17h15", "Recepção e acolhimento"],
    ["17h30", "Remada Alma Azul"],
    ["18h30", "Superioga e dinâmica educativa — ao mesmo tempo: Superioga; Dinâmica educativa sobre a fauna e a flora do Cerrado"],
    ["19h30", "Lanche saudável"],
    ["19h30 às 20h30", "Autocuidado com Cure-se Bem"],
  ]);
  assert.equal(context.title, "ESSÊNCIA — Corpo, Mente e Natureza");
  assert.equal(context.subtitle, "Celebração da Lua Cheia");
  assert.equal(context.maxPerOrder, 6);
  assert.equal(context.timeRange, "17H15 ÀS 20H30");
  assert.equal(context.arrivalNote, "Início às 17h15, com tolerância de chegada até 17h30.");
});

test("em breve: com a venda global ligada, a edição diz 'Reservas abrem em breve' e o servidor recusa", () => {
  const event = editionDemoEvent(EDITION, "AVAILABLE", 24);
  assert.equal(eventSalesOpen(event, true), false);
  assert.equal(availabilityBadge("AVAILABLE", 24, eventSalesOpen(event, true)).label, "Reservas abrem em breve");
  assert.equal(availabilityBadge("CLOSED", null, eventSalesOpen(event, true)).label, "Reservas abrem em breve");
  assert.equal(eventCta({ availability: "AVAILABLE", sessionId: "00000000-0000-4000-8000-000000000001", ctaLabel: "Garantir minha vaga", bookingOpen: eventSalesOpen(event, true) }).kind, "SOON");
  assert.equal(eventBookingRejection({ kind: "EVENT", maxPerOrder: 6, emailReady: true, visible: true, comingSoon: true }, 1, true)?.code, "EVENT_BOOKING_CLOSED");
});

// ===========================================================================
// Fotos, legendas e parceiros
// ===========================================================================

/** Largura × altura de um WebP (VP8, VP8L ou VP8X). */
function webpSize(bytes: Buffer) {
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WEBP");
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
}

const IMAGES = [
  parsed.success ? parsed.data.hero.image : null!, CONTENT.heroImageMobile!, CONTENT.cardImage!, CONTENT.intro.image!, CONTENT.reservation.image!,
  ...CONTENT.program.items.flatMap((item) => [item.image, ...item.parallel.map((activity) => activity.image)]).filter((image) => image !== null),
];

test("fotos: todas existem, sem metadados, leves; legendas da 1ª edição e dos lugares; nada ampliado", () => {
  for (const image of IMAGES) {
    assert.ok(image!.alt.length > 20, `texto alternativo descritivo: ${image!.src}`);
    const path = new URL(`../public${image!.src}`, import.meta.url);
    assert.ok(existsSync(path), image!.src);
    if (image!.src.startsWith("/images/eventos/essencia-lua-cheia/")) {
      const bytes = readFileSync(path);
      assert.ok(!bytes.includes(Buffer.from("Exif")) && !bytes.includes(Buffer.from("GPS")), `sem EXIF/GPS: ${image!.src}`);
      assert.ok(bytes.length < 520 * 1024, `leve: ${image!.src}`);
    }
  }
  const credits = Object.fromEntries(CONTENT.program.items.map((item) => [item.title, item.image?.credit ?? null]));
  assert.deepEqual(credits, {
    "Recepção e acolhimento": null,
    "Remada Alma Azul": "Remada Sunset · Alma Azul Academy",
    "Superioga e dinâmica educativa": null,
    "Lanche saudável": FIRST_EDITION,
    "Autocuidado com Cure-se Bem": FIRST_EDITION,
  });
  assert.deepEqual(CONTENT.program.items[2].parallel.map((activity) => activity.image?.credit), [FIRST_EDITION, "Córrego do Torto · Cerrado do Distrito Federal"]);
  assert.equal(parsed.success && parsed.data.hero.image.credit, "Remada da Lua Cheia · Alma Azul Academy");
  assert.match(CONTENT.program.items[3].image!.alt, /Duas mesas amarelas com alimentos/);
  const size = (name: string) => webpSize(readFileSync(new URL(`../public/images/eventos/essencia-lua-cheia/${name}`, import.meta.url)));
  assert.deepEqual(size("superioga-1a-edicao.webp"), { width: 720, height: 900 });
  assert.deepEqual(size("bem-estar-1a-edicao.webp"), { width: 720, height: 900 });
  assert.deepEqual(size("hero-lua-desktop.webp"), { width: 2400, height: 1350 });
  assert.deepEqual(size("hero-lua-mobile.webp"), { width: 1080, height: 1920 });
  assert.deepEqual(size("reserva-capsula-noite.webp"), { width: 2400, height: 1350 });
  assert.deepEqual(size("lanche-1a-edicao.webp"), { width: 1200, height: 1600 });
  assert.deepEqual(size("educacao-ambiental-cerrado.webp"), { width: 1400, height: 1050 });
  for (const gone of ["drink-capsula-neon.webp", "musica-capsula-noite.webp"]) {
    assert.ok(!existsSync(new URL(`../public/images/eventos/essencia-lua-cheia/${gone}`, import.meta.url)), `${gone} saiu`);
  }
});

test("parceiros: os seis, com logotipos oficiais já aprovados; Fernanda Garcia na Educação Ambiental, sem marca de outro parceiro", () => {
  assert.deepEqual(CONTENT.partners.items.map((partner) => [partner.name, partner.role]), [
    ["Alma Azul Academy", "Realização · Remada em canoa havaiana"],
    ["Cure-se Bem", "Realização · Massagem e reflexologia"],
    ["Cápsula Bar", "Realização · Local do evento"],
    ["Rapha Dantas", "Superioga"],
    ["Nutre - DF", "Lanche saudável"],
    ["Instituto Equilibraí", "Dinâmica educativa · fauna e flora do Cerrado, com Fernanda Garcia"],
  ]);
  const approved = new Set((ESSENCIA_EDITORIAL.event.partners.items as ReadonlyArray<{ logo?: { src: string } }>).map((partner) => partner.logo?.src));
  for (const partner of CONTENT.partners.items.filter((item) => item.logo)) assert.ok(approved.has(partner.logo!.src), `logo aprovado: ${partner.name}`);
  assert.equal(CONTENT.partners.items[4].logo?.src, "/images/eventos/essencia/logo-nutre.png");
  assert.equal(CONTENT.partners.items.filter((partner) => partner.logo?.src.endsWith("/logo-cure-se-bem.png")).length, 1);
  assert.equal(CONTENT.partners.items[5].logo, null, "Fernanda Garcia aparece pelo nome, sem o logo do Cure-se Bem");
  assert.ok(CONTENT.included.items.includes("Dinâmica educativa opcional sobre o Cerrado, com o Instituto Equilibraí e Fernanda Garcia"));
});

// ===========================================================================
// Visual e preservação da 1ª edição
// ===========================================================================

test("visual: tema dusk e fotos verticais; a 1ª edição segue igual", () => {
  assert.equal(CONTENT.theme, "dusk");
  assert.equal(CONTENT.program.imageShape, "portrait");
  const first = validateEventEditorial(ESSENCIA_EDITORIAL);
  assert.ok(first.success);
  if (first.success) {
    assert.equal(first.data.event.theme, null);
    assert.equal(first.data.event.spotlight, null);
    assert.ok(first.data.event.program.items.every((item) => item.parallel.length === 0));
  }
  assert.equal(editionDemoEvent(ESSENCIA_EDITION).editorial.event.theme, null);
  const bad = JSON.parse(JSON.stringify(ESSENCIA_LUA_CHEIA_EDITORIAL.event)) as { program: { items: Array<Record<string, unknown>> } };
  bad.program.items[4].parallel = [{ title: "Só uma", description: "Sozinha." }];
  assert.ok(parseEventContent(bad).errors.includes("O momento 5 precisa de pelo menos duas atividades simultâneas (ou nenhuma)."));
});

// ===========================================================================
// Scripts de cadastro gerados (só arquivos; nada executado em produção)
// ===========================================================================

const PATHS = editionCadastroPaths(ESSENCIA_LUA_CHEIA_SLUG);

test("scripts: os arquivos do repositório são exatamente os gerados da edição", () => {
  const model = { ...EDITION, registered: false };
  assert.equal(source(PATHS.preflight), editionPreflightSql(model), "rode pnpm events:edition-sql essencia-lua-cheia --modelo-local");
  assert.equal(source(PATHS.cadastro), editionCadastroSql(model));
  assert.equal(source(PATHS.postcheck), editionPostcheckSql(model));
  assert.equal(source(PATHS.rollback), editionRollbackSql(model));
  const cadastro = source(PATHS.cadastro);
  assert.deepEqual(JSON.parse(cadastro.match(/\$json\$([\s\S]*?)\$json\$/)?.[1] ?? ""), ESSENCIA_LUA_CHEIA_EDITORIAL);
  assert.match(cadastro, /'2026-11-23T20:15:00\.000Z'::timestamptz,\n {4}195,\n {4}16000,\n {4}24\n/);
  assert.doesNotMatch(cadastro, /publication_enabled = true|status = 'OPEN'|'PUBLISHED'|update public\.special_event_settings/);
  assert.match(source(PATHS.preflight), /TURMAS_REGULARES_SOBREPOSTAS/);
});

type Check = { check_name: string; result: string; status: string };

test("banco como produção: preflight → cadastro → postcheck aprovam; a 1ª edição não muda; publicada, a venda segue fechada", async () => {
  const db = await fullDatabase({ until: "202610310003_experiences_active_on_insert.sql" });
  await db.exec(PRODUCTION_ONLY);
  await applyMigration(db, "202610310004_event_publication_security.sql");
  await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
  await db.query(`update auth.users set email = $1 where id = $2::uuid`, [EDITION_ADMIN_EMAIL, ADMIN]);
  await db.exec(source("supabase/maintenance/essencia_cadastro.sql"));
  await db.exec(source("supabase/maintenance/essencia_publicacao.sql"));
  const snapshot = async () => (await db.query<Row>(`select e.status, e.editorial_content::text as content, s.status as session_status from public.experiences e join public.sessions s on s.experience_id = e.id where e.slug = 'essencia'`)).rows;
  const before = await snapshot();
  const report = async (sql: string) => new Map((await db.query<Check>(sql)).rows.map((row) => [row.check_name, row]));

  const pre = await report(source(PATHS.preflight));
  for (const [name, row] of pre) assert.notEqual(row.status, "FALHOU", `${name}: ${row.result}`);
  assert.equal(pre.get("EVENTO_CADASTRO_PREFLIGHT_OK")?.status, "OK");
  await db.exec(source(PATHS.cadastro));
  const post = await report(source(PATHS.postcheck));
  for (const [name, row] of post) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  assert.equal(post.get("SESSAO_FECHADA")?.result, "CLOSED 23/11/2026 17:15 195min 16000 centavos 24 vagas");
  assert.equal(post.get("RESERVAS_EM_BREVE")?.result, "comingSoon=true; até 6 por pedido; cancelamento até 2026-11-21T12:00:00-03:00");
  for (const key of ["OUTROS_EVENTOS", "LISTAGENS_REGULARES", "RESERVAS_POR_STATUS", "INSCRICOES_DA_LISTA_POR_STATUS"]) assert.equal(post.get(key)?.result, pre.get(key)?.result, key);
  assert.deepEqual(await snapshot(), before, "a 1ª edição não muda");

  // Simulação, só no banco de teste: publicada e com a sessão aberta, a edição continua em breve.
  const session = (await db.query<Row>(`select s.id from public.sessions s join public.experiences e on e.id = s.experience_id where e.slug = $1`, [ESSENCIA_LUA_CHEIA_SLUG])).rows[0].id as string;
  await db.query(`update public.experiences set status = 'PUBLISHED' where slug = $1`, [ESSENCIA_LUA_CHEIA_SLUG]);
  await db.query(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [session]);
  const rules = await loadSessionBookingRules(createPgliteAdmin(db).client as unknown as RulesQueryClient, session);
  assert.deepEqual(rules, { kind: "EVENT", maxPerOrder: 6, emailReady: true, visible: true, comingSoon: true });
  assert.equal(eventBookingRejection(rules, 1, true)?.code, "EVENT_BOOKING_CLOSED");
  await db.close();
});
