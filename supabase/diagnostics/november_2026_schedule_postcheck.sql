-- AGENDA DE NOVEMBRO/2026 (02 a 30/11) — POSTCHECK (SOMENTE LEITURA)
--
-- Um único comando SELECT, no formato check_name | result | status. Nenhuma
-- escrita, nenhum bloco anônimo, nenhuma mudança de schema. Nenhum dado
-- pessoal é retornado.
--
-- "Sessões do lote" são as que o script supabase/maintenance/
-- november_2026_schedule.sql criou: internal_notes com a nota do lote.
-- A linha final, AGENDA_NOVEMBRO_2026_OK, só fica OK quando tudo bate.
--
-- Os fingerprints de 01/11 devem ser iguais aos do preflight. Se diferirem,
-- confira day1_*: uma reserva feita pelo site em 01/11 entre o preflight e o
-- postcheck muda o fingerprint de reservas sem que o script tenha tocado nela
-- (o próprio script aborta se 01/11 mudar dentro da transação dele).

with calendar as (
  select series.day::date as session_date,
         extract(isodow from series.day)::integer as iso_dow
  from generate_series(date '2026-11-02', date '2026-11-30', interval '1 day') as series(day)
),
slots (base_slug, experience_slug, iso_dows, local_hour, local_minute, capacity) as (
  values
    ('lago-norte',      'remada-nascer-do-sol',          array[6],                 5, 30, 24),
    ('lago-norte',      'imersao-paranoa',               array[6, 7],              9,  0, 24),
    ('lago-norte',      'imersao-paranoa',               array[6, 7],             12,  0, 24),
    ('lago-norte',      'imersao-paranoa',               array[6, 7],             15,  0, 24),
    ('lago-norte',      'remada-sunset',                 array[7],                17,  0, 24),
    ('concha-acustica', 'remada-sunset-concha-acustica', array[1, 2, 3, 4, 5, 6, 7], 17, 0, 12),
    ('concha-acustica', 'rota-ermida-ponte-jk',          array[6, 7],             15,  0, 12)
),
plan as (
  select
    base.id as base_id,
    slots.base_slug,
    experience.id as experience_id,
    slots.experience_slug,
    make_timestamptz(
      2026, 11, extract(day from calendar.session_date)::integer,
      slots.local_hour, slots.local_minute, 0, 'America/Sao_Paulo'
    ) as starts_at,
    slots.capacity
  from calendar
  join slots on calendar.iso_dow = any (slots.iso_dows)
  join public.bases base on base.slug = slots.base_slug
  join public.experiences experience on experience.slug = slots.experience_slug and experience.base_id = base.id
),
batch as (
  select
    s.id, s.experience_id, s.starts_at, s.duration_minutes, s.price_cents, s.capacity, s.status::text as status,
    e.slug as experience_slug, e.status as experience_status, b.slug as base_slug,
    public.available_spots(s.id)::numeric as canonical_spots,
    case when to_jsonb(s.*) ->> 'spots_available' ~ '^-?[0-9]+(\.[0-9]+)?$'
         then (to_jsonb(s.*) ->> 'spots_available')::numeric end as legacy_spots,
    to_jsonb(s.*) ? 'spots_available' as has_legacy_spots,
    plan.capacity as planned_capacity
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  join public.bases b on b.id = e.base_id
  left join plan on plan.experience_id = s.experience_id and plan.starts_at = s.starts_at
  where s.internal_notes = 'Agenda novembro/2026 — criada em lote (supabase/maintenance/november_2026_schedule.sql).'
),
plan_presence as (
  select plan.*,
         (select count(*) from public.sessions s
          where s.experience_id = plan.experience_id and s.starts_at = plan.starts_at) as rows_now
  from plan
),
facts as (
  select
    (select count(*) from plan) as planned_total,
    (select count(*) from batch) as batch_total,
    (select string_agg(format('%s/%s: %s', g.base_slug, g.experience_slug, g.total), ' · ' order by g.base_slug, g.experience_slug)
     from (select base_slug, experience_slug, count(*) as total from batch group by 1, 2) g) as batch_by_experience,
    (select count(*) from batch where planned_capacity is null) as batch_outside_plan,
    (select count(*) from batch where price_cents <> 7000) as wrong_price,
    (select count(*) from batch where duration_minutes <> 90) as wrong_duration,
    (select count(*) from batch where capacity is distinct from planned_capacity) as wrong_capacity,
    (select count(*) from batch where status <> 'OPEN') as not_open,
    (select count(*) from batch where canonical_spots <> capacity) as spots_not_full,
    (select count(*) from batch where has_legacy_spots and legacy_spots is distinct from capacity::numeric) as legacy_spots_mismatch,
    (select count(*) from batch where experience_status <> 'PUBLISHED') as batch_not_published,
    (select count(*) from batch
     where (starts_at at time zone 'America/Sao_Paulo')::date not between date '2026-11-02' and date '2026-11-30') as batch_outside_range,
    (select count(*) from batch where (starts_at at time zone 'America/Sao_Paulo')::date = date '2026-11-01') as batch_on_day1,
    (select count(*) from plan_presence where rows_now = 0) as plan_missing,
    (select string_agg(format('%s/%s %s', p.base_slug, p.experience_slug,
              to_char(p.starts_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI')), ' · ' order by p.starts_at)
     from plan_presence p where p.rows_now = 0) as plan_missing_list,
    (select count(*) from plan_presence where rows_now > 1) as plan_duplicated,
    (select count(*) from (
       select s.experience_id, s.starts_at from public.sessions s
       where s.starts_at >= make_timestamptz(2026, 11, 1, 0, 0, 0, 'America/Sao_Paulo')
         and s.starts_at <  make_timestamptz(2026, 12, 1, 0, 0, 0, 'America/Sao_Paulo')
       group by 1, 2 having count(*) > 1) d) as november_duplicates,
    (select count(*) from public.admin_audit_log a
     where a.action = 'SESSION_CREATED' and a.metadata ->> 'source' = 'november_2026_schedule') as audit_rows,
    (select string_agg(to_char(t, 'DD/MM HH24:MI'), ', ' order by t) from (
       select distinct (starts_at at time zone 'America/Sao_Paulo') as t from batch) x) as batch_local_times_sample,
    (select count(*) from public.sessions s
     where (s.starts_at at time zone 'America/Sao_Paulo')::date = date '2026-11-01') as day1_sessions,
    (select count(*) from public.reservations r join public.sessions s on s.id = r.session_id
     where (s.starts_at at time zone 'America/Sao_Paulo')::date = date '2026-11-01') as day1_reservations,
    (select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), ''))
     from public.sessions s
     where (s.starts_at at time zone 'America/Sao_Paulo')::date = date '2026-11-01') as day1_sessions_fingerprint,
    (select md5(coalesce(string_agg(to_jsonb(r)::text, '|' order by r.id), ''))
     from public.reservations r join public.sessions s on s.id = r.session_id
     where (s.starts_at at time zone 'America/Sao_Paulo')::date = date '2026-11-01') as day1_reservations_fingerprint,
    (select count(*) from public.reservations r join batch on batch.id = r.session_id) as batch_reservations,
    (select count(*) from public.sessions) as sessions_total,
    (select count(*) from public.reservations) as reservations_total
),
problems as (
  select nullif(concat_ws('; ',
    case when facts.planned_total <> 69 then format('plano com %s horários, esperado 69', facts.planned_total) end,
    case when facts.batch_outside_plan > 0 then format('%s sessão(ões) do lote fora do plano', facts.batch_outside_plan) end,
    case when facts.wrong_price > 0 then format('%s com preço diferente de R$ 70', facts.wrong_price) end,
    case when facts.wrong_duration > 0 then format('%s com duração diferente de 90 min', facts.wrong_duration) end,
    case when facts.wrong_capacity > 0 then format('%s com capacidade errada', facts.wrong_capacity) end,
    case when facts.not_open > 0 then format('%s não OPEN', facts.not_open) end,
    case when facts.legacy_spots_mismatch > 0 then format('%s com spots_available diferente da capacidade', facts.legacy_spots_mismatch) end,
    case when facts.batch_outside_range > 0 then format('%s fora de 02–30/11', facts.batch_outside_range) end,
    case when facts.batch_on_day1 > 0 then format('%s criada(s) em 01/11', facts.batch_on_day1) end,
    case when facts.plan_duplicated > 0 then format('%s horário(s) do plano com mais de uma sessão', facts.plan_duplicated) end,
    case when facts.audit_rows <> facts.batch_total then format('auditoria %s ≠ lote %s', facts.audit_rows, facts.batch_total) end
  ), '') as text
  from facts
)
select checks.check_name, checks.result, checks.status
from (
  select 1 as ord, 'batch_sessions' as check_name, facts.batch_total::text as result, 'INFO' as status from facts
  union all select 2, 'batch_by_experience', coalesce(facts.batch_by_experience, 'nenhuma'), 'INFO' from facts
  union all select 3, 'planned_without_session', facts.plan_missing::text,
         case when facts.plan_missing = 0 then 'OK' else 'INFO: pulados por conflito' end from facts
  union all select 4, 'planned_without_session_list', coalesce(facts.plan_missing_list, 'nenhum'), 'INFO' from facts
  union all select 5, 'planned_slots_duplicated', facts.plan_duplicated::text,
         case when facts.plan_duplicated = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 6, 'november_duplicates_any_experience', facts.november_duplicates::text,
         case when facts.november_duplicates = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 7, 'batch_wrong_price', facts.wrong_price::text, case when facts.wrong_price = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 8, 'batch_wrong_duration', facts.wrong_duration::text, case when facts.wrong_duration = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 9, 'batch_wrong_capacity', facts.wrong_capacity::text, case when facts.wrong_capacity = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 10, 'batch_not_open', facts.not_open::text, case when facts.not_open = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 11, 'batch_spots_already_taken', facts.spots_not_full::text, 'INFO: reservas feitas depois da criação' from facts
  union all select 12, 'batch_reservations', facts.batch_reservations::text, 'INFO' from facts
  union all select 13, 'batch_legacy_spots_mismatch', facts.legacy_spots_mismatch::text,
         case when facts.legacy_spots_mismatch = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 14, 'batch_experience_not_published', facts.batch_not_published::text,
         case when facts.batch_not_published = 0 then 'OK' else 'WARNING: não aparecem no site' end from facts
  union all select 15, 'batch_outside_02_30_nov', facts.batch_outside_range::text,
         case when facts.batch_outside_range = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 16, 'batch_on_day1', facts.batch_on_day1::text, case when facts.batch_on_day1 = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 17, 'batch_local_times', coalesce(facts.batch_local_times_sample, '-'), 'INFO' from facts
  union all select 18, 'audit_rows', facts.audit_rows::text,
         case when facts.audit_rows = facts.batch_total then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 19, 'day1_sessions', facts.day1_sessions::text, 'INFO' from facts
  union all select 20, 'day1_reservations', facts.day1_reservations::text, 'INFO' from facts
  union all select 21, 'day1_sessions_fingerprint', facts.day1_sessions_fingerprint, 'COMPARE_WITH_PREFLIGHT' from facts
  union all select 22, 'day1_reservations_fingerprint', facts.day1_reservations_fingerprint, 'COMPARE_WITH_PREFLIGHT' from facts
  union all select 23, 'sessions_total', facts.sessions_total::text, 'INFO' from facts
  union all select 24, 'reservations_total', facts.reservations_total::text, 'INFO' from facts
  union all select 25, 'AGENDA_NOVEMBRO_2026_OK',
         coalesce(problems.text, format('%s sessões do lote conferidas; %s horário(s) do plano sem sessão', facts.batch_total, facts.plan_missing)),
         case when problems.text is null then 'OK' else 'REVIEW_REQUIRED' end
  from facts, problems
) checks
order by checks.ord;
