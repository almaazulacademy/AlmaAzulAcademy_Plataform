import { NextResponse } from "next/server";

import { createAdminSession } from "@/lib/admin/data";
import { adminMutationError, authorizeAdminApi, isSameOriginRequest } from "@/lib/admin/http";
import { validateAdminSessionInput } from "@/lib/admin/validation";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const authorization = await authorizeAdminApi();
  if (!authorization.context) return authorization.response;

  const body: unknown = await request.json().catch(() => null);
  const validation = validateAdminSessionInput(body);
  if (!validation.success) return NextResponse.json({ errors: validation.errors }, { status: 400 });

  try {
    const id = await createAdminSession(authorization.context.profile.userId, validation.data);
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    const failure = adminMutationError(error);
    return NextResponse.json({ message: failure.message }, { status: failure.status });
  }
}
