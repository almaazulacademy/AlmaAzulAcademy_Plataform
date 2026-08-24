import { NextResponse } from "next/server";

import { changeAdminReservationSession } from "@/lib/admin/data";
import { adminMutationError, authorizeAdminApi, isSameOriginRequest } from "@/lib/admin/http";
import { isUuid, validateReservationSessionChange } from "@/lib/admin/validation";

type RouteContext = { params: Promise<{ reservationId: string }> };

/**
 * "Alterar turma": move uma reserva confirmada para outra sessão.
 *
 * Este handler não decide nada sobre vagas. Ele valida sessão administrativa,
 * origem e payload, e entrega a decisão a `admin_change_reservation_session`,
 * que trava as duas sessões e recalcula a ocupação real antes de mover.
 *
 * A resposta 200 significa que o Supabase já gravou a mudança. A planilha é
 * atualizada depois, dentro da camada de dados, e uma falha do Google não
 * desfaz nem a mudança nem o pagamento.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const authorization = await authorizeAdminApi();
  if (!authorization.context) return authorization.response;

  const { reservationId } = await context.params;
  if (!isUuid(reservationId)) return NextResponse.json({ message: "Reserva inválida." }, { status: 400 });

  const body: unknown = await request.json().catch(() => null);
  const validation = validateReservationSessionChange(body);
  if (!validation.success) return NextResponse.json({ errors: validation.errors }, { status: 400 });

  try {
    const change = await changeAdminReservationSession(
      authorization.context.profile.userId,
      reservationId,
      validation.data.targetSessionId,
      validation.data.reason,
    );
    return change
      ? NextResponse.json({ success: true, change })
      : NextResponse.json({ message: "Reserva não encontrada." }, { status: 404 });
  } catch (error) {
    const failure = adminMutationError(error);
    return NextResponse.json({ message: failure.message }, { status: failure.status });
  }
}
