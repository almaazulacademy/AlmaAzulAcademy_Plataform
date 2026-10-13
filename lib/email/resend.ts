/**
 * Envio via Resend, pela API REST oficial.
 *
 * Sem dependência nova: uma chamada `fetch`, como já é feito com a InfinitePay e
 * com o Google Sheets. A chave e o remetente vêm de variável de ambiente e nunca
 * aparecem em log — o corpo de erro do provedor é descartado, sobra só o status.
 */

import { createHash } from "node:crypto";

import {
  EmailProviderError,
  type EmailMessage,
  type EmailProvider,
} from "@/lib/email/email-provider";

const RESEND_API = "https://api.resend.com/emails";
const TIMEOUT_MS = 8000;

/**
 * Cabeçalho `Idempotency-Key` do Resend: por 24 horas, a mesma chave com o mesmo
 * corpo devolve a resposta do primeiro envio em vez de entregar de novo.
 *
 * O resumo do corpo entra na chave porque o Resend recusa com 409 a mesma chave
 * com conteúdo diferente — e continuaria recusando a cada nova tentativa. Com o
 * resumo, a mensagem idêntica é deduplicada e a mensagem corrigida (remetente,
 * texto) segue como um envio novo.
 */
export function resendIdempotencyKey(key: string, body: string) {
  return `${key}/${createHash("sha256").update(body).digest("hex").slice(0, 32)}`;
}

export type ResendConfiguration = {
  apiKey: string;
  from: string;
  replyTo: string | null;
};

export class ResendProvider implements EmailProvider {
  readonly name = "RESEND";

  private readonly configuration: ResendConfiguration;

  constructor(configuration: ResendConfiguration) {
    this.configuration = configuration;
  }

  async send(message: EmailMessage): Promise<void> {
    const body = JSON.stringify({
      from: this.configuration.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(this.configuration.replyTo ? { reply_to: this.configuration.replyTo } : {}),
    });

    let response: Response;
    try {
      response = await fetch(RESEND_API, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.configuration.apiKey}`,
          "content-type": "application/json",
          ...(message.idempotencyKey ? { "idempotency-key": resendIdempotencyKey(message.idempotencyKey, body) } : {}),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new EmailProviderError("TIMEOUT", true);
      }
      throw new EmailProviderError("NETWORK_ERROR", true);
    }

    if (response.ok) return;

    // 401/403 é chave inválida, 422 é remetente ou destinatário recusado:
    // nenhum melhora com repetição imediata. 429 e 5xx melhoram. 409 só existe
    // com chave de idempotência: outro envio da mesma mensagem está em curso.
    const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
    throw new EmailProviderError(`HTTP_${response.status}`, retryable);
  }
}
