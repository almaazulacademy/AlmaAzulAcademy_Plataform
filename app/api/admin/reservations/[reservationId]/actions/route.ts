import { NextResponse } from "next/server";

import { cancelAdminReservation, confirmAdminReservation } from "@/lib/admin/data";
import { adminMutationError, authorizeAdminApi, isSameOriginRequest } from "@/lib/admin/http";
import { isUuid, validateReservationAdminAction } from "@/lib/admin/validation";

type RouteContext = { params: Promise<{ reservationId: string }> };

export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const authorization = await authorizeAdminApi();
  if (!authorization.context) return authorization.response;
  const { reservationId } = await context.params;
  if (!isUuid(reservationId)) return NextResponse.json({ message: "Reserva inválida." }, { status: 400 });

  const body: unknown = await request.json().catch(() => null);
  const validation = validateReservationAdminAction(body);
  if (!validation.success) return NextResponse.json({ errors: validation.errors }, { status: 400 });

  try {
    const success = validation.data.action === "CONFIRM_PAYMENT"
      ? await confirmAdminReservation(authorization.context.profile.userId, reservationId, validation.data.reason)
      : await cancelAdminReservation(authorization.context.profile.userId, reservationId, validation.data.reason);
    return success
      ? NextResponse.json({ success: true })
      : NextResponse.json({ message: "Reserva não encontrada." }, { status: 404 });
  } catch (error) {
    const failure = adminMutationError(error);
    return NextResponse.json({ message: failure.message }, { status: failure.status });
  }
}
