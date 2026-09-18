import { NextResponse } from "next/server";

import { authorizeTeamManagerApi, isSameOriginRequest } from "@/lib/admin/http";
import { createInstructorInvite, teamErrorResponse } from "@/lib/team/data";

/** Gera um convite de instrutor. O link volta só nesta resposta. */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const authorization = await authorizeTeamManagerApi();
  if (!authorization.context) return authorization.response;

  try {
    const invite = await createInstructorInvite(authorization.context.profile.userId);
    return NextResponse.json({ invite }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const failure = teamErrorResponse(error);
    return NextResponse.json({ message: failure.message }, { status: failure.status });
  }
}
