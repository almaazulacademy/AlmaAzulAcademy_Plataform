/**
 * O conteúdo de um evento basta para o e-mail de confirmação?
 *
 * O e-mail de evento (`lib/reservations/event-email.ts`) é montado do
 * `editorial_content`. Sem estes itens ele ficaria incompleto — e a venda não
 * pode abrir: `POST /api/reservations` recusa a reserva de um evento cujo
 * conteúdo não passa nesta conferência, e o envio de um e-mail incompleto fica
 * pendente em vez de sair o e-mail genérico de remada.
 *
 * Só o que é essencial para participar com segurança é exigido: programação,
 * chegada, prazo de cancelamento, o que levar, as orientações de segurança e o
 * texto da política. Alimentação, clima, brindes e outros benefícios são da
 * edição: entram no e-mail quando existem (`emailInfoItems`), nunca são exigidos.
 *
 * Módulo puro, sem imports de aplicação: é lido pelo Next e pelos testes.
 */

import type { EventContent, EventInfoItem } from "./editorial.ts";

/** Os textos de `info.items` que o e-mail do evento exige, por `id`. */
export const EVENT_EMAIL_INFO_IDS = ["o-que-levar", "seguranca", "cancelamento"] as const;

/**
 * Orientações que entram no e-mail sem precisar marcar `email: true`, na ordem
 * do conteúdo. Só entram se existirem e estiverem confirmadas. Qualquer outro
 * item entra com `email: true`; um destes sai com `email: false`.
 */
export const EVENT_EMAIL_DEFAULT_INFO_IDS = ["o-que-levar", "seguranca", "alimentacao", "clima"] as const;

/** Itens que o e-mail mostra em lugar próprio: a chegada nas linhas do resumo, a política no fim. */
const EMAIL_OWN_PLACE_IDS = ["chegada", "cancelamento"];

export function eventEmailMissing(content: EventContent): string[] {
  const missing: string[] = [];
  if (!content.program.items.length) missing.push("programação");
  if (!content.arrival) missing.push("início e tolerância de chegada (event.arrival)");
  if (!content.cancellation) missing.push("prazo de cancelamento (event.cancellation)");
  for (const id of EVENT_EMAIL_INFO_IDS) {
    const item = content.info.items.find((entry) => entry.id === id);
    if (!item || item.pending || !item.body) missing.push(`texto "${id}" confirmado`);
  }
  return missing;
}

export function isEventEmailReady(content: EventContent) {
  return eventEmailMissing(content).length === 0;
}

/**
 * As orientações do e-mail do ingresso, na ordem do conteúdo e com o título do
 * próprio conteúdo: nada da edição fica fixo no código.
 */
export function emailInfoItems(content: EventContent): EventInfoItem[] {
  return content.info.items.filter((item) => {
    if (item.pending || !item.body) return false;
    if (item.id && EMAIL_OWN_PLACE_IDS.includes(item.id)) return false;
    if (item.email !== null) return item.email;
    return Boolean(item.id && (EVENT_EMAIL_DEFAULT_INFO_IDS as readonly string[]).includes(item.id));
  });
}
