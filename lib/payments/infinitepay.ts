import {
  PaymentProviderError,
  type CheckoutResult,
  type CreateCheckoutRequest,
  type PaymentProvider,
  type VerifiedPayment,
  type VerifyPaymentRequest,
} from "@/lib/payments/payment-provider";

const CHECKOUT_API = "https://api.checkout.infinitepay.io";
const DEFAULT_TIMEOUT_MS = 8_000;

/** Chaves em que a InfinitePay já devolveu o valor do pedido e o valor cobrado. */
const ORDER_AMOUNT_KEYS = ["amount", "order_amount", "amount_cents", "value"];
const PAID_AMOUNT_KEYS = ["paid_amount", "paidAmount", "captured_amount", "total_amount", "total"];

/** Rótulos que o gateway já usou para "esse dinheiro entrou". */
const PAID_STATUSES = new Set(["paid", "approved", "captured", "succeeded", "confirmed", "authorized"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredHandle() {
  const handle = process.env.INFINITEPAY_HANDLE?.trim().replace(/^\$/, "");
  if (!handle) throw new PaymentProviderError("InfinitePay não configurada.", "MISSING_CONFIGURATION");
  return handle;
}

/**
 * Timeout das chamadas ao gateway.
 *
 * Existe como variável porque a reconciliação pode querer esperar mais que o
 * webhook: lá ninguém está segurando uma resposta HTTP do provedor.
 */
export function providerTimeoutMs() {
  const configured = Number(process.env.INFINITEPAY_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(configured), 1_000), 20_000);
}

async function parseResponse(response: Response) {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(payload)) {
    throw new PaymentProviderError("A InfinitePay não respondeu como esperado.", "PROVIDER_RESPONSE_ERROR");
  }
  return payload;
}

function validHttpsUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Inteiro não negativo, aceitando também o número transportado como string. */
function readAmount(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  }
  return null;
}

/**
 * "O gateway considera este pagamento aprovado?"
 *
 * Deliberadamente mais tolerante que a versão anterior, que exigia
 * `success === true && paid === true` e devolvia NOT_PAID — de forma terminal e
 * silenciosa — para qualquer outra forma de dizer a mesma coisa. `success`
 * ausente é tratado como não-negação; um `status` textual de aprovação vale
 * tanto quanto o booleano.
 */
function isApproved(payload: Record<string, unknown>) {
  if (payload.success === false || payload.success === "false") return false;
  if (payload.paid === true || payload.paid === "true") return true;
  const label = String(payload.status ?? payload.payment_status ?? payload.transaction_status ?? "").trim().toLowerCase();
  return PAID_STATUSES.has(label);
}

export class InfinitePayProvider implements PaymentProvider {
  readonly name = "INFINITEPAY";

  async createCheckout(request: CreateCheckoutRequest): Promise<CheckoutResult> {
    const response = await fetch(`${CHECKOUT_API}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        handle: requiredHandle(),
        order_nsu: request.orderId,
        items: [{
          quantity: request.quantity,
          price: request.unitPriceCents,
          description: request.description,
        }],
        redirect_url: request.returnUrl,
        webhook_url: request.webhookUrl,
        customer: {
          name: request.customer.name,
          email: request.customer.email,
          phone_number: request.customer.phone,
        },
      }),
      signal: AbortSignal.timeout(providerTimeoutMs()),
    });
    const payload = await parseResponse(response);
    const checkoutUrl = validHttpsUrl(payload.url ?? payload.checkout_url ?? payload.link);
    if (!checkoutUrl) throw new PaymentProviderError("Link de pagamento inválido.", "INVALID_CHECKOUT_URL");

    return {
      checkoutUrl,
      providerReference: typeof payload.slug === "string" ? payload.slug : null,
    };
  }

  /**
   * Consulta server-to-server do estado real do pagamento. É a única fonte de
   * verdade da confirmação — nem o payload do webhook, nem a query string do
   * retorno decidem alguma coisa.
   *
   * ## Sobre o valor
   *
   * A regra anterior era igualdade exata contra `amount ?? paid_amount`, e
   * qualquer diferença virava `PAYMENT_AMOUNT_MISMATCH` — um resultado terminal
   * que respondia 200 ao gateway e deixava a reserva vencer. Cartão parcelado
   * com juros pagos pelo cliente cobra **acima** do total da reserva e caía
   * exatamente aí.
   *
   * A regra passa a ser: o maior valor observado precisa cobrir o total da
   * reserva. Cobrança a menor continua sendo divergência — essa nunca pode
   * confirmar sozinha.
   */
  async verifyPayment(request: VerifyPaymentRequest): Promise<VerifiedPayment> {
    const response = await fetch(`${CHECKOUT_API}/payment_check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        handle: requiredHandle(),
        order_nsu: request.orderId,
        transaction_nsu: request.transactionId,
        slug: request.invoiceSlug,
      }),
      signal: AbortSignal.timeout(providerTimeoutMs()),
    });
    const payload = await parseResponse(response);

    const orderAmount = readAmount(payload, ORDER_AMOUNT_KEYS);
    const paidAmount = readAmount(payload, PAID_AMOUNT_KEYS);
    const observed = [orderAmount, paidAmount].filter((value): value is number => value !== null);
    const paid = isApproved(payload);

    // Sem pagamento aprovado o valor é irrelevante: um Pix ainda aguardando não
    // tem valor pago, e transformar isso em erro só apagaria o estado legítimo.
    if (!paid) {
      return {
        paid: false,
        amountCents: observed.length ? Math.max(...observed) : 0,
        chargedAmountCents: observed.length ? Math.max(...observed) : 0,
        transactionId: request.transactionId,
        invoiceSlug: request.invoiceSlug,
        receiptUrl: validHttpsUrl(payload.receipt_url),
        raw: payload,
      };
    }

    if (!observed.length) {
      throw new PaymentProviderError("Valor retornado pela InfinitePay é inválido.", "INVALID_PAYMENT_AMOUNT");
    }

    const charged = Math.max(...observed);
    if (charged < request.expectedAmountCents) {
      throw new PaymentProviderError("O valor pago não corresponde à reserva.", "PAYMENT_AMOUNT_MISMATCH");
    }

    return {
      paid: true,
      // Igualdade exata com `total_cents` é invariante da RPC de confirmação.
      amountCents: request.expectedAmountCents,
      chargedAmountCents: charged,
      transactionId: request.transactionId,
      invoiceSlug: request.invoiceSlug,
      receiptUrl: validHttpsUrl(payload.receipt_url),
      raw: payload,
    };
  }
}
