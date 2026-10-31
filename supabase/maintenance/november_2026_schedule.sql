-- AGENDA DE NOVEMBRO/2026 (02 a 30/11) — CRIAÇÃO DAS SESSÕES
--
-- Script de dados para o SQL Editor do Supabase. Não é migration: não cria nem
-- altera tabela, coluna, função, trigger, tipo ou policy. Rodar DEPOIS do
-- preflight (supabase/diagnostics/november_2026_schedule_preflight.sql) com a
-- linha READY_TO_CREATE_NOVEMBER_SCHEDULE em OK, e conferir com o postcheck.
--
-- Aditivo, idempotente e transacional: tudo acontece em uma transação
-- REPEATABLE READ e em um único bloco DO. Ou a agenda inteira entra, ou nada.
-- Reexecutar não cria duplicatas: cria só o que ainda faltar.
--
-- DIA 01/11/2026 PROTEGIDO. O calendário começa em 02/11; o bloco aborta se
-- qualquer horário planejado cair fora de 02–30/11 (data local de Brasília) e
-- aborta se as sessões de 01/11, as reservas (todas), os eventos de pagamento
-- ou qualquer sessão preexistente mudarem dentro da transação. Como a
-- transação é REPEATABLE READ, as duas leituras usam a mesma fotografia do
-- banco: reservas feitas pelo site enquanto o script roda não causam aborto
-- falso, e a comparação prova que só este script escreveu algo.
--
-- O que é escrito: só INSERT em public.sessions (as sessões faltantes) e em
-- public.admin_audit_log (uma linha SESSION_CREATED por sessão, como faz o
-- painel em admin_create_session, com actor nulo e source no metadata).
-- Nenhum UPDATE, DELETE ou on conflict do update. Experiências, bases,
-- preços e capacidades globais, reservas e pagamentos não são tocados.
--
-- Programação (horário local America/Sao_Paulo; make_timestamptz converte,
-- nenhuma hora é somada à mão):
--   Lago Norte (24 vagas)
--     sábados  07, 14, 21, 28: 05:30 Remada do Nascer do Sol · 09:00, 12:00, 15:00 Imersão Paranoá
--     domingos 08, 15, 22, 29: 09:00, 12:00, 15:00 Imersão Paranoá · 17:00 Remada Sunset
--   Cápsula Bar — Concha Acústica (12 vagas)
--     todos os dias 02–30:     17:00 Remada Sunset
--     sábados e domingos:      15:00 Rota Ermida Ponte JK
--   Toda sessão: R$ 70,00 (7000 centavos), 90 minutos, status OPEN.
--   Total planejado: 32 + 29 + 8 = 69.
--
-- Regras de não criação (o horário planejado é preservado/pulado e relatado):
--   JÁ EXISTE  mesma experiência + mesmo starts_at, em qualquer status
--              (inclusive CANCELLED e ARCHIVED). A base vem da experiência.
--   CONFLITO   outra sessão da MESMA BASE, não cancelada nem arquivada, cujo
--              intervalo [início, início + duração) se sobrepõe ao horário
--              planejado. O banco não tem regra de sobreposição; esta é a
--              proteção conservadora pedida — a sessão fica para o painel.

begin isolation level repeatable read;
set local lock_timeout = '5s';

do $november_2026$
declare
  expected_total constant integer := 69;
  batch_source constant text := 'november_2026_schedule';
  batch_note constant text := 'Agenda novembro/2026 — criada em lote (supabase/maintenance/november_2026_schedule.sql).';
  numeric_types constant text[] := array['smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision'];
  missing text;
  unsupported_required_columns text;
  legacy_spots_type text;
  legacy_columns text := '';
  legacy_values text := '';
  planned_total integer;
  existing_total integer;
  conflict_total integer;
  inserted_total integer;
  audit_total integer;
  day1_sessions_before text;
  day1_reservations_before text;
  reservations_before text;
  payment_events_before text;
  sessions_before text;
  day1_sessions_after text;
  day1_reservations_after text;
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
    raise exception 'NOVEMBER_2026_SCHEMA_REQUIRED';
  end if;

  -- 1. Plano. Experiência resolvida por slug E pela base esperada: um slug na
  --    base errada não entra no plano e o total deixa de bater.
  create temporary table november_2026_plan on commit drop as
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
  )
  select
    base.id as base_id,
    slots.base_slug,
    experience.id as experience_id,
    slots.experience_slug,
    calendar.session_date,
    make_timestamptz(
      2026, 11, extract(day from calendar.session_date)::integer,
      slots.local_hour, slots.local_minute, 0, 'America/Sao_Paulo'
    ) as starts_at,
    90 as duration_minutes,
    7000 as price_cents,
    slots.capacity,
    null::text as outcome
  from calendar
  join slots on calendar.iso_dow = any (slots.iso_dows)
  join public.bases base on base.slug = slots.base_slug
  join public.experiences experience on experience.slug = slots.experience_slug and experience.base_id = base.id;

  select string_agg(format('%s/%s', wanted.base_slug, wanted.experience_slug), ', ')
  into missing
  from (values
    ('lago-norte', 'remada-nascer-do-sol'), ('lago-norte', 'imersao-paranoa'), ('lago-norte', 'remada-sunset'),
    ('concha-acustica', 'remada-sunset-concha-acustica'), ('concha-acustica', 'rota-ermida-ponte-jk')
  ) as wanted(base_slug, experience_slug)
  where not exists (
    select 1 from public.experiences e join public.bases b on b.id = e.base_id
    where e.slug = wanted.experience_slug and b.slug = wanted.base_slug
  );
  if missing is not null then
    raise exception using message = 'NOVEMBER_2026_EXPERIENCE_NOT_FOUND',
      detail = format('Experiência/base não encontrada: %s.', missing);
  end if;

  select count(*) into planned_total from november_2026_plan;
  if planned_total <> expected_total then
    raise exception using message = 'NOVEMBER_2026_PLAN_UNEXPECTED_SIZE',
      detail = format('O plano gerou %s sessões e o esperado é %s.', planned_total, expected_total);
  end if;

  -- 2. Proteção de 01/11 e do intervalo: nenhuma data local fora de 02–30/11.
  if exists (
    select 1 from november_2026_plan
    where (starts_at at time zone 'America/Sao_Paulo')::date not between date '2026-11-02' and date '2026-11-30'
  ) then
    raise exception 'NOVEMBER_2026_PLAN_OUTSIDE_ALLOWED_RANGE';
  end if;

  -- Brasília é UTC−3 o ano todo desde 2019. Um tzdata antigo com horário de
  -- verão deslocaria todos os horários em 1 hora; nesse caso, aborta.
  if exists (
    select 1 from november_2026_plan
    where (starts_at at time zone 'UTC') - (starts_at at time zone 'America/Sao_Paulo') <> interval '3 hours'
  ) then
    raise exception 'NOVEMBER_2026_TIMEZONE_OFFSET_UNEXPECTED';
  end if;

  -- 3. O próprio plano não pode repetir horário nem sobrepor sessões na mesma base.
  if exists (
    select 1 from november_2026_plan a join november_2026_plan b
      on a.base_id = b.base_id and (a.experience_id, a.starts_at) < (b.experience_id, b.starts_at)
    where tstzrange(a.starts_at, a.starts_at + make_interval(mins => a.duration_minutes))
       && tstzrange(b.starts_at, b.starts_at + make_interval(mins => b.duration_minutes))
  ) or (select count(distinct (experience_id, starts_at)) from november_2026_plan) <> planned_total then
    raise exception 'NOVEMBER_2026_PLAN_SELF_OVERLAP';
  end if;

  -- 4. Colunas do INSERT. spots_available (legado de produção) entra com a
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

  -- 5. Classificação de cada horário planejado.
  update november_2026_plan plan
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
  from november_2026_plan;

  -- 6. Fotografia antes da escrita.
  select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), ''))
  into day1_sessions_before
  from public.sessions s
  where (s.starts_at at time zone 'America/Sao_Paulo')::date = date '2026-11-01';

  select md5(coalesce(string_agg(to_jsonb(r)::text, '|' order by r.id), ''))
  into day1_reservations_before
  from public.reservations r
  join public.sessions s on s.id = r.session_id
  where (s.starts_at at time zone 'America/Sao_Paulo')::date = date '2026-11-01';

  select md5(coalesce(string_agg(to_jsonb(r)::text, '|' order by r.id), '')) into reservations_before from public.reservations r;
  select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) into sessions_before from public.sessions s;
  if to_regclass('public.payment_events') is not null then
    execute $q$select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) from public.payment_events p$q$
    into payment_events_before;
  end if;

  -- 7. INSERT só do que está marcado CRIAR, com a mesma cláusula not exists
  --    (defesa extra contra corrida com o painel).
  create temporary table november_2026_created (id uuid primary key, experience_id uuid, starts_at timestamptz, capacity integer) on commit drop;

  execute format($insert$
    with inserted as (
      insert into public.sessions (
        experience_id, starts_at, duration_minutes, price_cents, capacity, status, internal_notes%1$s
      )
      select plan.experience_id, plan.starts_at, plan.duration_minutes, plan.price_cents, plan.capacity,
             'OPEN'::public.session_status, %3$L%2$s
      from november_2026_plan plan
      where plan.outcome = 'CRIAR'
        and not exists (
          select 1 from public.sessions s
          where s.experience_id = plan.experience_id and s.starts_at = plan.starts_at
        )
      returning id, experience_id, starts_at, capacity
    )
    insert into november_2026_created (id, experience_id, starts_at, capacity)
    select id, experience_id, starts_at, capacity from inserted
  $insert$, legacy_columns, legacy_values, batch_note);

  get diagnostics inserted_total = row_count;

  if inserted_total <> planned_total - existing_total - conflict_total then
    raise exception using message = 'NOVEMBER_2026_INSERT_MISMATCH',
      detail = format('Planejadas %s, já existentes %s, em conflito %s, inseridas %s.',
        planned_total, existing_total, conflict_total, inserted_total);
  end if;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  select null, 'SESSION_CREATED', 'SESSION', created.id,
         jsonb_build_object('starts_at', created.starts_at, 'capacity', created.capacity, 'status', 'OPEN', 'source', batch_source)
  from november_2026_created created;
  get diagnostics audit_total = row_count;

  -- 8. Fotografia depois da escrita: tudo o que já existia tem de estar igual.
  select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), ''))
  into day1_sessions_after
  from public.sessions s
  where (s.starts_at at time zone 'America/Sao_Paulo')::date = date '2026-11-01';

  select md5(coalesce(string_agg(to_jsonb(r)::text, '|' order by r.id), ''))
  into day1_reservations_after
  from public.reservations r
  join public.sessions s on s.id = r.session_id
  where (s.starts_at at time zone 'America/Sao_Paulo')::date = date '2026-11-01';

  select md5(coalesce(string_agg(to_jsonb(r)::text, '|' order by r.id), '')) into reservations_after from public.reservations r;
  select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), ''))
  into sessions_after
  from public.sessions s
  where not exists (select 1 from november_2026_created c where c.id = s.id);
  if to_regclass('public.payment_events') is not null then
    execute $q$select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) from public.payment_events p$q$
    into payment_events_after;
  end if;

  if day1_sessions_after is distinct from day1_sessions_before
     or day1_reservations_after is distinct from day1_reservations_before then
    raise exception 'NOVEMBER_2026_DAY1_CHANGED';
  end if;
  if reservations_after is distinct from reservations_before
     or payment_events_after is distinct from payment_events_before then
    raise exception 'NOVEMBER_2026_RESERVATIONS_OR_PAYMENTS_CHANGED';
  end if;
  if sessions_after is distinct from sessions_before then
    raise exception 'NOVEMBER_2026_EXISTING_SESSIONS_CHANGED';
  end if;
  if exists (
    select 1 from november_2026_created c
    where (c.starts_at at time zone 'America/Sao_Paulo')::date = date '2026-11-01'
  ) then
    raise exception 'NOVEMBER_2026_DAY1_WRITE_BLOCKED';
  end if;

  raise notice 'Agenda novembro/2026: % planejadas, % já existiam, % em conflito, % criadas agora (% linhas de auditoria).',
    planned_total, existing_total, conflict_total, inserted_total, audit_total;
  raise notice '01/11 preservado: sessões % = %, reservas % = %.',
    day1_sessions_before, day1_sessions_after, day1_reservations_before, day1_reservations_after;

  for summary in
    select base_slug, experience_slug,
           count(*) as planned,
           count(*) filter (where outcome = 'JA_EXISTE') as existing,
           count(*) filter (where outcome = 'CONFLITO') as conflicts,
           count(*) filter (where outcome = 'CRIAR') as created
    from november_2026_plan
    group by base_slug, experience_slug
    order by base_slug, experience_slug
  loop
    raise notice '  % / %: % planejadas, % já existiam, % em conflito, % criadas.',
      summary.base_slug, summary.experience_slug, summary.planned, summary.existing, summary.conflicts, summary.created;
  end loop;

  for summary in
    select base_slug, experience_slug, outcome,
           to_char(starts_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') as local_start
    from november_2026_plan
    where outcome <> 'CRIAR'
    order by starts_at, base_slug
  loop
    raise notice '  pulado (%): % / % às %.', summary.outcome, summary.base_slug, summary.experience_slug, summary.local_start;
  end loop;
end;
$november_2026$;

commit;
