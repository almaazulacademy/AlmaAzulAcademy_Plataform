import { NextResponse } from "next/server";

import { authorizeStandbyApi, isSameOriginRequest, standbyMutationError } from "@/lib/admin/http";
import { validateStandbyReschedule } from "@/lib/admin/standby";
import { rescheduleReservationFromStandby } from "@/lib/admin/standby-data";
import { isUuid } from "@/lib/admin/validation";

type RouteContext = { params: Promise<{ reservationId: string }> };

/**
 * "Reagendar": move uma reserva em Stand-by para uma nova turma.
 *
 * O corpo traz só a turma escolhida e um motivo opcional. Quantidade, valor e
 * pagamento não são parâmetros: são os da reserva e não mudam. A turma precisa
 * estar aberta, no futuro, publicada, com vagas para o grupo e custar por
 * participante exatamente o valor pago — a régua é de
 * `admin_reschedule_standby_same_price`, não deste handler.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const authorization = await authorizeStandbyApi();
  if (!authorization.context) return authorization.response;

  const { reservationId } = await context.params;
  if (!isUuid(reservationId)) return NextResponse.json({ message: "Reserva inválida." }, { status: 400 });

  const body: unknown = await request.json().catch(() => null);
  const validation = validateStandbyReschedule(body);
  if (!validation.success) {
    return NextResponse.json({ message: Object.values(validation.errors)[0], errors: validation.errors }, { status: 400 });
  }

  try {
    const resolution = await rescheduleReservationFromStandby(
      authorization.context.profile.userId,
      reservationId,
      validation.data.targetSessionId,
      validation.data.reason,
    );
    return resolution
      ? NextResponse.json({ success: true, resolution })
      : NextResponse.json({ message: "Reserva não encontrada." }, { status: 404 });
  } catch (error) {
    const failure = standbyMutationError(error);
    return NextResponse.json({ message: failure.message }, { status: failure.status });
  }
}
