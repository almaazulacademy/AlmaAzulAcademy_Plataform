/**
 * Envio em lote dos QRs pendentes — orquestração pura, sem Supabase nem Resend.
 *
 * Para cada reserva, na ordem: reivindica (o banco revalida a elegibilidade e
 * trava contra outro lote) → envia → conclui (grava CHECKIN_QR_RESENT junto com
 * o job). Se o envio falhar, marca o job como falho e segue para a próxima: uma
 * falha nunca interrompe o lote nem grava auditoria.
 *
 * Concorrência baixa e ritmo mínimo entre envios, para ficar dentro do limite
 * de requisições do Resend.
 */

export type QrBulkClaim =
  | { jobId: string; payload: unknown }
  | { skipped: string };

export type QrBulkDeps = {
  claim: (reservationId: string) => Promise<QrBulkClaim>;
  /** Monta e envia a mensagem a partir do payload. Lança em caso de falha. */
  send: (payload: unknown) => Promise<void>;
  complete: (jobId: string) => Promise<boolean>;
  fail: (jobId: string, errorCode: string) => Promise<void>;
  sanitizeError: (error: unknown) => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type QrBulkOptions = {
  concurrency?: number;
  /** Intervalo mínimo entre o início de dois envios. */
  minIntervalMs?: number;
  /** Nova tentativa única, após espera, quando o provedor responde 429. */
  rateLimitRetryMs?: number;
};

export type QrBulkFailure = { reservationId: string; errorCode: string };

export type QrBulkReport = {
  processed: number;
  sent: number;
  skipped: Record<string, number>;
  failed: QrBulkFailure[];
};

export const QR_BULK_DEFAULTS = { concurrency: 2, minIntervalMs: 600, rateLimitRetryMs: 1500 } as const;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runQrBulk(reservationIds: string[], deps: QrBulkDeps, options: QrBulkOptions = {}): Promise<QrBulkReport> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? QR_BULK_DEFAULTS.concurrency, 5));
  const minInterval = options.minIntervalMs ?? QR_BULK_DEFAULTS.minIntervalMs;
  const retryMs = options.rateLimitRetryMs ?? QR_BULK_DEFAULTS.rateLimitRetryMs;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;

  const report: QrBulkReport = { processed: 0, sent: 0, skipped: {}, failed: [] };
  const queue = [...new Set(reservationIds)];

  // Portão de ritmo: os envios começam, no mínimo, a cada `minInterval` ms.
  let nextSlot = 0;
  const waitTurn = async () => {
    const start = Math.max(now(), nextSlot);
    nextSlot = start + minInterval;
    const wait = start - now();
    if (wait > 0) await sleep(wait);
  };

  const processOne = async (reservationId: string) => {
    let claim: QrBulkClaim;
    try {
      claim = await deps.claim(reservationId);
    } catch (error) {
      report.failed.push({ reservationId, errorCode: deps.sanitizeError(error) });
      return;
    }
    if ("skipped" in claim) {
      report.skipped[claim.skipped] = (report.skipped[claim.skipped] ?? 0) + 1;
      return;
    }

    try {
      await waitTurn();
      try {
        await deps.send(claim.payload);
      } catch (error) {
        if (deps.sanitizeError(error) !== "HTTP_429") throw error;
        await sleep(retryMs);
        await waitTurn();
        await deps.send(claim.payload);
      }
    } catch (error) {
      const errorCode = deps.sanitizeError(error);
      await deps.fail(claim.jobId, errorCode).catch(() => undefined);
      report.failed.push({ reservationId, errorCode });
      return;
    }

    // O e-mail saiu. Se a conclusão falhar, o job fica PENDING e a reserva só
    // volta a ser candidata depois de 30 minutos — nunca no mesmo lote.
    const completed = await deps.complete(claim.jobId).catch(() => false);
    if (completed) report.sent += 1;
    else report.failed.push({ reservationId, errorCode: "SENT_NOT_RECORDED" });
  };

  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      await processOne(id);
      report.processed += 1;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
  return report;
}
