import type { ValidationResult } from "@/lib/reservations/validation";
import {
  EXPERIENCE_STATUSES,
  SESSION_STATUSES,
  type AdminExperienceInput,
  type AdminSessionInput,
  type ExperienceStatus,
  type SessionStatus,
} from "./types.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isUuid(value: string) {
  return UUID_PATTERN.test(value);
}

export function slugify(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function validateLoginInput(value: unknown): ValidationResult<{ email: string; password: string }> {
  if (!isRecord(value)) return { success: false, errors: { form: "Dados inválidos." } };
  const email = String(value.email ?? "").trim().toLowerCase();
  const password = String(value.password ?? "");
  const errors: Record<string, string> = {};

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    errors.email = "Informe um email válido.";
  }
  if (password.length < 6 || password.length > 128) {
    errors.password = "Informe sua senha de acesso.";
  }

  return Object.keys(errors).length
    ? { success: false, errors }
    : { success: true, data: { email, password } };
}

export function validateAdminSessionInput(value: unknown): ValidationResult<AdminSessionInput> {
  if (!isRecord(value)) return { success: false, errors: { form: "Dados inválidos." } };

  const experienceId = String(value.experienceId ?? "").trim();
  const startsAt = String(value.startsAt ?? "").trim();
  const durationMinutes = typeof value.durationMinutes === "number" ? value.durationMinutes : Number.NaN;
  const priceCents = typeof value.priceCents === "number" ? value.priceCents : Number.NaN;
  const capacity = typeof value.capacity === "number" ? value.capacity : Number.NaN;
  const status = String(value.status ?? "") as SessionStatus;
  const internalNotes = String(value.internalNotes ?? "").trim();
  const errors: Record<string, string> = {};

  if (!isUuid(experienceId)) errors.experienceId = "Selecione uma experiência.";
  if (!startsAt || !Number.isFinite(Date.parse(startsAt))) errors.startsAt = "Informe data e horário válidos.";
  if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 1440) {
    errors.durationMinutes = "A duração deve ficar entre 15 e 1440 minutos.";
  }
  if (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > 10_000_000) {
    errors.priceCents = "Informe um preço válido.";
  }
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 500) {
    errors.capacity = "A capacidade deve ficar entre 1 e 500.";
  }
  if (!SESSION_STATUSES.includes(status)) errors.status = "Selecione um status válido.";
  if (internalNotes.length > 1000) errors.internalNotes = "Use no máximo 1000 caracteres.";

  return Object.keys(errors).length
    ? { success: false, errors }
    : {
        success: true,
        data: { experienceId, startsAt, durationMinutes, priceCents, capacity, status, internalNotes },
      };
}

export function validateAdminExperienceInput(value: unknown): ValidationResult<AdminExperienceInput> {
  if (!isRecord(value)) return { success: false, errors: { form: "Dados inválidos." } };

  const title = String(value.title ?? "").trim().replace(/\s+/g, " ");
  const summary = String(value.summary ?? "").trim().replace(/\s+/g, " ");
  const description = String(value.description ?? "").trim();
  const durationMinutes = typeof value.durationMinutes === "number" ? value.durationMinutes : Number.NaN;
  const priceCents = typeof value.priceCents === "number" ? value.priceCents : Number.NaN;
  const defaultCapacity = typeof value.defaultCapacity === "number" ? value.defaultCapacity : Number.NaN;
  const status = String(value.status ?? "") as ExperienceStatus;
  const imageUrl = String(value.imageUrl ?? "").trim();
  const displayOrder = typeof value.displayOrder === "number" ? value.displayOrder : Number.NaN;
  const errors: Record<string, string> = {};

  if (title.length < 3 || title.length > 120) errors.title = "Use entre 3 e 120 caracteres.";
  if (summary.length < 10 || summary.length > 300) errors.summary = "Use entre 10 e 300 caracteres.";
  if (description.length < 20 || description.length > 5000) errors.description = "Use entre 20 e 5000 caracteres.";
  if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 1440) errors.durationMinutes = "Informe uma duração entre 15 e 1440 minutos.";
  if (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > 10_000_000) errors.priceCents = "Informe um preço válido.";
  if (!Number.isInteger(defaultCapacity) || defaultCapacity < 1 || defaultCapacity > 500) errors.defaultCapacity = "Informe uma capacidade entre 1 e 500.";
  if (!EXPERIENCE_STATUSES.includes(status)) errors.status = "Selecione um status válido.";
  if (imageUrl && !imageUrl.startsWith("/images/") && !/^https:\/\//i.test(imageUrl)) {
    errors.imageUrl = "Use uma imagem oficial em /images ou uma URL HTTPS.";
  }
  if (imageUrl.length > 500) errors.imageUrl = "Use no máximo 500 caracteres.";
  if (!Number.isInteger(displayOrder) || displayOrder < 0 || displayOrder > 10_000) {
    errors.displayOrder = "Informe uma ordem entre 0 e 10000.";
  }

  return Object.keys(errors).length
    ? { success: false, errors }
    : { success: true, data: { title, summary, description, durationMinutes, priceCents, defaultCapacity, status, imageUrl, displayOrder } };
}

export function validateReservationAdminAction(value: unknown): ValidationResult<{
  action: "CONFIRM_PAYMENT" | "CANCEL";
  reason: string;
}> {
  if (!isRecord(value)) return { success: false, errors: { form: "Dados inválidos." } };
  const action = String(value.action ?? "");
  const reason = String(value.reason ?? "").trim().replace(/\s+/g, " ");
  const errors: Record<string, string> = {};

  if (action !== "CONFIRM_PAYMENT" && action !== "CANCEL") errors.action = "Ação inválida.";
  if (reason.length < 3 || reason.length > 500) errors.reason = "Informe um motivo entre 3 e 500 caracteres.";

  return Object.keys(errors).length
    ? { success: false, errors }
    : { success: true, data: { action: action as "CONFIRM_PAYMENT" | "CANCEL", reason } };
}
