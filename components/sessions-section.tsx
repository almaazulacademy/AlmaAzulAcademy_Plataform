import Link from "next/link";
import { ArrowRight, CalendarDays, Ticket, Users } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { readOpenSessions } from "@/lib/reservations/session-catalog";
import type { BookingSession } from "@/lib/reservations/types";
import { groupSessionsByDay, type SessionChoice } from "@/lib/sessions/choice";

function formatPrice(cents: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

export function SessionsLoading() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3" aria-label="Carregando próximas datas" aria-busy="true">
      {[0, 1, 2].map((item) => <div key={item} className="h-64 animate-pulse rounded-3xl bg-white/10" />)}
    </div>
  );
}

function EmptyState({ error = false }: { error?: boolean }) {
  return (
    <div className="rounded-4xl border border-white/15 bg-white/[0.06] px-6 py-14 text-center sm:px-12">
      <CalendarDays className="mx-auto size-7 text-sand" />
      <h3 className="mt-5 text-2xl font-medium">{error ? "Não foi possível carregar as datas agora." : "Novas datas serão anunciadas em breve."}</h3>
      <p className="mx-auto mt-3 max-w-lg leading-7 text-white/60">
        {error ? "Tente novamente em alguns instantes. A experiência continua por aqui." : "Estamos preparando as próximas sessões. Volte em breve para encontrar sua data."}
      </p>
      <Link href="/acompanhar-reserva" className={buttonVariants({ variant: "light", size: "sm", className: "mt-6" })}>Acompanhar uma reserva</Link>
    </div>
  );
}

/**
 * Cartão de uma turma.
 *
 * O cartão inteiro é o alvo do clique — não um botão pequeno no rodapé — e o
 * horário é o maior elemento dele. Antes, a data ocupava o topo em corpo grande
 * e a hora aparecia em uma linha de 14px ao lado de preço e vagas: três turmas
 * do mesmo sábado ficavam praticamente idênticas na tela.
 *
 * O destino vem de `choice.href`, montado a partir de `sessions.id` na mesma
 * chamada que produziu o horário exibido. Não existe associação por posição.
 */
function SessionCard({ choice, session }: { choice: SessionChoice; session: BookingSession }) {
  return (
    <Link
      href={choice.href}
      aria-label={`Reservar ${choice.ariaLabel}`}
      className="group flex min-h-[16rem] flex-col rounded-3xl border border-white/15 bg-white/[0.07] p-6 transition duration-300 hover:-translate-y-1 hover:border-white/35 hover:bg-white/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sand focus-visible:ring-offset-2 focus-visible:ring-offset-ink sm:p-7"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sand">Turma</p>
      <p className="mt-2 text-[clamp(3.2rem,13vw,4rem)] font-medium leading-[0.85] tracking-[-0.06em]">
        {choice.time}
      </p>

      <div className="mt-7 space-y-2.5 border-t border-white/10 pt-5 text-sm text-white/65">
        <p className="flex items-center gap-3">
          <Ticket aria-hidden="true" className="size-4 shrink-0 text-sand" />
          {formatPrice(session.priceCents)} por pessoa
        </p>
        <p className="flex items-center gap-3">
          <Users aria-hidden="true" className="size-4 shrink-0 text-sand" />
          {session.remainingSpots} {session.remainingSpots === 1 ? "vaga restante" : "vagas restantes"}
        </p>
      </div>

      <span className="mt-auto flex items-center gap-2 pt-7 text-sm font-semibold text-white">
        Reservar esta turma
        <ArrowRight aria-hidden="true" className="size-4 transition-transform duration-300 group-hover:translate-x-1" />
      </span>
    </Link>
  );
}

/**
 * Grade de escolha da sessão, agrupada por dia.
 *
 * O agrupamento existe para tornar óbvio o que confundia o cliente: o mesmo
 * sábado tem 09:00, 12:00 e 15:00. Cada dia aparece uma vez, com as turmas
 * daquele dia lado a lado e o horário em evidência.
 */
export function SessionsGrid({ sessions }: { sessions: BookingSession[] }) {
  const days = groupSessionsByDay(sessions);

  return (
    <div className="space-y-12 sm:space-y-14">
      {days.map((day) => (
        <section key={day.dayKey} aria-label={day.fullDate}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-white/15 pb-4">
            <h3 className="text-2xl font-medium tracking-[-0.035em] first-letter:uppercase sm:text-3xl">
              {day.weekday}, {day.dayMonth}
            </h3>
            <p className="text-sm text-white/55">
              {day.turmas.length === 1 ? "1 turma neste dia" : `${day.turmas.length} turmas neste dia`}
            </p>
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {day.turmas.map(({ choice, session }) => (
              <SessionCard key={choice.sessionId} choice={choice} session={session} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Lê as sessões abertas da experiência e decide entre grade e estado vazio. */
export async function SessionsSection({ experienceSlug }: { experienceSlug: string }) {
  const result = await readOpenSessions(experienceSlug);
  if (result.status === "ERROR") return <EmptyState error />;
  if (result.status === "UNCONFIGURED" || !result.sessions.length) return <EmptyState />;

  return <SessionsGrid sessions={result.sessions} />;
}
