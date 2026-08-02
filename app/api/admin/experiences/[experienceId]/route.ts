import { NextResponse } from "next/server";

import { updateAdminExperience } from "@/lib/admin/data";
import { adminMutationError, authorizeAdminApi, isSameOriginRequest } from "@/lib/admin/http";
import { isUuid, validateAdminExperienceInput } from "@/lib/admin/validation";

type RouteContext = { params: Promise<{ experienceId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const authorization = await authorizeAdminApi();
  if (!authorization.context) return authorization.response;
  const { experienceId } = await context.params;
  if (!isUuid(experienceId)) return NextResponse.json({ message: "Experiência inválida." }, { status: 400 });

  const body: unknown = await request.json().catch(() => null);
  const validation = validateAdminExperienceInput(body);
  if (!validation.success) return NextResponse.json({ errors: validation.errors }, { status: 400 });

  try {
    const updated = await updateAdminExperience(authorization.context.profile.userId, experienceId, validation.data);
    return updated
      ? NextResponse.json({ success: true })
      : NextResponse.json({ message: "Experiência não encontrada." }, { status: 404 });
  } catch (error) {
    const failure = adminMutationError(error);
    return NextResponse.json({ message: failure.message }, { status: failure.status });
  }
}
