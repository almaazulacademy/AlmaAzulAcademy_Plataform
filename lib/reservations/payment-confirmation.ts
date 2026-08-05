import type { SupabaseClient } from "@supabase/supabase-js";

import { getPaymentProvider } from "@/lib/payments";
import {
  logPayment,
  newRequestId,
  sanitizePaymentPayload,
  type PaymentStage,
} from "@/lib/payments/observability";
import { PaymentProviderError } from "@/lib/payments/payment-provider";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

type PaymentNotification = {
  orderId: string;
  transactionId: string;
  invoiceSlug: string;
  captureMethod?: string;
  receiptUrl?: string;
  payload: Record<string, unknown>;
  requestId?: string;
  stage?: PaymentStage;
};

export type ConfirmationOutcome =
  /** Reserva passou de PRE_RESERVED para CONFIRMED agora. */
  | "CONFIRMED"
  /** Já estava CONFIRMED: nada a fazer, sucesso. */
  | "ALREADY_CONFIRMED"
  /** Pago fora da janela de retenção e recuperado porque ainda havia vaga. */
  | "RECONCILED"
  /** Pago, mas a sessão lotou enquanto a reserva estava vencida. Exige tratamento humano. */
  | "NO_CAPACITY"
  /** A InfinitePay não reconhece o pagamento como pago. Estado legítimo (Pix aguardando). */
  | "NOT_PAID"
  /** Valor cobrado diferente do total da reserva. */
  | "AMOUNT_MISMATCH"
  /** order_nsu não corresponde a nenhuma reserva. */
  | "RESERVATION_NOT_FOUND"
  /** Reserva cancelada: não se confirma automaticamente. */
  | "CANCELLED"
  /** Falha temporária ao falar com a InfinitePay. Vale nova tentativa. */
  | "PROVIDER_UNAVAILABLE";

export type ConfirmationResult = {
  outcome: ConfirmationOutcome;
  confirmed: boolean;
  /** true quando repetir a chamada mais tarde pode mudar o resultado. */
  retryable: boolean;
};

const TRANSIENT_PROVIDER_CODES = new Set(["PROVIDER_RESPONSE_ERROR", "MISSING_CONFIGURATION"]);

/**
 * Grava uma tentativa de pagamento sem nunca interromper o fluxo.
 *
 * O builder do supabase-js é *thenable*, não uma Promise: tem `.then`, mas não
 * `.catch`. Por isso o registro precisa de try/catch de verdade, e o erro de
 * negócio vem no campo `error` da resposta, não como exceção. Falhar aqui é
 * ruído de observabilidade — jamais deve impedir a verificação ou a confirmação
 * do pagamento.
 */
async function recordAttempt(
  admin: SupabaseClient,
  requestId: string,
  args: {
    reservationId: string;
    provider: string;
    providerEventId: string;
    eventType: string;
    payload: Record<string, unknown>;
  },
) {
  try {
    const { error } = await admin.rpc("record_payment_attempt", {
      p_reservation_id: args.reservationId,
      p_provider: args.provider,
      p_provider_event_id: args.providerEventId,
      p_event_type: args.eventType,
      p_amount_cents: 0,
      p_payload: args.payload,
    });
    if (error) {
      logPayment({ requestId, stage: "confirmation", outcome: "failed", errorCode: "RECORD_ATTEMPT_REJECTED" });
    }
  } catch {
    // Nunca propaga: sem rede, sem RPC aplicada ou sem permissão, o pagamento
    // ainda precisa seguir para verificação.
    logPayment({ requestId, stage: "confirmation", outcome: "failed", errorCode: "RECORD_ATTEMPT_UNAVAILABLE" });
  }
}

function result(outcome: ConfirmationOutcome): ConfirmationResult {
  return {
    outcome,
    confirmed: outcome === "CONFIRMED" || outcome === "ALREADY_CONFIRMED" || outcome === "RECONCILED",
    retryable: outcome === "PROVIDER_UNAVAILABLE" || outcome === "NOT_PAID",
  };
}

/**
 * Ponto único de confirmação. Usado pelo webhook, pela página de retorno e pela
 * verificação administrativa — os três caminhos são idempotentes e chegam ao
 * mesmo estado final.
 *
 * A confirmação nunca se apoia no payload recebido: o valor e o status "pago"
 * sempre vêm de uma consulta server-to-server ao payment_check da InfinitePay.
 */
export async function confirmPayment(notification: PaymentNotification): Promise<ConfirmationResult> {
  const requestId = notification.requestId ?? newRequestId();
  const stage: PaymentStage = notification.stage ?? "confirmation";
  const admin = getSupabaseAdminClient();
  if (!admin) throw new Error("Supabase administrativo não configurado.");

  const reservationResult = await admin
    .from("reservations")
    .select("id,total_cents,status,expires_at")
    .eq("id", notification.orderId)
    .maybeSingle();

  if (reservationResult.error) {
    logPayment({ requestId, stage, outcome: "failed", orderId: notification.orderId, errorCode: "RESERVATION_LOOKUP_FAILED" });
    return result("PROVIDER_UNAVAILABLE");
  }
  if (!reservationResult.data) {
    logPayment({ requestId, stage, outcome: "invalid", orderId: notification.orderId, errorCode: "RESERVATION_NOT_FOUND" });
    return result("RESERVATION_NOT_FOUND");
  }

  const reservation = reservationResult.data;
  if (reservation.status === "CONFIRMED") {
    logPayment({ requestId, stage, outcome: "already_confirmed", orderId: notification.orderId });
    return result("ALREADY_CONFIRMED");
  }
  if (reservation.status === "CANCELLED") {
    logPayment({ requestId, stage, outcome: "invalid", orderId: notification.orderId, errorCode: "RESERVATION_CANCELLED" });
    return result("CANCELLED");
  }

  const sanitizedPayload = sanitizePaymentPayload(notification.payload) as Record<string, unknown>;
  const provider = getPaymentProvider();

  // Deixa rastro do que chegou antes de qualquer verificação. Sem isso, um webhook
  // que falha some sem deixar histórico — foi exatamente o que impediu o diagnóstico
  // dos casos anteriores.
  await recordAttempt(admin, requestId, {
    reservationId: reservation.id,
    provider: provider.name,
    providerEventId: `${notification.transactionId || notification.invoiceSlug || requestId}:received`,
    eventType: "PAYMENT_WEBHOOK_RECEIVED",
    payload: {
      ...sanitizedPayload,
      stage,
      request_id: requestId,
      capture_method: notification.captureMethod ?? "",
    },
  });

  let verified;
  const startedAt = Date.now();
  try {
    verified = await provider.verifyPayment({
      orderId: notification.orderId,
      transactionId: notification.transactionId,
      invoiceSlug: notification.invoiceSlug,
      expectedAmountCents: Number(reservation.total_cents),
    });
  } catch (error) {
    const code = error instanceof PaymentProviderError ? error.causeCode : "PAYMENT_CHECK_FAILED";
    const mismatch = code === "PAYMENT_AMOUNT_MISMATCH";
    logPayment({
      requestId,
      stage: "payment_check",
      outcome: mismatch ? "invalid" : "failed",
      orderId: notification.orderId,
      transactionId: notification.transactionId,
      captureMethod: notification.captureMethod,
      errorCode: code,
      durationMs: Date.now() - startedAt,
    });

    if (mismatch) {
      await recordAttempt(admin, requestId, {
        reservationId: reservation.id,
        provider: provider.name,
        providerEventId: `${notification.transactionId || requestId}:mismatch`,
        eventType: "PAYMENT_AMOUNT_MISMATCH",
        payload: { ...sanitizedPayload, request_id: requestId, expected_cents: reservation.total_cents },
      });
      return result("AMOUNT_MISMATCH");
    }

    // Erro de rede, timeout ou resposta inesperada: vale nova tentativa.
    if (TRANSIENT_PROVIDER_CODES.has(code) || !(error instanceof PaymentProviderError)) {
      return result("PROVIDER_UNAVAILABLE");
    }
    return result("NOT_PAID");
  }

  logPayment({
    requestId,
    stage: "payment_check",
    outcome: verified.paid ? "confirmed" : "not_paid",
    orderId: notification.orderId,
    transactionId: notification.transactionId,
    captureMethod: notification.captureMethod,
    durationMs: Date.now() - startedAt,
  });

  if (!verified.paid) {
    await recordAttempt(admin, requestId, {
      reservationId: reservation.id,
      provider: provider.name,
      providerEventId: `${notification.transactionId || requestId}:unpaid`,
      eventType: "PAYMENT_NOT_CONFIRMED",
      payload: { ...sanitizedPayload, request_id: requestId },
    });
    return result("NOT_PAID");
  }

  const receiptUrl = verified.receiptUrl ?? notification.receiptUrl ?? "";
  const confirmationPayload = {
    ...sanitizedPayload,
    request_id: requestId,
    capture_method: notification.captureMethod ?? "",
    payment_check: sanitizePaymentPayload(verified.raw),
  };

  // Caminho feliz: pré-reserva ainda válida.
  const confirmation = await admin.rpc("confirm_reservation_payment", {
    p_reservation_id: notification.orderId,
    p_provider: provider.name,
    p_provider_event_id: verified.transactionId || `${requestId}:confirm`,
    p_amount_cents: verified.amountCents,
    p_receipt_url: receiptUrl,
    p_payload: confirmationPayload,
  });
  if (confirmation.error) {
    logPayment({ requestId, stage: "confirmation", outcome: "failed", orderId: notification.orderId, errorCode: "CONFIRM_RPC_FAILED" });
    return result("PROVIDER_UNAVAILABLE");
  }
  if (confirmation.data === true) {
    logPayment({ requestId, stage: "confirmation", outcome: "confirmed", orderId: notification.orderId, captureMethod: notification.captureMethod });
    return result("CONFIRMED");
  }

  // A RPC recusou. Como o pagamento está comprovado pelo payment_check, isso quase
  // sempre significa retenção vencida. Reconcilia se a sessão ainda comportar.
  const reconciliation = await admin.rpc("reconcile_reservation_payment", {
    p_reservation_id: notification.orderId,
    p_provider: provider.name,
    p_provider_event_id: verified.transactionId || `${requestId}:confirm`,
    p_amount_cents: verified.amountCents,
    p_receipt_url: receiptUrl,
    p_payload: confirmationPayload,
  });
  if (reconciliation.error) {
    logPayment({ requestId, stage: "reconciliation", outcome: "failed", orderId: notification.orderId, errorCode: "RECONCILE_RPC_FAILED" });
    return result("PROVIDER_UNAVAILABLE");
  }

  const status = typeof reconciliation.data === "string" ? reconciliation.data : "";
  const outcome: ConfirmationOutcome =
    status === "RECONCILED" ? "RECONCILED"
      : status === "ALREADY_CONFIRMED" ? "ALREADY_CONFIRMED"
        : status === "NO_CAPACITY" ? "NO_CAPACITY"
          : status === "AMOUNT_MISMATCH" ? "AMOUNT_MISMATCH"
            : status === "CANCELLED" || status === "SESSION_CANCELLED" ? "CANCELLED"
              : status === "NOT_FOUND" ? "RESERVATION_NOT_FOUND"
                : "PROVIDER_UNAVAILABLE";

  logPayment({
    requestId,
    stage: "reconciliation",
    outcome: outcome === "RECONCILED" ? "reconciled" : outcome === "ALREADY_CONFIRMED" ? "already_confirmed" : "invalid",
    orderId: notification.orderId,
    captureMethod: notification.captureMethod,
    errorCode: outcome === "RECONCILED" || outcome === "ALREADY_CONFIRMED" ? undefined : status || "RECONCILE_UNKNOWN",
  });
  return result(outcome);
}
