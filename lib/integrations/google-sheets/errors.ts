/**
 * Erros da integração com o Google.
 *
 * O único dado que sai daqui é um código curto e maiúsculo. Corpo de resposta,
 * mensagem do Google, cabeçalho e credencial nunca viram propriedade deste erro
 * — porque tudo que este erro carrega acaba em log e na fila de sincronização.
 */

export type GoogleSheetsErrorCode =
  | "NOT_CONFIGURED"
  | "INVALID_PRIVATE_KEY"
  | "AUTH_FAILED"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE"
  | `HTTP_${number}`;

export class GoogleSheetsError extends Error {
  readonly code: GoogleSheetsErrorCode;
  /** true quando repetir a chamada mais tarde pode dar certo. */
  readonly retryable: boolean;

  constructor(code: GoogleSheetsErrorCode, retryable: boolean) {
    super(code);
    this.name = "GoogleSheetsError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** Um 4xx de permissão não melhora com repetição; 429 e 5xx melhoram. */
export function httpError(status: number) {
  const retryable = status === 408 || status === 429 || status >= 500;
  return new GoogleSheetsError(`HTTP_${status}` as GoogleSheetsErrorCode, retryable);
}

/**
 * Reduz qualquer falha a um símbolo seguro de gravar. Um erro inesperado vira
 * `UNEXPECTED_ERROR`, nunca a mensagem original — que poderia trazer URL
 * assinada, token ou conteúdo de célula.
 */
export function sanitizeErrorCode(error: unknown): string {
  if (error instanceof GoogleSheetsError) return error.code;
  if (error instanceof Error && error.name === "AbortError") return "TIMEOUT";
  return "UNEXPECTED_ERROR";
}

export function isRetryable(error: unknown) {
  if (error instanceof GoogleSheetsError) return error.retryable;
  return true;
}
