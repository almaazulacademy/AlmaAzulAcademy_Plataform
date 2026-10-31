/**
 * Eventos especiais — fase 4: interface pública.
 *
 * Cobre o conteúdo editorial do evento (validação e o que fica pendente), a
 * apresentação (data, horário, preço, situação das vagas e botão), a leitura
 * das linhas reais de `list_public_events` no Postgres em memória, as
 * interruptoras (`EVENTS_PUBLIC_ENABLED`, prévia só em desenvolvimento e
 * Preview) e o que as rotas e componentes prometem: 404 com a seção
 * desligada, nenhum checkout nesta fase e nenhuma fixture fora da prévia.
 *
 * Nada aqui grava no Supabase: o banco é o PGlite do próprio teste.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

import { infoParagraphs, parseEventContent, validateEventEditorial, visibleInfoItems } from "../lib/events/editorial.ts";
import {
  arrivalMatchesSession,
  cancellationWindow,
  clockText,
  deadlineDayText,
  deadlineShortText,
  deadlineTimeText,
  sessionStartClock,
} from "../lib/events/policy.ts";
import { isEventBookingOpen, isEventsDemoEnabled, isEventsPublicEnabled } from "../lib/events/flags.ts";
import { DEMO_AVAILABILITIES, ESSENCIA_CAPACITY, ESSENCIA_EDITORIAL, ESSENCIA_STARTS_AT, essenciaDemoEvent } from "../lib/events/fixtures/essencia.ts";
import {
  availabilityBadge,
  eventCta,
  eventDayLabel,
  eventLongDate,
  eventPrice,
  eventTimeRange,
  isUpcoming,
  parseAvailability,
  programTimeLabel,
  spotsLabel,
} from "../lib/events/presentation.ts";
import { mapPublicEvent, mapPublicEvents, splitEvents } from "../lib/events/public.ts";
import { navbarLinks } from "../lib/navigation.ts";
import { fullDatabase } from "./support/full-database.ts";
import { ADMIN, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ===========================================================================
// 1. Conteúdo editorial
// ===========================================================================

test("conteúdo: o ESSÊNCIA é um documento de evento completo e publicável", () => {
  const result = validateEventEditorial(ESSENCIA_EDITORIAL);
  assert.equal(result.success, true, result.success ? "" : result.errors.join("; "));
  if (!result.success) return;
  const event = result.data.event;
  assert.equal(result.data.hero.title, "ESSÊNCIA");
  assert.equal(event.subtitle, "Corpo, mente e natureza");
  assert.equal(event.badge, "Evento especial · 1ª edição");
  assert.deepEqual(event.highlights, ["Canoa havaiana", "Meditação", "Superioga"]);
  assert.deepEqual(event.program.items.map((item) => item.time), ["05:30", "07:30", "07:45", "09:00"]);
  assert.deepEqual(event.program.items[1].hosts, ["Rapha Dantas", "Fernanda Garcia"]);
  assert.deepEqual(event.program.items[2].hosts, ["Rapha Dantas"]);
  assert.equal(event.program.items[0].note, "Não é necessário ter experiência prévia.");
  assert.deepEqual(event.included.items, [
    "Canoa havaiana ao nascer do sol",
    "Meditação sensorial com aromaterapia",
    "Superioga",
    "Momento de integração",
    "Lanche saudável da Nutre",
  ]);
  assert.deepEqual(event.partners.items.map((partner) => partner.name), ["Cure-se Bem", "Alma Azul Academy", "Cápsula Bar", "Rapha Dantas", "Nutre Congelados Saudáveis"]);
  // Sem logo fornecido, sem logo inventado.
  assert.equal(event.partners.items.find((partner) => partner.name === "Rapha Dantas")?.logo, null);
});

test("conteúdo: todas as imagens do ESSÊNCIA existem no repositório e têm texto alternativo", () => {
  const images: Array<{ src: string; alt: string }> = [];
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.src === "string") images.push({ src: record.src, alt: String(record.alt ?? "") });
    for (const item of Object.values(record)) walk(item);
  };
  walk(ESSENCIA_EDITORIAL);
  assert.ok(images.length >= 8);
  for (const image of images) {
    assert.ok(image.src.startsWith("/images/"), image.src);
    assert.ok(existsSync(new URL(`../public${image.src}`, import.meta.url)), `arquivo ausente: ${image.src}`);
    assert.ok(image.alt.trim().length > 5, `alt de ${image.src}`);
  }
});

test("conteúdo: informações pendentes nunca aparecem fora da prévia", () => {
  const draft = clone(ESSENCIA_EDITORIAL) as unknown as { event: { info: { items: Array<Record<string, unknown>> }; arrival?: unknown; cancellation?: unknown } };
  draft.event.info.items = [{ title: "Restrições e recomendações", pending: true }, { id: "o-que-levar", title: "O que levar", body: "Texto confirmado." }];
  delete draft.event.arrival;
  delete draft.event.cancellation;
  const parsed = parseEventContent(draft.event);
  assert.ok(parsed.content, parsed.errors.join("; "));
  assert.deepEqual(visibleInfoItems(parsed.content!, false).map((item) => item.title), ["O que levar"]);
  assert.equal(visibleInfoItems(parsed.content!, true).length, 2);
});

test("informações do ESSÊNCIA: os sete textos aprovados, todos publicáveis", () => {
  const result = validateEventEditorial(ESSENCIA_EDITORIAL);
  assert.ok(result.success, result.success ? "" : result.errors.join("; "));
  if (!result.success) return;
  const items = result.data.event.info.items;
  assert.deepEqual(items.map((item) => item.id), ["chegada", "o-que-levar", "experiencia", "seguranca", "alimentacao", "clima", "cancelamento"]);
  assert.deepEqual(items.map((item) => item.title), [
    "Horário e chegada",
    "O que levar",
    "Preciso ter experiência anterior?",
    "Segurança durante a remada",
    "Alimentação inclusa",
    "Condições climáticas",
    "Política de cancelamento",
  ]);
  assert.ok(items.every((item) => !item.pending), "nenhum texto pendente");
  assert.equal(visibleInfoItems(result.data.event, false).length, 7);

  const byId = (id: string) => items.find((item) => item.id === id)!.body!;
  assert.deepEqual(infoParagraphs(byId("chegada")), [
    "Nossa experiência começa às 05h30, no Cápsula Bar, às margens do Lago Paranoá.",
    "Recomendamos chegar com alguns minutos de antecedência para aproveitar cada momento. Haverá tolerância de chegada até às 05h50.",
  ]);
  assert.match(byId("o-que-levar"), /Venha com roupas confortáveis, adequadas para atividades físicas\. Recomendamos trazer garrafa de água, protetor solar e seus itens pessoais\./);
  assert.match(byId("o-que-levar"), /Para participar da prática de Superioga, traga seu próprio tapete\. A organização não disponibilizará tapetes para essa atividade\./);
  // Regra antiga (materiais fornecidos pela equipe) não pode sobrar em lugar nenhum do conteúdo.
  assert.doesNotMatch(JSON.stringify(ESSENCIA_EDITORIAL), /fornecid[oa]s? pela equipe|materiais necessários/i);
  assert.match(byId("seguranca"), /O uso de colete salva-vidas é obrigatório/);
  assert.match(byId("alimentacao"), /Nutre Congelados Saudáveis/);
  assert.match(byId("clima"), /o evento será reagendado e os participantes serão comunicados pela organização/);
  assert.deepEqual(infoParagraphs(byId("cancelamento")), [
    "Você pode solicitar o cancelamento até 5 de novembro de 2026, às 12h00 (horário de Brasília), escolhendo entre crédito para utilizar em outras experiências da Alma Azul ou solicitação de reembolso com nossa equipe.",
    "Após esse prazo, entre em contato conosco para avaliação do seu caso.",
  ]);
  // A política não fala mais em vaga na próxima edição e não promete nada automático.
  const policyTexts = JSON.stringify([byId("cancelamento"), result.data.event.cancellation]);
  assert.doesNotMatch(policyTexts, /próxima edição/i);
  assert.doesNotMatch(policyTexts, /automátic|imediat|instantâne|na hora/i);

  // Nenhuma referência à antiga chegada às 05h15, em nenhum texto do evento.
  assert.doesNotMatch(JSON.stringify(ESSENCIA_EDITORIAL), /0?5h15|0?5:15/);
});

test("chegada: início às 05h30 e tolerância até 05h50, coerentes com a sessão de 05h30 às 09h", () => {
  const result = validateEventEditorial(ESSENCIA_EDITORIAL);
  assert.ok(result.success);
  if (!result.success) return;
  assert.deepEqual(result.data.event.arrival, { startTime: "05:30", toleranceUntil: "05:50" });
  assert.equal(sessionStartClock(ESSENCIA_STARTS_AT), "05:30");
  assert.equal(arrivalMatchesSession(result.data.event.arrival!, ESSENCIA_STARTS_AT, 210), true);
  // Outra sessão (06h00) não combina com a regra das 05h30.
  assert.equal(arrivalMatchesSession(result.data.event.arrival!, "2026-11-07T09:00:00.000Z", 210), false);
  // Tolerância depois do fim da sessão não combina.
  assert.equal(arrivalMatchesSession({ startTime: "05:30", toleranceUntil: "09:30" }, ESSENCIA_STARTS_AT, 210), false);
  assert.equal(clockText("05:50"), "05h50");
});

test("cancelamento: prazo inequívoco de 05/11/2026 às 12h00 de Brasília, inclusivo", () => {
  const result = validateEventEditorial(ESSENCIA_EDITORIAL);
  assert.ok(result.success);
  if (!result.success) return;
  const cancellation = result.data.event.cancellation!;
  assert.deepEqual(cancellation, { deadline: "2026-11-05T12:00:00-03:00", timeZone: "America/Sao_Paulo", summary: "crédito para utilizar em outras experiências da Alma Azul ou solicitação de reembolso com nossa equipe" });
  assert.equal(new Date(cancellation.deadline).toISOString(), "2026-11-05T15:00:00.000Z");
  assert.equal(deadlineDayText(cancellation.deadline), "5 de novembro de 2026");
  assert.equal(deadlineTimeText(cancellation.deadline), "12h00");
  assert.equal(deadlineShortText(cancellation.deadline), "05/11/2026 às 12h00 (horário de Brasília)");

  // Limites: antes, exatamente no instante e depois.
  assert.equal(cancellationWindow(cancellation, new Date("2026-11-05T11:59:59.999-03:00")), "WITHIN_DEADLINE");
  assert.equal(cancellationWindow(cancellation, new Date("2026-11-05T12:00:00.000-03:00")), "WITHIN_DEADLINE");
  assert.equal(cancellationWindow(cancellation, new Date("2026-11-05T15:00:00.000Z")), "WITHIN_DEADLINE", "o mesmo instante em UTC");
  assert.equal(cancellationWindow(cancellation, new Date("2026-11-05T12:00:00.001-03:00")), "AFTER_DEADLINE");
  assert.equal(cancellationWindow(cancellation, new Date("2026-11-05T12:00:01-03:00")), "AFTER_DEADLINE");
  // Meio-dia em outro fuso não é o prazo: 12h00 UTC são 09h00 em Brasília, ainda dentro.
  assert.equal(cancellationWindow(cancellation, new Date("2026-11-05T12:00:00Z")), "WITHIN_DEADLINE");
  assert.equal(cancellationWindow(cancellation, new Date("2026-11-06T00:00:00-03:00")), "AFTER_DEADLINE");
});

test("cancelamento e chegada: o banco de conteúdo recusa prazo ambíguo e texto divergente da regra", () => {
  const variant = (change: (event: Record<string, unknown>) => void) => {
    const copy = clone(ESSENCIA_EDITORIAL) as unknown as { event: Record<string, unknown> };
    change(copy.event);
    return parseEventContent(copy.event).errors.join(" ");
  };
  assert.match(variant((event) => { (event.cancellation as Record<string, unknown>).deadline = "2026-11-05T12:00:00"; }), /deslocamento/);
  assert.match(variant((event) => { (event.cancellation as Record<string, unknown>).deadline = "05/11/2026 12:00"; }), /deslocamento/);
  assert.match(variant((event) => { (event.cancellation as Record<string, unknown>).timeZone = "UTC"; }), /America\/Sao_Paulo/);
  // Prazo mudou e o texto não: recusado.
  assert.match(variant((event) => { (event.cancellation as Record<string, unknown>).deadline = "2026-11-06T12:00:00-03:00"; }), /6 de novembro de 2026/);
  assert.match(variant((event) => { (event.arrival as Record<string, unknown>).toleranceUntil = "06:00"; }), /06h00/);
  assert.match(variant((event) => { (event.arrival as Record<string, unknown>).toleranceUntil = "05:20"; }), /depois do início/);
  // Outra edição com outras regras e textos coerentes: aceita.
  const next = clone(ESSENCIA_EDITORIAL) as unknown as { event: Record<string, unknown> & { info: { items: Array<Record<string, unknown>> } } };
  next.event.arrival = { startTime: "06:00", toleranceUntil: "06:15" };
  next.event.cancellation = { deadline: "2027-03-10T18:00:00-03:00", timeZone: "America/Sao_Paulo", summary: "reembolso" };
  next.event.info.items = [
    { id: "chegada", title: "Horário e chegada", body: "Começamos às 06h00. Tolerância até 06h15." },
    { id: "cancelamento", title: "Política de cancelamento", body: "Cancelamento até 10 de março de 2027, às 18h00, horário de Brasília." },
  ];
  assert.deepEqual(parseEventContent(next.event).errors, []);
});

test("conteúdo: evento sem programação, com horário inválido ou fora de ordem é recusado", () => {
  const base = clone(ESSENCIA_EDITORIAL) as unknown as Record<string, Record<string, unknown>>;
  const without = clone(base);
  delete without.event;
  assert.equal(validateEventEditorial(without).success, false);

  const empty = clone(base);
  (empty.event.program as Record<string, unknown>).items = [];
  assert.match(parseEventContent(empty.event).errors.join(" "), /programação precisa/);

  const badTime = clone(base);
  ((badTime.event.program as Record<string, unknown>).items as Array<Record<string, unknown>>)[0].time = "5h30";
  assert.match(parseEventContent(badTime.event).errors.join(" "), /HH:MM/);

  const unordered = clone(base);
  ((unordered.event.program as Record<string, unknown>).items as Array<Record<string, unknown>>).reverse();
  assert.match(parseEventContent(unordered.event).errors.join(" "), /ordem de horário/);

  const noIntro = clone(base);
  (noIntro.event.intro as Record<string, unknown>).paragraphs = [];
  assert.match(parseEventContent(noIntro.event).errors.join(" "), /apresentação precisa/);

  const badImage = clone(base);
  ((badImage.event.program as Record<string, unknown>).items as Array<Record<string, unknown>>)[0].image = { src: "http://inseguro/x.jpg", alt: "x" };
  const parsed = parseEventContent(badImage.event);
  assert.equal(parsed.content?.program.items[0].image, null, "imagem fora de /images/ ou HTTPS é ignorada");
});

// ===========================================================================
// 2. Apresentação
// ===========================================================================

test("apresentação: data, horário e preço do ESSÊNCIA no horário de Brasília", () => {
  assert.equal(eventDayLabel(ESSENCIA_STARTS_AT), "07 NOV · SÁBADO");
  assert.equal(eventTimeRange(ESSENCIA_STARTS_AT, 210), "05H30 ÀS 09H");
  assert.equal(eventLongDate(ESSENCIA_STARTS_AT), "07 de novembro de 2026");
  assert.equal(eventPrice(15_000), "R$ 150");
  assert.equal(eventPrice(15_050), "R$ 150,50");
  assert.equal(programTimeLabel("07:45"), "07h45");
  assert.equal(programTimeLabel("09:00"), "09h");
});

test("apresentação: situação das vagas e botão em cada estado; nunca checkout nesta fase", () => {
  assert.deepEqual(availabilityBadge("AVAILABLE", 12, true), { label: "Vagas abertas", tone: "open" });
  assert.deepEqual(availabilityBadge("AVAILABLE", 3, true), { label: "Últimas 3 vagas", tone: "last" });
  assert.deepEqual(availabilityBadge("AVAILABLE", 1, true), { label: "Última vaga", tone: "last" });
  assert.equal(availabilityBadge("SOLD_OUT", 0, true).label, "Esgotado");
  assert.equal(availabilityBadge("CLOSED", null, true).label, "Reservas encerradas");
  assert.equal(availabilityBadge("ENDED", null, true).label, "Evento realizado");
  assert.equal(availabilityBadge("CANCELLED", null, true).label, "Evento cancelado");
  assert.equal(parseAvailability("QUALQUER"), "NO_SESSION");
  assert.deepEqual(["AVAILABLE", "SOLD_OUT", "CLOSED", "ENDED", "CANCELLED"].map((state) => isUpcoming(parseAvailability(state))), [true, true, true, false, false]);

  assert.equal(isEventBookingOpen({}), false, "a venda de eventos nasce fechada");
  const soon = eventCta({ availability: "AVAILABLE", sessionId: "s-1", ctaLabel: "Garantir minha vaga", bookingOpen: isEventBookingOpen({}) });
  assert.equal(soon.kind, "SOON");
  assert.ok(!("href" in soon));
  // Na fase 5, o mesmo botão leva ao fluxo de reserva de sempre.
  assert.deepEqual(eventCta({ availability: "AVAILABLE", sessionId: "s-1", ctaLabel: "Garantir minha vaga", bookingOpen: true }), { kind: "BOOK", label: "Garantir minha vaga", href: "/reservar/s-1" });
  for (const availability of ["SOLD_OUT", "CLOSED", "ENDED", "CANCELLED", "NO_SESSION"] as const) {
    const cta = eventCta({ availability, sessionId: "s-1", ctaLabel: "Garantir minha vaga", bookingOpen: true });
    assert.equal(cta.kind, "UNAVAILABLE", availability);
  }
  assert.equal(spotsLabel("AVAILABLE", 12), "12 vagas");
  assert.equal(spotsLabel("AVAILABLE", 1), "1 vaga");
  assert.equal(spotsLabel("SOLD_OUT", 0), "Esgotado");
  assert.equal(spotsLabel("ENDED", null), null);
});

test("prévia: o ESSÊNCIA de demonstração em todas as situações, sem sessão real", () => {
  for (const availability of DEMO_AVAILABILITIES) {
    const event = essenciaDemoEvent(availability);
    assert.equal(event.session.id, null, "a prévia nunca aponta para uma sessão de verdade");
    assert.equal(event.session.availability, availability);
    assert.equal(event.session.priceCents, 15_000);
    assert.equal(event.session.durationMinutes, 210);
  }
  assert.equal(essenciaDemoEvent("AVAILABLE").session.remainingSpots, 24);
  assert.equal(ESSENCIA_CAPACITY, 24);
  assert.equal(essenciaDemoEvent("SOLD_OUT").session.remainingSpots, 0);
  const { upcoming, past } = splitEvents([essenciaDemoEvent("AVAILABLE"), essenciaDemoEvent("ENDED")]);
  assert.equal(upcoming.length, 1);
  assert.equal(past.length, 1);
});

// ===========================================================================
// 3. Leitura das linhas reais do banco
// ===========================================================================

test("dados: a linha de list_public_events vira o evento da página, com base, sessão e vagas", async () => {
  const db = await fullDatabase();
  const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
  const created = await fx.call(
    `public.admin_create_event($1::uuid, $2::uuid, 'essencia', 'ESSÊNCIA — Corpo, Mente e Natureza', 'Canoa, meditação e Superioga', $3::jsonb, null, now() + interval '9 days', 210, 15000, $4)`,
    [ADMIN, fx.SUNSET_CONCHA.base_id, JSON.stringify(ESSENCIA_EDITORIAL), ESSENCIA_CAPACITY],
  );
  // O banco aceita o documento: a mesma régua de publicação das experiências.
  assert.equal((await db.query<Row>(`select public.experience_editorial_is_publishable($1::jsonb) as ok`, [JSON.stringify(ESSENCIA_EDITORIAL)])).rows[0].ok, true);
  await db.query(`update public.special_event_settings set publication_enabled = true`);
  await db.query(`update public.experiences set status = 'PUBLISHED' where id = $1::uuid`, [created.experienceId]);
  await db.query(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [created.sessionId]);

  const rows = (await db.query(`select * from public.list_public_events()`)).rows;
  const events = mapPublicEvents(rows);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.slug, "essencia");
  assert.equal(event.editorial.hero.title, "ESSÊNCIA");
  assert.deepEqual(event.location, {
    baseSlug: "concha-acustica",
    baseName: "Cápsula Bar — Concha Acústica",
    meetingPoint: "Em frente ao Cápsula Bar — Concha Acústica",
    address: "SHTN Trecho 1, Lote 8 — Brasília/DF",
    mapsUrl: "https://maps.app.goo.gl/ueSCiLvHAggrzuAX7",
  });
  assert.deepEqual([event.session.id, event.session.availability, event.session.remainingSpots, event.session.priceCents, event.session.durationMinutes], [created.sessionId, "AVAILABLE", 24, 15000, 210]);

  await fx.reserve(created.sessionId, 12);
  await fx.reserve(created.sessionId, 12);
  const soldOut = mapPublicEvent((await db.query(`select * from public.get_public_event('essencia')`)).rows[0]);
  assert.deepEqual([soldOut?.session.availability, soldOut?.session.remainingSpots], ["SOLD_OUT", 0]);

  // Evento publicado sem o bloco do evento: não aparece no site.
  const plain = await fx.call(
    `public.admin_create_event($1::uuid, $2::uuid, 'evento-sem-bloco', 'Sem bloco', 'x', $3::jsonb, null, now() + interval '20 days', 120, 10000, 10)`,
    [ADMIN, fx.SUNSET_CONCHA.base_id, JSON.stringify({ ...ESSENCIA_EDITORIAL, event: undefined })],
  );
  await db.query(`update public.experiences set status = 'PUBLISHED' where id = $1::uuid`, [plain.experienceId]);
  const all = (await db.query(`select * from public.list_public_events()`)).rows;
  assert.equal(all.length, 2);
  assert.deepEqual(mapPublicEvents(all).map((item) => item.slug), ["essencia"]);
  // Nenhuma experiência regular vira evento.
  assert.ok(!mapPublicEvents(all).some((item) => ["imersao-paranoa", "remada-sunset"].includes(item.slug)));
  await db.close();
});

// ===========================================================================
// 4. Interruptores, rotas e componentes
// ===========================================================================

test("interruptores: seção desligada por padrão; prévia só no desenvolvimento e no Preview", () => {
  assert.equal(isEventsPublicEnabled({}), false);
  assert.equal(isEventsPublicEnabled({ EVENTS_PUBLIC_ENABLED: "1" }), false);
  assert.equal(isEventsPublicEnabled({ EVENTS_PUBLIC_ENABLED: "true" }), true);

  assert.equal(isEventsDemoEnabled({ VERCEL_ENV: "production", NODE_ENV: "production" }), false);
  assert.equal(isEventsDemoEnabled({ VERCEL_ENV: "production", NODE_ENV: "development" }), false);
  assert.equal(isEventsDemoEnabled({ VERCEL_ENV: "preview", NODE_ENV: "production" }), true);
  assert.equal(isEventsDemoEnabled({ NODE_ENV: "development" }), true);
  assert.equal(isEventsDemoEnabled({ NODE_ENV: "production" }), false);
});

test("rotas: 404 com a seção desligada, metadados de SEO e prévia sem indexação", () => {
  const index = source("app/eventos/page.tsx");
  const detail = source("app/eventos/[slug]/page.tsx");
  for (const code of [index, detail]) {
    assert.match(code, /if \(!isEventsPublicEnabled\(\)\) notFound\(\);/);
    assert.match(code, /export const dynamic = "force-dynamic"/);
  }
  assert.match(detail, /if \(!event\) notFound\(\);/);
  assert.match(detail, /openGraph:/);
  assert.match(detail, /canonical: `\/eventos\/\$\{event\.slug\}`/);
  assert.match(detail, /bookingOpen=\{isEventBookingOpen\(\)\}/);

  for (const file of ["app/eventos/demonstracao/page.tsx", "app/eventos/demonstracao/[slug]/page.tsx"]) {
    const code = source(file);
    assert.match(code, /if \(!isEventsDemoEnabled\(\)\) notFound\(\);/, file);
    assert.match(code, /robots: \{ index: false, follow: false \}/, file);
    assert.doesNotMatch(code, /getSupabase|\.rpc\(/, `${file} não lê o banco`);
  }
  assert.match(source("app/eventos/demonstracao/[slug]/page.tsx"), /bookingOpen=\{false\}/);
  // Sem loading.tsx: com ele, o 404 da seção desligada sairia como 200.
  assert.equal(existsSync(new URL("../app/eventos/loading.tsx", import.meta.url)), false);
  assert.ok(existsSync(new URL("../app/eventos/error.tsx", import.meta.url)));
  // A prévia não entra no sitemap; os eventos só com a seção ligada.
  const sitemap = source("app/sitemap.ts");
  assert.match(sitemap, /if \(isEventsPublicEnabled\(\)\)/);
  assert.doesNotMatch(sitemap, /demonstracao/);
});

test("fixture: a demonstração só é importada pela prévia e pelos testes", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(new URL(`../${dir}`, import.meta.url))) {
      const path = `${dir}/${name}`;
      if (statSync(new URL(`../${path}`, import.meta.url)).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name) && source(path).includes("fixtures/essencia") && !path.startsWith("app/eventos/demonstracao/") && path !== "lib/events/fixtures/essencia.ts") offenders.push(path);
    }
  };
  for (const dir of ["app", "components", "lib"]) walk(dir);
  assert.deepEqual(offenders, []);
});

test("navegação e home: Eventos só aparece com a seção ligada e evento publicado", () => {
  assert.deepEqual(navbarLinks(false).map((link) => link.label), ["Experiências", "Bases", "Quem Somos", "Acompanhar reserva"]);
  assert.deepEqual(navbarLinks(true).map((link) => link.label), ["Experiências", "Eventos", "Bases", "Quem Somos", "Acompanhar reserva"]);
  const navbar = source("components/layout/navbar.tsx");
  assert.match(navbar, /isEventsPublicEnabled\(\) && \(await hasPublishedEvents\(\)/);
  assert.doesNotMatch(navbar, /"use client"/);
  const home = source("app/page.tsx");
  assert.match(home, /isEventsPublicEnabled\(\) \? listPublicEvents\(\) : Promise\.resolve\(\[\]\)/);
  assert.match(home, /\{nextEvent \? <EventHighlight event=\{nextEvent\} bookingOpen=\{isEventBookingOpen\(\)\} \/> : null\}/);
  // /experiencias/[slug] de um evento leva à página do evento, só com a seção ligada.
  assert.match(source("app/experiencias/[slug]/page.tsx"), /if \(isEventsPublicEnabled\(\) && \(await getPublicEvent\(slug\)\)\) redirect\(`\/eventos\/\$\{slug\}`\);/);
});

test("componentes: conteúdo vindo dos dados, acessível e sem nada fixo do ESSÊNCIA", () => {
  const page = source("components/events/event-page.tsx");
  const cards = source("components/events/event-card.tsx") + source("components/events/events-index.tsx") + source("components/events/event-highlight.tsx");
  for (const code of [page, cards]) {
    assert.doesNotMatch(code, /ESSÊNCIA|Rapha|Cure-se|Nutre|Fernanda/i, "nenhum conteúdo do evento fixado no componente");
  }
  assert.equal((page.match(/<h1/g) ?? []).length, 1, "um único h1 na página do evento");
  assert.match(page, /<ol className=/, "a programação é uma lista ordenada");
  assert.match(page, /<time>/);
  assert.match(page, /aria-labelledby="evento-programacao"/);
  assert.match(source("components/events/event-parts.tsx"), /disabled aria-disabled="true"/);
  // CTA fixo no celular não cobre o rodapé: a página reserva o espaço embaixo.
  assert.match(page, /pb-28 text-white lg:pb-0/);
  assert.match(page, /fixed inset-x-0 bottom-0 z-40 .* lg:hidden/);
  assert.match(page, /env\(safe-area-inset-bottom\)/);
  // Política e chegada vêm do conteúdo e ficam visíveis junto ao botão de reserva.
  assert.match(page, /id=\{item\.id \? `info-\$\{item\.id\}` : undefined\}/);
  assert.match(page, /deadlineShortText\(extra\.cancellation\.deadline\)/);
  assert.match(page, /href="#info-cancelamento"/);
  assert.match(page, /clockText\(extra\.arrival\.toleranceUntil\)/);
  assert.doesNotMatch(page, /05:50|05h50|2026-11-05/, "nenhuma regra do ESSÊNCIA fixada no componente");
});
