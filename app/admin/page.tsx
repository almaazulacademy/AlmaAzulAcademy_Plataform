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
  Gauge,
  Trophy,
  ReceiptText,
} from "lucide-react";

import { AdminPageHeader } from "@/components/admin/page-header";
import { AdminErrorState } from "@/components/admin/states";
import { buttonVariants } from "@/components/ui/button";
import { requireAdmin } from "@/lib/admin/auth";
import { getAdminDashboard } from "@/lib/admin/data";
import { formatAdminDateTime, formatCurrency } from "@/lib/admin/format";
import { formatSessionDateTime } from "@/lib/sessions/date-time";

const cards = [
  { key: "futureSessions", label: "Sessões futuras", icon: CalendarCheck2 },
  { key: "confirmedReservations", label: "Reservas confirmadas", icon: TicketCheck },
  { key: "preReservations", label: "Pré-reservas", icon: Clock3 },
  { key: "expectedRevenueCents", label: "Receita prevista", icon: WalletCards },
  { key: "confirmedRevenueCents", label: "Receita confirmada", icon: Banknote },
  { key: "totalParticipants", label: "Total de participantes", icon: Users },
  { key: "totalReservations", label: "Número de reservas", icon: ReceiptText },
  { key: "monthlyRevenueCents", label: "Receita do mês", icon: Banknote },
  { key: "averageTicketCents", label: "Ticket médio", icon: WalletCards },
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
                <p className="mt-2 text-sm text-white/60">{formatSessionDateTime(metrics.nextSession.startsAt)}</p>
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

          <article className="rounded-3xl border border-ink/10 bg-white p-6">
            <div className="flex items-start justify-between"><p className="text-sm font-medium text-ink/55">Taxa média de ocupação</p><Gauge className="size-5 text-lake" /></div>
            <p className="mt-8 text-3xl font-semibold tracking-[-0.04em]">{metrics.averageOccupancyRate.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%</p>
          </article>
          <article className="rounded-3xl border border-ink/10 bg-white p-6">
            <div className="flex items-start justify-between"><p className="text-sm font-medium text-ink/55">Experiência mais vendida</p><Trophy className="size-5 text-lake" /></div>
            <p className="mt-8 text-xl font-semibold tracking-[-0.03em]">{metrics.topExperience ?? "Sem vendas confirmadas"}</p>
          </article>

          <article className="rounded-3xl border border-ink/10 bg-white p-6 sm:col-span-2 xl:col-span-4">
            <div><p className="text-sm font-medium text-ink/55">Receita confirmada · últimos 6 meses</p><p className="mt-1 text-xs text-ink/40">Comparativo mensal</p></div>
            <div className="mt-7 flex h-44 items-end gap-3" aria-label="Gráfico de receita mensal">{metrics.revenueByMonth.map((item) => { const max = Math.max(...metrics.revenueByMonth.map((entry) => entry.revenueCents), 1); const height = Math.max(6, (item.revenueCents / max) * 100); return <div key={item.month} title={`${item.month}: ${formatCurrency(item.revenueCents)}`} className="flex min-w-0 flex-1 flex-col items-center gap-2"><span className="hidden text-[10px] font-medium text-ink/45 sm:block">{formatCurrency(item.revenueCents)}</span><div className="w-full rounded-t-xl bg-lake" style={{ height: `${height}%` }} /><span className="text-xs capitalize text-ink/50">{item.month}</span></div>; })}</div>
          </article>

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
