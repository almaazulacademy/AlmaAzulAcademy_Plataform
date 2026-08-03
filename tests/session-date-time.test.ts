import assert from "node:assert/strict";
import test from "node:test";

import {
  formatSessionDate,
  formatSessionDateTime,
  formatSessionDayMonth,
  formatSessionTime,
  formatSessionWeekday,
  sessionLocalToIso,
  toSessionDateTimeLocal,
} from "../lib/sessions/date-time.ts";

test("converte UTC para o horário de Brasília", () => {
  assert.equal(formatSessionTime("2026-09-10T18:00:00.000Z"), "15:00");
  assert.equal(formatSessionTime("2026-09-10T03:00:00.000Z"), "00:00");
});

test("aplica a mudança de dia no fuso da sessão", () => {
  const startsAt = "2026-09-10T02:30:00.000Z";
  assert.equal(formatSessionTime(startsAt), "23:30");
  assert.match(formatSessionDate(startsAt), /09 de setembro de 2026/);
  assert.equal(formatSessionDayMonth(startsAt), "09 de setembro");
  assert.equal(formatSessionWeekday(startsAt), "quarta-feira");
});

test("mantém horários próximos da meia-noite sem depender do fuso do ambiente", () => {
  assert.equal(formatSessionTime("2026-09-10T02:59:00.000Z"), "23:59");
  assert.equal(formatSessionTime("2026-09-10T03:01:00.000Z"), "00:01");
  assert.equal(toSessionDateTimeLocal("2026-09-10T03:00:00.000Z"), "2026-09-10T00:00");
});

test("usa a mesma representação de starts_at nas telas de sessão", () => {
  const startsAt = "2026-09-10T18:00:00.000Z";
  const publicCard = formatSessionDateTime(startsAt);
  const reservationPage = formatSessionDateTime(startsAt);
  const adminPanel = formatSessionDateTime(startsAt);
  const sessionDetails = formatSessionDateTime(startsAt);

  assert.equal(publicCard, reservationPage);
  assert.equal(reservationPage, adminPanel);
  assert.equal(adminPanel, sessionDetails);
  assert.match(publicCard, /15:00/);
});

test("converte o datetime-local de Brasília uma única vez antes de salvar", () => {
  assert.equal(sessionLocalToIso("2026-09-10T15:00"), "2026-09-10T18:00:00.000Z");
  assert.equal(toSessionDateTimeLocal("2026-09-10T18:00:00.000Z"), "2026-09-10T15:00");
  assert.equal(sessionLocalToIso("valor inválido"), "");
});
