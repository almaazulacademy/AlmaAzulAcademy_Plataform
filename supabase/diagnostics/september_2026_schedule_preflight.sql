-- AGENDA DE SETEMBRO/2026 — PREFLIGHT (SOMENTE LEITURA)
-- Rode manualmente no projeto Supabase antes de aplicar
-- supabase/migrations/202608090001_september_2026_schedule.sql.
--
-- Este script não insere, não atualiza e não apaga nada.
-- Ele devolve apenas agregados, metadados de schema, IDs técnicos de sessão e
-- dados operacionais da agenda. Nenhum dado pessoal de participante é retornado.

-- 1. Contexto e pré-requisitos.
select
  current_database() as database_name,
  now() as checked_at,
  (select count(*) from public.experiences) as experiences_total,
  (select count(*) from public.sessions) as sessions_total,
  (select count(*)
     from public.sessions
    where starts_at >= make_timestamptz(2026, 9, 1, 0, 0, 0, 'America/Sao_Paulo')
      and starts_at <  make_timestamptz(2026, 10, 1, 0, 0, 0, 'America/Sao_Paulo')
  ) as september_2026_sessions_total;

-- 2. Slugs exigidos pela agenda. Qualquer AUSENTE bloqueia a migration.
select
  required.slug,
  (select experience.id from public.experiences experience where experience.slug = required.slug) as experience_id,
  (select experience.title from public.experiences experience where experience.slug = required.slug) as title,
  (select experience.status from public.experiences experience where experience.slug = required.slug) as status,
  (select experience.default_capacity from public.experiences experience where experience.slug = required.slug) as default_capacity,
  (select experience.price_cents from public.experiences experience where experience.slug = required.slug) as price_cents,
  case
    when not exists (select 1 from public.experiences experience where experience.slug = required.slug) then 'AUSENTE'
    when coalesce((select experience.default_capacity from public.experiences experience where experience.slug = required.slug), 0) <= 0 then 'CAPACIDADE_INVALIDA'
    else 'OK'
  end as readiness
from unnest(array['imersao-paranoa', 'remada-nascer-do-sol', 'remada-sunset']) as required(slug)
order by required.slug;

-- 3. Colunas obrigatórias sem default em public.sessions. A migration preenche
--    experience_id, starts_at, duration_minutes, price_cents, capacity e status.
--    Qualquer outra linha aqui é inconsistência grave e aborta a aplicação.
select
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'sessions'
  and is_nullable = 'NO'
  and column_default is null
  and is_identity = 'NO'
  and is_generated = 'NEVER'
  and not (column_name = any (array[
    'experience_id', 'starts_at', 'duration_minutes', 'price_cents', 'capacity', 'status'
  ]))
order by ordinal_position;

-- 4. Sessões que já existem em setembro/2026, no fuso de Brasília.
select
  session.id as session_id,
  experience.slug as experience_slug,
  experience.title as experience_title,
  (session.starts_at at time zone 'America/Sao_Paulo')::date as session_date,
  to_char(session.starts_at at time zone 'America/Sao_Paulo', 'HH24:MI') as local_time,
  to_char(session.starts_at at time zone 'America/Sao_Paulo', 'Dy') as weekday,
  session.starts_at as starts_at_utc,
  session.status,
  session.capacity,
  session.price_cents,
  session.duration_minutes
from public.sessions session
join public.experiences experience on experience.id = session.experience_id
where session.starts_at >= make_timestamptz(2026, 9, 1, 0, 0, 0, 'America/Sao_Paulo')
  and session.starts_at <  make_timestamptz(2026, 10, 1, 0, 0, 0, 'America/Sao_Paulo')
order by session.starts_at, experience.slug;

-- 5. Plano completo x banco atual: o que seria criado e o que já existe.
--    O plano é derivado do calendário (isodow 5 = sexta, 6 = sábado, 7 = domingo),
--    exatamente como na migration.
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
    calendar.session_date,
    calendar.iso_dow,
    make_timestamptz(2026, 9, extract(day from calendar.session_date)::integer, slots.local_hour, slots.local_minute, 0, 'America/Sao_Paulo') as starts_at,
    experience.default_capacity as capacity
  from calendar
  join slots on slots.iso_dow = calendar.iso_dow
  join public.experiences experience on experience.slug = slots.slug
)
select
  plan.session_date,
  to_char(plan.starts_at at time zone 'America/Sao_Paulo', 'HH24:MI') as local_time,
  to_char(plan.starts_at at time zone 'America/Sao_Paulo', 'Dy') as weekday,
  plan.slug as experience_slug,
  plan.starts_at as starts_at_utc,
  plan.capacity as planned_capacity,
  existing.id as existing_session_id,
  existing.status as existing_status,
  case when existing.id is null then 'SERA_CRIADA' else 'JA_EXISTE_PRESERVADA' end as action
from plan
left join public.sessions existing
  on existing.experience_id = plan.experience_id
 and existing.starts_at = plan.starts_at
order by plan.starts_at, plan.slug;

-- 6. Resumo do que a migration faria agora.
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
    make_timestamptz(2026, 9, extract(day from calendar.session_date)::integer, slots.local_hour, slots.local_minute, 0, 'America/Sao_Paulo') as starts_at
  from calendar
  join slots on slots.iso_dow = calendar.iso_dow
  join public.experiences experience on experience.slug = slots.slug
),
classified as (
  select
    plan.slug,
    exists (
      select 1
      from public.sessions session
      where session.experience_id = plan.experience_id
        and session.starts_at = plan.starts_at
    ) as already_exists
  from plan
)
select
  coalesce(slug, 'TOTAL') as experience_slug,
  count(*) as planned_sessions,
  count(*) filter (where already_exists) as already_existing,
  count(*) filter (where not already_exists) as would_be_created
from classified
group by rollup (slug)
order by (slug is null), slug;

-- 7. Sessões de setembro/2026 que existem no banco e NÃO fazem parte do plano.
--    Elas são preservadas pela migration; esta lista serve para revisão manual.
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
    make_timestamptz(2026, 9, extract(day from calendar.session_date)::integer, slots.local_hour, slots.local_minute, 0, 'America/Sao_Paulo') as starts_at
  from calendar
  join slots on slots.iso_dow = calendar.iso_dow
  join public.experiences experience on experience.slug = slots.slug
)
select
  session.id as session_id,
  experience.slug as experience_slug,
  (session.starts_at at time zone 'America/Sao_Paulo')::date as session_date,
  to_char(session.starts_at at time zone 'America/Sao_Paulo', 'HH24:MI') as local_time,
  session.status,
  session.capacity,
  session.price_cents,
  (select count(*) from public.reservations reservation where reservation.session_id = session.id) as reservations_count
from public.sessions session
join public.experiences experience on experience.id = session.experience_id
where session.starts_at >= make_timestamptz(2026, 9, 1, 0, 0, 0, 'America/Sao_Paulo')
  and session.starts_at <  make_timestamptz(2026, 10, 1, 0, 0, 0, 'America/Sao_Paulo')
  and not exists (
    select 1
    from plan
    where plan.experience_id = session.experience_id
      and plan.starts_at = session.starts_at
  )
order by session.starts_at, experience.slug;

-- 8. Impressão digital das sessões fora de setembro/2026. Guarde este valor:
--    ele precisa ser idêntico no postcheck, provando que agosto, outubro e
--    qualquer outro mês não foram tocados.
select
  count(*) as sessions_outside_september_2026,
  md5(coalesce(string_agg(
    id::text || ':' || experience_id::text || ':' || starts_at::text || ':' ||
    price_cents::text || ':' || capacity::text || ':' || status::text,
    '|' order by id
  ), '')) as sessions_outside_september_fingerprint
from public.sessions
where starts_at <  make_timestamptz(2026, 9, 1, 0, 0, 0, 'America/Sao_Paulo')
   or starts_at >= make_timestamptz(2026, 10, 1, 0, 0, 0, 'America/Sao_Paulo');
