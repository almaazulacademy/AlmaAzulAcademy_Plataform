import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { CouponForm } from "@/components/admin/coupons/coupon-form";
import { AdminPageHeader } from "@/components/admin/page-header";
import { AdminErrorState } from "@/components/admin/states";
import { buttonVariants } from "@/components/ui/button";
import { requireAdmin } from "@/lib/admin/auth";
import { canManageCoupons, couponPanelError, isCouponsAdminEnabled, type CouponExperienceOption } from "@/lib/admin/coupons";
import { couponAdminData } from "@/lib/admin/coupons-server";

export const metadata = { title: "Novo cupom" };

/** Novo cupom. Só ADMIN: o OPERATOR volta para a lista (e a rota o recusa de qualquer forma). */
export default async function NewCouponPage() {
  const context = await requireAdmin();
  if (!isCouponsAdminEnabled()) notFound();
  if (!canManageCoupons(context.profile.role)) redirect("/admin/marketing/cupons");

  let experiences: CouponExperienceOption[] | null = null;
  let failure = "";
  try {
    experiences = await couponAdminData().experiences(context.profile.userId);
  } catch (error) {
    failure = couponPanelError(error).message;
  }

  return (
    <div>
      <Link href="/admin/marketing/cupons" className={buttonVariants({ variant: "ghost", size: "sm" })}><ArrowLeft className="size-4" /> Voltar aos cupons</Link>
      <div className="mt-6">
        <AdminPageHeader eyebrow="Marketing" title="Novo cupom" description="O desconto é percentual, por participante, e o cupom vale uma vez por reserva. Nada é aplicado automaticamente: o cliente digita o código." />
      </div>
      {experiences ? <CouponForm mode="create" experiences={experiences} /> : <div className="mt-8"><AdminErrorState description={failure} /></div>}
    </div>
  );
}
