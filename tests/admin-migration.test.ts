import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/202608010002_admin_dashboard_mvp.sql", import.meta.url);

test("migration administrativa preserva autorização, auditoria e proteção de capacidade", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create table if not exists public\.admin_users/i);
  assert.match(sql, /create table if not exists public\.admin_audit_log/i);
  assert.match(sql, /create or replace function public\.is_active_admin/i);
  assert.match(sql, /CAPACITY_BELOW_OCCUPANCY/);
  assert.match(sql, /SESSION_EXPERIENCE_LOCKED/);
  assert.match(sql, /SESSION_HAS_RESERVATIONS/);
  assert.match(sql, /INSUFFICIENT_SPOTS/);
});

test("RPCs administrativas não são concedidas a anon ou authenticated", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /revoke all on function public\.admin_create_session[\s\S]+from public, anon, authenticated/i);
  assert.match(sql, /revoke all on function public\.admin_confirm_reservation[\s\S]+from public, anon, authenticated/i);
  assert.doesNotMatch(sql, /grant execute on function public\.admin_[^(]+\([^;]+\) to (anon|authenticated)/i);
});
