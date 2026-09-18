import { NextResponse } from "next/server";

import { authorizeAdminApi, isSameOriginRequest } from "@/lib/admin/http";
import { isUuid } from "@/lib/admin/validation";
import { listQrBulkCandidates, sendQrBulkChunk } from "@/lib/checkin/qr-bulk-service";
import { checkinErrorResponse } from "@/lib/checkin/parse";

export const maxDuration = 60;

/** Envio em massa para clientes: só perfil ADMIN (operador de base não dispara). */
async function authorize(): Promise<{ response: NextResponse; userId: null } | { response: null; userId: string }> {
  const authorization = await authorizeAdminApi();
  if (!authorization.context) return { response: authorization.response, userId: null };
  if (authorization.context.profile.role !== "ADMIN") {
    return { response: NextResponse.json({ message: "Apenas administradores podem enviar QRs em lote." }, { status: 403 }), userId: null };
  }
  return { response: null, userId: authorization.context.profile.userId };
}

/** Resumo sem dado pessoal: só quantidades. */
export async function GET() {
  const auth = await authorize();
  if (auth.response) return auth.response;
  const { userId } = auth;
  try {
    const candidates = await listQrBulkCandidates(userId);
    return NextResponse.json(
      { reservations: candidates.length, participants: candidates.reduce((sum, item) => sum + item.quantity, 0) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const failure = checkinErrorResponse(error);
    return NextResponse.json({ message: failure.message }, { status: failure.status });
  }
}

/** Processa um pedaço do lote. O painel chama de novo até `remaining` zerar. */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const auth = await authorize();
  if (auth.response) return auth.response;
  const { userId } = auth;

  const body = await request.json().catch(() => null) as { exclude?: unknown } | null;
  const exclude = Array.isArray(body?.exclude) ? body.exclude.filter((id): id is string => typeof id === "string" && isUuid(id)).slice(0, 500) : [];

  try {
    const result = await sendQrBulkChunk(userId, exclude);
    if (result === "DISABLED") {
      return NextResponse.json({ message: "O provedor de e-mail não está configurado neste ambiente." }, { status: 503 });
    }
    return NextResponse.json(result);
  } catch (error) {
    const failure = checkinErrorResponse(error);
    return NextResponse.json({ message: failure.message }, { status: failure.status });
  }
}
