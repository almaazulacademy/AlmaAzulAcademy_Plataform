/**
 * Logs de pagamento. Regra: nada de dado pessoal, cartão, token ou credencial.
 * Só identificadores do pedido, etapa, resultado e código sanitizado de erro.
 */

const SENSITIVE_KEY = /(cpf|document|card|cardholder|number|pan|cvv|cvc|password|secret|token|authorization|api[_-]?key|handle|holder|birth|address|zip|postal)/i;
const PERSONAL_KEY = /^(name|full_name|customer_name|email|phone|phone_number|customer)$/i;

export type PaymentStage =
  | "webhook_received"
  | "webhook_rejected"
  | "payment_check"
  | "confirmation"
  | "reconciliation"
  | "return_page"
  | "admin_verification";

export type PaymentOutcome =
  | "confirmed"
  | "already_confirmed"
  | "reconciled"
  | "duplicate"
  | "not_paid"
  | "invalid"
  | "failed";

export type PaymentLogFields = {
  requestId: string;
  stage: PaymentStage;
  outcome?: PaymentOutcome;
  orderId?: string;
  transactionId?: string;
  invoiceSlug?: string;
  captureMethod?: string;
  providerStatus?: number;
  errorCode?: string;
  durationMs?: number;
};

/** Mantém só as pontas do identificador: suficiente para correlacionar, insuficiente para vazar. */
export function maskIdentifier(value: string | null | undefined) {
  const text = (value ?? "").trim();
  if (!text) return "";
  if (text.length <= 8) return `${text.slice(0, 2)}…`;
  return `${text.slice(0, 8)}…${text.slice(-4)}`;
}

export function newRequestId() {
  return globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
}

/**
 * Remove chaves sensíveis e pessoais em profundidade antes de qualquer persistência
 * ou log. Valores desconhecidos longos são truncados para não carregar payload inteiro.
 */
export function sanitizePaymentPayload(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizePaymentPayload(item, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) {
        result[key] = "[redacted]";
        continue;
      }
      if (PERSONAL_KEY.test(key)) {
        result[key] = "[personal]";
        continue;
      }
      result[key] = sanitizePaymentPayload(item, depth + 1);
    }
    return result;
  }
  if (typeof value === "string") return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  return value;
}

export function logPayment(fields: PaymentLogFields) {
  const entry: Record<string, unknown> = {
    scope: "payments.infinitepay",
    requestId: fields.requestId,
    stage: fields.stage,
  };
  if (fields.outcome) entry.outcome = fields.outcome;
  if (fields.orderId) entry.orderId = maskIdentifier(fields.orderId);
  if (fields.transactionId) entry.transactionId = maskIdentifier(fields.transactionId);
  if (fields.invoiceSlug) entry.invoiceSlug = maskIdentifier(fields.invoiceSlug);
  if (fields.captureMethod) entry.captureMethod = fields.captureMethod;
  if (typeof fields.providerStatus === "number") entry.providerStatus = fields.providerStatus;
  if (fields.errorCode) entry.errorCode = fields.errorCode;
  if (typeof fields.durationMs === "number") entry.durationMs = fields.durationMs;

  if (fields.outcome === "failed" || fields.outcome === "invalid") console.error("[payments]", entry);
  else console.info("[payments]", entry);
}
