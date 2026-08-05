import {
  PaymentProviderError,
  type CheckoutResult,
  type CreateCheckoutRequest,
  type PaymentProvider,
  type VerifiedPayment,
  type VerifyPaymentRequest,
} from "@/lib/payments/payment-provider";

const CHECKOUT_API = "https://api.checkout.infinitepay.io";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredHandle() {
  const handle = process.env.INFINITEPAY_HANDLE?.trim().replace(/^\$/, "");
  if (!handle) throw new PaymentProviderError("InfinitePay não configurada.", "MISSING_CONFIGURATION");
  return handle;
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
      signal: AbortSignal.timeout(8_000),
    });
    const payload = await parseResponse(response);
    const checkoutUrl = validHttpsUrl(payload.url ?? payload.checkout_url ?? payload.link);
    if (!checkoutUrl) throw new PaymentProviderError("Link de pagamento inválido.", "INVALID_CHECKOUT_URL");

    return {
      checkoutUrl,
      providerReference: typeof payload.slug === "string" ? payload.slug : null,
    };
  }

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
      signal: AbortSignal.timeout(8_000),
    });
    const payload = await parseResponse(response);
    // A InfinitePay já devolveu `amount` e `paid_amount` conforme o tipo de captura.
    const amountCents = Number(payload.amount ?? payload.paid_amount);
    const paid = payload.success === true && payload.paid === true;
    if (!Number.isInteger(amountCents) || amountCents < 0) {
      throw new PaymentProviderError("Valor retornado pela InfinitePay é inválido.", "INVALID_PAYMENT_AMOUNT");
    }
    if (paid && amountCents !== request.expectedAmountCents) {
      throw new PaymentProviderError("O valor pago não corresponde à reserva.", "PAYMENT_AMOUNT_MISMATCH");
    }

    return {
      paid,
      amountCents,
      transactionId: request.transactionId,
      invoiceSlug: request.invoiceSlug,
      receiptUrl: validHttpsUrl(payload.receipt_url),
      raw: payload,
    };
  }
}
