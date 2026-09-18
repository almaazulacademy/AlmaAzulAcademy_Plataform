import { NextResponse } from "next/server";

import { authorizeAdminApi, isSameOriginRequest } from "@/lib/admin/http";
import { isUuid } from "@/lib/admin/validation";
import { sendCheckinReminderEmail } from "@/lib/reservations/confirmation-email-service";

type RouteContext = { params: Promise<{ reservationId: string }> };

const MESSAGES = {
  SENT: "QR Code enviado com sucesso.",
  DISABLED: "O provedor de e-mail não está configurado neste ambiente.",
  NOT_AVAILABLE: "Só reservas confirmadas têm QR Code para reenviar.",
  FAILED: "Não foi possível enviar agora. Tente novamente em instantes.",
} as const;

/**
 * "Reenviar QR Code" no detalhe da reserva. Envia para o e-mail já cadastrado,
 * com o mesmo token de sempre — nunca gera outro QR.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const authorization = await authorizeAdminApi();
  if (!authorization.context) return authorization.response;

  const { reservationId } = await context.params;
  if (!isUuid(reservationId)) return NextResponse.json({ message: "Reserva inválida." }, { status: 400 });

  const result = await sendCheckinReminderEmail(authorization.context.profile.userId, reservationId);
  const status = result.outcome === "SENT" ? 200 : result.outcome === "NOT_AVAILABLE" ? 409 : 503;
  return NextResponse.json(
    { success: result.outcome === "SENT", outcome: result.outcome, errorCode: result.errorCode, message: MESSAGES[result.outcome] },
    { status },
  );
}
