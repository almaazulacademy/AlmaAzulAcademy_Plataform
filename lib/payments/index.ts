import { InfinitePayProvider } from "@/lib/payments/infinitepay";
import type { PaymentProvider } from "@/lib/payments/payment-provider";

export function getPaymentProvider(): PaymentProvider {
  const provider = process.env.PAYMENT_PROVIDER?.trim().toUpperCase() || "INFINITEPAY";
  if (provider === "INFINITEPAY") return new InfinitePayProvider();
  throw new Error(`Provedor de pagamento não suportado: ${provider}`);
}

export type {
  CheckoutResult,
  CreateCheckoutRequest,
  PaymentProvider,
  VerifiedPayment,
  VerifyPaymentRequest,
} from "@/lib/payments/payment-provider";
