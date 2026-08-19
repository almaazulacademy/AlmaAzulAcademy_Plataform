/**
 * Ponto central da integração com o Google Sheets.
 *
 * Todo caminho que confirma ou cancela uma reserva chama daqui — webhook da
 * InfinitePay, retorno do pagamento, "Verificar pagamento", confirmação manual
 * e cancelamento administrativo. Nenhum endpoint reimplementa sincronização.
 *
 * Regra inegociável: **nada nesta função pode derrubar o fluxo que a chamou.**
 * Quando o Google está fora do ar, a reserva continua confirmada, o pagamento
 * continua confirmado, a vaga continua ocupada e o webhook continua respondendo
 * — o que muda é que o job fica pendente para uma próxima tentativa.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseAdminClient } from "@/lib/supabase/server";

import {
  GOOGLE_SHEETS_INTEGRATION,
  MAX_SYNC_ATTEMPTS,
  OPPORTUNISTIC_DRAIN_LIMIT,
  readGoogleSheetsConfig,
} from "./config.ts";
import { createSheetsClient, type SheetsClient } from "./client.ts";
import { sanitizeErrorCode } from "./errors.ts";
import { parseSnapshot } from "./mapping.ts";
import { logSheets } from "./observability.ts";
import { syncSnapshot } from "./sync.ts";

export type SheetSyncEntity = "RESERVATION" | "SESSION";

export type SheetSyncOperation = "CONFIRMED" | "CANCELLED" | "ADMIN" | "REBUILD";

export type SheetSyncOutcome = "SYNCED" | "PENDING" | "DISABLED";

export type SheetSyncResult = {
  outcome: SheetSyncOutcome;
  errorCode?: string;
};

export type SheetSyncState = {
  status: "SYNCED" | "PENDING" | "FAILED";
  attempts: number;
  operation: string;
  lastErrorCode: string | null;
  syncedAt: string | null;
  updatedAt: string | null;
};

type ClaimedJob = {
  id: string;
  entity_type: string;
  entity_id: string;
  operation: string;
  attempts: number;
};

const DISABLED: SheetSyncResult = { outcome: "DISABLED" };

function snapshotFunctionFor(entity: SheetSyncEntity) {
  return entity === "SESSION" ? "google_sheets_session_snapshot" : "google_sheets_reservation_snapshot";
}

function snapshotArgumentFor(entity: SheetSyncEntity, entityId: string) {
  return entity === "SESSION" ? { p_session_id: entityId } : { p_reservation_id: entityId };
}

/**
 * Lê o snapshot operacional. O recorte de privacidade é feito pela RPC, não
 * aqui: estas funções do banco não devolvem CPF, e-mail nem payload de
 * pagamento, então não existe caminho para eles chegarem à planilha.
 */
async function loadSnapshot(admin: SupabaseClient, entity: SheetSyncEntity, entityId: string) {
  const result = await admin.rpc(snapshotFunctionFor(entity), snapshotArgumentFor(entity, entityId));
  if (result.error) throw new Error("SNAPSHOT_UNAVAILABLE");
  return parseSnapshot(result.data);
}

/**
 * Executa uma sincronização e fecha o job correspondente.
 *
 * Devolve true quando sincronizou. Nunca propaga exceção: o erro vira código
 * sanitizado no job e uma linha de log.
 */
async function runJob(
  admin: SupabaseClient,
  client: SheetsClient,
  job: { id: string | null; entityType: SheetSyncEntity; entityId: string; operation: string; attempt: number },
): Promise<{ synced: boolean; errorCode?: string }> {
  const startedAt = Date.now();

  try {
    const snapshot = await loadSnapshot(admin, job.entityType, job.entityId);

    // Entidade sumiu do banco: não há o que sincronizar e insistir não ajuda.
    // Encerra o job para ele não ficar girando na fila para sempre.
    if (!snapshot) {
      if (job.id) await admin.rpc("complete_integration_sync_job", { p_job_id: job.id });
      logSheets({
        stage: "sync",
        outcome: "skipped",
        entityType: job.entityType,
        entityId: job.entityId,
        operation: job.operation,
        errorCode: "SNAPSHOT_EMPTY",
      });
      return { synced: true };
    }

    const report = await syncSnapshot(client, snapshot, {
      syncedAt: new Date().toISOString(),
      reconcileSession: job.entityType === "SESSION",
    });

    if (job.id) await admin.rpc("complete_integration_sync_job", { p_job_id: job.id });
    logSheets({
      stage: "sync",
      outcome: "synced",
      entityType: job.entityType,
      entityId: job.entityId,
      operation: job.operation,
      attempt: job.attempt,
      durationMs: Date.now() - startedAt,
      rowsUpdated: report.rowsUpdated,
      rowsAppended: report.rowsAppended,
      spotsDeactivated: report.spotsDeactivated,
    });
    return { synced: true };
  } catch (error) {
    const errorCode = sanitizeErrorCode(error);
    if (job.id) {
      // Registrar a falha é o que torna a recuperação possível. Se nem isso der
      // certo, o job continua PENDING — pior caso, é retentado depois.
      await admin
        .rpc("fail_integration_sync_job", { p_job_id: job.id, p_error_code: errorCode })
        .then(() => undefined, () => undefined);
    }
    logSheets({
      stage: "sync",
      outcome: "failed",
      entityType: job.entityType,
      entityId: job.entityId,
      operation: job.operation,
      attempt: job.attempt,
      errorCode,
      durationMs: Date.now() - startedAt,
    });
    return { synced: false, errorCode };
  }
}

/**
 * Aproveita uma execução que já está de pé para empurrar alguns jobs pendentes.
 *
 * É a recuperação automática sem cron e sem polling: o próximo pagamento
 * confirmado limpa a fila que o pagamento anterior deixou para trás. O limite
 * baixo mantém o webhook rápido.
 */
async function drainPendingJobs(admin: SupabaseClient, client: SheetsClient, limit: number) {
  const claim = await admin.rpc("claim_integration_sync_jobs", {
    p_integration: GOOGLE_SHEETS_INTEGRATION,
    p_limit: limit,
    p_max_attempts: MAX_SYNC_ATTEMPTS,
  });
  if (claim.error || !Array.isArray(claim.data) || claim.data.length === 0) return 0;

  const jobs = claim.data as ClaimedJob[];
  let synced = 0;
  for (const job of jobs) {
    const entityType: SheetSyncEntity = job.entity_type === "SESSION" ? "SESSION" : "RESERVATION";
    const result = await runJob(admin, client, {
      id: job.id,
      entityType,
      entityId: job.entity_id,
      operation: job.operation,
      attempt: job.attempts + 1,
    });
    if (result.synced) synced += 1;
  }

  logSheets({ stage: "drain", outcome: "synced", jobs: synced });
  return synced;
}

/**
 * Enfileira e tenta sincronizar agora. Nunca lança.
 *
 * A ordem importa: o job é gravado no Supabase **antes** de qualquer chamada ao
 * Google. Se a instância morrer no meio da chamada, o pendente já está durável.
 */
export async function syncSheetEntity(
  entity: SheetSyncEntity,
  entityId: string,
  operation: SheetSyncOperation,
): Promise<SheetSyncResult> {
  const config = readGoogleSheetsConfig();
  if (!config) return DISABLED;

  const admin = getSupabaseAdminClient();
  if (!admin) return DISABLED;

  let jobId: string | null = null;
  try {
    const enqueue = await admin.rpc("enqueue_integration_sync_job", {
      p_integration: GOOGLE_SHEETS_INTEGRATION,
      p_entity_type: entity,
      p_entity_id: entityId,
      p_operation: operation,
    });
    if (!enqueue.error && typeof enqueue.data === "string") jobId = enqueue.data;
    if (enqueue.error) {
      logSheets({ stage: "enqueue", outcome: "failed", entityType: entity, entityId, operation, errorCode: "ENQUEUE_REJECTED" });
    }
  } catch {
    logSheets({ stage: "enqueue", outcome: "failed", entityType: entity, entityId, operation, errorCode: "ENQUEUE_UNAVAILABLE" });
  }

  try {
    const client = createSheetsClient(config);
    const result = await runJob(admin, client, {
      id: jobId,
      entityType: entity,
      entityId,
      operation,
      attempt: 1,
    });

    if (!result.synced) return { outcome: "PENDING", errorCode: result.errorCode };

    // Só drena quando a própria sincronização deu certo: se o Google está fora,
    // insistir em mais três jobs só atrasaria a resposta.
    await drainPendingJobs(admin, client, OPPORTUNISTIC_DRAIN_LIMIT).catch(() => 0);
    return { outcome: "SYNCED" };
  } catch (error) {
    // Rede de segurança final. Nada aqui pode escapar para quem confirmou o
    // pagamento — o job já está pendente e será retentado.
    const errorCode = sanitizeErrorCode(error);
    logSheets({ stage: "sync", outcome: "failed", entityType: entity, entityId, operation, errorCode });
    return { outcome: "PENDING", errorCode };
  }
}

/**
 * Chamada a partir de qualquer transição real de estado de uma reserva.
 * Envolvida em try/catch próprio: nem uma exceção inesperada de importação
 * pode chegar ao webhook.
 */
export async function syncReservationAfterChange(
  reservationId: string,
  operation: SheetSyncOperation,
): Promise<SheetSyncResult> {
  try {
    return await syncSheetEntity("RESERVATION", reservationId, operation);
  } catch {
    return { outcome: "PENDING", errorCode: "UNEXPECTED_ERROR" };
  }
}

/** Reconstrói a lista inteira de uma sessão a partir do Supabase. */
export async function syncSessionList(sessionId: string): Promise<SheetSyncResult> {
  try {
    return await syncSheetEntity("SESSION", sessionId, "REBUILD");
  } catch {
    return { outcome: "PENDING", errorCode: "UNEXPECTED_ERROR" };
  }
}

/** Estado exibido no detalhe da reserva: Sincronizado, Pendente ou Erro. */
export async function getSheetSyncState(
  entity: SheetSyncEntity,
  entityId: string,
): Promise<SheetSyncState | null> {
  const admin = getSupabaseAdminClient();
  if (!admin) return null;

  try {
    const result = await admin.rpc("integration_sync_state", {
      p_integration: GOOGLE_SHEETS_INTEGRATION,
      p_entity_type: entity,
      p_entity_id: entityId,
    });
    if (result.error || !result.data || typeof result.data !== "object") return null;

    const row = result.data as Record<string, unknown>;
    const status = row.status === "SYNCED" || row.status === "FAILED" ? row.status : "PENDING";
    return {
      status,
      attempts: Number(row.attempts) || 0,
      operation: typeof row.operation === "string" ? row.operation : "",
      lastErrorCode: typeof row.lastErrorCode === "string" ? row.lastErrorCode : null,
      syncedAt: typeof row.syncedAt === "string" ? row.syncedAt : null,
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    };
  } catch {
    return null;
  }
}

/** true quando as variáveis do Google estão configuradas neste ambiente. */
export function isSheetSyncEnabled() {
  return readGoogleSheetsConfig() !== null;
}
