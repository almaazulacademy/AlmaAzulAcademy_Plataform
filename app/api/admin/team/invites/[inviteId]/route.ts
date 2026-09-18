import { NextResponse } from "next/server";

import { authorizeTeamManagerApi, isSameOriginRequest } from "@/lib/admin/http";
import { isUuid } from "@/lib/admin/validation";
import { revokeInstructorInvite, teamErrorResponse } from "@/lib/team/data";

type RouteContext = { params: Promise<{ inviteId: string }> };

/** Cancela um convite ainda não usado. */
export async function DELETE(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const authorization = await authorizeTeamManagerApi();
  if (!authorization.context) return authorization.response;

  const { inviteId } = await context.params;
  if (!isUuid(inviteId)) return NextResponse.json({ message: "Convite inválido." }, { status: 400 });

  try {
    const revoked = await revokeInstructorInvite(authorization.context.profile.userId, inviteId);
    if (!revoked) return NextResponse.json({ message: "Este convite já foi usado, cancelado ou não existe." }, { status: 409 });
    return NextResponse.json({ revoked: true });
  } catch (error) {
    const failure = teamErrorResponse(error);
    return NextResponse.json({ message: failure.message }, { status: failure.status });
  }
}
