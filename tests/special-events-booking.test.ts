/**
 * Eventos especiais — etapa 5A: reservas pelo fluxo de sempre.
 *
 * O evento usa `/reservar/[sessionId]`, `POST /api/reservations`,
 * `create_pre_reservation` e a confirmação de pagamento existentes. Este
 * arquivo prova o que muda antes da pré-reserva — venda fechada no servidor
 * enquanto `EVENT_BOOKING_OPEN` estiver desligada e no máximo 6 participantes
 * por pedido do ESSÊNCIA — e que a experiência regular segue igual.
 *
 * Banco: o Postgres em memória (PGlite) com todas as migrations. Nada é gravado
 * no Supabase; nenhuma cobrança é feita.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  EVENT_BOOKING_CLOSED_MESSAGE,
  eventBookingContext,
  eventBookingRejection,
  eventQuantityLimit,
  loadSessionBookingRules,
  type RulesQueryClient,
  type SessionBookingRules,
} from "../lib/events/booking.ts";
import { RESERVATION_MAX_QUANTITY, validateEventEditorial } from "../lib/events/editorial.ts";
import { isEventBookingOpen } from "../lib/events/flags.ts";
import { ESSENCIA_EDITORIAL, essenciaDemoEvent } from "../lib/events/fixtures/essencia.ts";
import { reservationQuantityOptions } from "../lib/waitlist/public.ts";
import { fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";
import { ADMIN, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const db = await fullDatabase();
const admin = createPgliteAdmin(db);
const rulesClient = admin.client as unknown as RulesQueryClient;
const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
const { call, rows, IMERSAO, SUNSET_CONCHA, makeSession, reserve } = fx;

let sequence = 0;

/** O ESSÊNCIA cadastrado só no banco de teste: publicado, sessão aberta, 12 vagas, R$ 150. */
async function essencia() {
  sequence += 1;
  const created = await call(
    `public.admin_create_event($1::uuid, $2::uuid, $3, 'ESSÊNCIA — Corpo, Mente e Natureza', 'Canoa, meditação e Superioga', $4::jsonb, null, now() + interval '9 days', 210, 15000, 12)`,
    [ADMIN, SUNSET_CONCHA.base_id, `essencia-teste-${sequence}`, JSON.stringify(ESSENCIA_EDITORIAL)],
  );
  await rows(`update public.special_event_settings set publication_enabled = true`);
  await rows(`update public.experiences set status = 'PUBLISHED' where id = $1::uuid`, [created.experienceId]);
  await rows(`update public.special_event_settings set publication_enabled = false`);
  await rows(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [created.sessionId]);
  return created.sessionId as string;
}

/**
 * O que `POST /api/reservations` faz, na mesma ordem: regras da sessão, recusa
 * de evento, pré-reserva no banco. Devolve a recusa ou a reserva criada.
 */
async function startReservation(sessionId: string, quantity: number, bookingOpen: boolean) {
  const rules = await loadSessionBookingRules(rulesClient, sessionId);
  const rejection = eventBookingRejection(rules, quantity, bookingOpen);
  if (rejection) return { rejected: rejection.code };
  sequence += 1;
  try {
    const created = await call(
      `public.create_pre_reservation($1::uuid, $2, $3, $4, $5, $6, null, gen_random_uuid())`,
      [sessionId, `Participante Ingresso ${sequence}`, String(70_000_000_000 + sequence), `+55619${String(50_000_000 + sequence)}`, `ingresso${sequence}@teste.local`, quantity],
    );
    return { created };
  } catch (error) {
    return { failed: (error as Error).message };
  }
}

// ===========================================================================
// 1. Venda fechada no servidor
// ===========================================================================

test("interruptor: a venda de eventos nasce fechada e exige a seção pública ligada", () => {
  assert.equal(isEventBookingOpen({}), false);
  assert.equal(isEventBookingOpen({ EVENT_BOOKING_OPEN: "true" }), false, "sem EVENTS_PUBLIC_ENABLED não vende");
  assert.equal(isEventBookingOpen({ EVENTS_PUBLIC_ENABLED: "true" }), false);
  assert.equal(isEventBookingOpen({ EVENT_BOOKING_OPEN: "1", EVENTS_PUBLIC_ENABLED: "true" }), false);
  assert.equal(isEventBookingOpen({ EVENT_BOOKING_OPEN: "true", EVENTS_PUBLIC_ENABLED: "true" }), true);
});

test("regra: evento com venda fechada é recusado; experiência regular nunca é afetada", () => {
  const event: SessionBookingRules = { kind: "EVENT", maxPerOrder: 6 };
  assert.deepEqual(eventBookingRejection(event, 1, false), { status: 409, code: "EVENT_BOOKING_CLOSED", message: EVENT_BOOKING_CLOSED_MESSAGE });
  assert.deepEqual(eventBookingRejection(event, 7, true), { status: 400, code: "EVENT_ORDER_LIMIT", message: "Cada pedido deste evento aceita até 6 participantes.", field: "quantity" });
  assert.equal(eventBookingRejection(event, 6, true), null);
  assert.equal(eventBookingRejection(event, 1, true), null);
  for (const open of [true, false]) {
    for (const quantity of [1, 6, 7, 20]) assert.equal(eventBookingRejection({ kind: "REGULAR" }, quantity, open), null, `regular ${quantity}`);
  }
  assert.equal(eventBookingRejection(null, 1, false), null, "sessão inexistente fica com a recusa de sempre do banco");
});

test("acesso direto: com a venda fechada, nem o id da sessão abre uma reserva de evento", async () => {
  const session = await essencia();
  assert.deepEqual(await loadSessionBookingRules(rulesClient, session), { kind: "EVENT", maxPerOrder: 6 });
  assert.deepEqual(await startReservation(session, 1, false), { rejected: "EVENT_BOOKING_CLOSED" });
  assert.equal((await rows(`select 1 from public.reservations where session_id = $1::uuid`, [session])).length, 0, "nenhuma vaga bloqueada");

  // A rota faz essa conferência antes de qualquer outra coisa que bloqueie vaga.
  const route = source("app/api/reservations/route.ts");
  const rules = route.indexOf("loadSessionBookingRules(");
  const rejection = route.indexOf("eventBookingRejection(rules, input.quantity, isEventBookingOpen())");
  const creation = route.indexOf('admin.rpc("create_pre_reservation"');
  assert.ok(rules > 0 && rejection > rules && creation > rejection, "regras → recusa → pré-reserva");
  assert.match(route, /status: 503/, "sem conseguir ler as regras, não abre reserva");
});

// ===========================================================================
// 2. Limite por pedido e capacidade
// ===========================================================================

test("ESSÊNCIA: até 6 por pedido, 12 no total, R$ 150 por pessoa decididos pelo banco", async () => {
  const session = await essencia();
  assert.deepEqual(await startReservation(session, 7, true), { rejected: "EVENT_ORDER_LIMIT" });
  const first = await startReservation(session, 6, true);
  assert.equal(first.created.totalCents, 90_000, "6 × R$ 150");
  const second = await startReservation(session, 6, true);
  assert.equal(second.created.totalCents, 90_000);
  // Capacidade cheia: a última tentativa é recusada pelo banco, não pela página.
  const third = await startReservation(session, 1, true);
  assert.match(third.failed ?? "", /INSUFFICIENT_SPOTS/);
  const occupied = await rows(`select coalesce(sum(quantity), 0)::int as n, coalesce(sum(total_cents), 0)::int as total from public.reservations where session_id = $1::uuid and status = 'PRE_RESERVED'`, [session]);
  assert.deepEqual(occupied[0], { n: 12, total: 180_000 }, "receita bruta máxima R$ 1.800");
  // O preço é o da sessão: o navegador não manda valor nenhum.
  assert.doesNotMatch(source("lib/reservations/validation.ts"), /price|totalCents|unitPrice/i);
});

test("última vaga: com 1 vaga restante, só um pedido de 1 entra", async () => {
  const session = await essencia();
  await reserve(session, 6);
  await reserve(session, 5);
  const [a, b] = [await startReservation(session, 1, true), await startReservation(session, 1, true)];
  assert.ok(a.created, "a primeira leva a última vaga");
  assert.match(b.failed ?? "", /INSUFFICIENT_SPOTS/);
  // Concorrência real (sessões independentes do Postgres): special-events-concurrency.test.ts.
  assert.match(source("tests/special-events-concurrency.test.ts"), /16 pessoas compram 1 vaga ao mesmo tempo/);
});

test("pré-reserva vencida deixa de ocupar vaga do evento", async () => {
  const session = await essencia();
  const held = await startReservation(session, 6, true);
  // Criada há 3 h, venceu há 1 h (a retenção é de 2 h).
  await rows(`update public.reservations set created_at = now() - interval '3 hours', expires_at = now() - interval '1 hour' where id = $1::uuid`, [held.created.reservationId]);
  assert.equal(Number((await rows(`select public.available_spots($1::uuid) as n`, [session]))[0].n), 12);
  assert.ok((await startReservation(session, 6, true)).created);
});

test("quantidade: o formulário do evento oferece até 6; o da experiência regular, como antes", () => {
  assert.equal(eventQuantityLimit(12, 6), 6);
  assert.equal(eventQuantityLimit(4, 6), 4);
  assert.equal(eventQuantityLimit(0, 6), 0);
  assert.deepEqual(reservationQuantityOptions(eventQuantityLimit(12, 6)), [1, 2, 3, 4, 5, 6]);
  assert.equal(reservationQuantityOptions(12).length, 12, "regular: até as vagas, limite geral de 20");
  assert.equal(reservationQuantityOptions(40).length, RESERVATION_MAX_QUANTITY);
});

test("conteúdo: o máximo por pedido é configurável por evento e validado", () => {
  const essence = validateEventEditorial(ESSENCIA_EDITORIAL);
  assert.ok(essence.success);
  if (!essence.success) return;
  assert.equal(essence.data.event.reservation.maxPerOrder, 6);
  const other = JSON.parse(JSON.stringify(ESSENCIA_EDITORIAL));
  delete other.event.reservation.maxPerOrder;
  const parsed = validateEventEditorial(other);
  assert.ok(parsed.success);
  if (parsed.success) assert.equal(parsed.data.event.reservation.maxPerOrder, RESERVATION_MAX_QUANTITY, "sem o campo, o limite geral");
  other.event.reservation.maxPerOrder = 0;
  assert.equal(validateEventEditorial(other).success, false);
  other.event.reservation.maxPerOrder = 21;
  assert.equal(validateEventEditorial(other).success, false);
});

test("regras da sessão: regular, evento, inexistente, banco antigo e falha", async () => {
  const regular = await makeSession(IMERSAO.id, { price: 7_000 });
  assert.deepEqual(await loadSessionBookingRules(rulesClient, regular), { kind: "REGULAR" });
  assert.equal(await loadSessionBookingRules(rulesClient, "00000000-0000-4000-8000-000000000000"), null);

  const fake = (experienceError: { message: string; code?: string } | null): RulesQueryClient => ({
    from(table: string) {
      return { select() { return { eq: async () => (table === "sessions" ? { data: [{ experience_id: "e1" }], error: null } : { data: null, error: experienceError }) }; } };
    },
  });
  assert.deepEqual(await loadSessionBookingRules(fake({ message: "column experiences.kind does not exist", code: "42703" }), "s"), { kind: "REGULAR" });
  await assert.rejects(loadSessionBookingRules(fake({ message: "fetch failed" }), "s"), /BOOKING_RULES_FAILED/);
});

test("experiência regular: reserva e pagamento como sempre, mesmo com a venda de eventos fechada", async () => {
  const regular = await makeSession(IMERSAO.id, { price: 7_000, capacity: 20 });
  const created = await startReservation(regular, 8, false);
  assert.equal(created.created.totalCents, 56_000);
  const booking = await reserve(regular, 2);
  assert.equal((await rows(`select status::text as status from public.reservations where id = $1::uuid`, [booking.id]))[0].status, "CONFIRMED");
});

// ===========================================================================
// 3. O que o cliente lê antes de pagar
// ===========================================================================

test("resumo do ingresso: programação, incluso, chegada e política exata antes do pagamento", () => {
  const context = eventBookingContext(essenciaDemoEvent());
  assert.equal(context.slug, "essencia");
  assert.equal(context.title, "ESSÊNCIA");
  assert.equal(context.dayLabel, "07 NOV · SÁBADO");
  assert.equal(context.timeRange, "05H30 ÀS 09H");
  assert.equal(context.arrivalNote, "Início às 05h30, com tolerância de chegada até 05h50.");
  assert.deepEqual(context.program.map((item) => item.time), ["05h30", "07h30", "07h45", "09h"]);
  assert.equal(context.included.length, 5);
  assert.equal(context.maxPerOrder, 6);
  assert.equal(
    context.cancellationShort,
    "Cancelamento até 05/11/2026 às 12h00 (horário de Brasília): crédito para utilizar em outras experiências da Alma Azul ou solicitação de reembolso com nossa equipe.",
  );
  assert.deepEqual(context.cancellationParagraphs, [
    "Você pode solicitar o cancelamento até 5 de novembro de 2026, às 12h00 (horário de Brasília), escolhendo entre crédito para utilizar em outras experiências da Alma Azul ou solicitação de reembolso com nossa equipe.",
    "Após esse prazo, entre em contato conosco para avaliação do seu caso.",
  ]);
});

test("formulário do evento: ingresso, política antes do botão e nada de turma", () => {
  const form = source("components/reservation/reservation-form.tsx");
  assert.match(form, /"Garantir meu ingresso"/);
  assert.match(form, /event \? "Participantes" : "Quantidade de pessoas"/);
  assert.match(form, /Até \{event\.maxPerOrder\} por pedido\./);
  const policy = form.indexOf('id="politica-cancelamento"');
  const submit = form.indexOf('<Button type="submit"');
  assert.ok(policy > 0 && policy < submit, "a política aparece antes do botão de pagamento");
  assert.match(form, /reservationQuantityOptions\(eventQuantityLimit\(spots, event\.maxPerOrder\)\)/);
  assert.match(form, /options\.map\(\(value\) => <option/);
  assert.match(form, /href=\{`\/eventos\/\$\{event\.slug\}`\}/);
  // A experiência regular mantém o texto de sempre.
  assert.match(form, /"Reservar vaga"/);
  assert.match(form, /<Link href="\/agenda"[^>]*>Ver próximas datas<\/Link>/);

  const summary = source("components/reservation/reservation-summary.tsx");
  assert.match(summary, /Resumo do ingresso/);
  assert.match(summary, /Ingresso único · programação completa/);
  assert.match(summary, /por participante/);
  assert.match(summary, /if \(event\) return <EventSummary/);
});

test("página de reserva: formulário só com a venda aberta, local do evento e volta para o evento", () => {
  const page = source("app/reservar/[sessionId]/page.tsx");
  assert.match(page, /session && bookingOpen \? \(/);
  assert.match(page, /const bookingOpen = isEventBookingOpen\(\);/);
  assert.match(page, /Reservas ainda não abertas/);
  assert.match(page, /Evento esgotado/);
  assert.match(page, /Voltar para o evento/);
  assert.match(page, /<BaseLocationCard location=\{event\.location\}/);
  assert.match(page, /<ReservationForm session=\{session\} event=\{eventBookingContext\(event\)\} \/>/);
  assert.match(page, /label="Seu ingresso"/);
  // O ramo regular continua igual.
  assert.match(page, /Voltar para as datas/);
  assert.match(page, /<ReservationForm session=\{session\} waitlistEnabled=\{waitlistEnabled\} waitlistSignup=\{waitlistSignup\} \/>/);
});

test("pré-reserva e retorno do pagamento: textos de ingresso e link para o evento", () => {
  const hold = source("components/reservation/reservation-hold.tsx");
  assert.match(hold, /Seus ingressos estão reservados por 2 horas\./);
  assert.match(hold, /Voltar ao evento/);
  const ret = source("app/pagamento/retorno/page.tsx");
  assert.match(ret, /summary\.eventSlug \? "Ingresso confirmado" : "Turma confirmada"/);
  assert.match(ret, /href=\{`\/eventos\/\$\{summary\.eventSlug\}`\}/);
  // A confirmação do pagamento é a de sempre.
  assert.match(ret, /await confirmPayment\(\{/);
});

test("página do evento: o botão só leva ao checkout com a venda aberta; a prévia nunca", () => {
  assert.match(source("app/eventos/[slug]/page.tsx"), /bookingOpen=\{isEventBookingOpen\(\)\}/);
  assert.match(source("app/eventos/demonstracao/[slug]/page.tsx"), /bookingOpen=\{false\}/);
});

test("pagamento e confirmação: nenhum arquivo do motor financeiro foi alterado nesta etapa", () => {
  // O motor continua o mesmo: a rota só ganhou a conferência antes da pré-reserva.
  const route = source("app/api/reservations/route.ts");
  assert.match(route, /provider\.createCheckout\(\{/);
  assert.match(route, /unitPriceCents: Math\.round\(created\.totalCents \/ created\.quantity\)/);
  assert.match(source("lib/reservations/payment-confirmation.ts"), /confirm_reservation_payment/);
});
