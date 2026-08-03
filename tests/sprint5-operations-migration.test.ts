import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(new URL("../supabase/migrations/202608030001_sprint5_complete_operations.sql", import.meta.url), "utf8");

test("Sprint 5 adiciona campos operacionais sem reescrever migrations anteriores", () => {
  for (const field of ["description", "duration_minutes", "price_cents", "default_capacity"]) {
    assert.match(sql, new RegExp(`add column if not exists ${field}`));
  }
});

test("métricas, participantes, filtros e ordenação ficam protegidos no banco", () => {
  assert.match(sql, /averageOccupancyRate/);
  assert.match(sql, /revenueByMonth/);
  assert.match(sql, /participants jsonb/);
  assert.match(sql, /p_payment_status text/);
  assert.match(sql, /p_sort text/);
  assert.match(sql, /ADMIN_FORBIDDEN/g);
  assert.match(sql, /revoke all on function public\.admin_list_reservations/);
  assert.match(sql, /to service_role/);
});

test("consultas preservam timezone, expiração e limite operacional", () => {
  assert.match(sql, /America\/Sao_Paulo/);
  assert.match(sql, /expire_pre_reservations\(\)/);
  assert.match(sql, /limit 500/);
});
