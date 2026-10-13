import { NextResponse } from "next/server";

import { authorizeStandbyApi, isSameOriginRequest } from "@/lib/admin/http";
import { isUuid } from "@/lib/admin/validation";
import { resendRescheduleConfirmationEmail } from "@/lib/reservations/reschedule-email-service";

type RouteContext = { params: Promise<{ reservationId: string }> };

/**
 * "Reenviar e-mail de reagendamento" no detalhe da reserva.
 *
 * Seguro por construção: a decisão de enviar é do banco, não deste endpoint. O
 * que ele pede é o e-mail do reagendamento mais recente da reserva — e só sai
 * se ainda não foi enviado, não está sendo enviado agora e a reserva continua
 * confirmada naquela turma. Clicar dez vezes não gera dez e-mails, e nenhum
 * caminho daqui reenvia o e-mail de pagamento.
 */
const MESSAGES = {
  SENT: "E-mail de confirmação do reagendamento enviado.",
  SKIPPED: "Nada a enviar: o e-mail já foi enviado, está em andamento ou a reserva não está mais naquela turma.",
  PENDING: "Não foi possível enviar agora: o cliente continua sem a confirmação. O envio ficou pendente.",
  DISABLED: "O e-mail de reagendamento não está ativado neste ambiente.",
} as const;

export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const authorization = await authorizeStandbyApi();
  if (!authorization.context) return authorization.response;

  const { reservationId } = await context.params;
  if (!isUuid(reservationId)) return NextResponse.json({ message: "Reserva inválida." }, { status: 400 });

  const result = await resendRescheduleConfirmationEmail(authorization.context.profile.userId, reservationId);
  const status = result.outcome === "DISABLED" || result.outcome === "PENDING" ? 503 : 200;

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
