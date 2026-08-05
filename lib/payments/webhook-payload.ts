/**
 * Normalização do payload de webhook da InfinitePay.
 *
 * O handler antigo exigia order_nsu + transaction_nsu + invoice_slug com esses nomes
 * exatos e devolvia 400 para qualquer outra forma. Como a InfinitePay reenvia o mesmo
 * corpo, um payload com nomenclatura diferente entrava em retry infinito e a reserva
 * nunca era confirmada. Aqui aceitamos os apelidos conhecidos e tratamos
 * transaction_nsu/slug como opcionais — o order_nsu é o único campo indispensável,
 * porque é ele que liga o evento à reserva.
 */

export type NormalizedWebhook = {
  orderId: string;
  transactionId: string;
  invoiceSlug: string;
  captureMethod: string;
  amountCents: number | null;
  receiptUrl: string;
};

const ORDER_KEYS = ["order_nsu", "orderNsu", "order_id", "orderId", "external_order_nsu"];
const TRANSACTION_KEYS = ["transaction_nsu", "transactionNsu", "transaction_id", "transactionId", "nsu"];
const SLUG_KEYS = ["invoice_slug", "invoiceSlug", "slug", "checkout_slug"];
const CAPTURE_KEYS = ["capture_method", "captureMethod", "payment_method", "paymentMethod"];
const AMOUNT_KEYS = ["amount", "paid_amount", "paidAmount", "amount_cents", "total"];
const RECEIPT_KEYS = ["receipt_url", "receiptUrl"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function readInteger(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  }
  return null;
}

/** Alguns provedores aninham o evento em `data`, `payment` ou `transaction`. */
function flatten(payload: Record<string, unknown>): Record<string, unknown> {
  const nested = ["data", "payment", "transaction", "invoice", "order"]
    .map((key) => payload[key])
    .filter(isRecord);
  return Object.assign({}, ...nested, payload) as Record<string, unknown>;
}

/** Normaliza `capture_method` para os valores que o negócio reconhece. */
export function normalizeCaptureMethod(value: string) {
  const method = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!method) return "";
  if (method.includes("pix")) return "pix";
  if (method.includes("credit")) return "credit_card";
  if (method.includes("debit")) return "debit_card";
  return method;
}

export function parseInfinitePayWebhook(payload: unknown): NormalizedWebhook | null {
  if (!isRecord(payload)) return null;
  const source = flatten(payload);
  const orderId = readString(source, ORDER_KEYS);
  if (!orderId) return null;

  return {
    orderId,
    transactionId: readString(source, TRANSACTION_KEYS),
    invoiceSlug: readString(source, SLUG_KEYS),
    captureMethod: normalizeCaptureMethod(readString(source, CAPTURE_KEYS)),
    amountCents: readInteger(source, AMOUNT_KEYS),
    receiptUrl: readString(source, RECEIPT_KEYS),
  };
}
