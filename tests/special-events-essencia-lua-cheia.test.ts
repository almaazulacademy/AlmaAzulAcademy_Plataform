/**
 * ESSÊNCIA — 2ª edição · Celebração da Lua Cheia (PR B).
 *
 * Confere o conteúdo aprovado no briefing de 13/11/2026: programação, chegada,
 * prazo de cancelamento, drink no lugar de alimentação, parceiros, fotos e
 * legendas; que a edição nasce "em breve"; que os e-mails saem com o drink e
 * sem lanche; que os scripts de cadastro gerados são os do repositório e
 * rodam num banco montado como produção (interruptor ligado, 1ª edição no ar)
 * sem tocar na 1ª edição. Nada é executado em produção.
 */

// Primeiro import: o relógio precisa estar no lugar antes de qualquer banco.
import "./support/essencia-clock.ts";

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { eventBookingRejection, eventSalesOpen, loadSessionBookingRules, type RulesQueryClient } from "../lib/events/booking.ts";
import { editionDemoEvent, editionErrors } from "../lib/events/edition.ts";
import { EVENT_EDITIONS, getEventEdition } from "../lib/events/editions.ts";
import { parseEventContent, validateEventEditorial, type EventContent } from "../lib/events/editorial.ts";
import { emailInfoItems, eventEmailMissing } from "../lib/events/email-readiness.ts";
import { ESSENCIA_EDITION, ESSENCIA_EDITORIAL } from "../lib/events/fixtures/essencia.ts";
import { ESSENCIA_LUA_CHEIA_EDITION, ESSENCIA_LUA_CHEIA_EDITORIAL, ESSENCIA_LUA_CHEIA_SLUG } from "../lib/events/fixtures/essencia-lua-cheia.ts";
import { arrivalMatchesSession, sessionStartClock } from "../lib/events/policy.ts";
import { availabilityBadge, eventCta, programItemTime } from "../lib/events/presentation.ts";
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

// ===========================================================================
// Edição e parâmetros
// ===========================================================================

test("edição: registrada pelo slug, válida, ainda não cadastrada e com os parâmetros aprovados", () => {
  assert.equal(EDITION.slug, "essencia-lua-cheia");
  assert.equal(getEventEdition(ESSENCIA_LUA_CHEIA_SLUG), EDITION);
  assert.deepEqual(EVENT_EDITIONS.map((edition) => edition.slug), ["essencia", "essencia-lua-cheia"]);
  assert.deepEqual(editionErrors(EDITION), []);
  assert.deepEqual(editionCadastroErrors(EDITION), []);
  assert.equal(EDITION.registered, false);
  assert.equal(EDITION.startsAt, "2026-11-24T18:00:00.000Z");
  assert.equal(sessionStartClock(EDITION.startsAt), "15:00", "15h em Brasília");
  assert.equal(new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long" }).format(new Date(EDITION.startsAt)), "terça-feira");
  assert.equal(EDITION.durationMinutes, 240, "das 15h ao início da confraternização, às 19h");
  assert.equal(EDITION.priceCents, 15_000);
  assert.equal(EDITION.capacity, 24);
  assert.equal(EDITION.baseSlug, "concha-acustica");
  assert.equal(CONTENT.reservation.maxPerOrder, 6);
  assert.equal(CONTENT.reservation.comingSoon, true);
  assert.equal(CONTENT.scheduleLabel, "A partir das 15h", "sem horário final inventado");
  assert.equal(CONTENT.badge, "Evento especial · 2ª edição");
  assert.equal(CONTENT.subtitle, "Celebração da Lua Cheia");
  assert.equal(parsed.success && parsed.data.hero.title, "ESSÊNCIA");
});

test("programação: os cinco momentos, na ordem, com os horários e os responsáveis confirmados", () => {
  assert.deepEqual(CONTENT.program.items.map((item) => [programItemTime(item), item.title, item.hosts]), [
    ["15h", "Recepção e boas-vindas", []],
    ["15h15", "Superioga", ["Rapha Dantas"]],
    ["16h30", "Momento de Bem-Estar", ["Cure-se Bem"]],
    ["17h30", "Remada Alma Azul · O Despertar da Lua Cheia", ["Alma Azul Academy"]],
    ["19h", "Música no Cápsula Bar", []],
  ]);
  const [reception, superioga, wellness, rowing, music] = CONTENT.program.items;
  assert.match(reception.description, /acolhimento/);
  assert.match(superioga.description, /^Movimento, energia e conexão com o corpo/);
  assert.match(wellness.description, /massagem relaxante ou reflexologia podal, associada aos benefícios dos óleos essenciais/);
  assert.match(wellness.description, /organizados pela equipe do Cure-se Bem, conforme a disponibilidade, sem escolha antecipada de modalidade/);
  assert.match(rowing.description, /pôr do sol e o despertar da Lua Cheia/);
  assert.doesNotMatch(rowing.description, /\d{1,2}h\d{0,2}|\d{1,2}:\d{2}/, "sem horário exato do nascimento da Lua");
  assert.match(music.description, /música ambiente, boas conversas e um brinde especial/);
  assert.doesNotMatch(JSON_TEXT, /\bshow\b|ao vivo/i, "não haverá show nem apresentação ao vivo");
});

test("informações: chegada às 14h50, tolerância até 15h15, prazo 22/11 12h, clima, segurança e o que levar", () => {
  assert.deepEqual(CONTENT.arrival, { startTime: "15:00", toleranceUntil: "15:15" });
  assert.ok(arrivalMatchesSession(CONTENT.arrival!, EDITION.startsAt, EDITION.durationMinutes));
  assert.deepEqual(CONTENT.cancellation, { deadline: "2026-11-22T12:00:00-03:00", timeZone: "America/Sao_Paulo", summary: "crédito para outra experiência da Alma Azul ou reembolso, pelo atendimento da nossa equipe" });
  const body = (id: string) => CONTENT.info.items.find((item) => item.id === id)?.body ?? "";
  assert.deepEqual(CONTENT.info.items.map((item) => item.id), ["chegada", "o-que-levar", "seguranca", "drink", "clima", "cancelamento"]);
  assert.match(body("chegada"), /14h50/);
  assert.match(body("chegada"), /15h00/);
  assert.match(body("chegada"), /até 15h15/);
  for (const thing of ["Tapete próprio para a prática de Superioga", "roupas leves e confortáveis", "garrafa de água", "muda de roupa para depois da remada"]) assert.match(body("o-que-levar"), new RegExp(thing));
  assert.match(body("seguranca"), /canoas havaianas/);
  assert.match(body("seguranca"), /colete salva-vidas/);
  assert.match(body("seguranca"), /condições seguras de navegação/);
  assert.match(body("clima"), /o evento inteiro será reagendado/);
  assert.match(body("clima"), /não é realizado em versão parcial/);
  assert.match(body("cancelamento"), /22 de novembro de 2026, às 12h00 \(horário de Brasília\)/);
  assert.match(body("cancelamento"), /crédito para outra experiência da Alma Azul ou reembolso/);
  assert.doesNotMatch(JSON_TEXT, /automátic/i, "não promete automação");
  assert.ok(CONTENT.info.items.every((item) => !item.pending));
});

test("sem alimentação: nenhum lanche, café da manhã ou texto de alimentação; o drink no lugar", () => {
  assert.ok(!CONTENT.info.items.some((item) => item.id === "alimentacao"));
  assert.doesNotMatch(JSON_TEXT, /lanche|café da manhã|alimenta|Nutre/i);
  assert.ok(CONTENT.included.items.includes("1 drink de cortesia, com ou sem álcool"));
  const drink = CONTENT.info.items.find((item) => item.id === "drink");
  assert.equal(drink?.email, true);
  assert.match(drink?.body ?? "", /1 drink de cortesia, com ou sem álcool, oferecido pelo Cápsula Bar/);
  assert.match(drink?.body ?? "", /não tem cobrança adicional de entrada ou couvert/);
  // Destaque do drink: celebração, sem sugerir álcool obrigatório.
  assert.equal(CONTENT.spotlight?.eyebrow, "Um drink para brindar");
  assert.equal(CONTENT.spotlight?.note, "Com ou sem álcool, à sua escolha.");
  assert.ok(CONTENT.spotlight?.paragraphs.some((paragraph) => paragraph.includes("incluído no ingresso")));
});

test("e-mail: drink, sem lanche, chegada, prazo e programação; pronto para vender", () => {
  assert.deepEqual(eventEmailMissing(CONTENT), []);
  assert.deepEqual(emailInfoItems(CONTENT).map((item) => item.title), ["O que levar", "Segurança na remada", "Um drink para brindar", "Condições climáticas"]);
  const emails = new Map(editionPreviewEmails(ESSENCIA_LUA_CHEIA_SLUG));
  const confirmation = emails.get("confirmacao")!;
  assert.equal(confirmation.subject, "Ingresso confirmado — ESSÊNCIA — 2ª edição · Celebração da Lua Cheia · DEMOEDICAO");
  for (const text of [
    "Data: terça-feira, 24 de novembro de 2026",
    "Início: 15h00",
    "Tolerância de chegada: até 15h15",
    "- 15h — Recepção e boas-vindas",
    "- 15h15 — Superioga (com Rapha Dantas)",
    "- 16h30 — Momento de Bem-Estar (com Cure-se Bem)",
    "- 17h30 — Remada Alma Azul · O Despertar da Lua Cheia (com Alma Azul Academy)",
    "- 19h — Música no Cápsula Bar",
    "UM DRINK PARA BRINDAR",
    "1 drink de cortesia, com ou sem álcool",
    "Prazo: 22/11/2026 às 12h00 (horário de Brasília).",
  ]) assert.ok(confirmation.text.includes(text), `confirmação sem: ${text}`);
  for (const [name, message] of emails) {
    if (!message) continue;
    for (const absent of ["Lanche", "lanche", "Alimentação", "Encerramento previsto", "1 dia antes", "roupa de banho"]) {
      assert.ok(!message.text.includes(absent) && !message.html.includes(absent), `${name} não pode citar: ${absent}`);
    }
  }
  // A prévia só gera arquivos: não há envio neste script.
  const script = source("scripts/email/event-edition-preview.ts");
  assert.doesNotMatch(script, /getEmailProvider|\.send\(|getSupabase|\.rpc\(/);
  assert.match(source("package.json"), /"email:preview:edicao":/);
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
  CONTENT.intro.image!, ...CONTENT.program.items.map((item) => item.image!), CONTENT.spotlight!.image!, CONTENT.reservation.image!,
  CONTENT.heroImageMobile!, CONTENT.cardImage!, parsed.success ? parsed.data.hero.image : null!,
];

test("fotos: todas existem, sem metadados, as da 1ª edição legendadas e nunca ampliadas", () => {
  for (const image of IMAGES) {
    assert.ok(image.alt.length > 20, `texto alternativo descritivo: ${image.src}`);
    const path = new URL(`../public${image.src}`, import.meta.url);
    assert.ok(existsSync(path), image.src);
    if (image.src.startsWith("/images/eventos/essencia-lua-cheia/")) {
      const bytes = readFileSync(path);
      assert.ok(!bytes.includes(Buffer.from("Exif")) && !bytes.includes(Buffer.from("GPS")), `sem EXIF/GPS: ${image.src}`);
      assert.ok(bytes.length < 400 * 1024, `leve: ${image.src}`);
    }
  }
  const credits = Object.fromEntries(CONTENT.program.items.map((item) => [item.title, item.image?.credit ?? null]));
  assert.deepEqual(credits, {
    "Recepção e boas-vindas": null,
    Superioga: FIRST_EDITION,
    "Momento de Bem-Estar": FIRST_EDITION,
    "Remada Alma Azul · O Despertar da Lua Cheia": "Remada Sunset · Alma Azul Academy",
    "Música no Cápsula Bar": null,
  });
  assert.equal(parsed.success && parsed.data.hero.image.credit, "Remada da Lua Cheia · Alma Azul Academy", "a foto do Hero não parece desta edição");
  // As fotos da 1ª edição vieram do WhatsApp (720 px): ficam no tamanho original.
  for (const name of ["superioga-1a-edicao.webp", "bem-estar-1a-edicao.webp"]) {
    assert.deepEqual(webpSize(readFileSync(new URL(`../public/images/eventos/essencia-lua-cheia/${name}`, import.meta.url))), { width: 720, height: 900 }, name);
  }
  assert.deepEqual(webpSize(readFileSync(new URL("../public/images/eventos/essencia-lua-cheia/hero-lua-desktop.webp", import.meta.url))), { width: 2400, height: 1350 });
  assert.deepEqual(webpSize(readFileSync(new URL("../public/images/eventos/essencia-lua-cheia/hero-lua-mobile.webp", import.meta.url))), { width: 1080, height: 1920 });
});

test("parceiros: os quatro, com os logotipos oficiais já usados na 1ª edição, sem alteração", () => {
  assert.deepEqual(CONTENT.partners.items.map((partner) => partner.name), ["Alma Azul Academy", "Cure-se Bem", "Cápsula Bar", "Rapha Dantas"]);
  const firstEditionLogos = new Set((ESSENCIA_EDITORIAL.event.partners.items as ReadonlyArray<{ logo?: { src: string } }>).map((partner) => partner.logo?.src));
  for (const partner of CONTENT.partners.items) {
    assert.ok(partner.logo, partner.name);
    assert.ok(firstEditionLogos.has(partner.logo!.src), `logo da 1ª edição: ${partner.name}`);
  }
  assert.doesNotMatch(JSON_TEXT, /patrocin/i);
});

// ===========================================================================
// Visual: tema, destaque e fotos verticais — opcionais, a 1ª edição não muda
// ===========================================================================

test("visual: tema dusk, destaque e fotos verticais só nesta edição; a 1ª edição segue igual", () => {
  assert.equal(CONTENT.theme, "dusk");
  assert.equal(CONTENT.program.imageShape, "portrait");
  const first = validateEventEditorial(ESSENCIA_EDITORIAL);
  assert.ok(first.success);
  if (first.success) {
    assert.equal(first.data.event.theme, null);
    assert.equal(first.data.event.spotlight, null);
    assert.equal(first.data.event.program.imageShape, null);
  }
  assert.deepEqual(editionDemoEvent(ESSENCIA_EDITION).editorial.event.theme, null);

  const bad = JSON.parse(JSON.stringify(ESSENCIA_LUA_CHEIA_EDITORIAL.event)) as Record<string, unknown> & { program: Record<string, unknown> };
  bad.theme = "neon";
  bad.program.imageShape = "redonda";
  bad.spotlight = { title: "Sem texto" };
  const errors = parseEventContent(bad).errors;
  assert.ok(errors.some((error) => error.startsWith('Tema "neon" desconhecido')));
  assert.ok(errors.some((error) => error.startsWith('Formato de foto da programação "redonda" desconhecido')));
  assert.ok(errors.includes("O destaque precisa de pelo menos um parágrafo."));

  const page = source("components/events/event-page.tsx");
  // Sem tema, as mesmas classes de antes (1ª edição).
  assert.ok(page.includes('heroShade: "bg-[linear-gradient(180deg,rgba(13,21,20,0.6)_0%,rgba(13,21,20,0.45)_35%,rgba(13,21,20,0.94)_100%)] sm:bg-[linear-gradient(180deg,rgba(13,21,20,0.55)_0%,rgba(13,21,20,0.25)_35%,rgba(13,21,20,0.92)_100%)]"'));
  assert.ok(page.includes('program: "border-t border-white/10"'));
  assert.ok(page.includes('info: "bg-night"'));
  assert.match(page, /const theme = THEMES\[extra\.theme \?\? "default"\];/);
  assert.match(page, /if \(!dusk\) return <span aria-hidden="true" className="absolute -left-\[5px\] top-3 size-\[9px\] rounded-full bg-ember" \/>;/);
  assert.match(page, /portrait \? "aspect-\[4\/5\] w-full max-w-md justify-self-center" : "aspect-\[4\/3\]"/);
  assert.match(page, /\{extra\.spotlight \? \(/);
  assert.match(page, /extra\.partners\.items\.length <= 4 \? "lg:grid-cols-4" : "lg:grid-cols-5"/);
});

test("prévia: a rota genérica mostra a edição, sem banco e sem checkout", () => {
  const detail = source("app/eventos/demonstracao/[slug]/page.tsx");
  assert.match(detail, /getEventEdition\(\(await params\)\.slug\)/);
  assert.match(detail, /bookingOpen=\{false\}/);
  const demo = editionDemoEvent(EDITION);
  assert.equal(demo.slug, "essencia-lua-cheia");
  assert.equal(demo.session.id, null, "sem sessão: o botão nunca leva ao checkout");
});

// ===========================================================================
// Scripts de cadastro gerados (só arquivos; nada executado em produção)
// ===========================================================================

const PATHS = editionCadastroPaths(ESSENCIA_LUA_CHEIA_SLUG);

test("scripts: os arquivos do repositório são exatamente os gerados da edição", () => {
  assert.equal(source(PATHS.preflight), editionPreflightSql(EDITION), "rode pnpm events:edition-sql essencia-lua-cheia");
  assert.equal(source(PATHS.cadastro), editionCadastroSql(EDITION));
  assert.equal(source(PATHS.postcheck), editionPostcheckSql(EDITION));
  assert.equal(source(PATHS.rollback), editionRollbackSql(EDITION));
  const cadastro = source(PATHS.cadastro);
  assert.deepEqual(JSON.parse(cadastro.match(/\$json\$([\s\S]*?)\$json\$/)?.[1] ?? ""), ESSENCIA_LUA_CHEIA_EDITORIAL);
  assert.match(cadastro, /'2026-11-24T18:00:00\.000Z'::timestamptz,\n {4}240,\n {4}15000,\n {4}24\n/);
  assert.doesNotMatch(cadastro, /publication_enabled = true|status = 'OPEN'|'PUBLISHED'|update public\.special_event_settings/);
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
  for (const [name, row] of pre) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  await db.exec(source(PATHS.cadastro));
  const post = await report(source(PATHS.postcheck));
  for (const [name, row] of post) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  assert.equal(post.get("SESSAO_FECHADA")?.result, "CLOSED 24/11/2026 15:00 240min 15000 centavos 24 vagas");
  assert.equal(post.get("RESERVAS_EM_BREVE")?.result, "comingSoon=true; até 6 por pedido; cancelamento até 2026-11-22T12:00:00-03:00");
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
