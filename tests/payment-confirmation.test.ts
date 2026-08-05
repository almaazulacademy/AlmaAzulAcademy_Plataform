import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { maskIdentifier, sanitizePaymentPayload } from "../lib/payments/observability.ts";
import { normalizeCaptureMethod, parseInfinitePayWebhook } from "../lib/payments/webhook-payload.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

// --- Payload do webhook -----------------------------------------------------

test("Pix aprovado via webhook é reconhecido", () => {
  const event = parseInfinitePayWebhook({
    order_nsu: "1f0b6b1e-0000-4000-8000-000000000001",
    transaction_nsu: "TX-PIX-1",
    slug: "abc123",
    capture_method: "pix",
    amount: 7000,
    receipt_url: "https://recibo.infinitepay.io/abc",
  });
  assert.ok(event);
  assert.equal(event.orderId, "1f0b6b1e-0000-4000-8000-000000000001");
  assert.equal(event.transactionId, "TX-PIX-1");
  assert.equal(event.invoiceSlug, "abc123");
  assert.equal(event.captureMethod, "pix");
  assert.equal(event.amountCents, 7000);
});

test("cartão de crédito aprovado via webhook é reconhecido", () => {
  const event = parseInfinitePayWebhook({
    order_nsu: "order-2",
    transaction_nsu: "TX-CARD-1",
    invoice_slug: "slug-2",
    capture_method: "credit-card",
    paid_amount: 14000,
  });
  assert.ok(event);
  assert.equal(event.captureMethod, "credit_card");
  assert.equal(event.amountCents, 14000);
});

test("payload aninhado e com apelidos alternativos continua sendo aceito", () => {
  const event = parseInfinitePayWebhook({
    event: "payment.approved",
    data: { orderNsu: "order-3", transaction_id: "TX-3", checkout_slug: "slug-3", paymentMethod: "PIX" },
  });
  assert.ok(event, "payload aninhado não pode ser rejeitado");
  assert.equal(event.orderId, "order-3");
  assert.equal(event.transactionId, "TX-3");
  assert.equal(event.invoiceSlug, "slug-3");
  assert.equal(event.captureMethod, "pix");
});

test("webhook sem transaction_nsu e sem slug ainda é aceito quando há order_nsu", () => {
  const event = parseInfinitePayWebhook({ order_nsu: "order-4" });
  assert.ok(event, "o antigo handler devolvia 400 aqui e a reserva nunca confirmava");
  assert.equal(event.transactionId, "");
  assert.equal(event.invoiceSlug, "");
});

test("payload sem order_nsu é inválido", () => {
  assert.equal(parseInfinitePayWebhook({ transaction_nsu: "TX" }), null);
  assert.equal(parseInfinitePayWebhook(null), null);
  assert.equal(parseInfinitePayWebhook("texto"), null);
  assert.equal(parseInfinitePayWebhook([{ order_nsu: "x" }]), null);
});

test("capture_method é normalizado sem inventar valores", () => {
  assert.equal(normalizeCaptureMethod("PIX"), "pix");
  assert.equal(normalizeCaptureMethod("credit_card"), "credit_card");
  assert.equal(normalizeCaptureMethod("Credit Card"), "credit_card");
  assert.equal(normalizeCaptureMethod(""), "");
  assert.equal(normalizeCaptureMethod("boleto"), "boleto");
});

// --- Sanitização e logs -----------------------------------------------------

test("dados sensíveis e pessoais não sobrevivem à sanitização", () => {
  const sanitized = sanitizePaymentPayload({
    order_nsu: "order-1",
    card_number: "4111111111111111",
    cvv: "123",
    api_key: "secret",
    handle: "$almaazul",
    cpf: "00000000000",
    customer: { name: "Fulano", email: "a@b.com" },
    name: "Fulano",
    email: "a@b.com",
    phone: "61999999999",
    amount: 7000,
  }) as Record<string, unknown>;

  assert.equal(sanitized.order_nsu, "order-1");
  assert.equal(sanitized.amount, 7000);
  for (const key of ["card_number", "cvv", "api_key", "handle", "cpf"]) {
    assert.equal(sanitized[key], "[redacted]", key);
  }
  for (const key of ["customer", "name", "email", "phone"]) {
    assert.equal(sanitized[key], "[personal]", key);
  }
  assert.doesNotMatch(JSON.stringify(sanitized), /4111111111111111|Fulano|a@b\.com|61999999999/);
});

test("identificadores em log são mascarados", () => {
  assert.equal(maskIdentifier(""), "");
  assert.equal(maskIdentifier("abc"), "ab…");
  assert.equal(maskIdentifier("1f0b6b1e-0000-4000-8000-000000000001"), "1f0b6b1e…0001");
});

// --- Contrato do handler e das RPCs ----------------------------------------

test("webhook responde 503 em falha temporária e 404 para pedido inexistente", () => {
  const route = source("app/api/payments/infinitepay/webhook/route.ts");
  assert.match(route, /RESERVATION_NOT_FOUND"\) return 404/);
  assert.match(route, /PROVIDER_UNAVAILABLE"\) return 503/);
  assert.match(route, /return 200/);
  assert.match(route, /status: 400/);
});

test("confirmação nunca confia só no payload recebido", () => {
  const confirmation = source("lib/reservations/payment-confirmation.ts");
  assert.match(confirmation, /provider\.verifyPayment/);
  const verifyIndex = confirmation.indexOf("provider.verifyPayment");
  const confirmIndex = confirmation.indexOf('rpc("confirm_reservation_payment"');
  assert.ok(verifyIndex > 0 && confirmIndex > verifyIndex, "payment_check precisa vir antes da confirmação");
  assert.match(confirmation, /if \(!verified\.paid\)/);
});

test("retorno do pagamento é fallback e reaproveita a mesma verificação", () => {
  const page = source("app/pagamento/retorno/page.tsx");
  assert.match(page, /confirmPayment\(/);
  assert.doesNotMatch(page, /confirmed = true/);
});

test("webhook não é interceptado pelo middleware administrativo", () => {
  const middleware = source("middleware.ts");
  const matcher = middleware.slice(middleware.indexOf("matcher"));
  assert.doesNotMatch(matcher, /payments/);
  assert.match(matcher, /\/api\/admin\/:path\*/);
});

test("checkout nunca usa localhost, vercel.app ou origem de preview no webhook", () => {
  const route = source("app/api/reservations/route.ts");
  assert.match(route, /SITE_URL/);
  assert.match(route, /vercel\\\.app/);
  assert.match(route, /localhost/);
  assert.doesNotMatch(route, /publicOrigin\(request\)/);
});

test("reconciliação preserva o invariante de capacidade e é idempotente", () => {
  const sql = source("supabase/migrations/202608050002_payment_reconciliation.sql");
  assert.match(sql, /create or replace function public\.reconcile_reservation_payment/);
  assert.match(sql, /for update/);
  assert.match(sql, /occupied \+ target\.quantity > target_session\.capacity/);
  assert.match(sql, /'NO_CAPACITY'/);
  assert.match(sql, /'ALREADY_CONFIRMED'/);
  assert.match(sql, /'AMOUNT_MISMATCH'/);
  assert.match(sql, /on conflict \(provider, provider_event_id\) do nothing/);
  // Impede que a expiração volte a derrubar uma reserva já paga.
  assert.match(sql, /expires_at = greatest\(expires_at, now\(\) \+ interval '1 hour'\)/);
  // Não pode tocar em preço, capacidade, sessões ou outras experiências.
  assert.doesNotMatch(sql, /update public\.sessions/i);
  assert.doesNotMatch(sql, /drop\s+(table|function|column)|truncate/i);
});

test("registro de tentativa grava evento sem confirmar reserva", () => {
  const sql = source("supabase/migrations/202608050002_payment_reconciliation.sql");
  const start = sql.indexOf("function public.record_payment_attempt");
  const end = sql.indexOf("function public.reconcile_reservation_payment");
  const body = sql.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(body, /insert into public\.payment_events/);
  assert.doesNotMatch(body, /update public\.reservations/);
  assert.doesNotMatch(body, /'CONFIRMED'/);
});

test("diagnóstico de pagamentos é somente leitura e não projeta dados pessoais", () => {
  const sql = source("supabase/diagnostics/payment_confirmation_report.sql");
  assert.doesNotMatch(sql, /^\s*(insert|update|delete|drop|alter|truncate)\b/im);
  assert.doesNotMatch(sql, /\b(r\.full_name|r\.email|r\.phone|r\.cpf_hash|r\.cpf_last4|pe\.payload\s*,)/i);
});
