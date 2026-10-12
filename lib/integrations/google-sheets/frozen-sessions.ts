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
 * sessão histórica, e a sincronização passa a ser a da turma nova. A sessão
 * histórica não é reconstruída por isso, e a reserva continua com uma linha só.
 *
 * ## A lista é permanente
 *
 * São exatamente estas 14, pelo `session_id` completo. Não há regra por data,
 * por prefixo nem por faixa: um id errado deixaria uma sessão sem proteção, ou
 * bloquearia uma turma normal. A lista só muda por decisão administrativa
 * registrada no documento do incidente — e um teste trava os 14 ids, então
 * acrescentar ou retirar um exige mudar o teste junto, de propósito.
 *
 * Os ids vieram do Supabase de produção em 12/10/2026, pela consulta somente
 * leitura `supabase/diagnostics/google_sheets_historical_sessions.sql`, e batem
 * um a um com os 14 prefixos registrados no incidente.
 */
const FROZEN_SESSION_IDS: readonly string[] = [
  "49a818bf-297a-4361-8d41-02e0491006b3",
  "4d77bf1d-fe49-4c7b-b582-29a95e3f8b7b",
  "8796cfff-0172-400e-b271-94b6ee935657",
  "9b40060d-8022-476e-aa68-c10e54e2f7a7",
  "8d78dd76-739b-4821-870b-135be377aaaf",
  "5589d4c6-df72-4f86-a6e8-42ac9aa38000",
  "c3969f2c-c0fc-4342-936a-67c9e1e5043a",
  "0a98cf4c-4d40-411d-987e-a383479fc2e1", // Remada do Nascer do Sol · 15/08/2026 06:00 — parcialmente presente na planilha
  "87077465-49ee-4b94-b89d-aa56296aabd0", // Imersão Paranoá · 15/08/2026 12:00 — parcialmente presente na planilha
  "c42e5181-83d6-4323-854d-4acd11a2e204",
  "6547901a-ebd6-4306-8f24-7b50355812dd",
  "86480dee-c466-4779-be07-938f67349dde",
  "d47907c1-9f09-49b1-bc11-45ec4b7eb359",
  "0ca42ebe-3732-4fa4-bbcf-26af6c953835",
];

export const FROZEN_SHEET_SESSION_IDS: ReadonlySet<string> = new Set(FROZEN_SESSION_IDS.map((id) => id.toLowerCase()));

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Comparação exata do `session_id` inteiro. Prefixo não congela nada. */
export function isFrozenSheetSession(sessionId: unknown): boolean {
  if (typeof sessionId !== "string") return false;
  const normalized = sessionId.trim().toLowerCase();
  return UUID_PATTERN.test(normalized) && FROZEN_SHEET_SESSION_IDS.has(normalized);
}
