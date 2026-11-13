import { NextResponse } from "next/server";

import { authorizeCouponsApi, isSameOriginRequest } from "@/lib/admin/http";
import { couponPanelError, isCouponUuid } from "@/lib/admin/coupons";
import { handleCouponUpdate } from "@/lib/admin/coupons-data";
import { couponAdminData } from "@/lib/admin/coupons-server";

type RouteContext = { params: Promise<{ couponId: string }> };

const NO_STORE = { "cache-control": "no-store" };

/**
 * Edição de um cupom. Só ADMIN.
 *
 * O corpo traz a versão que o formulário abriu (`expectedUpdatedAt`): se o
 * cupom mudou nesse meio-tempo, 409 em vez de sobrescrever. Depois do primeiro
 * uso, código, percentual e aplicabilidade são recusados aqui e no banco; o
 * limite nunca desce abaixo dos usos contados. O status muda pela rota
 * `status`, com auditoria própria.
 */
export async function PATCH(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403, headers: NO_STORE });
  }
  const authorization = await authorizeCouponsApi({ manage: true });
  if (!authorization.context) return authorization.response;

  const { couponId } = await context.params;
  if (!isCouponUuid(couponId)) return NextResponse.json({ message: "Cupom inválido." }, { status: 400, headers: NO_STORE });

  const body: unknown = await request.json().catch(() => null);
  try {
    const { userId, role } = authorization.context.profile;
    const result = await handleCouponUpdate(couponAdminData(), { userId, role }, couponId, body);
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
  } catch (error) {
    const mapped = couponPanelError(error);
    return NextResponse.json({ message: mapped.message }, { status: mapped.status, headers: NO_STORE });
  }
}
