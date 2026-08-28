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
  /** Símbolo curto do motivo, seguro para log e para a fila. */
  readonly causeCode: string;
  /** true quando repetir a chamada mais tarde pode dar certo. */
  readonly retryable: boolean;

  // Campos declarados, e não propriedades de parâmetro: o runner de testes do
  // Node carrega os `.ts` em strip-only mode, que não suporta a forma curta.
  constructor(causeCode: string, retryable: boolean) {
    super(causeCode);
    this.name = "EmailProviderError";
    this.causeCode = causeCode;
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
