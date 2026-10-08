import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { baseLocation, LAGO_NORTE_LOCATION, locationMapLink, parseBaseLocation, safeMapsUrl } from "../lib/bases/location.ts";
import { mapPublicBase } from "../lib/bases/catalog.ts";
import { parsePublicCheckinTicket } from "../lib/checkin/parse.ts";
import { sheetExperienceTitle } from "../lib/integrations/google-sheets/mapping.ts";
import {
  buildCheckinReminderEmail,
  buildReservationConfirmationEmail,
  deliverReservationConfirmationEmail,
  NEW_BASE_SUBJECT,
  parseReservationConfirmationData,
  type ConfirmationEmail,
} from "../lib/reservations/confirmation-email.ts";
import { applyMigration, fullDatabase } from "./support/full-database.ts";

const LAUNCH = "202610080001_capsula_bar_launch.sql";
const BEFORE_LAUNCH = "202609200001_instructor_access.sql";
const MAPS = "https://maps.app.goo.gl/ueSCiLvHAggrzuAX7";
const ADDRESS = "SHTN Trecho 1, Lote 8 — Brasília/DF";
const MEETING_POINT = "Em frente ao Cápsula Bar — Concha Acústica";
const ADMIN = "00000000-0000-4000-8000-00000000000a";
const OUTSIDER = "00000000-0000-4000-8000-00000000000b";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const migration = source(`supabase/migrations/${LAUNCH}`);
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

let cpfSeed = 10_000_000_000;

/** Pré-reserva pela mesma RPC que o site chama. */
async function preReserve(db: PGlite, sessionId: string, quantity: number, email = "cliente@exemplo.com") {
  cpfSeed += 1;
  const result = await one(db, "select public.create_pre_reservation($1,$2,$3,$4,$5,$6,$7,$8) as data", [
    sessionId, "Cliente de Teste", String(cpfSeed), "61999990000", email, quantity, "", randomUUID(),
  ]);
  return result.data as { reservationId: string; publicCode: string; totalCents: number; quantity: number };
}

/** Confirmação de pagamento pela mesma RPC do webhook da InfinitePay. */
async function confirm(db: PGlite, reservationId: string, amountCents: number, eventId = randomUUID()) {
  const result = await one(db, "select public.confirm_reservation_payment($1,'INFINITEPAY',$2,$3,'', '{}'::jsonb) as ok", [
    reservationId, eventId, amountCents,
  ]);
  return result.ok as boolean;
}

async function capsulaSession(db: PGlite) {
  return one(db, `
    select s.id, s.starts_at, s.duration_minutes, s.price_cents, s.capacity, s.status,
           public.available_spots(s.id) as spots, e.slug, e.title, b.slug as base_slug
    from public.sessions s
    join public.experiences e on e.id = s.experience_id
    join public.bases b on b.id = e.base_id
    where b.slug = 'concha-acustica' and e.slug = 'remada-sunset-concha-acustica'`);
}

async function lagoNorteSession(db: PGlite) {
  // Sessão futura do Lago Norte criada só para o teste (as semeadas são de 2026 e já passaram do relógio do teste ou não).
  await db.exec(`
    insert into public.sessions (experience_id, starts_at, duration_minutes, price_cents, capacity, status)
    select id, now() + interval '5 days', 90, 7000, 28, 'OPEN' from public.experiences where slug = 'remada-sunset'`);
  return one(db, `
    select s.id from public.sessions s join public.experiences e on e.id = s.experience_id
    where e.slug = 'remada-sunset' and s.starts_at > now() order by s.starts_at desc limit 1`);
}

/** A sessão de inauguração tem data fixa; o relógio do teste fica antes dela. */
async function launchedDatabase() {
  const db = await fullDatabase();
  // Garante que a sessão de 11/10/2026 esteja no futuro mesmo se a suíte rodar depois dessa data.
  await db.exec(`
    update public.sessions s set starts_at = greatest(s.starts_at, now() + interval '3 days')
    from public.experiences e join public.bases b on b.id = e.base_id
    where e.id = s.experience_id and b.slug = 'concha-acustica'`);
  await db.exec(`
    insert into auth.users (id) values ('${ADMIN}'), ('${OUTSIDER}');
    insert into public.admin_users (user_id, display_name, role, is_active) values ('${ADMIN}', 'Admin', 'ADMIN', true);`);
  return db;
}

// =============================================================================
// Migration: forma e segurança
// =============================================================================

test("migration de lançamento é aditiva e não toca as RPCs de reserva e pagamento", () => {
  assert.doesNotMatch(executable, /drop\s+table/i);
  assert.doesNotMatch(executable, /drop\s+column/i);
  assert.doesNotMatch(executable, /\btruncate\b/i);
  assert.doesNotMatch(executable, /delete\s+from/i);
  assert.doesNotMatch(executable, /drop\s+type/i);
  assert.doesNotMatch(executable, /cascade/i);
  // A única função recriada é a leitura pública das bases (ganha duas colunas).
  assert.deepEqual(executable.match(/drop function[^;]*/gi), ["drop function if exists public.list_public_bases()"]);
  for (const name of ["create_pre_reservation", "list_open_sessions", "get_booking_session", "confirm_reservation_payment", "attach_payment_checkout", "lookup_reservation", "available_spots", "expire_pre_reservations"]) {
    assert.doesNotMatch(executable, new RegExp(`function public\\.${name}\\b`), name);
  }
  assert.doesNotMatch(executable, /alter table public\.(sessions|reservations|payment_events)/i);
  // Nenhuma escrita mira o Lago Norte.
  assert.doesNotMatch(executable, /slug = 'lago-norte'/);
});

test("migration cria uma única sessão e nenhuma recorrência", () => {
  assert.equal((executable.match(/insert into public\.sessions/gi) ?? []).length, 1);
  assert.match(executable, /make_timestamptz\(2026, 10, 11, 17, 0, 0, 'America\/Sao_Paulo'\)/);
  assert.doesNotMatch(executable, /generate_series/i);
});

// =============================================================================
// Teste 1 — Remada Sunset de inauguração
// =============================================================================

test("Teste 1: base, experiências e a sessão de 11/10/2026 às 17h ficam como pedido", async () => {
  const db = await fullDatabase();

  const base = await one(db, "select * from public.bases where slug = 'concha-acustica'");
  assert.equal(base.name, "Cápsula Bar — Concha Acústica");
  assert.equal(base.status, "ACTIVE");
  assert.equal(base.address, ADDRESS);
  assert.equal(base.meeting_point, MEETING_POINT);
  assert.equal(base.maps_url, MAPS);
  assert.equal(base.partner_name, "Cápsula Bar");

  const experiences = await rows(db, `
    select e.slug, e.title, e.status, e.price_cents, e.duration_minutes, e.default_capacity
    from public.experiences e join public.bases b on b.id = e.base_id
    where b.slug = 'concha-acustica' order by e.title`);
  assert.deepEqual(experiences.map((item) => item.title), [
    "Caminhos do Paranoá — Rota Ermida x Ponte JK",
    "Caminhos do Paranoá — Rota Prainha do Congresso",
    "Remada Sunset",
    "Remada da Lua Cheia",
    "Remada do Nascer do Sol",
  ]);
  for (const experience of experiences) {
    assert.equal(experience.price_cents, 7000, String(experience.slug));
    assert.equal(experience.duration_minutes, 90, String(experience.slug));
    assert.equal(experience.default_capacity, 24, String(experience.slug));
    // Só a Remada Sunset abre; as demais ficam cadastradas, em breve.
    assert.equal(experience.status, experience.slug === "remada-sunset-concha-acustica" ? "PUBLISHED" : "COMING_SOON", String(experience.slug));
  }
  assert.equal((await rows(db, "select 1 from public.experiences where slug = 'caminhos-do-paranoa'")).length, 0);

  // Exatamente uma sessão na base nova.
  const sessions = await rows(db, `
    select s.* from public.sessions s join public.experiences e on e.id = s.experience_id
    join public.bases b on b.id = e.base_id where b.slug = 'concha-acustica'`);
  assert.equal(sessions.length, 1);
  const session = await capsulaSession(db);
  assert.equal(session.slug, "remada-sunset-concha-acustica");
  assert.equal(new Date(session.starts_at as string).toISOString(), "2026-10-11T20:00:00.000Z"); // 17h em Brasília
  const local = await one(db, "select to_char($1::timestamptz at time zone 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI ID') as local", [session.starts_at]);
  assert.equal(local.local, "2026-10-11 17:00 7"); // ISO 7 = domingo
  assert.equal(session.duration_minutes, 90);
  assert.equal(session.price_cents, 7000);
  assert.equal(session.capacity, 24);
  assert.equal(session.status, "OPEN");
  assert.equal(session.spots, 24);

  // Landing publicável: sem ela o banco recusaria a publicação.
  const editorial = await one(db, "select public.experience_editorial_is_publishable(editorial_content) as ok, editorial_content from public.experiences where slug = 'remada-sunset-concha-acustica'");
  assert.equal(editorial.ok, true);
  const copy = JSON.stringify(editorial.editorial_content);
  assert.match(copy, /Cápsula Bar/);
  assert.doesNotMatch(copy, /Lago Norte|QL 5/);
  assert.doesNotMatch(copy, /https?:\/\//);
});

test("Teste 1: fluxo de reserva — valor por pessoa, disponibilidade e limite de 24 vagas", async () => {
  const db = await launchedDatabase();
  const session = await capsulaSession(db);
  const sessionId = session.id as string;

  // O que a página de reserva lê.
  const booking = await one(db, "select * from public.get_booking_session($1)", [sessionId]);
  assert.equal(booking.price_cents, 7000);
  assert.equal(booking.duration_minutes, 90);
  assert.equal(booking.remaining_spots, 24);
  assert.equal(booking.experience_slug, "remada-sunset-concha-acustica");

  // R$ 70 × participantes.
  const single = await preReserve(db, sessionId, 1);
  const pair = await preReserve(db, sessionId, 2);
  const trio = await preReserve(db, sessionId, 3);
  assert.equal(single.totalCents, 7000);
  assert.equal(pair.totalCents, 14000);
  assert.equal(trio.totalCents, 21000);
  assert.equal((await capsulaSession(db)).spots, 18); // pré-reserva já bloqueia a vaga

  // Pagamento confirmado mantém a vaga ocupada; webhook duplicado não muda nada.
  const eventId = randomUUID();
  assert.equal(await confirm(db, pair.reservationId, 14000, eventId), true);
  assert.equal(await confirm(db, pair.reservationId, 14000, eventId), true);
  assert.equal(await confirm(db, pair.reservationId, 14000), true);
  assert.equal((await rows(db, "select 1 from public.payment_events where reservation_id = $1 and event_type = 'PAYMENT_CONFIRMED'", [pair.reservationId])).length, 1);
  assert.equal((await capsulaSession(db)).spots, 18);

  // Valor divergente do total da reserva nunca confirma.
  assert.equal(await confirm(db, single.reservationId, 100), false);
  assert.equal((await one(db, "select status from public.reservations where id = $1", [single.reservationId])).status, "PRE_RESERVED");

  // Pré-reserva vencida devolve as vagas.
  await db.query("update public.reservations set created_at = now() - interval '3 hours', expires_at = now() - interval '1 minute' where id = $1", [trio.reservationId]);
  assert.equal((await capsulaSession(db)).spots, 21);
  // Pagamento que chega depois do prazo não confirma nem ocupa vaga.
  assert.equal(await confirm(db, trio.reservationId, 21000), false);

  // Enche a turma até o limite e tenta passar dele.
  await preReserve(db, sessionId, 20);
  assert.equal((await capsulaSession(db)).spots, 1);
  await assert.rejects(preReserve(db, sessionId, 2), /INSUFFICIENT_SPOTS/);
  await preReserve(db, sessionId, 1);
  assert.equal((await capsulaSession(db)).spots, 0);
  await assert.rejects(preReserve(db, sessionId, 1), /INSUFFICIENT_SPOTS/);

  // Turma cheia sai da agenda pública.
  assert.equal((await rows(db, "select 1 from public.list_open_sessions('remada-sunset-concha-acustica')")).length, 0);
  const occupied = await one(db, `
    select coalesce(sum(quantity), 0)::int as total from public.reservations
    where session_id = $1 and (status = 'CONFIRMED' or (status = 'PRE_RESERVED' and expires_at > now()))`, [sessionId]);
  assert.equal(occupied.total, 24);
});

test("Teste 1: e-mail, lembrete e ingresso do QR saem com o endereço do Cápsula Bar", async () => {
  const db = await launchedDatabase();
  const session = await capsulaSession(db);
  const reservation = await preReserve(db, session.id as string, 2, "marina@exemplo.com");

  // Antes do pagamento não existe payload de e-mail nem direito de envio.
  assert.equal((await one(db, "select public.reservation_confirmation_email($1) as data", [reservation.reservationId])).data, null);
  assert.equal((await one(db, "select public.claim_reservation_confirmation_email($1, 3) as job", [reservation.reservationId])).job, null);

  assert.equal(await confirm(db, reservation.reservationId, 14000), true);
  const payload = (await one(db, "select public.reservation_confirmation_email($1) as data", [reservation.reservationId])).data;
  const data = parseReservationConfirmationData(payload);
  assert.ok(data);
  assert.equal(data.location?.baseSlug, "concha-acustica");
  assert.equal(data.location?.baseName, "Cápsula Bar — Concha Acústica");
  assert.equal(data.location?.meetingPoint, MEETING_POINT);
  assert.equal(data.location?.address, ADDRESS);
  assert.equal(data.location?.mapsUrl, MAPS);
  assert.equal(data.durationMinutes, 90);
  assert.ok(data.checkinToken, "reserva confirmada ganha token de check-in");

  const email = buildReservationConfirmationEmail(data);
  assert.equal(email.subject, NEW_BASE_SUBJECT);
  assert.equal(email.subject, "Sua reserva está confirmada! 🌊 | Alma Azul Academy");
  assert.equal(email.to, "marina@exemplo.com");
  for (const body of [email.html, email.text]) {
    assert.match(body, /Olá, Cliente!/);
    assert.match(body, /Sua experiência com a Alma Azul está confirmada! 💙/);
    assert.match(body, /Remada Sunset/);
    assert.match(body, /90 minutos/);
    assert.match(body, /Em frente ao Cápsula Bar — Concha Acústica\./);
    assert.match(body, /SHTN Trecho 1, Lote 8 — Brasília\/DF/);
    assert.ok(body.includes(MAPS));
    assert.match(body, /Como chegar — Google Maps/);
    assert.ok(body.includes(reservation.publicCode), "o código da reserva continua no e-mail");
    assert.ok(body.includes(`/checkin/${data.checkinToken}`), "o QR de check-in continua no e-mail");
    // Nunca o endereço do Lago Norte.
    assert.doesNotMatch(body, /QL 5|Lago Norte/);
    // Informações que já existiam continuam: tolerância, o que levar, cancelamento e grupo.
    assert.match(body, /Tolerância de até 20 minutos/);
    assert.match(body, /roupa de banho/);
    assert.match(body, /Criaremos um grupo/);
  }
  assert.match(email.text, /👥 Participantes: 2/);
  assert.ok(email.html.includes(`href="${MAPS}"`));
  assert.ok(email.html.includes(`/api/checkin/qr/${data.checkinToken}`));

  // Lembrete do QR ("Reenviar QR Code" e envio em lote) usa a mesma base.
  const reminder = buildCheckinReminderEmail(data);
  assert.ok(reminder);
  assert.ok(reminder.text.includes(MEETING_POINT) && reminder.text.includes(MAPS));
  assert.ok(reminder.html.includes(ADDRESS));
  assert.doesNotMatch(reminder.html + reminder.text, /QL 5/);
  const adminPayload = (await one(db, "select public.admin_reservation_qr_email_payload($1, $2) as data", [ADMIN, reservation.reservationId])).data;
  assert.equal(parseReservationConfirmationData(adminPayload)?.location?.baseSlug, "concha-acustica");

  // Ingresso público do QR: local da base, sem dado pessoal.
  const ticketRaw = (await one(db, "select public.public_checkin_ticket($1) as data", [data.checkinToken])).data;
  const ticket = parsePublicCheckinTicket(ticketRaw);
  assert.ok(ticket);
  assert.equal(ticket.quantity, 2);
  assert.equal(ticket.location?.mapsUrl, MAPS);
  assert.equal(ticket.location?.meetingPoint, MEETING_POINT);
  assert.doesNotMatch(JSON.stringify(ticketRaw), /marina@exemplo\.com|Cliente de Teste|cpf|phone/i);
});

test("Teste 5: e-mail duplicado é impossível e falha de envio não desfaz a reserva", async () => {
  const db = await launchedDatabase();
  const session = await capsulaSession(db);
  const reservation = await preReserve(db, session.id as string, 1);
  await confirm(db, reservation.reservationId, 7000);

  const sent: ConfirmationEmail[] = [];
  const deps = (send: (message: ConfirmationEmail) => Promise<void>) => ({
    claim: async () => (await one(db, "select public.claim_reservation_confirmation_email($1, 3) as job", [reservation.reservationId])).job as string | null,
    load: async () => (await one(db, "select public.reservation_confirmation_email($1) as data", [reservation.reservationId])).data,
    send,
    complete: async (jobId: string) => { await db.query("select public.complete_integration_sync_job($1)", [jobId]); },
    fail: async (jobId: string, code: string) => { await db.query("select public.fail_integration_sync_job($1, $2)", [jobId, code]); },
    sanitizeError: () => "HTTP_500",
  });

  // Provedor fora do ar: o job fica FAILED e a reserva segue confirmada, com a vaga ocupada.
  const failed = await deliverReservationConfirmationEmail(deps(async () => { throw new Error("provider down"); }));
  assert.equal(failed.outcome, "PENDING");
  assert.equal((await one(db, "select status from public.reservations where id = $1", [reservation.reservationId])).status, "CONFIRMED");
  assert.equal((await capsulaSession(db)).spots, 23);

  // Nova tentativa envia; as seguintes (webhook repetido, reprocessamento) não enviam de novo.
  const delivered = await deliverReservationConfirmationEmail(deps(async (message) => { sent.push(message); }));
  assert.equal(delivered.outcome, "SENT");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const again = await deliverReservationConfirmationEmail(deps(async (message) => { sent.push(message); }));
    assert.equal(again.outcome, "SKIPPED");
  }
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes(ADDRESS));
});

// =============================================================================
// Teste 2 e 4 — Lago Norte preservado e bases separadas
// =============================================================================

test("Teste 2: a migration não altera nenhuma experiência, sessão ou base do Lago Norte", async () => {
  const db = await fullDatabase({ until: BEFORE_LAUNCH });
  const snapshot = async () => ({
    base: await rows(db, "select id, slug, name, status, short_description, description, location_label, address, partner_name, image_url, display_order from public.bases where slug = 'lago-norte'"),
    experiences: await rows(db, `
      select e.id, e.slug, e.title, e.summary, e.description, e.status, e.price_cents, e.duration_minutes, e.default_capacity,
             e.image_url, e.display_order, e.editorial_content, e.is_exclusive, e.modality, e.updated_at
      from public.experiences e join public.bases b on b.id = e.base_id where b.slug = 'lago-norte' order by e.slug`),
    sessions: await rows(db, `
      select s.id, s.experience_id, s.starts_at, s.duration_minutes, s.price_cents, s.capacity, s.status, s.updated_at
      from public.sessions s join public.experiences e on e.id = s.experience_id
      join public.bases b on b.id = e.base_id where b.slug = 'lago-norte' order by s.starts_at, s.id`),
  });
  const before = await snapshot();
  assert.ok(before.experiences.length >= 4 && before.sessions.length > 0);

  await applyMigration(db, LAUNCH);
  assert.deepEqual(await snapshot(), before);

  const lagoNorte = await one(db, "select meeting_point, maps_url from public.bases where slug = 'lago-norte'");
  assert.equal(lagoNorte.meeting_point, null);
  assert.equal(lagoNorte.maps_url, null);
});

test("Teste 2: reserva do Lago Norte continua com o mesmo fluxo e o mesmo e-mail", async () => {
  const db = await launchedDatabase();
  const session = await lagoNorteSession(db);
  const reservation = await preReserve(db, session.id as string, 3);
  assert.equal(reservation.totalCents, 21000);
  assert.equal(await confirm(db, reservation.reservationId, 21000), true);

  const payload = (await one(db, "select public.reservation_confirmation_email($1) as data", [reservation.reservationId])).data as Row;
  const data = parseReservationConfirmationData(payload);
  assert.ok(data);
  assert.equal(data.location?.baseSlug, "lago-norte");
  assert.equal(data.location?.address, "QL 5 Conjunto 5 - Lago Norte");
  assert.equal(data.location?.mapsUrl, null);

  const email = buildReservationConfirmationEmail(data);
  assert.equal(email.subject, `Reserva confirmada — ${reservation.publicCode}`);
  assert.match(email.text, /Localização\nQL 5 Conjunto 5 - Lago Norte\n/);
  assert.match(email.text, /parada para banho/);
  assert.doesNotMatch(email.html + email.text, /Cápsula|SHTN|maps\.app\.goo\.gl|Como chegar/);

  // Idêntico, byte a byte, ao e-mail montado sem nenhuma informação de base
  // (o payload que a RPC devolvia antes desta migration).
  const legacyPayload = { ...payload };
  for (const key of ["baseSlug", "baseName", "meetingPoint", "address", "mapsUrl", "durationMinutes"]) delete legacyPayload[key];
  const legacy = parseReservationConfirmationData(legacyPayload);
  assert.ok(legacy);
  assert.deepEqual(buildReservationConfirmationEmail(legacy), email);
  assert.deepEqual(buildCheckinReminderEmail(legacy), buildCheckinReminderEmail(data));
});

test("Teste 4: cada reserva pertence à sua base e uma base não mexe nas vagas da outra", async () => {
  const db = await launchedDatabase();
  const capsula = await capsulaSession(db);
  const lago = await lagoNorteSession(db);
  const lagoSpots = async () => (await one(db, "select public.available_spots($1) as spots", [lago.id])).spots;
  assert.equal(await lagoSpots(), 28);

  const onCapsula = await preReserve(db, capsula.id as string, 4);
  await confirm(db, onCapsula.reservationId, 28000);
  assert.equal(await lagoSpots(), 28); // reserva no Cápsula Bar não ocupa vaga no Lago Norte
  const onLago = await preReserve(db, lago.id as string, 2);
  await confirm(db, onLago.reservationId, 14000);
  assert.equal((await capsulaSession(db)).spots, 20);
  assert.equal(await lagoSpots(), 26);

  const bases = await rows(db, `
    select r.id, b.slug from public.reservations r
    join public.sessions s on s.id = r.session_id
    join public.experiences e on e.id = s.experience_id
    join public.bases b on b.id = e.base_id
    where r.id = any($1::uuid[])`, [[onCapsula.reservationId, onLago.reservationId]]);
  assert.equal(bases.find((row) => row.id === onCapsula.reservationId)?.slug, "concha-acustica");
  assert.equal(bases.find((row) => row.id === onLago.reservationId)?.slug, "lago-norte");
  // A experiência gravada na reserva é a da sessão — a mesma que define a base.
  assert.equal((await rows(db, "select 1 from public.reservations r join public.sessions s on s.id = r.session_id where r.experience_id <> s.experience_id")).length, 0);

  // Métricas por base não se misturam.
  const metrics = async (slug: string) => (await one(db, "select public.admin_base_dashboard_metrics($1, (select id from public.bases where slug = $2)) as m", [ADMIN, slug])).m as Row;
  assert.equal((await metrics("concha-acustica")).confirmedRevenueCents, 28000);
  assert.equal((await metrics("lago-norte")).confirmedRevenueCents, 14000);
  assert.equal((await metrics("concha-acustica")).totalParticipants, 4);

  // Planilha: a turma do Cápsula Bar leva a base no título; a do Lago Norte não muda.
  const block = async (id: unknown) => (await one(db, "select public.google_sheets_session_block($1) as b", [id])).b as Row;
  assert.equal(sheetExperienceTitle(await block(capsula.id)), "Remada Sunset · Cápsula Bar — Concha Acústica");
  assert.equal(sheetExperienceTitle(await block(lago.id)), "Remada Sunset");
  assert.equal(sheetExperienceTitle({ experienceTitle: "Imersão Paranoá" }), "Imersão Paranoá");
});

// =============================================================================
// Teste 3 — Painel administrativo
// =============================================================================

test("Teste 3: o painel cria horários, altera preço e capacidade e cadastra experiências na nova base", async () => {
  const db = await launchedDatabase();
  const capsulaId = (await one(db, "select id from public.bases where slug = 'concha-acustica'")).id as string;
  const lua = await one(db, "select * from public.experiences where slug = 'remada-lua-cheia-concha-acustica'");

  // Novo horário em uma experiência da base (mesma RPC do botão "Nova sessão").
  const created = await one(db, "select public.admin_create_session($1,$2, now() + interval '20 days', 90, 7000, 24, 'OPEN', '') as id", [ADMIN, lua.id]);
  assert.ok(created.id);
  // Em breve ainda não é reservável: a sessão existe, mas não aparece na agenda pública.
  assert.equal((await rows(db, "select 1 from public.list_open_sessions('remada-lua-cheia-concha-acustica')")).length, 0);

  // Preço, duração e capacidade de uma sessão existente.
  const session = await capsulaSession(db);
  await db.query("select public.admin_update_session($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
    ADMIN, session.id, (await one(db, "select experience_id from public.sessions where id = $1", [session.id])).experience_id,
    session.starts_at, 120, 8500, 30, "OPEN", "",
  ]);
  const edited = await capsulaSession(db);
  assert.equal(edited.price_cents, 8500);
  assert.equal(edited.capacity, 30);
  assert.equal(edited.duration_minutes, 120);
  assert.equal(edited.spots, 30);
  // Reserva nova já sai com o preço novo.
  assert.equal((await preReserve(db, session.id as string, 2)).totalCents, 17000);

  // Desativar a sessão tira da agenda.
  await db.query("select public.admin_update_session($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
    ADMIN, session.id, (await one(db, "select experience_id from public.sessions where id = $1", [session.id])).experience_id,
    session.starts_at, 120, 8500, 30, "CLOSED", "",
  ]);
  assert.equal((await rows(db, "select 1 from public.list_open_sessions('remada-sunset-concha-acustica')")).length, 0);

  // Nova experiência/roteiro na base, pelo mesmo cadastro do Lago Norte.
  const experienceId = (await one(db, "select public.admin_create_experience($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) as id", [
    ADMIN, "caminhos-do-paranoa-rota-nova", "Caminhos do Paranoá — Rota Nova", "Um novo roteiro.", "COMING_SOON", "", 110,
    "Um novo roteiro.", 90, 7000, 24, "{}", capsulaId,
  ])).id as string;
  assert.equal((await one(db, "select b.slug from public.experiences e join public.bases b on b.id = e.base_id where e.id = $1", [experienceId])).slug, "concha-acustica");

  // Alterar o preço de uma experiência.
  await db.query("select public.admin_update_experience($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)", [
    ADMIN, experienceId, "Caminhos do Paranoá — Rota Nova", "Um novo roteiro.", "COMING_SOON", "", 110, "Um novo roteiro.", 100, 9000, 20, "{}", capsulaId,
  ]);
  const updated = await one(db, "select price_cents, duration_minutes, default_capacity from public.experiences where id = $1", [experienceId]);
  assert.deepEqual([updated.price_cents, updated.duration_minutes, updated.default_capacity], [9000, 100, 20]);
});

test("Teste 5: quem não é administrador não cria sessão nem experiência", async () => {
  const db = await launchedDatabase();
  const capsulaId = (await one(db, "select id from public.bases where slug = 'concha-acustica'")).id as string;
  const sunset = (await one(db, "select id from public.experiences where slug = 'remada-sunset-concha-acustica'")).id;
  await assert.rejects(db.query("select public.admin_create_session($1,$2, now() + interval '9 days', 90, 7000, 24, 'OPEN', '')", [OUTSIDER, sunset]), /ADMIN_FORBIDDEN/);
  await assert.rejects(db.query("select public.admin_create_experience($1,'x-y','Xis','s','DRAFT','',0,'d',90,0,1,'{}',$2)", [OUTSIDER, capsulaId]), /ADMIN_FORBIDDEN/);
  await assert.rejects(db.query("select public.admin_base_dashboard_metrics($1, $2)", [OUTSIDER, capsulaId]), /ADMIN_FORBIDDEN/);

  // As funções novas ou recriadas mantêm os mesmos privilégios.
  const grants = async (name: string) => (await rows(db, `
    select r.rolname from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
      lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      join pg_roles r on r.oid = acl.grantee
    where n.nspname = 'public' and p.proname = $1 and acl.privilege_type = 'EXECUTE'`, [name])).map((row) => row.rolname);
  for (const name of ["reservation_confirmation_email", "public_checkin_ticket", "google_sheets_session_block"]) {
    const roles = await grants(name);
    assert.ok(roles.includes("service_role"), name);
    assert.equal(roles.includes("anon") || roles.includes("authenticated"), false, name);
  }
  assert.ok((await grants("list_public_bases")).includes("anon"));
});

// =============================================================================
// Idempotência e schema legado de produção
// =============================================================================

test("reaplicar a migration não duplica nada nem sobrescreve edições do painel", async () => {
  const db = await fullDatabase();
  await db.exec(`
    update public.bases set name = 'Cápsula Bar (editado)', address = 'Outro endereço' where slug = 'concha-acustica';
    update public.experiences set price_cents = 9900, title = 'Remada Sunset Especial' where slug = 'remada-sunset-concha-acustica';
    update public.experiences set default_capacity = 12 where slug = 'remada-lua-cheia-concha-acustica';
    update public.sessions s set capacity = 30 from public.experiences e where e.id = s.experience_id and e.slug = 'remada-sunset-concha-acustica';`);
  await applyMigration(db, LAUNCH);
  await applyMigration(db, LAUNCH);

  const base = await one(db, "select name, address, status from public.bases where slug = 'concha-acustica'");
  assert.deepEqual([base.name, base.address, base.status], ["Cápsula Bar (editado)", "Outro endereço", "ACTIVE"]);
  const sunset = await one(db, "select price_cents, title from public.experiences where slug = 'remada-sunset-concha-acustica'");
  assert.deepEqual([sunset.price_cents, sunset.title], [9900, "Remada Sunset Especial"]);
  assert.equal((await one(db, "select default_capacity from public.experiences where slug = 'remada-lua-cheia-concha-acustica'")).default_capacity, 12);
  const sessions = await rows(db, "select s.capacity from public.sessions s join public.experiences e on e.id = s.experience_id where e.slug = 'remada-sunset-concha-acustica'");
  assert.deepEqual(sessions.map((row) => row.capacity), [30]);
  assert.equal((await rows(db, "select 1 from public.experiences e join public.bases b on b.id = e.base_id where b.slug = 'concha-acustica'")).length, 5);
});

test("migration aplica no schema legado de produção (colunas de compatibilidade e spots_available)", async () => {
  const db = await fullDatabase({ until: BEFORE_LAUNCH });
  await db.exec(`
    alter table public.experiences
      add column eyebrow text not null default '', add column short_description text not null default '',
      add column location text not null default '', add column cover_image text not null default '',
      add column gallery jsonb not null default '[]', add column included jsonb not null default '[]',
      add column active boolean not null default false;
    update public.experiences set location = 'Concha Acústica, Brasília'
      where base_id = (select id from public.bases where slug = 'concha-acustica');
    alter table public.sessions add column spots_available integer;
    update public.sessions set spots_available = capacity;
    alter table public.sessions alter column spots_available set not null;`);
  await applyMigration(db, LAUNCH);
  await applyMigration(db, LAUNCH);

  const session = await one(db, `
    select s.capacity, s.spots_available from public.sessions s join public.experiences e on e.id = s.experience_id
    where e.slug = 'remada-sunset-concha-acustica'`);
  assert.deepEqual([session.capacity, session.spots_available], [24, 24]);
  const sunset = await one(db, "select active, location, cover_image, status from public.experiences where slug = 'remada-sunset-concha-acustica'");
  assert.equal(sunset.active, true);
  assert.equal(sunset.location, "Cápsula Bar — Concha Acústica, Brasília");
  assert.equal(sunset.status, "PUBLISHED");
  const routes = await rows(db, "select slug, active, location from public.experiences where slug like 'caminhos-do-paranoa-%' order by slug");
  assert.equal(routes.length, 2);
  for (const route of routes) {
    assert.equal(route.active, false);
    assert.equal(route.location, "Cápsula Bar — Concha Acústica, Brasília");
  }
});

// =============================================================================
// Localização centralizada
// =============================================================================

test("localização tem uma fonte única e o endereço do Lago Norte não está espalhado pelo código", () => {
  // O endereço literal existe em um único módulo de aplicação (mais o espelho de contingência das bases).
  const withAddress = [
    "lib/reservations/confirmation-email.ts", "lib/reservations/confirmation-email-service.ts", "lib/reservations/data.ts",
    "lib/checkin/parse.ts", "lib/checkin/qr-bulk.ts", "app/pagamento/retorno/page.tsx", "app/reservar/[sessionId]/page.tsx",
    "app/checkin/[token]/page.tsx", "app/bases/[slug]/page.tsx", "components/bases/base-location.tsx",
    "components/reservation/reservation-lookup.tsx", "components/reservation/reservation-hold.tsx", "components/experience-landing.tsx",
  ].filter((path) => /QL 5/.test(source(path)));
  assert.deepEqual(withAddress, []);
  assert.match(source("lib/bases/location.ts"), /address: "QL 5 Conjunto 5 - Lago Norte"/);

  // O link do mapa do Cápsula Bar vive no banco, não no código do site.
  for (const path of ["lib/bases/location.ts", "lib/bases/concha-landing.ts", "components/bases/concha-landing.tsx", "lib/reservations/confirmation-email.ts"]) {
    assert.doesNotMatch(source(path), /maps\.app\.goo\.gl/, path);
  }

  // Todos os pontos que mostram "onde é" leem a base.
  for (const path of ["app/reservar/[sessionId]/page.tsx", "app/pagamento/retorno/page.tsx", "app/checkin/[token]/page.tsx", "components/reservation/reservation-lookup.tsx", "components/reservation/reservation-hold.tsx"]) {
    assert.match(source(path), /BaseLocationCard/, path);
  }
  assert.match(source("components/experience-landing.tsx"), /BaseMapLink/);
  assert.match(source("components/bases/concha-landing.tsx"), /BaseMapLink/);
  assert.match(source("components/bases/base-location.tsx"), /MAPS_BUTTON_LABEL/);
  // A decisão do e-mail é pela base, nunca pelo título da experiência.
  assert.doesNotMatch(source("lib/reservations/confirmation-email.ts"), /experienceTitle\s*(===|\.includes|\.match)/);
});

test("leitura de localização é defensiva", () => {
  const capsula = mapPublicBase({
    id: "b", slug: "concha-acustica", name: "Cápsula Bar — Concha Acústica", status: "ACTIVE",
    address: ADDRESS, meeting_point: MEETING_POINT, maps_url: MAPS,
  });
  assert.ok(capsula);
  assert.deepEqual(baseLocation(capsula), { baseSlug: "concha-acustica", baseName: "Cápsula Bar — Concha Acústica", meetingPoint: MEETING_POINT, address: ADDRESS, mapsUrl: MAPS });
  assert.deepEqual(locationMapLink(baseLocation(capsula)), { href: MAPS, official: true });

  // Base sem link oficial mantém a busca pelo endereço (comportamento do Lago Norte).
  const lago = locationMapLink(LAGO_NORTE_LOCATION);
  assert.equal(lago?.official, false);
  assert.match(lago?.href ?? "", /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=QL%205/);

  // Só HTTPS entra em e-mail e página.
  assert.equal(safeMapsUrl("javascript:alert(1)"), null);
  assert.equal(safeMapsUrl("http://maps.example.com"), null);
  assert.equal(safeMapsUrl('https://x.com/"><script>'), null);
  assert.equal(safeMapsUrl(MAPS), MAPS);
  // Sem base no payload não se inventa uma.
  assert.equal(parseBaseLocation({ experienceTitle: "Remada Sunset" }), null);
  assert.equal(parseBaseLocation(null), null);
});

test("landing do Cápsula Bar só abre caminho de reserva quando a base está ativa", async () => {
  const { CONCHA_LANDING } = await import("../lib/bases/concha-landing.ts");
  const landing = source("components/bases/concha-landing.tsx");
  const page = source("app/bases/[slug]/page.tsx");
  // A landing editorial é preservada nos dois estados; quem decide é o status da base.
  assert.match(page, /<ConchaLanding base=\{base\} fallbackBase=\{fallbackBase\} bookable=\{bookable\} experiences=\{experiences\} \/>/);
  assert.match(landing, /bookable \? experiences\.find\(\(item\) => slugs\.includes\(item\.slug\) && isExperienceBookable\(item, base\)\)/);
  assert.match(landing, /const firstOpen = bookable \?/);
  // Nenhuma data, valor ou vaga escrita na landing: isso vem das sessões.
  const copy = JSON.stringify(CONCHA_LANDING);
  for (const forbidden of [/R\$/, /\b\d{1,2}\/\d{1,2}\b/, /\bvagas?\b/i, /https?:\/\//, /checkout/i]) {
    assert.equal(forbidden.test(copy), false, String(forbidden));
  }
  // Cada card aponta para experiências que a migration realmente cadastra.
  for (const item of CONCHA_LANDING.experiences.items) {
    for (const slug of item.slugs) assert.match(migration, new RegExp(`'${slug}'`), slug);
  }
  assert.equal(CONCHA_LANDING.mediaCredit, "Registros de experiências Alma Azul no Lago Paranoá");
});
