-- Legacy schema compatibility bootstrap.
--
-- This file is intentionally non-destructive: it preserves legacy columns, rows,
-- UUIDs and foreign-key relationships, and never drops an enum or table.
-- IMPORTANT: because migrations 202608010001/002 sort before this file, a database
-- where 001 is not recorded as applied must run this SQL once as a reviewed
-- bootstrap transaction before the normal migration runner. A later normal run is
-- safe because every operation below is idempotent.

-- Fail clearly if the supplied inventory is no longer true. The legacy table was
-- reported empty; inventing CPF hashes or idempotency keys for unexpected rows
-- would be unsafe.
do $$
begin
  if to_regclass('public.reservations') is not null
     and exists (select 1 from public.reservations)
     and not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'reservations' and column_name = 'cpf_hash'
     ) then
    raise exception using
      message = 'LEGACY_RESERVATIONS_NOT_EMPTY',
      detail = 'Compatibility requires a reviewed data migration when legacy reservations exist.';
  end if;
end;
$$;

-- Keep the enum identities and their dependent columns/functions. PostgreSQL enum
-- label renames are transactional and preserve the type OID.
do $$
begin
  if exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
             where n.nspname = 'public' and t.typname = 'reservation_status') then
    if exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
               join pg_namespace n on n.oid = t.typnamespace
               where n.nspname = 'public' and t.typname = 'reservation_status' and e.enumlabel = 'pending')
       and not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
               join pg_namespace n on n.oid = t.typnamespace
               where n.nspname = 'public' and t.typname = 'reservation_status' and e.enumlabel = 'PRE_RESERVED') then
      alter type public.reservation_status rename value 'pending' to 'PRE_RESERVED';
    end if;
    if exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid=t.typnamespace
               where n.nspname='public' and t.typname='reservation_status' and e.enumlabel='confirmed') then
      alter type public.reservation_status rename value 'confirmed' to 'CONFIRMED';
    end if;
    if exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid=t.typnamespace
               where n.nspname='public' and t.typname='reservation_status' and e.enumlabel='cancelled') then
      alter type public.reservation_status rename value 'cancelled' to 'CANCELLED';
    end if;
    if exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid=t.typnamespace
               where n.nspname='public' and t.typname='reservation_status' and e.enumlabel='expired') then
      alter type public.reservation_status rename value 'expired' to 'EXPIRED';
    end if;
  else
    create type public.reservation_status as enum ('PRE_RESERVED', 'CONFIRMED', 'EXPIRED', 'CANCELLED');
  end if;
end;
$$;

do $$
begin
  if exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
             where n.nspname = 'public' and t.typname = 'session_status') then
    if exists (select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace
               where n.nspname='public' and t.typname='session_status' and e.enumlabel='scheduled')
       and not exists (select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace
               where n.nspname='public' and t.typname='session_status' and e.enumlabel='OPEN') then
      alter type public.session_status rename value 'scheduled' to 'OPEN';
    end if;
    if exists (select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace
               where n.nspname='public' and t.typname='session_status' and e.enumlabel='completed') then
      alter type public.session_status rename value 'completed' to 'CLOSED';
    end if;
    if exists (select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace
               where n.nspname='public' and t.typname='session_status' and e.enumlabel='cancelled') then
      alter type public.session_status rename value 'cancelled' to 'CANCELLED';
    end if;
  else
    create type public.session_status as enum ('OPEN', 'CLOSED', 'CANCELLED');
  end if;
end;
$$;

-- Experiences: add the transactional projection used by Sprints 3/4 while retaining
-- every editorial legacy field. short_description/cover_image/active remain intact.
alter table public.experiences
  add column if not exists summary text,
  add column if not exists status text,
  add column if not exists image_url text,
  add column if not exists display_order integer;

update public.experiences
set summary = coalesce(nullif(summary, ''), title),
    display_order = coalesce(display_order, 0)
where summary is null or summary = '' or display_order is null;

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='experiences' and column_name='short_description') then
    execute 'update public.experiences set summary=coalesce(nullif(short_description, ''''), summary) where short_description is not null';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='experiences' and column_name='description') then
    execute 'update public.experiences set summary=coalesce(nullif(summary, ''''), nullif(description, ''''), title)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='experiences' and column_name='cover_image') then
    execute 'update public.experiences set image_url=coalesce(image_url, cover_image)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='experiences' and column_name='active') then
    execute 'update public.experiences set status=case when active then ''PUBLISHED'' else ''DRAFT'' end where status is null';
  end if;
end;
$$;

update public.experiences set status='PUBLISHED' where status is null;

alter table public.experiences
  alter column summary set not null,
  alter column status set default 'PUBLISHED',
  alter column status set not null,
  alter column display_order set default 0,
  alter column display_order set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.experiences'::regclass and conname='experiences_status_check') then
    alter table public.experiences add constraint experiences_status_check
      check (status in ('DRAFT', 'PUBLISHED', 'ARCHIVED'));
  end if;
end;
$$;

-- Sessions: preserve all six IDs and rows. duration falls back to the experience's
-- editorial duration, then 90 minutes. spots_available is retained but is not used
-- by any canonical availability function or RPC.
alter table public.sessions
  add column if not exists duration_minutes integer,
  add column if not exists internal_notes text,
  add column if not exists updated_at timestamptz;

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='experiences' and column_name='duration_minutes') then
    execute 'update public.sessions s set duration_minutes=coalesce(s.duration_minutes,e.duration_minutes,90), updated_at=coalesce(s.updated_at,s.created_at,now()) from public.experiences e where e.id=s.experience_id and (s.duration_minutes is null or s.updated_at is null)';
  end if;
end;
$$;

update public.sessions
set duration_minutes = coalesce(duration_minutes, 90), updated_at = coalesce(updated_at, created_at, now())
where duration_minutes is null or updated_at is null;

alter table public.sessions
  alter column duration_minutes set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null,
  alter column status set default 'OPEN';

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.sessions'::regclass and conname='sessions_duration_minutes_check') then
    alter table public.sessions add constraint sessions_duration_minutes_check check (duration_minutes > 0);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.sessions'::regclass and conname='sessions_capacity_check') then
    alter table public.sessions add constraint sessions_capacity_check check (capacity > 0);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.sessions'::regclass and conname='sessions_price_cents_check') then
    alter table public.sessions add constraint sessions_price_cents_check check (price_cents >= 0);
  end if;
end;
$$;

-- Reservations: the reported table is empty, so canonical required columns can be
-- introduced without fabricating personal data. Legacy aliases remain available.
alter table public.reservations
  add column if not exists public_code text,
  add column if not exists idempotency_key uuid,
  add column if not exists experience_id uuid,
  add column if not exists full_name text,
  add column if not exists cpf_hash text,
  add column if not exists cpf_last4 char(4),
  add column if not exists phone text,
  add column if not exists email text,
  add column if not exists quantity integer,
  add column if not exists unit_price_cents integer,
  add column if not exists notes text,
  add column if not exists payment_provider text,
  add column if not exists provider_reference text,
  add column if not exists checkout_url text,
  add column if not exists confirmed_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists updated_at timestamptz;

-- These mappings are useful if a row appears between inventory and execution; the
-- guard above still refuses rows for which CPF-derived canonical data is impossible.
update public.reservations r
set experience_id = coalesce(r.experience_id, s.experience_id),
    unit_price_cents = coalesce(r.unit_price_cents, s.price_cents),
    updated_at = coalesce(r.updated_at, r.created_at, now())
from public.sessions s
where s.id = r.session_id;

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='reservations' and column_name='customer_name') then
    execute 'update public.reservations set full_name=coalesce(full_name,customer_name)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='reservations' and column_name='customer_phone') then
    execute 'update public.reservations set phone=coalesce(phone,customer_phone)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='reservations' and column_name='customer_email') then
    execute 'update public.reservations set email=coalesce(email,customer_email)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='reservations' and column_name='participants') then
    execute 'update public.reservations set quantity=coalesce(quantity,participants), unit_price_cents=coalesce(unit_price_cents,case when participants>0 then total_cents/participants end)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='reservations' and column_name='pix_code') then
    execute 'update public.reservations set checkout_url=coalesce(checkout_url,pix_code)';
  end if;
end;
$$;

alter table public.reservations
  alter column status set default 'PRE_RESERVED',
  alter column public_code set not null,
  alter column idempotency_key set not null,
  alter column experience_id set not null,
  alter column full_name set not null,
  alter column cpf_hash set not null,
  alter column cpf_last4 set not null,
  alter column phone set not null,
  alter column email set not null,
  alter column quantity set not null,
  alter column unit_price_cents set not null,
  alter column expires_at set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null;

-- The legacy total_cents is a regular column. Keep it and make its invariant
-- equivalent to the generated column expected by 001.
create or replace function public.set_reservation_total_cents()
returns trigger language plpgsql set search_path = public as $$
begin
  new.total_cents := new.quantity * new.unit_price_cents;
  return new;
end;
$$;

do $$
begin
  if exists (
    select 1 from pg_attribute
    where attrelid='public.reservations'::regclass and attname='total_cents'
      and not attisdropped and attgenerated=''
  ) then
    drop trigger if exists reservations_set_total_cents on public.reservations;
    create trigger reservations_set_total_cents
      before insert or update of quantity, unit_price_cents on public.reservations
      for each row execute function public.set_reservation_total_cents();
  end if;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.reservations'::regclass and conname='reservations_public_code_key') then
    alter table public.reservations add constraint reservations_public_code_key unique (public_code);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.reservations'::regclass and conname='reservations_idempotency_key_key') then
    alter table public.reservations add constraint reservations_idempotency_key_key unique (idempotency_key);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.reservations'::regclass and conname='reservations_experience_id_fkey') then
    alter table public.reservations add constraint reservations_experience_id_fkey foreign key (experience_id) references public.experiences(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.reservations'::regclass and conname='reservations_quantity_check') then
    alter table public.reservations add constraint reservations_quantity_check check (quantity > 0 and quantity <= 20);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.reservations'::regclass and conname='reservations_unit_price_cents_check') then
    alter table public.reservations add constraint reservations_unit_price_cents_check check (unit_price_cents >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.reservations'::regclass and conname='reservations_total_cents_check') then
    alter table public.reservations add constraint reservations_total_cents_check check (total_cents = quantity * unit_price_cents);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.reservations'::regclass and conname='reservations_notes_check') then
    alter table public.reservations add constraint reservations_notes_check check (notes is null or char_length(notes) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.reservations'::regclass and conname='reservation_expiry_after_creation') then
    alter table public.reservations add constraint reservation_expiry_after_creation check (expires_at > created_at);
  end if;
end;
$$;

create index if not exists sessions_experience_starts_at_idx
  on public.sessions (experience_id, starts_at) where status = 'OPEN';
create index if not exists reservations_session_occupancy_idx
  on public.reservations (session_id, status, expires_at);
create index if not exists reservations_lookup_idx
  on public.reservations (public_code, cpf_hash);
create index if not exists reservations_expiration_idx
  on public.reservations (expires_at) where status = 'PRE_RESERVED';

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='sessions' and column_name='spots_available') then
    comment on column public.sessions.spots_available is
      'Legacy snapshot only; canonical availability is public.available_spots(id), derived from capacity and valid reservations.';
  end if;
end;
$$;
comment on function public.set_reservation_total_cents() is
  'Compatibility trigger: keeps legacy regular total_cents equivalent to quantity * unit_price_cents.';
