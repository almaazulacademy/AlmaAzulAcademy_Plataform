/**
 * Fórmulas da aba `Lista da Sessão`.
 *
 * A lista não é gravada pela sincronização: ela é derivada, ao vivo, da aba
 * técnica `Vagas Confirmadas`. Isso garante que escolher outra sessão no
 * dropdown não dependa de nenhuma nova chamada ao servidor, e que uma vaga
 * desativada suma da turma no mesmo instante.
 *
 * Duas restrições guiaram a escrita destas fórmulas:
 *
 *   1. Nada de literais de matriz (`{a,b}`): o separador de colunas dentro de
 *      chaves muda com o idioma da planilha. `CHOOSECOLS` faz o mesmo recorte
 *      usando só vírgulas, que a API sempre aceita.
 *
 *   2. Nada de `LET`/`XLOOKUP` onde `INDEX`/`MATCH` resolvem. Menos superfície
 *      para incompatibilidade em contas antigas.
 */

import {
  columnLetter,
  LIST_MAX_SPOTS,
  LIST_SELECTOR_CELL,
  LIST_SESSION_ID_CELL,
  SESSION_COLUMN,
  SESSIONS_TAB,
  SPOT_COLUMN,
  SPOTS_TAB,
} from "./schema.ts";

/** "J1" → "$J$1": referência travada, para a fórmula sobreviver a arrastar. */
function absolute(cell: string) {
  const match = /^([A-Z]+)(\d+)$/.exec(cell);
  return match ? `$${match[1]}$${match[2]}` : cell;
}

function quoted(tab: string) {
  return `'${tab.replace(/'/g, "''")}'`;
}

function wholeColumn(tab: string, position: number) {
  const letter = columnLetter(position);
  return `${quoted(tab)}!$${letter}:$${letter}`;
}

/**
 * Lê uma coluna da aba `Sessões` para a sessão escolhida no dropdown.
 * O casamento é feito pelo rótulo legível, e não pelo id, porque é o rótulo que
 * a pessoa vê e escolhe.
 */
export function sessionLookupFormula(position: number) {
  const source = wholeColumn(SESSIONS_TAB, position);
  const labels = wholeColumn(SESSIONS_TAB, SESSION_COLUMN.label);
  return `=IFERROR(INDEX(${source},MATCH(${absolute(LIST_SELECTOR_CELL)},${labels},0)),"")`;
}

/** Resolve o rótulo escolhido para o session_id técnico. */
export function sessionIdFormula() {
  return sessionLookupFormula(SESSION_COLUMN.sessionId);
}

/**
 * Total arrecadado da turma.
 *
 * Soma a coluna "Valor pago" das vagas ativas da sessão. Como o valor só é
 * gravado na primeira vaga de cada reserva, uma reserva de três pessoas por
 * R$ 210 entra uma vez — e não três.
 */
export function sessionRevenueFormula() {
  const values = wholeColumn(SPOTS_TAB, SPOT_COLUMN.totalPaid);
  const sessions = wholeColumn(SPOTS_TAB, SPOT_COLUMN.sessionId);
  const active = wholeColumn(SPOTS_TAB, SPOT_COLUMN.active);
  return `=SUMIFS(${values},${sessions},${absolute(LIST_SESSION_ID_CELL)},${active},"SIM")`;
}

/**
 * Corpo da lista: as pessoas da sessão escolhida, em ordem de reserva e, dentro
 * de cada reserva, em ordem de vaga.
 *
 * `displayColumns` são as colunas visíveis; `sortColumns` entram no recorte só
 * para ordenar e são cortadas por `ARRAY_CONSTRAIN` antes de aparecer.
 */
export function sessionListFormula() {
  const displayColumns = [6, 7, 5, 10, 9, 8, 11];
  const sortColumns = [SPOT_COLUMN.order, SPOT_COLUMN.participantIndex];
  const picked = [...displayColumns, ...sortColumns];

  const width = columnLetter(14);
  const source = `${quoted(SPOTS_TAB)}!$A:$${width}`;
  const sessions = wholeColumn(SPOTS_TAB, SPOT_COLUMN.sessionId);
  const active = wholeColumn(SPOTS_TAB, SPOT_COLUMN.active);

  const selection = `CHOOSECOLS(${source},${picked.join(",")})`;
  const condition = `(${sessions}=${absolute(LIST_SESSION_ID_CELL)})*(${active}="SIM")`;
  const orderBy = `${displayColumns.length + 1},TRUE,${displayColumns.length + 2},TRUE`;

  return `=IFERROR(ARRAY_CONSTRAIN(SORT(FILTER(${selection},${condition}),${orderBy}),${LIST_MAX_SPOTS},${displayColumns.length}),"")`;
}
