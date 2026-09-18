import { NextResponse } from "next/server";

import { authenticateAdminCredentials, setAdminSessionCookies } from "@/lib/admin/auth";
import { isSameOriginRequest } from "@/lib/admin/http";
import { completePasswordReset } from "@/lib/auth/password-reset";
import { validateResetCompletion } from "@/lib/auth/password-reset-rules";
import { passwordResetCompleteDeps } from "@/lib/auth/password-reset-service";

/** Troca a senha com o token do link e entra com a senha nova. */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const validation = validateResetCompletion(await request.json().catch(() => null));
  if (!validation.success) return NextResponse.json({ errors: validation.errors }, { status: 400 });

  let deps;
  try {
    deps = passwordResetCompleteDeps();
  } catch {
    return NextResponse.json({ message: "A redefinição de senha está indisponível no momento." }, { status: 503 });
  }

  const result = await completePasswordReset(validation.data, deps).catch(() => null);
  if (!result) return NextResponse.json({ message: "Não foi possível trocar a senha agora. Tente novamente." }, { status: 500 });
  if (!result.ok) return NextResponse.json({ code: result.code, message: result.message }, { status: result.status });

  // Login normal da equipe: confere de novo papel e status em admin_users.
  const login = await authenticateAdminCredentials(result.email, validation.data.password);
  if (!login.success) {
    return NextResponse.json({ code: "RESET_LOGIN_FAILED", message: "Senha alterada. Entre com seu e-mail e a nova senha." });
  }
  const response = NextResponse.json({ reset: true, profile: { role: login.profile.role } });
  setAdminSessionCookies(response, login.session);
  return response;
}
