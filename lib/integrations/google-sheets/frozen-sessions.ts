/**
 * Sessões históricas congeladas na planilha.
 *
 * Catorze sessões anteriores ao início da integração (19/08/2026) ficaram fora
 * da sincronização por decisão administrativa de 09/10/2026 — ver
 * `docs/incident-2026-10-google-sheets-grid-limit.md`. Doze não aparecem em
 * nenhuma aba; duas, de 15/08/2026, aparecem com parte das reservas, e esse
 * histórico é mantido exatamente como está.
 *
 * "Congelada" quer dizer: **nenhuma sincronização lê ou escreve nada por causa
 * dessa sessão** — não cria a linha da turma, não reconstrói a lista, não
 * acrescenta reserva e não reescreve o que já existe. A checagem é por
 * `session_id` exato e fica no motor (`syncSnapshot`) e no serviço central
 * (`runSheetSyncJob`), então vale para qualquer origem: Stand-by, reagendamento,
 * cancelamento, botões manuais, confirmação de pagamento, reconciliação e job
 * pendente retomado.
 *
 * A única linha de uma sessão congelada que pode mudar é a da própria reserva
 * quando ela é reagendada para outra turma: a reserva deixa de pertencer à
 * sessão histórica, e a sincronização passa a ser a da turma nova.
 *
 * ## IDs
 *
 * Só entra aqui `session_id` completo e confirmado. Nada de prefixo, data ou
 * suposição: um id errado deixaria uma sessão sem proteção, ou bloquearia uma
 * turma normal.
 */

/** Os 14 prefixos registrados no documento do incidente. Referência, não regra. */
export const HISTORICAL_SESSION_PREFIXES = [
  "0a98cf4c",
  "0ca42ebe",
  "49a818bf",
  "4d77bf1d",
  "5589d4c6",
  "6547901a",
  "86480dee",
  "87077465",
  "8796cfff",
  "8d78dd76",
  "9b40060d",
  "c3969f2c",
  "c42e5181",
  "d47907c1",
] as const;

/**
 * `session_id` completos das sessões congeladas.
 *
 * As duas primeiras são as turmas de 15/08/2026 parcialmente presentes na
 * planilha; os ids foram lidos da própria aba `Sessões` em 12/10/2026.
 *
 * PENDENTE: o documento do incidente registra só os oito primeiros caracteres
 * das outras doze, e elas não estão na planilha nem no repositório. Os ids
 * completos precisam vir do Supabase — `pendingHistoricalPrefixes()` lista
 * quais faltam, e um teste falha se esta lista e o documento divergirem.
 */
const FROZEN_SESSION_IDS: readonly string[] = [
  "0a98cf4c-4d40-411d-987e-a383479fc2e1", // Remada do Nascer do Sol · 15/08/2026 06:00
  "87077465-49ee-4b94-b89d-aa56296aabd0", // Imersão Paranoá · 15/08/2026 12:00
];

export const FROZEN_SHEET_SESSION_IDS: ReadonlySet<string> = new Set(FROZEN_SESSION_IDS.map((id) => id.toLowerCase()));

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Comparação exata do `session_id` inteiro. Prefixo não congela nada. */
export function isFrozenSheetSession(sessionId: unknown): boolean {
  if (typeof sessionId !== "string") return false;
  const normalized = sessionId.trim().toLowerCase();
  return UUID_PATTERN.test(normalized) && FROZEN_SHEET_SESSION_IDS.has(normalized);
}

/** Prefixos documentados que ainda não têm o `session_id` completo registrado. */
export function pendingHistoricalPrefixes(): string[] {
  const known = new Set([...FROZEN_SHEET_SESSION_IDS].map((id) => id.slice(0, 8)));
  return HISTORICAL_SESSION_PREFIXES.filter((prefix) => !known.has(prefix));
}
