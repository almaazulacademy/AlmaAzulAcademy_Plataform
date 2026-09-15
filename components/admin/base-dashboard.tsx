import Link from "next/link";
import {
  Ban,
  Banknote,
  CalendarCheck2,
  Clock3,
  Gauge,
  ReceiptText,
  TicketCheck,
  Trophy,
  Users,
  WalletCards,
  Waves,
} from "lucide-react";

import { StatusBadge } from "@/components/admin/status-badge";
import { formatCurrency } from "@/lib/admin/format";
import type { AdminBase, AdminBaseDashboard } from "@/lib/admin/types";
import { formatSessionDateTime } from "@/lib/sessions/date-time";
import { cn } from "@/lib/utils";

/** Abas do dashboard: visão consolidada e uma aba por base. */
export function BaseDashboardTabs({ bases, current }: { bases: AdminBase[]; current: string | null }) {
  const tabs = [{ href: "/admin", label: "Visão geral", slug: null as string | null, badge: null as string | null }].concat(
    bases.map((base) => ({ href: `/admin/bases/${base.slug}`, label: base.name, slug: base.slug, badge: base.status === "ACTIVE" ? null : base.status === "COMING_SOON" ? "Em breve" : "Inativa" })),
  );
  return (
    <nav aria-label="Dashboards por base" className="-mx-5 mt-6 overflow-x-auto px-5 sm:mx-0 sm:px-0">
      <ul className="flex w-max gap-2 rounded-full bg-white p-1 ring-1 ring-ink/10">
        {tabs.map((tab) => {
          const active = tab.slug === current;
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-full px-4 text-sm font-semibold transition",
                  active ? "bg-ink text-white" : "text-ink/60 hover:bg-ink/5 hover:text-ink",
                )}
              >
                {tab.label}
                {tab.badge ? (
                  <span className={cn("rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.1em]", active ? "bg-white/15 text-white" : "bg-sky-50 text-sky-800")}>{tab.badge}</span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const metricCards = [
  { key: "futureSessions", label: "Sessões futuras", icon: CalendarCheck2 },
  { key: "confirmedReservations", label: "Reservas confirmadas", icon: TicketCheck },
  { key: "preReservations", label: "Pré-reservas", icon: Clock3 },
  { key: "cancelledReservations", label: "Cancelamentos", icon: Ban },
  { key: "confirmedRevenueCents", label: "Faturamento confirmado", icon: Banknote },
  { key: "expectedRevenueCents", label: "Receita prevista", icon: WalletCards },
  { key: "monthlyRevenueCents", label: "Receita do mês", icon: Banknote },
  { key: "averageTicketCents", label: "Ticket médio", icon: WalletCards },
  { key: "totalParticipants", label: "Participantes", icon: Users },
  { key: "totalReservations", label: "Número de reservas", icon: ReceiptText },
  { key: "experiencesCount", label: "Experiências", icon: Waves },
] as const;

export function BaseMetricsGrid({ metrics }: { metrics: AdminBaseDashboard }) {
  return (
    <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Indicadores da base">
      {metricCards.map((card) => {
        const Icon = card.icon;
        const raw = metrics[card.key];
        const value = card.key.endsWith("Cents") ? formatCurrency(raw) : new Intl.NumberFormat("pt-BR").format(raw);
        return (
          <article key={card.key} className="rounded-3xl border border-ink/10 bg-white p-5 sm:p-6">
            <div className="flex items-start justify-between gap-3"><p className="text-sm font-medium text-ink/55">{card.label}</p><Icon className="size-5 shrink-0 text-lake" /></div>
            <p className="mt-6 text-2xl font-semibold tracking-[-0.04em] text-ink sm:mt-8 sm:text-3xl">{value}</p>
          </article>
        );
      })}
      <article className="rounded-3xl border border-ink/10 bg-white p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3"><p className="text-sm font-medium text-ink/55">Ocupação média (futuras)</p><Gauge className="size-5 shrink-0 text-lake" /></div>
        <p className="mt-6 text-2xl font-semibold tracking-[-0.04em] sm:mt-8 sm:text-3xl">{metrics.averageOccupancyRate.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%</p>
      </article>
      <article className="rounded-3xl border border-ink/10 bg-white p-5 sm:col-span-2 sm:p-6 xl:col-span-4">
        <div className="flex items-start justify-between gap-3"><p className="text-sm font-medium text-ink/55">Experiência mais vendida</p><Trophy className="size-5 shrink-0 text-lake" /></div>
        <p className="mt-4 text-xl font-semibold tracking-[-0.03em]">{metrics.topExperience ?? "Sem vendas confirmadas"}</p>
      </article>
    </section>
  );
}

export function RevenueChart({ metrics }: { metrics: AdminBaseDashboard }) {
  const max = Math.max(...metrics.revenueByMonth.map((entry) => entry.revenueCents), 1);
  const empty = metrics.revenueByMonth.every((entry) => entry.revenueCents === 0);
  return (
    <article className="mt-4 rounded-3xl border border-ink/10 bg-white p-5 sm:p-6">
      <p className="text-sm font-medium text-ink/55">Faturamento confirmado · últimos 6 meses</p>
      {empty ? (
        <p className="mt-6 rounded-2xl bg-mist/60 px-4 py-6 text-center text-sm text-ink/55">Nenhuma receita confirmada nesta base ainda.</p>
      ) : (
        <div className="mt-7 flex h-44 items-end gap-2 sm:gap-3" aria-label="Gráfico de receita mensal">
          {metrics.revenueByMonth.map((item) => (
            <div key={item.month} title={`${item.month}: ${formatCurrency(item.revenueCents)}`} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-2">
              <span className="hidden text-[10px] font-medium text-ink/45 sm:block">{formatCurrency(item.revenueCents)}</span>
              <div className="w-full rounded-t-xl bg-lake" style={{ height: `${Math.max(4, (item.revenueCents / max) * 100)}%` }} />
              <span className="text-xs capitalize text-ink/50">{item.month}</span>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

export function UpcomingSessionsList({ metrics, emptyTitle, emptyDescription, sessionsHref }: { metrics: AdminBaseDashboard; emptyTitle: string; emptyDescription: string; sessionsHref: string }) {
  return (
    <article className="rounded-3xl border border-ink/10 bg-white p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-ink/55">Próximas sessões</p>
        <Link href={sessionsHref} className="text-sm font-semibold text-forest">Ver sessões</Link>
      </div>
      {metrics.upcomingSessions.length ? (
        <ul className="mt-4 divide-y divide-ink/10">
          {metrics.upcomingSessions.map((session) => {
            const occupied = session.capacity - session.remainingSpots;
            const occupancy = session.capacity ? Math.round((occupied / session.capacity) * 100) : 0;
            return (
              <li key={session.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-ink">{session.experienceTitle}</p>
                  <p className="text-sm text-ink/55">{formatSessionDateTime(session.startsAt)}</p>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <StatusBadge status={session.status} />
                  <span className="whitespace-nowrap text-ink/60">{occupied}/{session.capacity} · {occupancy}%</span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mt-4 rounded-2xl border border-dashed border-ink/15 px-4 py-8 text-center">
          <p className="font-semibold text-ink">{emptyTitle}</p>
          <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-ink/55">{emptyDescription}</p>
        </div>
      )}
    </article>
  );
}

/** Comparação lado a lado das bases, para a visão geral. */
export function BaseComparison({ rows }: { rows: Array<{ base: AdminBase; metrics: AdminBaseDashboard | null }> }) {
  const columns = [
    { label: "Faturamento confirmado", value: (m: AdminBaseDashboard) => formatCurrency(m.confirmedRevenueCents) },
    { label: "Reservas confirmadas", value: (m: AdminBaseDashboard) => String(m.confirmedReservations) },
    { label: "Participantes", value: (m: AdminBaseDashboard) => String(m.totalParticipants) },
    { label: "Ocupação média", value: (m: AdminBaseDashboard) => `${m.averageOccupancyRate.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` },
    { label: "Sessões futuras", value: (m: AdminBaseDashboard) => String(m.futureSessions) },
    { label: "Próxima sessão", value: (m: AdminBaseDashboard) => (m.nextSession ? formatSessionDateTime(m.nextSession.startsAt) : "—") },
  ];
  return (
    <section className="mt-8" aria-labelledby="desempenho-por-base">
      <h2 id="desempenho-por-base" className="text-lg font-semibold tracking-[-0.02em] text-ink">Desempenho por base</h2>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {rows.map(({ base, metrics }) => (
          <article key={base.slug} className="rounded-3xl border border-ink/10 bg-white p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h3 className="text-xl font-semibold tracking-[-0.03em]">{base.name}</h3>
                <StatusBadge status={base.status} />
              </div>
              <Link href={`/admin/bases/${base.slug}`} className="text-sm font-semibold text-forest">Abrir dashboard</Link>
            </div>
            {metrics ? (
              <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                {columns.map((column) => (
                  <div key={column.label}>
                    <dt className="text-xs text-ink/45">{column.label}</dt>
                    <dd className="mt-1 text-sm font-semibold text-ink">{column.value(metrics)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="mt-5 text-sm text-ink/55">Números por base disponíveis após aplicar a migration multi-base no Supabase.</p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
