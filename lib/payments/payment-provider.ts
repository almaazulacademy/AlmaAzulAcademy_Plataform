export type CheckoutCustomer = {
  name: string;
  email: string;
  phone: string;
};

export type CreateCheckoutRequest = {
  orderId: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  customer: CheckoutCustomer;
  returnUrl: string;
  webhookUrl: string;
};

export type CheckoutResult = {
  checkoutUrl: string;
  providerReference: string | null;
};

export type VerifyPaymentRequest = {
  orderId: string;
  transactionId: string;
  invoiceSlug: string;
  expectedAmountCents: number;
};

export type VerifiedPayment = {
  paid: boolean;
  /**
   * Valor que quita a reserva, em centavos. Quando o pagamento está quitado é
   * sempre `expectedAmountCents`: é ele que a RPC de confirmação compara com
   * `reservations.total_cents`, e essa igualdade é um invariante do banco.
   */
  amountCents: number;
  /**
   * Maior valor realmente observado na resposta do gateway. Pode ser **maior**
   * que `amountCents` — parcelamento com juros pagos pelo cliente cobra acima do
   * total da reserva. Fica no payload do evento para conferência, sem virar
   * divergência.
   */
  chargedAmountCents: number;
  transactionId: string;
  invoiceSlug: string;
  receiptUrl: string | null;
  raw: Record<string, unknown>;
};

export interface PaymentProvider {
  readonly name: string;
  createCheckout(request: CreateCheckoutRequest): Promise<CheckoutResult>;
  verifyPayment(request: VerifyPaymentRequest): Promise<VerifiedPayment>;
}

export class PaymentProviderError extends Error {
  /**
   * Código curto e estável do motivo. Vai para log e para `payment_events`, então
   * nunca carrega mensagem do gateway nem dado do cliente.
   *
   * Declarado como campo, e não como propriedade de parâmetro: o runner de testes
   * do Node carrega os `.ts` em *strip-only mode*, que não suporta
   * `constructor(readonly x: T)`.
   */
  readonly causeCode: string;

  constructor(message: string, causeCode: string) {
    super(message);
    this.name = "PaymentProviderError";
    this.causeCode = causeCode;
  }
}
