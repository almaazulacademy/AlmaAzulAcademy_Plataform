-- LAGO NORTE — REMADAS DE 1 HORA EM DIAS ÚTEIS (DEZEMBRO/2026) — POSTCHECK (SOMENTE LEITURA)
--
-- Um único SELECT. "Sessões do lote" = internal_notes com a nota do script
-- supabase/maintenance/december_2026_lago_norte_weekdays.sql. A linha final,
-- LAGO_NORTE_WEEKDAYS_OK, só fica OK quando tudo bate.
-- preexisting_december_sessions_fingerprint deve ser igual a
-- december_sessions_fingerprint do preflight (só sessões entram nele).

with calendar as (
  select series.day::date as session_date,
         extract(isodow from series.day)::integer as iso_dow
  from generate_series(date '2026-12-01', date '2026-12-31', interval '1 day') as series(day)
  where series.day::date not in (date '2026-12-25')
),
slots (base_slug, experience_slug, iso_dows, local_hour, local_minute, duration_minutes, price_cents, capacity) as (
  values
    ('lago-norte', 'remada-nascer-do-sol', array[1, 3, 5],  5, 30, 60, 6000, 24),
    ('lago-norte', 'remada-sunset',        array[1, 3, 5], 17, 30, 60, 6000, 24)
),
plan as (
  select experience.id as experience_id, slots.experience_slug,
         make_timestamptz(2026, 12, extract(day from calendar.session_date)::integer,
           slots.local_hour, slots.local_minute, 0, 'America/Sao_Paulo') as starts_at,
         slots.duration_minutes, slots.price_cents, slots.capacity
  from calendar
  join slots on calendar.iso_dow = any (slots.iso_dows)
  join public.bases base on base.slug = slots.base_slug
  join public.experiences experience on experience.slug = slots.experience_slug and experience.base_id = base.id
),
batch as (
  select s.id, s.starts_at, s.duration_minutes, s.price_cents, s.capacity, s.status::text as status, e.slug as experience_slug,
         public.available_spots(s.id)::numeric as canonical_spots,
         case when to_jsonb(s.*) ->> 'spots_available' ~ '^-?[0-9]+(\.[0-9]+)?$' then (to_jsonb(s.*) ->> 'spots_available')::numeric end as legacy_spots,
         to_jsonb(s.*) ? 'spots_available' as has_legacy_spots,
         plan.experience_id is not null as in_plan
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  left join plan on plan.experience_id = s.experience_id and plan.starts_at = s.starts_at
  where s.internal_notes = 'Lago Norte dias úteis dezembro/2026 — criada em lote (supabase/maintenance/december_2026_lago_norte_weekdays.sql).'
),
plan_presence as (
  select plan.*,
         (select count(*) from public.sessions s where s.experience_id = plan.experience_id and s.starts_at = plan.starts_at) as rows_now,
         (select count(*) from public.sessions s where s.experience_id = plan.experience_id and s.starts_at = plan.starts_at
            and s.status::text = 'OPEN' and s.duration_minutes = 60 and s.price_cents = 6000 and s.capacity = 24) as rows_matching
  from plan
),
facts as (
  select
    (select count(*) from plan) as planned_total,
    (select count(*) from batch) as batch_total,
    (select string_agg(format('%s %s: %s', g.experience_slug, g.local_time, g.total), ' · ' order by g.experience_slug)
     from (select experience_slug, to_char(starts_at at time zone 'America/Sao_Paulo', 'HH24:MI') as local_time, count(*) as total
           from batch group by 1, 2) g) as batch_by_slot,
    (select count(*) from batch where not in_plan) as batch_outside_plan,
    (select count(*) from batch
     where duration_minutes <> 60 or price_cents <> 6000 or capacity <> 24 or status <> 'OPEN'
        or extract(isodow from starts_at at time zone 'America/Sao_Paulo') not in (1, 3, 5)
        or (starts_at at time zone 'America/Sao_Paulo')::date = date '2026-12-25'
        or to_char(starts_at at time zone 'America/Sao_Paulo', 'HH24:MI') not in ('05:30', '17:30')) as rule_violations,
    (select count(*) from batch where has_legacy_spots and legacy_spots is distinct from capacity::numeric) as legacy_spots_mismatch,
    (select count(*) from batch where canonical_spots <> capacity) as spots_taken,
    (select count(*) from plan_presence where rows_matching = 1) as plan_as_planned,
    (select string_agg(format('%s %s', p.experience_slug, to_char(p.starts_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI')), ' · ' order by p.starts_at)
     from plan_presence p where p.rows_now = 0) as plan_missing_list,
    (select count(*) from plan_presence where rows_now > 1) as plan_duplicated,
    (select count(*) from public.admin_audit_log a
     where a.action = 'SESSION_CREATED' and a.metadata ->> 'source' = 'december_2026_lago_norte_weekdays') as audit_rows,
    (select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.sessions s
     where s.starts_at >= make_timestamptz(2026, 12, 1, 0, 0, 0, 'America/Sao_Paulo')
       and s.starts_at <  make_timestamptz(2027, 1, 1, 0, 0, 0, 'America/Sao_Paulo')
       and not exists (select 1 from batch where batch.id = s.id)) as preexisting_december_sessions_fingerprint,
    (select count(*) from public.sessions) as sessions_total,
    (select count(*) from public.reservations) as reservations_total
),
problems as (
  select nullif(concat_ws('; ',
    case when facts.planned_total <> 24 then format('plano com %s horários, esperado 24', facts.planned_total) end,
    case when facts.batch_outside_plan > 0 then format('%s sessão(ões) do lote fora do plano', facts.batch_outside_plan) end,
    case when facts.rule_violations > 0 then format('%s fora da regra seg/qua/sex 05:30 ou 17:30, 60 min, R$ 60, 24 vagas', facts.rule_violations) end,
    case when facts.legacy_spots_mismatch > 0 then format('%s com spots_available diferente da capacidade', facts.legacy_spots_mismatch) end,
    case when facts.plan_duplicated > 0 then format('%s horário(s) duplicado(s)', facts.plan_duplicated) end,
    case when facts.audit_rows <> facts.batch_total then format('auditoria %s ≠ lote %s', facts.audit_rows, facts.batch_total) end
  ), '') as text
  from facts
)
select checks.check_name, checks.result, checks.status
from (
  select 1 as ord, 'batch_sessions' as check_name, facts.batch_total::text as result, 'INFO' as status from facts
  union all select 2, 'batch_by_slot', coalesce(facts.batch_by_slot, 'nenhuma'), 'INFO' from facts
  union all select 3, 'planned_available_as_planned', format('%s de %s', facts.plan_as_planned, facts.planned_total),
         case when facts.plan_as_planned = facts.planned_total then 'OK' else 'INFO: ver pulados' end from facts
  union all select 4, 'planned_without_session_list', coalesce(facts.plan_missing_list, 'nenhum'), 'INFO' from facts
  union all select 5, 'rule_violations', facts.rule_violations::text, case when facts.rule_violations = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 6, 'planned_slots_duplicated', facts.plan_duplicated::text, case when facts.plan_duplicated = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 7, 'legacy_spots_mismatch', facts.legacy_spots_mismatch::text, case when facts.legacy_spots_mismatch = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 8, 'batch_spots_already_taken', facts.spots_taken::text, 'INFO: reservas feitas depois da criação' from facts
  union all select 9, 'audit_rows', facts.audit_rows::text, case when facts.audit_rows = facts.batch_total then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 10, 'preexisting_december_sessions_fingerprint', facts.preexisting_december_sessions_fingerprint, 'COMPARE_WITH_PREFLIGHT' from facts
  union all select 11, 'sessions_total', facts.sessions_total::text, 'INFO' from facts
  union all select 12, 'reservations_total', facts.reservations_total::text, 'INFO' from facts
  union all select 13, 'LAGO_NORTE_WEEKDAYS_OK',
         coalesce(problems.text, format('%s sessões do lote conferidas; %s de %s horários abertos como planejado', facts.batch_total, facts.plan_as_planned, facts.planned_total)),
         case when problems.text is null then 'OK' else 'REVIEW_REQUIRED' end
  from facts, problems
) checks
order by checks.ord;
