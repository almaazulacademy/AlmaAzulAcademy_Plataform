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
  amountCents: number;
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
  constructor(message: string, readonly causeCode: string) {
    super(message);
    this.name = "PaymentProviderError";
  }
}
