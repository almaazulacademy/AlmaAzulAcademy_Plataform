import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Pencil, Plus, Search, X } from "lucide-react";

import { CouponOverLimitBadge, CouponStateBadge } from "@/components/admin/coupons/coupon-badges";
import { inputClass, labelClass } from "@/components/admin/form-styles";
import { AdminPageHeader } from "@/components/admin/page-header";
import { AdminEmptyState, AdminErrorState } from "@/components/admin/states";
import { buttonVariants } from "@/components/ui/button";
import { requireAdmin } from "@/lib/admin/auth";
import {
  canManageCoupons,
  COUPON_STATUS_FILTERS,
  COUPON_STATUS_FILTER_LABELS,
  couponLimitLabel,
  couponPanelError,
  couponValidityLabel,
  filterCoupons,
  isCouponsAdminEnabled,
  parseCouponFilters,
} from "@/lib/admin/coupons";
import { couponAdminData } from "@/lib/admin/coupons-server";

export const metadata = { title: "Cupons de desconto" };

type SearchParams = Record<string, string | string[] | undefined>;

const DESCRIPTION = "Campanhas promocionais com desconto percentual. Desativar um cupom impede novas utilizações e preserva as reservas já feitas e o histórico.";

/**
 * Marketing → Cupons de desconto.
 *
 * ADMIN e OPERATOR consultam; só o ADMIN vê "Novo cupom" e "Editar" — e as
 * rotas e o banco recusam o OPERATOR de qualquer forma. A lista vem de
 * `admin_list_coupons`; filtro de situação e busca por código são feitos aqui.
 * O alerta de limite excedido aparece com qualquer situação.
 */
export default async function AdminCouponsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const context = await requireAdmin();
  // Painel desligado: a rota não existe, nem para quem digita o endereço.
  if (!isCouponsAdminEnabled()) notFound();
  const params = await searchParams;
  const filters = parseCouponFilters(params);
  const manager = canManageCoupons(context.profile.role);
  const header = (
    <AdminPageHeader
      eyebrow="Marketing"
      title="Cupons de desconto"
      description={DESCRIPTION}
      action={manager ? <Link href="/admin/marketing/cupons/novo" className={buttonVariants({ size: "sm" })}><Plus className="size-4" /> Novo cupom</Link> : null}
    />
  );

  let coupons;
  try {
    coupons = await couponAdminData().list(context.profile.userId);
  } catch (error) {
    return <div>{header}<div className="mt-8"><AdminErrorState description={couponPanelError(error).message} /></div></div>;
  }

  const visible = filterCoupons(coupons, filters);
  const hasFilters = filters.status !== "ALL" || Boolean(filters.query);
  const overLimitCount = coupons.filter((coupon) => coupon.overLimit).length;

  return (
    <div>
      {header}

      {overLimitCount > 0 ? (
        <p className="mt-6 rounded-3xl border border-orange-200 bg-orange-50 p-5 text-sm leading-6 text-orange-950" role="status">
          {overLimitCount === 1 ? "1 cupom tem" : `${overLimitCount} cupons têm`} utilizações pagas além do limite (pagamento confirmado depois que a vaga do cupom foi ocupada por outra reserva). Os pagamentos valem; confira o detalhe.
        </p>
      ) : null}

      <form method="get" className="mt-8 rounded-3xl border border-ink/10 bg-white p-5 sm:p-6" aria-label="Filtros dos cupons">
        <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label><span className={labelClass}>Situação</span><select name="status" defaultValue={filters.status} className={inputClass}>{COUPON_STATUS_FILTERS.map((status) => <option key={status} value={status}>{COUPON_STATUS_FILTER_LABELS[status]}</option>)}</select></label>
          <label><span className={labelClass}>Código</span><input name="query" defaultValue={filters.query} className={`${inputClass} font-mono uppercase`} maxLength={32} placeholder="ALMAAZUL10" autoComplete="off" /></label>
          <div className="flex gap-3">
            {hasFilters ? <Link href="/admin/marketing/cupons" className={buttonVariants({ variant: "ghost", size: "sm" })}><X className="size-4" /> Limpar</Link> : null}
            <button type="submit" className={buttonVariants({ size: "sm" })}><Search className="size-4" /> Filtrar</button>
          </div>
        </div>
      </form>

      <p className="mt-8 text-sm text-ink/50">{visible.length === coupons.length ? `${coupons.length} ${coupons.length === 1 ? "cupom" : "cupons"}` : `${visible.length} de ${coupons.length} cupons`}</p>

      {visible.length === 0 ? (
        <div className="mt-4">
          <AdminEmptyState
            title={hasFilters ? "Nenhum cupom encontrado" : "Nenhum cupom cadastrado"}
            description={hasFilters ? "Ajuste ou limpe os filtros para ampliar a busca." : manager ? "Crie o primeiro cupom em “Novo cupom”. Ele pode nascer inativo até a campanha começar." : "Quando um administrador criar um cupom, ele aparece aqui."}
          />
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-3xl border border-ink/10 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="hidden bg-mist/50 text-xs uppercase tracking-[0.12em] text-ink/55 lg:table-header-group">
              <tr>
                <th className="px-5 py-3 font-semibold">Código</th>
                <th className="px-5 py-3 font-semibold">Desconto</th>
                <th className="px-5 py-3 font-semibold">Utilizações</th>
                <th className="px-5 py-3 font-semibold">Limite</th>
                <th className="px-5 py-3 font-semibold">Validade</th>
                <th className="px-5 py-3 font-semibold">Situação</th>
                <th className="px-5 py-3"><span className="sr-only">Ações</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/10">
              {visible.map((coupon) => (
                <tr key={coupon.id} className="grid gap-2 p-5 lg:table-row lg:p-0">
                  <td className="lg:px-5 lg:py-4">
                    <Link href={`/admin/marketing/cupons/${coupon.id}`} className="font-mono text-sm font-semibold tracking-wide text-ink hover:text-lake">{coupon.code}</Link>
                    {coupon.description ? <p className="mt-1 line-clamp-1 max-w-xs text-xs text-ink/50">{coupon.description}</p> : null}
                  </td>
                  <td className="font-semibold lg:px-5 lg:py-4"><span className="text-ink/45 lg:hidden">Desconto: </span>{coupon.percentOff}%</td>
                  <td className="lg:px-5 lg:py-4"><span className="text-ink/45 lg:hidden">Utilizações: </span><span className="font-semibold">{coupon.uses.counted}</span>{coupon.uses.reserved ? <span className="block text-xs text-ink/45">{coupon.uses.reserved} aguardando pagamento</span> : null}</td>
                  <td className="text-ink/70 lg:px-5 lg:py-4"><span className="text-ink/45 lg:hidden">Limite: </span>{couponLimitLabel(coupon.maxUses)}</td>
                  <td className="text-ink/70 lg:px-5 lg:py-4"><span className="text-ink/45 lg:hidden">Validade: </span>{couponValidityLabel(coupon.validFrom, coupon.validUntil)}</td>
                  <td className="lg:px-5 lg:py-4">
                    <div className="flex flex-wrap gap-1.5">
                      <CouponStateBadge state={coupon.state} />
                      <CouponOverLimitBadge overLimit={coupon.overLimit} excessCount={coupon.excessCount} />
                    </div>
                  </td>
                  <td className="lg:px-5 lg:py-4 lg:text-right">
                    <div className="flex flex-wrap gap-2 lg:justify-end">
                      {manager ? <Link href={`/admin/marketing/cupons/${coupon.id}/editar`} className={buttonVariants({ variant: "ghost", size: "sm" })}><Pencil className="size-4" /> Editar</Link> : null}
                      <Link href={`/admin/marketing/cupons/${coupon.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Detalhes <ArrowRight className="size-4" /></Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
