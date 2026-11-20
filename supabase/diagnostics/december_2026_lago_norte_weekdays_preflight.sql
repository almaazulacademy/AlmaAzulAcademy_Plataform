-- LAGO NORTE — REMADAS DE 1 HORA EM DIAS ÚTEIS (DEZEMBRO/2026) — PREFLIGHT (SOMENTE LEITURA)
--
-- Um único SELECT, check_name | result | status. Nenhuma escrita, nenhum dado
-- pessoal (só contagens e fingerprints md5). Mesmo plano e mesmas regras de
-- JÁ EXISTE / CONFLITO do script supabase/maintenance/december_2026_lago_norte_weekdays.sql.
-- A linha final, READY_TO_CREATE_LAGO_NORTE_WEEKDAYS, só fica OK quando o
-- script pode rodar.
--
-- Plano: segundas, quartas e sextas de dezembro/2026, exceto 25/12 (Natal):
-- 05:30 Nascer do Sol e 17:30 Sunset, 60 min, R$ 60, 24 vagas — 24 sessões.

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
wanted (base_slug, experience_slug) as (
  values ('lago-norte', 'remada-nascer-do-sol'), ('lago-norte', 'remada-sunset')
),
plan as (
  select base.id as base_id, slots.base_slug, experience.id as experience_id, slots.experience_slug,
         calendar.session_date,
         make_timestamptz(2026, 12, extract(day from calendar.session_date)::integer,
           slots.local_hour, slots.local_minute, 0, 'America/Sao_Paulo') as starts_at,
         slots.duration_minutes, slots.price_cents, slots.capacity
  from calendar
  join slots on calendar.iso_dow = any (slots.iso_dows)
  join public.bases base on base.slug = slots.base_slug
  join public.experiences experience on experience.slug = slots.experience_slug and experience.base_id = base.id
),
plan_state as (
  select plan.*,
    case
      when exists (select 1 from public.sessions s where s.experience_id = plan.experience_id and s.starts_at = plan.starts_at) then 'JA_EXISTE'
      when exists (
        select 1 from public.sessions s join public.experiences e on e.id = s.experience_id
        where e.base_id = plan.base_id
          and s.status::text not in ('CANCELLED', 'ARCHIVED')
          and tstzrange(s.starts_at, s.starts_at + make_interval(mins => coalesce(s.duration_minutes, 90)))
           && tstzrange(plan.starts_at, plan.starts_at + make_interval(mins => plan.duration_minutes))
      ) then 'CONFLITO'
      else 'CRIAR'
    end as outcome
  from plan
),
lago_norte_december as (
  select s.*, e.slug as experience_slug, (s.starts_at at time zone 'America/Sao_Paulo') as local_start
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  join public.bases b on b.id = e.base_id
  where b.slug = 'lago-norte'
    and s.starts_at >= make_timestamptz(2026, 12, 1, 0, 0, 0, 'America/Sao_Paulo')
    and s.starts_at <  make_timestamptz(2027, 1, 1, 0, 0, 0, 'America/Sao_Paulo')
),
facts as (
  select
    (select string_agg(format('%s/%s', w.base_slug, w.experience_slug), ', ') from wanted w
     where not exists (select 1 from public.experiences e join public.bases b on b.id = e.base_id
                       where e.slug = w.experience_slug and b.slug = w.base_slug)) as missing_experiences,
    (select string_agg(format('%s: id %s, %s/%s, padrão %s min / %s centavos / %s vagas', e.slug, e.id, e.kind, e.status,
              e.duration_minutes, e.price_cents, e.default_capacity), ' · ' order by e.slug)
     from wanted w join public.bases b on b.slug = w.base_slug join public.experiences e on e.slug = w.experience_slug and e.base_id = b.id) as experience_info,
    (select string_agg(e.slug, ', ') from wanted w join public.bases b on b.slug = w.base_slug
     join public.experiences e on e.slug = w.experience_slug and e.base_id = b.id
     where e.kind::text <> 'REGULAR' or e.status <> 'PUBLISHED') as not_regular_published,
    (select format('id %s, %s', b.id, b.status) from public.bases b where b.slug = 'lago-norte') as base_info,
    (select b.status <> 'ACTIVE' from public.bases b where b.slug = 'lago-norte') as base_inactive,
    (select count(*) from plan_state) as planned_total,
    (select count(distinct (experience_id, starts_at)) from plan_state) as distinct_planned,
    (select string_agg(distinct to_char(session_date, 'DD/MM'), ', ') from plan_state) as planned_dates,
    (select count(*) from plan_state where outcome = 'JA_EXISTE') as existing_planned,
    (select count(*) from plan_state where outcome = 'CONFLITO') as conflict_planned,
    (select count(*) from plan_state where outcome = 'CRIAR') as to_create,
    (select string_agg(format('%s %s %s', p.outcome, p.experience_slug, to_char(p.starts_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI')), ' · ' order by p.starts_at)
     from plan_state p where p.outcome <> 'CRIAR') as skipped_list,
    (select count(*) from plan_state
     where (starts_at at time zone 'UTC') - (starts_at at time zone 'America/Sao_Paulo') <> interval '3 hours') as wrong_offset,
    (select count(*) from plan_state a join plan_state b
       on a.base_id = b.base_id and (a.experience_id, a.starts_at) < (b.experience_id, b.starts_at)
     where tstzrange(a.starts_at, a.starts_at + make_interval(mins => a.duration_minutes))
        && tstzrange(b.starts_at, b.starts_at + make_interval(mins => b.duration_minutes))) as plan_self_overlap,
    (select count(*) from lago_norte_december) as december_existing,
    (select count(*) from lago_norte_december where extract(isodow from local_start) between 1 and 5) as december_weekday_existing,
    (select string_agg(format('%s %s %s %s min R$ %s reservas %s', to_char(d.local_start, 'DD/MM HH24:MI'), d.experience_slug, d.status,
              d.duration_minutes, d.price_cents / 100, (select count(*) from public.reservations r where r.session_id = d.id)), ' · ' order by d.starts_at)
     from lago_norte_december d where extract(isodow from d.local_start) between 1 and 5) as december_weekday_list,
    (select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.sessions s
     where s.starts_at >= make_timestamptz(2026, 12, 1, 0, 0, 0, 'America/Sao_Paulo')
       and s.starts_at <  make_timestamptz(2027, 1, 1, 0, 0, 0, 'America/Sao_Paulo')) as december_sessions_fingerprint,
    (select count(*) from public.sessions s
     where s.starts_at >= make_timestamptz(2026, 12, 1, 0, 0, 0, 'America/Sao_Paulo')
       and s.starts_at <  make_timestamptz(2027, 1, 1, 0, 0, 0, 'America/Sao_Paulo')) as december_sessions,
    (select count(*) from public.sessions) as sessions_total,
    (select count(*) from public.reservations) as reservations_total,
    (select string_agg(column_info.column_name::text, ', ' order by column_info.ordinal_position)
     from information_schema.columns column_info
     where column_info.table_schema = 'public' and column_info.table_name = 'sessions'
       and column_info.is_nullable = 'NO' and column_info.column_default is null
       and column_info.is_identity = 'NO' and column_info.is_generated = 'NEVER'
       and not (column_info.column_name = any (array['experience_id', 'starts_at', 'duration_minutes', 'price_cents', 'capacity', 'status', 'spots_available']))) as unsupported_columns,
    (select count(*) from public.sessions s
     where s.internal_notes = 'Lago Norte dias úteis dezembro/2026 — criada em lote (supabase/maintenance/december_2026_lago_norte_weekdays.sql).') as previous_batch_rows
),
readiness as (
  select nullif(concat_ws('; ',
    case when facts.missing_experiences is not null then format('experiência não encontrada: %s', facts.missing_experiences) end,
    case when facts.not_regular_published is not null then format('experiência não REGULAR/PUBLISHED: %s', facts.not_regular_published) end,
    case when facts.base_inactive then 'base lago-norte não ACTIVE' end,
    case when facts.planned_total <> 24 then format('planned_sessions = %s, esperado 24', facts.planned_total) end,
    case when facts.distinct_planned <> facts.planned_total then 'o plano gerou horários repetidos' end,
    case when facts.plan_self_overlap > 0 then 'o plano tem sessões sobrepostas' end,
    case when facts.wrong_offset > 0 then 'America/Sao_Paulo não está em UTC−3 (tzdata?)' end,
    case when facts.unsupported_columns is not null then format('colunas obrigatórias sem default: %s', facts.unsupported_columns) end
  ), '') as problems
  from facts
)
select checks.check_name, checks.result, checks.status
from (
  select 1 as ord, 'base_lago_norte' as check_name, coalesce(facts.base_info, 'não encontrada') as result,
         case when facts.base_inactive is false then 'OK' else 'REVIEW_REQUIRED' end as status from facts
  union all select 2, 'experiences', coalesce(facts.experience_info, 'nenhuma'),
         case when facts.missing_experiences is null and facts.not_regular_published is null then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 3, 'planned_sessions', facts.planned_total::text, case when facts.planned_total = 24 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 4, 'planned_dates', coalesce(facts.planned_dates, '-'), 'INFO: seg/qua/sex de dezembro, sem 25/12' from facts
  union all select 5, 'holiday_excluded', '25/12 (sexta, Natal): sem remada de 1 hora', 'INFO' from facts
  union all select 6, 'planned_offset_not_utc_minus_3', facts.wrong_offset::text, case when facts.wrong_offset = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 7, 'planned_self_overlap', facts.plan_self_overlap::text, case when facts.plan_self_overlap = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 8, 'already_existing_planned', facts.existing_planned::text, 'INFO' from facts
  union all select 9, 'conflicting_planned', facts.conflict_planned::text, case when facts.conflict_planned = 0 then 'OK' else 'REVIEW_REQUIRED: horário pulado' end from facts
  union all select 10, 'skipped_list', coalesce(facts.skipped_list, 'nenhum'), 'INFO' from facts
  union all select 11, 'sessions_to_create', facts.to_create::text, 'INFO' from facts
  union all select 12, 'lago_norte_december_sessions', facts.december_existing::text, 'INFO' from facts
  union all select 13, 'lago_norte_december_weekday_sessions', facts.december_weekday_existing::text, 'INFO' from facts
  union all select 14, 'lago_norte_december_weekday_list', coalesce(facts.december_weekday_list, 'nenhuma'), 'INFO' from facts
  union all select 15, 'december_sessions', facts.december_sessions::text, 'INFO' from facts
  union all select 16, 'december_sessions_fingerprint', facts.december_sessions_fingerprint, 'INFO: comparar no postcheck' from facts
  union all select 17, 'sessions_total', facts.sessions_total::text, 'INFO' from facts
  union all select 18, 'reservations_total', facts.reservations_total::text, 'INFO' from facts
  union all select 19, 'unsupported_required_columns', coalesce(facts.unsupported_columns, 'nenhuma'),
         case when facts.unsupported_columns is null then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 20, 'previous_batch_rows', facts.previous_batch_rows::text, case when facts.previous_batch_rows = 0 then 'OK' else 'INFO: script já rodou antes' end from facts
  union all select 21, 'READY_TO_CREATE_LAGO_NORTE_WEEKDAYS',
         coalesce(readiness.problems, format('tudo conferido: %s planejadas, %s já existem, %s em conflito, %s a criar',
           facts.planned_total, facts.existing_planned, facts.conflict_planned, facts.to_create)),
         case when readiness.problems is null then 'OK' else 'REVIEW_REQUIRED' end
  from facts, readiness
) checks
order by checks.ord;
