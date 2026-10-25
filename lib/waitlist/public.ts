/**
 * Lista de espera — fase 2: turmas esgotadas no site.
 *
 * Regras de apresentação, em um lugar só. Nada aqui decide se uma reserva pode
 * acontecer: quem decide é o banco (`get_booking_session` e
 * `create_pre_reservation`, que não mudaram). Estas funções só garantem que a
 * tela nunca ofereça reserva onde o banco recusaria — e que, com a variável
 * desligada, o site continue exatamente como era.
 *
 * Sem Next e sem Supabase de propósito: é o que deixa testar tudo sem subir nada.
 */

import type { BookingSession } from "../reservations/types.ts";

/**
 * A exibição das turmas esgotadas só existe com `WAITLIST_PUBLIC_ENABLED=true`.
 *
 * Desligada — ausente ou com qualquer outro valor —, as listagens continuam
 * vindo de `list_open_sessions`, que só devolve turmas com vaga: nenhuma turma
 * esgotada aparece, como antes. Variável de servidor: nunca `NEXT_PUBLIC_`.
 */
export function isWaitlistPublicEnabled(env: Record<string, string | undefined> = process.env) {
  return (env.WAITLIST_PUBLIC_ENABLED ?? "").trim().toLowerCase() === "true";
}

/** Uma turma como o site a exibe: a sessão de sempre, mais se está esgotada. */
export type PublicSession = BookingSession & { soldOut: boolean };

export const SOLD_OUT_LABEL = "Esgotado";

export const SOLD_OUT_NOTE = "Todas as vagas desta turma já foram reservadas.";

/**
 * Pode reservar? Só com vaga de verdade. A marca `soldOut` vem do banco, mas a
 * contagem também é conferida: uma linha incoerente nunca vira link de reserva.
 */
export function isSessionBookable(session: Pick<PublicSession, "soldOut" | "remainingSpots">) {
  return !session.soldOut && session.remainingSpots > 0;
}

/** Sessão de `list_open_sessions`: sempre com vaga, nunca esgotada. */
export function asOpenSession(session: BookingSession): PublicSession {
  return { ...session, soldOut: session.remainingSpots <= 0 };
}

/**
 * Quantidades oferecidas no formulário: de 1 até as vagas restantes, no máximo
 * 20. Com zero vagas, nenhuma — e o formulário não é mostrado.
 */
export function reservationQuantityOptions(remainingSpots: number) {
  const max = Math.min(Math.max(Math.floor(Number.isFinite(remainingSpots) ? remainingSpots : 0), 0), 20);
  return Array.from({ length: max }, (_, index) => index + 1);
}

/**
 * O que fazer quando a criação da pré-reserva é recusada por falta de vaga —
 * a disponibilidade mudou entre a página e o envio.
 *
 *   SOLD_OUT — esgotou: o formulário dá lugar ao aviso de turma esgotada.
 *   FEWER    — ainda há vaga, mas menos do que o pedido: a quantidade é
 *              reduzida ao que sobrou e o cliente decide de novo.
 *   MESSAGE  — qualquer outra recusa, ou a variável desligada: só a mensagem
 *              da API, como sempre foi.
 */
export type ReservationConflict =
  | { kind: "SOLD_OUT" }
  | { kind: "FEWER"; remainingSpots: number }
  | { kind: "MESSAGE" };

export function resolveReservationConflict(payload: unknown, waitlistEnabled: boolean): ReservationConflict {
  if (!waitlistEnabled || typeof payload !== "object" || payload === null) return { kind: "MESSAGE" };
  const body = payload as Record<string, unknown>;
  if (body.code !== "INSUFFICIENT_SPOTS") return { kind: "MESSAGE" };
  const remaining = Number(body.remainingSpots);
  if (!Number.isInteger(remaining) || remaining < 0) return { kind: "MESSAGE" };
  return remaining === 0 ? { kind: "SOLD_OUT" } : { kind: "FEWER", remainingSpots: remaining };
}

export function fewerSpotsMessage(remainingSpots: number) {
  return remainingSpots === 1
    ? "As vagas mudaram enquanto você preenchia: resta 1 vaga nesta turma. Confira a quantidade e tente de novo."
    : `As vagas mudaram enquanto você preenchia: restam ${remainingSpots} vagas nesta turma. Confira a quantidade e tente de novo.`;
}

export const SOLD_OUT_WHILE_FILLING = "Esta turma esgotou enquanto você preenchia. Nenhuma vaga foi bloqueada e nada foi cobrado.";
