-- =============================================================================
-- EVENTOS ESPECIAIS, FASE 2 — FUNDAÇÃO NO BANCO
-- =============================================================================
--
-- Um evento especial é uma experiência (`experiences`) com `kind = 'EVENT'` e
-- uma sessão por edição. Reserva, vaga, pagamento, confirmação, planilha,
-- check-in, Stand-by e lista de espera continuam sendo os de sempre: nenhum
-- segundo sistema de reservas é criado.
--
-- O que esta migration faz:
--
--   1. `experiences.kind` ('REGULAR' | 'EVENT'), com 'REGULAR' como padrão.
--      Toda linha existente vira REGULAR pelo próprio default da coluna, sem
--      UPDATE e sem disparar trigger nenhuma;
--   2. `special_event_settings`: interruptor da publicação de eventos,
--      DESLIGADO. Enquanto desligado, nenhum evento pode ser PUBLISHED, por
--      nenhum caminho (painel antigo, RPC nova ou SQL);
--   3. `experiences_kind_guard`: o tipo não muda depois que a experiência tem
--      sessão, e o evento só é publicado com o interruptor ligado;
--   4. `reservations_event_kind_guard`: nenhuma reserva troca de sessão para
--      uma sessão de outro tipo — troca de turma do painel, Stand-by
--      (painel e autoatendimento) e qualquer caminho futuro (`EVENT_KIND_MISMATCH`);
--   5. leitura pública nova: `list_public_events`, `get_public_event`,
--      `list_public_event_sessions`, `list_public_regular_experiences` e
--      `list_public_regular_catalog`;
--   6. painel: `admin_create_event`, `admin_update_event`,
--      `admin_duplicate_event`, `admin_list_events` e `admin_event_report`.
--
-- O que NÃO faz: não substitui o corpo de nenhuma função existente, não toca
-- linha de reserva, sessão, pagamento, Stand-by ou lista de espera, não cria
-- agendamento e não cadastra evento nenhum. As listagens públicas atuais
-- (`list_public_experiences`, `list_public_catalog`, `get_public_experience`,
-- `list_open_sessions`) seguem iguais; o site passa a usar as versões por tipo
-- na fase 3, antes de qualquer evento ser publicado.
--
-- Idempotente: pode ser aplicada de novo sem efeito. Rollback em
-- `supabase/rollback/202610280001_special_events_foundation.rollback.sql`.

-- ---------------------------------------------------------------------------
-- 1. experiences.kind
-- ---------------------------------------------------------------------------
-- `add column ... not null default` não reescreve a tabela (Postgres 11+) e
-- preenche as linhas existentes com o default: nenhuma trigger de
-- `experiences` dispara e `updated_at` não muda.

alter table public.experiences
  add column if not exists kind text not null default 'REGULAR';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.experiences'::regclass
      and conname = 'experiences_kind_check'
  ) then
    alter table public.experiences add constraint experiences_kind_check
      check (kind in ('REGULAR', 'EVENT'));
  end if;
end;
$$;

comment on column public.experiences.kind is
  'REGULAR = experiência da agenda regular; EVENT = evento especial (uma sessão por edição). Não muda depois que a experiência tem sessão.';

-- ---------------------------------------------------------------------------
-- 2. Interruptor da publicação de eventos
-- ---------------------------------------------------------------------------
-- Desligado de fábrica. Ligar é uma decisão operacional, feita à mão no SQL
-- Editor quando as páginas de evento estiverem no ar:
--   update public.special_event_settings set publication_enabled = true, updated_at = now();

create table if not exists public.special_event_settings (
  singleton boolean primary key default true check (singleton),
  publication_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.special_event_settings (singleton) values (true)
on conflict (singleton) do nothing;

alter table public.special_event_settings enable row level security;
revoke all on table public.special_event_settings from public, anon, authenticated, service_role;

comment on table public.special_event_settings is
  'Interruptor da publicação de eventos especiais. Sem acesso pela API; alterado só no SQL Editor.';

-- ---------------------------------------------------------------------------
-- 3. Regras do tipo da experiência
-- ---------------------------------------------------------------------------
-- `security definer` porque lê o interruptor, que não tem privilégio para
-- ninguém — inclusive para a service role, que escreve em `experiences`.

create or replace function public.enforce_experience_kind_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- As sessões, reservas e a receita da experiência pertencem ao tipo em que
  -- aconteceram: trocar depois misturaria evento e agenda regular.
  if tg_op = 'UPDATE'
     and new.kind is distinct from old.kind
     and exists (select 1 from public.sessions s where s.experience_id = new.id) then
    raise exception 'EXPERIENCE_KIND_LOCKED' using errcode = '23514';
  end if;

  -- Só a passagem para PUBLISHED é conferida: um evento já publicado continua
  -- editável mesmo que o interruptor seja desligado depois.
  if new.kind = 'EVENT'
     and new.status = 'PUBLISHED'
     and (tg_op = 'INSERT' or old.status is distinct from 'PUBLISHED' or old.kind is distinct from 'EVENT')
     and not coalesce((select ses.publication_enabled from public.special_event_settings ses where ses.singleton), false) then
    raise exception 'EVENT_PUBLICATION_DISABLED' using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_experience_kind_rules() is
  'Invariantes de experiences.kind: imutável depois da primeira sessão; evento só vira PUBLISHED com special_event_settings.publication_enabled.';

revoke all on function public.enforce_experience_kind_rules() from public, anon, authenticated, service_role;

drop trigger if exists experiences_kind_guard on public.experiences;
create trigger experiences_kind_guard
  before insert or update of kind, status on public.experiences
  for each row execute function public.enforce_experience_kind_rules();

-- ---------------------------------------------------------------------------
-- 4. Nenhuma reserva troca de tipo
-- ---------------------------------------------------------------------------
-- Toda troca de turma escreve `reservations.session_id`: a troca do painel
-- (`admin_change_reservation_session`), o Stand-by pelo painel
-- (`admin_reschedule_standby_same_price` e a função antiga sem regra de preço),
-- o desfazer do Stand-by e o autoatendimento (`customer_reschedule_reservation`).
-- Uma trigger cobre todos, sem reescrever nenhum deles. A recusa desfaz a
-- transação inteira: histórico, Stand-by, e-mail de reagendamento e planilha
-- nem chegam a ser gravados.

create or replace function public.enforce_reservation_event_kind()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  previous_kind text;
  next_kind text;
begin
  if new.session_id is not distinct from old.session_id then
    return new;
  end if;

  select e.kind into previous_kind
  from public.sessions s join public.experiences e on e.id = s.experience_id
  where s.id = old.session_id;

  select e.kind into next_kind
  from public.sessions s join public.experiences e on e.id = s.experience_id
  where s.id = new.session_id;

  -- Sessão inexistente fica com a trigger de coerência, que já a recusa.
  if coalesce(previous_kind, 'REGULAR') is distinct from coalesce(next_kind, 'REGULAR') then
    raise exception 'EVENT_KIND_MISMATCH' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.enforce_reservation_event_kind() is
  'Invariante: uma reserva só troca de sessão para outra sessão do mesmo tipo (REGULAR ↔ REGULAR, EVENT ↔ EVENT).';

revoke all on function public.enforce_reservation_event_kind() from public, anon, authenticated, service_role;

drop trigger if exists reservations_event_kind_guard on public.reservations;
create trigger reservations_event_kind_guard
  before update of session_id on public.reservations
  for each row execute function public.enforce_reservation_event_kind();

-- ---------------------------------------------------------------------------
-- 5. Leitura pública
-- ---------------------------------------------------------------------------

-- Situação de uma sessão de evento, na ordem em que o cliente precisa ler:
-- cancelada, já realizada, reservas encerradas, esgotada ou com vagas.
-- `available_spots` não olha o status da sessão; por isso o status vem antes.
create or replace function public.special_event_availability(p_session_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when s.status = 'CANCELLED' then 'CANCELLED'
    when s.starts_at <= now() then 'ENDED'
    when s.status <> 'OPEN' then 'CLOSED'
    when coalesce(public.available_spots(s.id), 0) <= 0 then 'SOLD_OUT'
    else 'AVAILABLE'
  end
  from public.sessions s
  where s.id = p_session_id;
$$;

comment on function public.special_event_availability(uuid) is
  'AVAILABLE, SOLD_OUT, CLOSED, ENDED ou CANCELLED para uma sessão. Só exibição: reservar continua passando por create_pre_reservation.';

-- Um evento publicado por linha, com a sessão em destaque: a próxima sessão
-- ativa; sem ela, a mais recente. Próximos primeiro, depois os já realizados.
-- Não devolve capacidade nem dado de reserva; vagas restantes só enquanto a
-- sessão está aberta e no futuro.
create or replace function public.list_public_events()
returns table (
  id uuid,
  slug text,
  title text,
  summary text,
  image_url text,
  display_order integer,
  editorial_content jsonb,
  base_slug text,
  base_name text,
  base_address text,
  base_meeting_point text,
  base_maps_url text,
  session_id uuid,
  starts_at timestamptz,
  duration_minutes integer,
  price_cents integer,
  remaining_spots integer,
  availability text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    e.id, e.slug, e.title, e.summary, e.image_url, e.display_order, e.editorial_content,
    b.slug, b.name, b.address, b.meeting_point, b.maps_url,
    hs.id, hs.starts_at, hs.duration_minutes, hs.price_cents,
    case when hs.availability in ('AVAILABLE', 'SOLD_OUT') then coalesce(public.available_spots(hs.id), 0) end,
    coalesce(hs.availability, 'NO_SESSION')
  from public.experiences e
  join public.bases b on b.id = e.base_id
  left join lateral (
    select s.id, s.starts_at, s.duration_minutes, s.price_cents,
           public.special_event_availability(s.id) as availability
    from public.sessions s
    where s.experience_id = e.id
      and s.status <> 'ARCHIVED'
    order by (s.starts_at > now() and s.status <> 'CANCELLED') desc,
             case when s.starts_at > now() then s.starts_at end asc,
             s.starts_at desc
    limit 1
  ) hs on true
  where e.kind = 'EVENT'
    and e.status = 'PUBLISHED'
    and e.editorial_content <> '{}'::jsonb
    and b.status <> 'INACTIVE'
  order by (hs.starts_at > now()) desc nulls last,
           case when hs.starts_at > now() then hs.starts_at end asc,
           hs.starts_at desc,
           e.display_order, e.title;
$$;

create or replace function public.get_public_event(p_slug text)
returns table (
  id uuid,
  slug text,
  title text,
  summary text,
  image_url text,
  display_order integer,
  editorial_content jsonb,
  base_slug text,
  base_name text,
  base_address text,
  base_meeting_point text,
  base_maps_url text,
  session_id uuid,
  starts_at timestamptz,
  duration_minutes integer,
  price_cents integer,
  remaining_spots integer,
  availability text
)
language sql
stable
security definer
set search_path = public
as $$
  select * from public.list_public_events() ev where ev.slug = lower(trim(p_slug));
$$;

-- Todas as sessões de um evento publicado, inclusive encerradas, esgotadas e
-- já realizadas (só exibição). Sessão arquivada não aparece.
create or replace function public.list_public_event_sessions(p_slug text)
returns table (
  id uuid,
  experience_id uuid,
  experience_slug text,
  experience_title text,
  starts_at timestamptz,
  duration_minutes integer,
  price_cents integer,
  remaining_spots integer,
  availability text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.id, e.id, e.slug, e.title, s.starts_at, s.duration_minutes, s.price_cents,
    case when st.availability in ('AVAILABLE', 'SOLD_OUT') then coalesce(public.available_spots(s.id), 0) end,
    st.availability
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  cross join lateral (select public.special_event_availability(s.id) as availability) st
  where e.slug = lower(trim(p_slug))
    and e.kind = 'EVENT'
    and e.status = 'PUBLISHED'
    and s.status <> 'ARCHIVED'
  order by s.starts_at, s.id;
$$;

-- As duas listagens do site, recortadas para a agenda regular. Mesmas colunas,
-- mesma ordem e mesmo filtro de `list_public_experiences` e
-- `list_public_catalog`, mais `kind = 'REGULAR'`. As originais ficam intactas.
create or replace function public.list_public_regular_experiences()
returns table (id uuid, slug text, title text, summary text, image_url text, display_order integer, editorial_content jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.slug, e.title, e.summary, e.image_url, e.display_order, e.editorial_content
  from public.experiences e
  where e.status = 'PUBLISHED' and e.editorial_content <> '{}'::jsonb and e.kind = 'REGULAR'
  order by e.display_order, e.title;
$$;

create or replace function public.list_public_regular_catalog()
returns table (
  id uuid, slug text, title text, summary text, status text, image_url text,
  display_order integer, editorial_content jsonb, base_id uuid, base_slug text,
  is_exclusive boolean, modality text
)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.slug, e.title, e.summary, e.status, e.image_url,
         e.display_order,
         case when e.status = 'PUBLISHED' then e.editorial_content else '{}'::jsonb end,
         b.id, b.slug, e.is_exclusive, coalesce(e.modality, e.slug)
  from public.experiences e
  join public.bases b on b.id = e.base_id
  where b.status <> 'INACTIVE'
    and e.kind = 'REGULAR'
    and (
      (e.status = 'PUBLISHED' and e.editorial_content <> '{}'::jsonb)
      or e.status = 'COMING_SOON'
    )
  order by b.display_order, e.display_order, e.title;
$$;

-- ---------------------------------------------------------------------------
-- 6. Painel
-- ---------------------------------------------------------------------------
-- Todas executáveis só pela service role, depois de `is_active_admin` (ADMIN
-- ou OPERATOR ativo). Reaproveitam as RPCs de experiência e de sessão que o
-- painel já usa — mesmas validações, mesma auditoria — em vez de repetir regra.

-- Cria o evento em rascunho, com a sessão FECHADA para reservas. Nada fica à
-- venda: reservar exige experiência publicada e sessão aberta.
create or replace function public.admin_create_event(
  p_actor_id uuid,
  p_base_id uuid,
  p_slug text,
  p_title text,
  p_summary text,
  p_editorial_content jsonb,
  p_image_url text,
  p_starts_at timestamptz,
  p_duration_minutes integer,
  p_price_cents integer,
  p_capacity integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  created_experience uuid;
  created_session uuid;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if p_capacity is null or p_capacity < 1 or p_capacity > 500 then
    raise exception 'INVALID_EVENT_CAPACITY' using errcode = '22023';
  end if;

  created_experience := public.admin_create_experience(
    p_actor_id, p_slug, p_title, p_summary, 'DRAFT', p_image_url, 0, p_summary,
    p_duration_minutes, p_price_cents, p_capacity, coalesce(p_editorial_content, '{}'::jsonb), p_base_id
  );

  update public.experiences set kind = 'EVENT' where id = created_experience;

  created_session := public.admin_create_session(
    p_actor_id, created_experience, p_starts_at, p_duration_minutes, p_price_cents, p_capacity,
    'CLOSED', 'Evento especial: criado fechado para reservas.'
  );

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (
    p_actor_id, 'EVENT_CREATED', 'experience', created_experience,
    jsonb_build_object('slug', p_slug, 'title', p_title, 'sessionId', created_session, 'startsAt', p_starts_at,
                       'priceCents', p_price_cents, 'capacity', p_capacity, 'baseId', p_base_id)
  );

  return jsonb_build_object('experienceId', created_experience, 'sessionId', created_session);
end;
$$;

-- Conteúdo e status do evento. Data, preço, capacidade e abrir/fechar
-- reservas continuam na sessão, pelas RPCs de sessão de sempre.
create or replace function public.admin_update_event(
  p_actor_id uuid,
  p_experience_id uuid,
  p_title text,
  p_summary text,
  p_status text,
  p_image_url text,
  p_display_order integer,
  p_editorial_content jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_event public.experiences%rowtype;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('DRAFT', 'PUBLISHED', 'ARCHIVED') then
    raise exception 'INVALID_EVENT_STATUS' using errcode = '22023';
  end if;

  select * into current_event from public.experiences where id = p_experience_id for update;
  if not found or current_event.kind <> 'EVENT' then
    raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform public.admin_update_experience(
    p_actor_id, p_experience_id, p_title, p_summary, p_status, p_image_url, coalesce(p_display_order, current_event.display_order),
    current_event.description, current_event.duration_minutes, current_event.price_cents, current_event.default_capacity,
    coalesce(p_editorial_content, '{}'::jsonb), current_event.base_id
  );

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (
    p_actor_id, 'EVENT_UPDATED', 'experience', p_experience_id,
    jsonb_build_object('title', p_title, 'status', p_status, 'previousStatus', current_event.status)
  );

  return true;
end;
$$;

-- Nova edição a partir de uma anterior: conteúdo, base, preço, duração e
-- capacidade copiados; nova data; sempre rascunho com a sessão fechada. Nenhuma
-- reserva, inscrição ou pagamento é copiado.
create or replace function public.admin_duplicate_event(
  p_actor_id uuid,
  p_source_experience_id uuid,
  p_slug text,
  p_title text,
  p_starts_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  source_event public.experiences%rowtype;
  source_session public.sessions%rowtype;
  created jsonb;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  select * into source_event from public.experiences where id = p_source_experience_id;
  if not found or source_event.kind <> 'EVENT' then
    raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into source_session
  from public.sessions
  where experience_id = source_event.id and status <> 'ARCHIVED'
  order by starts_at desc
  limit 1;

  created := public.admin_create_event(
    p_actor_id,
    source_event.base_id,
    p_slug,
    p_title,
    source_event.summary,
    source_event.editorial_content,
    source_event.image_url,
    p_starts_at,
    coalesce(source_session.duration_minutes, source_event.duration_minutes),
    coalesce(source_session.price_cents, source_event.price_cents),
    coalesce(source_session.capacity, source_event.default_capacity)
  );

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (
    p_actor_id, 'EVENT_DUPLICATED', 'experience', (created->>'experienceId')::uuid,
    jsonb_build_object('sourceExperienceId', source_event.id, 'sourceSlug', source_event.slug, 'slug', p_slug)
  );

  return created;
end;
$$;

-- Lista do painel: um evento por linha, de qualquer status, com a sessão em
-- destaque (mesma régua da leitura pública) e os números dela.
create or replace function public.admin_list_events(p_actor_id uuid)
returns table (
  id uuid,
  slug text,
  title text,
  status text,
  base_id uuid,
  base_name text,
  display_order integer,
  sessions_count bigint,
  session_id uuid,
  starts_at timestamptz,
  session_status public.session_status,
  price_cents integer,
  capacity integer,
  confirmed_participants bigint,
  pending_participants bigint,
  remaining_spots integer,
  availability text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  return query
  select
    e.id, e.slug, e.title, e.status, b.id, b.name, e.display_order,
    (select count(*) from public.sessions s2 where s2.experience_id = e.id),
    hs.id, hs.starts_at, hs.status, hs.price_cents, hs.capacity,
    coalesce((select sum(r.quantity) from public.reservations r where r.session_id = hs.id and r.status = 'CONFIRMED'), 0)::bigint,
    coalesce((select sum(r.quantity) from public.reservations r where r.session_id = hs.id and r.status = 'PRE_RESERVED' and r.expires_at > now()), 0)::bigint,
    case when hs.id is not null then coalesce(public.available_spots(hs.id), 0) end,
    case when hs.id is not null then public.special_event_availability(hs.id) else 'NO_SESSION' end,
    e.created_at, e.updated_at
  from public.experiences e
  join public.bases b on b.id = e.base_id
  left join lateral (
    select s.id, s.starts_at, s.status, s.price_cents, s.capacity
    from public.sessions s
    where s.experience_id = e.id and s.status <> 'ARCHIVED'
    order by (s.starts_at > now() and s.status <> 'CANCELLED') desc,
             case when s.starts_at > now() then s.starts_at end asc,
             s.starts_at desc
    limit 1
  ) hs on true
  where e.kind = 'EVENT'
  order by (hs.starts_at > now()) desc nulls last,
           case when hs.starts_at > now() then hs.starts_at end asc,
           hs.starts_at desc,
           e.title;
end;
$$;

-- Relatório de um evento, separado dos números da agenda regular. Só
-- contagens e valores, nenhum dado pessoal. Receita confirmada soma CONFIRMED e
-- AWAITING_RESCHEDULE (paga, aguardando nova data), como no restante do painel.
create or replace function public.admin_event_report(p_actor_id uuid, p_experience_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  event_row record;
  sessions_report jsonb;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  select e.id, e.slug, e.title, e.status, b.name as base_name into event_row
  from public.experiences e join public.bases b on b.id = e.base_id
  where e.id = p_experience_id and e.kind = 'EVENT';
  if not found then
    raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(row_data order by (row_data->>'startsAt')::timestamptz), '[]'::jsonb) into sessions_report
  from (
    select jsonb_build_object(
      'sessionId', s.id,
      'startsAt', s.starts_at,
      'status', s.status,
      'availability', public.special_event_availability(s.id),
      'priceCents', s.price_cents,
      'capacity', s.capacity,
      'remainingSpots', coalesce(public.available_spots(s.id), 0),
      'confirmedReservations', count(r.id) filter (where r.status = 'CONFIRMED'),
      'confirmedParticipants', coalesce(sum(r.quantity) filter (where r.status = 'CONFIRMED'), 0),
      'pendingReservations', count(r.id) filter (where r.status = 'PRE_RESERVED' and r.expires_at > now()),
      'pendingParticipants', coalesce(sum(r.quantity) filter (where r.status = 'PRE_RESERVED' and r.expires_at > now()), 0),
      'awaitingRescheduleParticipants', coalesce(sum(r.quantity) filter (where r.status = 'AWAITING_RESCHEDULE'), 0),
      'cancelledReservations', count(r.id) filter (where r.status = 'CANCELLED'),
      'checkedInParticipants', coalesce(sum(r.checked_in_count) filter (where r.status = 'CONFIRMED'), 0),
      'confirmedRevenueCents', coalesce(sum(r.total_cents) filter (where r.status in ('CONFIRMED', 'AWAITING_RESCHEDULE')), 0),
      'pendingRevenueCents', coalesce(sum(r.total_cents) filter (where r.status = 'PRE_RESERVED' and r.expires_at > now()), 0)
    ) as row_data
    from public.sessions s
    left join public.reservations r on r.session_id = s.id
    where s.experience_id = event_row.id
    group by s.id
  ) per_session;

  return jsonb_build_object(
    'event', jsonb_build_object('id', event_row.id, 'slug', event_row.slug, 'title', event_row.title,
                                'status', event_row.status, 'baseName', event_row.base_name),
    'sessions', sessions_report,
    'totals', jsonb_build_object(
      'confirmedParticipants', (select coalesce(sum((x->>'confirmedParticipants')::bigint), 0) from jsonb_array_elements(sessions_report) x),
      'confirmedRevenueCents', (select coalesce(sum((x->>'confirmedRevenueCents')::bigint), 0) from jsonb_array_elements(sessions_report) x),
      'checkedInParticipants', (select coalesce(sum((x->>'checkedInParticipants')::bigint), 0) from jsonb_array_elements(sessions_report) x)
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Permissões
-- ---------------------------------------------------------------------------

revoke all on function public.special_event_availability(uuid) from public, anon, authenticated;
revoke all on function public.list_public_events() from public;
revoke all on function public.get_public_event(text) from public;
revoke all on function public.list_public_event_sessions(text) from public;
revoke all on function public.list_public_regular_experiences() from public;
revoke all on function public.list_public_regular_catalog() from public;
grant execute on function public.special_event_availability(uuid) to service_role;
grant execute on function public.list_public_events() to anon, authenticated, service_role;
grant execute on function public.get_public_event(text) to anon, authenticated, service_role;
grant execute on function public.list_public_event_sessions(text) to anon, authenticated, service_role;
grant execute on function public.list_public_regular_experiences() to anon, authenticated, service_role;
grant execute on function public.list_public_regular_catalog() to anon, authenticated, service_role;

revoke all on function public.admin_create_event(uuid, uuid, text, text, text, jsonb, text, timestamptz, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_update_event(uuid, uuid, text, text, text, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.admin_duplicate_event(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_list_events(uuid) from public, anon, authenticated;
revoke all on function public.admin_event_report(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_create_event(uuid, uuid, text, text, text, jsonb, text, timestamptz, integer, integer, integer) to service_role;
grant execute on function public.admin_update_event(uuid, uuid, text, text, text, text, integer, jsonb) to service_role;
grant execute on function public.admin_duplicate_event(uuid, uuid, text, text, timestamptz) to service_role;
grant execute on function public.admin_list_events(uuid) to service_role;
grant execute on function public.admin_event_report(uuid, uuid) to service_role;
