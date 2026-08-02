import Link from "next/link";
import {
  Banknote,
  CalendarCheck2,
  CalendarClock,
  Clock3,
  RefreshCw,
  TicketCheck,
  Users,
  WalletCards,
} from "lucide-react";

import { AdminPageHeader } from "@/components/admin/page-header";
import { AdminErrorState } from "@/components/admin/states";
import { buttonVariants } from "@/components/ui/button";
import { requireAdmin } from "@/lib/admin/auth";
import { getAdminDashboard } from "@/lib/admin/data";
import { formatAdminDateTime, formatCurrency } from "@/lib/admin/format";

const cards = [
  { key: "futureSessions", label: "Sessões futuras", icon: CalendarCheck2 },
  { key: "confirmedReservations", label: "Reservas confirmadas", icon: TicketCheck },
  { key: "preReservations", label: "Pré-reservas", icon: Clock3 },
  { key: "expectedRevenueCents", label: "Receita prevista", icon: WalletCards },
  { key: "confirmedRevenueCents", label: "Receita confirmada", icon: Banknote },
  { key: "totalParticipants", label: "Total de participantes", icon: Users },
] as const;

export default async function AdminDashboardPage() {
  const context = await requireAdmin();
  try {
    const metrics = await getAdminDashboard(context.profile.userId);
    return (
      <div>
        <AdminPageHeader
          eyebrow="Visão operacional"
          title={`Olá, ${context.profile.displayName.split(" ")[0]}.`}
          description="Acompanhe as próximas experiências e os principais números da operação."
          action={<Link href="/admin/sessoes?novo=1" className={buttonVariants()}>Nova sessão</Link>}
        />

        <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Indicadores do painel">
          <article className="rounded-3xl bg-ink p-6 text-white sm:col-span-2">
            <div className="flex items-start justify-between gap-4">
              <div className="grid size-11 place-items-center rounded-2xl bg-white/10"><CalendarClock className="size-5" /></div>
              <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white/70">Próxima experiência</span>
            </div>
            {metrics.nextSession ? (
              <div className="mt-7">
                <h2 className="text-2xl font-semibold tracking-[-0.03em]">{metrics.nextSession.experienceTitle}</h2>
                <p className="mt-2 text-sm text-white/60">{formatAdminDateTime(metrics.nextSession.startsAt)}</p>
                <p className="mt-5 text-sm font-medium">{metrics.nextSession.remainingSpots} vagas restantes</p>
              </div>
            ) : (
              <div className="mt-7"><h2 className="text-xl font-semibold">Nenhuma sessão futura</h2><p className="mt-2 text-sm text-white/60">Crie uma nova sessão para organizar a agenda.</p></div>
            )}
          </article>

          {cards.map((card) => {
            const Icon = card.icon;
            const value = card.key.endsWith("Cents")
              ? formatCurrency(metrics[card.key])
              : new Intl.NumberFormat("pt-BR").format(metrics[card.key]);
            return (
              <article key={card.key} className="rounded-3xl border border-ink/10 bg-white p-6">
                <div className="flex items-start justify-between"><p className="text-sm font-medium text-ink/55">{card.label}</p><Icon className="size-5 text-lake" /></div>
                <p className="mt-8 text-3xl font-semibold tracking-[-0.04em] text-ink">{value}</p>
              </article>
            );
          })}

          <article className="rounded-3xl border border-ink/10 bg-white p-6 sm:col-span-2">
            <div className="flex items-start justify-between"><p className="text-sm font-medium text-ink/55">Última atualização</p><RefreshCw className="size-5 text-lake" /></div>
            <p className="mt-8 text-xl font-semibold tracking-[-0.03em] text-ink">{formatAdminDateTime(metrics.lastUpdatedAt)}</p>
            <p className="mt-2 text-xs text-ink/45">Horário de Brasília</p>
          </article>
        </section>
      </div>
    );
  } catch {
    return (
      <div>
        <AdminPageHeader eyebrow="Visão operacional" title="Dashboard" description="Acompanhe a operação da Alma Azul." />
        <div className="mt-8"><AdminErrorState description="A migration administrativa pode ainda não ter sido aplicada no Supabase deste ambiente." /></div>
      </div>
    );
  }
}
