/**
 * Logs da integração com a planilha.
 *
 * A regra é a mesma dos logs de pagamento: identificador técnico mascarado,
 * etapa, resultado e código de erro sanitizado. Nunca telefone, nunca nome,
 * nunca CPF, nunca credencial do Google, nunca conteúdo de célula.
 */

import { maskIdentifier } from "../../payments/observability.ts";

export type SheetsStage =
  | "configuration"
  | "enqueue"
  | "sync"
  | "drain"
  | "admin_sync"
  | "setup";

export type SheetsOutcome =
  | "synced"
  | "pending"
  | "failed"
  | "disabled"
  | "skipped";

export type SheetsLogFields = {
  stage: SheetsStage;
  outcome?: SheetsOutcome;
  entityType?: string;
  entityId?: string;
  operation?: string;
  attempt?: number;
  errorCode?: string;
  durationMs?: number;
  /** Contadores agregados: quantidade de linhas, nunca o conteúdo delas. */
  rowsUpdated?: number;
  rowsAppended?: number;
  spotsDeactivated?: number;
  jobs?: number;
};

export function logSheets(fields: SheetsLogFields) {
  const entry: Record<string, unknown> = {
    scope: "integrations.google_sheets",
    stage: fields.stage,
  };
  if (fields.outcome) entry.outcome = fields.outcome;
  if (fields.entityType) entry.entityType = fields.entityType;
  if (fields.entityId) entry.entityId = maskIdentifier(fields.entityId);
  if (fields.operation) entry.operation = fields.operation;
  if (typeof fields.attempt === "number") entry.attempt = fields.attempt;
  if (fields.errorCode) entry.errorCode = fields.errorCode;
  if (typeof fields.durationMs === "number") entry.durationMs = fields.durationMs;
  if (typeof fields.rowsUpdated === "number") entry.rowsUpdated = fields.rowsUpdated;
  if (typeof fields.rowsAppended === "number") entry.rowsAppended = fields.rowsAppended;
  if (typeof fields.spotsDeactivated === "number") entry.spotsDeactivated = fields.spotsDeactivated;
  if (typeof fields.jobs === "number") entry.jobs = fields.jobs;

  if (fields.outcome === "failed") console.error("[google-sheets]", entry);
  else console.info("[google-sheets]", entry);
}
