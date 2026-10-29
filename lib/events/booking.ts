/**
 * Venda de ingressos de eventos especiais pelo fluxo de reserva de sempre.
 *
 * Não há segundo fluxo: o evento usa `/reservar/[sessionId]`,
 * `POST /api/reservations`, `create_pre_reservation`, a InfinitePay e a
 * confirmação de pagamento existentes. O que muda aqui é só o que vale antes
 * de criar a pré-reserva:
 *
 *   - sessão de evento com a venda fechada (`isEventBookingOpen`) é recusada
 *     no servidor, mesmo com o id da sessão em mãos;
 *   - o pedido respeita o máximo de participantes do evento
 *     (`event.reservation.maxPerOrder`), além do limite geral de 20.
 *
 * Preço, capacidade e vagas continuam decididos pelo banco.
 *
 * Módulo puro, sem imports de aplicação: é lido pelo Next e pelos testes.
 */

import { infoParagraphs, validateEventEditorial, type EventEditorial } from "./editorial.ts";
import { deadlineShortText, clockText } from "./policy.ts";
import { eventDayLabel, eventTimeRange, programTimeLabel } from "./presentation.ts";
import type { PublicEvent } from "./public.ts";

export type SessionBookingRules =
  | { kind: "REGULAR" }
  | { kind: "EVENT"; maxPerOrder: number };

export type BookingRejection = { status: number; code: "EVENT_BOOKING_CLOSED" | "EVENT_ORDER_LIMIT"; message: string; field?: "quantity" };

export const EVENT_BOOKING_CLOSED_MESSAGE = "As reservas deste evento ainda não estão abertas.";

export function eventOrderLimitMessage(max: number) {
  return `Cada pedido deste evento aceita até ${max} ${max === 1 ? "participante" : "participantes"}.`;
}

/** Recusa antes da pré-reserva, ou null para seguir o fluxo de sempre. */
export function eventBookingRejection(rules: SessionBookingRules | null, quantity: number, bookingOpen: boolean): BookingRejection | null {
  if (!rules || rules.kind === "REGULAR") return null;
  if (!bookingOpen) return { status: 409, code: "EVENT_BOOKING_CLOSED", message: EVENT_BOOKING_CLOSED_MESSAGE };
  if (quantity > rules.maxPerOrder) {
    return { status: 400, code: "EVENT_ORDER_LIMIT", message: eventOrderLimitMessage(rules.maxPerOrder), field: "quantity" };
  }
  return null;
}

type QueryResult = { data: unknown; error: { message: string; code?: string } | null };

/** O pedaço do supabase-js usado aqui: `from(t).select(c).eq(col, valor)`. */
export type RulesQueryClient = {
  from(table: string): { select(columns: string): { eq(column: string, value: string): PromiseLike<QueryResult> } };
};

function firstRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" ? row as Record<string, unknown> : null;
}

function isMissingKindColumn(error: { message: string; code?: string }) {
  return error.code === "42703" || /column .*kind.* does not exist/i.test(error.message);
}

/**
 * Tipo e limite por pedido da sessão, lidos com a service role. Sessão
 * inexistente devolve null (a RPC de pré-reserva recusa como sempre). Banco
 * sem a coluna `kind` é todo regular. Outra falha lança: sem saber se é evento,
 * não se abre reserva.
 */
export async function loadSessionBookingRules(client: RulesQueryClient, sessionId: string): Promise<SessionBookingRules | null> {
  const session = await client.from("sessions").select("experience_id").eq("id", sessionId);
  if (session.error) throw new Error(`BOOKING_RULES_FAILED: ${session.error.message}`);
  const experienceId = firstRow(session.data)?.experience_id;
  if (typeof experienceId !== "string" || !experienceId) return null;

  const experience = await client.from("experiences").select("kind, editorial_content").eq("id", experienceId);
  if (experience.error) {
    if (isMissingKindColumn(experience.error)) return { kind: "REGULAR" };
    throw new Error(`BOOKING_RULES_FAILED: ${experience.error.message}`);
  }
  const row = firstRow(experience.data);
  if (row?.kind !== "EVENT") return { kind: "REGULAR" };
  // Evento sem conteúdo válido fica com o limite geral; de todo modo, ele não
  // aparece no site e só vende publicado.
  const editorial = validateEventEditorial(row.editorial_content);
  return { kind: "EVENT", maxPerOrder: editorial.success ? editorial.data.event.reservation.maxPerOrder : 20 };
}

/** O que a página de reserva mostra de um evento, já pronto para o cliente. */
export type EventBookingContext = {
  slug: string;
  title: string;
  subtitle: string;
  dayLabel: string | null;
  timeRange: string | null;
  arrivalNote: string | null;
  included: string[];
  program: Array<{ time: string; title: string }>;
  cancellationShort: string | null;
  cancellationParagraphs: string[];
  maxPerOrder: number;
};

export function eventBookingContext(event: PublicEvent): EventBookingContext {
  const content: EventEditorial = event.editorial;
  const extra = content.event;
  const policy = extra.info.items.find((item) => item.id === "cancelamento" && !item.pending);
  return {
    slug: event.slug,
    title: content.hero.title,
    subtitle: extra.subtitle,
    dayLabel: event.session.startsAt ? eventDayLabel(event.session.startsAt) : null,
    timeRange: event.session.startsAt ? eventTimeRange(event.session.startsAt, event.session.durationMinutes) : null,
    arrivalNote: extra.arrival ? `Início às ${clockText(extra.arrival.startTime)}, com tolerância de chegada até ${clockText(extra.arrival.toleranceUntil)}.` : null,
    included: extra.included.items,
    program: extra.program.items.map((item) => ({ time: programTimeLabel(item.time), title: item.title })),
    cancellationShort: extra.cancellation ? `Cancelamento até ${deadlineShortText(extra.cancellation.deadline)}: ${extra.cancellation.summary}.` : null,
    cancellationParagraphs: infoParagraphs(policy?.body ?? null),
    maxPerOrder: extra.reservation.maxPerOrder,
  };
}

/** Opções de quantidade: até as vagas restantes e até o máximo por pedido. */
export function eventQuantityLimit(remainingSpots: number, maxPerOrder: number) {
  return Math.max(0, Math.min(Math.floor(remainingSpots), maxPerOrder));
}
