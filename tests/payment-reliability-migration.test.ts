/**
 * Invariantes de `202608280001_payment_confirmation_reliability.sql`.
 *
 * Estas asserções são sobre o texto do SQL de propósito: são o contrato que
 * precisa valer **antes** de a migration ser aplicada em produção, e o CI não
 * tem Postgres para executá-la. O comportamento em si é exercitado de duas
 * formas complementares:
 *
 *   * `payment-reliability.test.ts` roda a orquestração de verdade contra um
 *     banco em memória fiel às RPCs;
 *   * `supabase/diagnostics/payment_reliability_selftest.sql` roda a mesma
 *     matriz de cenários dentro de um Postgres real, em transação com
 *     `rollback` no fim.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const MIGRATION = "supabase/migrations/202608280001_payment_confirmation_reliability.sql";
const migration = source(MIGRATION);

function functionBody(name: string) {
  const start = migration.indexOf(`create or replace function public.${name}`);
  assert.ok(start >= 0, `a migration precisa declarar ${name}`);
  const end = migration.indexOf("\ncreate or replace function", start + 1);
  return migration.slice(start, end === -1 ? migration.length : end);
}

// --- A causa raiz: expiração cega -------------------------------------------

test("a expiração deixa de assumir que ausência de confirmação é ausência de pagamento", () => {
  const body = functionBody("expire_pre_reservations");

  // Retém antes de liberar: toda pré-reserva vencida que chegou a gerar
  // checkout entra em janela de segurança.
  assert.match(body, /payment_hold_until is null/);
  assert.match(body, /checkout_url is not null/);
  assert.match(body, /EXPIRATION_HELD_FOR_PAYMENT_CHECK/);

  // E a liberação sem resposta definitiva do gateway sempre deixa incidente.
  assert.match(body, /PAYMENT_HOLD_EXHAUSTED/);
  assert.match(body, /coalesce\(r\.last_reconciliation_code, ''\) <> 'NOT_PAID'/);

  // A retenção acontece antes da expiração no corpo da função.
  assert.ok(
    body.indexOf("EXPIRATION_HELD_FOR_PAYMENT_CHECK") < body.indexOf("set status = 'EXPIRED'"),
    "reter precisa vir antes de expirar",
  );
});

test("a retenção empurra expires_at, que é o predicado que todo o resto já usa", () => {
  const body = functionBody("expire_pre_reservations");
  // É isto que faz `available_spots`, `create_pre_reservation`,
  // `admin_confirm_reservation` e `admin_change_reservation_session`
  // respeitarem a janela de segurança sem serem reescritas.
  assert.match(body, /expires_at = greatest\(r\.expires_at \+ make_interval\(mins => hold_minutes\)/);
  assert.match(body, /original_expires_at = coalesce\(r\.original_expires_at, r\.expires_at\)/);
});

test("o prazo original do cliente é preservado para auditoria", () => {
  assert.match(migration, /add column if not exists original_expires_at timestamptz/);
  assert.match(migration, /add column if not exists payment_hold_until timestamptz/);
  assert.match(migration, /add column if not exists payment_hold_started_at timestamptz/);
});

// --- Liberar a vaga exige resposta positiva do gateway ----------------------

test("só um veredito definitivo devolve a vaga ao mercado", () => {
  const body = functionBody("release_reservation_payment_hold");
  assert.match(body, /not in \('NOT_PAID', 'CANCELLED', 'SESSION_CANCELLED', 'RESERVATION_NOT_FOUND'\)/);
  assert.match(body, /return false;/, "qualquer outro código precisa ser recusado");
  // Erro de rede e timeout não aparecem na whitelist.
  assert.doesNotMatch(body, /PROVIDER_UNAVAILABLE/);
});

test("a retenção tem teto absoluto contado do prazo original", () => {
  const body = functionBody("hold_reservation_for_payment_check");
  assert.match(body, /coalesce\(target\.original_expires_at, target\.expires_at\)/);
  assert.match(body, /payment_hold_max_minutes\(\)/);
  assert.match(body, /least\(now\(\) \+ make_interval/, "um gateway fora do ar não pode congelar a capacidade");
});

// --- Pagamento tardio sem capacidade ----------------------------------------

test("pagamento aprovado sem vaga vira incidente explícito e nunca silêncio", () => {
  const body = functionBody("reconcile_reservation_payment");
  assert.match(body, /PAYMENT_AFTER_EXPIRATION_NO_CAPACITY/);
  assert.match(body, /last_reconciliation_code = 'NO_CAPACITY'/);
  assert.match(body, /return 'NO_CAPACITY';/);

  // E nunca confirma por cima da capacidade.
  assert.ok(
    body.indexOf("occupied + target.quantity > target_session.capacity") < body.indexOf("PAYMENT_CONFIRMED_RECONCILED"),
    "a checagem de capacidade precede a confirmação",
  );
});

test("a reconciliação recontabiliza ocupação a partir das linhas reais", () => {
  const body = functionBody("reconcile_reservation_payment");
  assert.match(body, /for update/, "a sessão precisa ser travada antes de recontar");
  assert.match(body, /status = 'CONFIRMED' or \(status = 'PRE_RESERVED' and expires_at > now\(\)\)/);
});

// --- Fila da reconciliação ---------------------------------------------------

test("a fila cobre as quatro origens do incidente", () => {
  const body = functionBody("claim_payment_reconciliation");
  assert.match(body, /c\.expires_at <= now\(\) \+ interval '10 minutes'/, "prestes a vencer");
  assert.match(body, /c\.payment_hold_until is not null and c\.payment_hold_until > now\(\)/, "em janela de segurança");
  assert.match(body, /c\.status = 'EXPIRED' and c\.updated_at > now\(\) - make_interval\(hours => lookback\)/, "recém-expirada");
  assert.match(body, /'PAYMENT_WEBHOOK_RECEIVED', 'PAYMENT_NOT_CONFIRMED'/, "com sinal de pagamento");
});

test("a reivindicação é segura para execuções simultâneas e para retry", () => {
  const body = functionBody("claim_payment_reconciliation");
  assert.match(body, /for update skip locked/);
  assert.match(body, /reconciliation_attempts = r\.reconciliation_attempts \+ 1/);
  assert.match(body, /last_reconciled_at = now\(\)/);
  // Uma reserva já confirmada nunca volta para a fila.
  assert.match(body, /'PAYMENT_CONFIRMED', 'PAYMENT_CONFIRMED_MANUAL', 'PAYMENT_CONFIRMED_RECONCILED'/);
});

// --- Trilha durável ----------------------------------------------------------

test("a trilha aceita webhook que não casa com nenhuma reserva", () => {
  assert.match(migration, /create table if not exists public\.payment_webhook_log/);
  // O que `payment_events` não consegue guardar: reservation_id anulável.
  assert.match(migration, /reservation_id uuid references public\.reservations\(id\) on delete set null/);
  assert.match(migration, /order_id text/);
});

test("a trilha nunca derruba um pagamento", () => {
  const body = functionBody("record_payment_step");
  assert.match(body, /exception when others then/);
  assert.match(body, /return null;/);
});

test("códigos gravados são símbolos curtos, nunca mensagem de gateway", () => {
  assert.match(migration, /last_reconciliation_code is null or last_reconciliation_code ~ '\^\[A-Z0-9_\]\{1,64\}\$'/);
  assert.match(migration, /error_code is null or error_code ~ '\^\[A-Z0-9_\]\{1,64\}\$'/);
  assert.match(migration, /step ~ '\^\[A-Z0-9_\]\{1,64\}\$'/);
});

// --- Revisão administrativa ---------------------------------------------------

test("a revisão administrativa não projeta dado pessoal", () => {
  const body = functionBody("admin_payments_needing_review");
  for (const proibido of ["full_name", "cpf_hash", "cpf_last4", "r.email", "r.phone", "checkout_url", "pe.payload"]) {
    assert.ok(!body.includes(proibido), `${proibido} não pode sair na revisão administrativa`);
  }
  assert.match(body, /is_active_admin/, "a fila é restrita a admin ativo");
});

test("a revisão cobre as situações que a equipe conferia no extrato", () => {
  const body = functionBody("payment_review_reason");
  for (const motivo of [
    "APPROVED_NO_CAPACITY",
    "PAID_NOT_CONFIRMED",
    "AMOUNT_MISMATCH",
    "HOLD_EXHAUSTED",
    "RECONCILIATION_FAILING",
    "EXPIRED_WITH_PAYMENT_SIGNAL",
  ]) {
    assert.ok(body.includes(motivo), `${motivo} precisa estar na classificação`);
  }
});

test("uma reserva recuperada pela reconciliação deixa de aparecer como não paga", () => {
  // Regressão: o CASE do painel não conhecia PAYMENT_CONFIRMED_RECONCILED e
  // mostrava NOT_PAID para reservas efetivamente pagas.
  const listagem = migration.slice(migration.indexOf("create or replace function public.admin_list_reservations"));
  assert.match(listagem, /'PAYMENT_CONFIRMED','PAYMENT_CONFIRMED_MANUAL','PAYMENT_CONFIRMED_RECONCILED'/);
  assert.match(functionBody("reservation_payment_status"), /'PAYMENT_CONFIRMED_RECONCILED'/);
});

// --- Segurança e idempotência da própria migration ---------------------------

test("a migration é aditiva e idempotente", () => {
  assert.match(migration, /add column if not exists/);
  assert.match(migration, /create table if not exists/);
  assert.match(migration, /create index if not exists/);
  assert.doesNotMatch(migration, /\bdrop table\b/i);
  assert.doesNotMatch(migration, /\bdrop column\b/i);
  assert.doesNotMatch(migration, /\btruncate\b/i);
  assert.doesNotMatch(migration, /\bdelete from\b/i);
});

test("nenhuma reserva, sessão ou pagamento existente é alterado pela aplicação da migration", () => {
  // Todo `update`/`insert` da migration está dentro de corpo de função — nada é
  // executado no momento em que ela é aplicada.
  const foraDeFuncao = migration.split("$$").filter((_, index) => index % 2 === 0).join("\n");
  assert.doesNotMatch(foraDeFuncao, /^\s*update\s+public\./im);
  assert.doesNotMatch(foraDeFuncao, /^\s*insert\s+into\s+public\.(reservations|payment_events|sessions)/im);
});

test("as funções novas ficam restritas ao service role", () => {
  for (const fn of [
    "record_payment_step",
    "hold_reservation_for_payment_check",
    "release_reservation_payment_hold",
    "claim_payment_reconciliation",
    "admin_payments_needing_review",
  ]) {
    assert.ok(
      migration.includes(`revoke all on function public.${fn}`),
      `${fn} precisa ser revogada de anon/authenticated`,
    );
    assert.ok(
      migration.includes(`grant execute on function public.${fn}`),
      `${fn} precisa ser concedida ao service role`,
    );
  }
  assert.match(migration, /alter table public\.payment_webhook_log enable row level security/);
  assert.match(migration, /revoke all on public\.payment_webhook_log from anon, authenticated/);
});

// --- Cadeia de confirmação ----------------------------------------------------

test("a confirmação limpa o estado de retenção", () => {
  const body = functionBody("confirm_reservation_payment");
  assert.match(body, /payment_hold_until = null/);
  assert.match(body, /last_reconciliation_code = 'CONFIRMED'/);
  // O invariante de valor continua exato.
  assert.match(body, /if target\.total_cents <> p_amount_cents then return false; end if;/);
});

test("a janela de segurança é maior que a cadência da reconciliação oportunista", () => {
  const hold = Number(migration.match(/payment_hold_minutes\(\)\s*\nreturns integer language sql immutable as \$\$ select (\d+) \$\$/)?.[1]);
  const max = Number(migration.match(/payment_hold_max_minutes\(\)\s*\nreturns integer language sql immutable as \$\$ select (\d+) \$\$/)?.[1]);
  assert.ok(Number.isInteger(hold) && hold >= 15, "a janela precisa dar tempo de pelo menos uma verificação");
  assert.ok(Number.isInteger(max) && max > hold, "o teto precisa ser maior que a janela");
});
