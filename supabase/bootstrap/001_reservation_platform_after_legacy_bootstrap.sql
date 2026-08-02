-- OPERATIONAL COPY OF MIGRATION 001 FOR THE REVIEWED LEGACY DATABASE ONLY.
-- Run only after supabase/bootstrap/legacy_schema_compatibility.sql and preflight validation.
-- Do not use for clean databases or replace the historical 001 migration.
-- Existence guards, CREATE OR REPLACE, controlled trigger/policy replacement and
-- idempotent privileges tolerate a failed/partial attempt. The seed preserves the
-- existing UUID/editorial fields; the cron block refuses duplicates/conflicts.
--
-- READ-ONLY PARTIAL-STATE INVENTORY TO RUN AND SAVE BEFORE THIS FILE:
-- select extname,extversion from pg_extension where extname in ('pgcrypto','pg_cron');
-- select t.typname,e.enumlabel,e.enumsortorder from pg_type t join pg_enum e on e.enumtypid=t.oid join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typname in ('reservation_status','session_status') order by t.typname,e.enumsortorder;
-- select table_name,column_name,data_type,udt_name,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name in ('experiences','sessions','reservations','payment_events') order by table_name,ordinal_position;
-- select c.relname table_name,i.relname index_name,pg_get_indexdef(i.oid) from pg_index x join pg_class c on c.oid=x.indrelid join pg_class i on i.oid=x.indexrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('experiences','sessions','reservations','payment_events') order by 1,2;
-- select event_object_table,trigger_name,action_timing,event_manipulation,action_statement from information_schema.triggers where trigger_schema='public' order by 1,2;
-- select p.oid::regprocedure,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by 1::text;
-- select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname;
-- select grantee,table_name,privilege_type from information_schema.role_table_grants where table_schema='public' and table_name in ('experiences','sessions','reservations','payment_events') order by table_name,grantee,privilege_type;
-- select grantee,routine_name,privilege_type from information_schema.role_routine_grants where routine_schema='public' order by routine_name,grantee;
-- select jobid,jobname,schedule,command,database,username,active from cron.job where jobname='expire-alma-azul-pre-reservations' order by jobid;
-- select 'experiences' object,count(*) total from public.experiences union all select 'sessions',count(*) from public.sessions union all select 'reservations',count(*) from public.reservations;
-- select id,slug,title,eyebrow,short_description,active,summary,status from public.experiences where slug='imersao-paranoa';
-- select id,experience_id,starts_at,status from public.sessions order by id;

begin;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron;

do $$ begin
  create type public.reservation_status as enum ('PRE_RESERVED', 'CONFIRMED', 'EXPIRED', 'CANCELLED');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.session_status as enum ('OPEN', 'CLOSED', 'CANCELLED');
exception when duplicate_object then null;
end $$;

create table if not exists public.experiences (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  summary text not null,
  status text not null default 'PUBLISHED' check (status in ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  experience_id uuid not null references public.experiences(id) on delete restrict,
  starts_at timestamptz not null,
  duration_minutes integer not null check (duration_minutes > 0),
  price_cents integer not null check (price_cents >= 0),
  capacity integer not null check (capacity > 0),
  status public.session_status not null default 'OPEN',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.sessions add column if not exists experience_id uuid references public.experiences(id) on delete restrict;
alter table public.sessions add column if not exists starts_at timestamptz;
alter table public.sessions add column if not exists duration_minutes integer;
alter table public.sessions add column if not exists price_cents integer;
alter table public.sessions add column if not exists capacity integer;
alter table public.sessions add column if not exists status public.session_status default 'OPEN';
alter table public.sessions add column if not exists created_at timestamptz not null default now();
alter table public.sessions add column if not exists updated_at timestamptz not null default now();

create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  public_code text not null unique,
  idempotency_key uuid not null unique,
  experience_id uuid not null references public.experiences(id) on delete restrict,
  session_id uuid not null references public.sessions(id) on delete restrict,
  status public.reservation_status not null default 'PRE_RESERVED',
  full_name text not null,
  cpf_hash text not null,
  cpf_last4 char(4) not null,
  phone text not null,
  email text not null,
  quantity integer not null check (quantity > 0 and quantity <= 20),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  total_cents integer generated always as (quantity * unit_price_cents) stored,
  notes text check (char_length(notes) <= 500),
  expires_at timestamptz not null,
  payment_provider text,
  provider_reference text,
  checkout_url text,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reservation_expiry_after_creation check (expires_at > created_at)
);

create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete restrict,
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  amount_cents integer not null check (amount_cents >= 0),
  payload jsonb not null,
  processed_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

create index if not exists sessions_experience_starts_at_idx on public.sessions (experience_id, starts_at) where status = 'OPEN';
create index if not exists reservations_session_occupancy_idx on public.reservations (session_id, status, expires_at);
create index if not exists reservations_lookup_idx on public.reservations (public_code, cpf_hash);
create index if not exists reservations_expiration_idx on public.reservations (expires_at) where status = 'PRE_RESERVED';

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists experiences_set_updated_at on public.experiences;
create trigger experiences_set_updated_at before update on public.experiences for each row execute function public.set_updated_at();
drop trigger if exists sessions_set_updated_at on public.sessions;
create trigger sessions_set_updated_at before update on public.sessions for each row execute function public.set_updated_at();
drop trigger if exists reservations_set_updated_at on public.reservations;
create trigger reservations_set_updated_at before update on public.reservations for each row execute function public.set_updated_at();

create or replace function public.expire_pre_reservations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  update public.reservations
  set status = 'EXPIRED', updated_at = now()
  where status = 'PRE_RESERVED' and expires_at <= now();
  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.available_spots(p_session_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select greatest(
    0,
    s.capacity - coalesce(sum(r.quantity) filter (
      where r.status = 'CONFIRMED'
         or (r.status = 'PRE_RESERVED' and r.expires_at > now())
    ), 0)::integer
  )
  from public.sessions s
  left join public.reservations r on r.session_id = s.id
  where s.id = p_session_id
  group by s.capacity;
$$;

create or replace function public.list_open_sessions(p_experience_slug text)
returns table (
  id uuid,
  experience_id uuid,
  experience_slug text,
  experience_title text,
  experience_summary text,
  starts_at timestamptz,
  duration_minutes integer,
  price_cents integer,
  remaining_spots integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.id,
    e.id,
    e.slug,
    e.title,
    e.summary,
    s.starts_at,
    s.duration_minutes,
    s.price_cents,
    public.available_spots(s.id)
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  where e.slug = p_experience_slug
    and e.status = 'PUBLISHED'
    and s.status = 'OPEN'
    and s.starts_at > now()
    and public.available_spots(s.id) > 0
  order by s.starts_at;
$$;

create or replace function public.get_booking_session(p_session_id uuid)
returns table (
  id uuid,
  experience_id uuid,
  experience_slug text,
  experience_title text,
  experience_summary text,
  starts_at timestamptz,
  duration_minutes integer,
  price_cents integer,
  remaining_spots integer
)
language sql
stable
security definer
set search_path = public
as $$
  select * from public.list_open_sessions((
    select e.slug from public.sessions s join public.experiences e on e.id = s.experience_id where s.id = p_session_id
  )) where id = p_session_id;
$$;

create or replace function public.create_pre_reservation(
  p_session_id uuid,
  p_full_name text,
  p_cpf text,
  p_phone text,
  p_email text,
  p_quantity integer,
  p_notes text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  target_session public.sessions%rowtype;
  target_experience public.experiences%rowtype;
  existing_reservation public.reservations%rowtype;
  created_reservation public.reservations%rowtype;
  normalized_cpf text := regexp_replace(p_cpf, E'\\D', '', 'g');
  occupied integer;
begin
  if p_quantity < 1 or p_quantity > 20 then raise exception 'INVALID_QUANTITY' using errcode = '22023'; end if;
  if char_length(trim(p_full_name)) < 5 then raise exception 'INVALID_NAME' using errcode = '22023'; end if;
  if normalized_cpf !~ '^\d{11}$' then raise exception 'INVALID_CPF' using errcode = '22023'; end if;

  select * into existing_reservation from public.reservations where idempotency_key = p_idempotency_key;
  if found then
    if existing_reservation.cpf_hash <> encode(digest(normalized_cpf, 'sha256'), 'hex') then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'reservationId', existing_reservation.id,
      'publicCode', existing_reservation.public_code,
      'expiresAt', existing_reservation.expires_at,
      'quantity', existing_reservation.quantity,
      'totalCents', existing_reservation.total_cents
    );
  end if;

  select * into target_session from public.sessions where id = p_session_id for update;
  if not found or target_session.status <> 'OPEN' or target_session.starts_at <= now() then
    raise exception 'SESSION_UNAVAILABLE' using errcode = 'P0001';
  end if;
  select * into target_experience from public.experiences where id = target_session.experience_id and status = 'PUBLISHED';
  if not found then raise exception 'EXPERIENCE_UNAVAILABLE' using errcode = 'P0001'; end if;

  update public.reservations set status = 'EXPIRED', updated_at = now()
  where session_id = p_session_id and status = 'PRE_RESERVED' and expires_at <= now();

  select coalesce(sum(quantity), 0)::integer into occupied
  from public.reservations
  where session_id = p_session_id
    and (status = 'CONFIRMED' or (status = 'PRE_RESERVED' and expires_at > now()));

  if occupied + p_quantity > target_session.capacity then
    raise exception 'INSUFFICIENT_SPOTS' using errcode = 'P0001';
  end if;

  insert into public.reservations (
    public_code, idempotency_key, experience_id, session_id, full_name, cpf_hash, cpf_last4,
    phone, email, quantity, unit_price_cents, notes, expires_at
  ) values (
    upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
    p_idempotency_key,
    target_experience.id,
    target_session.id,
    trim(p_full_name),
    encode(digest(normalized_cpf, 'sha256'), 'hex'),
    right(normalized_cpf, 4),
    p_phone,
    lower(trim(p_email)),
    p_quantity,
    target_session.price_cents,
    nullif(trim(p_notes), ''),
    now() + interval '2 hours'
  ) returning * into created_reservation;

  return jsonb_build_object(
    'reservationId', created_reservation.id,
    'publicCode', created_reservation.public_code,
    'expiresAt', created_reservation.expires_at,
    'quantity', created_reservation.quantity,
    'totalCents', created_reservation.total_cents,
    'experienceTitle', target_experience.title
  );
end;
$$;

create or replace function public.attach_payment_checkout(
  p_reservation_id uuid,
  p_provider text,
  p_provider_reference text,
  p_checkout_url text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.reservations
  set payment_provider = p_provider,
      provider_reference = p_provider_reference,
      checkout_url = p_checkout_url,
      updated_at = now()
  where id = p_reservation_id and status = 'PRE_RESERVED' and expires_at > now();
  return found;
end;
$$;

create or replace function public.cancel_pre_reservation(p_reservation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.reservations
  set status = 'CANCELLED', cancelled_at = now(), updated_at = now()
  where id = p_reservation_id and status = 'PRE_RESERVED';
  return found;
end;
$$;

create or replace function public.lookup_reservation(p_cpf text, p_public_code text)
returns table (
  reservation_id uuid,
  public_code text,
  reservation_status public.reservation_status,
  expires_at timestamptz,
  quantity integer,
  total_cents integer,
  checkout_url text,
  full_name text,
  session_id uuid,
  experience_id uuid,
  experience_slug text,
  experience_title text,
  experience_summary text,
  starts_at timestamptz,
  duration_minutes integer,
  price_cents integer,
  remaining_spots integer
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare normalized_cpf text := regexp_replace(p_cpf, E'\\D', '', 'g');
begin
  perform public.expire_pre_reservations();
  return query
  select
    r.id, r.public_code, r.status, r.expires_at, r.quantity, r.total_cents,
    case when r.status = 'PRE_RESERVED' and r.expires_at > now() then r.checkout_url else null end,
    r.full_name, s.id, e.id, e.slug, e.title, e.summary, s.starts_at, s.duration_minutes,
    s.price_cents, public.available_spots(s.id)
  from public.reservations r
  join public.sessions s on s.id = r.session_id
  join public.experiences e on e.id = r.experience_id
  where r.public_code = upper(trim(p_public_code))
    and r.cpf_hash = encode(digest(normalized_cpf, 'sha256'), 'hex')
  limit 1;
end;
$$;

create or replace function public.confirm_reservation_payment(
  p_reservation_id uuid,
  p_provider text,
  p_provider_event_id text,
  p_amount_cents integer,
  p_receipt_url text,
  p_payload jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare target public.reservations%rowtype;
begin
  select * into target from public.reservations where id = p_reservation_id for update;
  if not found then return false; end if;
  if target.status = 'CONFIRMED' then return true; end if;
  if target.status <> 'PRE_RESERVED' or target.expires_at <= now() then
    insert into public.payment_events (
      reservation_id, provider, provider_event_id, event_type, amount_cents, payload
    ) values (
      target.id, p_provider, p_provider_event_id, 'PAYMENT_AFTER_EXPIRATION', p_amount_cents,
      p_payload || jsonb_build_object('receipt_url', p_receipt_url)
    ) on conflict (provider, provider_event_id) do nothing;
    update public.reservations set status = 'EXPIRED', updated_at = now()
    where id = target.id and status = 'PRE_RESERVED';
    return false;
  end if;
  if target.total_cents <> p_amount_cents then return false; end if;

  insert into public.payment_events (
    reservation_id, provider, provider_event_id, event_type, amount_cents, payload
  ) values (
    target.id, p_provider, p_provider_event_id, 'PAYMENT_CONFIRMED', p_amount_cents,
    p_payload || jsonb_build_object('receipt_url', p_receipt_url)
  ) on conflict (provider, provider_event_id) do nothing;

  update public.reservations
  set status = 'CONFIRMED', confirmed_at = now(), provider_reference = p_provider_event_id, updated_at = now()
  where id = target.id;
  return true;
end;
$$;

alter table public.experiences enable row level security;
alter table public.sessions enable row level security;
alter table public.reservations enable row level security;
alter table public.payment_events enable row level security;

drop policy if exists "published experiences are readable" on public.experiences;
create policy "published experiences are readable" on public.experiences for select to anon, authenticated using (status = 'PUBLISHED');
drop policy if exists "open future sessions are readable" on public.sessions;
create policy "open future sessions are readable" on public.sessions for select to anon, authenticated using (status = 'OPEN' and starts_at > now());

revoke all on public.reservations from anon, authenticated;
revoke all on public.payment_events from anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.expire_pre_reservations() from public, anon, authenticated;
revoke all on function public.available_spots(uuid) from public, anon, authenticated;
revoke all on function public.create_pre_reservation(uuid, text, text, text, text, integer, text, uuid) from public, anon, authenticated;
revoke all on function public.attach_payment_checkout(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.cancel_pre_reservation(uuid) from public, anon, authenticated;
revoke all on function public.lookup_reservation(text, text) from public, anon, authenticated;
revoke all on function public.confirm_reservation_payment(uuid, text, text, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_pre_reservation(uuid, text, text, text, text, integer, text, uuid) to service_role;
grant execute on function public.attach_payment_checkout(uuid, text, text, text) to service_role;
grant execute on function public.cancel_pre_reservation(uuid) to service_role;
grant execute on function public.lookup_reservation(text, text) to service_role;
grant execute on function public.confirm_reservation_payment(uuid, text, text, integer, text, jsonb) to service_role;
grant execute on function public.expire_pre_reservations() to service_role;
grant execute on function public.available_spots(uuid) to anon, authenticated, service_role;
grant execute on function public.list_open_sessions(text) to anon, authenticated, service_role;
grant execute on function public.get_booking_session(uuid) to anon, authenticated, service_role;

-- Preserve the existing experience UUID and every legacy editorial column.
update public.experiences
set title = 'Imersão Paranoá',
    summary = 'Uma experiência de 1h30 pelo lado mais preservado do Lago Paranoá.',
    status = 'PUBLISHED',
    updated_at = now()
where slug = 'imersao-paranoa';

-- This branch is only for an unexpectedly missing legacy record. It supplies every
-- NOT NULL legacy editorial column reported for this database as well as the
-- canonical Sprint 3 columns. Existing records never enter this branch.
insert into public.experiences (
  slug, title, eyebrow, short_description, description, duration_minutes,
  location, cover_image, gallery, included, active, summary, status,
  created_at, updated_at
)
select
  'imersao-paranoa', 'Imersão Paranoá', 'Experiência assinatura',
  'Uma experiência de 1h30 pelo lado mais preservado do Lago Paranoá.',
  'Uma experiência de 1h30 pelo lado mais preservado do Lago Paranoá.',
  90, 'Lago Paranoá, Brasília - DF',
  '/images/experiences/imersao-paranoa/grupos/img-3964.webp',
  '[]'::jsonb, '[]'::jsonb, true,
  'Uma experiência de 1h30 pelo lado mais preservado do Lago Paranoá.',
  'PUBLISHED', now(), now()
where not exists (select 1 from public.experiences where slug = 'imersao-paranoa');

update public.sessions
set experience_id = (select id from public.experiences where slug = 'imersao-paranoa')
where experience_id is null;

do $$
declare existing_job cron.job%rowtype;
begin
  select * into existing_job from cron.job
  where jobname = 'expire-alma-azul-pre-reservations' order by jobid limit 1;
  if not found then
    perform cron.schedule('expire-alma-azul-pre-reservations', '* * * * *',
      'select public.expire_pre_reservations();');
  elsif existing_job.schedule <> '* * * * *'
     or btrim(existing_job.command) <> 'select public.expire_pre_reservations();' then
    raise exception using message = 'CRON_JOB_DEFINITION_CONFLICT',
      detail = format('Existing job %s has schedule %s and command %s', existing_job.jobid, existing_job.schedule, existing_job.command),
      hint = 'Review the existing pg_cron job manually; this bootstrap will not overwrite it.';
  end if;
  if (select count(*) from cron.job where jobname = 'expire-alma-azul-pre-reservations') > 1 then
    raise exception 'DUPLICATE_EXPIRATION_CRON_JOBS';
  end if;
end;
$$;

commit;
