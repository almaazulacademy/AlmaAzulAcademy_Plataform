import { NextResponse } from "next/server";

import { authorizeAdminApi, isSameOriginRequest } from "@/lib/admin/http";
import { isUuid } from "@/lib/admin/validation";
import { syncSessionList } from "@/lib/integrations/google-sheets/service";

type RouteContext = { params: Promise<{ sessionId: string }> };

/**
 * "Sincronizar lista da sessão": reconstrói a turma inteira na planilha a partir
 * do Supabase e desativa vagas que não existem mais. É o fallback operacional
 * quando a planilha ficou para trás — e continua sendo só leitura do lado do
 * Supabase: nenhuma reserva, vaga ou capacidade é alterada.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const authorization = await authorizeAdminApi();
  if (!authorization.context) return authorization.response;

  const { sessionId } = await context.params;
  if (!isUuid(sessionId)) return NextResponse.json({ message: "Sessão inválida." }, { status: 400 });

  const result = await syncSessionList(sessionId);

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
        message: "Não foi possível reconstruir a lista na planilha agora. A sincronização ficou pendente e será tentada de novo.",
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
        ? "Esta é uma sessão histórica mantida fora da sincronização. Nada foi criado nem alterado."
        : "Esta turma não está na planilha operacional e foi origem de um Stand-by. Nada foi criado nem alterado.",
    });
  }

  return NextResponse.json({ success: true, outcome: result.outcome, message: "Lista da sessão reconstruída na planilha." });
}
