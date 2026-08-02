import type { CreateReservationInput } from "@/lib/reservations/types";

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; errors: Record<string, string> };

export function digitsOnly(value: string) {
  return value.replace(/\D/g, "");
}

export function isValidCpf(value: string) {
  const cpf = digitsOnly(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;

  const calculateDigit = (length: number) => {
    const sum = cpf
      .slice(0, length)
      .split("")
      .reduce((total, digit, index) => total + Number(digit) * (length + 1 - index), 0);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };

  return calculateDigit(9) === Number(cpf[9]) && calculateDigit(10) === Number(cpf[10]);
}

export function formatCpf(value: string) {
  return digitsOnly(value)
    .slice(0, 11)
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
}

export function normalizePhone(value: string) {
  const digits = digitsOnly(value);
  return digits.startsWith("55") ? `+${digits}` : `+55${digits}`;
}

export function formatPhone(value: string) {
  return digitsOnly(value)
    .replace(/^55/, "")
    .slice(0, 11)
    .replace(/^(\d{2})(\d)/, "($1) $2")
    .replace(/(\d{5})(\d)/, "$1-$2");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function validateReservationInput(value: unknown): ValidationResult<CreateReservationInput> {
  if (!isRecord(value)) return { success: false, errors: { form: "Dados inválidos." } };

  const input = {
    sessionId: String(value.sessionId ?? "").trim(),
    fullName: String(value.fullName ?? "").trim().replace(/\s+/g, " "),
    cpf: digitsOnly(String(value.cpf ?? "")),
    phone: normalizePhone(String(value.phone ?? "")),
    email: String(value.email ?? "").trim().toLowerCase(),
    quantity: Number(value.quantity),
    notes: String(value.notes ?? "").trim() || undefined,
    idempotencyKey: String(value.idempotencyKey ?? "").trim(),
  };
  const errors: Record<string, string> = {};

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.sessionId)) errors.sessionId = "Sessão inválida.";
  if (input.fullName.length < 5 || !input.fullName.includes(" ")) errors.fullName = "Informe nome e sobrenome.";
  if (!isValidCpf(input.cpf)) errors.cpf = "Informe um CPF válido.";
  if (!/^\+55\d{10,11}$/.test(input.phone)) errors.phone = "Informe um WhatsApp válido com DDD.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || input.email.length > 254) errors.email = "Informe um email válido.";
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 20) errors.quantity = "Escolha entre 1 e 20 pessoas.";
  if (input.notes && input.notes.length > 500) errors.notes = "Use no máximo 500 caracteres.";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.idempotencyKey)) errors.form = "Atualize a página e tente novamente.";

  return Object.keys(errors).length ? { success: false, errors } : { success: true, data: input };
}

export function validateLookupInput(value: unknown): ValidationResult<{ cpf: string; publicCode: string }> {
  if (!isRecord(value)) return { success: false, errors: { form: "Dados inválidos." } };
  const cpf = digitsOnly(String(value.cpf ?? ""));
  const publicCode = String(value.publicCode ?? "").trim().toUpperCase();
  const errors: Record<string, string> = {};
  if (!isValidCpf(cpf)) errors.cpf = "Informe um CPF válido.";
  if (!/^[A-Z0-9]{8,12}$/.test(publicCode)) errors.publicCode = "Informe o código da reserva.";
  return Object.keys(errors).length ? { success: false, errors } : { success: true, data: { cpf, publicCode } };
}
