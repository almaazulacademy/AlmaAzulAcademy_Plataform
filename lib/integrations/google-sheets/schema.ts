/**
 * Estrutura da planilha operacional do Google Sheets.
 *
 * Um único lugar descreve abas, cabeçalhos e posições de coluna. O script de
 * setup cria a planilha a partir daqui e a sincronização escreve a partir daqui
 * — então não existe a possibilidade de os dois divergirem em silêncio.
 *
 * Sem imports de aplicação: este módulo é consumido pelo runtime do Next, pelos
 * testes com `node --test` e pelo script de setup em linha de comando.
 */

export const SPREADSHEET_LOCALE = "pt_BR";
export const SPREADSHEET_TIME_ZONE = "America/Sao_Paulo";

export const RESERVATIONS_TAB = "Reservas do Site";
export const SESSIONS_TAB = "Sessões";
export const SPOTS_TAB = "Vagas Confirmadas";
export const LIST_TAB = "Lista da Sessão";

/** Valor gravado na coluna "Origem". Reservas vindas do site nascem com este selo. */
export const SITE_ORIGIN = "Site";

/** Marcadores da coluna "Ativo" da aba técnica de vagas. */
export const ACTIVE_YES = "SIM";
export const ACTIVE_NO = "NÃO";

/**
 * Quantas vagas a `Lista da Sessão` comporta. A Imersão Paranoá usa 28; a folga
 * até 40 evita ter que refazer a planilha quando uma sessão maior aparecer.
 */
export const LIST_MAX_SPOTS = 40;

/** Primeira linha de dados da `Lista da Sessão` (as cinco primeiras são cabeçalho). */
export const LIST_FIRST_DATA_ROW = 6;

/** Todas as abas têm uma linha de cabeçalho; os dados começam na linha 2. */
export const FIRST_DATA_ROW = 2;

export const RESERVATION_HEADERS = [
  "reservation_id",
  "Código da reserva",
  "session_id",
  "Experiência",
  "Data",
  "Horário",
  "Responsável",
  "WhatsApp",
  "Pessoas",
  "Valor total pago",
  "Status da reserva",
  "Status do pagamento",
  "Forma de pagamento",
  "Origem",
  "Última sincronização",
] as const;

export const SESSION_HEADERS = [
  "session_id",
  "Experiência",
  "Data",
  "Horário",
  "Capacidade",
  "Confirmados",
  "Vagas restantes",
  "Status da sessão",
  "Última sincronização",
  "Rótulo",
] as const;

export const SPOT_HEADERS = [
  "spot_key",
  "reservation_id",
  "session_id",
  "Vaga da reserva",
  "Código da reserva",
  "Nome",
  "WhatsApp",
  "Valor pago",
  "Forma de pagamento",
  "Status da reserva",
  "Observações",
  "Ativo",
  "Ordem",
  "Última sincronização",
] as const;

export const LIST_HEADERS = [
  "Vaga",
  "Nome",
  "WhatsApp",
  "Código da reserva",
  "Status",
  "Forma de pagamento",
  "Valor pago",
  "Observações",
] as const;

/**
 * Posições 1-based das colunas usadas por código. Nomear a posição evita que um
 * "coluna 12" solto no meio da sincronização se perca quando a planilha evoluir.
 */
export const RESERVATION_COLUMN = {
  reservationId: 1,
  publicCode: 2,
  sessionId: 3,
  syncedAt: 15,
} as const;

export const SESSION_COLUMN = {
  sessionId: 1,
  label: 10,
} as const;

export const SPOT_COLUMN = {
  spotKey: 1,
  reservationId: 2,
  sessionId: 3,
  participantIndex: 4,
  totalPaid: 8,
  active: 12,
  order: 13,
} as const;

/** Colunas técnicas escondidas em cada aba (1-based). */
export const HIDDEN_COLUMNS: Record<string, number[]> = {
  [RESERVATIONS_TAB]: [RESERVATION_COLUMN.reservationId, RESERVATION_COLUMN.sessionId],
  [SESSIONS_TAB]: [SESSION_COLUMN.sessionId, SESSION_COLUMN.label],
  [LIST_TAB]: [10],
};

/** A aba de vagas é insumo da `Lista da Sessão`; ninguém precisa lê-la à mão. */
export const HIDDEN_TABS = [SPOTS_TAB];

export const TAB_WIDTHS: Record<string, number> = {
  [RESERVATIONS_TAB]: RESERVATION_HEADERS.length,
  [SESSIONS_TAB]: SESSION_HEADERS.length,
  [SPOTS_TAB]: SPOT_HEADERS.length,
  [LIST_TAB]: 10,
};

export const TAB_HEADERS: Record<string, readonly string[]> = {
  [RESERVATIONS_TAB]: RESERVATION_HEADERS,
  [SESSIONS_TAB]: SESSION_HEADERS,
  [SPOTS_TAB]: SPOT_HEADERS,
};

/** Célula onde a `Lista da Sessão` guarda a sessão escolhida no dropdown. */
export const LIST_SELECTOR_CELL = "B2";

/** Célula técnica escondida que resolve o rótulo escolhido para o session_id. */
export const LIST_SESSION_ID_CELL = "J1";

/** Converte uma posição 1-based em letra de coluna: 1 → A, 27 → AA. */
export function columnLetter(position: number) {
  let remaining = Math.max(1, Math.trunc(position));
  let letters = "";
  while (remaining > 0) {
    const rest = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    remaining = Math.trunc((remaining - 1 - rest) / 26);
  }
  return letters;
}

/** Referência A1 completa, com o nome da aba sempre entre aspas simples. */
export function a1(tab: string, range: string) {
  return `'${tab.replace(/'/g, "''")}'!${range}`;
}

/** Intervalo de uma linha inteira de dados de uma aba. */
export function rowRange(tab: string, rowNumber: number, width: number) {
  return a1(tab, `A${rowNumber}:${columnLetter(width)}${rowNumber}`);
}

/** Intervalo de uma coluna inteira de dados, do primeiro registro em diante. */
export function columnRange(tab: string, position: number) {
  const letter = columnLetter(position);
  return a1(tab, `${letter}${FIRST_DATA_ROW}:${letter}`);
}
