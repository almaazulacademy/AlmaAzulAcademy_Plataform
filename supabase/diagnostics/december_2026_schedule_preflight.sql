-- AGENDA DE DEZEMBRO/2026 (01 a 31/12) — PREFLIGHT (SOMENTE LEITURA)
--
-- Um único comando SELECT, no formato check_name | result | status, para o
-- SQL Editor mostrar tudo de uma vez. Nenhuma escrita, nenhum bloco anônimo,
-- nenhuma função nova, nenhuma mudança de schema. Nenhum dado pessoal de
-- participante é retornado (só contagens e fingerprints md5).
--
-- O plano e as regras de JÁ EXISTE / CONFLITO são os mesmos do script
-- supabase/maintenance/december_2026_schedule.sql (mesma arquitetura da
-- agenda de novembro, PR #33). A linha final, READY_TO_CREATE_DECEMBER_SCHEDULE,
-- só fica OK quando o script pode rodar. As linhas *_fingerprint servem de
-- linha de base para o postcheck.
--
-- Diferenças em relação a novembro:
--   * Nascer do Sol às 05:00 (era 05:30).
--   * Cápsula Bar: Remada Sunset de segunda a sexta às 17:30, 60 min, R$ 60;
--     sábado e domingo às 17:00, 90 min, R$ 70. Mesma experiência, preço e
--     duração gravados por sessão (o padrão da experiência não muda).
--   * Calendário 01–31/12, sem dia protegido: toda sessão que já existe em
--     dezembro é preservada e entra no fingerprint.

with calendar as (
  select series.day::date as session_date,
         extract(isodow from series.day)::integer as iso_dow
  from generate_series(date '2026-12-01', date '2026-12-31', interval '1 day') as series(day)
),
slots (base_slug, experience_slug, iso_dows, local_hour, local_minute, duration_minutes, price_cents, capacity) as (
  values
    ('lago-norte',      'remada-nascer-do-sol',          array[6],             5,  0, 90, 7000, 24),
    ('lago-norte',      'imersao-paranoa',               array[6, 7],          9,  0, 90, 7000, 24),
    ('lago-norte',      'imersao-paranoa',               array[6, 7],         12,  0, 90, 7000, 24),
    ('lago-norte',      'imersao-paranoa',               array[6, 7],         15,  0, 90, 7000, 24),
    ('lago-norte',      'remada-sunset',                 array[7],            17,  0, 90, 7000, 24),
    ('concha-acustica', 'remada-sunset-concha-acustica', array[1, 2, 3, 4, 5], 17, 30, 60, 6000, 12),
    ('concha-acustica', 'remada-sunset-concha-acustica', array[6, 7],         17,  0, 90, 7000, 12),
    ('concha-acustica', 'rota-ermida-ponte-jk',          array[6, 7],         15,  0, 90, 7000, 12)
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
    calendar.session_date,
    make_timestamptz(
      2026, 12, extract(day from calendar.session_date)::integer,
      slots.local_hour, slots.local_minute, 0, 'America/Sao_Paulo'
    ) as starts_at,
    slots.duration_minutes,
    slots.price_cents,
    slots.capacity
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
           && tstzrange(plan.starts_at, plan.starts_at + make_interval(mins => plan.duration_minutes))
      ) then 'CONFLITO'
      else 'CRIAR'
    end as outcome
  from plan
),
existing_divergent as (
  -- Horário do plano que já existe com preço, duração, capacidade ou status
  -- diferente do planejado. O script NÃO altera essas sessões.
  select p.*, s.status::text as current_status, s.price_cents as current_price,
         s.duration_minutes as current_duration, s.capacity as current_capacity
  from plan_state p
  join public.sessions s on s.experience_id = p.experience_id and s.starts_at = p.starts_at
  where p.outcome = 'JA_EXISTE'
    and (s.price_cents <> p.price_cents or s.duration_minutes <> p.duration_minutes
         or s.capacity <> p.capacity or s.status::text <> 'OPEN')
),
december as (
  select s.*, e.slug as experience_slug, e.kind::text as experience_kind, b.slug as base_slug,
         (s.starts_at at time zone 'America/Sao_Paulo') as local_start
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  join public.bases b on b.id = e.base_id
  where s.starts_at >= make_timestamptz(2026, 12, 1, 0, 0, 0, 'America/Sao_Paulo')
    and s.starts_at <  make_timestamptz(2027, 1, 1, 0, 0, 0, 'America/Sao_Paulo')
),
facts as (
  select
    (select string_agg(format('%s/%s', w.base_slug, w.experience_slug), ', ')
     from wanted w
     where not exists (
       select 1 from public.experiences e join public.bases b on b.id = e.base_id
       where e.slug = w.experience_slug and b.slug = w.base_slug
     )) as missing_experiences,
    (select string_agg(format('%s/%s: id %s, %s/%s, preço padrão %s, duração padrão %s, capacidade padrão %s',
              b.slug, e.slug, e.id, e.kind, e.status, e.price_cents, e.duration_minutes, e.default_capacity), ' · ' order by b.slug, e.slug)
     from wanted w
     join public.bases b on b.slug = w.base_slug
     join public.experiences e on e.slug = w.experience_slug and e.base_id = b.id) as experience_ids,
    (select string_agg(format('%s/%s', b.slug, e.slug), ', ')
     from wanted w
     join public.bases b on b.slug = w.base_slug
     join public.experiences e on e.slug = w.experience_slug and e.base_id = b.id
     where e.status <> 'PUBLISHED') as not_published,
    (select string_agg(format('%s/%s', b.slug, e.slug), ', ')
     from wanted w
     join public.bases b on b.slug = w.base_slug
     join public.experiences e on e.slug = w.experience_slug and e.base_id = b.id
     where e.kind::text <> 'REGULAR') as not_regular,
    (select string_agg(format('%s: id %s, %s', b.slug, b.id, b.status), ' · ' order by b.slug)
     from public.bases b where b.slug in ('lago-norte', 'concha-acustica')) as base_ids,
    (select string_agg(b.slug, ', ') from public.bases b
     where b.slug in ('lago-norte', 'concha-acustica') and b.status <> 'ACTIVE') as inactive_bases,
    (select e.editorial_content -> 'quickFacts' from public.experiences e join public.bases b on b.id = e.base_id
     where e.slug = 'remada-sunset-concha-acustica' and b.slug = 'concha-acustica')::text as capsula_sunset_quick_facts,
    (select count(*) from plan_state) as planned_total,
    (select count(distinct (experience_id, starts_at)) from plan_state) as distinct_planned,
    (select string_agg(format('%s/%s %s %s min R$ %s cap %s: %s', g.base_slug, g.experience_slug, g.local_time,
              g.duration_minutes, g.price_cents / 100, g.capacity, g.total), ' · '
              order by g.base_slug, g.experience_slug, g.local_time)
     from (select base_slug, experience_slug, to_char(starts_at at time zone 'America/Sao_Paulo', 'HH24:MI') as local_time,
                  duration_minutes, price_cents, capacity, count(*) as total
           from plan_state group by 1, 2, 3, 4, 5, 6) g) as planned_by_slot,
    (select count(*) from plan_state where outcome = 'JA_EXISTE') as existing_planned,
    (select count(*) from plan_state where outcome = 'CONFLITO') as conflict_planned,
    (select count(*) from plan_state where outcome = 'CRIAR') as to_create,
    (select count(*) from existing_divergent) as existing_divergent_total,
    (select string_agg(format('%s/%s %s: atual %s R$ %s %s min cap %s; plano R$ %s %s min cap %s',
              d.base_slug, d.experience_slug, to_char(d.starts_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'),
              d.current_status, (d.current_price / 100.0)::numeric(10, 2), d.current_duration, d.current_capacity,
              d.price_cents / 100, d.duration_minutes, d.capacity), ' · ' order by d.starts_at)
     from existing_divergent d) as existing_divergent_list,
    (select count(*) from plan_state
     where (starts_at at time zone 'America/Sao_Paulo')::date not between date '2026-12-01' and date '2026-12-31') as outside_range,
    (select count(*) from plan_state
     where (starts_at at time zone 'UTC') - (starts_at at time zone 'America/Sao_Paulo') <> interval '3 hours') as wrong_offset,
    (select count(*) from plan_state a join plan_state b
       on a.base_id = b.base_id and (a.experience_id, a.starts_at) < (b.experience_id, b.starts_at)
     where tstzrange(a.starts_at, a.starts_at + make_interval(mins => a.duration_minutes))
        && tstzrange(b.starts_at, b.starts_at + make_interval(mins => b.duration_minutes))) as plan_self_overlap,
    (select string_agg(format('%s %s/%s %s', p.outcome, p.base_slug, p.experience_slug,
              to_char(p.starts_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI')), ' · ' order by p.starts_at, p.base_slug)
     from plan_state p where p.outcome <> 'CRIAR') as skipped_list,
    (select string_agg(format('%s %s/%s %s %s min R$ %s', p.outcome, p.base_slug, p.experience_slug,
              to_char(p.starts_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'), p.duration_minutes, p.price_cents / 100),
              ' · ' order by p.starts_at, p.base_slug)
     from plan_state p where p.session_date in (date '2026-12-24', date '2026-12-25', date '2026-12-31')) as holiday_list,
    (select string_agg(format('%s/%s: %s', grouped.base_slug, grouped.experience_slug, grouped.to_create), ' · '
              order by grouped.base_slug, grouped.experience_slug)
     from (select base_slug, experience_slug, count(*) filter (where outcome = 'CRIAR') as to_create
           from plan_state group by base_slug, experience_slug) grouped) as to_create_by_experience,
    (select count(*) from december) as december_existing,
    (select string_agg(format('%s %s/%s %s %s cap %s preço %s %s min reservas %s',
              to_char(d.local_start, 'DD/MM HH24:MI'), d.base_slug, d.experience_slug, d.experience_kind, d.status,
              d.capacity, d.price_cents, d.duration_minutes,
              (select count(*) from public.reservations r where r.session_id = d.id)), ' · ' order by d.starts_at, d.base_slug)
     from december d) as december_list,
    (select count(*) from december where experience_kind = 'EVENT') as december_event_sessions,
    (select count(*) from public.reservations r join december d on d.id = r.session_id) as december_reservations,
    (select string_agg(format('%s: %s', g.status, g.total), ', ' order by g.status)
     from (select r.status::text as status, count(*) as total
           from public.reservations r join december d on d.id = r.session_id group by 1) g) as december_reservations_by_status,
    (select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), ''))
     from public.sessions s
     where s.starts_at >= make_timestamptz(2026, 12, 1, 0, 0, 0, 'America/Sao_Paulo')
       and s.starts_at <  make_timestamptz(2027, 1, 1, 0, 0, 0, 'America/Sao_Paulo')) as december_sessions_fingerprint,
    (select md5(coalesce(string_agg(to_jsonb(r)::text, '|' order by r.id), ''))
     from public.reservations r join public.sessions s on s.id = r.session_id
     where s.starts_at >= make_timestamptz(2026, 12, 1, 0, 0, 0, 'America/Sao_Paulo')
       and s.starts_at <  make_timestamptz(2027, 1, 1, 0, 0, 0, 'America/Sao_Paulo')) as december_reservations_fingerprint,
    (select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), ''))
     from public.sessions s
     where s.starts_at >= make_timestamptz(2026, 11, 1, 0, 0, 0, 'America/Sao_Paulo')
       and s.starts_at <  make_timestamptz(2026, 12, 1, 0, 0, 0, 'America/Sao_Paulo')) as november_sessions_fingerprint,
    (select count(*) from public.sessions s
     where s.starts_at >= make_timestamptz(2026, 11, 1, 0, 0, 0, 'America/Sao_Paulo')
       and s.starts_at <  make_timestamptz(2026, 12, 1, 0, 0, 0, 'America/Sao_Paulo')) as november_sessions,
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
    (select count(*) from public.sessions s
     where s.internal_notes = 'Agenda dezembro/2026 — criada em lote (supabase/maintenance/december_2026_schedule.sql).') as previous_batch_rows,
    (select string_agg(t.tgname, ', ' order by t.tgname) from pg_trigger t
     where t.tgrelid = to_regclass('public.sessions') and not t.tgisinternal) as trigger_names,
    (select string_agg(e.enumlabel, ', ' order by e.enumlabel) from pg_enum e
     where e.enumtypid = 'public.session_status'::regtype) as session_status_values,
    (select count(*) from public.sessions s
     where s.internal_notes = 'Agenda novembro/2026 — criada em lote (supabase/maintenance/november_2026_schedule.sql).') as november_batch_rows,
    (select count(*) from public.admin_audit_log a
     where a.action = 'SESSION_CREATED' and a.metadata ->> 'source' = 'november_2026_schedule') as november_batch_audit
),
readiness as (
  select nullif(concat_ws('; ',
    case when facts.missing_experiences is not null
      then format('experiência/base não encontrada: %s', facts.missing_experiences) end,
    case when facts.not_regular is not null
      then format('experiência não REGULAR: %s', facts.not_regular) end,
    case when facts.inactive_bases is not null
      then format('base não ACTIVE (o trigger recusa a sessão): %s', facts.inactive_bases) end,
    case when facts.planned_total <> 71 then format('planned_sessions = %s, esperado 71', facts.planned_total) end,
    case when facts.distinct_planned <> facts.planned_total then 'o plano gerou horários repetidos' end,
    case when facts.plan_self_overlap > 0 then 'o plano tem sessões sobrepostas na mesma base' end,
    case when facts.outside_range > 0 then 'o plano tem horário fora de 01–31/12' end,
    case when facts.wrong_offset > 0 then 'America/Sao_Paulo não está em UTC−3 em dezembro (tzdata?)' end,
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
         case when facts.missing_experiences is null and facts.not_regular is null then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 3, 'experiences_not_published', coalesce(facts.not_published, 'nenhuma'),
         case when facts.not_published is null then 'OK' else 'WARNING: sessões criadas não aparecem no site' end from facts
  union all select 4, 'capsula_sunset_quick_facts', coalesce(facts.capsula_sunset_quick_facts, '-'),
         'INFO: texto fixo da página; dias úteis serão 60 min / R$ 60' from facts
  union all select 5, 'planned_sessions', facts.planned_total::text,
         case when facts.planned_total = 71 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 6, 'planned_by_slot', coalesce(facts.planned_by_slot, '-'), 'INFO' from facts
  union all select 7, 'planned_outside_01_31_dec', facts.outside_range::text,
         case when facts.outside_range = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 8, 'planned_offset_not_utc_minus_3', facts.wrong_offset::text,
         case when facts.wrong_offset = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 9, 'planned_self_overlap', facts.plan_self_overlap::text,
         case when facts.plan_self_overlap = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 10, 'already_existing_planned', facts.existing_planned::text, 'INFO' from facts
  union all select 11, 'existing_with_divergent_config', facts.existing_divergent_total::text,
         case when facts.existing_divergent_total = 0 then 'OK' else 'REVIEW_REQUIRED: o script não altera, decidir antes' end from facts
  union all select 12, 'existing_with_divergent_config_list', coalesce(facts.existing_divergent_list, 'nenhuma'), 'INFO' from facts
  union all select 13, 'conflicting_planned', facts.conflict_planned::text,
         case when facts.conflict_planned = 0 then 'OK' else 'REVIEW_REQUIRED: horário pulado' end from facts
  union all select 14, 'skipped_list', coalesce(facts.skipped_list, 'nenhum'), 'INFO' from facts
  union all select 15, 'holidays_24_25_31_dec', coalesce(facts.holiday_list, 'nenhuma'), 'INFO: conferir antes de publicar' from facts
  union all select 16, 'sessions_to_create', facts.to_create::text, 'INFO' from facts
  union all select 17, 'sessions_to_create_by_experience', coalesce(facts.to_create_by_experience, '-'), 'INFO' from facts
  union all select 18, 'december_existing_sessions', facts.december_existing::text, 'INFO' from facts
  union all select 19, 'december_existing_list', coalesce(facts.december_list, 'nenhuma'), 'INFO' from facts
  union all select 20, 'december_event_sessions', facts.december_event_sessions::text,
         case when facts.december_event_sessions = 0 then 'OK' else 'INFO: evento especial em dezembro' end from facts
  union all select 21, 'december_reservations', facts.december_reservations::text, 'INFO' from facts
  union all select 22, 'december_reservations_by_status', coalesce(facts.december_reservations_by_status, 'nenhuma'), 'INFO' from facts
  union all select 23, 'december_sessions_fingerprint', facts.december_sessions_fingerprint, 'INFO' from facts
  union all select 24, 'december_reservations_fingerprint', facts.december_reservations_fingerprint, 'INFO' from facts
  union all select 25, 'november_sessions', facts.november_sessions::text, 'INFO' from facts
  union all select 26, 'november_sessions_fingerprint', facts.november_sessions_fingerprint, 'INFO' from facts
  union all select 27, 'november_batch_rows_and_audit', format('%s sessões com a nota do lote, %s linhas de auditoria',
         facts.november_batch_rows, facts.november_batch_audit), 'INFO: como novembro foi criado' from facts
  union all select 28, 'december_previous_batch_rows', facts.previous_batch_rows::text,
         case when facts.previous_batch_rows = 0 then 'OK' else 'INFO: script já rodou antes' end from facts
  union all select 29, 'sessions_total', facts.sessions_total::text, 'INFO' from facts
  union all select 30, 'reservations_total', facts.reservations_total::text, 'INFO' from facts
  union all select 31, 'spots_available_type', coalesce(facts.spots_type, 'coluna ausente'), 'INFO' from facts
  union all select 32, 'unsupported_required_columns', coalesce(facts.unsupported_columns, 'nenhuma'),
         case when facts.unsupported_columns is null then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 33, 'sessions_triggers', coalesce(facts.trigger_names, 'nenhum'), 'INFO' from facts
  union all select 34, 'session_status_values', coalesce(facts.session_status_values, '-'), 'INFO' from facts
  union all select 35, 'READY_TO_CREATE_DECEMBER_SCHEDULE',
         coalesce(readiness.problems, format('tudo conferido: %s planejadas, %s já existem (%s divergentes), %s em conflito, %s a criar',
           facts.planned_total, facts.existing_planned, facts.existing_divergent_total, facts.conflict_planned, facts.to_create)),
         case when readiness.problems is null then 'OK' else 'REVIEW_REQUIRED' end
  from facts, readiness
) checks
order by checks.ord;
