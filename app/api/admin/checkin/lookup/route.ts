import { NextResponse } from "next/server";

import { authorizeCheckinApi } from "@/lib/admin/http";
import { isUuid } from "@/lib/admin/validation";
import { lookupCheckin } from "@/lib/checkin/data";
import { checkinErrorResponse } from "@/lib/checkin/parse";
import { extractCheckinToken } from "@/lib/checkin/token";

/**
 * Localiza a reserva de um QR lido (ou de um id, no check-in manual).
 * Só leitura: nunca registra presença.
 */
export async function GET(request: Request) {
  const authorization = await authorizeCheckinApi();
  if (!authorization.context) return authorization.response;

  const params = new URL(request.url).searchParams;
  const scanned = params.get("code") ?? "";
  const reservationId = params.get("reservationId") ?? "";
  const token = scanned ? extractCheckinToken(scanned) : null;

  if (!token && !isUuid(reservationId)) {
    return NextResponse.json({ code: "INVALID_QR", message: "Este QR Code não é de uma reserva da Alma Azul." }, { status: 400 });
  }

  try {
    const reservation = await lookupCheckin(
      authorization.context.profile.userId,
      token ? { token } : { reservationId },
    );
    if (!reservation) {
      return NextResponse.json({ code: "NOT_FOUND", message: "Nenhuma reserva encontrada para este QR Code." }, { status: 404 });
    }
    return NextResponse.json({ reservation }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const failure = checkinErrorResponse(error);
    return NextResponse.json({ code: failure.code, message: failure.message }, { status: failure.status });
  }
}
