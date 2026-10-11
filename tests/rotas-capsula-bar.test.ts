import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { isExperienceBookable } from "../lib/bases/availability.ts";
import { FALLBACK_COMING_SOON_EXPERIENCES, renamedExperienceRedirect, RENAMED_EXPERIENCE_SLUGS } from "../lib/bases/catalog.ts";
import { CONCHA_LANDING } from "../lib/bases/concha-landing.ts";
import { validateExperienceEditorial } from "../lib/editorial/experience.ts";
import { sheetExperienceTitle } from "../lib/integrations/google-sheets/mapping.ts";
import { applyMigration, fullDatabase } from "./support/full-database.ts";

const ROUTES = "202610120001_rotas_capsula_bar.sql";
const TEXT_FIX = "202610120002_rota_ermida_texto.sql";
const BEFORE_ROUTES = "202610080001_capsula_bar_launch.sql";
const ADMIN = "00000000-0000-4000-8000-00000000000a";
const NAMES = { "rota-ermida-ponte-jk": "Rota Ermida Ponte JK", "rota-prainha-do-congresso": "Rota Prainha do Congresso" } as const;
const SLUGS = Object.keys(NAMES) as Array<keyof typeof NAMES>;

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const migration = source(`supabase/migrations/${ROUTES}`);
const executable = migration.replace(/^\s*--.*$/gm, "");

type Row = Record<string, unknown>;

async function rows(db: PGlite, sql: string, params: unknown[] = []) {
  return (await db.query<Row>(sql, params)).rows;
}

async function one(db: PGlite, sql: string, params: unknown[] = []) {
  const [row] = await rows(db, sql, params);
  assert.ok(row, `sem resultado: ${sql}`);
  return row;
}

/** Impressão digital de tudo o que não é uma das duas rotas. */
async function untouched(db: PGlite) {
  return rows(db, `
    select e.id, e.slug, e.title, e.status, e.price_cents, e.duration_minutes, e.default_capacity, e.image_url,
           e.modality, e.editorial_content::text as editorial, e.base_id,
           (select count(*) from public.sessions s where s.experience_id = e.id) as sessions
    from public.experiences e
    where e.slug not like '%rota-%'
    order by e.slug`);
}

async function withAdmin(db: PGlite) {
  await db.exec(`
    insert into auth.users (id) values ('${ADMIN}');
    insert into public.admin_users (user_id, display_name, role, is_active) values ('${ADMIN}', 'Admin', 'ADMIN', true);`);
  return db;
}

/** Publica pela mesma RPC do botão "Ativar" do painel, reenviando o cadastro como ele está. */
async function publish(db: PGlite, slug: string) {
  const e = await one(db, "select * from public.experiences where slug = $1", [slug]);
  return one(db, "select public.admin_update_experience($1,$2,$3,$4,'PUBLISHED',$5,$6,$7,$8,$9,$10,$11,$12) as ok", [
    ADMIN, e.id, e.title, e.summary, e.image_url ?? "", e.display_order, e.description, e.duration_minutes, e.price_cents,
    e.default_capacity, JSON.stringify(e.editorial_content), e.base_id,
  ]);
}

test("migration das rotas é aditiva: sem sessão, sem publicação e sem tocar RPCs", () => {
  for (const forbidden of [
    /\bdrop\s/i, /\bdelete\s+from\b/i, /\btruncate\b/i, /insert\s+into/i, /create\s+(or\s+replace\s+)?function/i,
    /public\.sessions/i, /public\.reservations/i, /'PUBLISHED'/, /price_cents/i, /default_capacity/i, /duration_minutes/i,
  ]) {
    assert.equal(forbidden.test(executable), false, String(forbidden));
  }
});

test("as duas rotas ganham nome e slug próprios no mesmo registro, ainda em breve", async () => {
  const before = await fullDatabase({ until: BEFORE_ROUTES });
  const ids = await rows(before, "select id, slug, price_cents, duration_minutes, default_capacity from public.experiences where slug like 'caminhos-do-paranoa-rota-%' order by slug");
  assert.equal(ids.length, 2);
  const others = await untouched(before);
  await applyMigration(before, ROUTES);
  const db = before;

  const routes = await rows(db, `
    select e.id, e.slug, e.title, e.status, e.modality, e.price_cents, e.duration_minutes, e.default_capacity, e.image_url,
           b.slug as base_slug, public.experience_editorial_is_publishable(e.editorial_content) as publishable
    from public.experiences e join public.bases b on b.id = e.base_id
    where e.slug like 'rota-%' order by e.slug`);
  assert.deepEqual(routes.map((route) => route.slug), SLUGS);
  for (const [index, route] of routes.entries()) {
    assert.equal(route.title, NAMES[route.slug as keyof typeof NAMES]);
    assert.equal(route.id, ids[index].id, "o registro é o mesmo");
    assert.equal(route.modality, route.slug);
    assert.equal(route.base_slug, "concha-acustica");
    assert.equal(route.status, "COMING_SOON");
    assert.equal(route.publishable, true);
    assert.deepEqual(
      [route.price_cents, route.duration_minutes, route.default_capacity],
      [ids[index].price_cents, ids[index].duration_minutes, ids[index].default_capacity],
    );
    // O cadastro e a landing dizem a mesma duração: 90 minutos.
    assert.equal(route.duration_minutes, 90);
  }
  assert.notEqual(routes[0].image_url, routes[1].image_url);
  // O nome antigo saiu do cadastro; nenhuma sessão nasceu e o resto ficou idêntico.
  assert.equal((await rows(db, "select 1 from public.experiences where slug like 'caminhos%' or title ilike '%caminhos%' or modality like 'caminhos%'")).length, 0);
  assert.equal((await rows(db, "select 1 from public.sessions s join public.experiences e on e.id = s.experience_id where e.slug like 'rota-%'")).length, 0);
  assert.deepEqual(await untouched(db), others);
  const comingSoon = await rows(db, "select slug from public.experiences where slug in ('remada-nascer-do-sol-concha-acustica','remada-lua-cheia-concha-acustica') and status = 'COMING_SOON'");
  assert.equal(comingSoon.length, 2);
});

test("landing das rotas: completa, com 1h30 e iniciantes, sem o nome antigo, horário fixo ou preço", async () => {
  const db = await fullDatabase();
  for (const slug of SLUGS) {
    const row = await one(db, "select editorial_content from public.experiences where slug = $1", [slug]);
    const validation = validateExperienceEditorial(row.editorial_content, true);
    assert.equal(validation.success, true, validation.success ? "" : validation.errors.join(" "));
    const editorial = row.editorial_content as { about: { title: string }; seo: { title: string } };
    assert.equal(editorial.about.title, NAMES[slug]);
    assert.ok(editorial.seo.title.startsWith(NAMES[slug]));

    const copy = JSON.stringify(row.editorial_content);
    const text = copy.replace(/\/images\/[^"]+/g, "");
    assert.doesNotMatch(text, /caminhos/i);
    assert.match(text, /Confira as próximas datas e horários disponíveis/);
    assert.match(text, /Cápsula Bar/);
    // Confirmado pela operação: 1h30 de duração e adequada para iniciantes.
    const facts = Object.fromEntries((row.editorial_content as { quickFacts: Array<{ label: string; value: string }> }).quickFacts.map((fact) => [fact.label, fact.value]));
    assert.equal(facts["Duração"], "1h30");
    assert.equal(facts["Nível"], "Iniciantes são bem-vindos");
    assert.match(text, /Não é preciso ter experiência anterior/);
    assert.match(text, /Colete salva-vidas/);
    // Sem horário fixo, distância ou preço: isso é da sessão, definida no painel.
    for (const forbidden of [/\b\d{1,2}h(?!30\b)/, /\b\d{1,2}:\d{2}\b/, /\bkm\b/i, /R\$/, /Lago Norte|QL 5/, /https?:\/\//, /manh[ãa]|tarde|noite/i]) {
      assert.equal(forbidden.test(text), false, `${slug}: ${forbidden}`);
    }
    for (const path of copy.match(/\/images\/[^"]+/g) ?? []) {
      assert.doesNotThrow(() => readFileSync(new URL(`../public${path}`, import.meta.url)), path);
    }
  }
});

test("reaplicar não sobrescreve o painel, e os slugs antigos não voltam a existir", async () => {
  const db = await fullDatabase();
  await db.exec(`
    update public.experiences set title = 'Rota JK (editada)', editorial_content = jsonb_build_object('version', 1, 'nota', 'painel'), image_url = '/images/outra.webp'
      where slug = 'rota-ermida-ponte-jk';`);
  await applyMigration(db, ROUTES);
  // A migration de lançamento tentaria recriar a Rota Prainha pelo slug antigo: é recusada por inteiro.
  await assert.rejects(applyMigration(db, BEFORE_ROUTES), /experiences_retired_slugs/);
  await assert.rejects(db.exec("update public.experiences set slug = 'caminhos-do-paranoa-rota-ermida-ponte-jk' where slug = 'rota-ermida-ponte-jk'"), /experiences_retired_slugs/);
  await applyMigration(db, ROUTES);

  const route = await one(db, "select title, image_url, editorial_content->>'nota' as nota from public.experiences where slug = 'rota-ermida-ponte-jk'");
  assert.deepEqual([route.title, route.image_url, route.nota], ["Rota JK (editada)", "/images/outra.webp", "painel"]);
  const capsula = await rows(db, "select e.slug from public.experiences e join public.bases b on b.id = e.base_id where b.slug = 'concha-acustica'");
  assert.equal(capsula.length, 5);
  assert.equal(capsula.some((row) => String(row.slug).startsWith("caminhos")), false);
  assert.equal((await rows(db, "select 1 from pg_constraint where conname = 'experiences_retired_slugs'")).length, 1);
});

test("rota com sessões e reservas mantém tudo ligado depois da troca de slug", async () => {
  const db = await withAdmin(await fullDatabase({ until: BEFORE_ROUTES }));
  const old = await one(db, "select id from public.experiences where slug = 'caminhos-do-paranoa-rota-ermida-ponte-jk'");
  const session = await one(db, "select public.admin_create_session($1,$2, now() + interval '9 days', 120, 8500, 10, 'OPEN', '') as id", [ADMIN, old.id]);
  // Reserva confirmada antes da troca (a rota é publicada só para o teste conseguir reservar).
  await db.exec("update public.experiences set editorial_content = (select editorial_content from public.experiences where slug = 'remada-sunset-concha-acustica'), status = 'PUBLISHED' where slug = 'caminhos-do-paranoa-rota-ermida-ponte-jk'");
  const reservation = (await one(db, "select public.create_pre_reservation($1,'Cliente de Teste','12345678901','61999990000','a@exemplo.com',3,'',$2) as data", [session.id, randomUUID()])).data as { reservationId: string; publicCode: string };
  await one(db, "select public.confirm_reservation_payment($1,'INFINITEPAY',$2,25500,'', '{}'::jsonb) as ok", [reservation.reservationId, randomUUID()]);
  const before = await one(db, "select id, public_code, session_id, experience_id, status, quantity, checkin_token, confirmed_at from public.reservations where id = $1", [reservation.reservationId]);

  await applyMigration(db, ROUTES);

  const kept = await one(db, "select e.id, e.slug, e.status, s.price_cents, s.capacity, s.duration_minutes from public.sessions s join public.experiences e on e.id = s.experience_id where s.id = $1", [session.id]);
  assert.deepEqual([kept.id, kept.slug, kept.status, kept.price_cents, kept.capacity, kept.duration_minutes], [old.id, "rota-ermida-ponte-jk", "PUBLISHED", 8500, 10, 120]);
  // A reserva é a mesma linha, ligada à mesma sessão e à mesma experiência, e continua consultável.
  assert.deepEqual(await one(db, "select id, public_code, session_id, experience_id, status, quantity, checkin_token, confirmed_at from public.reservations where id = $1", [reservation.reservationId]), before);
  assert.equal(before.experience_id, old.id);
  assert.equal((await one(db, "select public.available_spots($1) as spots", [session.id])).spots, 7);
  const email = (await one(db, "select public.reservation_confirmation_email($1) as data", [reservation.reservationId])).data as Row;
  assert.equal(email.experienceTitle, "Rota Ermida Ponte JK");
  assert.equal(email.publicCode, reservation.publicCode);
  assert.equal((await rows(db, "select 1 from public.payment_events where reservation_id = $1", [reservation.reservationId])).length >= 1, true);
});

test("painel: ativar a rota abre o fluxo de reserva existente, com horário, preço e vagas da sessão", async () => {
  const db = await withAdmin(await fullDatabase());
  const route = await one(db, "select id from public.experiences where slug = 'rota-prainha-do-congresso'");
  // Sessão criada pelo painel com a rota ainda "em breve": existe, mas não aparece no site.
  const morning = await one(db, "select public.admin_create_session($1,$2, date_trunc('day', now()) + interval '6 days 12 hours 30 minutes', 150, 9000, 8, 'OPEN', '') as id", [ADMIN, route.id]);
  const afternoon = await one(db, "select public.admin_create_session($1,$2, date_trunc('day', now()) + interval '7 days 18 hours', 100, 6000, 6, 'OPEN', '') as id", [ADMIN, route.id]);
  assert.equal((await rows(db, "select 1 from public.list_open_sessions('rota-prainha-do-congresso')")).length, 0);
  await assert.rejects(
    db.query("select public.create_pre_reservation($1,'Cliente de Teste','12345678901','61999990000','a@exemplo.com',1,'',$2)", [morning.id, randomUUID()]),
    /EXPERIENCE_UNAVAILABLE/,
  );

  assert.equal((await publish(db, "rota-prainha-do-congresso")).ok, true);

  const open = await rows(db, "select id, price_cents, duration_minutes, remaining_spots from public.list_open_sessions('rota-prainha-do-congresso') order by starts_at");
  assert.deepEqual(open.map((item) => [item.id, item.price_cents, item.duration_minutes, item.remaining_spots]), [
    [morning.id, 9000, 150, 8],
    [afternoon.id, 6000, 100, 6],
  ]);

  // Reserva, pagamento, e-mail, QR e planilha: as mesmas RPCs, com a base da rota.
  const reservation = (await one(db, "select public.create_pre_reservation($1,'Cliente de Teste','12345678901','61999990000','a@exemplo.com',2,'',$2) as data", [morning.id, randomUUID()])).data as { reservationId: string; totalCents: number };
  assert.equal(reservation.totalCents, 18000);
  assert.equal((await one(db, "select public.confirm_reservation_payment($1,'INFINITEPAY',$2,18000,'', '{}'::jsonb) as ok", [reservation.reservationId, randomUUID()])).ok, true);
  assert.equal((await one(db, "select public.available_spots($1) as spots", [morning.id])).spots, 6);

  const email = (await one(db, "select public.reservation_confirmation_email($1) as data", [reservation.reservationId])).data as Row;
  assert.equal(email.experienceTitle, "Rota Prainha do Congresso");
  assert.equal(email.baseSlug, "concha-acustica");
  assert.equal(email.durationMinutes, 150);
  const token = (await one(db, "select checkin_token from public.reservations where id = $1", [reservation.reservationId])).checkin_token;
  const ticket = (await one(db, "select public.public_checkin_ticket($1) as data", [token])).data as Row;
  assert.equal(ticket.experienceTitle, "Rota Prainha do Congresso");
  const block = (await one(db, "select public.google_sheets_session_block($1) as data", [morning.id])).data as Row;
  assert.equal(sheetExperienceTitle(block), "Rota Prainha do Congresso · Cápsula Bar — Concha Acústica");

  // Limite de vagas da sessão continua valendo.
  await assert.rejects(
    db.query("select public.create_pre_reservation($1,'Outro Cliente','98765432100','61999990001','b@exemplo.com',7,'',$2)", [morning.id, randomUUID()]),
    /INSUFFICIENT_SPOTS/,
  );
  // A outra rota e as demais "em breve" não abriram junto.
  const statuses = await rows(db, "select e.slug, e.status from public.experiences e join public.bases b on b.id = e.base_id where b.slug = 'concha-acustica' order by e.slug");
  assert.deepEqual(statuses.filter((item) => item.status === "PUBLISHED").map((item) => item.slug), ["remada-sunset-concha-acustica", "rota-prainha-do-congresso"]);
});

test("site: um card por rota, com link próprio e selo conforme o status", () => {
  const cards = CONCHA_LANDING.experiences.items.filter((item) => item.title.startsWith("Rota "));
  assert.deepEqual(cards.map((card) => card.title), Object.values(NAMES));
  assert.notEqual(cards[0].image.src, cards[1].image.src);
  for (const [index, card] of cards.entries()) {
    // Slug novo primeiro; o antigo cobre o intervalo entre o deploy e a migration.
    assert.equal(card.slugs[0], SLUGS[index]);
    assert.equal(RENAMED_EXPERIENCE_SLUGS[card.slugs[1]], SLUGS[index]);
    assert.equal(card.slugs.length, 2);
  }
  assert.equal(CONCHA_LANDING.experiences.items.some((item) => /caminhos/i.test(item.title + item.summary)), false);

  const landing = source("components/bases/concha-landing.tsx");
  // O selo vem do status da experiência do card, nunca fixo.
  assert.match(landing, /\{open \? <ActiveBaseBadge tone="dark" \/> : <ComingSoonBadge tone="dark" \/>\}/);
  assert.match(landing, /href=\{`\/experiencias\/\$\{open\.slug\}`\}/);
  assert.equal((landing.match(/<ComingSoonBadge/g) ?? []).length, 2);

  const base = { status: "ACTIVE" as const };
  assert.equal(isExperienceBookable({ status: "COMING_SOON" }, base), false);
  assert.equal(isExperienceBookable({ status: "PUBLISHED" }, base), true);

  // Contingência sem banco: as duas rotas com os nomes oficiais, sem reserva.
  const fallback = FALLBACK_COMING_SOON_EXPERIENCES.filter((item) => item.slug.startsWith("rota-"));
  assert.deepEqual(fallback.map((item) => [item.slug, item.title, item.status]), SLUGS.map((slug) => [slug, NAMES[slug], "COMING_SOON"]));
});

test("URLs antigas redirecionam para as novas só quando o slug antigo já não existe", () => {
  assert.deepEqual(RENAMED_EXPERIENCE_SLUGS, {
    "caminhos-do-paranoa-rota-ermida-ponte-jk": "rota-ermida-ponte-jk",
    "caminhos-do-paranoa-rota-prainha-do-congresso": "rota-prainha-do-congresso",
  });
  const page = source("app/experiencias/[slug]/page.tsx");
  const comingSoon = page.indexOf("return <ComingSoonExperience");
  for (const [old, current] of Object.entries(RENAMED_EXPERIENCE_SLUGS)) {
    // Antes da migration o slug antigo ainda existe: a página dele é servida, sem redirecionar.
    assert.equal(renamedExperienceRedirect(old, true), null);
    // Depois da migration ele some do catálogo: 308 para a URL nova.
    assert.equal(renamedExperienceRedirect(old, false), `/experiencias/${current}`);
    // A URL nova nunca redireciona, exista ou não.
    assert.equal(renamedExperienceRedirect(current, true), null);
    assert.equal(renamedExperienceRedirect(current, false), null);
  }
  assert.equal(renamedExperienceRedirect("caminhos-do-paranoa", false), null);
  assert.equal(renamedExperienceRedirect("remada-sunset-concha-acustica", false), null);
  const redirect = page.indexOf("permanentRedirect(renamed)");
  assert.match(page, /renamedExperienceRedirect\(slug, Boolean\(upcoming\)\)/);
  assert.ok(comingSoon > 0 && redirect > comingSoon, "a experiência existente é servida antes do redirecionamento");
  assert.ok(page.indexOf("if (!experience) notFound()") > redirect);
});

test("Rota Ermida Ponte JK: a remada vai até a Ermida, com banho, e a ponte é vista — não percorrida", async () => {
  const before = await fullDatabase({ until: ROUTES });
  const others = await rows(before, "select id, slug, title, summary, description, status, editorial_content::text as editorial from public.experiences where slug <> 'rota-ermida-ponte-jk' order by slug");
  const fixed = await rows(before, "select id, slug, title, status, price_cents, duration_minutes, default_capacity, image_url, modality from public.experiences where slug = 'rota-ermida-ponte-jk'");
  await applyMigration(before, TEXT_FIX);
  await applyMigration(before, TEXT_FIX);
  const db = before;

  const route = await one(db, "select summary, description, editorial_content, public.experience_editorial_is_publishable(editorial_content) as publishable from public.experiences where slug = 'rota-ermida-ponte-jk'");
  const text = `${route.summary} ${route.description} ${JSON.stringify(route.editorial_content).replace(/\/images\/[^"]+/g, "")}`;
  assert.equal(route.publishable, true);
  assert.equal(validateExperienceEditorial(route.editorial_content, true).success, true);
  assert.doesNotMatch(text, /pela Ponte JK/);
  assert.match(text, /até a prainha da Ermida Dom Bosco/);
  assert.match(text, /banho/);
  assert.match(text, /Ponte JK/);
  assert.equal(route.summary, CONCHA_LANDING.experiences.items[0].summary);
  assert.equal(route.summary, FALLBACK_COMING_SOON_EXPERIENCES.find((item) => item.slug === "rota-ermida-ponte-jk")?.summary);
  // Só texto, só nesta rota.
  assert.deepEqual(await rows(db, "select id, slug, title, status, price_cents, duration_minutes, default_capacity, image_url, modality from public.experiences where slug = 'rota-ermida-ponte-jk'"), fixed);
  assert.deepEqual(await rows(db, "select id, slug, title, summary, description, status, editorial_content::text as editorial from public.experiences where slug <> 'rota-ermida-ponte-jk' order by slug"), others);

  // Texto já editado pelo painel não é sobrescrito.
  const edited = await fullDatabase({ until: ROUTES });
  await edited.exec("update public.experiences set summary = 'Resumo do painel', editorial_content = jsonb_set(editorial_content, '{hero,title}', '\"Título do painel\"') where slug = 'rota-ermida-ponte-jk'");
  await applyMigration(edited, TEXT_FIX);
  const kept = await one(edited, "select summary, editorial_content #>> '{hero,title}' as title, editorial_content #>> '{quickFacts,5,value}' as percurso from public.experiences where slug = 'rota-ermida-ponte-jk'");
  assert.deepEqual([kept.summary, kept.title, kept.percurso], ["Resumo do painel", "Título do painel", "Até a prainha da Ermida Dom Bosco, com parada para banho"]);
});
