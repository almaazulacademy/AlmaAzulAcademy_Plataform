import { NextResponse } from "next/server";

import { logPayment, newRequestId, sanitizePaymentPayload } from "@/lib/payments/observability";
import { parseInfinitePayWebhook } from "@/lib/payments/webhook-payload";
import { confirmPayment, type ConfirmationOutcome } from "@/lib/reservations/payment-confirmation";

// Rota pública do gateway: sem cookie, sem sessão, sem cache.
// O middleware só intercepta /admin, /api/admin e /preview, então este caminho
// nunca é bloqueado por autenticação.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * HTTP por resultado:
 *   200 — processado, já processado, ou legitimamente ainda não pago.
 *         Reenviar o mesmo corpo não mudaria nada.
 *   400 — corpo inválido ou sem order_nsu. Retry com o mesmo corpo é inútil,
 *         mas devolvemos 4xx para a InfinitePay sinalizar a falha no painel.
 *   404 — order_nsu não corresponde a nenhuma reserva.
 *   503 — falha temporária nossa ou da própria InfinitePay. Retry é desejável.
 */
function statusFor(outcome: ConfirmationOutcome) {
  if (outcome === "RESERVATION_NOT_FOUND") return 404;
  if (outcome === "PROVIDER_UNAVAILABLE") return 503;
  return 200;
}

export async function POST(request: Request) {
  const requestId = newRequestId();
  const startedAt = Date.now();
  const payload: unknown = await request.json().catch(() => null);
  const event = parseInfinitePayWebhook(payload);

  if (!event) {
    logPayment({ requestId, stage: "webhook_rejected", outcome: "invalid", errorCode: "MISSING_ORDER_NSU" });
    return NextResponse.json({ received: false, requestId, reason: "MISSING_ORDER_NSU" }, { status: 400 });
  }

  logPayment({
    requestId,
    stage: "webhook_received",
    orderId: event.orderId,
    transactionId: event.transactionId,
    invoiceSlug: event.invoiceSlug,
    captureMethod: event.captureMethod,
  });

  try {
    const confirmation = await confirmPayment({
      orderId: event.orderId,
      transactionId: event.transactionId,
      invoiceSlug: event.invoiceSlug,
      captureMethod: event.captureMethod,
      receiptUrl: event.receiptUrl,
      payload: sanitizePaymentPayload(event) as Record<string, unknown>,
      requestId,
      stage: "webhook_received",
    });

    const status = statusFor(confirmation.outcome);
    logPayment({
      requestId,
      stage: "webhook_received",
      outcome: confirmation.confirmed ? "confirmed" : status === 200 ? "duplicate" : "failed",
      orderId: event.orderId,
      captureMethod: event.captureMethod,
      providerStatus: status,
      errorCode: confirmation.confirmed ? undefined : confirmation.outcome,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json(
      { received: true, requestId, confirmed: confirmation.confirmed, outcome: confirmation.outcome },
      { status },
    );
  } catch (error) {
    // Só chega aqui em falha de infraestrutura (ex.: service role ausente).
    logPayment({
      requestId,
      stage: "webhook_received",
      outcome: "failed",
      orderId: event.orderId,
      errorCode: error instanceof Error ? error.name : "UNKNOWN_ERROR",
      providerStatus: 503,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ received: false, requestId, outcome: "INTERNAL_ERROR" }, { status: 503 });
  }
}
