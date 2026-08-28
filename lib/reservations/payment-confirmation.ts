import type { SupabaseClient } from "@supabase/supabase-js";

import { syncReservationAfterChange } from "@/lib/integrations/google-sheets/service";
import { getPaymentProvider } from "@/lib/payments";
import type { PaymentProvider } from "@/lib/payments/payment-provider";
import { sendReservationConfirmationEmail } from "@/lib/reservations/confirmation-email-service";
import {
  logPayment,
  newRequestId,
  sanitizePaymentPayload,
  type PaymentSource,
  type PaymentStage,
} from "@/lib/payments/observability";
import { recordPaymentStep } from "@/lib/payments/payment-trail";
import { PaymentProviderError } from "@/lib/payments/payment-provider";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

/**
 * Portas externas da confirmação.
 *
 * Mesma ideia de `deliverReservationConfirmationEmail`, que já recebe
 * `claim`/`load`/`send`/`complete`/`fail` de fora: a orquestração fica testável
 * de ponta a ponta sem banco e sem rede, e a produção continua usando o
 * Supabase e o provedor reais por padrão.
 *
 * É por aqui que a suíte exercita webhook duplicado, webhook atrasado, gateway
 * fora do ar, confirmações simultâneas e pagamento tardio sem capacidade — todos
 * contra o código que roda em produção, não contra uma cópia dele.
 */
export type ConfirmationPorts = {
  admin?: SupabaseClient | null;
  provider?: PaymentProvider;
  /** Planilha e e-mail. Sobrescrito nos testes para observar o disparo. */
  jobs?: (reservationId: string) => Promise<void>;
};

type PaymentNotification = {
  orderId: string;
  transactionId: string;
  invoiceSlug: string;
  captureMethod?: string;
  receiptUrl?: string;
  payload: Record<string, unknown>;
  requestId?: string;
  stage?: PaymentStage;
  /** Origem da chamada na trilha durável. */
  source?: PaymentSource;
  /**
   * Quando true, planilha e e-mail não são aguardados aqui. O chamador recebe
   * `settle()` em `confirmPaymentWithJobs` e decide quando rodá-los — no webhook
   * isso acontece depois da resposta HTTP, via `after()`.
   */
  deferSideEffects?: boolean;
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
  /** Valor cobrado abaixo do total da reserva. */
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
  /**
   * true quando o resultado é **definitivo e negativo**: a InfinitePay afirma que
   * este pedido não está pago. Só nesse caso a reconciliação pode devolver a vaga
   * ao mercado. Erro de rede, timeout e divergência de valor não entram aqui.
   */
  definitivelyUnpaid: boolean;
  /** true quando um humano precisa olhar. Alimenta "Pagamentos para revisar". */
  needsReview: boolean;
};

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
    definitivelyUnpaid: outcome === "NOT_PAID",
    needsReview: outcome === "NO_CAPACITY" || outcome === "AMOUNT_MISMATCH",
  };
}

/**
 * Efeitos colaterais pós-confirmação: planilha operacional e e-mail do cliente.
 *
 * Ficam separados de propósito. Os dois somam até dezesseis segundos de rede no
 * pior caso e estavam **dentro** do tempo de resposta do webhook — um caminho
 * direto para o gateway ver timeout num pagamento que já tinha sido confirmado.
 * Nenhum dos dois pode alterar o resultado: quando o Google ou o provedor de
 * e-mail falham, a reserva segue CONFIRMED e só os jobs ficam pendentes.
 */
export async function runPostConfirmationJobs(reservationId: string) {
  await syncReservationAfterChange(reservationId, "CONFIRMED");
  await sendReservationConfirmationEmail(reservationId);
}

/**
 * Ponto único de confirmação. Usado pelo webhook, pela página de retorno, pela
 * verificação administrativa e pela reconciliação automática — os quatro
 * caminhos são idempotentes e chegam ao mesmo estado final.
 *
 * A confirmação nunca se apoia no payload recebido: o valor e o status "pago"
 * sempre vêm de uma consulta server-to-server ao payment_check da InfinitePay.
 */
export async function confirmPayment(
  notification: PaymentNotification,
  ports: ConfirmationPorts = {},
): Promise<ConfirmationResult> {
  const { result: confirmation, settle } = await confirmPaymentWithJobs(notification, ports);
  if (!notification.deferSideEffects) await settle();
  return confirmation;
}

/**
 * Igual a `confirmPayment`, mas devolve os efeitos colaterais como uma função a
 * ser executada quando o chamador quiser. `settle()` é seguro de chamar sempre:
 * quando não houve confirmação, não faz nada.
 */
export async function confirmPaymentWithJobs(
  notification: PaymentNotification,
  ports: ConfirmationPorts = {},
): Promise<{ result: ConfirmationResult; settle: () => Promise<void> }> {
  const confirmation = await runConfirmation(notification, ports);
  const jobs = ports.jobs ?? runPostConfirmationJobs;

  const settle = async () => {
    // Também roda em ALREADY_CONFIRMED: um webhook repetido vira, de graça, uma
    // nova tentativa do que ficou pendente antes. Não gera e-mail duplicado
    // porque a reivindicação no banco só devolve job para envio ainda não feito.
    if (!confirmation.confirmed) return;
    await jobs(notification.orderId);
  };

  return { result: confirmation, settle };
}

async function runConfirmation(
  notification: PaymentNotification,
  ports: ConfirmationPorts,
): Promise<ConfirmationResult> {
  const requestId = notification.requestId ?? newRequestId();
  const stage: PaymentStage = notification.stage ?? "confirmation";
  const source: PaymentSource = notification.source ?? "WEBHOOK";
  const admin = ports.admin !== undefined ? ports.admin : getSupabaseAdminClient();
  if (!admin) throw new Error("Supabase administrativo não configurado.");

  const reservationResult = await admin
    .from("reservations")
    .select("id,total_cents,status,expires_at,payment_hold_until,provider_reference")
    .eq("id", notification.orderId)
    .maybeSingle();

  if (reservationResult.error) {
    logPayment({ requestId, stage, outcome: "failed", orderId: notification.orderId, errorCode: "RESERVATION_LOOKUP_FAILED" });
    await recordPaymentStep({
      requestId, source, step: "CONFIRM_FAILED", outcome: "FAILED",
      orderId: notification.orderId, errorCode: "RESERVATION_LOOKUP_FAILED", stage,
    }, admin);
    return result("PROVIDER_UNAVAILABLE");
  }
  if (!reservationResult.data) {
    logPayment({ requestId, stage, outcome: "invalid", orderId: notification.orderId, errorCode: "RESERVATION_NOT_FOUND" });
    await recordPaymentStep({
      requestId, source, step: "WEBHOOK_REJECTED", outcome: "INVALID",
      orderId: notification.orderId, errorCode: "RESERVATION_NOT_FOUND", stage,
    }, admin);
    return result("RESERVATION_NOT_FOUND");
  }

  const reservation = reservationResult.data;
  if (reservation.status === "CONFIRMED") {
    logPayment({ requestId, stage, outcome: "already_confirmed", orderId: notification.orderId });
    await recordPaymentStep({
      requestId, source, step: "CONFIRM_SUCCESS", outcome: "SKIPPED",
      orderId: notification.orderId, errorCode: "ALREADY_CONFIRMED", stage,
    }, admin);
    return result("ALREADY_CONFIRMED");
  }
  if (reservation.status === "CANCELLED") {
    logPayment({ requestId, stage, outcome: "invalid", orderId: notification.orderId, errorCode: "RESERVATION_CANCELLED" });
    await recordPaymentStep({
      requestId, source, step: "CONFIRM_FAILED", outcome: "INVALID",
      orderId: notification.orderId, errorCode: "RESERVATION_CANCELLED", stage,
    }, admin);
    return result("CANCELLED");
  }

  const sanitizedPayload = sanitizePaymentPayload(notification.payload) as Record<string, unknown>;
  const provider = ports.provider ?? getPaymentProvider();

  // A referência do checkout guardada na criação é a melhor pista quando o
  // webhook chega sem slug — e é a única pista da reconciliação, que não tem
  // webhook nenhum para ler.
  const invoiceSlug = notification.invoiceSlug
    || (typeof reservation.provider_reference === "string" ? reservation.provider_reference : "");

  // Deixa rastro do que chegou antes de qualquer verificação. Sem isso, um webhook
  // que falha some sem deixar histórico — foi exatamente o que impediu o diagnóstico
  // dos casos anteriores.
  await recordAttempt(admin, requestId, {
    reservationId: reservation.id,
    provider: provider.name,
    providerEventId: `${notification.transactionId || invoiceSlug || requestId}:received`,
    eventType: "PAYMENT_WEBHOOK_RECEIVED",
    payload: {
      ...sanitizedPayload,
      stage,
      request_id: requestId,
      capture_method: notification.captureMethod ?? "",
    },
  });
  await recordPaymentStep({
    requestId, source, step: "WEBHOOK_VALIDATED", outcome: "OK",
    orderId: notification.orderId, providerReference: invoiceSlug,
    providerEventId: notification.transactionId, stage,
    payload: { capture_method: notification.captureMethod ?? "", reservation_status: reservation.status },
  }, admin);

  let verified;
  const startedAt = Date.now();
  try {
    verified = await provider.verifyPayment({
      orderId: notification.orderId,
      transactionId: notification.transactionId,
      invoiceSlug,
      expectedAmountCents: Number(reservation.total_cents),
    });
  } catch (error) {
    const code = error instanceof PaymentProviderError ? error.causeCode : "PAYMENT_CHECK_FAILED";
    const mismatch = code === "PAYMENT_AMOUNT_MISMATCH";
    const durationMs = Date.now() - startedAt;
    logPayment({
      requestId,
      stage: "payment_check",
      outcome: mismatch ? "invalid" : "failed",
      orderId: notification.orderId,
      transactionId: notification.transactionId,
      captureMethod: notification.captureMethod,
      errorCode: code,
      durationMs,
    });
    await recordPaymentStep({
      requestId, source, step: "PAYMENT_CHECK_FAILED", outcome: mismatch ? "INVALID" : "FAILED",
      orderId: notification.orderId, providerReference: invoiceSlug,
      providerEventId: notification.transactionId, errorCode: code, durationMs, stage: "payment_check",
    }, admin);

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

    // Toda exceção que não é divergência de valor vira PROVIDER_UNAVAILABLE.
    //
    // Antes, um `PaymentProviderError` fora da lista de códigos transitórios
    // virava `NOT_PAID` — um veredito *definitivo* de "não pagou" tirado de um
    // erro do nosso lado. Com a janela de segurança, esse veredito libera a
    // vaga. Falha de rede, timeout, resposta ilegível e configuração ausente não
    // são prova de não pagamento: são incerteza, e incerteza segura a vaga.
    return result("PROVIDER_UNAVAILABLE");
  }

  const durationMs = Date.now() - startedAt;
  logPayment({
    requestId,
    stage: "payment_check",
    outcome: verified.paid ? "confirmed" : "not_paid",
    orderId: notification.orderId,
    transactionId: notification.transactionId,
    captureMethod: notification.captureMethod,
    durationMs,
  });
  await recordPaymentStep({
    requestId, source, step: verified.paid ? "PAYMENT_APPROVED" : "PAYMENT_NOT_APPROVED",
    outcome: "OK", orderId: notification.orderId, providerReference: invoiceSlug,
    providerEventId: notification.transactionId, durationMs, stage: "payment_check",
    payload: verified.paid ? { charged_amount_cents: verified.chargedAmountCents } : {},
  }, admin);

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
    charged_amount_cents: verified.chargedAmountCents,
    payment_check: sanitizePaymentPayload(verified.raw),
  };
  const providerEventId = verified.transactionId || `${requestId}:confirm`;

  await recordPaymentStep({
    requestId, source, step: "CONFIRM_ATTEMPT", outcome: "OK",
    orderId: notification.orderId, providerEventId, stage: "confirmation",
  }, admin);

  // Caminho feliz: retenção ainda válida — inclusive quando a validade é a
  // janela de segurança da expiração, e não mais o prazo original do cliente.
  const confirmation = await admin.rpc("confirm_reservation_payment", {
    p_reservation_id: notification.orderId,
    p_provider: provider.name,
    p_provider_event_id: providerEventId,
    p_amount_cents: verified.amountCents,
    p_receipt_url: receiptUrl,
    p_payload: confirmationPayload,
  });
  if (confirmation.error) {
    logPayment({ requestId, stage: "confirmation", outcome: "failed", orderId: notification.orderId, errorCode: "CONFIRM_RPC_FAILED" });
    await recordPaymentStep({
      requestId, source, step: "CONFIRM_FAILED", outcome: "FAILED",
      orderId: notification.orderId, providerEventId, errorCode: "CONFIRM_RPC_FAILED", stage: "confirmation",
    }, admin);
    return result("PROVIDER_UNAVAILABLE");
  }
  if (confirmation.data === true) {
    logPayment({ requestId, stage: "confirmation", outcome: "confirmed", orderId: notification.orderId, captureMethod: notification.captureMethod });
    await recordPaymentStep({
      requestId, source, step: "CONFIRM_SUCCESS", outcome: "OK",
      orderId: notification.orderId, providerEventId, stage: "confirmation",
    }, admin);
    return result("CONFIRMED");
  }

  // A RPC recusou. Como o pagamento está comprovado pelo payment_check, isso quase
  // sempre significa retenção vencida. Reconcilia se a sessão ainda comportar.
  await recordPaymentStep({
    requestId, source, step: "RECONCILIATION_ATTEMPT", outcome: "OK",
    orderId: notification.orderId, providerEventId, stage: "reconciliation",
  }, admin);
  const reconciliation = await admin.rpc("reconcile_reservation_payment", {
    p_reservation_id: notification.orderId,
    p_provider: provider.name,
    p_provider_event_id: providerEventId,
    p_amount_cents: verified.amountCents,
    p_receipt_url: receiptUrl,
    p_payload: confirmationPayload,
  });
  if (reconciliation.error) {
    logPayment({ requestId, stage: "reconciliation", outcome: "failed", orderId: notification.orderId, errorCode: "RECONCILE_RPC_FAILED" });
    await recordPaymentStep({
      requestId, source, step: "RECONCILIATION_FAILED", outcome: "FAILED",
      orderId: notification.orderId, providerEventId, errorCode: "RECONCILE_RPC_FAILED", stage: "reconciliation",
    }, admin);
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
  await recordPaymentStep({
    requestId,
    source,
    step: outcome === "NO_CAPACITY"
      ? "PAYMENT_APPROVED_WITHOUT_CAPACITY"
      : outcome === "RECONCILED" || outcome === "ALREADY_CONFIRMED"
        ? "RECONCILIATION_SUCCESS"
        : "RECONCILIATION_FAILED",
    outcome: outcome === "RECONCILED" || outcome === "ALREADY_CONFIRMED" ? "OK" : "FAILED",
    orderId: notification.orderId,
    providerEventId,
    errorCode: outcome === "RECONCILED" || outcome === "ALREADY_CONFIRMED" ? undefined : status || "RECONCILE_UNKNOWN",
    stage: "reconciliation",
  }, admin);
  return result(outcome);
}
