import { NextResponse } from "next/server";

import { authorizeCouponsApi, isSameOriginRequest } from "@/lib/admin/http";
import { couponPanelError } from "@/lib/admin/coupons";
import { handleCouponCreate } from "@/lib/admin/coupons-data";
import { couponAdminData } from "@/lib/admin/coupons-server";

const NO_STORE = { "cache-control": "no-store" };

/**
 * "Novo cupom" (Marketing → Cupons de desconto). Só ADMIN.
 *
 * Valida origem, a variável do painel, a sessão e o papel, e entrega o pedido a
 * `admin_create_coupon`, que confere tudo de novo e grava a auditoria. O ator
 * vem da sessão, nunca do corpo.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403, headers: NO_STORE });
  }
  const authorization = await authorizeCouponsApi({ manage: true });
  if (!authorization.context) return authorization.response;

  const body: unknown = await request.json().catch(() => null);
  try {
    const { userId, role } = authorization.context.profile;
    const result = await handleCouponCreate(couponAdminData(), { userId, role }, body);
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
  } catch (error) {
    const mapped = couponPanelError(error);
    return NextResponse.json({ message: mapped.message }, { status: mapped.status, headers: NO_STORE });
  }
}
