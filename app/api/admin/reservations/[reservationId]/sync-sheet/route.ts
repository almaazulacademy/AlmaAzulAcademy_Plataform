import { NextResponse } from "next/server";

import { authorizeAdminApi, isSameOriginRequest } from "@/lib/admin/http";
import { isUuid } from "@/lib/admin/validation";
import { syncReservationAfterChange } from "@/lib/integrations/google-sheets/service";

type RouteContext = { params: Promise<{ reservationId: string }> };

/**
 * "Sincronizar planilha" no detalhe da reserva.
 *
 * Reenvia a reserva para a planilha operacional. É idempotente: repetir a ação
 * reescreve as mesmas linhas e não cria participante duplicado. Nunca altera
 * status, vaga, capacidade ou pagamento — só espelha o que o Supabase já diz.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const authorization = await authorizeAdminApi();
  if (!authorization.context) return authorization.response;

  const { reservationId } = await context.params;
  if (!isUuid(reservationId)) return NextResponse.json({ message: "Reserva inválida." }, { status: 400 });

  const result = await syncReservationAfterChange(reservationId, "ADMIN");

  if (result.outcome === "DISABLED") {
    return NextResponse.json(
      { success: false, outcome: result.outcome, message: "A integração com o Google Sheets não está configurada neste ambiente." },
      { status: 503 },
    );
  }
  if (result.outcome === "PENDING") {
    return NextResponse.json(
      {
        success: false,
        outcome: result.outcome,
        errorCode: result.errorCode,
        message: "Não foi possível escrever na planilha agora. A sincronização ficou pendente e será tentada de novo.",
      },
      { status: 503 },
    );
  }

  // Nada foi escrito: sessão histórica congelada, ou turma de origem de um
  // Stand-by que não está na planilha. Este botão não cria nenhuma das duas.
  if (result.outcome === "SKIPPED") {
    return NextResponse.json({
      success: true,
      outcome: result.outcome,
      skipReason: result.skipReason,
      message: result.skipReason === "SESSION_FROZEN"
        ? "A turma desta reserva é uma sessão histórica mantida fora da sincronização. Nada foi criado nem alterado."
        : "A turma desta reserva não está na planilha operacional. Nada foi criado nem alterado.",
    });
  }

  return NextResponse.json({ success: true, outcome: result.outcome, message: "Reserva sincronizada com a planilha." });
}
