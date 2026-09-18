// Regras do convite sem dependência de Node: usadas pelo servidor e pelo formulário.

export const PASSWORD_MIN_LENGTH = 8;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isInviteToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export type InviteState = "VALID" | "EXPIRED" | "USED" | "REVOKED" | "INVALID";

export function parseInviteState(value: unknown): InviteState {
  return value === "VALID" || value === "EXPIRED" || value === "USED" || value === "REVOKED" ? value : "INVALID";
}

export const INVITE_STATE_MESSAGES: Record<Exclude<InviteState, "VALID">, { title: string; description: string }> = {
  INVALID: {
    title: "Convite inválido",
    description: "Este link de convite não existe. Confira se ele foi copiado por inteiro ou peça um novo à administração da Alma Azul.",
  },
  EXPIRED: {
    title: "Convite expirado",
    description: "Este convite passou da validade. Peça um novo link à administração da Alma Azul.",
  },
  USED: {
    title: "Convite já utilizado",
    description: "Este convite já foi usado para criar uma conta. Se a conta é sua, entre com seu e-mail e senha.",
  },
  REVOKED: {
    title: "Convite cancelado",
    description: "Este convite foi cancelado pela administração. Peça um novo link se ainda precisar de acesso.",
  },
};

export type SignupInput = { token: string; name: string; email: string; password: string };

/** Validação do formulário. Nenhum campo de papel é aceito: o papel vem do convite, no servidor. */
export function validateSignupInput(value: unknown):
  | { success: true; data: SignupInput }
  | { success: false; errors: Record<string, string> } {
  if (!value || typeof value !== "object") return { success: false, errors: { form: "Dados inválidos." } };
  const record = value as Record<string, unknown>;
  const token = typeof record.token === "string" ? record.token.trim() : "";
  const name = String(record.name ?? "").trim().replace(/\s+/g, " ");
  const email = String(record.email ?? "").trim().toLowerCase();
  const password = String(record.password ?? "");
  const confirmation = String(record.passwordConfirmation ?? "");
  const errors: Record<string, string> = {};

  if (!isInviteToken(token)) errors.form = INVITE_STATE_MESSAGES.INVALID.description;
  if (name.length < 2 || name.length > 80) errors.name = "Informe seu nome (até 80 caracteres).";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) errors.email = "Informe um e-mail válido.";
  if (password.length < PASSWORD_MIN_LENGTH || password.length > 72) {
    errors.password = `A senha precisa ter entre ${PASSWORD_MIN_LENGTH} e 72 caracteres.`;
  } else if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    errors.password = "Use letras e números na senha.";
  }
  if (!errors.password && password !== confirmation) errors.passwordConfirmation = "As senhas não conferem.";

  return Object.keys(errors).length ? { success: false, errors } : { success: true, data: { token, name, email, password } };
}
