import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(
  new URL("../supabase/migrations/202608190001_reservation_confirmation_email.sql", import.meta.url),
  "utf8",
);

/** Só o SQL executável: comentários explicam o contrato, não o cumprem. */
function statements(text: string) {
  return text.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
}

test("só reserva confirmada pode gerar e-mail, e a checagem é do banco", () => {
  const claim = sql.slice(
    sql.indexOf("function public.claim_reservation_confirmation_email"),
    sql.indexOf("function public.claim_pending_confirmation_emails"),
  );

  assert.match(claim, /where id = p_reservation_id and status = 'CONFIRMED'/);
  assert.match(claim, /return null;/);

  // O payload da mensagem também exige CONFIRMED: segunda tranca.
  const payload = sql.slice(sql.indexOf("function public.reservation_confirmation_email"));
  assert.match(payload, /and r\.status = 'CONFIRMED'/);
});

test("um e-mail já enviado nunca é reivindicado de novo", () => {
  const claim = sql.slice(
    sql.indexOf("function public.claim_reservation_confirmation_email"),
    sql.indexOf("function public.claim_pending_confirmation_emails"),
  );

  // A reivindicação só devolve id quando a linha não existe ou existe e falhou.
  // SYNCED e PENDING não passam pela cláusula, então nada é devolvido.
  assert.match(claim, /on conflict \(integration, entity_type, entity_id\) do update/);
  assert.match(claim, /where integration_sync_jobs\.status = 'FAILED'/);
  assert.match(claim, /and integration_sync_jobs\.attempts < max_attempts/);
  assert.match(claim, /'RESERVATION_CONFIRMATION_EMAIL'/);
});

test("a recuperação de pendências não ressuscita reserva cancelada", () => {
  const drain = sql.slice(
    sql.indexOf("function public.claim_pending_confirmation_emails"),
    sql.indexOf("function public.reservation_confirmation_email"),
  );

  assert.match(drain, /join public\.reservations r on r\.id = k\.entity_id/);
  assert.match(drain, /and r\.status = 'CONFIRMED'/);
  assert.match(drain, /k\.status <> 'SYNCED'/);
  assert.match(drain, /for update skip locked/);
  // Envio preso em PENDING volta a ser tentado só depois da carência.
  assert.match(drain, /make_interval\(mins => greatest\(coalesce\(p_stale_minutes, 15\), 1\)\)/);
});

test("o payload leva o mínimo para escrever a mensagem e nada além", () => {
  const payload = statements(sql.slice(sql.indexOf("function public.reservation_confirmation_email")));

  for (const campo of ["publicCode", "fullName", "email", "startsAt", "experienceTitle"]) {
    assert.match(payload, new RegExp(campo), `o e-mail precisa de ${campo}`);
  }
  for (const proibido of ["cpf_hash", "cpf_last4", "checkout_url", "provider_reference", "r.phone", "r.notes"]) {
    assert.doesNotMatch(payload, new RegExp(proibido.replace(".", "\\.")), `${proibido} não pode sair do banco`);
  }
});

test("a migration é aditiva e não cria tabela nova", () => {
  const executable = statements(sql);

  assert.match(executable, /create or replace function/);
  assert.doesNotMatch(executable, /create table/, "reaproveita integration_sync_jobs");
  assert.doesNotMatch(executable, /drop table|drop function|truncate|delete from/i);
  assert.doesNotMatch(executable, /alter table public\.(reservations|sessions|experiences|payment_events)/);
});

test("tudo fica restrito ao service_role", () => {
  for (const name of [
    "claim_reservation_confirmation_email",
    "claim_pending_confirmation_emails",
    "reservation_confirmation_email",
  ]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated`));
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role`));
  }
});
