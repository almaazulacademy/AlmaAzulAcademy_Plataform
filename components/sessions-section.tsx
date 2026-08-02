import Link from "next/link";
import { CalendarDays, Clock3, Ticket, Users } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { listOpenSessions } from "@/lib/reservations/data";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export function SessionsLoading() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3" aria-label="Carregando próximas datas" aria-busy="true">
      {[0, 1, 2].map((item) => <div key={item} className="h-80 animate-pulse rounded-3xl bg-white/10" />)}
    </div>
  );
}

function EmptyState({ error = false }: { error?: boolean }) {
  return (
    <div className="rounded-4xl border border-white/15 bg-white/[0.06] px-6 py-14 text-center sm:px-12">
      <CalendarDays className="mx-auto size-7 text-sand" />
      <h3 className="mt-5 text-2xl font-medium">{error ? "Não foi possível carregar as datas agora." : "Novas datas serão abertas em breve."}</h3>
      <p className="mx-auto mt-3 max-w-lg leading-7 text-white/60">
        {error ? "Tente novamente em alguns instantes. A experiência continua por aqui." : "Estamos preparando as próximas sessões. Volte em breve para encontrar sua data."}
      </p>
    </div>
  );
}

export async function SessionsSection({ experienceSlug }: { experienceSlug: string }) {
  const supabase = getSupabaseServerClient();
  if (!supabase) return <EmptyState />;

  try {
    const sessions = await listOpenSessions(supabase, experienceSlug);
    if (!sessions.length) return <EmptyState />;

    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {sessions.map((session) => {
          const date = new Date(session.startsAt);
          return (
            <article key={session.id} className="group flex min-h-80 flex-col rounded-3xl border border-white/15 bg-white/[0.07] p-7 transition duration-300 hover:-translate-y-1 hover:bg-white/[0.11]">
              <div className="flex items-start justify-between gap-5">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-sand">{new Intl.DateTimeFormat("pt-BR", { weekday: "long" }).format(date)}</p>
                  <p className="mt-2 text-3xl font-medium capitalize">{new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "long" }).format(date)}</p>
                </div>
                <CalendarDays className="size-5 text-white/45" />
              </div>
              <div className="mt-8 space-y-3 border-t border-white/10 pt-6 text-sm text-white/70">
                <p className="flex items-center gap-3"><Clock3 className="size-4 text-sand" />{new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(date)}</p>
                <p className="flex items-center gap-3"><Ticket className="size-4 text-sand" />{new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(session.priceCents / 100)} por pessoa</p>
                <p className="flex items-center gap-3"><Users className="size-4 text-sand" />{session.remainingSpots} {session.remainingSpots === 1 ? "vaga restante" : "vagas restantes"}</p>
              </div>
              <Link href={`/reservar/${session.id}`} className={buttonVariants({ variant: "light", size: "sm", className: "mt-auto w-full" })}>
                Selecionar esta data
              </Link>
            </article>
          );
        })}
      </div>
    );
  } catch (error) {
    console.error("Erro ao ler sessões abertas:", error instanceof Error ? error.message : "erro desconhecido");
    return <EmptyState error />;
  }
}
