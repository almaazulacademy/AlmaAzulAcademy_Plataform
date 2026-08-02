import { NextResponse } from "next/server";

import { authenticateAdminCredentials, setAdminSessionCookies } from "@/lib/admin/auth";
import { isSameOriginRequest } from "@/lib/admin/http";
import { validateLoginInput } from "@/lib/admin/validation";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }

  const body: unknown = await request.json().catch(() => null);
  const validation = validateLoginInput(body);
  if (!validation.success) return NextResponse.json({ errors: validation.errors }, { status: 400 });

  const result = await authenticateAdminCredentials(validation.data.email, validation.data.password);
  if (!result.success) return NextResponse.json({ message: result.message }, { status: result.status });

  const response = NextResponse.json({ profile: result.profile });
  setAdminSessionCookies(response, result.session);
  return response;
}
