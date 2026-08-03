import { NextResponse } from "next/server";

import { authenticateAdminCredentials, setAdminSessionCookies } from "@/lib/admin/auth";
import { isSameOriginRequest } from "@/lib/admin/http";
import { validateLoginInput } from "@/lib/admin/validation";

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403, headers: { "x-auth-diagnostic-id": requestId } });
  }

  const body: unknown = await request.json().catch(() => null);
  const validation = validateLoginInput(body);
  if (!validation.success) return NextResponse.json({ errors: validation.errors }, { status: 400 });

  const result = await authenticateAdminCredentials(validation.data.email, validation.data.password, requestId);
  if (!result.success) {
    return NextResponse.json({ message: result.message }, { status: result.status, headers: { "x-auth-diagnostic-id": requestId } });
  }

  const response = NextResponse.json({ profile: result.profile }, { headers: { "x-auth-diagnostic-id": requestId } });
  setAdminSessionCookies(response, result.session);
  console.info("[admin-auth]", {
    requestId,
    stage: "session_cookies_set",
    secure: process.env.NODE_ENV === "production",
    accessMaxAge: Math.max(60, result.session.expires_in),
  });
  return response;
}
