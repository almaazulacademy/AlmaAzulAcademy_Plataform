import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { sessionLocalToIso } from "../lib/sessions/date-time.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const migration = source("supabase/migrations/202608090001_september_2026_schedule.sql");
const preflight = source("supabase/diagnostics/september_2026_schedule_preflight.sql");
const postcheck = source("supabase/diagnostics/september_2026_schedule_postcheck.sql");

// Padrão semanal aprovado, em horário local de Brasília. isodow: 5 sexta, 6 sábado, 7 domingo.
const WEEKLY_SLOTS: Array<[number, string, string]> = [
  [5, "remada-nascer-do-sol", "05:30"],
  [5, "imersao-paranoa", "09:00"],
  [5, "remada-sunset", "17:00"],
  [6, "remada-nascer-do-sol", "06:00"],
  [6, "imersao-paranoa", "09:00"],
  [6, "imersao-paranoa", "12:00"],
  [6, "imersao-paranoa", "15:00"],
  [7, "imersao-paranoa", "09:00"],
  [7, "imersao-paranoa", "12:00"],
  [7, "imersao-paranoa", "15:00"],
  [7, "remada-sunset", "17:00"],
];

// Calendário derivado, não digitado: dias de setembro/2026 por dia da semana.
function septemberDays() {
  return Array.from({ length: 30 }, (_, index) => index + 1).map((day) => {
    const weekday = new Date(Date.UTC(2026, 8, day)).getUTCDay();
    return { day, isoDow: weekday === 0 ? 7 : weekday };
  });
}

function plannedSessions() {
  return septemberDays().flatMap(({ day, isoDow }) =>
    WEEKLY_SLOTS.filter(([slotDow]) => slotDow === isoDow).map(([, slug, localTime]) => {
      const localStartsAt = `2026-09-${String(day).padStart(2, "0")}T${localTime}`;
      return { day, isoDow, slug, localTime, localStartsAt, startsAtUtc: sessionLocalToIso(localStartsAt) };
    }),
  );
}

function slotsBlock(sql: string) {
  const block = sql.match(/slots \(iso_dow, slug, local_hour, local_minute\) as \(\s*values([\s\S]*?)\n\s*\)/);
  assert.ok(block, "bloco de horários não encontrado no SQL");
  return Array.from(block[1].matchAll(/\((\d+),\s*'([a-z-]+)',\s*(\d+),\s*(\d+)\)/g)).map((match) => [
    Number(match[1]),
    match[2],
    `${String(match[3]).padStart(2, "0")}:${String(match[4]).padStart(2, "0")}`,
  ] as [number, string, string]);
}

test("setembro de 2026 tem quatro sextas, quatro sábados e quatro domingos", () => {
  const days = septemberDays();
  assert.deepEqual(days.filter((item) => item.isoDow === 5).map((item) => item.day), [4, 11, 18, 25]);
  assert.deepEqual(days.filter((item) => item.isoDow === 6).map((item) => item.day), [5, 12, 19, 26]);
  assert.deepEqual(days.filter((item) => item.isoDow === 7).map((item) => item.day), [6, 13, 20, 27]);
});

test("a agenda planejada soma 44 sessões, e não 40", () => {
  const planned = plannedSessions();
  const byDow = (dow: number) => planned.filter((item) => item.isoDow === dow).length;
  assert.equal(byDow(5), 12);
  assert.equal(byDow(6), 16);
  assert.equal(byDow(7), 16);
  assert.equal(planned.length, 44);
  assert.equal(byDow(5) + byDow(6) + byDow(7), planned.length);
});

test("distribuição por experiência", () => {
  const planned = plannedSessions();
  const count = (slug: string) => planned.filter((item) => item.slug === slug).length;
  assert.equal(count("imersao-paranoa"), 28);
  assert.equal(count("remada-nascer-do-sol"), 8);
  assert.equal(count("remada-sunset"), 8);
  assert.equal(count("imersao-paranoa") + count("remada-nascer-do-sol") + count("remada-sunset"), 44);
});

test("nenhuma combinação de experiência e horário se repete no plano", () => {
  const planned = plannedSessions();
  const keys = new Set(planned.map((item) => `${item.slug}@${item.startsAtUtc}`));
  assert.equal(keys.size, planned.length);
});

test("horários locais de Brasília viram os instantes UTC corretos", () => {
  assert.equal(sessionLocalToIso("2026-09-04T05:30"), "2026-09-04T08:30:00.000Z");
  assert.equal(sessionLocalToIso("2026-09-05T06:00"), "2026-09-05T09:00:00.000Z");
  assert.equal(sessionLocalToIso("2026-09-06T09:00"), "2026-09-06T12:00:00.000Z");
  assert.equal(sessionLocalToIso("2026-09-06T12:00"), "2026-09-06T15:00:00.000Z");
  assert.equal(sessionLocalToIso("2026-09-06T15:00"), "2026-09-06T18:00:00.000Z");
  assert.equal(sessionLocalToIso("2026-09-27T17:00"), "2026-09-27T20:00:00.000Z");
  // Setembro fica fora de qualquer horário de verão: o deslocamento é sempre -03:00.
  for (const session of plannedSessions()) {
    const utcHour = Number(session.startsAtUtc.slice(11, 13));
    const localHour = Number(session.localTime.slice(0, 2));
    assert.equal(utcHour, localHour + 3);
    assert.equal(session.startsAtUtc.slice(0, 10), session.localStartsAt.slice(0, 10));
    assert.equal(session.startsAtUtc.slice(14, 16), session.localTime.slice(3, 5));
  }
});

test("a migration repete exatamente o padrão semanal aprovado", () => {
  assert.deepEqual(slotsBlock(migration), WEEKLY_SLOTS);
  assert.match(migration, /expected_total constant integer := 44/);
  assert.match(migration, /generate_series\(date '2026-09-01', date '2026-09-30', interval '1 day'\)/);
  assert.match(migration, /make_timestamptz\(\s*2026,\s*9,[\s\S]*?'America\/Sao_Paulo'\s*\)/);
});

test("a migration é aditiva, idempotente e não altera nada existente", () => {
  assert.equal((migration.match(/insert into public\.sessions/g) ?? []).length, 1);
  assert.match(migration, /where not exists \([\s\S]*?session\.experience_id = plan\.experience_id[\s\S]*?session\.starts_at = plan\.starts_at[\s\S]*?\)/);
  assert.doesNotMatch(migration, /\bdelete\s+from\b/i);
  assert.doesNotMatch(migration, /\bupdate\s+public\./i);
  assert.doesNotMatch(migration, /on conflict/i);
  assert.doesNotMatch(migration, /\btruncate\b/i);
  // Só public.sessions recebe escrita; nenhuma outra tabela é tocada.
  assert.deepEqual([...new Set((migration.match(/insert into public\.\w+/g) ?? []))], ["insert into public.sessions"]);
  assert.doesNotMatch(migration, /public\.(reservations|payment_events|admin_users|platform_settings|admin_audit_log)/);
});

test("a migration é transacional e aborta antes de inserir quando falta pré-requisito", () => {
  assert.equal((migration.match(/^do \$september_2026\$/gm) ?? []).length, 1);
  assert.match(migration, /SEPTEMBER_2026_EXPERIENCE_SLUG_NOT_FOUND/);
  assert.match(migration, /Slugs não encontrados em public\.experiences: %s/);
  assert.match(migration, /SESSIONS_REQUIRED_COLUMNS_UNSUPPORTED/);
  assert.match(migration, /SEPTEMBER_2026_DEFAULT_CAPACITY_INVALID/);
  assert.match(migration, /SEPTEMBER_2026_PLAN_UNEXPECTED_SIZE/);
  assert.match(migration, /SEPTEMBER_2026_INSERT_MISMATCH/);
  // As checagens de slug, schema e capacidade vêm antes do insert.
  assert.ok(migration.indexOf("SEPTEMBER_2026_EXPERIENCE_SLUG_NOT_FOUND") < migration.indexOf("insert into public.sessions"));
  assert.ok(migration.indexOf("SEPTEMBER_2026_DEFAULT_CAPACITY_INVALID") < migration.indexOf("insert into public.sessions"));
});

test("as sessões nascem com 90 minutos, R$ 70 e capacidade padrão da experiência", () => {
  assert.match(migration, /\n\s*90,\n\s*7000,\n\s*plan\.capacity,\n\s*'OPEN'::public\.session_status/);
  assert.match(migration, /experience\.default_capacity as capacity/);
  assert.doesNotMatch(migration, /\n\s*28,/);
});

test("os três slugs reais são resolvidos por slug, sem UUID fixo", () => {
  assert.match(migration, /required_slugs constant text\[\] := array\['imersao-paranoa', 'remada-nascer-do-sol', 'remada-sunset'\]/);
  assert.match(migration, /join public\.experiences experience on experience\.slug = slots\.slug/);
  assert.doesNotMatch(migration, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});

test("preflight e postcheck usam o mesmo padrão semanal da migration", () => {
  assert.deepEqual(slotsBlock(preflight), WEEKLY_SLOTS);
  assert.deepEqual(slotsBlock(postcheck), WEEKLY_SLOTS);
});

test("preflight e postcheck são somente leitura e sem dados pessoais", () => {
  for (const diagnostic of [preflight, postcheck]) {
    assert.doesNotMatch(diagnostic, /\binsert\s+into\b/i);
    assert.doesNotMatch(diagnostic, /\bupdate\s+public\./i);
    assert.doesNotMatch(diagnostic, /\bdelete\s+from\b/i);
    assert.doesNotMatch(diagnostic, /\b(drop|truncate|alter)\s+table\b/i);
    assert.doesNotMatch(diagnostic, /full_name|cpf|phone|email|checkout_url|provider_reference/i);
  }
});

test("preflight mostra conflitos e postcheck confirma a agenda final", () => {
  assert.match(preflight, /SERA_CRIADA/);
  assert.match(preflight, /JA_EXISTE_PRESERVADA/);
  assert.match(preflight, /sessions_outside_september_fingerprint/);
  assert.match(postcheck, /AGENDA_SETEMBRO_2026_COMPLETA/);
  assert.match(postcheck, /duplicate_groups/);
  assert.match(postcheck, /sessions_outside_september_fingerprint/);
  assert.match(postcheck, /Esperado: imersao-paranoa 28,\n--\s*remada-nascer-do-sol 8, remada-sunset 8/);
  assert.match(postcheck, /Esperado: sexta 12, sábado 16, domingo 16/);
});
