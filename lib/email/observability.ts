/**
 * Logs de envio de e-mail.
 *
 * O endereço do destinatário **nunca** é logado, nem mascarado: o identificador
 * técnico da reserva já basta para correlacionar, e ele não é dado pessoal.
 * Também não entram nome, assunto, corpo da mensagem nem chave do provedor.
 */

import { maskIdentifier } from "@/lib/payments/observability";

export type EmailStage = "confirmation" | "retry" | "configuration";

export type EmailOutcome = "sent" | "skipped" | "pending" | "failed" | "disabled";

export type EmailLogFields = {
  stage: EmailStage;
  outcome: EmailOutcome;
  reservationId?: string;
  provider?: string;
  attempt?: number;
  errorCode?: string;
  durationMs?: number;
  drained?: number;
};

export function logEmail(fields: EmailLogFields) {
  const entry: Record<string, unknown> = {
    scope: "notifications.email",
    stage: fields.stage,
    outcome: fields.outcome,
  };
  if (fields.reservationId) entry.reservationId = maskIdentifier(fields.reservationId);
  if (fields.provider) entry.provider = fields.provider;
  if (typeof fields.attempt === "number") entry.attempt = fields.attempt;
  if (fields.errorCode) entry.errorCode = fields.errorCode;
  if (typeof fields.durationMs === "number") entry.durationMs = fields.durationMs;
  if (typeof fields.drained === "number") entry.drained = fields.drained;

  if (fields.outcome === "failed") console.error("[email]", entry);
  else console.info("[email]", entry);
}
