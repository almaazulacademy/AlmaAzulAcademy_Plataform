import { NextResponse } from "next/server";

import { authorizeStandbyApi, isSameOriginRequest, standbyMutationError } from "@/lib/admin/http";
import { validateStandbyEntry } from "@/lib/admin/standby";
import { getStandbyOptions, setReservationStandby } from "@/lib/admin/standby-data";
import { isUuid } from "@/lib/admin/validation";
import { isRescheduleEmailActive } from "@/lib/reservations/reschedule-email-service";

type RouteContext = { params: Promise<{ reservationId: string }> };

/**
 * Situação de uma reserva em Stand-by: a turma original, se dá para desfazer e
 * as turmas elegíveis para reagendar.
 *
 * Leitura pura, consultada quando o modal abre. Sem verificação de origem, como
 * as demais leituras do painel: um GET do mesmo domínio não carrega `Origin` e
 * não há efeito colateral a proteger. A autorização administrativa é exigida.
 */
export async function GET(_request: Request, context: RouteContext) {
  const authorization = await authorizeStandbyApi();
  if (!authorization.context) return authorization.response;

  const { reservationId } = await context.params;
  if (!isUuid(reservationId)) return NextResponse.json({ message: "Reserva inválida." }, { status: 400 });

  try {
    const options = await getStandbyOptions(authorization.context.profile.userId, reservationId);
    if (!options) return NextResponse.json({ message: "Reserva não encontrada." }, { status: 404 });
    // O modal diz ao admin, antes de confirmar, se o cliente será avisado por e-mail.
    return NextResponse.json({ ...options, rescheduleEmailEnabled: isRescheduleEmailActive() }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const failure = standbyMutationError(error);
    return NextResponse.json({ message: failure.message }, { status: failure.status });
  }
}

/**
 * "Colocar em Stand-by": tira uma reserva confirmada e paga da turma original.
 *
 * Este handler valida sessão administrativa, origem e payload — motivo e
 * confirmação explícita — e entrega a decisão a `admin_set_reservation_standby`,
 * que recusa reserva não confirmada, sem pagamento confirmado ou com presença
 * registrada. A resposta 200 significa que o Supabase já gravou.
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
  const validation = validateStandbyEntry(body);
  if (!validation.success) {
    return NextResponse.json({ message: Object.values(validation.errors)[0], errors: validation.errors }, { status: 400 });
  }

  try {
    const entry = await setReservationStandby(authorization.context.profile.userId, reservationId, validation.data.reason);
    return entry
      ? NextResponse.json({ success: true, standbyId: entry.standbyId })
      : NextResponse.json({ message: "Reserva não encontrada." }, { status: 404 });
  } catch (error) {
    const failure = standbyMutationError(error);
    return NextResponse.json({ message: failure.message }, { status: failure.status });
  }
}
