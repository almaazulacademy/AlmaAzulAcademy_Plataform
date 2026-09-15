import Link from "next/link";
import { notFound } from "next/navigation";
import { BookOpenCheck, CalendarDays, CalendarPlus, ExternalLink, RefreshCw } from "lucide-react";

import { BaseDashboardTabs, BaseMetricsGrid, RevenueChart, UpcomingSessionsList } from "@/components/admin/base-dashboard";
import { AdminPageHeader } from "@/components/admin/page-header";
import { AdminEmptyState, AdminErrorState } from "@/components/admin/states";
import { StatusBadge } from "@/components/admin/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { requireAdmin } from "@/lib/admin/auth";
import { experiencesInBase } from "@/lib/admin/base-filter";
import { getAdminBaseDashboard, listAdminBases, listAdminExperiences } from "@/lib/admin/data";
import { formatAdminDateTime } from "@/lib/admin/format";

export const metadata = { title: "Dashboard da base" };

type Props = { params: Promise<{ slug: string }> };

/**
 * Dashboard de uma base: somente sessões, reservas e receita das experiências
 * desta base. Uma base sem operação mostra estados vazios, nunca números
 * inventados nem cards quebrados.
 */
export default async function AdminBaseDashboardPage({ params }: Props) {
  const context = await requireAdmin();
  const { slug } = await params;
  const { bases, migrationPending } = await listAdminBases();
  const base = bases.find((item) => item.slug === slug);
  if (!base) notFound();

  const header = (
    <>
      <AdminPageHeader
        eyebrow={`Dashboard · Base ${base.name}`}
        title={`Base ${base.name}`}
        description={
          base.status === "ACTIVE"
            ? "Somente os dados desta base: sessões, reservas, participantes e faturamento."
            : "Base ainda sem programação aberta. Os números aparecem aqui quando houver sessões e reservas."
        }
        action={
          <div className="flex flex-wrap gap-2">
            <Link href={`/bases/${base.slug}`} className={buttonVariants({ variant: "outline", size: "sm" })}><ExternalLink className="size-4" /> Página pública</Link>
            {base.status === "ACTIVE" ? <Link href="/admin/sessoes?novo=1" className={buttonVariants({ size: "sm" })}><CalendarPlus className="size-4" /> Nova sessão</Link> : null}
          </div>
        }
      />
      <BaseDashboardTabs bases={bases} current={base.slug} />
    </>
  );

  if (migrationPending) {
    return (
      <div>
        {header}
        <div className="mt-8"><AdminErrorState title="Dashboard por base indisponível." description="A migration multi-base (202609150001_multi_base.sql) ainda não foi aplicada no Supabase deste ambiente. A visão geral continua funcionando normalmente." /></div>
      </div>
    );
  }

  try {
    const [metrics, experiences] = await Promise.all([
      getAdminBaseDashboard(context.profile.userId, base.id),
      listAdminExperiences(context.profile.userId),
    ]);
    const baseExperiences = experiencesInBase(experiences, base.slug);
    const hasOperation = metrics.sessionsCount > 0 || metrics.totalReservations > 0;

    return (
      <div>
        {header}

        <div className="mt-6 flex flex-wrap items-center gap-3 text-sm text-ink/55">
          <StatusBadge status={base.status} />
          <span>{base.locationLabel}</span>
          {base.partnerName ? <span>· Parceria com {base.partnerName}</span> : null}
          <span className="inline-flex items-center gap-1.5"><RefreshCw className="size-3.5" /> {formatAdminDateTime(metrics.lastUpdatedAt)}</span>
        </div>

        {hasOperation ? (
          <>
            <BaseMetricsGrid metrics={metrics} />
            <RevenueChart metrics={metrics} />
          </>
        ) : (
          <div className="mt-8">
            <AdminEmptyState
              title="Nenhuma sessão cadastrada ainda."
              description={
                base.status === "ACTIVE"
                  ? "Quando houver sessões e reservas nesta base, faturamento, ocupação e participantes aparecem aqui."
                  : `A Base ${base.name} está em breve. Sem sessões, reservas ou faturamento por enquanto.`
              }
            />
          </div>
        )}

        <div className="mt-4 grid gap-4 xl:grid-cols-[1.3fr_0.7fr]">
          <UpcomingSessionsList
            metrics={metrics}
            sessionsHref={`/admin/sessoes?base=${base.slug}`}
            emptyTitle="Nenhuma sessão futura."
            emptyDescription={base.status === "ACTIVE" ? "Crie uma nova sessão para organizar a agenda desta base." : "Esta base ainda não tem programação aberta."}
          />

          <article className="rounded-3xl border border-ink/10 bg-white p-5 sm:p-6">
            <p className="text-sm font-medium text-ink/55">Experiências da base</p>
            {baseExperiences.length ? (
              <ul className="mt-4 divide-y divide-ink/10">
                {baseExperiences.map((experience) => (
                  <li key={experience.id} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-ink">{experience.title}</p>
                      <p className="text-xs text-ink/45">{experience.sessionsCount} sessões{experience.isExclusive ? " · exclusiva da base" : ""}</p>
                    </div>
                    <StatusBadge status={experience.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-ink/55">Nenhuma experiência cadastrada nesta base.</p>
            )}
            <div className="mt-5 flex flex-wrap gap-2 border-t border-ink/10 pt-4">
              <Link href={`/admin/sessoes?base=${base.slug}`} className={buttonVariants({ variant: "ghost", size: "sm" })}><CalendarDays className="size-4" /> Sessões</Link>
              <Link href={`/admin/reservas?base=${base.slug}`} className={buttonVariants({ variant: "ghost", size: "sm" })}><BookOpenCheck className="size-4" /> Reservas</Link>
            </div>
          </article>
        </div>
      </div>
    );
  } catch {
    return (
      <div>
        {header}
        <div className="mt-8"><AdminErrorState description="Não foi possível carregar os números desta base. Confira a configuração do Supabase e tente novamente." /></div>
      </div>
    );
  }
}
