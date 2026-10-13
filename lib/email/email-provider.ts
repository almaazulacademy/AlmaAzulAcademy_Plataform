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
  /**
   * Identifica o envio para o provedor não entregar duas vezes a mesma
   * mensagem: repetir a chave com o mesmo conteúdo devolve a resposta do
   * primeiro envio. Opcional: sem ela, o envio é feito como sempre foi.
   */
  idempotencyKey?: string;
};

/**
 * O que uma falha diz sobre a entrega.
 *
 *   NOT_SENT    — o provedor respondeu recusando: a mensagem comprovadamente não saiu.
 *   UNKNOWN     — não houve resposta conclusiva (timeout, rede, 5xx): pode ter saído.
 *   KEY_REFUSED — o provedor recusou a chave de idempotência: ou outro pedido com
 *                 ela ainda está em curso, ou ela já foi usada com outro conteúdo.
 *                 Nos dois casos um pedido anterior chegou lá, e o que aconteceu
 *                 com ele continua desconhecido.
 */
export type EmailDelivery = "NOT_SENT" | "UNKNOWN" | "KEY_REFUSED";

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

export class EmailProviderError extends Error {
  /** Símbolo curto do motivo, seguro para log e para a fila. */
  readonly causeCode: string;
  /** true quando repetir a chamada mais tarde pode dar certo. */
  readonly retryable: boolean;
  /** O que se sabe sobre a entrega. Sem informação, vale o mais prudente: UNKNOWN. */
  readonly delivery: EmailDelivery;

  // Campos declarados, e não propriedades de parâmetro: o runner de testes do
  // Node carrega os `.ts` em strip-only mode, que não suporta a forma curta.
  constructor(causeCode: string, retryable: boolean, delivery: EmailDelivery = "UNKNOWN") {
    super(causeCode);
    this.name = "EmailProviderError";
    this.causeCode = causeCode;
    this.retryable = retryable;
    this.delivery = delivery;
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

/**
 * O que uma falha de envio diz sobre a entrega. Qualquer erro que não seja uma
 * recusa explícita do provedor é UNKNOWN: um envio com resultado desconhecido
 * nunca é tratado como comprovadamente não enviado.
 */
export function emailDeliveryOf(error: unknown): EmailDelivery {
  return error instanceof EmailProviderError ? error.delivery : "UNKNOWN";
}
