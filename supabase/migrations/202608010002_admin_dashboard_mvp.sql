alter table public.sessions
  add column if not exists internal_notes text;

alter table public.experiences
  add column if not exists image_url text,
  add column if not exists display_order integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sessions_internal_notes_length'
  ) then
    alter table public.sessions
      add constraint sessions_internal_notes_length
      check (internal_notes is null or char_length(internal_notes) <= 1000);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'experiences_image_url_length'
  ) then
    alter table public.experiences
      add constraint experiences_image_url_length
      check (image_url is null or char_length(image_url) <= 500);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'experiences_display_order_nonnegative'
  ) then
    alter table public.experiences
      add constraint experiences_display_order_nonnegative
      check (display_order >= 0);
  end if;
end;
$$;

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role text not null default 'ADMIN' check (role in ('ADMIN', 'OPERATOR')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.platform_settings (
  singleton boolean primary key default true check (singleton),
  company_name text not null default 'Alma Azul Academy',
  whatsapp text,
  email text,
  pix_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists experiences_display_order_idx
  on public.experiences (display_order, title);
create index if not exists admin_audit_log_entity_idx
  on public.admin_audit_log (entity_type, entity_id, created_at desc);
create index if not exists admin_audit_log_actor_idx
  on public.admin_audit_log (actor_user_id, created_at desc);

drop trigger if exists admin_users_set_updated_at on public.admin_users;
create trigger admin_users_set_updated_at
  before update on public.admin_users
  for each row execute function public.set_updated_at();

drop trigger if exists platform_settings_set_updated_at on public.platform_settings;
create trigger platform_settings_set_updated_at
  before update on public.platform_settings
  for each row execute function public.set_updated_at();

create or replace function public.is_active_admin(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_users
    where user_id = p_user_id and is_active
  );
$$;

create or replace function public.admin_dashboard_metrics(p_actor_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'nextSession', (
      select jsonb_build_object(
        'id', s.id,
        'experienceTitle', e.title,
        'startsAt', s.starts_at,
        'remainingSpots', public.available_spots(s.id)
      )
      from public.sessions s
      join public.experiences e on e.id = s.experience_id
      where s.starts_at > now() and s.status <> 'CANCELLED'
      order by s.starts_at
      limit 1
    ),
    'futureSessions', (
      select count(*) from public.sessions
      where starts_at > now() and status <> 'CANCELLED'
    ),
    'confirmedReservations', (
      select count(*) from public.reservations where status = 'CONFIRMED'
    ),
    'preReservations', (
      select count(*) from public.reservations
      where status = 'PRE_RESERVED' and expires_at > now()
    ),
    'expectedRevenueCents', (
      select coalesce(sum(total_cents), 0) from public.reservations
      where status = 'CONFIRMED'
         or (status = 'PRE_RESERVED' and expires_at > now())
    ),
    'confirmedRevenueCents', (
      select coalesce(sum(total_cents), 0) from public.reservations
      where status = 'CONFIRMED'
    ),
    'totalParticipants', (
      select coalesce(sum(quantity), 0) from public.reservations
      where status = 'CONFIRMED'
    ),
    'lastUpdatedAt', greatest(
      coalesce((select max(updated_at) from public.experiences), '-infinity'::timestamptz),
      coalesce((select max(updated_at) from public.sessions), '-infinity'::timestamptz),
      coalesce((select max(updated_at) from public.reservations), '-infinity'::timestamptz)
    )
  ) into result;

  return result;
end;
$$;

create or replace function public.admin_list_experiences(p_actor_id uuid)
returns table (
  id uuid,
  slug text,
  title text,
  summary text,
  status text,
  image_url text,
  display_order integer,
  sessions_count bigint,
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
    e.id,
    e.slug,
    e.title,
    e.summary,
    e.status,
    e.image_url,
    e.display_order,
    count(s.id),
    e.created_at,
    e.updated_at
  from public.experiences e
  left join public.sessions s on s.experience_id = e.id
  group by e.id
  order by e.display_order, e.title;
end;
$$;

create or replace function public.admin_list_sessions(p_actor_id uuid)
returns table (
  id uuid,
  experience_id uuid,
  experience_title text,
  starts_at timestamptz,
  duration_minutes integer,
  price_cents integer,
  capacity integer,
  remaining_spots integer,
  reservations_count bigint,
  status public.session_status,
  internal_notes text,
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
    s.id,
    s.experience_id,
    e.title,
    s.starts_at,
    s.duration_minutes,
    s.price_cents,
    s.capacity,
    public.available_spots(s.id),
    count(r.id),
    s.status,
    s.internal_notes,
    s.created_at,
    s.updated_at
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  left join public.reservations r on r.session_id = s.id
  group by s.id, e.title
  order by s.starts_at desc;
end;
$$;

create or replace function public.admin_create_session(
  p_actor_id uuid,
  p_experience_id uuid,
  p_starts_at timestamptz,
  p_duration_minutes integer,
  p_price_cents integer,
  p_capacity integer,
  p_status public.session_status,
  p_internal_notes text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  created_id uuid;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if p_starts_at <= now() then
    raise exception 'SESSION_MUST_BE_FUTURE' using errcode = '22023';
  end if;
  if p_duration_minutes < 15 or p_duration_minutes > 1440
     or p_price_cents < 0
     or p_capacity < 1 then
    raise exception 'INVALID_SESSION_DATA' using errcode = '22023';
  end if;
  if not exists (select 1 from public.experiences where id = p_experience_id) then
    raise exception 'EXPERIENCE_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.sessions (
    experience_id, starts_at, duration_minutes, price_cents, capacity, status, internal_notes
  ) values (
    p_experience_id, p_starts_at, p_duration_minutes, p_price_cents, p_capacity,
    p_status, nullif(trim(p_internal_notes), '')
  ) returning id into created_id;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (
    p_actor_id,
    'SESSION_CREATED',
    'SESSION',
    created_id,
    jsonb_build_object('starts_at', p_starts_at, 'capacity', p_capacity, 'status', p_status)
  );

  return created_id;
end;
$$;

create or replace function public.admin_update_session(
  p_actor_id uuid,
  p_session_id uuid,
  p_experience_id uuid,
  p_starts_at timestamptz,
  p_duration_minutes integer,
  p_price_cents integer,
  p_capacity integer,
  p_status public.session_status,
  p_internal_notes text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.sessions%rowtype;
  occupied integer;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if p_duration_minutes < 15 or p_duration_minutes > 1440
     or p_price_cents < 0
     or p_capacity < 1 then
    raise exception 'INVALID_SESSION_DATA' using errcode = '22023';
  end if;

  select * into target from public.sessions where id = p_session_id for update;
  if not found then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.experiences where id = p_experience_id) then
    raise exception 'EXPERIENCE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if target.experience_id <> p_experience_id
     and exists (select 1 from public.reservations where session_id = p_session_id) then
    raise exception 'SESSION_EXPERIENCE_LOCKED' using errcode = '23514';
  end if;

  update public.reservations
  set status = 'EXPIRED', updated_at = now()
  where session_id = p_session_id and status = 'PRE_RESERVED' and expires_at <= now();

  select coalesce(sum(quantity), 0)::integer into occupied
  from public.reservations
  where session_id = p_session_id
    and (status = 'CONFIRMED' or (status = 'PRE_RESERVED' and expires_at > now()));

  if p_capacity < occupied then
    raise exception 'CAPACITY_BELOW_OCCUPANCY' using errcode = '23514';
  end if;

  update public.sessions
  set experience_id = p_experience_id,
      starts_at = p_starts_at,
      duration_minutes = p_duration_minutes,
      price_cents = p_price_cents,
      capacity = p_capacity,
      status = p_status,
      internal_notes = nullif(trim(p_internal_notes), '')
  where id = p_session_id;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (
    p_actor_id,
    'SESSION_UPDATED',
    'SESSION',
    p_session_id,
    jsonb_build_object('starts_at', p_starts_at, 'capacity', p_capacity, 'status', p_status)
  );

  return true;
end;
$$;

create or replace function public.admin_delete_session(
  p_actor_id uuid,
  p_session_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.sessions%rowtype;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  select * into target from public.sessions where id = p_session_id for update;
  if not found then return false; end if;
  if exists (select 1 from public.reservations where session_id = p_session_id) then
    raise exception 'SESSION_HAS_RESERVATIONS' using errcode = '23503';
  end if;

  delete from public.sessions where id = p_session_id;
  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (
    p_actor_id,
    'SESSION_DELETED',
    'SESSION',
    p_session_id,
    jsonb_build_object('starts_at', target.starts_at, 'capacity', target.capacity)
  );
  return true;
end;
$$;

create or replace function public.admin_create_experience(
  p_actor_id uuid,
  p_slug text,
  p_title text,
  p_summary text,
  p_status text,
  p_image_url text,
  p_display_order integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  created_id uuid;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
     or char_length(trim(p_title)) < 3
     or char_length(trim(p_summary)) < 10
     or p_status not in ('DRAFT', 'PUBLISHED', 'ARCHIVED')
     or p_display_order < 0 then
    raise exception 'INVALID_EXPERIENCE_DATA' using errcode = '22023';
  end if;

  insert into public.experiences (slug, title, summary, status, image_url, display_order)
  values (
    p_slug,
    trim(p_title),
    trim(p_summary),
    p_status,
    nullif(trim(p_image_url), ''),
    p_display_order
  ) returning id into created_id;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (p_actor_id, 'EXPERIENCE_CREATED', 'EXPERIENCE', created_id, jsonb_build_object('slug', p_slug));
  return created_id;
end;
$$;

create or replace function public.admin_update_experience(
  p_actor_id uuid,
  p_experience_id uuid,
  p_title text,
  p_summary text,
  p_status text,
  p_image_url text,
  p_display_order integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if char_length(trim(p_title)) < 3
     or char_length(trim(p_summary)) < 10
     or p_status not in ('DRAFT', 'PUBLISHED', 'ARCHIVED')
     or p_display_order < 0 then
    raise exception 'INVALID_EXPERIENCE_DATA' using errcode = '22023';
  end if;

  update public.experiences
  set title = trim(p_title),
      summary = trim(p_summary),
      status = p_status,
      image_url = nullif(trim(p_image_url), ''),
      display_order = p_display_order
  where id = p_experience_id;
  if not found then return false; end if;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (
    p_actor_id,
    'EXPERIENCE_UPDATED',
    'EXPERIENCE',
    p_experience_id,
    jsonb_build_object('status', p_status, 'display_order', p_display_order)
  );
  return true;
end;
$$;

create or replace function public.admin_list_reservations(
  p_actor_id uuid,
  p_date date,
  p_experience_id uuid,
  p_status public.reservation_status,
  p_name text,
  p_phone text,
  p_cpf text,
  p_session_id uuid
)
returns table (
  id uuid,
  public_code text,
  reservation_status public.reservation_status,
  full_name text,
  cpf_last4 char(4),
  phone text,
  email text,
  quantity integer,
  total_cents integer,
  notes text,
  expires_at timestamptz,
  payment_provider text,
  provider_reference text,
  payment_status text,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  session_id uuid,
  starts_at timestamptz,
  experience_id uuid,
  experience_title text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  normalized_phone text := regexp_replace(coalesce(p_phone, ''), E'\\D', '', 'g');
  normalized_cpf text := regexp_replace(coalesce(p_cpf, ''), E'\\D', '', 'g');
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  perform public.expire_pre_reservations();

  return query
  select
    r.id,
    r.public_code,
    r.status,
    r.full_name,
    r.cpf_last4,
    r.phone,
    r.email,
    r.quantity,
    r.total_cents,
    r.notes,
    r.expires_at,
    r.payment_provider,
    r.provider_reference,
    case
      when exists (
        select 1 from public.payment_events pe
        where pe.reservation_id = r.id
          and pe.event_type in ('PAYMENT_CONFIRMED', 'PAYMENT_CONFIRMED_MANUAL')
      ) then 'PAID'
      when exists (
        select 1 from public.payment_events pe
        where pe.reservation_id = r.id and pe.event_type = 'PAYMENT_AFTER_EXPIRATION'
      ) then 'PAID_AFTER_EXPIRATION'
      when r.status = 'PRE_RESERVED' and r.expires_at > now() then 'PENDING'
      else 'NOT_PAID'
    end,
    r.confirmed_at,
    r.cancelled_at,
    r.created_at,
    r.updated_at,
    s.id,
    s.starts_at,
    e.id,
    e.title
  from public.reservations r
  join public.sessions s on s.id = r.session_id
  join public.experiences e on e.id = r.experience_id
  where (p_date is null or (s.starts_at at time zone 'America/Sao_Paulo')::date = p_date)
    and (p_experience_id is null or e.id = p_experience_id)
    and (p_status is null or r.status = p_status)
    and (nullif(trim(p_name), '') is null or r.full_name ilike '%' || trim(p_name) || '%')
    and (
      normalized_phone = ''
      or regexp_replace(r.phone, E'\\D', '', 'g') like '%' || normalized_phone || '%'
    )
    and (
      normalized_cpf = ''
      or (char_length(normalized_cpf) = 11 and r.cpf_hash = encode(digest(normalized_cpf, 'sha256'), 'hex'))
      or (char_length(normalized_cpf) <= 4 and r.cpf_last4 = right(normalized_cpf, 4))
    )
    and (p_session_id is null or s.id = p_session_id)
  order by s.starts_at desc, r.created_at desc
  limit 500;
end;
$$;

create or replace function public.admin_get_reservation(
  p_actor_id uuid,
  p_reservation_id uuid
)
returns table (
  id uuid,
  public_code text,
  reservation_status public.reservation_status,
  full_name text,
  cpf_last4 char(4),
  phone text,
  email text,
  quantity integer,
  unit_price_cents integer,
  total_cents integer,
  notes text,
  expires_at timestamptz,
  payment_provider text,
  provider_reference text,
  checkout_url text,
  payment_status text,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  session_id uuid,
  starts_at timestamptz,
  duration_minutes integer,
  experience_id uuid,
  experience_title text
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
    r.id,
    r.public_code,
    r.status,
    r.full_name,
    r.cpf_last4,
    r.phone,
    r.email,
    r.quantity,
    r.unit_price_cents,
    r.total_cents,
    r.notes,
    r.expires_at,
    r.payment_provider,
    r.provider_reference,
    r.checkout_url,
    case
      when exists (
        select 1 from public.payment_events pe
        where pe.reservation_id = r.id
          and pe.event_type in ('PAYMENT_CONFIRMED', 'PAYMENT_CONFIRMED_MANUAL')
      ) then 'PAID'
      when exists (
        select 1 from public.payment_events pe
        where pe.reservation_id = r.id and pe.event_type = 'PAYMENT_AFTER_EXPIRATION'
      ) then 'PAID_AFTER_EXPIRATION'
      when r.status = 'PRE_RESERVED' and r.expires_at > now() then 'PENDING'
      else 'NOT_PAID'
    end,
    r.confirmed_at,
    r.cancelled_at,
    r.created_at,
    r.updated_at,
    s.id,
    s.starts_at,
    s.duration_minutes,
    e.id,
    e.title
  from public.reservations r
  join public.sessions s on s.id = r.session_id
  join public.experiences e on e.id = r.experience_id
  where r.id = p_reservation_id;
end;
$$;

create or replace function public.admin_confirm_reservation(
  p_actor_id uuid,
  p_reservation_id uuid,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.reservations%rowtype;
  target_session public.sessions%rowtype;
  occupied integer;
  manual_event_id text;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if char_length(trim(p_reason)) < 3 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;

  select * into target from public.reservations where id = p_reservation_id for update;
  if not found then return false; end if;
  if target.status = 'CONFIRMED' then return true; end if;
  if target.status = 'CANCELLED' then
    raise exception 'CANCELLED_RESERVATION' using errcode = 'P0001';
  end if;

  select * into target_session from public.sessions where id = target.session_id for update;
  if target_session.status = 'CANCELLED' then
    raise exception 'SESSION_CANCELLED' using errcode = 'P0001';
  end if;

  update public.reservations
  set status = 'EXPIRED', updated_at = now()
  where session_id = target.session_id
    and id <> target.id
    and status = 'PRE_RESERVED'
    and expires_at <= now();

  select coalesce(sum(quantity), 0)::integer into occupied
  from public.reservations
  where session_id = target.session_id
    and id <> target.id
    and (status = 'CONFIRMED' or (status = 'PRE_RESERVED' and expires_at > now()));

  if occupied + target.quantity > target_session.capacity then
    raise exception 'INSUFFICIENT_SPOTS' using errcode = 'P0001';
  end if;

  manual_event_id := 'manual-' || gen_random_uuid()::text;
  insert into public.payment_events (
    reservation_id, provider, provider_event_id, event_type, amount_cents, payload
  ) values (
    target.id,
    'MANUAL',
    manual_event_id,
    'PAYMENT_CONFIRMED_MANUAL',
    target.total_cents,
    jsonb_build_object('actor_user_id', p_actor_id, 'reason', trim(p_reason))
  );

  update public.reservations
  set status = 'CONFIRMED',
      confirmed_at = now(),
      cancelled_at = null,
      payment_provider = coalesce(payment_provider, 'MANUAL'),
      provider_reference = coalesce(provider_reference, manual_event_id),
      updated_at = now()
  where id = target.id;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, reason)
  values (p_actor_id, 'RESERVATION_MANUALLY_CONFIRMED', 'RESERVATION', target.id, trim(p_reason));
  return true;
end;
$$;

create or replace function public.admin_cancel_reservation(
  p_actor_id uuid,
  p_reservation_id uuid,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.reservations%rowtype;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if char_length(trim(p_reason)) < 3 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;

  select * into target from public.reservations where id = p_reservation_id for update;
  if not found then return false; end if;
  if target.status = 'CANCELLED' then return true; end if;

  update public.reservations
  set status = 'CANCELLED', cancelled_at = now(), updated_at = now()
  where id = target.id;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, reason, metadata)
  values (
    p_actor_id,
    'RESERVATION_CANCELLED',
    'RESERVATION',
    target.id,
    trim(p_reason),
    jsonb_build_object('previous_status', target.status)
  );
  return true;
end;
$$;

alter table public.admin_users enable row level security;
alter table public.admin_audit_log enable row level security;
alter table public.platform_settings enable row level security;

drop policy if exists "admins read own membership" on public.admin_users;
create policy "admins read own membership"
  on public.admin_users
  for select
  to authenticated
  using (user_id = auth.uid() and is_active);

revoke all on public.admin_users from anon, authenticated;
revoke all on public.admin_audit_log from anon, authenticated;
revoke all on public.platform_settings from anon, authenticated;
grant select (user_id, display_name, role, is_active) on public.admin_users to authenticated;

revoke all on function public.is_active_admin(uuid) from public, anon, authenticated;
revoke all on function public.admin_dashboard_metrics(uuid) from public, anon, authenticated;
revoke all on function public.admin_list_experiences(uuid) from public, anon, authenticated;
revoke all on function public.admin_list_sessions(uuid) from public, anon, authenticated;
revoke all on function public.admin_create_session(uuid, uuid, timestamptz, integer, integer, integer, public.session_status, text) from public, anon, authenticated;
revoke all on function public.admin_update_session(uuid, uuid, uuid, timestamptz, integer, integer, integer, public.session_status, text) from public, anon, authenticated;
revoke all on function public.admin_delete_session(uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_create_experience(uuid, text, text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.admin_update_experience(uuid, uuid, text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.admin_list_reservations(uuid, date, uuid, public.reservation_status, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.admin_get_reservation(uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_confirm_reservation(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_cancel_reservation(uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.is_active_admin(uuid) to service_role;
grant execute on function public.admin_dashboard_metrics(uuid) to service_role;
grant execute on function public.admin_list_experiences(uuid) to service_role;
grant execute on function public.admin_list_sessions(uuid) to service_role;
grant execute on function public.admin_create_session(uuid, uuid, timestamptz, integer, integer, integer, public.session_status, text) to service_role;
grant execute on function public.admin_update_session(uuid, uuid, uuid, timestamptz, integer, integer, integer, public.session_status, text) to service_role;
grant execute on function public.admin_delete_session(uuid, uuid) to service_role;
grant execute on function public.admin_create_experience(uuid, text, text, text, text, text, integer) to service_role;
grant execute on function public.admin_update_experience(uuid, uuid, text, text, text, text, integer) to service_role;
grant execute on function public.admin_list_reservations(uuid, date, uuid, public.reservation_status, text, text, text, uuid) to service_role;
grant execute on function public.admin_get_reservation(uuid, uuid) to service_role;
grant execute on function public.admin_confirm_reservation(uuid, uuid, text) to service_role;
grant execute on function public.admin_cancel_reservation(uuid, uuid, text) to service_role;

insert into public.platform_settings (singleton, company_name)
values (true, 'Alma Azul Academy')
on conflict (singleton) do nothing;

update public.experiences
set image_url = '/images/experiences/imersao-paranoa/grupos/img-3964.webp',
    display_order = 0
where slug = 'imersao-paranoa' and image_url is null;
