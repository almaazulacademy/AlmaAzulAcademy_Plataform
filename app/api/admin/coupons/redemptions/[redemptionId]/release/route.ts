import { NextResponse } from "next/server";

import { authorizeCouponsApi, isSameOriginRequest } from "@/lib/admin/http";
import { couponPanelError, isCouponUuid } from "@/lib/admin/coupons";
import { handleCouponRelease } from "@/lib/admin/coupons-data";
import { couponAdminData } from "@/lib/admin/coupons-server";

type RouteContext = { params: Promise<{ redemptionId: string }> };

const NO_STORE = { "cache-control": "no-store" };

/**
 * Liberação manual de uma utilização. Só ADMIN, com justificativa e
 * confirmação explícita. O banco só libera uso de reserva paga e depois
 * cancelada; reserva, pagamento e valores não mudam — o uso só deixa de contar
 * no limite, e a liberação fica na auditoria.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403, headers: NO_STORE });
  }
  const authorization = await authorizeCouponsApi({ manage: true });
  if (!authorization.context) return authorization.response;

  const { redemptionId } = await context.params;
  if (!isCouponUuid(redemptionId)) return NextResponse.json({ message: "Utilização inválida." }, { status: 400, headers: NO_STORE });

  const body: unknown = await request.json().catch(() => null);
  try {
    const { userId, role } = authorization.context.profile;
    const result = await handleCouponRelease(couponAdminData(), { userId, role }, redemptionId, body);
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
  } catch (error) {
    const mapped = couponPanelError(error);
    return NextResponse.json({ message: mapped.message }, { status: mapped.status, headers: NO_STORE });
  }
}
