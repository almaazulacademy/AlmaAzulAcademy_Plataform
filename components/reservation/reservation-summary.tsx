import { CalendarDays, Clock3, Ticket, Users } from "lucide-react";

import type { BookingSession } from "@/lib/reservations/types";
import { buildSessionChoice } from "@/lib/sessions/choice";

function formatPrice(cents: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

/**
 * Resumo da reserva, mostrado ao lado do formulário e na consulta da reserva.
 *
 * A turma escolhida ocupa o bloco mais visível do resumo: com três horários no
 * mesmo dia, a hora é o dado que distingue esta reserva de outra, e precisa ser
 * a primeira coisa que o cliente lê antes de pagar. Data e horário saem de
 * `buildSessionChoice`, ou seja, do `starts_at` desta sessão.
 */
export function ReservationSummary({ session, quantity = 1 }: { session: BookingSession; quantity?: number }) {
  const choice = buildSessionChoice(session);

  return (
    <aside className="rounded-4xl bg-ink p-7 text-white sm:p-9 lg:sticky lg:top-32">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sand">Resumo da experiência</p>
      <h2 className="mt-5 text-3xl font-medium tracking-[-0.04em]">{session.experienceTitle}</h2>
      <p className="mt-4 leading-7 text-white/60">{session.experienceSummary}</p>

      <div className="mt-8 rounded-3xl border border-white/15 bg-white/[0.07] p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sand">Sua turma</p>
        <p className="mt-3 text-[clamp(3rem,11vw,3.6rem)] font-medium leading-[0.85] tracking-[-0.06em]">
          <span className="sr-only">Horário de início: </span>
          {choice.time}
        </p>
        <p className="mt-4 flex items-start gap-2.5 text-sm leading-6 text-white/70">
          <CalendarDays aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-sand" />
          <span className="first-letter:uppercase">{choice.fullDate}</span>
        </p>
      </div>

      <div className="mt-7 space-y-4 border-t border-white/15 pt-7 text-sm text-white/75">
        <p className="flex items-center gap-3">
          <Clock3 aria-hidden="true" className="size-4 shrink-0 text-sand" />
          {session.durationMinutes} minutos de experiência
        </p>
        <p className="flex items-center gap-3">
          <Ticket aria-hidden="true" className="size-4 shrink-0 text-sand" />
          {formatPrice(session.priceCents)} por pessoa
        </p>
        <p className="flex items-center gap-3">
          <Users aria-hidden="true" className="size-4 shrink-0 text-sand" />
          {session.remainingSpots} {session.remainingSpots === 1 ? "vaga disponível" : "vagas disponíveis"}
        </p>
      </div>

      <div className="mt-8 flex items-center justify-between border-t border-white/15 pt-6">
        <span className="text-sm text-white/55">Total para {quantity} {quantity === 1 ? "pessoa" : "pessoas"}</span>
        <strong className="text-xl">{formatPrice(session.priceCents * quantity)}</strong>
      </div>
    </aside>
  );
}
