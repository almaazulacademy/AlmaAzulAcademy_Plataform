import { AlertTriangle } from "lucide-react";

import { COUPON_STATE_LABELS, REDEMPTION_STATE_LABELS, type RedemptionState } from "@/lib/admin/coupons";
import { couponOverLimitLabel, type CouponState } from "@/lib/coupons/rules";
import { cn } from "@/lib/utils";

const STATE_STYLES: Record<CouponState, string> = {
  ACTIVE: "bg-emerald-50 text-emerald-800 ring-emerald-600/15",
  INACTIVE: "bg-slate-100 text-slate-700 ring-slate-500/15",
  SCHEDULED: "bg-sky-50 text-sky-800 ring-sky-600/15",
  EXPIRED: "bg-red-50 text-red-800 ring-red-600/15",
  EXHAUSTED: "bg-amber-50 text-amber-800 ring-amber-600/15",
};

const REDEMPTION_STYLES: Record<RedemptionState, string> = {
  RESERVED: "bg-amber-50 text-amber-800 ring-amber-600/15",
  CONFIRMED: "bg-emerald-50 text-emerald-800 ring-emerald-600/15",
  CANCELLED_AFTER_PAYMENT: "bg-red-50 text-red-800 ring-red-600/15",
  RELEASED: "bg-slate-100 text-slate-700 ring-slate-500/15",
  LAPSED: "bg-slate-100 text-slate-700 ring-slate-500/15",
};

const BADGE = "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset";

/** Situação operacional do cupom (`state`). */
export function CouponStateBadge({ state, className }: { state: CouponState; className?: string }) {
  return <span className={cn(BADGE, STATE_STYLES[state], className)}>{COUPON_STATE_LABELS[state]}</span>;
}

/**
 * Alerta de limite excedido. Independe da situação: aparece com o cupom ativo,
 * inativo, expirado, agendado ou esgotado, sempre que houver uso pago além do
 * limite.
 */
export function CouponOverLimitBadge({ overLimit, excessCount, className }: { overLimit: boolean; excessCount: number; className?: string }) {
  const label = couponOverLimitLabel({ overLimit, excessCount });
  if (!label) return null;
  return (
    <span className={cn(BADGE, "bg-orange-50 text-orange-800 ring-orange-600/20", className)}>
      <AlertTriangle className="size-3.5" aria-hidden /> {label}
    </span>
  );
}

export function RedemptionStateBadge({ state }: { state: RedemptionState }) {
  return <span className={cn(BADGE, REDEMPTION_STYLES[state])}>{REDEMPTION_STATE_LABELS[state]}</span>;
}
