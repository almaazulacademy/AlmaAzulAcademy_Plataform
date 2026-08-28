/**
 * Cenários de falha da confirmação de pagamento.
 *
 * Cada teste exercita o código de produção — `confirmPayment`,
 * `reconcilePendingPayments`, `readWebhookBody`, `InfinitePayProvider` — contra
 * um banco em memória fiel às RPCs e um `fetch` controlado. Não há asserção
 * sobre texto de SQL aqui: as invariantes do plpgsql estão em
 * `payment-reliability-migration.test.ts` e no self-test que roda contra um
 * Postgres real.
 *
 * A pergunta que a suíte responde é sempre a mesma: **uma reserva paga pode
 * perder a vaga?**
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InfinitePayProvider } from "../lib/payments/infinitepay.ts";
import { PaymentProviderError } from "../lib/payments/payment-provider.ts";
import { readWebhookBody } from "../lib/payments/webhook-payload.ts";
import { confirmPayment } from "../lib/reservations/payment-confirmation.ts";
import { decide, reconcilePendingPayments } from "../lib/reservations/payment-reconciliation.ts";
import { FakeProvider, PaymentStore } from "./support/payment-store.ts";

const ORDER = "1f0b6b1e-0000-4000-8000-000000000001";
const OTHER = "1f0b6b1e-0000-4000-8000-000000000002";
const SESSION = "5a0b6b1e-0000-4000-8000-0000000000aa";

/** Ambiente mínimo com uma sessão de uma vaga e uma pré-reserva válida. */
function scenario(options: { capacity?: number; quantity?: number } = {}) {
  const store = new PaymentStore();
  store.addSession(SESSION, options.capacity ?? 1);
  const reservation = store.addReservation({
    id: ORDER,
    session_id: SESSION,
    quantity: options.quantity ?? 1,
    total_cents: 7000,
  });
  return { store, reservation };
}

function paidProvider(chargedCents?: number) {
  return new FakeProvider(() => ({ paid: true, chargedCents }));
}

function unpaidProvider() {
  return new FakeProvider(() => ({ paid: false }));
}

function brokenProvider() {
  return new FakeProvider(() => new PaymentProviderError("timeout", "PROVIDER_RESPONSE_ERROR"));
}

function notify(store: PaymentStore, extra: Record<string, unknown> = {}) {
  return {
    orderId: ORDER,
    transactionId: "TX-1",
    invoiceSlug: "slug-abc",
    captureMethod: "pix",
    payload: {},
    ...extra,
  } as Parameters<typeof confirmPayment>[0];
}

// --- 1. Caminho normal -------------------------------------------------------

test("1. pagamento com webhook normal confirma a reserva", async () => {
  const { store } = scenario();
  const jobs: string[] = [];

  const outcome = await confirmPayment(notify(store), {
    admin: store.client(),
    provider: paidProvider(),
    jobs: async (id) => { jobs.push(id); },
  });

  assert.equal(outcome.outcome, "CONFIRMED");
  assert.equal(outcome.confirmed, true);
  assert.equal(store.reservations.get(ORDER)?.status, "CONFIRMED");
  assert.ok(store.hasEvent(ORDER, "PAYMENT_CONFIRMED"));
  assert.deepEqual(jobs, [ORDER], "planilha e e-mail precisam ser disparados uma vez");
});

// --- 2. Webhook duplicado ----------------------------------------------------

test("2. webhook duplicado é idempotente e não gera evento repetido", async () => {
  const { store } = scenario();
  const provider = paidProvider();
  const ports = { admin: store.client(), provider, jobs: async () => {} };

  const first = await confirmPayment(notify(store), ports);
  const second = await confirmPayment(notify(store), ports);

  assert.equal(first.outcome, "CONFIRMED");
  assert.equal(second.outcome, "ALREADY_CONFIRMED");
  assert.equal(second.confirmed, true, "webhook repetido continua sendo sucesso para o gateway");
  assert.equal(store.eventsFor(ORDER).filter((e) => e.event_type === "PAYMENT_CONFIRMED").length, 1);
  assert.equal(store.reservations.get(ORDER)?.status, "CONFIRMED");
});

// --- 3. Webhook atrasado -----------------------------------------------------

test("3. webhook atrasado dentro da janela de segurança ainda confirma", async () => {
  const { store } = scenario();

  // Prazo do cliente vence e o cron roda: a vaga entra em janela de segurança.
  store.advance(121);
  store.expirePreReservations();
  assert.equal(store.reservations.get(ORDER)?.status, "PRE_RESERVED");
  assert.equal(store.availableSpots(SESSION), 0, "a vaga não pode ser liberada antes de verificar o pagamento");
  assert.ok(store.hasEvent(ORDER, "EXPIRATION_HELD_FOR_PAYMENT_CHECK"));

  // Webhook chega dez minutos depois do prazo original.
  store.advance(10);
  const outcome = await confirmPayment(notify(store), {
    admin: store.client(), provider: paidProvider(), jobs: async () => {},
  });

  assert.equal(outcome.outcome, "CONFIRMED");
  assert.equal(store.reservations.get(ORDER)?.status, "CONFIRMED");
});

// --- 4. Cliente fecha o navegador --------------------------------------------

test("4. pagamento sem nenhum retorno do navegador confirma pelo webhook", async () => {
  const { store } = scenario();
  // Nenhuma chamada de página de retorno acontece neste teste.
  const outcome = await confirmPayment(notify(store, { source: "WEBHOOK" }), {
    admin: store.client(), provider: paidProvider(), jobs: async () => {},
  });
  assert.equal(outcome.confirmed, true);
  assert.equal(store.reservations.get(ORDER)?.status, "CONFIRMED");
});

// --- 5 e 6. Ordem entre retorno e webhook ------------------------------------

test("5. retorno do navegador antes do webhook: o webhook vira ALREADY_CONFIRMED", async () => {
  const { store } = scenario();
  const ports = { admin: store.client(), provider: paidProvider(), jobs: async () => {} };

  const fromReturn = await confirmPayment(notify(store, { source: "RETURN_PAGE", stage: "return_page" }), ports);
  const fromWebhook = await confirmPayment(notify(store), ports);

  assert.equal(fromReturn.outcome, "CONFIRMED");
  assert.equal(fromWebhook.outcome, "ALREADY_CONFIRMED");
  assert.equal(store.eventsFor(ORDER).filter((e) => e.event_type === "PAYMENT_CONFIRMED").length, 1);
});

test("6. webhook antes do retorno: o retorno vira ALREADY_CONFIRMED", async () => {
  const { store } = scenario();
  const ports = { admin: store.client(), provider: paidProvider(), jobs: async () => {} };

  const fromWebhook = await confirmPayment(notify(store), ports);
  const fromReturn = await confirmPayment(notify(store, { source: "RETURN_PAGE", stage: "return_page" }), ports);

  assert.equal(fromWebhook.outcome, "CONFIRMED");
  assert.equal(fromReturn.outcome, "ALREADY_CONFIRMED");
  assert.equal(fromReturn.confirmed, true, "a tela do cliente precisa mostrar confirmado");
});

// --- 7 e 8. Webhook depois do prazo ------------------------------------------

test("7. webhook recebido depois de expires_at ainda confirma dentro do hold", async () => {
  const { store } = scenario();
  store.advance(121);
  store.expirePreReservations();
  store.advance(5);

  const outcome = await confirmPayment(notify(store), {
    admin: store.client(), provider: paidProvider(), jobs: async () => {},
  });

  assert.equal(outcome.confirmed, true);
  assert.equal(store.reservations.get(ORDER)?.status, "CONFIRMED");
});

test("8. webhook recebido com a reserva já EXPIRED reconcilia quando há vaga", async () => {
  const { store } = scenario({ capacity: 2 });
  // Passa do prazo, do hold e da janela inteira: a reserva expira de fato.
  store.advance(121);
  store.expirePreReservations();
  store.advance(200);
  store.expirePreReservations();
  assert.equal(store.reservations.get(ORDER)?.status, "EXPIRED");

  const outcome = await confirmPayment(notify(store), {
    admin: store.client(), provider: paidProvider(), jobs: async () => {},
  });

  assert.equal(outcome.outcome, "RECONCILED");
  assert.equal(store.reservations.get(ORDER)?.status, "CONFIRMED");
  assert.ok(store.hasEvent(ORDER, "PAYMENT_CONFIRMED_RECONCILED"));
});

// --- 9. Webhook duas vezes com o mesmo resultado -----------------------------

test("9. dois webhooks idênticos chegam ao mesmo estado final", async () => {
  const { store } = scenario();
  const ports = { admin: store.client(), provider: paidProvider(), jobs: async () => {} };

  const results = [await confirmPayment(notify(store), ports), await confirmPayment(notify(store), ports)];

  assert.ok(results.every((item) => item.confirmed));
  assert.equal(store.reservations.get(ORDER)?.status, "CONFIRMED");
  assert.equal(store.availableSpots(SESSION), 0);
});

// --- 10. InfinitePay indisponível --------------------------------------------

test("10. InfinitePay indisponível nunca é tratada como 'não pagou'", async () => {
  const { store } = scenario();

  const outcome = await confirmPayment(notify(store), {
    admin: store.client(), provider: brokenProvider(), jobs: async () => {},
  });

  assert.equal(outcome.outcome, "PROVIDER_UNAVAILABLE");
  assert.equal(outcome.definitivelyUnpaid, false, "erro de rede não pode virar veredito de não pagamento");
  assert.equal(outcome.retryable, true);
  assert.equal(store.reservations.get(ORDER)?.status, "PRE_RESERVED", "a reserva não pode ser expirada por falha nossa");
});

// --- 11. Supabase falha temporariamente --------------------------------------

test("11. falha temporária do Supabase devolve PROVIDER_UNAVAILABLE, não confirmação falsa", async () => {
  const { store } = scenario();
  store.failNextRpc = "reservations.select";

  const outcome = await confirmPayment(notify(store), {
    admin: store.client(), provider: paidProvider(), jobs: async () => {},
  });

  assert.equal(outcome.outcome, "PROVIDER_UNAVAILABLE");
  assert.equal(outcome.confirmed, false);
  assert.equal(store.reservations.get(ORDER)?.status, "PRE_RESERVED");
});

test("11b. falha na RPC de confirmação não confirma e continua retentável", async () => {
  const { store } = scenario();
  store.failNextRpc = "confirm_reservation_payment";

  const outcome = await confirmPayment(notify(store), {
    admin: store.client(), provider: paidProvider(), jobs: async () => {},
  });

  assert.equal(outcome.outcome, "PROVIDER_UNAVAILABLE");
  assert.equal(store.reservations.get(ORDER)?.status, "PRE_RESERVED");
});

// --- 12. Reconciliação corrige uma confirmação que falhou --------------------

test("12. confirmação falha e a reconciliação posterior corrige sozinha", async () => {
  const { store } = scenario();
  store.failNextRpc = "confirm_reservation_payment";

  const failed = await confirmPayment(notify(store), {
    admin: store.client(), provider: paidProvider(), jobs: async () => {},
  });
  assert.equal(failed.confirmed, false);

  // Ninguém volta ao site e nenhum webhook novo chega. Só o cron.
  store.advance(115);
  const report = await reconcilePendingPayments(10, {
    admin: store.client(), provider: paidProvider(), jobs: async () => {},
  });

  assert.equal(report.confirmed, 1);
  assert.equal(store.reservations.get(ORDER)?.status, "CONFIRMED");
});

// --- 13. Reserva não paga expira normalmente ---------------------------------

test("13. reserva comprovadamente não paga expira e devolve a vaga", async () => {
  const { store } = scenario();

  store.advance(121);
  store.expirePreReservations();
  assert.equal(store.availableSpots(SESSION), 0, "durante a janela de segurança a vaga fica retida");

  const report = await reconcilePendingPayments(10, {
    admin: store.client(), provider: unpaidProvider(), jobs: async () => {},
  });
  assert.equal(report.released, 1);

  store.expirePreReservations();
  assert.equal(store.reservations.get(ORDER)?.status, "EXPIRED");
  assert.equal(store.availableSpots(SESSION), 1, "a vaga precisa voltar ao mercado depois da resposta definitiva");
  assert.equal(store.hasEvent(ORDER, "PAYMENT_HOLD_EXHAUSTED"), false, "resposta definitiva não é incidente");
});

// --- 14. O requisito central -------------------------------------------------

test("14. reserva paga nunca é liberada apenas por ausência de webhook", async () => {
  const { store } = scenario();

  // Nenhum webhook jamais chega. O prazo vence.
  store.advance(121);
  store.expirePreReservations();
  assert.equal(store.availableSpots(SESSION), 0);

  // O cron pergunta à InfinitePay e descobre que está pago.
  const report = await reconcilePendingPayments(10, {
    admin: store.client(), provider: paidProvider(), jobs: async () => {},
  });

  assert.equal(report.confirmed, 1);
  assert.equal(store.reservations.get(ORDER)?.status, "CONFIRMED");
  assert.equal(store.availableSpots(SESSION), 0, "a vaga é de quem pagou");
});

test("14b. gateway fora do ar segura a vaga em vez de liberá-la", async () => {
  const { store } = scenario();
  store.advance(121);
  store.expirePreReservations();

  const report = await reconcilePendingPayments(10, {
    admin: store.client(), provider: brokenProvider(), jobs: async () => {},
  });

  assert.equal(report.held, 1);
  assert.equal(report.released, 0, "incerteza jamais libera vaga");
  assert.equal(store.availableSpots(SESSION), 0);
  assert.equal(store.reservations.get(ORDER)?.status, "PRE_RESERVED");
});

test("14c. a retenção tem teto e o esgotamento vira incidente, nunca silêncio", async () => {
  const { store } = scenario();
  store.advance(121);
  store.expirePreReservations();

  // O gateway fica fora do ar por muito mais que o teto de retenção.
  for (let round = 0; round < 20; round += 1) {
    store.advance(20);
    await reconcilePendingPayments(10, {
      admin: store.client(), provider: brokenProvider(), jobs: async () => {},
    });
    store.expirePreReservations();
  }

  assert.equal(store.reservations.get(ORDER)?.status, "EXPIRED", "capacidade não pode ficar refém do gateway");
  assert.ok(store.hasEvent(ORDER, "PAYMENT_HOLD_EXHAUSTED"), "a liberação precisa deixar incidente registrado");
});

// --- 15. Reconciliação sem navegador -----------------------------------------

test("15. reconciliação confirma sem webhook e sem retorno do navegador", async () => {
  const { store } = scenario();
  const provider = paidProvider();

  store.advance(115);
  const report = await reconcilePendingPayments(10, { admin: store.client(), provider, jobs: async () => {} });

  assert.equal(report.processed, 1, "a reserva prestes a vencer precisa ser conferida antes do prazo");
  assert.equal(report.confirmed, 1);
  assert.ok(provider.calls > 0, "a reconciliação precisa perguntar ao gateway");
});

// --- 16. Confirmações simultâneas --------------------------------------------

test("16. duas confirmações simultâneas são idempotentes", async () => {
  const { store } = scenario();
  const ports = { admin: store.client(), provider: paidProvider(), jobs: async () => {} };

  const [first, second] = await Promise.all([
    confirmPayment(notify(store), ports),
    confirmPayment(notify(store, { requestId: "second" }), ports),
  ]);

  assert.ok(first.confirmed && second.confirmed);
  assert.equal(store.eventsFor(ORDER).filter((e) => e.event_type === "PAYMENT_CONFIRMED").length, 1);
  assert.equal(store.availableSpots(SESSION), 0);
});

// --- 17 e 18. Pagamento tardio -----------------------------------------------

test("17. pagamento tardio com vaga disponível é recuperado", async () => {
  const { store } = scenario({ capacity: 2 });
  store.advance(121);
  store.expirePreReservations();
  store.advance(200);
  store.expirePreReservations();

  const report = await reconcilePendingPayments(10, {
    admin: store.client(), provider: paidProvider(), jobs: async () => {},
  });

  assert.equal(report.confirmed, 1);
  assert.equal(store.reservations.get(ORDER)?.status, "CONFIRMED");
});

test("18. pagamento tardio sem vaga gera incidente e nunca some", async () => {
  const { store } = scenario({ capacity: 1 });
  store.advance(121);
  store.expirePreReservations();
  store.advance(200);
  store.expirePreReservations();
  assert.equal(store.reservations.get(ORDER)?.status, "EXPIRED");

  // Outra pessoa ocupou a vaga enquanto isso.
  store.addReservation({ id: OTHER, session_id: SESSION, status: "CONFIRMED", expires_at: store.now + 3_600_000 });
  assert.equal(store.availableSpots(SESSION), 0);

  const report = await reconcilePendingPayments(10, {
    admin: store.client(), provider: paidProvider(), jobs: async () => {},
  });

  assert.equal(report.incidents, 1);
  assert.equal(report.confirmed, 0, "confirmar aqui geraria overbooking");
  assert.ok(store.hasEvent(ORDER, "PAYMENT_AFTER_EXPIRATION_NO_CAPACITY"));
  assert.equal(store.reservations.get(ORDER)?.last_reconciliation_code, "NO_CAPACITY");
  assert.equal(store.reservations.get(OTHER)?.status, "CONFIRMED", "quem já estava confirmado não pode ser derrubado");
});

// --- 19. Disponibilidade durante a reconciliação -----------------------------

test("19. available_spots não libera vaga em processo de reconciliação", async () => {
  const { store } = scenario();

  store.advance(121);
  assert.equal(store.availableSpots(SESSION), 1, "antes do cron a vaga aparece livre — é a janela que o cron fecha");

  store.expirePreReservations();
  assert.equal(store.availableSpots(SESSION), 0, "com o hold aplicado a vaga volta a ficar retida");

  store.advance(20);
  await reconcilePendingPayments(10, { admin: store.client(), provider: brokenProvider(), jobs: async () => {} });
  assert.equal(store.availableSpots(SESSION), 0, "enquanto o estado é incerto a vaga continua retida");
});

// --- 20. Duplicidade de eventos ----------------------------------------------

test("20. nenhum payment_event duplicado por (provider, provider_event_id)", async () => {
  const { store } = scenario();
  const ports = { admin: store.client(), provider: paidProvider(), jobs: async () => {} };

  await confirmPayment(notify(store), ports);
  await confirmPayment(notify(store), ports);
  await confirmPayment(notify(store), ports);

  const keys = store.events.map((event) => `${event.provider}:${event.provider_event_id}`);
  assert.equal(new Set(keys).size, keys.length, "a chave única do banco precisa ser respeitada");
});

// --- 21. Um pagamento, uma reserva -------------------------------------------

test("21. um pagamento nunca confirma duas reservas", async () => {
  const { store } = scenario({ capacity: 2 });
  store.addReservation({ id: OTHER, session_id: SESSION });
  const ports = { admin: store.client(), provider: paidProvider(), jobs: async () => {} };

  await confirmPayment(notify(store), ports);

  assert.equal(store.reservations.get(ORDER)?.status, "CONFIRMED");
  assert.equal(store.reservations.get(OTHER)?.status, "PRE_RESERVED", "o order_nsu liga o pagamento a uma reserva só");
  assert.equal(store.eventsFor(OTHER).length, 0);
});

// --- 22. Retry do cron -------------------------------------------------------

test("22. retry do cron é idempotente", async () => {
  const { store } = scenario();
  store.advance(115);
  const ports = { admin: store.client(), provider: paidProvider(), jobs: async () => {} };

  const first = await reconcilePendingPayments(10, ports);
  const second = await reconcilePendingPayments(10, ports);

  assert.equal(first.confirmed, 1);
  assert.equal(second.processed, 0, "reserva já confirmada sai da fila");
  assert.equal(store.eventsFor(ORDER).filter((e) => e.event_type === "PAYMENT_CONFIRMED").length, 1);
});

// --- Regressões específicas do incidente -------------------------------------

test("parcelamento com juros pagos pelo cliente não vira divergência de valor", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  process.env.INFINITEPAY_HANDLE = "alma-azul-test";

  globalThis.fetch = (async () => new Response(
    JSON.stringify({ success: true, paid: true, amount: 7000, paid_amount: 7560, capture_method: "credit_card" }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;

  const verified = await new InfinitePayProvider().verifyPayment({
    orderId: ORDER, transactionId: "TX", invoiceSlug: "slug", expectedAmountCents: 7000,
  });

  assert.equal(verified.paid, true, "cobrar acima do total é parcelamento, não divergência");
  assert.equal(verified.amountCents, 7000, "a RPC compara com total_cents e exige igualdade exata");
  assert.equal(verified.chargedAmountCents, 7560, "o valor real cobrado fica registrado");
});

test("cobrança abaixo do total continua sendo divergência", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  process.env.INFINITEPAY_HANDLE = "alma-azul-test";

  globalThis.fetch = (async () => new Response(
    JSON.stringify({ success: true, paid: true, amount: 100 }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;

  await assert.rejects(
    () => new InfinitePayProvider().verifyPayment({
      orderId: ORDER, transactionId: "TX", invoiceSlug: "slug", expectedAmountCents: 7000,
    }),
    (error: unknown) => error instanceof PaymentProviderError && error.causeCode === "PAYMENT_AMOUNT_MISMATCH",
  );
});

test("aprovação sinalizada só por status textual é reconhecida", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  process.env.INFINITEPAY_HANDLE = "alma-azul-test";

  globalThis.fetch = (async () => new Response(
    JSON.stringify({ success: true, status: "approved", amount: 7000 }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;

  const verified = await new InfinitePayProvider().verifyPayment({
    orderId: ORDER, transactionId: "TX", invoiceSlug: "slug", expectedAmountCents: 7000,
  });
  assert.equal(verified.paid, true, "a versão anterior exigia o booleano `paid` e devolvia NOT_PAID aqui");
});

test("Pix ainda aguardando não vira erro nem confirmação", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  process.env.INFINITEPAY_HANDLE = "alma-azul-test";

  globalThis.fetch = (async () => new Response(
    JSON.stringify({ success: true, paid: false }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;

  const verified = await new InfinitePayProvider().verifyPayment({
    orderId: ORDER, transactionId: "TX", invoiceSlug: "slug", expectedAmountCents: 7000,
  });
  assert.equal(verified.paid, false);
  assert.equal(verified.amountCents, 0, "sem pagamento não há valor a comparar");
});

test("webhook em formulário não é mais perdido", async () => {
  const form = new Request("https://almaazulacademy.com.br/api/payments/infinitepay/webhook", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `order_nsu=${ORDER}&transaction_nsu=TX-1&slug=abc&capture_method=pix`,
  });
  const parsed = await readWebhookBody(form);
  assert.equal(parsed.format, "form");
  assert.equal((parsed.payload as Record<string, string>).order_nsu, ORDER);
});

test("JSON enviado com Content-Type errado ainda é lido", async () => {
  const request = new Request("https://almaazulacademy.com.br/api/payments/infinitepay/webhook", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ order_nsu: ORDER, transaction_nsu: "TX-1" }),
  });
  const parsed = await readWebhookBody(request);
  assert.equal(parsed.format, "json");
  assert.equal((parsed.payload as Record<string, string>).order_nsu, ORDER);
});

test("corpo vazio é reconhecido como vazio, não como JSON quebrado", async () => {
  const request = new Request("https://almaazulacademy.com.br/api/payments/infinitepay/webhook", { method: "POST" });
  const parsed = await readWebhookBody(request);
  assert.equal(parsed.format, "empty");
  assert.equal(parsed.payload, null);
});

test("só 'não pago' libera a vaga; todo o resto retém ou vira incidente", () => {
  assert.equal(decide("NOT_PAID"), "RELEASE");
  assert.equal(decide("PROVIDER_UNAVAILABLE"), "HOLD");
  assert.equal(decide("NO_CAPACITY"), "INCIDENT");
  assert.equal(decide("AMOUNT_MISMATCH"), "INCIDENT");
  assert.equal(decide("CONFIRMED"), "CONFIRMED");
  assert.equal(decide("RECONCILED"), "CONFIRMED");
  assert.equal(decide("ALREADY_CONFIRMED"), "CONFIRMED");
});

test("a trilha durável distingue cada etapa do fluxo", async () => {
  const { store } = scenario();
  await confirmPayment(notify(store), {
    admin: store.client(), provider: paidProvider(), jobs: async () => {},
  });

  const steps = store.steps.map((entry) => entry.step);
  for (const expected of ["WEBHOOK_VALIDATED", "PAYMENT_APPROVED", "CONFIRM_ATTEMPT", "CONFIRM_SUCCESS"]) {
    assert.ok(steps.includes(expected), `etapa ${expected} precisa estar na trilha`);
  }
  assert.ok(store.steps.every((entry) => entry.reservation_id === ORDER || entry.reservation_id === null));
});
