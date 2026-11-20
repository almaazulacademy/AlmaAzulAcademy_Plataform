-- LAGO NORTE — REMADAS DE 1 HORA EM DIAS ÚTEIS (DEZEMBRO/2026) — CRIAÇÃO
--
-- Script de dados para o SQL Editor do Supabase. Não é migration. Rodar DEPOIS
-- do preflight (supabase/diagnostics/december_2026_lago_norte_weekdays_preflight.sql)
-- com READY_TO_CREATE_LAGO_NORTE_WEEKDAYS em OK, e conferir com o postcheck.
--
-- Mesma arquitetura das agendas de novembro e dezembro: aditivo, idempotente e
-- transacional (REPEATABLE READ, um bloco DO). Só INSERT em public.sessions e
-- public.admin_audit_log. Aborta se reservas, pagamentos ou qualquer sessão
-- preexistente mudarem dentro da transação.
--
-- Programação aprovada (horário local America/Sao_Paulo), Base Lago Norte:
--   segundas, quartas e sextas de dezembro/2026, EXCETO FERIADOS:
--     05:30 Remada do Nascer do Sol — 60 min, R$ 60 (6000), 24 vagas
--     17:30 Remada Sunset           — 60 min, R$ 60 (6000), 24 vagas
--   Datas: 02, 04, 07, 09, 11, 14, 16, 18, 21, 23, 28 e 30/12 (12 dias).
--   25/12 (sexta, Natal) fica de fora: feriado não recebe a remada de 1 hora,
--   e nenhuma programação de feriado foi aprovada para o Lago Norte.
--   Total planejado: 12 × 2 = 24 sessões. Nenhum mês seguinte é criado.
--
-- Regras de não criação (o horário é preservado/pulado e relatado):
--   JÁ EXISTE  mesma experiência + mesmo starts_at, em qualquer status.
--   CONFLITO   outra sessão da MESMA BASE, não cancelada nem arquivada, com
--              intervalo [início, início + duração) sobreposto.

begin isolation level repeatable read;
set local lock_timeout = '5s';

do $lago_norte_weekdays$
declare
  expected_total constant integer := 24;
  batch_source constant text := 'december_2026_lago_norte_weekdays';
  batch_note constant text := 'Lago Norte dias úteis dezembro/2026 — criada em lote (supabase/maintenance/december_2026_lago_norte_weekdays.sql).';
  numeric_types constant text[] := array['smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision'];
  missing text;
  not_regular text;
  unsupported_required_columns text;
  legacy_spots_type text;
  legacy_columns text := '';
  legacy_values text := '';
  planned_total integer;
  existing_total integer;
  conflict_total integer;
  inserted_total integer;
  audit_total integer;
  reservations_before text;
  payment_events_before text;
  sessions_before text;
  reservations_after text;
  payment_events_after text;
  sessions_after text;
  summary record;
begin
  if to_regclass('public.bases') is null
     or to_regclass('public.experiences') is null
     or to_regclass('public.sessions') is null
     or to_regclass('public.reservations') is null
     or to_regclass('public.admin_audit_log') is null then
    raise exception 'LAGO_NORTE_WEEKDAYS_SCHEMA_REQUIRED';
  end if;

  -- 1. Plano. Experiência resolvida por slug E pela base esperada: um slug na
  --    base errada não entra no plano e o total deixa de bater.
  create temporary table lnw_plan on commit drop as
  with calendar as (
    select series.day::date as session_date,
           extract(isodow from series.day)::integer as iso_dow
    from generate_series(date '2026-12-01', date '2026-12-31', interval '1 day') as series(day)
    -- Feriados de Brasília em dezembro/2026 (lib/sessions/holidays.ts): só o Natal.
    where series.day::date not in (date '2026-12-25')
  ),
  slots (base_slug, experience_slug, iso_dows, local_hour, local_minute, duration_minutes, price_cents, capacity) as (
    values
      ('lago-norte', 'remada-nascer-do-sol', array[1, 3, 5],  5, 30, 60, 6000, 24),
      ('lago-norte', 'remada-sunset',        array[1, 3, 5], 17, 30, 60, 6000, 24)
  )
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
    slots.capacity,
    null::text as outcome
  from calendar
  join slots on calendar.iso_dow = any (slots.iso_dows)
  join public.bases base on base.slug = slots.base_slug
  join public.experiences experience on experience.slug = slots.experience_slug and experience.base_id = base.id;

  select string_agg(format('%s/%s', wanted.base_slug, wanted.experience_slug), ', ')
  into missing
  from (values
    ('lago-norte', 'remada-nascer-do-sol'), ('lago-norte', 'remada-sunset')
  ) as wanted(base_slug, experience_slug)
  where not exists (
    select 1 from public.experiences e join public.bases b on b.id = e.base_id
    where e.slug = wanted.experience_slug and b.slug = wanted.base_slug
  );
  if missing is not null then
    raise exception using message = 'LAGO_NORTE_WEEKDAYS_EXPERIENCE_NOT_FOUND',
      detail = format('Experiência/base não encontrada: %s.', missing);
  end if;

  -- Só experiências regulares: eventos especiais ficam fora desta agenda.
  select string_agg(distinct plan.experience_slug, ', ')
  into not_regular
  from lnw_plan plan
  join public.experiences e on e.id = plan.experience_id
  where e.kind::text <> 'REGULAR';
  if not_regular is not null then
    raise exception using message = 'LAGO_NORTE_WEEKDAYS_EXPERIENCE_NOT_REGULAR',
      detail = format('Experiência não REGULAR no plano: %s.', not_regular);
  end if;

  select count(*) into planned_total from lnw_plan;
  if planned_total <> expected_total then
    raise exception using message = 'LAGO_NORTE_WEEKDAYS_PLAN_UNEXPECTED_SIZE',
      detail = format('O plano gerou %s sessões e o esperado é %s.', planned_total, expected_total);
  end if;

  -- 2. Intervalo: nenhuma data local fora de 01–31/12.
  if exists (
    select 1 from lnw_plan
    where (starts_at at time zone 'America/Sao_Paulo')::date not between date '2026-12-01' and date '2026-12-31'
  ) then
    raise exception 'LAGO_NORTE_WEEKDAYS_PLAN_OUTSIDE_ALLOWED_RANGE';
  end if;

  -- Brasília é UTC−3 o ano todo desde 2019. Um tzdata antigo com horário de
  -- verão deslocaria todos os horários em 1 hora; nesse caso, aborta.
  if exists (
    select 1 from lnw_plan
    where (starts_at at time zone 'UTC') - (starts_at at time zone 'America/Sao_Paulo') <> interval '3 hours'
  ) then
    raise exception 'LAGO_NORTE_WEEKDAYS_TIMEZONE_OFFSET_UNEXPECTED';
  end if;

  -- 3. Regra do formato de 1 hora: seg/qua/sex, 05:30 ou 17:30, 60 min, R$ 60,
  --    24 vagas, nunca em feriado.
  if exists (
    select 1 from lnw_plan
    where extract(isodow from session_date) not in (1, 3, 5)
       or session_date = date '2026-12-25'
       or to_char(starts_at at time zone 'America/Sao_Paulo', 'HH24:MI') not in ('05:30', '17:30')
       or duration_minutes <> 60 or price_cents <> 6000 or capacity <> 24
  ) then
    raise exception 'LAGO_NORTE_WEEKDAYS_PLAN_RULE';
  end if;

  -- 4. O próprio plano não pode repetir horário nem sobrepor sessões na mesma base.
  if exists (
    select 1 from lnw_plan a join lnw_plan b
      on a.base_id = b.base_id and (a.experience_id, a.starts_at) < (b.experience_id, b.starts_at)
    where tstzrange(a.starts_at, a.starts_at + make_interval(mins => a.duration_minutes))
       && tstzrange(b.starts_at, b.starts_at + make_interval(mins => b.duration_minutes))
  ) or (select count(distinct (experience_id, starts_at)) from lnw_plan) <> planned_total then
    raise exception 'LAGO_NORTE_WEEKDAYS_PLAN_SELF_OVERLAP';
  end if;

  -- 5. Colunas do INSERT. spots_available (legado de produção) entra com a
  --    capacidade quando existe — sessão nova não tem reserva, então é igual a
  --    available_spots(id). Outra coluna obrigatória sem default aborta.
  select data_type into legacy_spots_type
  from information_schema.columns
  where table_schema = 'public' and table_name = 'sessions' and column_name = 'spots_available';

  if legacy_spots_type is not null then
    if not (legacy_spots_type = any (numeric_types)) then
      raise exception using message = 'SESSIONS_SPOTS_AVAILABLE_TYPE_UNSUPPORTED',
        detail = format('public.sessions.spots_available é %s.', legacy_spots_type);
    end if;
    legacy_columns := ', spots_available';
    legacy_values := ', plan.capacity';
  end if;

  select string_agg(column_name::text, ', ' order by ordinal_position)
  into unsupported_required_columns
  from information_schema.columns
  where table_schema = 'public' and table_name = 'sessions'
    and is_nullable = 'NO' and column_default is null
    and is_identity = 'NO' and is_generated = 'NEVER'
    and not (column_name = any (array[
      'experience_id', 'starts_at', 'duration_minutes', 'price_cents', 'capacity', 'status', 'spots_available'
    ]));
  if unsupported_required_columns is not null then
    raise exception using message = 'SESSIONS_REQUIRED_COLUMNS_UNSUPPORTED',
      detail = format('Colunas obrigatórias sem default não mapeadas: %s.', unsupported_required_columns);
  end if;

  -- 6. Classificação de cada horário planejado.
  update lnw_plan plan
  set outcome = case
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
  end;

  select count(*) filter (where outcome = 'JA_EXISTE'), count(*) filter (where outcome = 'CONFLITO')
  into existing_total, conflict_total
  from lnw_plan;

  -- 7. Fotografia antes da escrita.
  select md5(coalesce(string_agg(to_jsonb(r)::text, '|' order by r.id), '')) into reservations_before from public.reservations r;
  select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) into sessions_before from public.sessions s;
  if to_regclass('public.payment_events') is not null then
    execute $q$select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) from public.payment_events p$q$
    into payment_events_before;
  end if;

  -- 8. INSERT só do que está marcado CRIAR, com a mesma cláusula not exists
  --    (defesa extra contra corrida com o painel).
  create temporary table lnw_created (
    id uuid primary key, experience_id uuid, starts_at timestamptz,
    duration_minutes integer, price_cents integer, capacity integer
  ) on commit drop;

  execute format($insert$
    with inserted as (
      insert into public.sessions (
        experience_id, starts_at, duration_minutes, price_cents, capacity, status, internal_notes%1$s
      )
      select plan.experience_id, plan.starts_at, plan.duration_minutes, plan.price_cents, plan.capacity,
             'OPEN'::public.session_status, %3$L%2$s
      from lnw_plan plan
      where plan.outcome = 'CRIAR'
        and not exists (
          select 1 from public.sessions s
          where s.experience_id = plan.experience_id and s.starts_at = plan.starts_at
        )
      returning id, experience_id, starts_at, duration_minutes, price_cents, capacity
    )
    insert into lnw_created (id, experience_id, starts_at, duration_minutes, price_cents, capacity)
    select id, experience_id, starts_at, duration_minutes, price_cents, capacity from inserted
  $insert$, legacy_columns, legacy_values, batch_note);

  get diagnostics inserted_total = row_count;

  if inserted_total <> planned_total - existing_total - conflict_total then
    raise exception using message = 'LAGO_NORTE_WEEKDAYS_INSERT_MISMATCH',
      detail = format('Planejadas %s, já existentes %s, em conflito %s, inseridas %s.',
        planned_total, existing_total, conflict_total, inserted_total);
  end if;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  select null, 'SESSION_CREATED', 'SESSION', created.id,
         jsonb_build_object(
           'starts_at', created.starts_at, 'duration_minutes', created.duration_minutes,
           'price_cents', created.price_cents, 'capacity', created.capacity,
           'status', 'OPEN', 'source', batch_source)
  from lnw_created created;
  get diagnostics audit_total = row_count;

  -- 9. Fotografia depois da escrita: tudo o que já existia tem de estar igual.
  select md5(coalesce(string_agg(to_jsonb(r)::text, '|' order by r.id), '')) into reservations_after from public.reservations r;
  select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), ''))
  into sessions_after
  from public.sessions s
  where not exists (select 1 from lnw_created c where c.id = s.id);
  if to_regclass('public.payment_events') is not null then
    execute $q$select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) from public.payment_events p$q$
    into payment_events_after;
  end if;

  if reservations_after is distinct from reservations_before
     or payment_events_after is distinct from payment_events_before then
    raise exception 'LAGO_NORTE_WEEKDAYS_RESERVATIONS_OR_PAYMENTS_CHANGED';
  end if;
  if sessions_after is distinct from sessions_before then
    raise exception 'LAGO_NORTE_WEEKDAYS_EXISTING_SESSIONS_CHANGED';
  end if;
  if exists (
    select 1 from lnw_created c
    join public.sessions s on s.id = c.id
    join lnw_plan plan on plan.experience_id = c.experience_id and plan.starts_at = c.starts_at
    where s.price_cents <> plan.price_cents or s.duration_minutes <> plan.duration_minutes
       or s.capacity <> plan.capacity or s.status::text <> 'OPEN'
  ) then
    raise exception 'LAGO_NORTE_WEEKDAYS_CREATED_CONFIG_MISMATCH';
  end if;

  raise notice 'Lago Norte dias úteis dezembro/2026: % planejadas, % já existiam, % em conflito, % criadas agora (% linhas de auditoria).',
    planned_total, existing_total, conflict_total, inserted_total, audit_total;

  for summary in
    select base_slug, experience_slug,
           to_char(starts_at at time zone 'America/Sao_Paulo', 'HH24:MI') as local_time,
           duration_minutes, price_cents,
           count(*) as planned,
           count(*) filter (where outcome = 'JA_EXISTE') as existing,
           count(*) filter (where outcome = 'CONFLITO') as conflicts,
           count(*) filter (where outcome = 'CRIAR') as created
    from lnw_plan
    group by 1, 2, 3, 4, 5
    order by 1, 2, 3
  loop
    raise notice '  % / % %h (% min, % centavos): % planejadas, % já existiam, % em conflito, % criadas.',
      summary.base_slug, summary.experience_slug, summary.local_time, summary.duration_minutes, summary.price_cents,
      summary.planned, summary.existing, summary.conflicts, summary.created;
  end loop;

  for summary in
    select base_slug, experience_slug, outcome,
           to_char(starts_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') as local_start
    from lnw_plan
    where outcome <> 'CRIAR'
    order by starts_at, base_slug
  loop
    raise notice '  pulado (%): % / % às %.', summary.outcome, summary.base_slug, summary.experience_slug, summary.local_start;
  end loop;
end;
$lago_norte_weekdays$;

commit;
