-- AGENDA DE SETEMBRO/2026 — PREFLIGHT RESUMIDO (SOMENTE LEITURA)
--
-- Um único comando SELECT, portanto o SQL Editor mostra tudo de uma vez, no
-- formato check_name | result | status.
--
-- Somente leitura: nenhuma escrita, nenhum bloco anônimo, nenhuma função nova,
-- nenhuma mudança de schema. Nenhum dado pessoal de participante é retornado.
--
-- Funciona mesmo em um schema que não tenha a coluna legada spots_available:
-- ela é consultada apenas por metadados, em information_schema.
--
-- A linha final, READY_TO_CREATE_SEPTEMBER_SCHEDULE, só fica OK quando todas as
-- condições de segurança estão atendidas; caso contrário lista o que revisar.

with calendar as (
  select
    series.day::date as session_date,
    extract(isodow from series.day)::integer as iso_dow
  from generate_series(date '2026-09-01', date '2026-09-30', interval '1 day') as series(day)
),
slots (iso_dow, slug, local_hour, local_minute) as (
  values
    (5, 'remada-nascer-do-sol',  5, 30),
    (5, 'imersao-paranoa',       9,  0),
    (5, 'remada-sunset',        17,  0),
    (6, 'remada-nascer-do-sol',  6,  0),
    (6, 'imersao-paranoa',       9,  0),
    (6, 'imersao-paranoa',      12,  0),
    (6, 'imersao-paranoa',      15,  0),
    (7, 'imersao-paranoa',       9,  0),
    (7, 'imersao-paranoa',      12,  0),
    (7, 'imersao-paranoa',      15,  0),
    (7, 'remada-sunset',        17,  0)
),
plan as (
  select
    experience.id as experience_id,
    slots.slug,
    make_timestamptz(
      2026, 9, extract(day from calendar.session_date)::integer,
      slots.local_hour, slots.local_minute, 0, 'America/Sao_Paulo'
    ) as starts_at
  from calendar
  join slots on slots.iso_dow = calendar.iso_dow
  join public.experiences experience on experience.slug = slots.slug
),
plan_state as (
  select
    plan.experience_id,
    plan.slug,
    plan.starts_at,
    (
      select count(*)
      from public.sessions session
      where session.experience_id = plan.experience_id
        and session.starts_at = plan.starts_at
    ) as existing_rows
  from plan
),
facts as (
  select
    (select count(*) from public.experiences where slug = 'imersao-paranoa') as imersao_exists,
    (select count(*) from public.experiences where slug = 'remada-nascer-do-sol') as nascer_exists,
    (select count(*) from public.experiences where slug = 'remada-sunset') as sunset_exists,
    (select default_capacity from public.experiences where slug = 'imersao-paranoa') as imersao_capacity,
    (select default_capacity from public.experiences where slug = 'remada-nascer-do-sol') as nascer_capacity,
    (select default_capacity from public.experiences where slug = 'remada-sunset') as sunset_capacity,
    (select count(*) from plan_state) as planned_total,
    (select count(*) from plan_state where existing_rows > 0) as existing_planned,
    (select count(*) from plan_state where existing_rows = 0) as to_create,
    (select count(*) from plan_state where existing_rows > 1) as duplicated_planned,
    (select count(distinct (state.experience_id, state.starts_at)) from plan_state state) as distinct_planned,
    (
      select count(*)
      from public.sessions session
      where session.starts_at >= make_timestamptz(2026, 9, 1, 0, 0, 0, 'America/Sao_Paulo')
        and session.starts_at <  make_timestamptz(2026, 10, 1, 0, 0, 0, 'America/Sao_Paulo')
    ) as september_existing,
    (
      select column_info.data_type::text
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = 'sessions'
        and column_info.column_name = 'spots_available'
    ) as spots_type,
    (
      select column_info.is_nullable::text
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = 'sessions'
        and column_info.column_name = 'spots_available'
    ) as spots_nullable,
    (
      select column_info.column_default::text
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = 'sessions'
        and column_info.column_name = 'spots_available'
    ) as spots_default,
    (
      select col_description(to_regclass('public.sessions'), column_info.ordinal_position::integer)
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = 'sessions'
        and column_info.column_name = 'spots_available'
    ) as spots_comment,
    (
      -- Colunas obrigatórias sem default que a agenda não sabe preencher.
      -- spots_available fica de fora porque a migration a preenche com a
      -- capacidade da sessão quando ela existe.
      select string_agg(column_info.column_name::text, ', ' order by column_info.ordinal_position)
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = 'sessions'
        and column_info.is_nullable = 'NO'
        and column_info.column_default is null
        and column_info.is_identity = 'NO'
        and column_info.is_generated = 'NEVER'
        and not (column_info.column_name = any (array[
          'experience_id', 'starts_at', 'duration_minutes', 'price_cents', 'capacity', 'status', 'spots_available'
        ]))
    ) as unsupported_columns,
    (
      select string_agg(trigger_info.tgname, ', ' order by trigger_info.tgname)
      from pg_trigger trigger_info
      where trigger_info.tgrelid = to_regclass('public.sessions')
        and not trigger_info.tgisinternal
    ) as trigger_names,
    (
      select count(*)
      from public.sessions
      where starts_at <  make_timestamptz(2026, 9, 1, 0, 0, 0, 'America/Sao_Paulo')
         or starts_at >= make_timestamptz(2026, 10, 1, 0, 0, 0, 'America/Sao_Paulo')
    ) as outside_total,
    (
      select md5(coalesce(string_agg(
        id::text || ':' || experience_id::text || ':' || starts_at::text || ':' ||
        price_cents::text || ':' || capacity::text || ':' || status::text,
        '|' order by id
      ), ''))
      from public.sessions
      where starts_at <  make_timestamptz(2026, 9, 1, 0, 0, 0, 'America/Sao_Paulo')
         or starts_at >= make_timestamptz(2026, 10, 1, 0, 0, 0, 'America/Sao_Paulo')
    ) as outside_fingerprint
),
numeric_types as (
  select array['smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision']::text[] as accepted
),
readiness as (
  select nullif(concat_ws('; ',
    case when facts.imersao_exists = 0 then 'slug imersao-paranoa não encontrado' end,
    case when facts.nascer_exists = 0 then 'slug remada-nascer-do-sol não encontrado' end,
    case when facts.sunset_exists = 0 then 'slug remada-sunset não encontrado' end,
    case when facts.planned_total <> 44
      then format('planned_sessions = %s, esperado 44', facts.planned_total) end,
    case when facts.distinct_planned <> facts.planned_total
      then 'o plano gerou horários repetidos para a mesma experiência' end,
    case when facts.duplicated_planned > 0
      then format('%s horário(s) do plano já têm mais de uma sessão no banco', facts.duplicated_planned) end,
    case when facts.unsupported_columns is not null
      then format('colunas obrigatórias sem default não mapeadas: %s', facts.unsupported_columns) end,
    case when facts.spots_type is not null and not (facts.spots_type = any (numeric_types.accepted))
      then format('spots_available é %s; a migration só preenche tipos numéricos', facts.spots_type) end,
    case when coalesce(facts.imersao_capacity, 0) <= 0
      then 'default_capacity inválida em imersao-paranoa' end,
    case when coalesce(facts.nascer_capacity, 0) <= 0
      then 'default_capacity inválida em remada-nascer-do-sol' end,
    case when coalesce(facts.sunset_capacity, 0) <= 0
      then 'default_capacity inválida em remada-sunset' end
  ), '') as problems
  from facts, numeric_types
)
select checks.check_name, checks.result, checks.status
from (
  select 1 as ord,
    'spots_available_exists' as check_name,
    case when facts.spots_type is null then 'não' else 'sim' end as result,
    'OK' as status
  from facts

  union all
  select 2,
    'spots_available_data_type',
    coalesce(facts.spots_type, 'coluna ausente'),
    case
      when facts.spots_type is null then 'OK'
      when facts.spots_type = any (numeric_types.accepted) then 'OK'
      else 'REVIEW_REQUIRED'
    end
  from facts, numeric_types

  union all
  select 3,
    'spots_available_nullable',
    case
      when facts.spots_nullable is null then 'coluna ausente'
      when facts.spots_nullable = 'NO' then 'NOT NULL'
      else 'aceita NULL'
    end,
    'OK'
  from facts

  union all
  select 4,
    'spots_available_default',
    case
      when facts.spots_type is null then 'coluna ausente'
      when facts.spots_default is null then 'sem default'
      else facts.spots_default
    end,
    'OK'
  from facts

  union all
  select 5,
    'spots_available_comment',
    case
      when facts.spots_type is null then 'coluna ausente'
      when facts.spots_comment is null then 'sem comentário'
      else facts.spots_comment
    end,
    'OK'
  from facts

  union all
  select 6,
    'sessions_triggers',
    coalesce(facts.trigger_names, 'nenhum'),
    case when facts.trigger_names is null then 'OK' else 'INFO' end
  from facts

  union all
  select 7,
    'unsupported_required_columns',
    coalesce(facts.unsupported_columns, 'nenhuma'),
    case when facts.unsupported_columns is null then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 8,
    'planned_sessions',
    facts.planned_total::text,
    case when facts.planned_total = 44 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 9,
    'existing_planned_sessions',
    facts.existing_planned::text,
    'OK'
  from facts

  union all
  select 10,
    'sessions_to_create',
    facts.to_create::text,
    'OK'
  from facts

  union all
  select 11,
    'existing_september_sessions',
    facts.september_existing::text,
    case when facts.september_existing = 0 then 'OK' else 'INFO' end
  from facts

  union all
  select 12,
    'duplicate_planned_sessions',
    facts.duplicated_planned::text,
    case when facts.duplicated_planned = 0 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 13,
    'imersao_paranoa_exists',
    case when facts.imersao_exists > 0 then 'sim' else 'não' end,
    case when facts.imersao_exists > 0 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 14,
    'remada_nascer_do_sol_exists',
    case when facts.nascer_exists > 0 then 'sim' else 'não' end,
    case when facts.nascer_exists > 0 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 15,
    'remada_sunset_exists',
    case when facts.sunset_exists > 0 then 'sim' else 'não' end,
    case when facts.sunset_exists > 0 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 16,
    'imersao_default_capacity',
    coalesce(facts.imersao_capacity::text, 'experiência ausente'),
    case when coalesce(facts.imersao_capacity, 0) > 0 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 17,
    'nascer_do_sol_default_capacity',
    coalesce(facts.nascer_capacity::text, 'experiência ausente'),
    case when coalesce(facts.nascer_capacity, 0) > 0 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 18,
    'sunset_default_capacity',
    coalesce(facts.sunset_capacity::text, 'experiência ausente'),
    case when coalesce(facts.sunset_capacity, 0) > 0 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 19,
    'sessions_outside_september_2026',
    facts.outside_total::text,
    'OK'
  from facts

  union all
  select 20,
    'sessions_outside_september_fingerprint',
    facts.outside_fingerprint,
    'OK'
  from facts

  union all
  select 21,
    'READY_TO_CREATE_SEPTEMBER_SCHEDULE',
    coalesce(
      readiness.problems,
      format(
        'tudo conferido: %s sessões planejadas, %s já existentes, %s a criar',
        facts.planned_total, facts.existing_planned, facts.to_create
      )
    ),
    case when readiness.problems is null then 'OK' else 'REVIEW_REQUIRED' end
  from facts, readiness
) checks
order by checks.ord;
