/**
 * O relógio controlado dos testes (`tests/support/controlled-clock.ts`): o
 * JavaScript e o Postgres em memória veem o mesmo "agora", que anda; datas
 * explícitas não mudam. E o relógio do ESSÊNCIA começa antes do evento, sem
 * mexer na data histórica.
 */

import "./support/essencia-clock.ts";

import assert from "node:assert/strict";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { ESSENCIA_STARTS_AT } from "../lib/events/fixtures/essencia.ts";
import { controlledNow, installControlledClock } from "./support/controlled-clock.ts";
import { ESSENCIA_TEST_NOW } from "./support/essencia-clock.ts";

const START = Date.parse(ESSENCIA_TEST_NOW);

test("JavaScript: Date.now, new Date() e Date() partem do instante controlado e andam", async () => {
  const first = Date.now();
  assert.ok(first >= START && first - START < 60_000, new Date(first).toISOString());
  assert.ok(Math.abs(new Date().getTime() - first) < 1_000);
  assert.ok(new Date() instanceof Date);
  assert.match(Date(), /2026/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(Date.now() > first, "o relógio continua andando");
  assert.ok(Math.abs(controlledNow() - Date.now()) < 5);
});

test("datas explícitas não mudam: a data histórica do ESSÊNCIA continua 07/11/2026", () => {
  assert.equal(ESSENCIA_STARTS_AT, "2026-11-07T08:30:00.000Z");
  assert.equal(new Date(ESSENCIA_STARTS_AT).toISOString(), ESSENCIA_STARTS_AT);
  assert.equal(new Date(2026, 10, 7, 5, 30).getFullYear(), 2026);
  assert.equal(Date.UTC(2026, 10, 7, 8, 30), Date.parse(ESSENCIA_STARTS_AT));
  assert.ok(Date.now() < Date.parse(ESSENCIA_STARTS_AT), "o relógio do roteiro está antes do evento");
});

test("Postgres em memória: now() é o instante controlado, em Brasília 31/10/2026", async () => {
  const db = new PGlite();
  const row = (await db.query<{ local: string; epoch: number; before: boolean }>(
    `select to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24') as local,
            extract(epoch from now()) * 1000 as epoch,
            now() < $1::timestamptz as before`,
    [ESSENCIA_STARTS_AT],
  )).rows[0];
  assert.equal(row.local, "31/10/2026 12");
  assert.ok(Math.abs(Number(row.epoch) - Date.now()) < 5_000);
  assert.equal(row.before, true);
  await db.close();
});

test("reinstalar com o mesmo instante não muda nada; com outro, é erro", () => {
  installControlledClock(ESSENCIA_TEST_NOW);
  assert.throws(() => installControlledClock("2027-01-01T00:00:00.000Z"), /já instalado/);
  assert.throws(() => installControlledClock("ontem"), /inválido/);
});
