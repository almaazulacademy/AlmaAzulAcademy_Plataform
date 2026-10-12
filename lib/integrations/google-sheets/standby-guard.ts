/**
 * Quando uma sincronização só pode **atualizar** a planilha, sem criar a turma.
 *
 * Uma reserva em Stand-by continua apontando para a turma original. Sincronizá-la
 * do jeito normal escreveria a linha dessa turma na aba `Sessões` mesmo que ela
 * nunca tenha estado lá — e é exatamente o caso das sessões históricas mantidas
 * fora da planilha de propósito (ver
 * `docs/incident-2026-10-google-sheets-grid-limit.md`).
 *
 * A regra não depende de quem chamou. Ela é decidida a cada execução, a partir
 * das linhas de `reservation_standby` cuja turma original é a turma que está
 * sendo sincronizada — então vale igualmente para a entrada em Stand-by, o
 * reagendamento, o cancelamento, os botões manuais e um job pendente retomado
 * horas depois.
 *
 * Em modo "somente atualizar", turma que já está na planilha é atualizada
 * normalmente; turma ausente não é criada e nada é escrito.
 */

export type StandbyOriginRow = {
  reservationId: string;
  /** `resolved_at is null`: a reserva ainda está em Stand-by. */
  open: boolean;
  resolution: string | null;
  resolvedSessionId: string | null;
};

/**
 * `rows` são as autorizações de Stand-by cuja turma original é `sessionId`.
 *
 * RESERVATION — a reserva está em Stand-by, ou foi cancelada em Stand-by: nos
 * dois casos ela ainda aponta para a turma original e não ocupa vaga nela.
 * Depois de reagendada ou devolvida à turma, a sincronização volta ao normal:
 * a reserva está confirmada em uma turma futura, que pode precisar ser criada.
 *
 * SESSION — a turma já foi origem de um Stand-by que não terminou nela mesma.
 * Reconstruir essa turma serve para corrigir totais, nunca para criá-la.
 */
export function isStandbyOriginUpdateOnly(
  entity: "RESERVATION" | "SESSION",
  entityId: string,
  sessionId: string,
  rows: readonly StandbyOriginRow[],
) {
  if (entity === "RESERVATION") {
    return rows.some((row) => row.reservationId === entityId && (row.open || row.resolution === "CANCELLED"));
  }
  return rows.some((row) => row.open || row.resolution === "CANCELLED" || row.resolvedSessionId !== sessionId);
}

/** Linha de `reservation_standby` como o PostgREST devolve. */
export function parseStandbyOriginRows(value: unknown): StandbyOriginRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .map((row) => ({
      reservationId: typeof row.reservation_id === "string" ? row.reservation_id : "",
      open: row.resolved_at === null || row.resolved_at === undefined,
      resolution: typeof row.resolution === "string" ? row.resolution : null,
      resolvedSessionId: typeof row.resolved_session_id === "string" ? row.resolved_session_id : null,
    }));
}

/**
 * Erros do PostgREST/Postgres que significam "este banco não tem Stand-by":
 * tabela fora do cache do PostgREST ou inexistente. Sem a tabela não existe
 * reserva em Stand-by, logo não há turma original a proteger.
 */
export function isStandbyTableMissing(code: unknown) {
  return code === "PGRST205" || code === "42P01";
}
