import { NextResponse } from "next/server";

import { authorizeAdminApi, isSameOriginRequest } from "@/lib/admin/http";
import { isUuid } from "@/lib/admin/validation";
import { logPayment, newRequestId } from "@/lib/payments/observability";
import { confirmPayment, type ConfirmationOutcome } from "@/lib/reservations/payment-confirmation";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

type RouteContext = { params: Promise<{ reservationId: string }> };

/**
 * "Verificar pagamento": consulta o payment_check da InfinitePay e confirma a
 * reserva somente se o gateway disser que está paga. Diferente de
 * `admin_confirm_reservation_manually`, que confia no julgamento do operador,
 * esta ação não confirma nada por conta própria.
 */
const MESSAGES: Record<ConfirmationOutcome, string> = {
  CONFIRMED: "Pagamento verificado na InfinitePay e reserva confirmada.",
  ALREADY_CONFIRMED: "Esta reserva já estava confirmada.",
  RECONCILED: "Pagamento confirmado na InfinitePay fora do prazo de retenção. A vaga foi recuperada porque a sessão ainda tem capacidade.",
  NO_CAPACITY: "O pagamento existe na InfinitePay, mas a sessão já lotou. Não confirmei para não gerar overbooking — trate manualmente (realocação ou estorno).",
  NOT_PAID: "A InfinitePay ainda não reconhece este pagamento como pago.",
  AMOUNT_MISMATCH: "O valor pago na InfinitePay não corresponde ao total da reserva. Verifique antes de confirmar.",
  RESERVATION_NOT_FOUND: "Reserva não encontrada.",
  CANCELLED: "Reserva cancelada. Não é possível confirmar automaticamente.",
  PROVIDER_UNAVAILABLE: "Não foi possível falar com a InfinitePay agora. Tente novamente em alguns instantes.",
};

export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const authorization = await authorizeAdminApi();
  if (!authorization.context) return authorization.response;

  const { reservationId } = await context.params;
  if (!isUuid(reservationId)) return NextResponse.json({ message: "Reserva inválida." }, { status: 400 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ message: "Supabase administrativo não configurado." }, { status: 503 });

  const body: unknown = await request.json().catch(() => null);
  const transactionId = body && typeof body === "object" && typeof (body as Record<string, unknown>).transactionId === "string"
    ? ((body as Record<string, unknown>).transactionId as string).trim()
    : "";

  const reservation = await admin
    .from("reservations")
    .select("id,provider_reference")
    .eq("id", reservationId)
    .maybeSingle();
  if (reservation.error || !reservation.data) {
    return NextResponse.json({ message: MESSAGES.RESERVATION_NOT_FOUND }, { status: 404 });
  }

  const requestId = newRequestId();
  try {
    const confirmation = await confirmPayment({
      orderId: reservationId,
      transactionId,
      invoiceSlug: typeof reservation.data.provider_reference === "string" ? reservation.data.provider_reference : "",
      payload: { source: "admin_verification", actor_user_id: authorization.context.profile.userId },
      requestId,
      stage: "admin_verification",
    });
    return NextResponse.json({
      success: confirmation.confirmed,
      outcome: confirmation.outcome,
      message: MESSAGES[confirmation.outcome],
    });
  } catch (error) {
    logPayment({
      requestId,
      stage: "admin_verification",
      outcome: "failed",
      orderId: reservationId,
      errorCode: error instanceof Error ? error.name : "UNKNOWN_ERROR",
    });
    return NextResponse.json({ message: MESSAGES.PROVIDER_UNAVAILABLE }, { status: 503 });
  }
}
