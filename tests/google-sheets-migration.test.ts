import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(
  new URL("../supabase/migrations/202608180001_google_sheets_sync.sql", import.meta.url),
  "utf8",
);

/** Só o SQL executável: comentários explicam o contrato, não o cumprem. */
function statements(text: string) {
  return text.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
}

test("a fila de sincronização é durável, auditável e única por entidade", () => {
  assert.match(sql, /create table if not exists public\.integration_sync_jobs/);

  for (const field of ["integration", "entity_type", "entity_id", "operation", "status", "attempts", "last_error_code", "created_at", "updated_at", "synced_at"]) {
    assert.match(sql, new RegExp(`\\b${field}\\b`), `campo ${field} ausente`);
  }

  // Um webhook repetido não cria job novo: a chave é (integração, entidade).
  assert.match(sql, /create unique index if not exists integration_sync_jobs_entity_key\s+on public\.integration_sync_jobs \(integration, entity_type, entity_id\)/);
  assert.match(sql, /on conflict \(integration, entity_type, entity_id\) do update/);
});

test("o código de erro gravado é um símbolo curto, nunca uma mensagem do Google", () => {
  assert.match(sql, /last_error_code is null or last_error_code ~ '\^\[A-Z0-9_\]\{1,64\}\$'/);
  // A própria função normaliza antes de gravar, então a constraint nunca é violada.
  assert.match(sql, /regexp_replace\(coalesce\(nullif\(trim\(p_error_code\), ''\), 'UNKNOWN_ERROR'\), '\[\^A-Za-z0-9_\]', '_', 'g'\)/);
  // A fila guarda estado e código de erro. Nunca payload, credencial ou token.
  const queue = statements(sql.slice(0, sql.indexOf("-- 3. Snapshots operacionais")));
  assert.doesNotMatch(queue, /payload|credential|private_key|token|secret/i);
});

test("falha conta tentativa e mantém o job recuperável", () => {
  const fail = sql.slice(sql.indexOf("function public.fail_integration_sync_job"), sql.indexOf("function public.integration_sync_state"));
  assert.match(fail, /status = 'FAILED'/);
  assert.match(fail, /attempts = attempts \+ 1/);

  const claim = sql.slice(sql.indexOf("function public.claim_integration_sync_jobs"), sql.indexOf("function public.complete_integration_sync_job"));
  assert.match(claim, /status <> 'SYNCED'/);
  assert.match(claim, /attempts < greatest\(coalesce\(p_max_attempts, 5\), 1\)/);
  assert.match(claim, /for update skip locked/, "duas execuções simultâneas não podem pegar o mesmo job");
  assert.doesNotMatch(claim, /attempts = /, "reservar não conta tentativa; falhar conta");
});

test("os snapshots devolvem o mínimo operacional e nenhum dado sensível", () => {
  const snapshots = statements(sql.slice(sql.indexOf("-- 3. Snapshots operacionais")));

  for (const allowed of ["publicCode", "fullName", "phone", "quantity", "totalCents", "paymentStatus", "paymentMethod", "experienceTitle", "capacity", "remainingSpots"]) {
    assert.match(snapshots, new RegExp(allowed), `o snapshot precisa expor ${allowed}`);
  }

  // O contrato de privacidade é imposto aqui, no banco: a aplicação nunca
  // recebe estes campos, então não tem como enviá-los à planilha.
  for (const forbidden of ["cpf_hash", "cpf_last4", "r.email", "checkout_url", "provider_reference", "r.notes"]) {
    assert.doesNotMatch(snapshots, new RegExp(forbidden.replace(".", "\\.")), `${forbidden} não pode sair do banco`);
  }
});

test("a integração só lê: nada altera reserva, sessão, vaga ou capacidade", () => {
  const snapshots = statements(sql.slice(sql.indexOf("-- 3. Snapshots operacionais")));

  assert.doesNotMatch(snapshots, /update public\.(reservations|sessions|experiences)/);
  assert.doesNotMatch(snapshots, /insert into public\.(reservations|sessions|experiences|payment_events)/);
  assert.doesNotMatch(snapshots, /delete from/);

  // Capacidade e vagas restantes continuam vindo das funções que já existiam.
  assert.match(snapshots, /public\.available_spots\(s\.id\)/);
  assert.match(snapshots, /'capacity', s\.capacity/);
});

test("a migration é aditiva, idempotente e não apaga nada", () => {
  assert.match(sql, /create table if not exists/);
  assert.match(sql, /create unique index if not exists/);
  assert.match(sql, /create or replace function/);
  assert.match(sql, /exception when duplicate_object then null/);

  const executable = statements(sql);
  assert.doesNotMatch(executable, /drop table|drop function|truncate|delete from/i);
  assert.doesNotMatch(executable, /alter table public\.(reservations|sessions|experiences|payment_events)/);
});

test("tudo fica restrito ao service_role", () => {
  assert.match(sql, /alter table public\.integration_sync_jobs enable row level security/);
  assert.match(sql, /revoke all on public\.integration_sync_jobs from anon, authenticated/);

  const functions = [
    "enqueue_integration_sync_job",
    "claim_integration_sync_jobs",
    "complete_integration_sync_job",
    "fail_integration_sync_job",
    "integration_sync_state",
    "google_sheets_reservation_snapshot",
    "google_sheets_session_snapshot",
  ];
  for (const name of functions) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated`), `${name} precisa ser revogada`);
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role`), `${name} precisa ser concedida ao service_role`);
  }
});

test("o status de pagamento da planilha é o mesmo que o admin já mostra", () => {
  assert.match(sql, /'PAYMENT_CONFIRMED', 'PAYMENT_CONFIRMED_MANUAL', 'PAYMENT_CONFIRMED_RECONCILED'/);
  assert.match(sql, /'PAID_AFTER_EXPIRATION'/);
  assert.match(sql, /r\.status = 'PRE_RESERVED' and r\.expires_at > now\(\) then 'PENDING'/);
});
