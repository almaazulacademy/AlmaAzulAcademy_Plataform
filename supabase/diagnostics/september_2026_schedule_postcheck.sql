-- AGENDA DE SETEMBRO/2026 — POSTCHECK (SOMENTE LEITURA)
-- Rode manualmente depois de aplicar
-- supabase/migrations/202608090001_september_2026_schedule.sql.
--
-- Este script não insere, não atualiza e não apaga nada.
-- Nenhum dado pessoal de participante é retornado.

-- 1. Agenda final de setembro/2026, por data, horário e experiência.
select
  (session.starts_at at time zone 'America/Sao_Paulo')::date as session_date,
  to_char(session.starts_at at time zone 'America/Sao_Paulo', 'HH24:MI') as local_time,
  to_char(session.starts_at at time zone 'America/Sao_Paulo', 'Dy') as weekday,
  experience.slug as experience_slug,
  experience.title as experience_title,
  session.starts_at as starts_at_utc,
  session.status,
  session.capacity,
  session.price_cents,
  session.duration_minutes,
  public.available_spots(session.id) as remaining_spots
from public.sessions session
join public.experiences experience on experience.id = session.experience_id
where session.starts_at >= make_timestamptz(2026, 9, 1, 0, 0, 0, 'America/Sao_Paulo')
  and session.starts_at <  make_timestamptz(2026, 10, 1, 0, 0, 0, 'America/Sao_Paulo')
order by session.starts_at, experience.slug;

-- 2. Quantidade total de sessões em setembro/2026.
select
  count(*) as september_2026_sessions_total,
  count(*) filter (where session.status = 'OPEN') as open_sessions,
  count(*) filter (where session.status = 'CLOSED') as closed_sessions,
  count(*) filter (where session.status = 'CANCELLED') as cancelled_sessions,
  count(*) filter (where session.status = 'ARCHIVED') as archived_sessions,
  count(distinct session.experience_id) as experiences_with_sessions,
  min(session.starts_at at time zone 'America/Sao_Paulo') as first_local_start,
  max(session.starts_at at time zone 'America/Sao_Paulo') as last_local_start
from public.sessions session
where session.starts_at >= make_timestamptz(2026, 9, 1, 0, 0, 0, 'America/Sao_Paulo')
  and session.starts_at <  make_timestamptz(2026, 10, 1, 0, 0, 0, 'America/Sao_Paulo');

-- 3. Quantidade por experiência. Esperado: imersao-paranoa 28,
--    remada-nascer-do-sol 8, remada-sunset 8.
select
  experience.slug as experience_slug,
  experience.title as experience_title,
  count(*) as sessions_count,
  count(distinct (session.starts_at at time zone 'America/Sao_Paulo')::date) as distinct_days,
  min(session.capacity) as min_capacity,
  max(session.capacity) as max_capacity,
  min(session.price_cents) as min_price_cents,
  max(session.price_cents) as max_price_cents
from public.sessions session
join public.experiences experience on experience.id = session.experience_id
where session.starts_at >= make_timestamptz(2026, 9, 1, 0, 0, 0, 'America/Sao_Paulo')
  and session.starts_at <  make_timestamptz(2026, 10, 1, 0, 0, 0, 'America/Sao_Paulo')
group by experience.slug, experience.title
order by experience.slug;

-- 4. Quantidade por dia da semana. Esperado: sexta 12, sábado 16, domingo 16.
select
  extract(isodow from session.starts_at at time zone 'America/Sao_Paulo')::integer as iso_dow,
  to_char(session.starts_at at time zone 'America/Sao_Paulo', 'Day') as weekday,
  count(*) as sessions_count
from public.sessions session
where session.starts_at >= make_timestamptz(2026, 9, 1, 0, 0, 0, 'America/Sao_Paulo')
  and session.starts_at <  make_timestamptz(2026, 10, 1, 0, 0, 0, 'America/Sao_Paulo')
group by 1, 2
order by 1;

-- 5. Duplicatas: mesma experiência no mesmo horário. Zero linhas = agenda limpa.
select
  experience.slug as experience_slug,
  (session.starts_at at time zone 'America/Sao_Paulo') as local_starts_at,
  count(*) as duplicate_count,
  array_agg(session.id order by session.id) as session_ids
from public.sessions session
join public.experiences experience on experience.id = session.experience_id
where session.starts_at >= make_timestamptz(2026, 9, 1, 0, 0, 0, 'America/Sao_Paulo')
  and session.starts_at <  make_timestamptz(2026, 10, 1, 0, 0, 0, 'America/Sao_Paulo')
group by experience.slug, session.starts_at
having count(*) > 1
order by 2, 1;

-- 6. Veredito único: plano completo aplicado, sem duplicatas e sem desvio de
--    preço, duração ou status nas sessões criadas por esta agenda.
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
missing as (
  select count(*) as missing_count
  from plan
  where not exists (
    select 1
    from public.sessions session
    where session.experience_id = plan.experience_id
      and session.starts_at = plan.starts_at
  )
),
duplicates as (
  select count(*) as duplicate_groups
  from (
    select session.experience_id, session.starts_at
    from public.sessions session
    where session.starts_at >= make_timestamptz(2026, 9, 1, 0, 0, 0, 'America/Sao_Paulo')
      and session.starts_at <  make_timestamptz(2026, 10, 1, 0, 0, 0, 'America/Sao_Paulo')
    group by session.experience_id, session.starts_at
    having count(*) > 1
  ) grouped
),
deviations as (
  select count(*) as deviating_sessions
  from plan
  join public.sessions session
    on session.experience_id = plan.experience_id
   and session.starts_at = plan.starts_at
  where session.duration_minutes <> 90
     or session.price_cents <> 7000
)
select
  (select count(*) from plan) as planned_sessions,
  (select missing_count from missing) as planned_sessions_missing,
  (select duplicate_groups from duplicates) as duplicate_groups,
  (select deviating_sessions from deviations) as sessions_with_unexpected_price_or_duration,
  case
    when (select count(*) from plan) <> 44 then 'PLANO_INESPERADO_REVISAR'
    when (select missing_count from missing) > 0 then 'AGENDA_INCOMPLETA_REAPLICAR_MIGRATION'
    when (select duplicate_groups from duplicates) > 0 then 'DUPLICATAS_ENCONTRADAS_REVISAR'
    when (select deviating_sessions from deviations) > 0 then 'REVISAR_PRECO_OU_DURACAO'
    else 'AGENDA_SETEMBRO_2026_COMPLETA'
  end as verdict;

-- 7. Impressão digital das sessões fora de setembro/2026. Precisa ser idêntica
--    à do preflight: prova que agosto, outubro e demais meses não mudaram.
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
