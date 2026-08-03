import assert from "node:assert/strict";
import test from "node:test";

import { brasiliaLocalToIso, formatMaskedCpf } from "../lib/admin/format.ts";
import {
  isUuid,
  slugify,
  validateAdminExperienceInput,
  validateAdminSessionInput,
  validateLoginInput,
  validateReservationAdminAction,
} from "../lib/admin/validation.ts";
import { describeAuthFailure } from "../lib/admin/auth-errors.ts";

test("normaliza o slug de qualquer experiência", () => {
  assert.equal(slugify("  Remada da Lua Cheia  "), "remada-da-lua-cheia");
  assert.equal(slugify("Imersão Paranoá"), "imersao-paranoa");
});

test("valida credenciais sem expor ou normalizar a senha", () => {
  const valid = validateLoginInput({ email: " EQUIPE@ALMAAZUL.COM.BR ", password: "segura123" });
  assert.equal(valid.success, true);
  if (valid.success) {
    assert.equal(valid.data.email, "equipe@almaazul.com.br");
    assert.equal(valid.data.password, "segura123");
  }
  assert.equal(validateLoginInput({ email: "inválido", password: "123" }).success, false);
});

test("distingue falhas de autenticação sem mascarar configuração e sessão", () => {
  assert.deepEqual(describeAuthFailure({ code: "email_not_confirmed", status: 400 }), {
    status: 403,
    message: "O email desta conta ainda não foi confirmado.",
  });
  assert.equal(describeAuthFailure({ code: "invalid_credentials", status: 400 }).status, 401);
  assert.equal(describeAuthFailure({ message: "Invalid API key", status: 401 }).status, 503);
  assert.equal(describeAuthFailure({ code: "unexpected_failure", status: 500 }).status, 503);
});

test("valida os limites de uma sessão administrativa", () => {
  const valid = validateAdminSessionInput({
    experienceId: "3b12f1df-5232-4804-897e-917bf397618a",
    startsAt: "2026-09-10T12:00:00.000Z",
    durationMinutes: 90,
    priceCents: 18000,
    capacity: 20,
    status: "OPEN",
    internalNotes: "Equipe chega 30 minutos antes.",
  });
  assert.equal(valid.success, true);

  const invalid = validateAdminSessionInput({
    experienceId: "inválida",
    startsAt: "",
    durationMinutes: 0,
    priceCents: -1,
    capacity: 0,
    status: "UNKNOWN",
  });
  assert.equal(invalid.success, false);
  assert.equal(validateAdminSessionInput({
    experienceId: "3b12f1df-5232-4804-897e-917bf397618a",
    startsAt: "2026-09-10T12:00:00.000Z",
    durationMinutes: "90",
    priceCents: null,
    capacity: "20",
    status: "OPEN",
  }).success, false);
  assert.equal(isUuid("3b12f1df-5232-4804-897e-917bf397618a"), true);
});

test("valida cadastro e imagem oficial da experiência", () => {
  assert.equal(validateAdminExperienceInput({
    title: "Remada Sunset",
    summary: "Uma remada ao entardecer no Lago Paranoá.",
    status: "DRAFT",
    imageUrl: "/images/experiences/sunset/capa.webp",
    displayOrder: 1,
  }).success, true);
  assert.equal(validateAdminExperienceInput({
    title: "X",
    summary: "curta",
    status: "INVALID",
    imageUrl: "http://inseguro.example/imagem.jpg",
    displayOrder: -1,
  }).success, false);
  assert.equal(validateAdminExperienceInput({
    title: "Remada Sunset",
    summary: "Uma remada ao entardecer no Lago Paranoá.",
    status: "DRAFT",
    imageUrl: "",
    displayOrder: "1",
  }).success, false);
});

test("ações sensíveis exigem motivo explícito", () => {
  assert.equal(validateReservationAdminAction({ action: "CONFIRM_PAYMENT", reason: "Pagamento em espécie" }).success, true);
  assert.equal(validateReservationAdminAction({ action: "CANCEL", reason: "" }).success, false);
  assert.equal(validateReservationAdminAction({ action: "DELETE", reason: "teste" }).success, false);
});

test("formata CPF mascarado e converte horário de Brasília", () => {
  assert.equal(formatMaskedCpf("4725"), "•••.•••.47-25");
  assert.equal(brasiliaLocalToIso("2026-09-10T09:00"), "2026-09-10T12:00:00.000Z");
});
