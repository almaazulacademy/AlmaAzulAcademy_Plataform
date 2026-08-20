/**
 * Contrato de envio de e-mail transacional.
 *
 * Mesmo desenho de `lib/payments/payment-provider.ts`: uma interface pequena,
 * uma implementação por provedor e um erro com código sanitizado. Trocar de
 * provedor não deve tocar em nada fora de `lib/email/`.
 */

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

export class EmailProviderError extends Error {
  /** true quando repetir a chamada mais tarde pode dar certo. */
  readonly retryable: boolean;

  constructor(readonly causeCode: string, retryable: boolean) {
    super(causeCode);
    this.name = "EmailProviderError";
    this.retryable = retryable;
  }
}

/** Reduz qualquer falha a um símbolo curto e seguro de gravar em log e na fila. */
export function sanitizeEmailErrorCode(error: unknown) {
  if (error instanceof EmailProviderError) return error.causeCode;
  if (error instanceof Error && error.name === "TimeoutError") return "TIMEOUT";
  return "UNEXPECTED_ERROR";
}

export function isRetryableEmailError(error: unknown) {
  if (error instanceof EmailProviderError) return error.retryable;
  return true;
}
