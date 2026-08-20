/**
 * Envio via Resend, pela API REST oficial.
 *
 * Sem dependência nova: uma chamada `fetch`, como já é feito com a InfinitePay e
 * com o Google Sheets. A chave e o remetente vêm de variável de ambiente e nunca
 * aparecem em log — o corpo de erro do provedor é descartado, sobra só o status.
 */

import {
  EmailProviderError,
  type EmailMessage,
  type EmailProvider,
} from "@/lib/email/email-provider";

const RESEND_API = "https://api.resend.com/emails";
const TIMEOUT_MS = 8000;

export type ResendConfiguration = {
  apiKey: string;
  from: string;
  replyTo: string | null;
};

export class ResendProvider implements EmailProvider {
  readonly name = "RESEND";

  constructor(private readonly configuration: ResendConfiguration) {}

  async send(message: EmailMessage): Promise<void> {
    let response: Response;
    try {
      response = await fetch(RESEND_API, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.configuration.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: this.configuration.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(this.configuration.replyTo ? { reply_to: this.configuration.replyTo } : {}),
        }),
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
    // nenhum melhora com repetição imediata. 429 e 5xx melhoram.
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new EmailProviderError(`HTTP_${response.status}`, retryable);
  }
}
