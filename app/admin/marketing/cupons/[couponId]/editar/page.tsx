import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { CouponForm } from "@/components/admin/coupons/coupon-form";
import { AdminPageHeader } from "@/components/admin/page-header";
import { AdminErrorState } from "@/components/admin/states";
import { buttonVariants } from "@/components/ui/button";
import { requireAdmin } from "@/lib/admin/auth";
import { canManageCoupons, couponPanelError, couponSummary, isCouponsAdminEnabled, isCouponUuid, type AdminCouponDetail, type CouponExperienceOption } from "@/lib/admin/coupons";
import { couponAdminData } from "@/lib/admin/coupons-server";

export const metadata = { title: "Editar cupom" };

/**
 * Edição de cupom. Só ADMIN: o OPERATOR volta para o detalhe (e a rota o
 * recusa de qualquer forma). Num cupom já utilizado, o formulário mostra os
 * campos bloqueados com a explicação.
 */
export default async function EditCouponPage({ params }: { params: Promise<{ couponId: string }> }) {
  const context = await requireAdmin();
  if (!isCouponsAdminEnabled()) notFound();
  const { couponId } = await params;
  if (!isCouponUuid(couponId)) notFound();
  if (!canManageCoupons(context.profile.role)) redirect(`/admin/marketing/cupons/${couponId}`);

  let coupon: AdminCouponDetail | null = null;
  let experiences: CouponExperienceOption[] = [];
  let failure = "";
  try {
    const data = couponAdminData();
    [coupon, experiences] = await Promise.all([data.get(context.profile.userId, couponId), data.experiences(context.profile.userId)]);
  } catch (error) {
    failure = couponPanelError(error).message;
  }
  if (!failure && !coupon) notFound();

  return (
    <div>
      <Link href={`/admin/marketing/cupons/${couponId}`} className={buttonVariants({ variant: "ghost", size: "sm" })}><ArrowLeft className="size-4" /> Voltar ao cupom</Link>
      <div className="mt-6">
        <AdminPageHeader eyebrow="Marketing" title={coupon ? `Editar ${coupon.code}` : "Editar cupom"} description="As alterações valem para as próximas utilizações. Reservas já feitas com o cupom mantêm os valores registrados." />
      </div>
      {coupon ? <CouponForm mode="edit" experiences={experiences} coupon={couponSummary(coupon)} /> : <div className="mt-8"><AdminErrorState description={failure} /></div>}
    </div>
  );
}
