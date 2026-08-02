import assert from "node:assert/strict";
import test from "node:test";

import {
  digitsOnly,
  formatCpf,
  formatPhone,
  isValidCpf,
  normalizePhone,
  validateLookupInput,
  validateReservationInput,
} from "../lib/reservations/validation.ts";

test("valida CPF pelo dígito verificador", () => {
  assert.equal(isValidCpf("529.982.247-25"), true);
  assert.equal(isValidCpf("529.982.247-24"), false);
  assert.equal(isValidCpf("111.111.111-11"), false);
});

test("normaliza CPF e WhatsApp brasileiros", () => {
  assert.equal(digitsOnly("529.982.247-25"), "52998224725");
  assert.equal(formatCpf("52998224725"), "529.982.247-25");
  assert.equal(formatPhone("61999998888"), "(61) 99999-8888");
  assert.equal(normalizePhone("(61) 99999-8888"), "+5561999998888");
});

test("aceita uma solicitação completa e normaliza os campos", () => {
  const result = validateReservationInput({
    sessionId: "3b12f1df-5232-4804-897e-917bf397618a",
    fullName: "  Maria   da Silva ",
    cpf: "529.982.247-25",
    phone: "(61) 99999-8888",
    email: " MARIA@EXAMPLE.COM ",
    quantity: 2,
    notes: "Primeira remada",
    idempotencyKey: "9d1ad4aa-b586-4d64-9cf2-9f115b633c77",
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.fullName, "Maria da Silva");
    assert.equal(result.data.cpf, "52998224725");
    assert.equal(result.data.phone, "+5561999998888");
    assert.equal(result.data.email, "maria@example.com");
  }
});

test("rejeita dados incompletos e quantidade fora do limite", () => {
  const result = validateReservationInput({ quantity: 21 });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.errors.fullName);
    assert.ok(result.errors.cpf);
    assert.ok(result.errors.quantity);
  }
});

test("recuperação sempre exige CPF válido e código", () => {
  assert.equal(validateLookupInput({ cpf: "52998224725", publicCode: "AB12CD34EF" }).success, true);
  assert.equal(validateLookupInput({ cpf: "52998224725" }).success, false);
  assert.equal(validateLookupInput({ publicCode: "AB12CD34EF" }).success, false);
});
