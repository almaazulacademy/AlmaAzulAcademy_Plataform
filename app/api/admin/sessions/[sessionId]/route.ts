import { NextResponse } from "next/server";

import { deleteAdminSession, updateAdminSession } from "@/lib/admin/data";
import { adminMutationError, authorizeAdminApi, isSameOriginRequest } from "@/lib/admin/http";
import { isUuid, validateAdminSessionInput } from "@/lib/admin/validation";

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const authorization = await authorizeAdminApi();
  if (!authorization.context) return authorization.response;
  const { sessionId } = await context.params;
  if (!isUuid(sessionId)) return NextResponse.json({ message: "Sessão inválida." }, { status: 400 });

  const body: unknown = await request.json().catch(() => null);
  const validation = validateAdminSessionInput(body);
  if (!validation.success) return NextResponse.json({ errors: validation.errors }, { status: 400 });

  try {
    const updated = await updateAdminSession(authorization.context.profile.userId, sessionId, validation.data);
    return updated
      ? NextResponse.json({ success: true })
      : NextResponse.json({ message: "Sessão não encontrada." }, { status: 404 });
  } catch (error) {
    const failure = adminMutationError(error);
    return NextResponse.json({ message: failure.message }, { status: failure.status });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const authorization = await authorizeAdminApi();
  if (!authorization.context) return authorization.response;
  const { sessionId } = await context.params;
  if (!isUuid(sessionId)) return NextResponse.json({ message: "Sessão inválida." }, { status: 400 });

  try {
    const deleted = await deleteAdminSession(authorization.context.profile.userId, sessionId);
    return deleted
      ? NextResponse.json({ success: true })
      : NextResponse.json({ message: "Sessão não encontrada." }, { status: 404 });
  } catch (error) {
    const failure = adminMutationError(error);
    return NextResponse.json({ message: failure.message }, { status: failure.status });
  }
}
