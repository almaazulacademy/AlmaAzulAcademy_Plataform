import { NextResponse } from "next/server";

import { authenticateAdminCredentials, setAdminSessionCookies } from "@/lib/admin/auth";
import { isSameOriginRequest } from "@/lib/admin/http";
import { supabaseSignupDeps } from "@/lib/team/data";
import { validateSignupInput } from "@/lib/team/invite";
import { registerInstructor } from "@/lib/team/signup";

/**
 * Cadastro público, mas só com convite válido. O corpo não tem campo de papel:
 * qualquer `role` enviado é ignorado — quem define INSTRUCTOR é a RPC.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const validation = validateSignupInput(await request.json().catch(() => null));
  if (!validation.success) return NextResponse.json({ errors: validation.errors }, { status: 400 });

  let deps;
  try {
    deps = supabaseSignupDeps();
  } catch {
    return NextResponse.json({ message: "Cadastro indisponível neste ambiente." }, { status: 503 });
  }

  const result = await registerInstructor(validation.data, deps).catch(() => null);
  if (!result) return NextResponse.json({ message: "Não foi possível concluir o cadastro. Tente novamente." }, { status: 500 });
  if (!result.ok) {
    return NextResponse.json({ code: result.code, message: result.message, inviteState: result.inviteState ?? null }, { status: result.status });
  }

  // Mesmo login da equipe: confere o perfil recém-criado em admin_users.
  const login = await authenticateAdminCredentials(validation.data.email, validation.data.password);
  if (!login.success) {
    return NextResponse.json({ code: "REGISTERED_LOGIN_FAILED", message: "Conta criada. Entre com seu e-mail e senha." }, { status: 201 });
  }
  const response = NextResponse.json({ registered: true, profile: { role: login.profile.role, displayName: login.profile.displayName } }, { status: 201 });
  setAdminSessionCookies(response, login.session);
  return response;
}
