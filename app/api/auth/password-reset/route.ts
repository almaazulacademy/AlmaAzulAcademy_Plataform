import { NextResponse } from "next/server";

import { isSameOriginRequest } from "@/lib/admin/http";
import { requestPasswordReset } from "@/lib/auth/password-reset";
import { normalizeEmail, RESET_REQUESTED_MESSAGE } from "@/lib/auth/password-reset-rules";
import { passwordResetRequestDeps } from "@/lib/auth/password-reset-service";

/**
 * "Esqueci minha senha". Responde sempre a mesma mensagem, exista a conta ou
 * não, para não revelar quais e-mails são da equipe.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const email = normalizeEmail(body?.email);
  if (!email) return NextResponse.json({ errors: { email: "Informe um e-mail válido." } }, { status: 400 });

  let deps;
  try {
    deps = passwordResetRequestDeps();
  } catch {
    deps = null;
  }
  if (!deps) {
    return NextResponse.json({ message: "A recuperação de senha está indisponível no momento. Fale com a administração da Alma Azul." }, { status: 503 });
  }

  await requestPasswordReset(email, deps).catch(() => undefined);
  return NextResponse.json({ message: RESET_REQUESTED_MESSAGE });
}
