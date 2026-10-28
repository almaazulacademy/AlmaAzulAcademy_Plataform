/**
 * Eventos especiais — fase 2: fundação no banco.
 *
 * Roda contra o Postgres em memória (PGlite) com **todas** as migrations. Um
 * evento é uma experiência `kind = 'EVENT'` com uma sessão por edição; as
 * reservas passam pelos caminhos reais de sempre — pré-reserva, pagamento,
 * troca de turma, Stand-by pelo painel e pelo cliente, lista de espera.
 *
 * O banco é um só para quase todo o arquivo: cada teste cria os próprios
 * eventos e confere o estado deles, não totais globais. Os testes que comparam
 * listagens inteiras, a migration, os diagnósticos e o rollback usam um banco
 * novo.
 *
 * A concorrência com sessões reais do Postgres (várias pessoas disputando as 12
 * vagas ao mesmo tempo) está em `special-events-concurrency.test.ts`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { adminMutationError, standbyMutationError } from "../lib/admin/mutation-errors.ts";
import { selfServiceRescheduleError } from "../lib/reservations/standby-self-service.ts";
import { applyMigration, fullDatabase } from "./support/full-database.ts";
import { ADMIN, INSTRUCTOR, rescheduleFixtures, STRANGER, type Row } from "./support/reschedule-email-fixtures.ts";

const MIGRATION = "202610280001_special_events_foundation.sql";
const PREVIOUS = "202610260002_waitlist_spot_email.sql";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const db = await fullDatabase();
const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
const { one, rows, call, IMERSAO, SUNSET_CONCHA, makeSession, reserve, setStandby, reschedule, uniquePrice } = fx;

const CONCHA = SUNSET_CONCHA.base_id as string;
const EDITORIAL = (await one(`select editorial_content from public.experiences where slug = 'imersao-paranoa'`)).editorial_content;
const PRICE = 15_000;
const CAPACITY = 12;

type EventRef = { slug: string; title: string; experienceId: string; sessionId: string };

let sequence = 0;

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: Error) => {
    assert.match(error.message, pattern);
    return true;
  });
}

async function createEvent(options: { price?: number; capacity?: number; startsIn?: string; actor?: string } = {}): Promise<EventRef> {
  sequence += 1;
  const slug = `evento-teste-${sequence}`;
  const title = `Evento Teste ${sequence}`;
  const created = await call(
    `public.admin_create_event($1::uuid, $2::uuid, $3, $4, 'Uma manhã completa', $5::jsonb, null, now() + $6::interval, 210, $7, $8)`,
    [options.actor ?? ADMIN, CONCHA, slug, title, JSON.stringify(EDITORIAL), options.startsIn ?? "10 days", options.price ?? PRICE, options.capacity ?? CAPACITY],
  );
  return { slug, title, experienceId: created.experienceId, sessionId: created.sessionId };
}

async function setPublication(enabled: boolean) {
  await rows(`update public.special_event_settings set publication_enabled = $1`, [enabled]);
}

function updateEvent(event: EventRef, status: string, editorial: unknown = EDITORIAL, actor = ADMIN) {
  return call(
    `public.admin_update_event($1::uuid, $2::uuid, $3, 'Uma manhã completa', $4, null, 0, $5::jsonb)`,
    [actor, event.experienceId, event.title, status, JSON.stringify(editorial)],
  );
}

/** Publica com o interruptor ligado só durante a publicação. */
async function publish(event: EventRef) {
  await setPublication(true);
  try {
    await updateEvent(event, "PUBLISHED");
  } finally {
    await setPublication(false);
  }
}

/** Abre ou fecha a sessão pela RPC de sessão do painel, a de sempre. */
async function setSessionStatus(sessionId: string, status: string) {
  const session = await one(`select * from public.sessions where id = $1::uuid`, [sessionId]);
  await call(
    `public.admin_update_session($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5, $6, $7, $8::public.session_status, $9)`,
    [ADMIN, sessionId, session.experience_id, session.starts_at, session.duration_minutes, session.price_cents, session.capacity, status, session.internal_notes],
  );
}

/** Evento publicado com a sessão aberta: o estado de "à venda". */
async function onSaleEvent(options: { capacity?: number; price?: number } = {}) {
  const event = await createEvent(options);
  await publish(event);
  await setSessionStatus(event.sessionId, "OPEN");
  return event;
}

function preReserve(sessionId: string, quantity: number) {
  sequence += 1;
  return call(
    `public.create_pre_reservation($1::uuid, $2, $3, $4, $5, $6, null, gen_random_uuid())`,
    [sessionId, `Participante Evento ${sequence}`, String(50_000_000_000 + sequence), `+55619${String(30_000_000 + sequence)}`, `evento${sequence}@teste.local`, quantity],
  );
}

async function reservationRow(id: string) {
  return one(`select session_id, experience_id, status::text as status from public.reservations where id = $1::uuid`, [id]);
}

async function changesOf(id: string) {
  return (await rows(`select id from public.reservation_session_changes where reservation_id = $1::uuid`, [id])).length;
}

// ===========================================================================
// 1. Tipo da experiência
// ===========================================================================

test("tipo: toda experiência existente fica REGULAR, e o banco só aceita REGULAR ou EVENT", async () => {
  const kinds = await rows(`select slug, kind from public.experiences where slug not like 'evento-teste-%' order by slug`);
  assert.ok(kinds.length >= 9);
  for (const row of kinds) assert.equal(row.kind, "REGULAR", row.slug);
  await rejects(
    db.query(
      `insert into public.experiences (slug, title, summary, description, duration_minutes, price_cents, default_capacity, status, base_id, kind)
       values ('tipo-invalido', 'Tipo inválido', 'x', 'x', 90, 0, 1, 'DRAFT', $1::uuid, 'OUTRO')`,
      [CONCHA],
    ),
    /experiences_kind_check/,
  );
});

test("tipo: não muda depois que a experiência tem sessão, nos dois sentidos", async () => {
  await makeSession(IMERSAO.id, { price: uniquePrice() });
  await rejects(db.query(`update public.experiences set kind = 'EVENT' where id = $1::uuid`, [IMERSAO.id]), /EXPERIENCE_KIND_LOCKED/);
  const event = await createEvent();
  await rejects(db.query(`update public.experiences set kind = 'REGULAR' where id = $1::uuid`, [event.experienceId]), /EXPERIENCE_KIND_LOCKED/);
  // Editar uma experiência regular pelo painel de sempre continua igual.
  const imersao = await one(`select * from public.experiences where id = $1::uuid`, [IMERSAO.id]);
  assert.equal(await call(
    `public.admin_update_experience($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::uuid)`,
    [ADMIN, imersao.id, imersao.title, imersao.summary, imersao.status, imersao.image_url, imersao.display_order, imersao.description,
      imersao.duration_minutes, imersao.price_cents, imersao.default_capacity, JSON.stringify(imersao.editorial_content), imersao.base_id],
  ), true);
  assert.equal((await one(`select kind from public.experiences where id = $1::uuid`, [IMERSAO.id])).kind, "REGULAR");
});

// ===========================================================================
// 2. Criação e publicação
// ===========================================================================

test("criação: rascunho EVENT com a sessão fechada, auditado e fora do site", async () => {
  const event = await createEvent();
  const experience = await one(`select kind, status, base_id from public.experiences where id = $1::uuid`, [event.experienceId]);
  assert.deepEqual([experience.kind, experience.status, experience.base_id], ["EVENT", "DRAFT", CONCHA]);
  const session = await one(`select status::text as status, capacity, price_cents, duration_minutes, experience_id from public.sessions where id = $1::uuid`, [event.sessionId]);
  assert.deepEqual([session.status, session.capacity, session.price_cents, session.duration_minutes, session.experience_id], ["CLOSED", 12, 15000, 210, event.experienceId]);

  const actions = (await rows(
    `select action from public.admin_audit_log where entity_id in ($1::uuid, $2::uuid) order by action`,
    [event.experienceId, event.sessionId],
  )).map((row) => row.action);
  assert.deepEqual(actions, ["EVENT_CREATED", "EXPERIENCE_CREATED", "SESSION_CREATED"]);

  assert.equal((await rows(`select 1 from public.list_public_events() where slug = $1`, [event.slug])).length, 0);
  assert.equal((await rows(`select 1 from public.list_public_experiences() where slug = $1`, [event.slug])).length, 0);
  assert.equal((await rows(`select 1 from public.list_public_catalog() where slug = $1`, [event.slug])).length, 0);
  await rejects(preReserve(event.sessionId, 1), /SESSION_UNAVAILABLE/);

  const listed = await one(`select * from public.admin_list_events($1::uuid) where id = $2::uuid`, [ADMIN, event.experienceId]);
  assert.deepEqual([listed.status, listed.availability, listed.capacity, listed.remaining_spots], ["DRAFT", "CLOSED", 12, 12]);
});

test("criação: dados inválidos não deixam experiência nem sessão pela metade", async () => {
  sequence += 1;
  const slug = `evento-invalido-${sequence}`;
  const attempt = (startsIn: string, capacity: number) => call(
    `public.admin_create_event($1::uuid, $2::uuid, $3, 'Inválido', 'x', $4::jsonb, null, now() + $5::interval, 210, 15000, $6)`,
    [ADMIN, CONCHA, slug, JSON.stringify(EDITORIAL), startsIn, capacity],
  );
  await rejects(attempt("-1 day", 12), /SESSION_MUST_BE_FUTURE/);
  await rejects(attempt("10 days", 0), /INVALID_EVENT_CAPACITY/);
  assert.equal((await rows(`select 1 from public.experiences where slug = $1`, [slug])).length, 0);
  const existing = await createEvent();
  await rejects(call(
    `public.admin_create_event($1::uuid, $2::uuid, $3, 'Repetido', 'x', '{}'::jsonb, null, now() + interval '10 days', 210, 15000, 12)`,
    [ADMIN, CONCHA, existing.slug],
  ), /EXPERIENCE_SLUG_EXISTS/);
});

test("permissões: só ADMIN ou OPERATOR ativo opera eventos; instrutor e desconhecido são recusados", async () => {
  const event = await createEvent();
  for (const actor of [INSTRUCTOR, STRANGER]) {
    await rejects(createEvent({ actor }), /ADMIN_FORBIDDEN/);
    await rejects(updateEvent(event, "DRAFT", EDITORIAL, actor), /ADMIN_FORBIDDEN/);
    await rejects(call(`public.admin_duplicate_event($1::uuid, $2::uuid, 'copia-proibida', 'Cópia', now() + interval '20 days')`, [actor, event.experienceId]), /ADMIN_FORBIDDEN/);
    await rejects(rows(`select * from public.admin_list_events($1::uuid)`, [actor]), /ADMIN_FORBIDDEN/);
    await rejects(call(`public.admin_event_report($1::uuid, $2::uuid)`, [actor, event.experienceId]), /ADMIN_FORBIDDEN/);
  }
});

test("publicação: bloqueada com o interruptor desligado, por qualquer caminho", async () => {
  const event = await createEvent();
  await rejects(updateEvent(event, "PUBLISHED"), /EVENT_PUBLICATION_DISABLED/);
  // O painel atual de experiências também não publica um evento.
  await rejects(call(
    `public.admin_update_experience($1::uuid, $2::uuid, $3, 'x', 'PUBLISHED', null, 0, 'x', 210, 15000, 12, $4::jsonb, $5::uuid)`,
    [ADMIN, event.experienceId, event.title, JSON.stringify(EDITORIAL), CONCHA],
  ), /EVENT_PUBLICATION_DISABLED/);
  await rejects(db.query(`update public.experiences set status = 'PUBLISHED' where id = $1::uuid`, [event.experienceId]), /EVENT_PUBLICATION_DISABLED/);
  assert.equal((await one(`select status from public.experiences where id = $1::uuid`, [event.experienceId])).status, "DRAFT");

  // Ligado: publica, com a mesma régua de conteúdo das experiências.
  await setPublication(true);
  await rejects(updateEvent(event, "PUBLISHED", {}), /INCOMPLETE_EDITORIAL_CONTENT/);
  assert.equal(await updateEvent(event, "PUBLISHED"), true);
  await setPublication(false);

  // Desligado de novo: o evento já publicado continua editável e publicado.
  assert.equal(await updateEvent(event, "PUBLISHED"), true);
  assert.equal((await one(`select status from public.experiences where id = $1::uuid`, [event.experienceId])).status, "PUBLISHED");
  assert.equal((await rows(`select 1 from public.list_public_events() where slug = $1`, [event.slug])).length, 1);
  assert.equal((await rows(`select 1 from public.admin_audit_log where entity_id = $1::uuid and action = 'EVENT_UPDATED'`, [event.experienceId])).length, 2);

  // Status fora do ciclo de um evento e experiência regular são recusados.
  await rejects(updateEvent(event, "COMING_SOON"), /INVALID_EVENT_STATUS/);
  await rejects(call(
    `public.admin_update_event($1::uuid, $2::uuid, 'x', 'x', 'DRAFT', null, 0, '{}'::jsonb)`,
    [ADMIN, IMERSAO.id],
  ), /EVENT_NOT_FOUND/);
});

// ===========================================================================
// 3. Leitura pública
// ===========================================================================

test("listagens: as regulares são as atuais sem eventos; publicado, o evento só aparece nas de evento", async () => {
  const fresh = await fullDatabase();
  const freshFx = await rescheduleFixtures(async (sql, params = []) => (await fresh.query(sql, params)).rows as Row[]);
  const all = async (sql: string) => (await fresh.query(sql)).rows;

  assert.deepEqual(await all(`select * from public.list_public_regular_experiences()`), await all(`select * from public.list_public_experiences()`));
  assert.deepEqual(await all(`select * from public.list_public_regular_catalog()`), await all(`select * from public.list_public_catalog()`));
  assert.deepEqual(await all(`select * from public.list_public_events()`), []);

  const created = await freshFx.call(
    `public.admin_create_event($1::uuid, $2::uuid, 'essencia-teste', 'ESSÊNCIA', 'Corpo, mente e natureza', $3::jsonb, null, now() + interval '10 days', 210, 15000, 12)`,
    [ADMIN, freshFx.SUNSET_CONCHA.base_id, JSON.stringify(EDITORIAL)],
  );
  await fresh.query(`update public.special_event_settings set publication_enabled = true`);
  await fresh.query(`update public.experiences set status = 'PUBLISHED' where id = $1::uuid`, [created.experienceId]);
  await fresh.query(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [created.sessionId]);

  const slugs = async (sql: string) => (await fresh.query<{ slug: string }>(sql)).rows.map((row) => row.slug);
  assert.ok(!(await slugs(`select slug from public.list_public_regular_experiences()`)).includes("essencia-teste"));
  assert.ok(!(await slugs(`select slug from public.list_public_regular_catalog()`)).includes("essencia-teste"));
  assert.deepEqual(await slugs(`select slug from public.list_public_events()`), ["essencia-teste"]);
  // As listagens antigas não sabem de tipo: por isso o site troca para as
  // novas (fase 3) antes de qualquer evento ser publicado.
  assert.ok((await slugs(`select slug from public.list_public_experiences()`)).includes("essencia-teste"));
  // O motor de reservas é o mesmo: a sessão do evento é reservável como qualquer outra.
  assert.equal((await fresh.query(`select * from public.list_open_sessions('essencia-teste')`)).rows.length, 1);
  assert.equal((await fresh.query(`select * from public.get_booking_session($1::uuid)`, [created.sessionId])).rows.length, 1);

  const detail = (await fresh.query<Row>(`select * from public.get_public_event('  ESSENCIA-TESTE ')`)).rows[0];
  assert.deepEqual([detail.slug, detail.availability, detail.remaining_spots, detail.price_cents, detail.base_slug], ["essencia-teste", "AVAILABLE", 12, 15000, "concha-acustica"]);
  assert.ok(detail.base_address.includes("SHTN Trecho 1"));
  assert.ok(!("capacity" in detail), "a leitura pública não expõe a capacidade");
  await fresh.close();
});

test("situação pública: com vagas, esgotado, reservas encerradas, cancelado e realizado", async () => {
  const event = await onSaleEvent({ capacity: 2 });
  const state = async (sessionId = event.sessionId) => (await one(
    `select availability, remaining_spots from public.list_public_event_sessions($1) where id = $2::uuid`, [event.slug, sessionId],
  ));
  assert.deepEqual(await state(), { availability: "AVAILABLE", remaining_spots: 2 });
  await reserve(event.sessionId, 2);
  assert.deepEqual(await state(), { availability: "SOLD_OUT", remaining_spots: 0 });
  await setSessionStatus(event.sessionId, "CLOSED");
  assert.deepEqual(await state(), { availability: "CLOSED", remaining_spots: null });
  await setSessionStatus(event.sessionId, "CANCELLED");
  assert.deepEqual(await state(), { availability: "CANCELLED", remaining_spots: null });

  // Edição já realizada: continua listada, sem vagas.
  const past = await makeSession(event.experienceId, { price: PRICE, capacity: 12, startsIn: "-2 days" });
  assert.deepEqual(await state(past), { availability: "ENDED", remaining_spots: null });

  // Em destaque fica a próxima sessão ativa; sem ela, a mais recente.
  const upcoming = await makeSession(event.experienceId, { price: PRICE, capacity: 12, startsIn: "30 days" });
  assert.equal((await one(`select session_id from public.get_public_event($1)`, [event.slug])).session_id, upcoming);
  await rows(`update public.sessions set status = 'ARCHIVED' where id = $1::uuid`, [upcoming]);
  // Sem sessão ativa no futuro, a futura (cancelada) vem antes da já realizada.
  assert.deepEqual(await one(`select session_id, availability from public.get_public_event($1)`, [event.slug]), { session_id: event.sessionId, availability: "CANCELLED" });
  assert.equal((await rows(`select 1 from public.list_public_event_sessions($1) where id = $2::uuid`, [event.slug, upcoming])).length, 0, "arquivada não aparece");
});

// ===========================================================================
// 4. Capacidade de 12 vagas (motor de sempre)
// ===========================================================================

test("capacidade: 12 vagas a R$ 150 nunca passam do limite; receita máxima R$ 1.800", async () => {
  const event = await onSaleEvent();
  const first = await reserve(event.sessionId, 5);
  await reserve(event.sessionId, 5);
  await rejects(preReserve(event.sessionId, 3), /INSUFFICIENT_SPOTS/);
  const held = await preReserve(event.sessionId, 2);
  assert.equal(held.totalCents, 30_000);
  await rejects(preReserve(event.sessionId, 1), /INSUFFICIENT_SPOTS/);
  assert.equal((await one(`select public.available_spots($1::uuid) as n`, [event.sessionId])).n, 0);

  let report = await call(`public.admin_event_report($1::uuid, $2::uuid)`, [ADMIN, event.experienceId]);
  assert.equal(report.sessions[0].confirmedParticipants, 10);
  assert.equal(report.sessions[0].pendingParticipants, 2);
  assert.equal(report.sessions[0].pendingRevenueCents, 30_000);

  assert.equal(await call(
    `public.confirm_reservation_payment($1::uuid, 'INFINITEPAY', 'tx-evento-held', $2, 'https://recibo.teste/evento', '{}'::jsonb)`,
    [held.reservationId, held.totalCents],
  ), true);
  report = await call(`public.admin_event_report($1::uuid, $2::uuid)`, [ADMIN, event.experienceId]);
  assert.equal(report.totals.confirmedParticipants, 12);
  assert.equal(report.totals.confirmedRevenueCents, 180_000);
  assert.equal(report.sessions[0].remainingSpots, 0);
  const serialized = JSON.stringify(report);
  for (const personal of [first.email, first.name, first.cpf, "cpf", "email", "phone"]) assert.ok(!serialized.includes(personal), `relatório sem ${personal}`);

  const other = await onSaleEvent();
  await rejects(preReserve(other.sessionId, 13), /INSUFFICIENT_SPOTS/);
});

// ===========================================================================
// 5. Nenhuma reserva troca de tipo
// ===========================================================================

test("troca de turma do painel: bloqueada entre evento e regular, liberada dentro do mesmo tipo", async () => {
  const event = await onSaleEvent();
  const regular = await makeSession(SUNSET_CONCHA.id, { price: PRICE, capacity: 10 });
  const regularOther = await makeSession(SUNSET_CONCHA.id, { price: PRICE, capacity: 10 });
  const change = (reservationId: string, sessionId: string) => call(
    `public.admin_change_reservation_session($1::uuid, $2::uuid, $3::uuid, 'Pedido do cliente')`, [ADMIN, reservationId, sessionId],
  );

  const regularBooking = await reserve(regular, 2);
  await rejects(change(regularBooking.id, event.sessionId), /EVENT_KIND_MISMATCH/);
  assert.deepEqual(await reservationRow(regularBooking.id), { session_id: regular, experience_id: SUNSET_CONCHA.id, status: "CONFIRMED" });
  assert.equal(await changesOf(regularBooking.id), 0);

  const eventBooking = await reserve(event.sessionId, 2);
  await rejects(change(eventBooking.id, regular), /EVENT_KIND_MISMATCH/);
  assert.equal((await reservationRow(eventBooking.id)).session_id, event.sessionId);

  // Dentro do mesmo tipo, tudo como antes.
  const secondEdition = await makeSession(event.experienceId, { price: PRICE, capacity: 12, startsIn: "20 days" });
  await change(eventBooking.id, secondEdition);
  assert.equal((await reservationRow(eventBooking.id)).session_id, secondEdition);
  await change(regularBooking.id, regularOther);
  assert.equal((await reservationRow(regularBooking.id)).session_id, regularOther);

  const failure = adminMutationError(new Error("EVENT_KIND_MISMATCH"));
  assert.equal(failure.status, 409);
  assert.match(failure.message, /evento especial/);
});

test("Stand-by: painel e autoatendimento bloqueados entre tipos; a reserva continua aguardando", async () => {
  const event = await onSaleEvent();
  const regularOrigin = await makeSession(SUNSET_CONCHA.id, { price: PRICE, capacity: 10 });
  const regularTarget = await makeSession(SUNSET_CONCHA.id, { price: PRICE, capacity: 10 });

  const booking = await reserve(regularOrigin, 2);
  const entered = await setStandby(booking.id);
  await rejects(reschedule(booking.id, event.sessionId), /EVENT_KIND_MISMATCH/);
  await rejects(call(
    `public.customer_reschedule_reservation($1, $2, null, $3::uuid, $4::uuid)`, [booking.cpf, booking.code, entered.standbyId, event.sessionId],
  ), /EVENT_KIND_MISMATCH/);
  assert.deepEqual(await reservationRow(booking.id), { session_id: regularOrigin, experience_id: SUNSET_CONCHA.id, status: "AWAITING_RESCHEDULE" });
  assert.equal((await one(`select resolved_at from public.reservation_standby where id = $1::uuid`, [entered.standbyId])).resolved_at, null);
  assert.equal(await changesOf(booking.id), 0);
  assert.equal((await rows(`select 1 from public.reservation_reschedule_emails where reservation_id = $1::uuid`, [booking.id])).length, 0);

  // A turma regular do mesmo valor continua valendo.
  await reschedule(booking.id, regularTarget);
  assert.deepEqual(await reservationRow(booking.id), { session_id: regularTarget, experience_id: SUNSET_CONCHA.id, status: "CONFIRMED" });

  // Reserva de evento em Stand-by: só volta para uma sessão de evento.
  const eventBooking = await reserve(event.sessionId, 1);
  const eventStandby = await setStandby(eventBooking.id);
  await rejects(reschedule(eventBooking.id, regularTarget), /EVENT_KIND_MISMATCH/);
  await rejects(call(
    `public.customer_reschedule_reservation($1, $2, null, $3::uuid, $4::uuid)`, [eventBooking.cpf, eventBooking.code, eventStandby.standbyId, regularTarget],
  ), /EVENT_KIND_MISMATCH/);
  const nextEdition = await makeSession(event.experienceId, { price: PRICE, capacity: 12, startsIn: "25 days" });
  await call(
    `public.customer_reschedule_reservation($1, $2, null, $3::uuid, $4::uuid)`, [eventBooking.cpf, eventBooking.code, eventStandby.standbyId, nextEdition],
  );
  assert.deepEqual(await reservationRow(eventBooking.id), { session_id: nextEdition, experience_id: event.experienceId, status: "CONFIRMED" });

  // Desfazer devolve à turma original, que é do mesmo tipo.
  const undoBooking = await reserve(event.sessionId, 1);
  await setStandby(undoBooking.id);
  await call(`public.admin_undo_reservation_standby($1::uuid, $2::uuid, 'Evento mantido')`, [ADMIN, undoBooking.id]);
  assert.equal((await reservationRow(undoBooking.id)).status, "CONFIRMED");

  assert.equal(standbyMutationError(new Error("EVENT_KIND_MISMATCH")).status, 409);
  const customer = selfServiceRescheduleError(new Error("EVENT_KIND_MISMATCH"), { kind: "CPF_CODE", cpf: booking.cpf, publicCode: booking.code });
  assert.deepEqual([customer.status, customer.code], [409, "SESSION_UNAVAILABLE"]);
});

// ===========================================================================
// 6. Lista de espera, duplicação, painel
// ===========================================================================

test("lista de espera: a sessão de evento esgotada funciona como qualquer turma", async () => {
  const event = await onSaleEvent({ capacity: 2 });
  await reserve(event.sessionId, 2);
  const listed = await one(`select sold_out, remaining_spots from public.list_public_sessions($1)`, [event.slug]);
  assert.deepEqual([listed.sold_out, listed.remaining_spots], [true, 0]);
  const joined = await call(
    `public.waitlist_join($1::uuid, 'Pessoa Espera Evento', 'espera.evento@teste.local', '+5561999990077', 1, null, '')`, [event.sessionId],
  );
  assert.equal(joined.status, "ACCEPTED");
});

test("duplicar: nova edição em rascunho, sessão fechada, nenhuma reserva copiada", async () => {
  const source = await onSaleEvent();
  await reserve(source.sessionId, 3);
  const copy = await call(
    `public.admin_duplicate_event($1::uuid, $2::uuid, $3, 'Evento Segunda Edição', now() + interval '40 days')`,
    [ADMIN, source.experienceId, `${source.slug}-2`],
  );
  const experience = await one(`select kind, status, base_id, editorial_content from public.experiences where id = $1::uuid`, [copy.experienceId]);
  assert.deepEqual([experience.kind, experience.status, experience.base_id], ["EVENT", "DRAFT", CONCHA]);
  assert.deepEqual(experience.editorial_content, EDITORIAL);
  const session = await one(`select status::text as status, price_cents, capacity, duration_minutes from public.sessions where id = $1::uuid`, [copy.sessionId]);
  assert.deepEqual(session, { status: "CLOSED", price_cents: 15000, capacity: 12, duration_minutes: 210 });
  assert.equal((await rows(`select 1 from public.reservations where session_id = $1::uuid`, [copy.sessionId])).length, 0);
  assert.equal((await rows(`select 1 from public.admin_audit_log where entity_id = $1::uuid and action = 'EVENT_DUPLICATED'`, [copy.experienceId])).length, 1);
  assert.equal((await one(`select status from public.experiences where id = $1::uuid`, [source.experienceId])).status, "PUBLISHED");
  await rejects(call(
    `public.admin_duplicate_event($1::uuid, $2::uuid, 'copia-regular', 'Cópia', now() + interval '40 days')`, [ADMIN, IMERSAO.id],
  ), /EVENT_NOT_FOUND/);
});

test("painel: lista e relatório só de eventos, sem misturar a agenda regular", async () => {
  await createEvent();
  const listed = await rows(`select id from public.admin_list_events($1::uuid)`, [ADMIN]);
  const kinds = await rows(`select distinct e.kind from public.experiences e where e.id = any($1::uuid[])`, [listed.map((row) => row.id)]);
  assert.deepEqual(kinds.map((row) => row.kind), ["EVENT"]);
  await rejects(call(`public.admin_event_report($1::uuid, $2::uuid)`, [ADMIN, IMERSAO.id]), /EVENT_NOT_FOUND/);
});

// ===========================================================================
// 7. Migration, diagnósticos e rollback
// ===========================================================================

const NEW_FUNCTIONS = [
  "admin_create_event(uuid,uuid,text,text,text,jsonb,text,timestamp with time zone,integer,integer,integer)",
  "admin_duplicate_event(uuid,uuid,text,text,timestamp with time zone)",
  "admin_event_report(uuid,uuid)",
  "admin_list_events(uuid)",
  "admin_update_event(uuid,uuid,text,text,text,text,integer,jsonb)",
  "enforce_experience_kind_rules()",
  "enforce_reservation_event_kind()",
  "get_public_event(text)",
  "list_public_event_sessions(text)",
  "list_public_events()",
  "list_public_regular_catalog()",
  "list_public_regular_experiences()",
  "special_event_availability(uuid)",
];

const functionsSql = `select p.oid::regprocedure::text as name, md5(p.prosrc) as src from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`;

test("migration: aditiva, idempotente, sem tocar função existente nem linha operacional", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  const old = (await before.query<{ name: string; src: string }>(functionsSql)).rows;
  const experiencesBefore = (await before.query(`select id, updated_at from public.experiences order by id`)).rows;
  await applyMigration(before, MIGRATION);
  await applyMigration(before, MIGRATION);
  const current = new Map((await before.query<{ name: string; src: string }>(functionsSql)).rows.map((row) => [row.name, row.src]));
  for (const row of old) assert.equal(current.get(row.name), row.src, `${row.name} não pode mudar`);
  assert.deepEqual([...current.keys()].filter((name) => !old.some((row) => row.name === name)).sort(), NEW_FUNCTIONS);
  assert.deepEqual((await before.query(`select id, updated_at from public.experiences order by id`)).rows, experiencesBefore, "nenhuma experiência foi reescrita");
  assert.equal((await before.query(`select * from public.special_event_settings`)).rows.length, 1);

  const privileges = async (fn: string) => (await before.query<Row>(
    `select has_function_privilege('anon', $1, 'EXECUTE') as a, has_function_privilege('authenticated', $1, 'EXECUTE') as b,
            has_function_privilege('service_role', $1, 'EXECUTE') as c, p.prosecdef as definer
     from pg_proc p where p.oid = $1::regprocedure`, [`public.${fn}`])).rows[0];
  for (const fn of NEW_FUNCTIONS) {
    const row = await privileges(fn);
    assert.equal(row.definer, true, fn);
    if (fn.startsWith("admin_")) assert.deepEqual([row.a, row.b, row.c], [false, false, true], fn);
    else if (fn.startsWith("enforce_")) assert.deepEqual([row.a, row.b, row.c], [false, false, false], fn);
    else if (fn.startsWith("special_event_availability")) assert.deepEqual([row.a, row.b, row.c], [false, false, true], fn);
    else assert.deepEqual([row.a, row.b, row.c], [true, true, true], fn);
  }
  const table = (await before.query<Row>(
    `select c.relrowsecurity as rls, has_table_privilege('service_role', c.oid, 'SELECT') as s, has_table_privilege('anon', c.oid, 'SELECT') as a,
            has_table_privilege('authenticated', c.oid, 'UPDATE') as u
     from pg_class c where c.oid = 'public.special_event_settings'::regclass`)).rows[0];
  assert.deepEqual([table.rls, table.s, table.a, table.u], [true, false, false, false]);
  assert.equal((await before.query<Row>(`select publication_enabled from public.special_event_settings`)).rows[0].publication_enabled, false);

  const code = source(`supabase/migrations/${MIGRATION}`).split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
  assert.doesNotMatch(code, /cron\.schedule|pg_net|net\.http|create extension/i);
  assert.doesNotMatch(code, /(insert into|update|delete from) public\.(reservations|sessions|payment_events|reservation_standby|waitlist_\w+|bases)\b/i);
  assert.doesNotMatch(code, /create or replace function public\.(list_public_experiences|list_public_catalog|get_public_experience|list_open_sessions|create_pre_reservation|admin_change_reservation_session|customer_reschedule_reservation|admin_reschedule_standby_same_price)\b/i);
  assert.doesNotMatch(code, /drop function|cascade/i);
  await before.close();
});

const PREFLIGHT = source("supabase/diagnostics/special_events_foundation_preflight.sql");
const POSTCHECK = source("supabase/diagnostics/special_events_foundation_postcheck.sql");
const ROLLBACK = source("supabase/rollback/202610280001_special_events_foundation.rollback.sql");

type Check = { check_name: string; result: string; status: string };

async function report(database: { query: (sql: string) => Promise<{ rows: unknown[] }> }, sql: string) {
  return new Map(((await database.query(sql)).rows as Check[]).map((row) => [row.check_name, row]));
}

test("preflight e postcheck: aprovam o banco do repositório, nas duas pontas", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  const pre = await report(before, PREFLIGHT);
  for (const [name, row] of pre) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  await assert.rejects(before.query(POSTCHECK), /does not exist/);
  await applyMigration(before, MIGRATION);
  const post = await report(before, POSTCHECK);
  for (const [name, row] of post) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  assert.equal(post.get("FUNCOES_NOVAS_COM_A_DEFINICAO_DO_REPOSITORIO")?.result, "13 de 13");
  assert.match(post.get("INTERRUPTOR_DA_PUBLICACAO")!.result, /^desligado/);
  for (const count of ["ASSINATURA_DAS_FUNCOES_EXISTENTES", "EXPERIENCIAS_POR_STATUS", "SESSOES_POR_STATUS", "RESERVAS_POR_STATUS"]) {
    assert.equal(post.get(count)?.result, pre.get(count)?.result, count);
  }

  // Mais tarde, com um evento publicado: aviso, não falha, e as listagens
  // regulares continuam sem perda.
  const local = await rescheduleFixtures(async (sql, params = []) => (await before.query(sql, params)).rows as Row[]);
  const created = await local.call(
    `public.admin_create_event($1::uuid, $2::uuid, 'evento-postcheck', 'Evento', 'x', $3::jsonb, null, now() + interval '10 days', 210, 15000, 12)`,
    [ADMIN, local.SUNSET_CONCHA.base_id, JSON.stringify(EDITORIAL)],
  );
  await before.query(`update public.special_event_settings set publication_enabled = true`);
  await before.query(`update public.experiences set status = 'PUBLISHED' where id = $1::uuid`, [created.experienceId]);
  const later = await report(before, POSTCHECK);
  for (const name of ["INTERRUPTOR_DA_PUBLICACAO", "EXPERIENCIAS_POR_TIPO", "EVENTOS_PUBLICOS"]) assert.equal(later.get(name)?.status, "ATENCAO", name);
  assert.equal(later.get("LISTAGENS_REGULARES_SEM_PERDA")?.status, "OK");
  assert.equal(later.get("EVENTOS_POSTCHECK_OK")?.status, "OK");
  await before.close();
});

test("preflight: reprova se uma função que a migration chama estiver diferente do repositório", async () => {
  const before = await fullDatabase({ until: PREVIOUS });
  await before.exec(`create or replace function public.available_spots(p_session_id uuid) returns integer language sql stable security definer set search_path = public as $$ select 99 $$`);
  const pre = await report(before, PREFLIGHT);
  assert.equal(pre.get("FUNCOES_QUE_A_MIGRATION_CHAMA")?.status, "FALHOU");
  assert.match(pre.get("FUNCOES_QUE_A_MIGRATION_CHAMA")!.result, /available_spots=DIFERENTE/);
  assert.equal(pre.get("EVENTOS_PREFLIGHT_OK")?.status, "FALHOU");
  await before.close();
});

test("rollback: remove só o que a migration criou; recusa enquanto houver evento; reaplicar devolve tudo", async () => {
  const database = await fullDatabase();
  const before = (await database.query<{ name: string; src: string }>(functionsSql)).rows;

  await database.exec(ROLLBACK);
  const after = (await database.query<{ name: string; src: string }>(functionsSql)).rows;
  assert.deepEqual(before.filter((row) => !after.some((kept) => kept.name === row.name)).map((row) => row.name).sort(), NEW_FUNCTIONS);
  for (const row of after) assert.equal(row.src, before.find((old) => old.name === row.name)?.src, row.name);
  assert.equal((await database.query(`select 1 from information_schema.columns where table_name = 'experiences' and column_name = 'kind'`)).rows.length, 0);
  assert.equal((await database.query<Row>(`select to_regclass('public.special_event_settings') as t`)).rows[0].t, null);
  await database.exec(ROLLBACK); // de novo: sem efeito e sem erro

  await applyMigration(database, MIGRATION);
  assert.equal((await report(database, POSTCHECK)).get("EVENTOS_POSTCHECK_OK")?.status, "OK");

  const local = await rescheduleFixtures(async (sql, params = []) => (await database.query(sql, params)).rows as Row[]);
  await local.call(
    `public.admin_create_event($1::uuid, $2::uuid, 'evento-rollback', 'Evento', 'x', '{}'::jsonb, null, now() + interval '10 days', 210, 15000, 12)`,
    [ADMIN, local.SUNSET_CONCHA.base_id],
  );
  await assert.rejects(database.exec(ROLLBACK), /ROLLBACK_RECUSADO/);
  await database.exec(`rollback`);
  assert.equal((await database.query<Row>(`select kind from public.experiences where slug = 'evento-rollback'`)).rows[0].kind, "EVENT");
  assert.equal((await database.query(`select 1 from pg_trigger where tgname = 'reservations_event_kind_guard'`)).rows.length, 1);
  await database.close();
});
