import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { sessionLocalToIso } from "../lib/sessions/date-time.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const migration = source("supabase/migrations/202608090001_september_2026_schedule.sql");
const preflight = source("supabase/diagnostics/september_2026_schedule_preflight.sql");
const preflightSummary = source("supabase/diagnostics/september_2026_schedule_preflight_summary.sql");
const postcheck = source("supabase/diagnostics/september_2026_schedule_postcheck.sql");
const postcheckSummary = source("supabase/diagnostics/september_2026_schedule_postcheck_summary.sql");

// Remove comentários e literais para analisar só o SQL executável.
function executableSql(sql: string) {
  return sql.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");
}

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

test("a coluna legada spots_available é preenchida com a capacidade da sessão", () => {
  // Em produção spots_available é NOT NULL e sem default; em um schema limpo ela
  // não existe. O INSERT é montado em tempo de execução para cobrir os dois casos.
  assert.match(migration, /column_name = 'spots_available'/);
  assert.match(migration, /legacy_columns := ', spots_available';/);
  assert.match(migration, /legacy_values := ', plan\.capacity';/);
  assert.match(migration, /execute format\(\$insert\$/);
  assert.match(migration, /status%1\$s/);
  assert.match(migration, /'OPEN'::public\.session_status%2\$s/);
  assert.match(migration, /get diagnostics inserted_total = row_count;/);
  // A lista fixa de colunas do INSERT continua sem spots_available: ela só entra
  // pela parte dinâmica, então o schema limpo insere exatamente o mesmo de antes.
  assert.doesNotMatch(migration, /capacity,\n\s*status,\n\s*spots_available/);
  assert.equal((migration.match(/insert into public\.sessions/g) ?? []).length, 1);
});

test("qualquer outra coluna obrigatória sem default continua abortando a migration", () => {
  assert.match(migration, /and not \(column_name = any \(mapped_columns\)\)/);
  assert.match(migration, /and not \(legacy_spots_type is not null and column_name = 'spots_available'\)/);
  assert.match(migration, /SESSIONS_REQUIRED_COLUMNS_UNSUPPORTED/);
  assert.match(migration, /SESSIONS_SPOTS_AVAILABLE_TYPE_UNSUPPORTED/);
  assert.match(migration, /numeric_types constant text\[\] := array\['smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision'\]/);
  // O tipo da coluna legada é verificado antes de qualquer escrita.
  assert.ok(migration.indexOf("SESSIONS_SPOTS_AVAILABLE_TYPE_UNSUPPORTED") < migration.indexOf("insert into public.sessions"));
});

test("preflight e postcheck leem spots_available sem quebrar em schema sem a coluna", () => {
  for (const diagnostic of [preflight, postcheck]) {
    assert.match(diagnostic, /to_jsonb\(session\.\*\) ->> 'spots_available'/);
    assert.doesNotMatch(diagnostic, /\bselect[^;]*\bsession\.spots_available\b/i);
    // O cast só acontece quando o valor legado é mesmo numérico, então um schema
    // inesperado não derruba o diagnóstico antes de ele mostrar o schema real.
    assert.ok(diagnostic.includes("~ '^-?[0-9]+(\\.[0-9]+)?$'"));
  }
  assert.match(preflight, /pg_get_triggerdef/);
  assert.match(preflight, /pg_get_constraintdef/);
  assert.match(postcheck, /REVISAR_SNAPSHOT_LEGADO_SPOTS_AVAILABLE/);
  assert.match(postcheck, /sessions_with_wrong_legacy_snapshot/);
  // O veredito só cobra o snapshot em sessões sem reserva válida.
  assert.match(postcheck, /public\.available_spots\(session\.id\) = session\.capacity\n\s*and \(to_jsonb\(session\.\*\) ->> 'spots_available'\)::numeric <> session\.capacity::numeric/);
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

test("o preflight resumido é um único SELECT, sem escrita e sem bloco anônimo", () => {
  const executable = executableSql(preflightSummary);
  // Um único comando: o SQL Editor do Supabase mostra apenas o último result set.
  assert.equal((executable.match(/;/g) ?? []).length, 1);
  assert.match(preflightSummary.trimEnd(), /;$/);
  assert.doesNotMatch(executable, /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|call|merge|copy|vacuum|analyze)\b/i);
  assert.doesNotMatch(executable, /\bdo\s*\$/i);
  assert.doesNotMatch(preflightSummary, /full_name|cpf|phone|email|checkout_url|provider_reference/i);
  // A coluna legada só é consultada por metadados, então roda sem ela no schema.
  assert.doesNotMatch(executable, /\bsession\.spots_available\b/i);
  assert.match(preflightSummary, /information_schema\.columns[\s\S]*?column_name = 'spots_available'/);
});

test("o preflight resumido cobre todos os checks e usa o mesmo plano da migration", () => {
  assert.deepEqual(slotsBlock(preflightSummary), WEEKLY_SLOTS);
  const checks = [
    "spots_available_exists",
    "spots_available_data_type",
    "spots_available_nullable",
    "spots_available_default",
    "spots_available_comment",
    "sessions_triggers",
    "unsupported_required_columns",
    "planned_sessions",
    "existing_planned_sessions",
    "sessions_to_create",
    "existing_september_sessions",
    "duplicate_planned_sessions",
    "imersao_paranoa_exists",
    "remada_nascer_do_sol_exists",
    "remada_sunset_exists",
    "imersao_default_capacity",
    "nascer_do_sol_default_capacity",
    "sunset_default_capacity",
    "sessions_outside_september_2026",
    "sessions_outside_september_fingerprint",
    "READY_TO_CREATE_SEPTEMBER_SCHEDULE",
  ];
  for (const [index, check] of checks.entries()) {
    assert.match(preflightSummary, new RegExp(`select ${index + 1}(?: as ord)?,\\n\\s*'${check}'`));
  }
  assert.equal((preflightSummary.match(/union all/g) ?? []).length, checks.length - 1);
  assert.match(preflightSummary, /'REVIEW_REQUIRED'/);
  // O veredito final considera slugs, total planejado, duplicatas, colunas e capacidade.
  assert.match(preflightSummary, /planned_sessions = %s, esperado 44/);
  assert.match(preflightSummary, /colunas obrigatórias sem default não mapeadas: %s/);
  assert.match(preflightSummary, /a migration só preenche tipos numéricos/);
  assert.match(preflightSummary, /default_capacity inválida em imersao-paranoa/);
});

test("o postcheck resumido é um único SELECT somente leitura", () => {
  const executable = executableSql(postcheckSummary);
  assert.equal((executable.match(/;/g) ?? []).length, 1);
  assert.match(postcheckSummary.trimEnd(), /;$/);
  assert.doesNotMatch(executable, /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|call|merge|copy|vacuum|analyze)\b/i);
  assert.doesNotMatch(executable, /\bdo\s*\$/i);
  assert.doesNotMatch(postcheckSummary, /full_name|cpf|phone|email|checkout_url|provider_reference/i);
  assert.ok(postcheckSummary.includes("~ '^-?[0-9]+(\\.[0-9]+)?$'"));
});

test("o postcheck resumido cobre todos os checks com os números esperados", () => {
  assert.deepEqual(slotsBlock(postcheckSummary), WEEKLY_SLOTS);
  const checks = [
    "september_total_sessions",
    "planned_sessions_found",
    "imersao_paranoa_sessions",
    "nascer_do_sol_sessions",
    "sunset_sessions",
    "friday_sessions",
    "saturday_sessions",
    "sunday_sessions",
    "sessions_with_capacity_not_28",
    "sessions_with_price_not_7000",
    "sessions_with_duration_not_90",
    "sessions_with_status_not_open",
    "duplicate_experience_start_times",
    "spots_available_inconsistent",
    "sessions_outside_september_2026",
    "sessions_outside_september_fingerprint",
    "AGENDA_SETEMBRO_2026_COMPLETA",
  ];
  for (const [index, check] of checks.entries()) {
    assert.match(postcheckSummary, new RegExp(`select ${index + 1}(?: as ord)?,\\n\\s*'${check}'`));
  }
  assert.equal((postcheckSummary.match(/union all/g) ?? []).length, checks.length - 1);
  // Números esperados da agenda e linha de base das sessões de outros meses.
  assert.match(postcheckSummary, /facts\.total_sessions = 44/);
  assert.match(postcheckSummary, /facts\.imersao_sessions = 28/);
  assert.match(postcheckSummary, /facts\.nascer_sessions = 8/);
  assert.match(postcheckSummary, /facts\.sunset_sessions = 8/);
  assert.match(postcheckSummary, /facts\.friday_sessions = 12/);
  assert.match(postcheckSummary, /facts\.saturday_sessions = 16/);
  assert.match(postcheckSummary, /facts\.sunday_sessions = 16/);
  assert.match(postcheckSummary, /42::bigint as expected_outside_total/);
  assert.match(postcheckSummary, /'56bb25691790418d2e8fd0f232edf2fa'::text as expected_outside_fingerprint/);
  for (const zero of ["capacity_wrong", "price_wrong", "duration_wrong", "status_wrong", "duplicate_groups", "legacy_spots_wrong"]) {
    assert.match(postcheckSummary, new RegExp(`facts\\.${zero} = 0 then 'OK'`));
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
