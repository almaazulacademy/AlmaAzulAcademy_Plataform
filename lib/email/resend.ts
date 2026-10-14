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

  private readonly configuration: ResendConfiguration;

  constructor(configuration: ResendConfiguration) {
    this.configuration = configuration;
  }

  async send(message: EmailMessage): Promise<void> {
    let response: Response;
    try {
      response = await fetch(RESEND_API, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.configuration.apiKey}`,
          "content-type": "application/json",
          // Só quando a mensagem traz chave. O Resend guarda a chave por 24 horas:
          // a mesma chave com o mesmo corpo devolve a resposta do primeiro envio,
          // sem entregar de novo. Por isso ela vai exatamente como veio — qualquer
          // derivação do conteúdo aqui desfaria a proteção.
          ...(message.idempotencyKey ? { "idempotency-key": message.idempotencyKey } : {}),
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
      // Sem resposta, o pedido pode ter chegado ao provedor: resultado desconhecido.
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new EmailProviderError("TIMEOUT", true, "UNKNOWN");
      }
      throw new EmailProviderError("NETWORK_ERROR", true, "UNKNOWN");
    }

    if (response.ok) return;

    // 401/403 é chave inválida, 422 é remetente ou destinatário recusado:
    // nenhum melhora com repetição imediata. 429 e 5xx melhoram.
    //
    // Um 4xx é o provedor recusando o pedido: a mensagem não saiu. 408 e 5xx não
    // dizem isso — o provedor pode ter aceitado antes de falhar.
    //
    // 409 só acontece com chave de idempotência, e são dois casos: outro pedido
    // com a mesma chave ainda em curso, ou a chave já usada com outro conteúdo.
    // Só o corpo da resposta os distingue, e ele não é lido — pode citar o
    // destinatário. Quem enviou recebe "a chave foi recusada" e decide pelo
    // histórico das próprias tentativas.
    if (response.status === 409) throw new EmailProviderError("HTTP_409", true, "KEY_REFUSED");

    const unknown = response.status === 408 || response.status >= 500;
    const retryable = unknown || response.status === 429;
    throw new EmailProviderError(`HTTP_${response.status}`, retryable, unknown ? "UNKNOWN" : "NOT_SENT");
  }
}
