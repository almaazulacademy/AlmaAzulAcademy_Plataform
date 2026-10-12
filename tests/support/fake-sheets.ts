/**
 * Planilha falsa em memória, compartilhada pelas suítes da integração.
 *
 * Nenhum teste fala com o Google. O dublê implementa o mesmo contrato de três
 * operações que o cliente real, o que permite verificar o resultado final na
 * "planilha" célula a célula — e garante que a CI jamais escreva em uma planilha
 * de verdade.
 */

import { httpError } from "../../lib/integrations/google-sheets/errors.ts";
import type { SheetValue } from "../../lib/integrations/google-sheets/mapping.ts";
import {
  RESERVATION_HEADERS,
  RESERVATIONS_TAB,
  SESSION_HEADERS,
  SESSIONS_TAB,
  SPOT_HEADERS,
  SPOTS_TAB,
} from "../../lib/integrations/google-sheets/schema.ts";
import type { SheetsGateway } from "../../lib/integrations/google-sheets/sync.ts";

const COLUMN_INDEX = (letters: string) =>
  [...letters].reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 64), 0) - 1;

function parseRange(range: string) {
  const match = /^'(.+)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d*))?$/.exec(range);
  if (!match) throw new Error(`Intervalo não reconhecido: ${range}`);
  return {
    tab: match[1].replace(/''/g, "'"),
    startColumn: COLUMN_INDEX(match[2]),
    startRow: Number(match[3]) - 1,
    endColumn: match[4] ? COLUMN_INDEX(match[4]) : COLUMN_INDEX(match[2]),
  };
}

export type FakeSheets = SheetsGateway & {
  grid(tab: string): SheetValue[][];
  headerRow(tab: string): SheetValue[];
  dataRows(tab: string): SheetValue[][];
  failNextCalls(count: number): void;
  /** Tamanho da grade da aba, em linhas — o `gridProperties.rowCount` do Google. */
  rowCount(tab: string): number;
  setRowCount(tab: string, rows: number): void;
  ensureRowsCalls(): number;
};

/** O setup cria as abas de dados com 2000 linhas. */
export const DEFAULT_ROW_COUNT = 2000;

const SEEDED_TABS: Array<readonly [string, readonly string[]]> = [
  [RESERVATIONS_TAB, RESERVATION_HEADERS],
  [SESSIONS_TAB, SESSION_HEADERS],
  [SPOTS_TAB, SPOT_HEADERS],
];

export function createFakeSheets(): FakeSheets {
  const tabs = new Map<string, SheetValue[][]>();
  const rowCounts = new Map<string, number>();
  let failures = 0;
  let ensureCalls = 0;
  const rowCount = (tab: string) => rowCounts.get(tab) ?? DEFAULT_ROW_COUNT;

  // A planilha falsa nasce como o setup deixa a real: cabeçalho na linha 1 e
  // nenhuma linha de dado. Sem isso os testes não conseguiriam ver o cabeçalho
  // sendo empurrado para baixo — que foi exatamente o bug de produção.
  for (const [tab, headers] of SEEDED_TABS) tabs.set(tab, [[...headers]]);

  const grid = (tab: string) => {
    const existing = tabs.get(tab);
    if (existing) return existing;
    const created: SheetValue[][] = [];
    tabs.set(tab, created);
    return created;
  };

  const guard = () => {
    if (failures > 0) {
      failures -= 1;
      throw new Error("google indisponível");
    }
  };

  const lastUsedRow = (tab: string) => {
    const rows = grid(tab);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if ((rows[index] ?? []).some((cell) => cell !== "" && cell !== undefined)) return index;
    }
    return -1;
  };

  return {
    grid,
    headerRow: (tab: string) => grid(tab)[0] ?? [],
    dataRows: (tab: string) => grid(tab).slice(1).filter((row) => (row ?? []).some((cell) => cell !== "")),
    failNextCalls: (count: number) => { failures = count; },
    rowCount,
    setRowCount: (tab: string, rows: number) => { rowCounts.set(tab, rows); },
    ensureRowsCalls: () => ensureCalls,

    async ensureRows(requirements) {
      guard();
      ensureCalls += 1;
      for (const { tab, minRows } of requirements) {
        if (rowCount(tab) < minRows) rowCounts.set(tab, minRows);
      }
    },

    async batchGet(ranges: string[]) {
      guard();
      return ranges.map((range) => {
        const { tab, startColumn, startRow, endColumn } = parseRange(range);
        const rows = grid(tab);
        const last = lastUsedRow(tab);
        const slice: string[][] = [];
        for (let index = startRow; index <= last; index += 1) {
          const row = rows[index] ?? [];
          slice.push(row.slice(startColumn, endColumn + 1).map((cell) => (cell === undefined ? "" : String(cell))));
        }
        return slice;
      });
    },

    async batchUpdate(updates) {
      guard();
      // Como o Google: escrever fora da grade recusa o lote inteiro com 400
      // ("exceeds grid limits") e nada é gravado.
      for (const update of updates) {
        const { tab, startRow } = parseRange(update.range);
        if (startRow + update.values.length > rowCount(tab)) throw httpError(400);
      }
      for (const update of updates) {
        const { tab, startColumn, startRow } = parseRange(update.range);
        const rows = grid(tab);
        update.values.forEach((values, rowOffset) => {
          const target = startRow + rowOffset;
          while (rows.length <= target) rows.push([]);
          values.forEach((value, columnOffset) => {
            rows[target][startColumn + columnOffset] = value;
          });
        });
      }
    },
  };
}
