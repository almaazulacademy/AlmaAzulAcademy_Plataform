/**
 * Fórmulas da aba `Lista da Sessão`.
 *
 * A lista não é gravada pela sincronização: ela é derivada, ao vivo, da aba
 * técnica `Vagas Confirmadas`. Isso garante que escolher outra sessão no
 * dropdown não dependa de nenhuma nova chamada ao servidor, e que uma vaga
 * desativada suma da turma no mesmo instante.
 *
 * ## O separador de argumentos depende do idioma da planilha
 *
 * `valueInputOption=USER_ENTERED` faz a API interpretar a fórmula exatamente
 * como se alguém a tivesse digitado na interface — e na interface o separador
 * segue o idioma. Em `pt_BR`, onde a vírgula é separador decimal, argumentos são
 * separados por ponto e vírgula.
 *
 * A primeira versão gravou tudo com vírgula. A API aceitou (a célula virou uma
 * fórmula de verdade), mas nenhuma delas avaliava: `effectiveValue` voltava
 * `errorValue: ERROR` e a planilha exibia `#ERROR!`. Ler só com
 * `valueRenderOption=FORMULA` não revela isso — a fórmula está lá, ela só não
 * calcula. Por isso o separador agora vem do locale real da planilha.
 *
 * Continua valendo a regra de não usar literais de matriz (`{a,b}`): dentro de
 * chaves o separador de colunas também muda com o idioma, e `CHOOSECOLS` faz o
 * mesmo recorte sem esse risco. Nomes de função não são traduzidos pelo Google
 * Sheets em nenhum idioma, então só o separador precisa de tratamento.
 */

import {
  columnLetter,
  LIST_FIRST_DATA_ROW,
  LIST_MAX_SPOTS,
  LIST_SELECTOR_CELL,
  LIST_SESSION_ID_CELL,
  SESSION_COLUMN,
  SESSIONS_TAB,
  SPOT_COLUMN,
  SPOTS_TAB,
} from "./schema.ts";

/**
 * Idiomas que usam ponto como separador decimal e, portanto, vírgula como
 * separador de argumentos. Todo o resto — incluindo `pt_BR` — usa ponto e
 * vírgula.
 */
const COMMA_LOCALE_PREFIXES = ["en", "ja", "ko", "zh", "th", "he", "iw", "ms"];

/** Separador usado pela planilha operacional, que o setup cria sempre em pt_BR. */
export const DEFAULT_ARGUMENT_SEPARATOR = ";";

export function argumentSeparatorFor(locale: string | undefined | null) {
  const normalized = (locale ?? "").trim().toLowerCase().replace("-", "_");
  if (!normalized) return DEFAULT_ARGUMENT_SEPARATOR;
  const language = normalized.split("_")[0];
  return COMMA_LOCALE_PREFIXES.includes(language) ? "," : DEFAULT_ARGUMENT_SEPARATOR;
}

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

/** Junta argumentos com o separador do idioma da planilha. */
function args(separator: string, ...parts: string[]) {
  return parts.join(separator);
}

/**
 * Lê uma coluna da aba `Sessões` para a sessão escolhida no dropdown.
 * O casamento é feito pelo rótulo legível, e não pelo id, porque é o rótulo que
 * a pessoa vê e escolhe.
 */
export function sessionLookupFormula(position: number, separator = DEFAULT_ARGUMENT_SEPARATOR) {
  const source = wholeColumn(SESSIONS_TAB, position);
  const labels = wholeColumn(SESSIONS_TAB, SESSION_COLUMN.label);
  const match = `MATCH(${args(separator, absolute(LIST_SELECTOR_CELL), labels, "0")})`;
  const index = `INDEX(${args(separator, source, match)})`;
  return `=IFERROR(${args(separator, index, '""')})`;
}

/** Resolve o rótulo escolhido para o session_id técnico. */
export function sessionIdFormula(separator = DEFAULT_ARGUMENT_SEPARATOR) {
  return sessionLookupFormula(SESSION_COLUMN.sessionId, separator);
}

/**
 * Total arrecadado da turma.
 *
 * Soma a coluna "Valor pago" das vagas ativas da sessão. Como o valor só é
 * gravado na primeira vaga de cada reserva, uma reserva de três pessoas por
 * R$ 210 entra uma vez — e não três.
 */
export function sessionRevenueFormula(separator = DEFAULT_ARGUMENT_SEPARATOR) {
  const values = wholeColumn(SPOTS_TAB, SPOT_COLUMN.totalPaid);
  const sessions = wholeColumn(SPOTS_TAB, SPOT_COLUMN.sessionId);
  const active = wholeColumn(SPOTS_TAB, SPOT_COLUMN.active);
  return `=SUMIFS(${args(separator, values, sessions, absolute(LIST_SESSION_ID_CELL), active, '"SIM"')})`;
}

/**
 * Corpo da lista: as pessoas da sessão escolhida, em ordem de reserva e, dentro
 * de cada reserva, em ordem de vaga.
 *
 * `displayColumns` são as colunas visíveis; `sortColumns` entram no recorte só
 * para ordenar e são cortadas por `ARRAY_CONSTRAIN` antes de aparecer.
 */
export function sessionListFormula(separator = DEFAULT_ARGUMENT_SEPARATOR) {
  const displayColumns = [6, 7, 5, 10, 9, 8, 11];
  const sortColumns = [SPOT_COLUMN.order, SPOT_COLUMN.participantIndex];
  const picked = [...displayColumns, ...sortColumns];

  const width = columnLetter(14);
  const source = `${quoted(SPOTS_TAB)}!$A:$${width}`;
  const sessions = wholeColumn(SPOTS_TAB, SPOT_COLUMN.sessionId);
  const active = wholeColumn(SPOTS_TAB, SPOT_COLUMN.active);

  const selection = `CHOOSECOLS(${args(separator, source, ...picked.map(String))})`;
  const condition = `(${sessions}=${absolute(LIST_SESSION_ID_CELL)})*(${active}="SIM")`;
  const filtered = `FILTER(${args(separator, selection, condition)})`;
  const sorted = `SORT(${args(
    separator,
    filtered,
    String(displayColumns.length + 1),
    "TRUE",
    String(displayColumns.length + 2),
    "TRUE",
  )})`;
  const constrained = `ARRAY_CONSTRAIN(${args(separator, sorted, String(LIST_MAX_SPOTS), String(displayColumns.length))})`;
  return `=IFERROR(${args(separator, constrained, '""')})`;
}

/** Toda célula da `Lista da Sessão` que recebe fórmula, para setup e verificação. */
export function listFormulaCells(separator = DEFAULT_ARGUMENT_SEPARATOR) {
  return [
    { cell: LIST_SESSION_ID_CELL, formula: sessionIdFormula(separator) },
    { cell: "B3", formula: sessionLookupFormula(2, separator) },
    { cell: "D3", formula: sessionLookupFormula(3, separator) },
    { cell: "F3", formula: sessionLookupFormula(4, separator) },
    { cell: "H3", formula: sessionLookupFormula(8, separator) },
    { cell: "B4", formula: sessionLookupFormula(5, separator) },
    { cell: "D4", formula: sessionLookupFormula(6, separator) },
    { cell: "F4", formula: sessionLookupFormula(7, separator) },
    { cell: "H4", formula: sessionRevenueFormula(separator) },
    { cell: `B${LIST_FIRST_DATA_ROW}`, formula: sessionListFormula(separator) },
  ];
}
