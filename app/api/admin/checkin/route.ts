import { NextResponse } from "next/server";

import { authorizeAdminApi, isSameOriginRequest } from "@/lib/admin/http";
import { isUuid } from "@/lib/admin/validation";
import { registerCheckin } from "@/lib/checkin/data";
import { checkinErrorResponse } from "@/lib/checkin/parse";

/**
 * Registra, corrige ou desfaz a presença de uma reserva.
 *
 * O navegador só sugere; quem decide é `admin_register_checkin`, que confere
 * admin ativo, reserva confirmada, turma esperada, limite de vagas e check-in
 * duplicado sob lock da linha.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const authorization = await authorizeAdminApi();
  if (!authorization.context) return authorization.response;

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const reservationId = typeof body?.reservationId === "string" ? body.reservationId : "";
  const method = body?.method === "QR" || body?.method === "MANUAL" ? body.method : null;
  const expectedSessionId = typeof body?.expectedSessionId === "string" && isUuid(body.expectedSessionId) ? body.expectedSessionId : null;
  const allowUpdate = body?.allowUpdate === true;
  const count = body?.count === null ? null : Number(body?.count);

  if (!isUuid(reservationId) || !method) {
    return NextResponse.json({ code: "INVALID_INPUT", message: "Dados do check-in inválidos." }, { status: 400 });
  }
  if (count !== null && (!Number.isInteger(count) || count < 0 || count > 20)) {
    return NextResponse.json({ code: "INVALID_COUNT", message: "Quantidade de presentes inválida." }, { status: 400 });
  }
  if (count === null && !allowUpdate) {
    return NextResponse.json({ code: "INVALID_INPUT", message: "Para desfazer um check-in, confirme a correção." }, { status: 400 });
  }

  try {
    const reservation = await registerCheckin(authorization.context.profile.userId, {
      reservationId,
      count,
      method,
      expectedSessionId,
      allowUpdate,
    });
    return NextResponse.json({ reservation });
  } catch (error) {
    const failure = checkinErrorResponse(error);
    return NextResponse.json({ code: failure.code, message: failure.message }, { status: failure.status });
  }
}
