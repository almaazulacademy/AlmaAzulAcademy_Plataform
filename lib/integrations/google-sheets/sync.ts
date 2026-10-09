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
 *
 * ## Por que não existe `append` aqui
 *
 * A primeira versão usava `values.append` com `insertDataOption=INSERT_ROWS`.
 * Em produção isso inseriu as linhas *acima* do cabeçalho em duas das três
 * abas: `Sessões` ficou com o dado na linha 1 e o cabeçalho na linha 2, e
 * `Reservas do Site` acumulou cinco registros antes do cabeçalho. O `append`
 * decide sozinho onde fica a "tabela" dentro do intervalo informado, e essa
 * heurística não é algo em que valha a pena confiar para uma planilha
 * operacional.
 *
 * Agora a posição de cada linha é calculada aqui, a partir da leitura que já
 * fazemos da coluna-chave, e escrita com um intervalo explícito. A linha 1 é
 * inalcançável por construção — `assertDataRow` recusa qualquer destino acima
 * da primeira linha de dados.
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
import { GoogleSheetsError } from "./errors.ts";
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
 * Leitura e escrita mapeiam um-para-um em `values.batchGet` e
 * `values.batchUpdate`. Nenhuma delas move linhas: toda escrita vai para um
 * intervalo que este módulo calculou.
 *
 * `ensureRows` existe porque escrever em intervalo explícito, ao contrário do
 * `append`, **não aumenta a grade**: a aba nasce com 2000 linhas e, quando a
 * `Vagas Confirmadas` encheu, o Google passou a recusar o lote inteiro com 400
 * ("exceeds grid limits") — e nenhuma reserva nova chegava à planilha.
 */
export type SheetsGateway = {
  batchGet(ranges: string[]): Promise<string[][][]>;
  /**
   * Garante que cada aba tem pelo menos `minRows` linhas na grade, acrescentando
   * linhas vazias **no fim** quando falta. Nunca move nem apaga linha existente.
   */
  ensureRows(requirements: RowRequirement[]): Promise<void>;
  batchUpdate(updates: Array<{ range: string; values: SheetValue[][] }>): Promise<void>;
};

export type RowRequirement = { tab: string; minRows: number };

/**
 * Folga acrescentada quando uma aba precisa crescer. Evita pagar uma chamada de
 * estrutura a cada reserva nova logo depois de a grade encher.
 */
export const GRID_GROWTH_MARGIN = 500;

export type GridSheet = { properties?: { sheetId?: number; title?: string; gridProperties?: { rowCount?: number } } };

/**
 * Quantas linhas acrescentar ao fim de cada aba para caber `minRows`. Puro, para
 * ser testado sem rede. Aba ausente é erro: escrever nela falharia de qualquer
 * jeito, e aqui o código já diz o porquê.
 */
export function planGridGrowth(sheets: GridSheet[], requirements: RowRequirement[], margin = GRID_GROWTH_MARGIN) {
  const growth: Array<{ sheetId: number; length: number }> = [];
  for (const { tab, minRows } of requirements) {
    const properties = sheets.find((sheet) => sheet.properties?.title === tab)?.properties;
    const sheetId = properties?.sheetId;
    const rowCount = properties?.gridProperties?.rowCount;
    if (typeof sheetId !== "number" || typeof rowCount !== "number") {
      throw new GoogleSheetsError("SHEET_TAB_MISSING", false);
    }
    if (rowCount < minRows) growth.push({ sheetId, length: minRows - rowCount + margin });
  }
  return growth;
}

export type SyncReport = {
  sessionId: string;
  reservations: number;
  rowsUpdated: number;
  rowsAppended: number;
  spotsDeactivated: number;
};

type KeyedRow = { key: string; values: SheetValue[] };

type SheetPlan = {
  updates: Array<{ range: string; values: SheetValue[][] }>;
  appended: number;
};

/**
 * Onde cada chave já mora e qual é a próxima linha livre da aba.
 * `nextRow` nunca é menor que `FIRST_DATA_ROW`, mesmo com a aba vazia.
 */
type TabCursor = {
  index: Map<string, number[]>;
  nextRow: number;
};

/**
 * Invariante central desta correção: nada é escrito na linha do cabeçalho.
 * Se algum cálculo de posição regredir, a sincronização falha aqui em vez de
 * corromper a planilha em silêncio.
 */
function assertDataRow(rowNumber: number, tab: string) {
  if (!Number.isInteger(rowNumber) || rowNumber < FIRST_DATA_ROW) {
    throw new Error(`HEADER_ROW_WRITE_BLOCKED:${tab}:${rowNumber}`);
  }
  return rowNumber;
}

/**
 * Índice `chave → números de linha` a partir da coluna-chave lida da planilha.
 *
 * O `batchGet` corta as linhas vazias do fim, então o comprimento devolvido é
 * exatamente a extensão usada da aba — e a primeira linha livre vem dele.
 */
function readCursor(column: string[][]): TabCursor {
  const index = new Map<string, number[]>();
  column.forEach((row, offset) => {
    const key = (row[0] ?? "").trim();
    if (!key) return;
    const rowNumber = offset + FIRST_DATA_ROW;
    const positions = index.get(key);
    if (positions) positions.push(rowNumber);
    else index.set(key, [rowNumber]);
  });
  return { index, nextRow: FIRST_DATA_ROW + column.length };
}

/**
 * Escreve as linhas na posição que já ocupam, ou na primeira linha livre.
 *
 * Se a mesma chave aparecer mais de uma vez — linha colada à mão, ou duas
 * sincronizações que se cruzaram — a primeira recebe o dado e as demais são
 * neutralizadas. A planilha se conserta sozinha na sincronização seguinte,
 * sem intervenção manual e sem apagar nada.
 */
function planUpsert(
  plan: SheetPlan,
  tab: string,
  width: number,
  rows: KeyedRow[],
  cursor: TabCursor,
  deactivateColumn?: number,
) {
  let deactivated = 0;

  for (const row of rows) {
    const positions = cursor.index.get(row.key) ?? [];

    if (positions.length === 0) {
      const target = assertDataRow(cursor.nextRow, tab);
      plan.updates.push({ range: rowRange(tab, target, width), values: [row.values] });
      // Registra a posição recém-ocupada: se a mesma chave voltar neste mesmo
      // lote, ela atualiza a linha em vez de consumir outra.
      cursor.index.set(row.key, [target]);
      cursor.nextRow = target + 1;
      plan.appended += 1;
      continue;
    }

    plan.updates.push({
      range: rowRange(tab, assertDataRow(positions[0], tab), width),
      values: [row.values],
    });

    for (const duplicate of positions.slice(1)) {
      const neutralized = [...row.values];
      if (deactivateColumn) neutralized[deactivateColumn - 1] = ACTIVE_NO;
      plan.updates.push({
        range: rowRange(tab, assertDataRow(duplicate, tab), width),
        values: [neutralized],
      });
      deactivated += 1;
    }
  }

  return deactivated;
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

  const plan: SheetPlan = { updates: [], appended: 0 };
  const sessionCursor = readCursor(sessionKeys);
  const reservationCursor = readCursor(reservationKeys);
  const spotCursor = readCursor(spotRowsRead);
  const cursors: Array<readonly [string, TabCursor, number]> = [
    [SESSIONS_TAB, sessionCursor, sessionCursor.nextRow],
    [RESERVATIONS_TAB, reservationCursor, reservationCursor.nextRow],
    [SPOTS_TAB, spotCursor, spotCursor.nextRow],
  ];

  planUpsert(
    plan,
    SESSIONS_TAB,
    SESSION_HEADERS.length,
    [{ key: session.id, values: sessionRow(session, syncedAt) }],
    sessionCursor,
  );

  planUpsert(
    plan,
    RESERVATIONS_TAB,
    RESERVATION_HEADERS.length,
    reservations.map((reservation) => ({
      key: reservation.id,
      values: reservationRow(reservation, session, syncedAt),
    })),
    reservationCursor,
  );

  const spots = reservations.flatMap((reservation) => spotRows(reservation, session, syncedAt));
  let spotsDeactivated = planUpsert(
    plan,
    SPOTS_TAB,
    SPOT_HEADERS.length,
    spots,
    spotCursor,
    SPOT_COLUMN.active,
  );

  if (options.reconcileSession) {
    spotsDeactivated += planDeactivateOrphans(plan, spotRowsRead, session.id, new Set(spots.map((spot) => spot.key)));
  }

  // Só as abas que ganharam linha nova precisam de grade: quem apenas reescreve
  // linhas existentes não paga a chamada extra ao Google.
  const requirements: RowRequirement[] = cursors
    .filter(([, cursor, firstFreeRow]) => cursor.nextRow > firstFreeRow)
    .map(([tab, cursor]) => ({ tab, minRows: cursor.nextRow - 1 }));
  if (requirements.length) await gateway.ensureRows(requirements);

  if (plan.updates.length) await gateway.batchUpdate(plan.updates);

  return {
    sessionId: session.id,
    reservations: reservations.length,
    rowsUpdated: plan.updates.length - plan.appended,
    rowsAppended: plan.appended,
    spotsDeactivated,
  };
}

/**
 * Desativa vagas que pertencem à sessão na planilha mas não existem mais no
 * Supabase — uma reserva apagada por manutenção, uma linha colada à mão, um
 * resquício de importação. Só toca na coluna "Ativo": nada é apagado.
 */
function planDeactivateOrphans(
  plan: SheetPlan,
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

    const rowNumber = assertDataRow(offset + FIRST_DATA_ROW, SPOTS_TAB);
    plan.updates.push({ range: a1(SPOTS_TAB, `${column}${rowNumber}`), values: [[ACTIVE_NO]] });
    deactivated += 1;
  });

  return deactivated;
}
