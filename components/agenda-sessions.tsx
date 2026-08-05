import Link from "next/link";
import {
  ArrowRight,
  CalendarDays,
  Clock3,
  MapPin,
  MessageCircle,
  Moon,
  SunMedium,
  Sunrise,
  Ticket,
  Users,
  Waves,
  type LucideIcon,
} from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { listAgendaSessions, type AgendaSession } from "@/lib/agenda/data";
import { WHATSAPP_AGENDA_LINK } from "@/lib/contact";
import { formatSessionDayMonth, formatSessionTime, formatSessionWeekday } from "@/lib/sessions/date-time";
import { getSupabaseServerClient } from "@/lib/supabase/server";

function resolveExperienceIcon(slug: string): LucideIcon {
  if (/lua/.test(slug)) return Moon;
  if (/nascer|amanhecer|sunrise/.test(slug)) return Sunrise;
  if (/sunset|entardecer|por-do-sol/.test(slug)) return SunMedium;
  return Waves;
}

function formatPrice(cents: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

function formatSpots(remaining: number) {
  return remaining === 1 ? "1 vaga disponível" : `${remaining} vagas disponíveis`;
}

export function AgendaLoading() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Carregando próximas datas" aria-busy="true">
      {[0, 1, 2].map((item) => (
        <div key={item} className="h-72 animate-pulse rounded-3xl border border-ink/10 bg-white/70" />
      ))}
    </div>
  );
}

function EmptyState({ error = false }: { error?: boolean }) {
  return (
    <div className="rounded-4xl border border-ink/10 bg-white px-6 py-14 text-center shadow-soft sm:px-12">
      <CalendarDays className="mx-auto size-7 text-lake" aria-hidden="true" />
      <h2 className="mt-5 text-2xl font-medium tracking-[-0.03em] text-forest sm:text-3xl">
        {error ? "Não foi possível carregar a agenda agora." : "Novas datas serão divulgadas em breve."}
      </h2>
      <p className="mx-auto mt-4 max-w-lg leading-7 text-ink/65">
        {error
          ? "Tente novamente em alguns instantes. Se preferir, fale com a gente pelo WhatsApp."
          : "Estamos preparando as próximas sessões de todas as experiências. Volte em breve — ou fale com a gente para ser avisado primeiro."}
      </p>
      <a
        href={WHATSAPP_AGENDA_LINK}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Falar com a Alma Azul pelo WhatsApp sobre as próximas datas"
        className={buttonVariants({ variant: "outline", size: "sm", className: "mt-7" })}
      >
        <MessageCircle className="size-4" aria-hidden="true" />
        Falar pelo WhatsApp
      </a>
    </div>
  );
}

function AgendaCard({ session }: { session: AgendaSession }) {
  const Icon = resolveExperienceIcon(session.experienceSlug);
  const dateLabel = `${formatSessionWeekday(session.startsAt)}, ${formatSessionDayMonth(session.startsAt)}`;
  const soldOut = session.remainingSpots <= 0;

  return (
    <article className="flex flex-col rounded-3xl border border-ink/10 bg-white p-6 shadow-soft transition duration-300 hover:-translate-y-1 sm:p-7">
      <span className="grid size-11 place-items-center rounded-2xl bg-mist text-lake" aria-hidden="true">
        <Icon className="size-5" />
      </span>

      <h2 className="mt-5 text-balance text-2xl font-medium leading-tight tracking-[-0.035em] text-forest sm:text-[1.6rem]">
        {session.experienceTitle}
      </h2>

      <p className="mt-2 text-base font-semibold text-ink first-letter:uppercase">{dateLabel}</p>

      <div className="mt-5 space-y-2.5 border-t border-ink/10 pt-5 text-sm text-ink/65">
        <p className="flex items-center gap-2.5">
          <MapPin className="size-4 shrink-0 text-lake" aria-hidden="true" />
          <span className="sr-only">Local: </span>
          {session.location}
        </p>
        <p className="flex items-center gap-2.5">
          <Clock3 className="size-4 shrink-0 text-lake" aria-hidden="true" />
          <span className="sr-only">Horário e duração: </span>
          {formatSessionTime(session.startsAt)}
          {session.durationMinutes > 0 ? ` · ${session.durationMinutes} min` : ""}
        </p>
        <p className="flex items-center gap-2.5">
          <Ticket className="size-4 shrink-0 text-lake" aria-hidden="true" />
          <span className="sr-only">Preço por pessoa: </span>
          {formatPrice(session.priceCents)}
        </p>
        <p className="flex items-center gap-2.5">
          <Users className="size-4 shrink-0 text-lake" aria-hidden="true" />
          {soldOut ? "Sem vagas para esta data" : formatSpots(session.remainingSpots)}
        </p>
      </div>

      {soldOut ? (
        <p className="mt-6 rounded-full border border-ink/15 px-4 py-3 text-center text-sm font-semibold text-ink/45">
          Sessão esgotada
        </p>
      ) : (
        <Link
          href={`/reservar/${session.id}`}
          aria-label={`Reservar vaga na ${session.experienceTitle} em ${dateLabel}, às ${formatSessionTime(session.startsAt)}`}
          className={buttonVariants({ size: "sm", className: "mt-6 w-full" })}
        >
          Reservar vaga
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      )}
    </article>
  );
}

export async function AgendaSessions() {
  const supabase = getSupabaseServerClient();
  if (!supabase) return <EmptyState />;

  try {
    const sessions = await listAgendaSessions(supabase);
    if (!sessions.length) return <EmptyState />;

    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {sessions.map((session) => (
          <AgendaCard key={session.id} session={session} />
        ))}
      </div>
    );
  } catch (error) {
    console.error("Erro ao montar a agenda geral:", error instanceof Error ? error.message : "erro desconhecido");
    return <EmptyState error />;
  }
}
