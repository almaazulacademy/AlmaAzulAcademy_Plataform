/**
 * Motor de sincronização.
 *
 * Recebe um snapshot já lido do Supabase e um *gateway* de planilha, e converge
 * a planilha para o estado do snapshot. Não conhece HTTP, não conhece
 * credencial, não conhece Supabase — o que permite testar idempotência,
 * expansão de vagas e cancelamento contra uma planilha falsa em memória.
 *
 * Idempotência vem da chave, nunca do nome ou do telefone:
 *
 *   `Reservas do Site`   → chave `reservation_id`
 *   `Sessões`            → chave `session_id`
 *   `Vagas Confirmadas`  → chave `reservation_id:índice`
 *
 * Sincronizar a mesma reserva vinte vezes reescreve as mesmas linhas vinte
 * vezes e termina com exatamente um registro de cada.
 */

import {
  ACTIVE_NO,
  a1,
  columnLetter,
  FIRST_DATA_ROW,
  RESERVATION_HEADERS,
  RESERVATIONS_TAB,
  rowRange,
  SESSION_HEADERS,
  SESSIONS_TAB,
  SPOT_COLUMN,
  SPOT_HEADERS,
  SPOTS_TAB,
} from "./schema.ts";
import {
  reservationRow,
  sessionRow,
  spotRows,
  type SheetValue,
  type SyncSnapshot,
} from "./mapping.ts";

/**
 * Superfície mínima da API do Google Sheets usada pela sincronização.
 *
 * Três operações mapeiam um-para-um em `values.batchGet`, `values.batchUpdate`
 * e `values.append`. É o suficiente para tudo, e é pequeno o bastante para ser
 * substituído por um dublê nos testes.
 */
export type SheetsGateway = {
  batchGet(ranges: string[]): Promise<string[][][]>;
  batchUpdate(updates: Array<{ range: string; values: SheetValue[][] }>): Promise<void>;
  append(range: string, values: SheetValue[][]): Promise<void>;
};

export type SyncReport = {
  sessionId: string;
  reservations: number;
  rowsUpdated: number;
  rowsAppended: number;
  spotsDeactivated: number;
};

type KeyedRow = { key: string; values: SheetValue[] };

type PendingWrite = {
  updates: Array<{ range: string; values: SheetValue[][] }>;
  appends: Map<string, SheetValue[][]>;
};

function emptyWrite(): PendingWrite {
  return { updates: [], appends: new Map() };
}

function queueAppend(write: PendingWrite, tab: string, values: SheetValue[]) {
  const existing = write.appends.get(tab);
  if (existing) existing.push(values);
  else write.appends.set(tab, [values]);
}

/** Índice `chave → números de linha`, na ordem em que aparecem na planilha. */
function indexByKey(column: string[][]) {
  const index = new Map<string, number[]>();
  column.forEach((row, offset) => {
    const key = (row[0] ?? "").trim();
    if (!key) return;
    const rowNumber = offset + FIRST_DATA_ROW;
    const positions = index.get(key);
    if (positions) positions.push(rowNumber);
    else index.set(key, [rowNumber]);
  });
  return index;
}

/**
 * Escreve as linhas na posição que já ocupam, ou enfileira uma nova.
 *
 * Se a mesma chave aparecer mais de uma vez — o que só acontece se duas
 * sincronizações da mesma entidade se cruzarem no exato instante do append —
 * a primeira linha recebe o dado e as demais são neutralizadas. A planilha se
 * conserta sozinha na sincronização seguinte, sem intervenção manual.
 */
function planUpsert(
  write: PendingWrite,
  tab: string,
  width: number,
  rows: KeyedRow[],
  index: Map<string, number[]>,
  deactivateColumn?: number,
) {
  let deactivated = 0;

  for (const row of rows) {
    const positions = index.get(row.key) ?? [];
    if (positions.length === 0) {
      queueAppend(write, tab, row.values);
      continue;
    }

    write.updates.push({ range: rowRange(tab, positions[0], width), values: [row.values] });

    for (const duplicate of positions.slice(1)) {
      const neutralized = [...row.values];
      if (deactivateColumn) neutralized[deactivateColumn - 1] = ACTIVE_NO;
      write.updates.push({ range: rowRange(tab, duplicate, width), values: [neutralized] });
      deactivated += 1;
    }
  }

  return deactivated;
}

async function flush(gateway: SheetsGateway, write: PendingWrite) {
  if (write.updates.length) await gateway.batchUpdate(write.updates);
  for (const [tab, values] of write.appends) {
    if (values.length) await gateway.append(a1(tab, "A1"), values);
  }
}

/**
 * Converge a planilha para o snapshot.
 *
 * `reconcileSession` liga a reconstrução completa da turma: além de reescrever
 * o que veio no snapshot, desativa qualquer vaga daquela sessão que não exista
 * mais no Supabase. É o modo usado pelo botão "Sincronizar lista da sessão" —
 * e a razão de ele servir como recuperação operacional.
 */
export async function syncSnapshot(
  gateway: SheetsGateway,
  snapshot: SyncSnapshot,
  options: { syncedAt: string; reconcileSession?: boolean },
): Promise<SyncReport> {
  const { session, reservations } = snapshot;
  const syncedAt = options.syncedAt;

  const [sessionKeys, reservationKeys, spotRowsRead] = await gateway.batchGet([
    a1(SESSIONS_TAB, `A${FIRST_DATA_ROW}:A`),
    a1(RESERVATIONS_TAB, `A${FIRST_DATA_ROW}:A`),
    a1(SPOTS_TAB, `A${FIRST_DATA_ROW}:C`),
  ]);

  const write = emptyWrite();

  planUpsert(
    write,
    SESSIONS_TAB,
    SESSION_HEADERS.length,
    [{ key: session.id, values: sessionRow(session, syncedAt) }],
    indexByKey(sessionKeys),
  );

  planUpsert(
    write,
    RESERVATIONS_TAB,
    RESERVATION_HEADERS.length,
    reservations.map((reservation) => ({
      key: reservation.id,
      values: reservationRow(reservation, session, syncedAt),
    })),
    indexByKey(reservationKeys),
  );

  const spots = reservations.flatMap((reservation) => spotRows(reservation, session, syncedAt));
  const spotIndex = indexByKey(spotRowsRead);
  let spotsDeactivated = planUpsert(
    write,
    SPOTS_TAB,
    SPOT_HEADERS.length,
    spots,
    spotIndex,
    SPOT_COLUMN.active,
  );

  if (options.reconcileSession) {
    spotsDeactivated += planDeactivateOrphans(write, spotRowsRead, session.id, new Set(spots.map((spot) => spot.key)));
  }

  await flush(gateway, write);

  return {
    sessionId: session.id,
    reservations: reservations.length,
    rowsUpdated: write.updates.length,
    rowsAppended: [...write.appends.values()].reduce((total, rows) => total + rows.length, 0),
    spotsDeactivated,
  };
}

/**
 * Desativa vagas que pertencem à sessão na planilha mas não existem mais no
 * Supabase — uma reserva apagada por manutenção, uma linha colada à mão, um
 * resquício de importação. Só toca na coluna "Ativo": nada é apagado.
 */
function planDeactivateOrphans(
  write: PendingWrite,
  spotRowsRead: string[][],
  sessionId: string,
  knownKeys: Set<string>,
) {
  const column = columnLetter(SPOT_COLUMN.active);
  let deactivated = 0;

  spotRowsRead.forEach((row, offset) => {
    const key = (row[0] ?? "").trim();
    const rowSessionId = (row[2] ?? "").trim();
    if (!key || rowSessionId !== sessionId || knownKeys.has(key)) return;

    const rowNumber = offset + FIRST_DATA_ROW;
    write.updates.push({ range: a1(SPOTS_TAB, `${column}${rowNumber}`), values: [[ACTIVE_NO]] });
    deactivated += 1;
  });

  return deactivated;
}
