/**
 * Eventos especiais — etapa 5B: e-mails de reserva do evento.
 *
 * Prova que uma reserva de evento recebe o e-mail do evento — montado do
 * conteúdo editorial, no horário de Brasília — pelo mesmo envio de sempre
 * (reivindicação, idempotência, tentativas), que nunca sai o e-mail genérico
 * de remada para um ingresso de evento e que os e-mails das experiências
 * regulares não mudaram. Nada é enviado: o provedor é sempre falso.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { eventBookingRejection, loadSessionBookingRules, type RulesQueryClient } from "../lib/events/booking.ts";
import { validateEventEditorial } from "../lib/events/editorial.ts";
import { eventEmailMissing } from "../lib/events/email-readiness.ts";
import { CONCHA_ACUSTICA_LOCATION, ESSENCIA_CAPACITY, ESSENCIA_EDITORIAL, ESSENCIA_STARTS_AT } from "../lib/events/fixtures/essencia.ts";
import {
  buildCheckinReminderEmail,
  buildReservationConfirmationEmail,
  buildReservationRescheduleEmail,
  CANCELLATION_NOTE,
  deliverReservationConfirmationEmail,
  EVENT_EMAIL_NOT_READY,
  MEETING_TOLERANCE_NOTE,
  parseReservationConfirmationData,
  PREPARATION_ITEMS,
  type ConfirmationEmail,
  type ReservationConfirmationData,
} from "../lib/reservations/confirmation-email.ts";
import { withEventEmailContext, type EventEmailQueryClient } from "../lib/reservations/event-email-context.ts";
import { fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";
import { ADMIN, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const editorial = validateEventEditorial(ESSENCIA_EDITORIAL);
if (!editorial.success) throw new Error(editorial.errors.join("; "));
const CONTENT = editorial.data.event;

function eventData(overrides: Partial<ReservationConfirmationData> = {}): ReservationConfirmationData {
  return {
    reservationId: "00000000-0000-4000-8000-0000000e55e1",
    publicCode: "ESS7K2M9QX",
    fullName: "Marina Albuquerque",
    email: "marina@teste.local",
    quantity: 2,
    experienceTitle: "ESSÊNCIA — Corpo, Mente e Natureza",
    startsAt: ESSENCIA_STARTS_AT,
    checkinToken: "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b",
    durationMinutes: 210,
    location: CONCHA_ACUSTICA_LOCATION,
    event: CONTENT,
    ...overrides,
  };
}

/** O que nunca pode aparecer num e-mail de evento: textos de remada da base. */
const GENERIC = [CANCELLATION_NOTE, MEETING_TOLERANCE_NOTE, ...PREPARATION_ITEMS, "1 dia antes", "roupa de banho", "chinelo", "Nos vemos na água", "Criaremos um grupo", "fornecidos pela equipe", "materiais necessários"];

function assertNoGeneric(message: ConfirmationEmail, label: string) {
  for (const text of GENERIC) {
    assert.ok(!message.text.includes(text), `${label} (texto) não pode citar: ${text}`);
    assert.ok(!message.html.includes(text), `${label} (HTML) não pode citar: ${text}`);
  }
}

// ===========================================================================
// 1. Conteúdo do e-mail de confirmação do evento
// ===========================================================================

test("confirmação do evento: todo o conteúdo obrigatório, no horário de Brasília", () => {
  const email = buildReservationConfirmationEmail(eventData());
  assert.equal(email.to, "marina@teste.local");
  assert.equal(email.subject, "Ingresso confirmado — ESSÊNCIA — Corpo, Mente e Natureza · ESS7K2M9QX");
  const required = [
    "ESSÊNCIA — Corpo, Mente e Natureza",
    "sábado, 07 de novembro de 2026",
    "Início: 05h30",
    "Tolerância de chegada: até 05h50",
    "Encerramento previsto: 09h00",
    "Participantes: 2 participantes",
    "Código da reserva: ESS7K2M9QX",
    "Em frente ao Cápsula Bar — Concha Acústica",
    "SHTN Trecho 1, Lote 8 — Brasília/DF",
    "05h30 — Canoa havaiana ao nascer do sol",
    "07h30 — Meditação sensorial (com Rapha Dantas e Fernanda Garcia)",
    "07h45 — Superioga (com Rapha Dantas)",
    "09h — Encerramento e conexão",
    "roupas confortáveis",
    "garrafa de água, protetor solar",
    "Para participar da prática de Superioga, traga seu próprio tapete. A organização não disponibilizará tapetes para essa atividade.",
    "O uso de colete salva-vidas é obrigatório durante a atividade na água.",
    "lanche saudável oferecido pela Nutre Congelados Saudáveis",
    "Você pode solicitar o cancelamento até 5 de novembro de 2026, às 12h00 (horário de Brasília), escolhendo entre crédito para utilizar em outras experiências da Alma Azul ou solicitação de reembolso com nossa equipe.",
    "Prazo: 05/11/2026 às 12h00 (horário de Brasília).",
    "SEU QR CODE DE CHECK-IN",
    "No dia do evento, apresente este QR Code à nossa equipe para realizar seu check-in.",
    "https://www.almaazulacademy.com.br/checkin/3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b",
  ];
  for (const text of required) assert.ok(email.text.includes(text), `texto puro sem: ${text}`);
  for (const text of ["Ingresso confirmado", "ESS7K2M9QX", "até 05h50", "09h00", "traga seu próprio tapete", "colete salva-vidas", "Nutre Congelados Saudáveis", "5 de novembro de 2026, às 12h00", "Como chegar — Google Maps"]) {
    assert.ok(email.html.includes(text), `HTML sem: ${text}`);
  }
  assertNoGeneric(email, "confirmação");
});

test("confirmação do evento: dados do cliente escapados no HTML", () => {
  const email = buildReservationConfirmationEmail(eventData({ fullName: "<script>alert(1)</script> Silva" }));
  assert.ok(!email.html.includes("<script>alert(1)</script>"));
  assert.ok(email.html.includes("&lt;script&gt;"));
});

test("horário: a mesma sessão em outro instante muda início e fim; tolerância só quando combina", () => {
  // 06h00 em Brasília: a regra de chegada (05h30/05h50) não combina e some.
  const later = buildReservationConfirmationEmail(eventData({ startsAt: "2026-11-07T09:00:00.000Z" }));
  assert.ok(later.text.includes("Início: 06h00"));
  assert.ok(later.text.includes("Encerramento previsto: 09h30"));
  assert.ok(!later.text.includes("Tolerância de chegada"), "nunca um horário de chegada que não combina com a sessão");
});

// ===========================================================================
// 2. Lembrete do QR e reagendamento
// ===========================================================================

test("lembrete do QR do evento: ingresso, início, tolerância e QR, sem texto de remada", () => {
  const reminder = buildCheckinReminderEmail(eventData());
  assert.ok(reminder);
  assert.equal(reminder.subject, "Seu QR Code de check-in — ESSÊNCIA — Corpo, Mente e Natureza");
  for (const text of ["Passando para lembrar do seu ingresso para o ESSÊNCIA", "Início: 05h30", "Tolerância de chegada: até 05h50", "Participantes: 2 participantes", "/checkin/3f2b8c1e"]) {
    assert.ok(reminder.text.includes(text), text);
  }
  assertNoGeneric(reminder, "lembrete");
  assert.equal(buildCheckinReminderEmail(eventData({ checkinToken: null })), null);
});

test("reagendamento do evento: nova data, pagamento válido, programação e sem política antecipada", () => {
  const email = buildReservationRescheduleEmail(eventData());
  assert.equal(email.subject, "Nova data confirmada — ESSÊNCIA — Corpo, Mente e Natureza · ESS7K2M9QX");
  for (const text of ["Seu ingresso foi transferido para uma nova data", "SEU PAGAMENTO CONTINUA VÁLIDO", "05h30 — Canoa havaiana", "traga seu próprio tapete", "colete salva-vidas", "O QR Code do seu ingresso continua o mesmo"]) {
    assert.ok(email.text.includes(text), text);
  }
  assert.ok(!email.text.includes("Política de cancelamento".toUpperCase()), "como no reagendamento das experiências, sem antecipar a política");
  assertNoGeneric(email, "reagendamento");
});

// ===========================================================================
// 3. Experiência regular: e-mails de sempre
// ===========================================================================

test("experiência regular: confirmação, lembrete e reagendamento exatamente como antes", () => {
  const regular = eventData({ event: undefined, experienceTitle: "Remada Sunset", startsAt: "2026-10-11T20:00:00.000Z", durationMinutes: 90 });
  const email = buildReservationConfirmationEmail(regular);
  assert.ok(email.text.includes(CANCELLATION_NOTE), "a política de sempre continua no e-mail regular");
  assert.ok(email.text.includes(PREPARATION_ITEMS[0]));
  assert.ok(!email.text.includes("Ingresso confirmado"));
  assert.ok(buildCheckinReminderEmail(regular)?.text.includes("Nos vemos na água!"));
  assert.ok(buildReservationRescheduleEmail(regular).subject.startsWith("Reagendamento confirmado — "));
});

// ===========================================================================
// 4. Leitura do payload e falha fechada
// ===========================================================================

function payload(extra: Record<string, unknown> = {}) {
  return {
    reservationId: "00000000-0000-4000-8000-0000000e55e1",
    publicCode: "ESS7K2M9QX",
    status: "CONFIRMED",
    fullName: "Marina Albuquerque",
    email: "marina@teste.local",
    quantity: 2,
    experienceTitle: "ESSÊNCIA — Corpo, Mente e Natureza",
    startsAt: ESSENCIA_STARTS_AT,
    durationMinutes: 210,
    baseSlug: "concha-acustica",
    baseName: "Cápsula Bar — Concha Acústica",
    meetingPoint: "Em frente ao Cápsula Bar — Concha Acústica",
    address: "SHTN Trecho 1, Lote 8 — Brasília/DF",
    ...extra,
  };
}

test("leitura: evento com conteúdo completo usa o modelo de evento; incompleto não envia nada", () => {
  const ok = parseReservationConfirmationData(payload({ experienceKind: "EVENT", eventEditorial: ESSENCIA_EDITORIAL }));
  assert.ok(ok?.event);
  assert.equal(ok?.eventContentInvalid, undefined);

  const incomplete = clone(ESSENCIA_EDITORIAL) as unknown as { event: { info: { items: Array<{ id?: string }> } } };
  incomplete.event.info.items = incomplete.event.info.items.filter((item) => item.id !== "seguranca");
  const broken = parseReservationConfirmationData(payload({ experienceKind: "EVENT", eventEditorial: incomplete }));
  assert.ok(broken);
  assert.equal(broken?.event, undefined);
  assert.equal(broken?.eventContentInvalid, true);
  assert.throws(() => buildReservationConfirmationEmail(broken!), new RegExp(EVENT_EMAIL_NOT_READY));
  assert.throws(() => buildReservationRescheduleEmail(broken!), new RegExp(EVENT_EMAIL_NOT_READY));
  assert.equal(buildCheckinReminderEmail({ ...broken!, checkinToken: "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b" }), null);

  const regular = parseReservationConfirmationData(payload({ experienceKind: "REGULAR" }));
  assert.equal(regular?.event, undefined);
  assert.equal(regular?.eventContentInvalid, undefined);
});

test("prontidão: o ESSÊNCIA tem tudo o que o e-mail precisa; sem um texto, não", () => {
  assert.deepEqual(eventEmailMissing(CONTENT), []);
  const without = clone(ESSENCIA_EDITORIAL) as unknown as { event: Record<string, unknown> & { info: { items: Array<{ id?: string }> } } };
  delete without.event.arrival;
  without.event.info.items = without.event.info.items.filter((item) => item.id !== "o-que-levar");
  const parsed = validateEventEditorial(without);
  assert.ok(parsed.success);
  if (parsed.success) assert.deepEqual(eventEmailMissing(parsed.data.event), ["início e tolerância de chegada (event.arrival)", 'texto "o-que-levar" confirmado']);
});

test("envio: reivindica antes, envia uma vez; evento incompleto fica pendente e nunca vira e-mail genérico", async () => {
  const sent: ConfirmationEmail[] = [];
  const completed: string[] = [];
  const failed: Array<[string, string]> = [];
  const deps = (load: unknown, claim: string | null = "job-1") => ({
    claim: async () => claim,
    load: async () => load,
    send: async (message: ConfirmationEmail) => { sent.push(message); },
    complete: async (jobId: string) => { completed.push(jobId); },
    fail: async (jobId: string, code: string) => { failed.push([jobId, code]); },
    sanitizeError: (error: unknown) => (error instanceof Error ? error.message : "ERRO"),
  });

  assert.deepEqual(await deliverReservationConfirmationEmail(deps(payload({ experienceKind: "EVENT", eventEditorial: ESSENCIA_EDITORIAL }))), { outcome: "SENT" });
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /^Ingresso confirmado — ESSÊNCIA/);
  assert.deepEqual(completed, ["job-1"]);

  // Idempotência: sem a reivindicação, nada sai.
  assert.deepEqual(await deliverReservationConfirmationEmail(deps(payload({ experienceKind: "EVENT", eventEditorial: ESSENCIA_EDITORIAL }), null)), { outcome: "SKIPPED" });
  assert.equal(sent.length, 1);

  // Conteúdo incompleto: pendente para nova tentativa, sem enviar.
  const incomplete = clone(ESSENCIA_EDITORIAL) as unknown as { event: Record<string, unknown> };
  delete incomplete.event.cancellation;
  assert.deepEqual(await deliverReservationConfirmationEmail(deps(payload({ experienceKind: "EVENT", eventEditorial: incomplete }), "job-2")), { outcome: "PENDING", errorCode: EVENT_EMAIL_NOT_READY });
  assert.equal(sent.length, 1);
  assert.deepEqual(failed, [["job-2", EVENT_EMAIL_NOT_READY]]);
});

// ===========================================================================
// 5. Ponta a ponta no banco de teste
// ===========================================================================

test("banco: reserva paga do evento → payload da RPC → contexto do evento → e-mail do evento", async () => {
  const db = await fullDatabase();
  const admin = createPgliteAdmin(db);
  const client = admin.client as unknown as EventEmailQueryClient;
  const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
  const created = await fx.call(
    `public.admin_create_event($1::uuid, $2::uuid, 'essencia', 'ESSÊNCIA — Corpo, Mente e Natureza', 'x', $3::jsonb, null, now() + interval '9 days', 210, 15000, $4)`,
    [ADMIN, fx.SUNSET_CONCHA.base_id, JSON.stringify(ESSENCIA_EDITORIAL), ESSENCIA_CAPACITY],
  );
  await db.query(`update public.special_event_settings set publication_enabled = true`);
  await db.query(`update public.experiences set status = 'PUBLISHED' where id = $1::uuid`, [created.experienceId]);
  await db.query(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [created.sessionId]);
  const booking = await fx.reserve(created.sessionId, 2);

  const raw = (await db.query<Row>(`select public.reservation_confirmation_email($1::uuid) as value`, [booking.id])).rows[0].value;
  const enriched = await withEventEmailContext(client, raw);
  const data = parseReservationConfirmationData(enriched);
  assert.ok(data?.event, "a reserva do evento leva o conteúdo do evento");
  const email = buildReservationConfirmationEmail(data!);
  assert.match(email.subject, /^Ingresso confirmado — ESSÊNCIA — Corpo, Mente e Natureza · /);
  assert.ok(email.text.includes(`Código da reserva: ${booking.code}`));
  assert.ok(email.text.includes("Participantes: 2 participantes"));
  assertNoGeneric(email, "ponta a ponta");

  // Reserva regular: o payload segue intacto e o e-mail é o de sempre.
  const regularSession = await fx.makeSession(fx.SUNSET_CONCHA.id, { price: 9_000 });
  const regular = await fx.reserve(regularSession, 1);
  const regularRaw = (await db.query<Row>(`select public.reservation_confirmation_email($1::uuid) as value`, [regular.id])).rows[0].value;
  const regularData = parseReservationConfirmationData(await withEventEmailContext(client, regularRaw));
  assert.equal(regularData?.event, undefined);
  assert.ok(buildReservationConfirmationEmail(regularData!).text.includes(CANCELLATION_NOTE));

  // Sem o conteúdo do e-mail completo, a venda do evento não abre — mesmo com a variável ligada.
  const incomplete = clone(ESSENCIA_EDITORIAL) as unknown as { event: { info: { items: Array<{ id?: string }> } } };
  incomplete.event.info.items = incomplete.event.info.items.filter((item) => item.id !== "alimentacao");
  await db.query(`update public.experiences set editorial_content = $1::jsonb where id = $2::uuid`, [JSON.stringify(incomplete), created.experienceId]);
  const rules = await loadSessionBookingRules(admin.client as unknown as RulesQueryClient, created.sessionId);
  assert.deepEqual(rules, { kind: "EVENT", maxPerOrder: 6, emailReady: false });
  assert.equal(eventBookingRejection(rules, 1, true)?.code, "EVENT_EMAIL_NOT_READY");
  await db.close();
});

test("contexto: sem reserva no payload, intacto; banco antigo, regular; falha de leitura, lança", async () => {
  const fake = (experienceError: { message: string; code?: string } | null, reservationError: { message: string } | null = null): EventEmailQueryClient => ({
    from(table: string) {
      return {
        select() {
          return {
            eq: async () => (table === "reservations"
              ? { data: reservationError ? null : [{ experience_id: "e1" }], error: reservationError }
              : { data: null, error: experienceError }),
          };
        },
      };
    },
  });
  assert.deepEqual(await withEventEmailContext(fake(null), { publicCode: "X" }), { publicCode: "X" });
  assert.deepEqual(await withEventEmailContext(fake({ message: "column experiences.kind does not exist", code: "42703" }), { reservationId: "r1" }), { reservationId: "r1", experienceKind: "REGULAR" });
  await assert.rejects(withEventEmailContext(fake({ message: "fetch failed" }), { reservationId: "r1" }), /EVENT_CONTEXT_UNAVAILABLE/);
  await assert.rejects(withEventEmailContext(fake(null, { message: "timeout" }), { reservationId: "r1" }), /EVENT_CONTEXT_UNAVAILABLE/);
});

// ===========================================================================
// 6. Ligações e demonstração
// ===========================================================================

test("os quatro envios passam pelo contexto do evento; o reagendamento falha fechado", () => {
  const service = source("lib/reservations/confirmation-email-service.ts");
  assert.equal((service.match(/withEventEmailContext\(admin as unknown as EventEmailQueryClient, payload\.data\)/g) ?? []).length, 2, "confirmação e lembrete individual");
  assert.match(source("lib/checkin/qr-bulk-service.ts"), /parseReservationConfirmationData\(await withEventEmailContext\(/);
  assert.match(source("lib/reservations/reschedule-email-service.ts"), /enrich: \(payload\) => withEventEmailContext\(/);
  const reschedule = source("lib/reservations/reschedule-email.ts");
  assert.match(reschedule, /return failed\("EVENT_CONTEXT_UNAVAILABLE", "REJECTED", true\);/);
  assert.match(reschedule, /return failed\("EVENT_EMAIL_NOT_READY", "REJECTED", true\);/);
});

test("demonstração: só gera arquivos; envio só com --enviar --confirmo, para a equipe e marcado", () => {
  const script = source("scripts/email/event-preview.ts");
  assert.match(script, /const send = args\.includes\("--enviar"\) && args\.includes\("--confirmo"\);/);
  assert.match(script, /to: CONTACT_EMAIL,/);
  assert.match(script, /subject: `\[DEMONSTRAÇÃO\] \$\{message\.subject\}`/);
  assert.match(script, /idempotencyKey: `demo-evento-essencia-\$\{name\}-v1`/);
  assert.doesNotMatch(script, /getSupabase|\.rpc\(/, "não fala com o banco");
  assert.match(source("package.json"), /"email:preview:evento":/);
});
