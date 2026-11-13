import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, Pencil } from "lucide-react";

import { CouponOverLimitBadge, CouponStateBadge, RedemptionStateBadge } from "@/components/admin/coupons/coupon-badges";
import { CouponStatusButton } from "@/components/admin/coupons/coupon-status-button";
import { ReleaseRedemptionButton } from "@/components/admin/coupons/release-redemption-button";
import { AdminEmptyState, AdminErrorState } from "@/components/admin/states";
import { buttonVariants } from "@/components/ui/button";
import { requireAdmin } from "@/lib/admin/auth";
import {
  canManageCoupons,
  canReleaseRedemption,
  couponFinancials,
  couponLimitLabel,
  couponPanelError,
  couponScopeLabel,
  couponValidityLabel,
  isCouponsAdminEnabled,
  isCouponUuid,
  type AdminCouponDetail,
} from "@/lib/admin/coupons";
import { couponAdminData } from "@/lib/admin/coupons-server";
import { formatAdminDateTime, formatCurrency } from "@/lib/admin/format";
import { couponOverLimitLabel } from "@/lib/coupons/rules";
import { formatSessionDateTime } from "@/lib/sessions/date-time";
import { cn } from "@/lib/utils";

export const metadata = { title: "Cupom de desconto" };

/**
 * Detalhe do cupom: dados, utilizações por estado, valores e cada uso.
 *
 * Receita e descontos seguem a definição do relatório
 * (`discount_coupons_report.sql`): só usos confirmados. Pré-reserva aguardando
 * pagamento aparece à parte e nunca como receita. A liberação manual só é
 * oferecida ao ADMIN, e só para uso pago e depois cancelado — a regra do banco.
 */
export default async function AdminCouponDetailPage({ params }: { params: Promise<{ couponId: string }> }) {
  const context = await requireAdmin();
  if (!isCouponsAdminEnabled()) notFound();
  const { couponId } = await params;
  if (!isCouponUuid(couponId)) notFound();

  let coupon: AdminCouponDetail | null = null;
  let failure = "";
  try {
    coupon = await couponAdminData().get(context.profile.userId, couponId);
  } catch (error) {
    failure = couponPanelError(error).message;
  }
  const back = <Link href="/admin/marketing/cupons" className={buttonVariants({ variant: "ghost", size: "sm" })}><ArrowLeft className="size-4" /> Voltar aos cupons</Link>;
  if (failure) return <div>{back}<div className="mt-6"><AdminErrorState description={failure} /></div></div>;
  if (!coupon) notFound();

  const manager = canManageCoupons(context.profile.role);
  const money = couponFinancials(coupon.redemptions);
  const overLimit = couponOverLimitLabel(coupon);

  const fields: Array<[string, string]> = [
    ["Desconto", `${coupon.percentOff}% por participante`],
    ["Validade", couponValidityLabel(coupon.validFrom, coupon.validUntil)],
    ["Limite de utilizações", couponLimitLabel(coupon.maxUses)],
    ["Aplicabilidade", couponScopeLabel(coupon)],
    ["Status cadastrado", coupon.status === "ACTIVE" ? "Ativo" : "Inativo"],
    ["Criado em", formatAdminDateTime(coupon.createdAt)],
    ["Última alteração", formatAdminDateTime(coupon.updatedAt)],
  ];

  const metrics: Array<{ label: string; value: string; hint?: string; tone?: "alert" }> = [
    { label: "Utilizações contabilizadas", value: coupon.maxUses === null ? String(coupon.uses.counted) : `${coupon.uses.counted} de ${coupon.maxUses}`, hint: "Reservadas, confirmadas e pagas depois canceladas" },
    { label: "Reservadas", value: String(coupon.uses.reserved), hint: "Pré-reservas aguardando pagamento" },
    { label: "Confirmadas", value: String(coupon.uses.confirmed) },
    { label: "Pagas e canceladas", value: String(coupon.uses.cancelledAfterPayment), hint: "Contam até a liberação manual" },
    { label: "Liberadas", value: String(coupon.uses.released) },
    { label: "Pré-reservas expiradas", value: String(coupon.uses.lapsed), hint: "Expiradas ou canceladas sem pagamento" },
    { label: "Limite excedido", value: coupon.overLimit ? `${coupon.excessCount}` : "Não", hint: coupon.overLimit ? "Utilizações pagas além do limite" : undefined, tone: coupon.overLimit ? "alert" : undefined },
  ];

  return (
    <div>
      {back}
      <header className="mt-6 flex flex-col gap-6 border-b border-ink/10 pb-7 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-lake">Marketing · Cupom de desconto</p>
          <h1 className="mt-3 font-mono text-3xl font-semibold tracking-wide text-ink sm:text-4xl">{coupon.code}</h1>
          <div className="mt-4 flex flex-wrap gap-2">
            <CouponStateBadge state={coupon.state} />
            <CouponOverLimitBadge overLimit={coupon.overLimit} excessCount={coupon.excessCount} />
          </div>
          {coupon.description ? <p className="mt-4 max-w-2xl text-sm leading-6 text-ink/60">{coupon.description}</p> : null}
        </div>
        {manager ? (
          <div className="flex shrink-0 flex-wrap gap-3">
            <CouponStatusButton couponId={coupon.id} code={coupon.code} status={coupon.status} />
            <Link href={`/admin/marketing/cupons/${coupon.id}/editar`} className={buttonVariants({ size: "sm" })}><Pencil className="size-4" /> Editar</Link>
          </div>
        ) : null}
      </header>

      {overLimit ? (
        <section role="alert" className="mt-6 flex items-start gap-3 rounded-3xl border border-orange-200 bg-orange-50 p-5">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-orange-700" aria-hidden />
          <div>
            <h2 className="text-sm font-semibold text-orange-950">{overLimit}</h2>
            <p className="mt-1 text-sm leading-6 text-orange-900/80">
              Um pagamento foi confirmado depois que a vaga do cupom já tinha sido ocupada por outra reserva. O pagamento vale pelo valor com desconto; as utilizações além do limite estão marcadas na tabela. Novas utilizações seguem recusadas enquanto não houver vaga no limite.
            </p>
          </div>
        </section>
      ) : null}

      <dl className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Dados do cupom">
        {fields.map(([label, value]) => <div key={label} className="rounded-3xl border border-ink/10 bg-white p-5"><dt className="text-xs font-medium text-ink/45">{label}</dt><dd className="mt-2 break-words text-sm font-semibold leading-6 text-ink">{value}</dd></div>)}
      </dl>

      {coupon.scope === "SELECTED" ? (
        <section className="mt-6 rounded-3xl border border-ink/10 bg-white p-6">
          <h2 className="text-sm font-semibold">Experiências elegíveis</h2>
          <ul className="mt-4 flex flex-wrap gap-2">
            {coupon.experiences.map((item) => (
              <li key={item.id} className="rounded-full bg-mist px-3 py-1.5 text-xs font-medium text-ink/75">{item.title}{item.kind === "EVENT" ? " · evento especial" : ""}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-8" aria-labelledby="coupon-usage">
        <h2 id="coupon-usage" className="text-lg font-semibold">Utilizações</h2>
        <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4 xl:grid-cols-7">
          {metrics.map((item) => (
            <div key={item.label} className={cn("rounded-3xl border bg-white p-5", item.tone === "alert" ? "border-orange-200" : "border-ink/10")}>
              <dt className="text-xs font-medium text-ink/45">{item.label}</dt>
              <dd className={cn("mt-2 text-2xl font-semibold tracking-[-0.03em]", item.tone === "alert" ? "text-orange-800" : "text-ink")}>{item.value}</dd>
              {item.hint ? <p className="mt-1 text-[11px] leading-4 text-ink/45">{item.hint}</p> : null}
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-8" aria-labelledby="coupon-money">
        <h2 id="coupon-money" className="text-lg font-semibold">Valores</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-3">
          <div className="rounded-3xl border border-ink/10 bg-white p-5"><dt className="text-xs font-medium text-ink/45">Receita confirmada</dt><dd className="mt-2 text-2xl font-semibold tracking-[-0.03em]">{formatCurrency(money.revenueConfirmedCents)}</dd><p className="mt-1 text-[11px] leading-4 text-ink/45">Valor efetivamente cobrado nas reservas confirmadas</p></div>
          <div className="rounded-3xl border border-ink/10 bg-white p-5"><dt className="text-xs font-medium text-ink/45">Descontos concedidos</dt><dd className="mt-2 text-2xl font-semibold tracking-[-0.03em]">{formatCurrency(money.discountConfirmedCents)}</dd><p className="mt-1 text-[11px] leading-4 text-ink/45">O que deixou de ser cobrado nessas mesmas reservas</p></div>
          <div className="rounded-3xl border border-dashed border-ink/15 bg-white p-5"><dt className="text-xs font-medium text-ink/45">Aguardando pagamento</dt><dd className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-ink/60">{formatCurrency(money.pendingTotalCents)}</dd><p className="mt-1 text-[11px] leading-4 text-ink/45">{money.pendingCount} {money.pendingCount === 1 ? "pré-reserva" : "pré-reservas"} — não é receita</p></div>
        </dl>
      </section>

      <section className="mt-8" aria-labelledby="coupon-redemptions">
        <h2 id="coupon-redemptions" className="text-lg font-semibold">Histórico de utilizações</h2>
        <p className="mt-1 text-sm text-ink/50">Os valores ficam congelados no momento da compra. Alterar ou desativar o cupom não muda nenhuma linha daqui.</p>
        {coupon.redemptions.length === 0 ? (
          <div className="mt-4"><AdminEmptyState title="Nenhuma utilização ainda" description="Quando um cliente reservar com este cupom, a reserva aparece aqui com o valor original, o desconto e o valor final." /></div>
        ) : (
          <div className="mt-4 overflow-hidden rounded-3xl border border-ink/10 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="hidden bg-mist/50 text-xs uppercase tracking-[0.12em] text-ink/55 xl:table-header-group">
                <tr>
                  <th className="px-5 py-3 font-semibold">Reserva</th>
                  <th className="px-5 py-3 font-semibold">Experiência</th>
                  <th className="px-5 py-3 font-semibold">Data</th>
                  <th className="px-5 py-3 font-semibold">Status</th>
                  <th className="px-5 py-3 text-right font-semibold">Original</th>
                  <th className="px-5 py-3 text-right font-semibold">Desconto</th>
                  <th className="px-5 py-3 text-right font-semibold">Final</th>
                  <th className="px-5 py-3"><span className="sr-only">Ações</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink/10">
                {coupon.redemptions.map((item) => (
                  <tr key={item.id} className={cn("grid gap-2 p-5 xl:table-row xl:p-0", item.overLimit ? "bg-orange-50/50" : "")}>
                    <td className="xl:px-5 xl:py-4">
                      <Link href={`/admin/reservas/${item.reservationId}`} className="font-mono text-sm font-semibold tracking-wide text-lake hover:underline">{item.publicCode || item.reservationId.slice(0, 8)}</Link>
                      <p className="text-xs text-ink/45">{item.quantity} {item.quantity === 1 ? "participante" : "participantes"} · {formatAdminDateTime(item.createdAt)}</p>
                    </td>
                    <td className="xl:px-5 xl:py-4">{item.experienceTitle || "—"}</td>
                    <td className="text-ink/70 xl:px-5 xl:py-4"><span className="text-ink/45 xl:hidden">Turma: </span>{item.startsAt ? formatSessionDateTime(item.startsAt) : "—"}</td>
                    <td className="xl:px-5 xl:py-4">
                      <div className="flex flex-wrap gap-1.5">
                        <RedemptionStateBadge state={item.state} />
                        {item.overLimit ? <span className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-2.5 py-1 text-xs font-semibold text-orange-800 ring-1 ring-inset ring-orange-600/20"><AlertTriangle className="size-3.5" aria-hidden /> Além do limite</span> : null}
                      </div>
                      {item.releasedAt ? <p className="mt-1 text-xs text-ink/50">Liberada em {formatAdminDateTime(item.releasedAt)}{item.releasedByName ? ` por ${item.releasedByName}` : ""}{item.releasedReason ? ` — ${item.releasedReason}` : ""}</p> : null}
                    </td>
                    <td className="text-ink/70 xl:px-5 xl:py-4 xl:text-right"><span className="text-ink/45 xl:hidden">Original: </span>{formatCurrency(item.originalTotalCents)}</td>
                    <td className="text-ink/70 xl:px-5 xl:py-4 xl:text-right"><span className="text-ink/45 xl:hidden">Desconto: </span>− {formatCurrency(item.discountCents)}</td>
                    <td className="font-semibold xl:px-5 xl:py-4 xl:text-right"><span className="font-normal text-ink/45 xl:hidden">Final: </span>{formatCurrency(item.totalCents)}</td>
                    <td className="xl:px-5 xl:py-4 xl:text-right">
                      {manager && canReleaseRedemption(item) ? <ReleaseRedemptionButton redemptionId={item.id} publicCode={item.publicCode} /> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
