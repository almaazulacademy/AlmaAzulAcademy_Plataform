import { NextResponse } from "next/server";

import { authorizeStandbyApi, isSameOriginRequest, standbyMutationError } from "@/lib/admin/http";
import { validateStandbyUndo } from "@/lib/admin/standby";
import { undoReservationStandby } from "@/lib/admin/standby-data";
import { isUuid } from "@/lib/admin/validation";

type RouteContext = { params: Promise<{ reservationId: string }> };

/**
 * "Desfazer Stand-by": devolve a reserva à turma original.
 *
 * Só acontece se a turma original estiver aberta, ainda não tiver começado e
 * tiver vagas para o grupo inteiro — quem confere é
 * `admin_undo_reservation_standby`, com a sessão travada. Quando não dá, a
 * operação é recusada e o Stand-by continua aberto, intacto.
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
  const validation = validateStandbyUndo(body);
  if (!validation.success) {
    return NextResponse.json({ message: Object.values(validation.errors)[0], errors: validation.errors }, { status: 400 });
  }

  try {
    const resolution = await undoReservationStandby(authorization.context.profile.userId, reservationId, validation.data.reason);
    return resolution
      ? NextResponse.json({ success: true, resolution })
      : NextResponse.json({ message: "Reserva não encontrada." }, { status: 404 });
  } catch (error) {
    const failure = standbyMutationError(error);
    return NextResponse.json({ message: failure.message }, { status: failure.status });
  }
}
