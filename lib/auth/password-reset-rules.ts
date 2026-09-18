// Regras da recuperação de senha sem dependência de servidor: usadas pelas rotas
// e pelos formulários.

import { passwordErrors } from "../team/invite-rules.ts";

export const RESET_PATH = "/redefinir-senha";

/** Resposta única do pedido, exista a conta ou não: não revela quem é da equipe. */
export const RESET_REQUESTED_MESSAGE =
  "Se este e-mail for de uma conta ativa da equipe Alma Azul, você vai receber um link para criar uma nova senha em alguns minutos. Confira também o spam.";

export const RESET_LINK_INVALID_MESSAGE =
  "Este link de redefinição é inválido, já foi usado ou expirou. Peça um novo em “Esqueci minha senha”.";

// `hashed_token` do Supabase: hex. Faixa larga para não depender do algoritmo exato.
const RESET_TOKEN_PATTERN = /^[a-f0-9]{40,128}$/i;

export function isResetToken(value: unknown): value is string {
  return typeof value === "string" && RESET_TOKEN_PATTERN.test(value);
}

export function normalizeEmail(value: unknown) {
  const email = String(value ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

export function validateResetCompletion(value: unknown):
  | { success: true; data: { token: string; password: string } }
  | { success: false; errors: Record<string, string> } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const token = typeof record.token === "string" ? record.token.trim() : "";
  const password = String(record.password ?? "");
  const errors: Record<string, string> = { ...passwordErrors(password, String(record.passwordConfirmation ?? "")) };
  if (!isResetToken(token)) errors.form = RESET_LINK_INVALID_MESSAGE;
  return Object.keys(errors).length ? { success: false, errors } : { success: true, data: { token, password } };
}
