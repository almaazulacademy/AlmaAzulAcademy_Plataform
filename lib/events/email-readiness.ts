/**
 * O conteúdo de um evento basta para o e-mail de confirmação?
 *
 * O e-mail de evento (`lib/reservations/event-email.ts`) é montado do
 * `editorial_content`. Sem estes itens ele ficaria incompleto — e a venda não
 * pode abrir: `POST /api/reservations` recusa a reserva de um evento cujo
 * conteúdo não passa nesta conferência, e o envio de um e-mail incompleto fica
 * pendente em vez de sair o e-mail genérico de remada.
 *
 * Módulo puro, sem imports de aplicação: é lido pelo Next e pelos testes.
 */

import type { EventContent } from "./editorial.ts";

/** Os textos de `info.items` que o e-mail do evento precisa, por `id`. */
export const EVENT_EMAIL_INFO_IDS = ["o-que-levar", "seguranca", "alimentacao", "cancelamento"] as const;

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
