import { NextResponse } from "next/server";

import { authorizeTeamManagerApi, isSameOriginRequest } from "@/lib/admin/http";
import { isUuid } from "@/lib/admin/validation";
import { setInstructorActive, teamErrorResponse } from "@/lib/team/data";

type RouteContext = { params: Promise<{ userId: string }> };

/**
 * Desativa ou reativa um instrutor. A RPC só alcança linhas INSTRUCTOR, então
 * esta rota nunca desativa nem altera um administrador.
 */
export async function PATCH(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const authorization = await authorizeTeamManagerApi();
  if (!authorization.context) return authorization.response;

  const { userId } = await context.params;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!isUuid(userId) || typeof body?.active !== "boolean") {
    return NextResponse.json({ message: "Dados inválidos." }, { status: 400 });
  }

  try {
    await setInstructorActive(authorization.context.profile.userId, userId, body.active);
    return NextResponse.json({ active: body.active });
  } catch (error) {
    const failure = teamErrorResponse(error);
    return NextResponse.json({ message: failure.message }, { status: failure.status });
  }
}
