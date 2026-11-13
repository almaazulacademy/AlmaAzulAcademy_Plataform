-- AGENDA DE NOVEMBRO/2026 (02 a 30/11) — PREFLIGHT (SOMENTE LEITURA)
--
-- Um único comando SELECT, no formato check_name | result | status, para o
-- SQL Editor mostrar tudo de uma vez. Nenhuma escrita, nenhum bloco anônimo,
-- nenhuma função nova, nenhuma mudança de schema. Nenhum dado pessoal de
-- participante é retornado (só contagens e fingerprints md5).
--
-- O plano e as regras de JÁ EXISTE / CONFLITO são os mesmos do script
-- supabase/maintenance/november_2026_schedule.sql. A linha final,
-- READY_TO_CREATE_NOVEMBER_SCHEDULE, só fica OK quando o script pode rodar.
-- As linhas *_fingerprint servem de linha de base para o postcheck.

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
wanted (base_slug, experience_slug) as (
  values
    ('lago-norte', 'remada-nascer-do-sol'), ('lago-norte', 'imersao-paranoa'), ('lago-norte', 'remada-sunset'),
    ('concha-acustica', 'remada-sunset-concha-acustica'), ('concha-acustica', 'rota-ermida-ponte-jk')
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
    ) as starts_at
  from calendar
  join slots on calendar.iso_dow = any (slots.iso_dows)
  join public.bases base on base.slug = slots.base_slug
  join public.experiences experience on experience.slug = slots.experience_slug and experience.base_id = base.id
),
plan_state as (
  select
    plan.*,
    case
      when exists (
        select 1 from public.sessions s
        where s.experience_id = plan.experience_id and s.starts_at = plan.starts_at
      ) then 'JA_EXISTE'
      when exists (
        select 1
        from public.sessions s
        join public.experiences e on e.id = s.experience_id
        where e.base_id = plan.base_id
          and s.status::text not in ('CANCELLED', 'ARCHIVED')
          and tstzrange(s.starts_at, s.starts_at + make_interval(mins => coalesce(s.duration_minutes, 90)))
           && tstzrange(plan.starts_at, plan.starts_at + interval '90 minutes')
      ) then 'CONFLITO'
      else 'CRIAR'
    end as outcome
  from plan
),
november as (
  select s.*, e.slug as experience_slug, b.slug as base_slug,
         (s.starts_at at time zone 'America/Sao_Paulo') as local_start
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  join public.bases b on b.id = e.base_id
  where s.starts_at >= make_timestamptz(2026, 11, 1, 0, 0, 0, 'America/Sao_Paulo')
    and s.starts_at <  make_timestamptz(2026, 12, 1, 0, 0, 0, 'America/Sao_Paulo')
),
facts as (
  select
    (select string_agg(format('%s/%s', w.base_slug, w.experience_slug), ', ')
     from wanted w
     where not exists (
       select 1 from public.experiences e join public.bases b on b.id = e.base_id
       where e.slug = w.experience_slug and b.slug = w.base_slug
     )) as missing_experiences,
    (select string_agg(format('%s/%s: id %s, status %s, preço padrão %s, capacidade padrão %s',
              b.slug, e.slug, e.id, e.status, e.price_cents, e.default_capacity), ' · ' order by b.slug, e.slug)
     from wanted w
     join public.bases b on b.slug = w.base_slug
     join public.experiences e on e.slug = w.experience_slug and e.base_id = b.id) as experience_ids,
    (select string_agg(format('%s/%s', b.slug, e.slug), ', ')
     from wanted w
     join public.bases b on b.slug = w.base_slug
     join public.experiences e on e.slug = w.experience_slug and e.base_id = b.id
     where e.status <> 'PUBLISHED') as not_published,
    (select string_agg(format('%s: id %s, %s', b.slug, b.id, b.status), ' · ' order by b.slug)
     from public.bases b where b.slug in ('lago-norte', 'concha-acustica')) as base_ids,
    (select string_agg(b.slug, ', ') from public.bases b
     where b.slug in ('lago-norte', 'concha-acustica') and b.status <> 'ACTIVE') as inactive_bases,
    (select count(*) from plan_state) as planned_total,
    (select count(distinct (experience_id, starts_at)) from plan_state) as distinct_planned,
    (select count(*) from plan_state where outcome = 'JA_EXISTE') as existing_planned,
    (select count(*) from plan_state where outcome = 'CONFLITO') as conflict_planned,
    (select count(*) from plan_state where outcome = 'CRIAR') as to_create,
    (select count(*) from plan_state
     where (starts_at at time zone 'America/Sao_Paulo')::date not between date '2026-11-02' and date '2026-11-30') as outside_range,
    (select count(*) from plan_state
     where (starts_at at time zone 'UTC') - (starts_at at time zone 'America/Sao_Paulo') <> interval '3 hours') as wrong_offset,
    (select string_agg(format('%s %s/%s %s', p.outcome, p.base_slug, p.experience_slug,
              to_char(p.starts_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI')), ' · ' order by p.starts_at, p.base_slug)
     from plan_state p where p.outcome <> 'CRIAR') as skipped_list,
    (select string_agg(format('%s/%s: %s', grouped.base_slug, grouped.experience_slug, grouped.to_create), ' · '
              order by grouped.base_slug, grouped.experience_slug)
     from (select base_slug, experience_slug, count(*) filter (where outcome = 'CRIAR') as to_create
           from plan_state group by base_slug, experience_slug) grouped) as to_create_by_experience,
    (select count(*) from november) as november_existing,
    (select string_agg(format('%s %s/%s %s cap %s preço %s %s min reservas %s',
              to_char(n.local_start, 'DD/MM HH24:MI'), n.base_slug, n.experience_slug, n.status,
              n.capacity, n.price_cents, n.duration_minutes,
              (select count(*) from public.reservations r where r.session_id = n.id)), ' · ' order by n.starts_at, n.base_slug)
     from november n) as november_list,
    (select count(*) from november where local_start::date = date '2026-11-01') as day1_sessions,
    (select count(*) from public.reservations r join november n on n.id = r.session_id
     where n.local_start::date = date '2026-11-01') as day1_reservations,
    (select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), ''))
     from public.sessions s
     where (s.starts_at at time zone 'America/Sao_Paulo')::date = date '2026-11-01') as day1_sessions_fingerprint,
    (select md5(coalesce(string_agg(to_jsonb(r)::text, '|' order by r.id), ''))
     from public.reservations r join public.sessions s on s.id = r.session_id
     where (s.starts_at at time zone 'America/Sao_Paulo')::date = date '2026-11-01') as day1_reservations_fingerprint,
    (select count(*) from public.sessions) as sessions_total,
    (select count(*) from public.reservations) as reservations_total,
    (select column_info.data_type::text from information_schema.columns column_info
     where column_info.table_schema = 'public' and column_info.table_name = 'sessions'
       and column_info.column_name = 'spots_available') as spots_type,
    (select string_agg(column_info.column_name::text, ', ' order by column_info.ordinal_position)
     from information_schema.columns column_info
     where column_info.table_schema = 'public' and column_info.table_name = 'sessions'
       and column_info.is_nullable = 'NO' and column_info.column_default is null
       and column_info.is_identity = 'NO' and column_info.is_generated = 'NEVER'
       and not (column_info.column_name = any (array[
         'experience_id', 'starts_at', 'duration_minutes', 'price_cents', 'capacity', 'status', 'spots_available'
       ]))) as unsupported_columns,
    (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'sessions' and column_name = 'internal_notes') as has_internal_notes,
    (select string_agg(t.tgname, ', ' order by t.tgname) from pg_trigger t
     where t.tgrelid = to_regclass('public.sessions') and not t.tgisinternal) as trigger_names,
    (select string_agg(e.enumlabel, ', ' order by e.enumlabel) from pg_enum e
     where e.enumtypid = 'public.session_status'::regtype) as session_status_values
),
readiness as (
  select nullif(concat_ws('; ',
    case when facts.missing_experiences is not null
      then format('experiência/base não encontrada: %s', facts.missing_experiences) end,
    case when facts.inactive_bases is not null
      then format('base não ACTIVE (o trigger recusa a sessão): %s', facts.inactive_bases) end,
    case when facts.planned_total <> 69 then format('planned_sessions = %s, esperado 69', facts.planned_total) end,
    case when facts.distinct_planned <> facts.planned_total then 'o plano gerou horários repetidos' end,
    case when facts.outside_range > 0 then 'o plano tem horário fora de 02–30/11' end,
    case when facts.wrong_offset > 0 then 'America/Sao_Paulo não está em UTC−3 em novembro (tzdata?)' end,
    case when facts.unsupported_columns is not null
      then format('colunas obrigatórias sem default não mapeadas: %s', facts.unsupported_columns) end,
    case when facts.spots_type is not null
          and not (facts.spots_type = any (array['smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision']))
      then format('spots_available é %s', facts.spots_type) end,
    case when facts.has_internal_notes = 0 then 'coluna sessions.internal_notes ausente' end,
    case when to_regclass('public.admin_audit_log') is null then 'tabela admin_audit_log ausente' end
  ), '') as problems
  from facts
)
select checks.check_name, checks.result, checks.status
from (
  select 1 as ord, 'bases' as check_name, coalesce(facts.base_ids, 'nenhuma') as result,
         case when facts.inactive_bases is null then 'OK' else 'REVIEW_REQUIRED' end as status from facts
  union all select 2, 'experiences', coalesce(facts.experience_ids, 'nenhuma'),
         case when facts.missing_experiences is null then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 3, 'experiences_not_published', coalesce(facts.not_published, 'nenhuma'),
         case when facts.not_published is null then 'OK' else 'WARNING: sessões criadas não aparecem no site' end from facts
  union all select 4, 'planned_sessions', facts.planned_total::text,
         case when facts.planned_total = 69 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 5, 'planned_outside_02_30_nov', facts.outside_range::text,
         case when facts.outside_range = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 5, 'planned_offset_not_utc_minus_3', facts.wrong_offset::text,
         case when facts.wrong_offset = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 6, 'already_existing_planned', facts.existing_planned::text, 'INFO' from facts
  union all select 7, 'conflicting_planned', facts.conflict_planned::text,
         case when facts.conflict_planned = 0 then 'OK' else 'INFO' end from facts
  union all select 8, 'skipped_list', coalesce(facts.skipped_list, 'nenhum'), 'INFO' from facts
  union all select 9, 'sessions_to_create', facts.to_create::text, 'INFO' from facts
  union all select 10, 'sessions_to_create_by_experience', coalesce(facts.to_create_by_experience, '-'), 'INFO' from facts
  union all select 11, 'november_existing_sessions', facts.november_existing::text, 'INFO' from facts
  union all select 12, 'november_existing_list', coalesce(facts.november_list, 'nenhuma'), 'INFO' from facts
  union all select 13, 'day1_sessions', facts.day1_sessions::text, 'INFO' from facts
  union all select 14, 'day1_reservations', facts.day1_reservations::text, 'INFO' from facts
  union all select 15, 'day1_sessions_fingerprint', facts.day1_sessions_fingerprint, 'INFO' from facts
  union all select 16, 'day1_reservations_fingerprint', facts.day1_reservations_fingerprint, 'INFO' from facts
  union all select 17, 'sessions_total', facts.sessions_total::text, 'INFO' from facts
  union all select 18, 'reservations_total', facts.reservations_total::text, 'INFO' from facts
  union all select 19, 'spots_available_type', coalesce(facts.spots_type, 'coluna ausente'), 'INFO' from facts
  union all select 20, 'unsupported_required_columns', coalesce(facts.unsupported_columns, 'nenhuma'),
         case when facts.unsupported_columns is null then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 21, 'sessions_triggers', coalesce(facts.trigger_names, 'nenhum'), 'INFO' from facts
  union all select 22, 'session_status_values', coalesce(facts.session_status_values, '-'), 'INFO' from facts
  union all select 23, 'READY_TO_CREATE_NOVEMBER_SCHEDULE',
         coalesce(readiness.problems, format('tudo conferido: %s planejadas, %s já existem, %s em conflito, %s a criar',
           facts.planned_total, facts.existing_planned, facts.conflict_planned, facts.to_create)),
         case when readiness.problems is null then 'OK' else 'REVIEW_REQUIRED' end
  from facts, readiness
) checks
order by checks.ord;
