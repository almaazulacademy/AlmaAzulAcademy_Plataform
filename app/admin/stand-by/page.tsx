import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, ChevronLeft, ChevronRight, Filter, Search, Users, X } from "lucide-react";

import { inputClass, labelClass } from "@/components/admin/form-styles";
import { AdminPageHeader } from "@/components/admin/page-header";
import { StandbyActions } from "@/components/admin/standby/standby-actions";
import { AdminEmptyState, AdminErrorState } from "@/components/admin/states";
import { buttonVariants } from "@/components/ui/button";
import { requireAdmin } from "@/lib/admin/auth";
import { listAdminBases } from "@/lib/admin/data";
import { formatAdminDateTime, formatAdminPhone, formatCurrency } from "@/lib/admin/format";
import { isStandbyAdminEnabled, parseStandbyListFilters, standbyListHref, standbyPageCount, STANDBY_PAGE_SIZE } from "@/lib/admin/standby";
import { listStandbyReservations } from "@/lib/admin/standby-data";
import { formatSessionDateTime } from "@/lib/sessions/date-time";

export const metadata = { title: "Stand-by" };

type SearchParams = Record<string, string | string[] | undefined>;

const DESCRIPTION = "Reservas pagas que saíram da turma original e aguardam uma nova data. Quem espera há mais tempo aparece primeiro.";

/**
 * Lista "Aguardando reagendamento".
 *
 * Paginada no banco: busca, filtros, total e página vêm de
 * `admin_list_standby_reservations_page`, então a lista não tem teto — a página
 * seguinte sempre existe enquanto houver reserva.
 */
export default async function AdminStandbyPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const context = await requireAdmin();
  // Painel desligado: a rota não existe, nem para quem digita o endereço.
  if (!isStandbyAdminEnabled()) notFound();
  const params = await searchParams;

  try {
    const { bases } = await listAdminBases();
    const filters = parseStandbyListFilters(params, bases);
    const baseId = bases.find((base) => base.slug === filters.base)?.id ?? null;
    const page = await listStandbyReservations(context.profile.userId, {
      query: filters.query,
      baseId,
      link: filters.link,
      page: filters.page,
    });
    const pages = standbyPageCount(page.total);
    const hasFilters = Boolean(filters.query || filters.base || filters.link);
    const first = page.total === 0 ? 0 : page.offset + 1;
    const last = page.offset + page.items.length;

    return (
      <div>
        <AdminPageHeader eyebrow="Atendimento" title="Stand-by" description={DESCRIPTION} />

        <form method="get" className="mt-8 rounded-3xl border border-ink/10 bg-white p-5 sm:p-6" aria-label="Filtros de Stand-by">
          <div className="flex items-center gap-2"><Filter className="size-4 text-lake" /><h2 className="text-sm font-semibold">Filtros</h2></div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label><span className={labelClass}>Busca</span><input name="query" defaultValue={filters.query} className={inputClass} maxLength={120} placeholder="Nome, código ou telefone" /></label>
            <label><span className={labelClass}>Base original</span><select name="base" defaultValue={filters.base} className={inputClass}><option value="">Todas as bases</option>{bases.map((base) => <option key={base.slug} value={base.slug}>{base.name}</option>)}</select></label>
            <label><span className={labelClass}>Link individual</span><select name="link" defaultValue={filters.link} className={inputClass}><option value="">Todos</option><option value="WITHOUT">Sem link ativo</option><option value="WITH">Com link ativo</option></select></label>
          </div>
          <div className="mt-5 flex flex-wrap justify-end gap-3">
            {hasFilters ? <Link href="/admin/stand-by" className={buttonVariants({ variant: "ghost", size: "sm" })}><X className="size-4" /> Limpar</Link> : null}
            <button type="submit" className={buttonVariants({ size: "sm" })}><Search className="size-4" /> Aplicar filtros</button>
          </div>
        </form>

        <div className="mt-6">
          <p className="mb-4 text-sm text-ink/50">
            {page.total === 0
              ? "Nenhuma reserva aguardando reagendamento"
              : `${page.total} ${page.total === 1 ? "reserva" : "reservas"} · ${page.totalParticipants} ${page.totalParticipants === 1 ? "participante" : "participantes"} · ${formatCurrency(page.totalCents)} pagos · mostrando ${first}–${last}`}
          </p>

          {page.items.length === 0 ? (
            <AdminEmptyState
              title={hasFilters ? "Nenhum resultado encontrado" : "Nenhuma reserva em Stand-by"}
              description={hasFilters
                ? "Ajuste ou remova os filtros para ampliar a busca."
                : "Quando uma reserva paga for colocada em Stand-by, ela aparece aqui até ser reagendada, devolvida à turma original ou cancelada."}
              action={<Link href={hasFilters ? "/admin/stand-by" : "/admin/reservas"} className={buttonVariants({ variant: "outline", size: "sm" })}>{hasFilters ? "Limpar filtros" : "Ver reservas"}</Link>}
            />
          ) : (
            <div className="space-y-4">
              {page.items.map((item) => (
                <article key={item.standbyId} className="rounded-3xl border border-ink/10 bg-white p-5 sm:p-6">
                  <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                    <div className="min-w-0 xl:w-64">
                      <h2 className="truncate text-lg font-semibold">{item.fullName}</h2>
                      <p className="mt-1 font-mono text-sm tracking-wide text-lake">{item.publicCode}</p>
                      <p className="mt-1 text-sm text-ink/50">{formatAdminPhone(item.phone)}</p>
                      <p className="mt-1 truncate text-xs text-ink/40">{item.email}</p>
                    </div>
                    <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                      <div><dt className="text-xs text-ink/45">Data original</dt><dd className="mt-1 text-sm font-semibold">{formatSessionDateTime(item.originalStartsAt)}</dd></div>
                      <div><dt className="text-xs text-ink/45">Experiência original</dt><dd className="mt-1 text-sm font-semibold">{item.originalExperienceTitle || "—"}</dd></div>
                      <div><dt className="text-xs text-ink/45">Base original</dt><dd className="mt-1 text-sm font-semibold">{item.originalBaseName || "—"}</dd></div>
                      <div><dt className="text-xs text-ink/45">Participantes</dt><dd className="mt-1 flex items-center gap-1.5 text-sm font-semibold"><Users className="size-4 text-lake" /> {item.quantity}</dd></div>
                      <div><dt className="text-xs text-ink/45">Valor pago</dt><dd className="mt-1 text-sm font-semibold">{formatCurrency(item.totalCents)}</dd></div>
                      <div><dt className="text-xs text-ink/45">Em Stand-by desde</dt><dd className="mt-1 text-sm font-semibold">{formatAdminDateTime(item.enteredAt)}</dd></div>
                    </dl>
                  </div>
                  <p className="mt-4 rounded-2xl bg-mist/50 p-4 text-sm leading-6 text-ink/70">
                    <span className="font-semibold text-ink">Motivo:</span> {item.reason || "Não informado"}
                    <span className="mt-1 block text-xs text-ink/50">
                      Colocada por {item.enteredByName || "administrador removido"}
                      {item.hasActiveLink ? ` · link individual ativo desde ${formatAdminDateTime(item.linkCreatedAt)}` : " · sem link individual ativo"}
                    </span>
                  </p>
                  <div className="mt-5 flex flex-col gap-3 border-t border-ink/10 pt-4 xl:flex-row xl:items-center xl:justify-between">
                    <StandbyActions reservationId={item.reservationId} fullName={item.fullName} phone={item.phone} publicCode={item.publicCode} hasActiveLink={item.hasActiveLink} />
                    <Link href={`/admin/reservas/${item.reservationId}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Abrir detalhes <ArrowRight className="size-4" /></Link>
                  </div>
                </article>
              ))}
            </div>
          )}

          {pages > 1 ? (
            <nav className="mt-6 flex items-center justify-between gap-3" aria-label="Paginação">
              {filters.page > 1
                ? <Link href={standbyListHref(filters, filters.page - 1)} className={buttonVariants({ variant: "outline", size: "sm" })}><ChevronLeft className="size-4" /> Anterior</Link>
                : <span />}
              <p className="text-sm text-ink/50">Página {Math.min(filters.page, pages)} de {pages} · {STANDBY_PAGE_SIZE} por página</p>
              {filters.page < pages
                ? <Link href={standbyListHref(filters, filters.page + 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>Próxima <ChevronRight className="size-4" /></Link>
                : <span />}
            </nav>
          ) : null}
        </div>
      </div>
    );
  } catch {
    return (
      <div>
        <AdminPageHeader eyebrow="Atendimento" title="Stand-by" description={DESCRIPTION} />
        <div className="mt-8"><AdminErrorState description="A migration do painel de Stand-by precisa estar aplicada no Supabase para consultar esta lista." /></div>
      </div>
    );
  }
}
