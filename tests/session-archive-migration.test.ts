import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const statusMigrationUrl = new URL("../supabase/migrations/202608040001_session_archived_status.sql", import.meta.url);
const workflowMigrationUrl = new URL("../supabase/migrations/202608040002_session_archive_workflow.sql", import.meta.url);

test("migration adiciona ARCHIVED ao enum session_status sem apagar dados", async () => {
  const sql = await readFile(statusMigrationUrl, "utf8");
  assert.match(sql, /alter type public\.session_status add value if not exists 'ARCHIVED'/i);
  assert.doesNotMatch(sql, /drop type|delete from|truncate/i);
});

test("workflow de arquivamento não usa delete em cascata nem apaga reservas/pagamentos", async () => {
  const sql = await readFile(workflowMigrationUrl, "utf8");
  assert.doesNotMatch(sql, /cascade/i);
  assert.doesNotMatch(sql, /delete from public\.reservations/i);
  assert.doesNotMatch(sql, /delete from public\.payment_events/i);
});

test("admin_delete_session arquiva sessões com reservas em vez de bloquear a exclusão", async () => {
  const sql = await readFile(workflowMigrationUrl, "utf8");
  assert.match(sql, /create or replace function public\.admin_delete_session/i);
  assert.match(sql, /SESSION_ALREADY_ARCHIVED/);
  assert.match(sql, /'SESSION_ARCHIVED'/);
  assert.match(sql, /update public\.sessions set status = 'ARCHIVED'/i);
  assert.match(sql, /delete from public\.sessions where id = p_session_id/i);
});

test("admin_restore_session existe, valida arquivamento, data futura e conflito de horário", async () => {
  const sql = await readFile(workflowMigrationUrl, "utf8");
  assert.match(sql, /create or replace function public\.admin_restore_session/i);
  assert.match(sql, /SESSION_NOT_ARCHIVED/);
  assert.match(sql, /SESSION_RESTORE_PAST/);
  assert.match(sql, /SESSION_RESTORE_CONFLICT/);
  assert.match(sql, /revoke all on function public\.admin_restore_session\(uuid, uuid\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.admin_restore_session\(uuid, uuid\) to service_role/i);
});

test("admin_list_sessions aceita filtro de arquivamento e admin_dashboard_metrics exclui sessões arquivadas", async () => {
  const sql = await readFile(workflowMigrationUrl, "utf8");
  assert.match(sql, /create function public\.admin_list_sessions\(p_actor_id uuid, p_filter text default 'ACTIVE'\)/i);
  assert.match(sql, /status not in \('CANCELLED', 'ARCHIVED'\)/);
});
