import { NextResponse } from "next/server";

import { restoreAdminSession } from "@/lib/admin/data";
import { adminMutationError, authorizeAdminApi, isSameOriginRequest } from "@/lib/admin/http";
import { isUuid } from "@/lib/admin/validation";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const authorization = await authorizeAdminApi();
  if (!authorization.context) return authorization.response;
  const { sessionId } = await context.params;
  if (!isUuid(sessionId)) return NextResponse.json({ message: "Sessão inválida." }, { status: 400 });

  try {
    const restored = await restoreAdminSession(authorization.context.profile.userId, sessionId);
    return restored
      ? NextResponse.json({ success: true })
      : NextResponse.json({ message: "Sessão não encontrada." }, { status: 404 });
  } catch (error) {
    const failure = adminMutationError(error);
    return NextResponse.json({ message: failure.message }, { status: failure.status });
  }
}
