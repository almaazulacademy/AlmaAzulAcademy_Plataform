import { NextResponse, after } from "next/server";

import { logPayment, newRequestId, sanitizePaymentPayload } from "@/lib/payments/observability";
import { recordPaymentStep } from "@/lib/payments/payment-trail";
import { parseInfinitePayWebhook, readWebhookBody } from "@/lib/payments/webhook-payload";
import { confirmPaymentWithJobs, type ConfirmationOutcome } from "@/lib/reservations/payment-confirmation";
import { drainReconciliationOpportunistically } from "@/lib/reservations/payment-reconciliation";

// Rota pública do gateway: sem cookie, sem sessão, sem cache.
// O middleware só intercepta /admin, /api/admin e /preview, então este caminho
// nunca é bloqueado por autenticação.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * A resposta precisa caber com folga no tempo de espera do gateway. Planilha e
 * e-mail saíram do caminho crítico (rodam em `after()`), então o que sobra é uma
 * consulta ao banco, o `payment_check` e a RPC de confirmação.
 */
export const maxDuration = 30;

/**
 * HTTP por resultado:
 *   200 — processado, já processado, ou legitimamente ainda não pago.
 *         Reenviar o mesmo corpo não mudaria nada.
 *   400 — corpo inválido ou sem order_nsu. Retry com o mesmo corpo é inútil,
 *         mas devolvemos 4xx para a InfinitePay sinalizar a falha no painel.
 *         **A tentativa fica gravada em `payment_webhook_log` antes da resposta**,
 *         então nem esse caso desaparece.
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
  const { payload, format } = await readWebhookBody(request);
  const event = parseInfinitePayWebhook(payload);

  // Registro durável antes de qualquer decisão. É o que fecha os casos "webhook
  // chegou e não sabemos o que aconteceu com ele".
  await recordPaymentStep({
    requestId,
    source: "WEBHOOK",
    step: event ? "WEBHOOK_RECEIVED" : "WEBHOOK_REJECTED",
    outcome: event ? "OK" : "INVALID",
    orderId: event?.orderId,
    providerReference: event?.invoiceSlug,
    providerEventId: event?.transactionId,
    errorCode: event ? undefined : "MISSING_ORDER_NSU",
    stage: event ? "webhook_received" : "webhook_rejected",
    payload: {
      body_format: format,
      content_type: (request.headers.get("content-type") ?? "").slice(0, 100),
      capture_method: event?.captureMethod ?? "",
      body: sanitizePaymentPayload(payload),
    },
  });

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
    const { result: confirmation, settle } = await confirmPaymentWithJobs({
      orderId: event.orderId,
      transactionId: event.transactionId,
      invoiceSlug: event.invoiceSlug,
      captureMethod: event.captureMethod,
      receiptUrl: event.receiptUrl,
      payload: sanitizePaymentPayload(event) as Record<string, unknown>,
      requestId,
      stage: "webhook_received",
      source: "WEBHOOK",
      deferSideEffects: true,
    });

    // Planilha operacional e e-mail de confirmação rodam **depois** da resposta.
    // Estavam no caminho crítico e somavam até dezesseis segundos de rede a uma
    // requisição que o gateway espera curta: um pagamento já confirmado no banco
    // podia virar timeout no painel da InfinitePay.
    if (confirmation.confirmed) after(() => settle().catch(() => undefined));

    // Reconciliação de carona. O cron da Vercel no plano Hobby roda uma vez por
    // dia, granularidade inútil para uma janela de segurança de trinta minutos.
    // Um webhook chegando significa que existe pagamento acontecendo agora —
    // é o melhor momento para conferir algumas pendências. Fora do caminho
    // crítico: acontece depois da resposta.
    after(() => drainReconciliationOpportunistically());

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
    const errorCode = error instanceof Error ? error.name : "UNKNOWN_ERROR";
    logPayment({
      requestId,
      stage: "webhook_received",
      outcome: "failed",
      orderId: event.orderId,
      errorCode,
      providerStatus: 503,
      durationMs: Date.now() - startedAt,
    });
    await recordPaymentStep({
      requestId, source: "WEBHOOK", step: "CONFIRM_FAILED", outcome: "FAILED",
      orderId: event.orderId, errorCode: "INTERNAL_ERROR", httpStatus: 503,
      durationMs: Date.now() - startedAt, stage: "webhook_received",
    });
    return NextResponse.json({ received: false, requestId, outcome: "INTERNAL_ERROR" }, { status: 503 });
  }
}

/**
 * Sonda de alcance. Não confirma nada e não tem efeito colateral.
 *
 * Existe para a equipe conseguir provar, do painel da InfinitePay ou de um
 * `curl`, que a URL configurada chega mesmo neste deployment — inclusive
 * distinguindo `almaazulacademy.com.br` de `www.almaazulacademy.com.br`, que
 * podem ter comportamento de redirecionamento diferente para POST.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  return NextResponse.json({
    ok: true,
    endpoint: "infinitepay-webhook",
    method: "POST",
    host: url.host,
    note: "Endpoint ativo. Notificações de pagamento devem ser enviadas por POST.",
  });
}
