import { CalendarDays, Clock3, Ticket, Users } from "lucide-react";

import type { BookingSession } from "@/lib/reservations/types";

export function ReservationSummary({ session, quantity = 1 }: { session: BookingSession; quantity?: number }) {
  const date = new Date(session.startsAt);
  return (
    <aside className="rounded-4xl bg-ink p-7 text-white sm:p-9 lg:sticky lg:top-32">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sand">Resumo da experiência</p>
      <h2 className="mt-5 text-3xl font-medium tracking-[-0.04em]">{session.experienceTitle}</h2>
      <p className="mt-4 leading-7 text-white/60">{session.experienceSummary}</p>
      <div className="mt-8 space-y-4 border-t border-white/15 pt-7 text-sm text-white/75">
        <p className="flex items-start gap-3"><CalendarDays className="mt-0.5 size-4 shrink-0 text-sand" />{new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(date)}</p>
        <p className="flex items-center gap-3"><Clock3 className="size-4 text-sand" />{new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(date)} · {session.durationMinutes} minutos</p>
        <p className="flex items-center gap-3"><Ticket className="size-4 text-sand" />{new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(session.priceCents / 100)} por pessoa</p>
        <p className="flex items-center gap-3"><Users className="size-4 text-sand" />{session.remainingSpots} {session.remainingSpots === 1 ? "vaga disponível" : "vagas disponíveis"}</p>
      </div>
      <div className="mt-8 flex items-center justify-between border-t border-white/15 pt-6">
        <span className="text-sm text-white/55">Total para {quantity} {quantity === 1 ? "pessoa" : "pessoas"}</span>
        <strong className="text-xl">{new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format((session.priceCents * quantity) / 100)}</strong>
      </div>
    </aside>
  );
}
