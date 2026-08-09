-- Agenda de setembro de 2026 da Alma Azul Academy.
--
-- Aditiva, idempotente e transacional: todo o trabalho acontece dentro de um
-- único bloco DO, então ou a agenda inteira é criada ou nada é inserido.
-- Reexecutar não cria duplicatas e não altera nenhuma sessão existente.
--
-- Regra de duplicidade: mesma experience_id + mesmo starts_at, em qualquer
-- status (inclusive CANCELLED e ARCHIVED). Linhas já existentes são apenas
-- ignoradas — sem UPDATE, sem DELETE, sem on conflict do update.
--
-- Não toca em experiências, reservas, pagamentos, autenticação, conteúdo
-- editorial nem em sessões de agosto ou outubro.
--
-- Padrão de toda sessão criada aqui:
--   duração 90 minutos, preço R$ 70,00 (7000 centavos), status OPEN e
--   capacidade lida de experiences.default_capacity (hoje 28 pessoas).
--
-- Horários locais (America/Sao_Paulo), derivados do calendário de setembro/2026:
--   sextas   (04, 11, 18, 25): 05:30 Nascer do Sol · 09:00 Imersão · 17:00 Sunset
--   sábados  (05, 12, 19, 26): 06:00 Nascer do Sol · 09:00, 12:00 e 15:00 Imersão
--   domingos (06, 13, 20, 27): 09:00, 12:00 e 15:00 Imersão · 17:00 Sunset
--
-- Total planejado: 4 x 3 + 4 x 4 + 4 x 4 = 44 sessões
--   Imersão Paranoá 28 · Remada do Nascer do Sol 8 · Remada Sunset 8.
--
-- A conversão para UTC é feita pelo banco, com make_timestamptz e o fuso
-- America/Sao_Paulo. Nenhuma hora é somada ou subtraída manualmente.

do $september_2026$
declare
  required_slugs constant text[] := array['imersao-paranoa', 'remada-nascer-do-sol', 'remada-sunset'];
  expected_total constant integer := 44;
  missing_slugs text;
  unsupported_required_columns text;
  invalid_capacity text;
  planned_total integer;
  existing_total integer;
  inserted_total integer;
  summary record;
begin
  if to_regclass('public.experiences') is null or to_regclass('public.sessions') is null then
    raise exception 'RESERVATION_PLATFORM_MIGRATION_REQUIRED';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'experiences'
      and column_name = 'default_capacity'
  ) then
    raise exception 'EXPERIENCES_DEFAULT_CAPACITY_REQUIRED';
  end if;

  -- 1. Experiências resolvidas por slug. Sem qualquer uma delas a agenda ficaria
  --    incompleta, então a migration aborta antes de inserir qualquer linha.
  select string_agg(required.slug, ', ' order by required.slug)
  into missing_slugs
  from unnest(required_slugs) as required(slug)
  where not exists (select 1 from public.experiences experience where experience.slug = required.slug);

  if missing_slugs is not null then
    raise exception using
      message = 'SEPTEMBER_2026_EXPERIENCE_SLUG_NOT_FOUND',
      detail = format('Slugs não encontrados em public.experiences: %s.', missing_slugs),
      hint = 'Aplique as migrations das experiências antes desta agenda.';
  end if;

  -- 2. Colunas obrigatórias sem default que esta migration não preenche. Um schema
  --    fora do esperado é inconsistência grave: aborta sem inserção parcial.
  select string_agg(column_name, ', ' order by ordinal_position)
  into unsupported_required_columns
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'sessions'
    and is_nullable = 'NO'
    and column_default is null
    and is_identity = 'NO'
    and is_generated = 'NEVER'
    and not (column_name = any (array[
      'experience_id', 'starts_at', 'duration_minutes', 'price_cents', 'capacity', 'status'
    ]));

  if unsupported_required_columns is not null then
    raise exception using
      message = 'SESSIONS_REQUIRED_COLUMNS_UNSUPPORTED',
      detail = format('Colunas obrigatórias sem default não mapeadas: %s.', unsupported_required_columns),
      hint = 'Revise o schema de public.sessions antes de criar a agenda.';
  end if;

  -- 3. Capacidade padrão vem da experiência, não de um número fixo na migration.
  select string_agg(format('%s = %s', experience.slug, coalesce(experience.default_capacity::text, 'null')), ', ' order by experience.slug)
  into invalid_capacity
  from public.experiences experience
  where experience.slug = any (required_slugs)
    and (experience.default_capacity is null or experience.default_capacity <= 0);

  if invalid_capacity is not null then
    raise exception using
      message = 'SEPTEMBER_2026_DEFAULT_CAPACITY_INVALID',
      detail = format('Capacidade padrão inválida: %s.', invalid_capacity),
      hint = 'Corrija default_capacity da experiência antes de criar a agenda.';
  end if;

  -- 4. O plano é derivado do calendário real de setembro/2026 (isodow 5 = sexta,
  --    6 = sábado, 7 = domingo). Nenhuma data é digitada à mão.
  --    A tabela é temporária e some no commit; nada dela persiste no schema.
  create temporary table september_2026_plan on commit drop as
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
  )
  select
    experience.id as experience_id,
    slots.slug,
    calendar.session_date,
    calendar.iso_dow,
    slots.local_hour,
    slots.local_minute,
    make_timestamptz(
      2026,
      9,
      extract(day from calendar.session_date)::integer,
      slots.local_hour,
      slots.local_minute,
      0,
      'America/Sao_Paulo'
    ) as starts_at,
    experience.default_capacity as capacity
  from calendar
  join slots on slots.iso_dow = calendar.iso_dow
  join public.experiences experience on experience.slug = slots.slug;

  select count(*) into planned_total from september_2026_plan;

  if planned_total <> expected_total then
    raise exception using
      message = 'SEPTEMBER_2026_PLAN_UNEXPECTED_SIZE',
      detail = format('O plano gerou %s sessões e o esperado é %s.', planned_total, expected_total),
      hint = 'Revise o calendário e a tabela de horários antes de aplicar.';
  end if;

  -- 5. Conflitos: qualquer sessão já cadastrada para a mesma experiência e horário
  --    é preservada exatamente como está.
  select count(*)
  into existing_total
  from september_2026_plan plan
  where exists (
    select 1
    from public.sessions session
    where session.experience_id = plan.experience_id
      and session.starts_at = plan.starts_at
  );

  insert into public.sessions (
    experience_id,
    starts_at,
    duration_minutes,
    price_cents,
    capacity,
    status
  )
  select
    plan.experience_id,
    plan.starts_at,
    90,
    7000,
    plan.capacity,
    'OPEN'::public.session_status
  from september_2026_plan plan
  where not exists (
    select 1
    from public.sessions session
    where session.experience_id = plan.experience_id
      and session.starts_at = plan.starts_at
  );

  get diagnostics inserted_total = row_count;

  if inserted_total + existing_total <> planned_total then
    raise exception using
      message = 'SEPTEMBER_2026_INSERT_MISMATCH',
      detail = format('Planejadas %s, já existentes %s, inseridas %s.', planned_total, existing_total, inserted_total);
  end if;

  raise notice 'Agenda setembro/2026: % planejadas, % já existiam, % criadas agora.',
    planned_total, existing_total, inserted_total;

  for summary in
    select
      plan.slug,
      count(*) as planned,
      count(*) filter (where exists (
        select 1
        from public.sessions session
        where session.experience_id = plan.experience_id
          and session.starts_at = plan.starts_at
      )) as present_now
    from september_2026_plan plan
    group by plan.slug
    order by plan.slug
  loop
    raise notice '  %: % planejadas, % presentes no banco.', summary.slug, summary.planned, summary.present_now;
  end loop;
end;
$september_2026$;
