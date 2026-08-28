/**
 * Trilha durável do fluxo de pagamento.
 *
 * ## Por que não bastava `payment_events`
 *
 * `payment_events.reservation_id` é NOT NULL com FK. Isso deixa de fora
 * justamente os casos mais difíceis de diagnosticar no incidente atual:
 *
 *   * webhook cujo `order_nsu` não corresponde a nenhuma reserva;
 *   * webhook cujo corpo não dá nem para interpretar;
 *   * webhook respondido com erro HTTP.
 *
 * Nenhum dos três deixa rastro no banco hoje — só uma linha em `console` que
 * some com a retenção de log da Vercel. `payment_webhook_log` aceita os três.
 *
 * ## Regras
 *
 * 1. **Nunca lança.** Uma etapa que não consegue ser registrada não pode
 *    derrubar a confirmação de um pagamento. Todo caminho aqui é `catch`-ado.
 * 2. **Nunca grava PII nem segredo.** O payload passa por
 *    `sanitizePaymentPayload` antes de sair daqui, do mesmo jeito que em
 *    `payment_events`.
 */

import {
  logPayment,
  sanitizePaymentPayload,
  type PaymentSource,
  type PaymentStage,
  type PaymentStep,
} from "@/lib/payments/observability";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

export type PaymentTrailEntry = {
  requestId: string;
  source: PaymentSource;
  step: PaymentStep;
  /** Espelha o vocabulário do CHECK no banco: livre, curto e sem dado pessoal. */
  outcome?: "OK" | "FAILED" | "INVALID" | "SKIPPED";
  orderId?: string;
  providerReference?: string;
  providerEventId?: string;
  httpStatus?: number;
  durationMs?: number;
  errorCode?: string;
  payload?: Record<string, unknown>;
  /** Etapa correspondente no log de stdout, quando fizer sentido duplicar lá. */
  stage?: PaymentStage;
};

/**
 * Grava uma etapa. Devolve o id da linha quando gravou, `null` quando não deu —
 * e não dar nunca é motivo para interromper quem chamou.
 */
export async function recordPaymentStep(
  entry: PaymentTrailEntry,
  client?: SupabaseClient | null,
): Promise<string | null> {
  try {
    const admin = client !== undefined ? client : getSupabaseAdminClient();
    if (!admin) return null;

    const { data, error } = await admin.rpc("record_payment_step", {
      p_request_id: entry.requestId,
      p_source: entry.source,
      p_step: entry.step,
      p_outcome: entry.outcome ?? null,
      p_order_id: entry.orderId ?? null,
      p_provider_reference: entry.providerReference ?? null,
      p_provider_event_id: entry.providerEventId ?? null,
      p_http_status: entry.httpStatus ?? null,
      p_duration_ms: entry.durationMs ?? null,
      p_error_code: entry.errorCode ?? null,
      p_payload: sanitizePaymentPayload(entry.payload ?? {}) as Record<string, unknown>,
    });

    if (error) {
      // A RPC pode simplesmente ainda não estar aplicada neste ambiente.
      logPayment({
        requestId: entry.requestId,
        stage: entry.stage ?? "confirmation",
        outcome: "failed",
        errorCode: "PAYMENT_TRAIL_REJECTED",
      });
      return null;
    }
    return typeof data === "string" ? data : null;
  } catch {
    logPayment({
      requestId: entry.requestId,
      stage: entry.stage ?? "confirmation",
      outcome: "failed",
      errorCode: "PAYMENT_TRAIL_UNAVAILABLE",
    });
    return null;
  }
}
