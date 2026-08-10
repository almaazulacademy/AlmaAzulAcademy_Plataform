import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

// Remove comentários e literais para analisar só o SQL executável.
function executableSql(sql: string) {
  return sql.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");
}

const migration = source("supabase/migrations/202608090002_imersao_paranoa_default_capacity.sql");
const diagnostic = source("supabase/diagnostics/experiences_default_capacity_check.sql");
const schedule = source("supabase/migrations/202608090001_september_2026_schedule.sql");
const sprint5 = source("supabase/migrations/202608030001_sprint5_complete_operations.sql");

test("a origem do 15 continua registrada na migration da Sprint 5", () => {
  // Backfill genérico: o 15 nunca foi uma decisão sobre a Imersão Paranoá.
  assert.match(sprint5, /default_capacity = coalesce\(default_capacity, 15\)/);
  assert.match(sprint5, /alter column default_capacity set default 15/);
  assert.match(migration, /202608030001_sprint5_complete_operations\.sql/);
});

test("a correção alcança apenas a Imersão Paranoá e apenas default_capacity", () => {
  assert.match(migration, /target_slug constant text := 'imersao-paranoa';/);
  assert.match(migration, /target_capacity constant integer := 28;/);
  assert.equal((migration.match(/update public\.\w+/g) ?? []).length, 1);
  assert.deepEqual([...new Set(migration.match(/update public\.\w+/g) ?? [])], ["update public.experiences"]);
  assert.match(migration, /set default_capacity = target_capacity,\n\s*updated_at = now\(\)\n\s*where slug = target_slug/);
  // Nenhuma outra coluna da experiência recebe atribuição em lugar nenhum.
  assert.doesNotMatch(migration, /\b(price_cents|editorial_content|image_url|display_order|duration_minutes)\s*=/);
});

test("nada de sessões, reservas, pagamentos ou outras experiências", () => {
  assert.doesNotMatch(migration, /public\.(sessions|reservations|payment_events|admin_users|platform_settings|admin_audit_log)/);
  assert.doesNotMatch(migration, /\bdelete\s+from\b/i);
  assert.doesNotMatch(migration, /\binsert\s+into\b/i);
  assert.doesNotMatch(migration, /\b(drop|truncate)\b/i);
  // Trava: as demais experiências têm de sair idênticas.
  assert.match(migration, /others_before/);
  assert.match(migration, /others_after is distinct from others_before/);
  assert.match(migration, /EXPERIENCES_UNEXPECTED_CAPACITY_CHANGE/);
  assert.match(migration, /where slug <> target_slug/);
});

test("a correção é idempotente e confirma o resultado", () => {
  assert.match(migration, /and default_capacity is distinct from target_capacity;/);
  assert.match(migration, /IMERSAO_PARANOA_NOT_FOUND/);
  assert.match(migration, /IMERSAO_PARANOA_CAPACITY_NOT_APPLIED/);
  assert.equal((migration.match(/^do \$imersao_capacity\$/gm) ?? []).length, 1);
});

test("a agenda de setembro continua lendo a capacidade da experiência", () => {
  assert.match(schedule, /experience\.default_capacity as capacity/);
  assert.doesNotMatch(schedule, /\n\s*28,/);
});

test("o diagnóstico de capacidade é um único SELECT somente leitura", () => {
  const executable = executableSql(diagnostic);
  assert.equal((executable.match(/;/g) ?? []).length, 1);
  assert.doesNotMatch(executable, /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|call|merge|copy|vacuum)\b/i);
  assert.doesNotMatch(executable, /\bdo\s*\$/i);
  assert.doesNotMatch(diagnostic, /full_name|cpf|phone|email|checkout_url|provider_reference/i);
  for (const check of [
    "imersao_paranoa_default_capacity",
    "remada_nascer_do_sol_default_capacity",
    "remada_sunset_default_capacity",
    "DEFAULT_CAPACITY_READY",
  ]) {
    assert.ok(diagnostic.includes(`'${check}'`), `check ausente: ${check}`);
  }
  assert.match(diagnostic, /facts\.imersao = 28 and facts\.nascer = 28 and facts\.sunset = 28/);
});
