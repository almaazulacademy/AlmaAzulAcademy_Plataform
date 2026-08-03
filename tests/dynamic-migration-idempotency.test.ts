import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const dashboard = source("supabase/migrations/202608010002_admin_dashboard_mvp.sql");
const operations = source("supabase/migrations/202608030001_sprint5_complete_operations.sql");
const dynamic = source("supabase/migrations/202608030002_dynamic_experiences.sql");
const diagnostic = source("supabase/diagnostics/202608030002_dynamic_experiences_preflight.sql");

test("inventário histórico registra as três gerações das RPCs administrativas", () => {
  assert.match(dashboard, /admin_create_experience\([\s\S]*?p_display_order integer[\s\S]*?returns uuid/);
  assert.match(dashboard, /admin_update_experience\([\s\S]*?p_display_order integer[\s\S]*?returns boolean/);
  assert.match(dashboard, /admin_list_experiences\(p_actor_id uuid\)[\s\S]*?sessions_count bigint/);

  assert.match(operations, /admin_create_experience\(p_actor_id uuid,p_slug text,p_title text,p_summary text,p_status text,p_image_url text,p_display_order integer,p_description text,p_duration_minutes integer,p_price_cents integer,p_default_capacity integer\)/);
  assert.match(operations, /admin_update_experience\(p_actor_id uuid,p_experience_id uuid,p_title text,p_summary text,p_status text,p_image_url text,p_display_order integer,p_description text,p_duration_minutes integer,p_price_cents integer,p_default_capacity integer\)/);
  assert.match(operations, /returns table \(id uuid, slug text, title text, summary text, description text, duration_minutes integer, price_cents integer, default_capacity integer/);

  assert.match(dynamic, /p_default_capacity integer,p_editorial_content jsonb\)/);
  assert.match(dynamic, /editorial_content jsonb, sessions_count bigint/);
  for (const sql of [dashboard, operations, dynamic]) {
    assert.match(sql, /security definer/);
    assert.match(sql, /set search_path\s*=\s*public|set search_path=public/);
  }
});

test("banco anterior à Sprint 5.2 recebe coluna e novas sobrecargas sem remoção ampla", () => {
  assert.match(dynamic, /add column if not exists editorial_content jsonb/);
  assert.match(dynamic, /where editorial_content is null/);
  assert.match(dynamic, /alter column editorial_content set default '\{\}'::jsonb/);
  assert.match(dynamic, /alter column editorial_content set not null/);
  assert.match(dynamic, /create or replace function public\.admin_create_experience/);
  assert.match(dynamic, /create or replace function public\.admin_update_experience/);
  assert.doesNotMatch(dynamic, /drop function if exists public\.admin_(create|update)_experience/);
  const executable = dynamic.replace(/^\s*--.*$/gm, "");
  assert.doesNotMatch(executable, /drop function[^;]*cascade/i);
});

test("banco parcialmente atualizado substitui RPCs escalares e trata retorno tabular explicitamente", () => {
  assert.match(dynamic, /to_regprocedure\('public\.admin_list_experiences\(uuid\)'\)/);
  assert.match(dynamic, /existing_output_types is distinct from expected_output_types/);
  assert.match(dynamic, /existing_output_names is distinct from expected_output_names/);
  assert.match(dynamic, /execute 'drop function public\.admin_list_experiences\(uuid\)'/);
  assert.match(dynamic, /create or replace function public\.admin_list_experiences/);
  assert.equal((dynamic.match(/create or replace function public\.admin_create_experience/g) ?? []).length, 1);
  assert.equal((dynamic.match(/create or replace function public\.admin_update_experience/g) ?? []).length, 1);
});

test("migration já aplicada pode ser repetida com constraints e grants idempotentes", () => {
  assert.match(dynamic, /conrelid = 'public\.experiences'::regclass/);
  assert.equal((dynamic.match(/create or replace function public\.(experience_editorial_is_publishable|get_public_experience|list_public_experiences)/g) ?? []).length, 3);
  assert.match(dynamic, /revoke all on function public\.admin_create_experience\([^)]*jsonb\) from public, anon, authenticated/);
  assert.match(dynamic, /grant execute on function public\.admin_create_experience\([^)]*jsonb\) to service_role/);
  assert.match(dynamic, /revoke all on function public\.admin_list_experiences\(uuid\) from public, anon, authenticated/);
  assert.match(dynamic, /grant execute on function public\.admin_list_experiences\(uuid\) to service_role/);
});

test("SQL diagnóstico é somente leitura e informa coluna, assinaturas, retornos e segurança", () => {
  const executable = diagnostic.replace(/^\s*--.*$/gm, "");
  assert.doesNotMatch(executable, /\b(insert|update|delete|alter|create|drop|truncate|grant|revoke|do)\b/i);
  assert.match(diagnostic, /editorial_content_exists/);
  for (const name of [
    "admin_create_experience",
    "admin_update_experience",
    "admin_list_experiences",
    "get_public_experience",
    "list_public_experiences",
    "experience_editorial_is_publishable",
  ]) assert.match(diagnostic, new RegExp(`\\('${name}'\\)`));
  assert.match(diagnostic, /pg_get_function_identity_arguments/);
  assert.match(diagnostic, /pg_get_function_result/);
  assert.match(diagnostic, /security_definer/);
  assert.match(diagnostic, /function_settings/);
  assert.match(diagnostic, /service_role_can_execute/);
});
