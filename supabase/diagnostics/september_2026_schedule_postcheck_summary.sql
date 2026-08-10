-- AGENDA DE SETEMBRO/2026 — POSTCHECK RESUMIDO (SOMENTE LEITURA)
--
-- Um único comando SELECT, portanto o SQL Editor mostra tudo de uma vez, no
-- formato check_name | result | status.
--
-- Somente leitura: nenhuma escrita, nenhum bloco anônimo, nenhuma função nova,
-- nenhuma mudança de schema ou de dado. Nenhum dado pessoal é retornado.
--
-- Funciona mesmo em um schema que não tenha a coluna legada spots_available:
-- ela é lida por to_jsonb e só é convertida quando o valor é numérico.
--
-- A linha final, AGENDA_SETEMBRO_2026_COMPLETA, só fica OK quando todos os
-- números batem; caso contrário lista exatamente o que divergiu.

with baseline as (
  -- Medidos no preflight, antes de aplicar a agenda. Servem para provar que
  -- agosto, outubro e qualquer outro mês continuam intactos.
  select
    42::bigint as expected_outside_total,
    '56bb25691790418d2e8fd0f232edf2fa'::text as expected_outside_fingerprint
),
calendar as (
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
september as (
  select
    session.id,
    session.experience_id,
    session.starts_at,
    session.capacity,
    session.price_cents,
    session.duration_minutes,
    session.status::text as status,
    experience.slug,
    extract(isodow from session.starts_at at time zone 'America/Sao_Paulo')::integer as iso_dow,
    public.available_spots(session.id)::numeric as canonical_spots,
    case
      when to_jsonb(session.*) ->> 'spots_available' ~ '^-?[0-9]+(\.[0-9]+)?$'
        then (to_jsonb(session.*) ->> 'spots_available')::numeric
    end as legacy_spots
  from public.sessions session
  join public.experiences experience on experience.id = session.experience_id
  where session.starts_at >= make_timestamptz(2026, 9, 1, 0, 0, 0, 'America/Sao_Paulo')
    and session.starts_at <  make_timestamptz(2026, 10, 1, 0, 0, 0, 'America/Sao_Paulo')
),
facts as (
  select
    (select count(*) from september) as total_sessions,
    (select count(*) from plan) as planned_total,
    (
      select count(*)
      from plan
      where exists (
        select 1
        from public.sessions session
        where session.experience_id = plan.experience_id
          and session.starts_at = plan.starts_at
      )
    ) as planned_found,
    (select count(*) from september where slug = 'imersao-paranoa') as imersao_sessions,
    (select count(*) from september where slug = 'remada-nascer-do-sol') as nascer_sessions,
    (select count(*) from september where slug = 'remada-sunset') as sunset_sessions,
    (select count(*) from september where iso_dow = 5) as friday_sessions,
    (select count(*) from september where iso_dow = 6) as saturday_sessions,
    (select count(*) from september where iso_dow = 7) as sunday_sessions,
    (select count(*) from september where capacity <> 28) as capacity_wrong,
    (select count(*) from september where price_cents <> 7000) as price_wrong,
    (select count(*) from september where duration_minutes <> 90) as duration_wrong,
    (select count(*) from september where status <> 'OPEN') as status_wrong,
    (
      select count(*)
      from (
        select experience_id, starts_at
        from september
        group by experience_id, starts_at
        having count(*) > 1
      ) grouped
    ) as duplicate_groups,
    (
      select count(*)
      from september
      where legacy_spots is not null
        and legacy_spots <> canonical_spots
    ) as legacy_spots_wrong,
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
verdict as (
  select nullif(concat_ws('; ',
    case when facts.planned_total <> 44
      then format('o plano gerou %s sessões, esperado 44', facts.planned_total) end,
    case when facts.total_sessions <> 44
      then format('setembro tem %s sessões, esperado 44', facts.total_sessions) end,
    case when facts.planned_found <> 44
      then format('%s de 44 horários planejados encontrados no banco', facts.planned_found) end,
    case when facts.imersao_sessions <> 28
      then format('imersao-paranoa com %s sessões, esperado 28', facts.imersao_sessions) end,
    case when facts.nascer_sessions <> 8
      then format('remada-nascer-do-sol com %s sessões, esperado 8', facts.nascer_sessions) end,
    case when facts.sunset_sessions <> 8
      then format('remada-sunset com %s sessões, esperado 8', facts.sunset_sessions) end,
    case when facts.friday_sessions <> 12
      then format('sextas com %s sessões, esperado 12', facts.friday_sessions) end,
    case when facts.saturday_sessions <> 16
      then format('sábados com %s sessões, esperado 16', facts.saturday_sessions) end,
    case when facts.sunday_sessions <> 16
      then format('domingos com %s sessões, esperado 16', facts.sunday_sessions) end,
    case when facts.capacity_wrong > 0
      then format('%s sessão(ões) com capacidade diferente de 28', facts.capacity_wrong) end,
    case when facts.price_wrong > 0
      then format('%s sessão(ões) com preço diferente de 7000', facts.price_wrong) end,
    case when facts.duration_wrong > 0
      then format('%s sessão(ões) com duração diferente de 90', facts.duration_wrong) end,
    case when facts.status_wrong > 0
      then format('%s sessão(ões) com status diferente de OPEN', facts.status_wrong) end,
    case when facts.duplicate_groups > 0
      then format('%s horário(s) com mais de uma sessão da mesma experiência', facts.duplicate_groups) end,
    case when facts.legacy_spots_wrong > 0
      then format('%s sessão(ões) com spots_available diferente das vagas canônicas', facts.legacy_spots_wrong) end,
    case when facts.outside_total <> baseline.expected_outside_total
      then format('sessões fora de setembro: %s, esperado %s', facts.outside_total, baseline.expected_outside_total) end,
    case when facts.outside_fingerprint is distinct from baseline.expected_outside_fingerprint
      then 'a impressão digital das sessões fora de setembro mudou desde o preflight' end
  ), '') as problems
  from facts, baseline
)
select checks.check_name, checks.result, checks.status
from (
  select 1 as ord,
    'september_total_sessions' as check_name,
    facts.total_sessions::text as result,
    case when facts.total_sessions = 44 then 'OK' else 'REVIEW_REQUIRED' end as status
  from facts

  union all
  select 2,
    'planned_sessions_found',
    format('%s de %s', facts.planned_found, facts.planned_total),
    case when facts.planned_found = 44 and facts.planned_total = 44 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 3,
    'imersao_paranoa_sessions',
    facts.imersao_sessions::text,
    case when facts.imersao_sessions = 28 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 4,
    'nascer_do_sol_sessions',
    facts.nascer_sessions::text,
    case when facts.nascer_sessions = 8 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 5,
    'sunset_sessions',
    facts.sunset_sessions::text,
    case when facts.sunset_sessions = 8 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 6,
    'friday_sessions',
    facts.friday_sessions::text,
    case when facts.friday_sessions = 12 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 7,
    'saturday_sessions',
    facts.saturday_sessions::text,
    case when facts.saturday_sessions = 16 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 8,
    'sunday_sessions',
    facts.sunday_sessions::text,
    case when facts.sunday_sessions = 16 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 9,
    'sessions_with_capacity_not_28',
    facts.capacity_wrong::text,
    case when facts.capacity_wrong = 0 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 10,
    'sessions_with_price_not_7000',
    facts.price_wrong::text,
    case when facts.price_wrong = 0 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 11,
    'sessions_with_duration_not_90',
    facts.duration_wrong::text,
    case when facts.duration_wrong = 0 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 12,
    'sessions_with_status_not_open',
    facts.status_wrong::text,
    case when facts.status_wrong = 0 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 13,
    'duplicate_experience_start_times',
    facts.duplicate_groups::text,
    case when facts.duplicate_groups = 0 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 14,
    'spots_available_inconsistent',
    facts.legacy_spots_wrong::text,
    case when facts.legacy_spots_wrong = 0 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 15,
    'sessions_outside_september_2026',
    format('%s (esperado %s)', facts.outside_total, baseline.expected_outside_total),
    case when facts.outside_total = baseline.expected_outside_total then 'OK' else 'REVIEW_REQUIRED' end
  from facts, baseline

  union all
  select 16,
    'sessions_outside_september_fingerprint',
    facts.outside_fingerprint,
    case when facts.outside_fingerprint is not distinct from baseline.expected_outside_fingerprint then 'OK' else 'REVIEW_REQUIRED' end
  from facts, baseline

  union all
  select 17,
    'AGENDA_SETEMBRO_2026_COMPLETA',
    coalesce(
      verdict.problems,
      'agenda completa: 44 sessões em setembro, 28 Imersão, 8 Nascer do Sol, 8 Sunset, sem duplicatas e sem desvio de capacidade, preço, duração ou status'
    ),
    case when verdict.problems is null then 'OK' else 'REVIEW_REQUIRED' end
  from verdict
) checks
order by checks.ord;
