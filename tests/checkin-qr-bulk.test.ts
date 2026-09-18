import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { runQrBulk, type QrBulkClaim, type QrBulkDeps } from "../lib/checkin/qr-bulk.ts";
import { EmailProviderError, sanitizeEmailErrorCode } from "../lib/email/email-provider.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

// =============================================================================
// Banco real (PGlite): migrations de check-in aplicadas sobre um schema mínimo.
// Nenhum e-mail é enviado: o "envio" é só a sequência claim → complete/fail.
// =============================================================================

const ADMIN = "00000000-0000-4000-8000-00000000000a";
const OUTSIDER = "00000000-0000-4000-8000-00000000000b";
const FUTURE = "00000000-0000-4000-8000-000000000051";
const PAST = "00000000-0000-4000-8000-000000000052";
const EXP = "00000000-0000-4000-8000-0000000000e1";
const R = {
  eligible: "00000000-0000-4000-8000-000000000101",
  eligible2: "00000000-0000-4000-8000-000000000102",
  resent: "00000000-0000-4000-8000-000000000103",
  qrInConfirmation: "00000000-0000-4000-8000-000000000104",
  oldConfirmation: "00000000-0000-4000-8000-000000000105",
  cancelled: "00000000-0000-4000-8000-000000000106",
  expired: "00000000-0000-4000-8000-000000000107",
  past: "00000000-0000-4000-8000-000000000108",
  noToken: "00000000-0000-4000-8000-000000000109",
  noEmail: "00000000-0000-4000-8000-000000000110",
};

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users (id uuid primary key);
    create type public.reservation_status as enum ('PRE_RESERVED','CONFIRMED','EXPIRED','CANCELLED');
    create table public.bases (id uuid primary key default gen_random_uuid(), name text);
    create table public.experiences (id uuid primary key, title text not null, base_id uuid);
    create table public.sessions (id uuid primary key, experience_id uuid not null, starts_at timestamptz not null, capacity int not null default 10, status text not null default 'OPEN');
    create table public.reservations (
      id uuid primary key, public_code text not null, experience_id uuid not null, session_id uuid not null,
      status public.reservation_status not null, full_name text not null, email text, quantity int not null,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table public.admin_users (user_id uuid primary key, display_name text, role text, is_active boolean);
    create table public.admin_audit_log (id uuid primary key default gen_random_uuid(), actor_user_id uuid, action text not null,
      entity_type text not null, entity_id uuid, reason text, metadata jsonb not null default '{}', created_at timestamptz default now());
    create table public.integration_sync_jobs (id uuid primary key default gen_random_uuid(), integration text not null, entity_type text not null,
      entity_id uuid not null, operation text not null, status text not null default 'PENDING', attempts int not null default 0,
      last_error_code text, created_at timestamptz default now(), updated_at timestamptz default now(), synced_at timestamptz);
    create unique index integration_sync_jobs_entity_key on public.integration_sync_jobs (integration, entity_type, entity_id);
    create function public.is_active_admin(p uuid) returns boolean language sql stable as
      $$ select exists (select 1 from public.admin_users where user_id = p and is_active) $$;
    create function public.fail_integration_sync_job(p_job_id uuid, p_error_code text) returns boolean language plpgsql as $$
      begin update public.integration_sync_jobs set status = 'FAILED', attempts = attempts + 1, last_error_code = p_error_code, updated_at = now()
        where id = p_job_id; return found; end $$;
    create function public.reservation_confirmation_email(p_reservation_id uuid) returns jsonb language sql as $$ select '{}'::jsonb $$;

    insert into auth.users values ('${ADMIN}'), ('${OUTSIDER}');
    insert into public.admin_users values ('${ADMIN}', 'Admin', 'ADMIN', true);
    insert into public.experiences values ('${EXP}', 'Imersão Paranoá', null);
    insert into public.sessions (id, experience_id, starts_at) values
      ('${FUTURE}', '${EXP}', now() + interval '2 days'), ('${PAST}', '${EXP}', now() - interval '2 days');
  `);
  const reservation = (id: string, status: string, session = FUTURE, email: string | null = "cliente@exemplo.com", quantity = 2) =>
    `('${id}', 'C${id.slice(-3)}', '${EXP}', '${session}', '${status}', 'Cliente', ${email === null ? "null" : `'${email}'`}, ${quantity})`;
  await db.exec(`insert into public.reservations (id, public_code, experience_id, session_id, status, full_name, email, quantity) values
    ${[
      reservation(R.eligible, "CONFIRMED"),
      reservation(R.eligible2, "CONFIRMED", FUTURE, "outra@exemplo.com", 3),
      reservation(R.resent, "CONFIRMED"),
      reservation(R.qrInConfirmation, "CONFIRMED"),
      reservation(R.oldConfirmation, "CONFIRMED"),
      reservation(R.cancelled, "CANCELLED"),
      reservation(R.expired, "EXPIRED"),
      reservation(R.past, "CONFIRMED", PAST),
      reservation(R.noToken, "PRE_RESERVED"),
      reservation(R.noEmail, "CONFIRMED", FUTURE, "sem-arroba"),
    ].join(",")};`);

  await db.exec(source("supabase/migrations/202609180001_reservation_checkin.sql"));
  await db.exec(source("supabase/migrations/202609190001_checkin_qr_bulk.sql"));

  // Reserva confirmada que perdeu o token só pode existir por intervenção
  // manual; a trigger regenera se o status for tocado, então o teste desliga
  // a trigger só para montar o cenário.
  await db.exec(`
    alter table public.reservations disable trigger reservations_ensure_checkin_token;
    update public.reservations set status = 'CONFIRMED', checkin_token = null where id = '${R.noToken}';
    alter table public.reservations enable trigger reservations_ensure_checkin_token;
    insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id) values ('${ADMIN}', 'CHECKIN_QR_RESENT', 'RESERVATION', '${R.resent}');
    insert into public.integration_sync_jobs (integration, entity_type, entity_id, operation, status, synced_at) values
      ('RESERVATION_CONFIRMATION_EMAIL', 'RESERVATION', '${R.qrInConfirmation}', 'SEND', 'SYNCED', '2026-09-18 17:00+00'),
      ('RESERVATION_CONFIRMATION_EMAIL', 'RESERVATION', '${R.oldConfirmation}', 'SEND', 'SYNCED', '2026-09-10 12:00+00');
  `);
  return db;
}

async function candidates(db: PGlite) {
  const result = await db.query<{ reservation_id: string }>("select reservation_id from public.admin_checkin_qr_bulk_candidates($1)", [ADMIN]);
  return result.rows.map((row) => row.reservation_id).sort();
}

async function eligibility(db: PGlite, id: string) {
  return (await db.query<{ e: string }>("select public.checkin_qr_bulk_eligibility($1) e", [id])).rows[0].e;
}

async function tokens(db: PGlite) {
  return (await db.query<{ id: string; t: string | null }>("select id, checkin_token::text t from public.reservations order by id")).rows;
}

/** Liga o orquestrador ao banco de teste; `send` é injetado (nada sai). */
function dbDeps(db: PGlite, send: QrBulkDeps["send"]): QrBulkDeps {
  return {
    claim: async (id) => (await db.query<{ j: Record<string, unknown> }>("select public.admin_checkin_qr_bulk_claim($1, $2) j", [ADMIN, id])).rows[0].j as QrBulkClaim,
    send,
    complete: async (jobId) => (await db.query<{ ok: boolean }>("select public.admin_checkin_qr_bulk_complete($1, $2) ok", [ADMIN, jobId])).rows[0].ok,
    fail: async (jobId, code) => { await db.query("select public.admin_checkin_qr_bulk_fail($1, $2, $3)", [ADMIN, jobId, code]); },
    sanitizeError: sanitizeEmailErrorCode,
    sleep: async () => undefined,
  };
}

test("elegibilidade: cada critério do dry run", async () => {
  const db = await database();
  assert.equal(await eligibility(db, R.eligible), "ELIGIBLE");
  assert.equal(await eligibility(db, R.oldConfirmation), "ELIGIBLE"); // confirmação antes do corte, sem QR
  assert.equal(await eligibility(db, R.resent), "ALREADY_RESENT");
  assert.equal(await eligibility(db, R.qrInConfirmation), "QR_IN_CONFIRMATION");
  assert.equal(await eligibility(db, R.cancelled), "NOT_CONFIRMED");
  assert.equal(await eligibility(db, R.expired), "NOT_CONFIRMED");
  assert.equal(await eligibility(db, R.past), "PAST_SESSION");
  assert.equal(await eligibility(db, R.noToken), "NO_TOKEN");
  assert.equal(await eligibility(db, R.noEmail), "NO_EMAIL");
  assert.deepEqual(await candidates(db), [R.eligible, R.eligible2, R.oldConfirmation].sort());
});

test("candidatos exigem administrador ativo", async () => {
  const db = await database();
  await assert.rejects(db.query("select * from public.admin_checkin_qr_bulk_candidates($1)", [OUTSIDER]), /ADMIN_FORBIDDEN/);
  await assert.rejects(db.query("select public.admin_checkin_qr_bulk_claim($1, $2)", [OUTSIDER, R.eligible]), /ADMIN_FORBIDDEN/);
});

test("lote envia os elegíveis, grava CHECKIN_QR_RESENT e não regenera token", async () => {
  const db = await database();
  const before = await tokens(db);
  const sent: unknown[] = [];
  const report = await runQrBulk(await candidates(db), dbDeps(db, async (payload) => { sent.push(payload); }));

  assert.equal(report.sent, 3);
  assert.equal(report.failed.length, 0);
  assert.equal(sent.length, 3);
  assert.deepEqual(await tokens(db), before);
  const audit = await db.query<{ n: number }>("select count(*)::int n from public.admin_audit_log where action = 'CHECKIN_QR_RESENT' and metadata->>'source' = 'BULK'");
  assert.equal(audit.rows[0].n, 3);
  assert.deepEqual(await candidates(db), []);
});

test("execução repetida do lote não reenvia para ninguém", async () => {
  const db = await database();
  const ids = await candidates(db);
  let sends = 0;
  await runQrBulk(ids, dbDeps(db, async () => { sends += 1; }));
  // Segunda rodada com a MESMA lista antiga (ex.: duplo clique): tudo ignorado.
  const second = await runQrBulk(ids, dbDeps(db, async () => { sends += 1; }));
  assert.equal(sends, 3);
  assert.equal(second.sent, 0);
  assert.deepEqual(second.skipped, { ALREADY_RESENT: 3 });
});

test("dois lotes simultâneos nunca enviam a mesma reserva duas vezes", async () => {
  const db = await database();
  const ids = await candidates(db);
  const perReservation = new Map<string, number>();
  const send = async (payload: unknown) => {
    const id = (payload as { id?: string }).id ?? "x";
    perReservation.set(id, (perReservation.get(id) ?? 0) + 1);
  };
  const [a, b] = await Promise.all([runQrBulk(ids, dbDeps(db, send)), runQrBulk(ids, dbDeps(db, send))]);
  assert.equal(a.sent + b.sent, 3);
  const audit = await db.query<{ n: number; d: number }>("select count(*)::int n, count(distinct entity_id)::int d from public.admin_audit_log where action = 'CHECKIN_QR_RESENT' and metadata->>'source' = 'BULK'");
  assert.deepEqual(audit.rows[0], { n: 3, d: 3 });
});

test("falha individual não grava auditoria, segue o lote e a reserva continua pendente", async () => {
  const db = await database();
  const ids = await candidates(db);
  let calls = 0;
  const report = await runQrBulk(ids, dbDeps(db, async () => {
    calls += 1;
    if (calls === 1) throw new EmailProviderError("HTTP_500", true);
  }), { concurrency: 1 });

  assert.equal(report.processed, 3);
  assert.equal(report.sent, 2);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].errorCode, "HTTP_500");
  const failedId = report.failed[0].reservationId;
  const audit = await db.query("select 1 from public.admin_audit_log where entity_id = $1 and action = 'CHECKIN_QR_RESENT'", [failedId]);
  assert.equal(audit.rows.length, 0);
  assert.deepEqual(await candidates(db), [failedId]);

  // Nova rodada: só a que falhou é tentada, e agora sai.
  const retry = await runQrBulk(await candidates(db), dbDeps(db, async () => undefined));
  assert.equal(retry.sent, 1);
  assert.deepEqual(await candidates(db), []);
});

test("reserva cancelada entre a listagem e o envio é ignorada na revalidação", async () => {
  const db = await database();
  const ids = await candidates(db);
  await db.query("update public.reservations set status = 'CANCELLED' where id = $1", [R.eligible]);
  const report = await runQrBulk(ids, dbDeps(db, async () => undefined));
  assert.equal(report.sent, 2);
  assert.deepEqual(report.skipped, { NOT_CONFIRMED: 1 });
});

// =============================================================================
// Orquestrador isolado
// =============================================================================

function fakeDeps(overrides: Partial<QrBulkDeps> = {}): QrBulkDeps & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    claim: async (id) => ({ jobId: `job-${id}`, payload: { id } }),
    send: async (payload) => { log.push(`send:${(payload as { id: string }).id}`); },
    complete: async (jobId) => { log.push(`complete:${jobId}`); return true; },
    fail: async (jobId, code) => { log.push(`fail:${jobId}:${code}`); },
    sanitizeError: sanitizeEmailErrorCode,
    sleep: async () => undefined,
    ...overrides,
  };
}

test("orquestrador: auditoria só depois do envio; falha não conclui", async () => {
  const deps = fakeDeps({
    send: async (payload) => {
      if ((payload as { id: string }).id === "b") throw new EmailProviderError("HTTP_422", false);
    },
  });
  const report = await runQrBulk(["a", "b", "c"], deps, { concurrency: 1 });
  assert.deepEqual(deps.log, ["complete:job-a", "fail:job-b:HTTP_422", "complete:job-c"]);
  assert.equal(report.sent, 2);
  assert.deepEqual(report.failed, [{ reservationId: "b", errorCode: "HTTP_422" }]);
});

test("orquestrador: 429 tenta de novo uma vez; falha na conclusão é reportada", async () => {
  let attempts = 0;
  const deps = fakeDeps({
    send: async () => { attempts += 1; if (attempts === 1) throw new EmailProviderError("HTTP_429", true); },
    complete: async (jobId) => jobId !== "job-b",
  });
  const report = await runQrBulk(["a", "b"], deps, { concurrency: 1 });
  assert.equal(attempts, 3);
  assert.equal(report.sent, 1);
  assert.deepEqual(report.failed, [{ reservationId: "b", errorCode: "SENT_NOT_RECORDED" }]);
});

test("orquestrador: ritmo mínimo entre envios", async () => {
  let clock = 0;
  const starts: number[] = [];
  const deps = fakeDeps({
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    send: async () => { starts.push(clock); clock += 100; },
  });
  await runQrBulk(["a", "b", "c", "d"], deps, { concurrency: 1, minIntervalMs: 600 });
  assert.equal(starts.length, 4);
  for (let index = 1; index < starts.length; index += 1) assert.ok(starts[index] - starts[index - 1] >= 600);
});

test("orquestrador: no máximo N envios simultâneos e ids duplicados uma vez só", async () => {
  let active = 0;
  let peak = 0;
  const deps = fakeDeps({
    send: async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    },
  });
  const report = await runQrBulk(["a", "b", "c", "d", "e", "a"], deps, { concurrency: 2, minIntervalMs: 0 });
  assert.equal(report.processed, 5);
  assert.equal(report.sent, 5);
  assert.equal(peak, 2);
});

// =============================================================================
// Rota e interface
// =============================================================================

test("rota do lote: só ADMIN, mesma origem, sem número fixo", () => {
  const route = source("app/api/admin/checkin/qr-bulk/route.ts");
  assert.match(route, /authorizeAdminApi\(\)/);
  assert.match(route, /profile\.role !== "ADMIN"/);
  assert.match(route, /isSameOriginRequest/);
  const service = source("lib/checkin/qr-bulk-service.ts");
  assert.match(service, /buildCheckinReminderEmail/);
  assert.doesNotMatch(service, /\b99\b|\b245\b/);
});
