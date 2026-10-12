/**
 * Proteção financeira do Stand-by na camada da aplicação.
 *
 * Uma reserva em `AWAITING_RESCHEDULE` já está paga e fora da turma original.
 * A pergunta desta suíte é uma só: **algum caminho de pagamento consegue
 * devolvê-la à turma antiga ou gravar um segundo evento financeiro?**
 *
 * `confirmPayment` é o ponto único usado por webhook, página de retorno,
 * "Verificar pagamento" e reconciliação automática. Ele roda de verdade aqui,
 * contra o banco em memória fiel às RPCs. As mesmas travas, no plpgsql real,
 * estão em `reservation-standby.test.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { adminMutationError } from "../lib/admin/mutation-errors.ts";
import { parseReservationSessionOptions } from "../lib/admin/session-change.ts";
import { isActiveSpot, reservationStatusLabel, type ReservationSnapshot } from "../lib/integrations/google-sheets/mapping.ts";
import { confirmPayment } from "../lib/reservations/payment-confirmation.ts";
import { decide, reconcilePendingPayments } from "../lib/reservations/payment-reconciliation.ts";
import {
  isPaymentSettledStatus,
  isReservationStatus,
  RESERVATION_STATUS_LABELS,
  RESERVATION_STATUSES,
} from "../lib/reservations/types.ts";
import { FakeProvider, PaymentStore } from "./support/payment-store.ts";

const ORDER = "2f0b6b1e-0000-4000-8000-000000000001";
const OTHER = "2f0b6b1e-0000-4000-8000-000000000002";
const SESSION = "6a0b6b1e-0000-4000-8000-0000000000aa";

/** Reserva paga, confirmada e depois colocada em Stand-by: a vaga está livre. */
function standbyScenario() {
  const store = new PaymentStore();
  store.addSession(SESSION, 1);
  const reservation = store.addReservation({
    id: ORDER,
    session_id: SESSION,
    status: "AWAITING_RESCHEDULE",
    confirmed_at: store.now,
    provider_reference: "TX-ORIGINAL",
  });
  return { store, reservation };
}

function notification(extra: Record<string, unknown> = {}) {
  return {
    orderId: ORDER,
    transactionId: "TX-ORIGINAL",
    invoiceSlug: "slug-abc",
    captureMethod: "pix",
    payload: {},
    ...extra,
  } as Parameters<typeof confirmPayment>[0];
}

const paid = () => new FakeProvider(() => ({ paid: true }));

for (const [label, extra] of [
  ["webhook repetido", { source: "WEBHOOK", stage: "confirmation" }],
  ["retorno de pagamento", { source: "RETURN_PAGE", stage: "return_page" }],
  ["verificação manual", { source: "ADMIN", stage: "admin_verification" }],
] as const) {
  test(`${label} não reconfirma uma reserva em Stand-by`, async () => {
    const { store } = standbyScenario();
    const provider = paid();
    const jobs: string[] = [];

    const outcome = await confirmPayment(notification(extra), {
      admin: store.client(),
      provider,
      jobs: async (id) => { jobs.push(id); },
    });

    assert.equal(outcome.outcome, "AWAITING_RESCHEDULE");
    assert.equal(outcome.confirmed, false, "não houve confirmação: planilha e e-mail não podem rodar");
    assert.equal(outcome.retryable, false, "resultado definitivo: o gateway não deve tentar de novo");
    assert.equal(outcome.needsReview, false, "não é caso de 'Pagamentos para revisar'");
    assert.equal(outcome.definitivelyUnpaid, false, "a reserva está paga");

    assert.equal(store.reservations.get(ORDER)?.status, "AWAITING_RESCHEDULE");
    assert.equal(store.availableSpots(SESSION), 1, "a vaga da turma antiga continua livre");
    assert.deepEqual(store.eventsFor(ORDER), [], "nenhum evento financeiro novo");
    assert.equal(provider.calls, 0, "nem consulta o gateway");
    assert.deepEqual(jobs, [], "nenhum efeito pós-confirmação");
    assert.ok(!store.rpcCalls.includes("confirm_reservation_payment"));
    assert.ok(!store.rpcCalls.includes("reconcile_reservation_payment"));
    assert.ok(!store.rpcCalls.includes("record_payment_attempt"));
  });
}

test("a vaga liberada pode ser vendida e o webhook antigo não a toma de volta", async () => {
  const { store } = standbyScenario();
  store.addReservation({ id: OTHER, session_id: SESSION, provider_reference: "slug-outra" });

  const second = await confirmPayment(notification({ orderId: OTHER, transactionId: "TX-2", invoiceSlug: "slug-outra" }), {
    admin: store.client(), provider: paid(), jobs: async () => {},
  });
  assert.equal(second.outcome, "CONFIRMED");
  assert.equal(store.availableSpots(SESSION), 0);

  const replay = await confirmPayment(notification(), { admin: store.client(), provider: paid(), jobs: async () => {} });
  assert.equal(replay.outcome, "AWAITING_RESCHEDULE");
  assert.equal(store.reservations.get(ORDER)?.status, "AWAITING_RESCHEDULE");
  assert.equal(store.reservations.get(OTHER)?.status, "CONFIRMED");
  assert.equal(store.availableSpots(SESSION), 0, "sem overbooking: uma vaga, uma reserva confirmada");
});

test("corrida: a reserva entra em Stand-by depois da leitura inicial e as RPCs recusam", async () => {
  const store = new PaymentStore();
  store.addSession(SESSION, 1);
  // Vencida há pouco: o caminho real de um webhook atrasado, que termina na
  // reconciliação. O Stand-by acontece enquanto o gateway é consultado.
  store.addReservation({ id: ORDER, session_id: SESSION, status: "EXPIRED" });
  const provider = new FakeProvider(() => {
    store.reservations.get(ORDER)!.status = "AWAITING_RESCHEDULE";
    return { paid: true };
  });
  const jobs: string[] = [];

  const outcome = await confirmPayment(notification({ transactionId: "TX-LATE" }), {
    admin: store.client(), provider, jobs: async (id) => { jobs.push(id); },
  });

  assert.equal(outcome.outcome, "AWAITING_RESCHEDULE");
  assert.equal(outcome.confirmed, false);
  assert.equal(outcome.retryable, false);
  assert.equal(store.reservations.get(ORDER)?.status, "AWAITING_RESCHEDULE");
  assert.ok(store.rpcCalls.includes("confirm_reservation_payment"), "a RPC foi alcançada e devolveu false");
  assert.ok(store.rpcCalls.includes("reconcile_reservation_payment"), "a reconciliação foi alcançada e recusou");
  for (const forbidden of ["PAYMENT_CONFIRMED", "PAYMENT_CONFIRMED_RECONCILED", "PAYMENT_AFTER_EXPIRATION", "PAYMENT_AFTER_EXPIRATION_NO_CAPACITY"]) {
    assert.ok(!store.hasEvent(ORDER, forbidden), `${forbidden} não pode ser gravado`);
  }
  assert.deepEqual(jobs, []);
});

test("reconciliação automática não reivindica nem altera reserva em Stand-by", async () => {
  const { store } = standbyScenario();
  const provider = paid();

  // Pior caso para a fila: prazo vencido há horas e checkout gravado.
  store.advance(600);
  const report = await reconcilePendingPayments(10, { admin: store.client(), provider, jobs: async () => {} });

  assert.equal(report.outcome, "PROCESSED", "a rotina rodou de verdade contra o banco de teste");
  assert.equal(report.processed, 0, "Stand-by não é candidato à reconciliação");
  assert.ok(store.rpcCalls.includes("claim_payment_reconciliation"));
  assert.equal(provider.calls, 0);
  assert.equal(store.reservations.get(ORDER)?.status, "AWAITING_RESCHEDULE");
  assert.deepEqual(store.eventsFor(ORDER), []);
});

test("decide() trata Stand-by como pagamento resolvido: sem retenção, sem liberação, sem incidente", () => {
  assert.equal(decide("AWAITING_RESCHEDULE"), "CONFIRMED");
});

test("o status novo é conhecido e nunca vira Expirada ou Cancelada na leitura", () => {
  assert.ok((RESERVATION_STATUSES as readonly string[]).includes("AWAITING_RESCHEDULE"));
  assert.ok(isReservationStatus("AWAITING_RESCHEDULE"));
  assert.ok(!isReservationStatus("QUALQUER_COISA"));
  assert.equal(RESERVATION_STATUS_LABELS.AWAITING_RESCHEDULE, "Aguardando reagendamento");

  const options = parseReservationSessionOptions({
    reservationId: ORDER, publicCode: "ABC1234567", fullName: "Cliente Teste",
    status: "AWAITING_RESCHEDULE", quantity: 2, totalCents: 14000, unitPriceCents: 7000,
    hiddenForCapacity: 0, current: null, options: [],
  });
  assert.equal(options?.status, "AWAITING_RESCHEDULE");
});

test("pagamento resolvido: confirmada e aguardando reagendamento, e só elas", () => {
  assert.equal(isPaymentSettledStatus("CONFIRMED"), true);
  assert.equal(isPaymentSettledStatus("AWAITING_RESCHEDULE"), true);
  for (const status of ["PRE_RESERVED", "EXPIRED", "CANCELLED", "", null, undefined]) {
    assert.equal(isPaymentSettledStatus(status), false, String(status));
  }
});

test("planilha: rótulo próprio e vaga inativa enquanto a reserva aguarda reagendamento", () => {
  assert.equal(reservationStatusLabel("AWAITING_RESCHEDULE"), "Aguardando reagendamento");
  assert.equal(reservationStatusLabel("CONFIRMED"), "Confirmada");
  assert.equal(isActiveSpot({ status: "AWAITING_RESCHEDULE" } as ReservationSnapshot), false);
  assert.equal(isActiveSpot({ status: "CONFIRMED" } as ReservationSnapshot), true);
});

test("confirmação manual recusada pelo banco chega ao operador com a explicação certa", () => {
  const failure = adminMutationError(new Error("RESERVATION_AWAITING_RESCHEDULE"));
  assert.equal(failure.status, 409);
  assert.match(failure.message, /aguarda reagendamento/);
});
