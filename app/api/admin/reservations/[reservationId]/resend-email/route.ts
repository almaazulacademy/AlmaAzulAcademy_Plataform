import { NextResponse } from "next/server";

import { authorizeAdminApi, isSameOriginRequest } from "@/lib/admin/http";
import { isUuid } from "@/lib/admin/validation";
import { sendReservationConfirmationEmail } from "@/lib/reservations/confirmation-email-service";

type RouteContext = { params: Promise<{ reservationId: string }> };

/**
 * "Reenviar e-mail" no detalhe da reserva.
 *
 * Seguro por construção: a decisão de enviar é do banco, não deste endpoint.
 * Se o e-mail já foi enviado, a reivindicação devolve null e a resposta diz
 * exatamente isso — clicar dez vezes não gera dez e-mails. Se a reserva não
 * estiver confirmada, também não envia.
 */
const MESSAGES = {
  SENT: "E-mail de confirmação enviado.",
  SKIPPED: "Nada a enviar: este e-mail já foi enviado ou a reserva não está confirmada.",
  PENDING: "Não foi possível enviar agora. O envio ficou pendente e será tentado de novo.",
  DISABLED: "O provedor de e-mail não está configurado neste ambiente.",
} as const;

export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const authorization = await authorizeAdminApi();
  if (!authorization.context) return authorization.response;

  const { reservationId } = await context.params;
  if (!isUuid(reservationId)) return NextResponse.json({ message: "Reserva inválida." }, { status: 400 });

  const result = await sendReservationConfirmationEmail(reservationId);
  const status = result.outcome === "DISABLED" ? 503 : result.outcome === "PENDING" ? 503 : 200;

  return NextResponse.json(
    {
      success: result.outcome === "SENT",
      outcome: result.outcome,
      errorCode: result.errorCode,
      message: MESSAGES[result.outcome],
    },
    { status },
  );
}
