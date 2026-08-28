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

/**
 * Leitura do corpo do webhook, tolerante a formato.
 *
 * O handler anterior chamava `request.json()` e tratava qualquer falha como
 * corpo inválido: resposta 400, nenhum registro no banco, pagamento perdido.
 * Gateways mandam `application/x-www-form-urlencoded` com frequência, e mandam
 * JSON com `Content-Type` errado com frequência ainda maior — nenhuma das duas
 * coisas justifica perder a notificação de um pagamento aprovado.
 *
 * Devolve também o formato reconhecido, que vai para a trilha durável: é assim
 * que se descobre, depois, que a InfinitePay mudou o envio.
 */
export async function readWebhookBody(request: Request): Promise<{ payload: unknown; format: string }> {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();

  if (contentType.includes("form")) {
    try {
      const form = await request.formData();
      const entries: Record<string, unknown> = {};
      for (const [key, value] of form.entries()) entries[key] = typeof value === "string" ? value : "";
      return { payload: entries, format: "form" };
    } catch {
      return { payload: null, format: "form_unreadable" };
    }
  }

  const raw = await request.text().catch(() => "");
  if (!raw.trim()) return { payload: null, format: "empty" };

  try {
    return { payload: JSON.parse(raw), format: "json" };
  } catch {
    // JSON não era. Última tentativa: corpo de formulário sem o Content-Type.
    const entries = Object.fromEntries(new URLSearchParams(raw).entries());
    if (Object.keys(entries).length) return { payload: entries, format: "form_without_content_type" };
    return { payload: null, format: "unparseable" };
  }
}
