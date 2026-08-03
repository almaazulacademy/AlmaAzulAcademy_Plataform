-- Keep canonical reservation fields compatible with the legacy NOT NULL aliases.
-- No column, constraint or existing row is removed or bulk-updated.

do $$
declare
  legacy_column_count integer;
begin
  select count(*)::integer into legacy_column_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'reservations'
    and column_name in ('customer_name', 'customer_email', 'customer_phone', 'participants');

  if legacy_column_count not in (0, 4) then
    raise exception using
      message = 'INCOMPLETE_LEGACY_RESERVATION_SCHEMA',
      detail = format('Expected zero or four legacy reservation aliases, found %s.', legacy_column_count);
  end if;

  if legacy_column_count = 4 then
    execute $function$
      create or replace function public.sync_reservation_legacy_fields()
      returns trigger
      language plpgsql
      set search_path = public
      as $body$
      begin
        if tg_op = 'INSERT' then
          new.full_name := coalesce(new.full_name, new.customer_name);
          new.customer_name := new.full_name;
          new.email := coalesce(new.email, new.customer_email);
          new.customer_email := new.email;
          new.phone := coalesce(new.phone, new.customer_phone);
          new.customer_phone := new.phone;
          new.quantity := coalesce(new.quantity, new.participants);
          new.participants := new.quantity;
        else
          if new.full_name is distinct from old.full_name then
            new.customer_name := new.full_name;
          elsif new.customer_name is distinct from old.customer_name then
            new.full_name := new.customer_name;
          else
            new.customer_name := new.full_name;
          end if;

          if new.email is distinct from old.email then
            new.customer_email := new.email;
          elsif new.customer_email is distinct from old.customer_email then
            new.email := new.customer_email;
          else
            new.customer_email := new.email;
          end if;

          if new.phone is distinct from old.phone then
            new.customer_phone := new.phone;
          elsif new.customer_phone is distinct from old.customer_phone then
            new.phone := new.customer_phone;
          else
            new.customer_phone := new.phone;
          end if;

          if new.quantity is distinct from old.quantity then
            new.participants := new.quantity;
          elsif new.participants is distinct from old.participants then
            new.quantity := new.participants;
          else
            new.participants := new.quantity;
          end if;
        end if;
        return new;
      end;
      $body$;
    $function$;

    drop trigger if exists reservations_sync_legacy_fields on public.reservations;
    create trigger reservations_sync_legacy_fields
      before insert or update
      on public.reservations
      for each row execute function public.sync_reservation_legacy_fields();
  end if;
end;
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
  has_legacy_aliases boolean;
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

  select count(*) = 4 into has_legacy_aliases
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'reservations'
    and column_name in ('customer_name', 'customer_email', 'customer_phone', 'participants');

  if has_legacy_aliases then
    execute $insert$
      insert into public.reservations (
        public_code, idempotency_key, experience_id, session_id,
        full_name, customer_name, cpf_hash, cpf_last4,
        phone, customer_phone, email, customer_email,
        quantity, participants, unit_price_cents, notes, expires_at
      ) values (
        upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
        $1, $2, $3, $4, $4,
        encode(digest($5, 'sha256'), 'hex'), right($5, 4),
        $6, $6, lower(trim($7)), lower(trim($7)),
        $8, $8, $9, nullif(trim($10), ''), now() + interval '2 hours'
      ) returning *
    $insert$
    into created_reservation
    using p_idempotency_key, target_experience.id, target_session.id,
      trim(p_full_name), normalized_cpf, p_phone, p_email, p_quantity,
      target_session.price_cents, p_notes;
  else
    insert into public.reservations (
      public_code, idempotency_key, experience_id, session_id, full_name, cpf_hash, cpf_last4,
      phone, email, quantity, unit_price_cents, notes, expires_at
    ) values (
      upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
      p_idempotency_key, target_experience.id, target_session.id, trim(p_full_name),
      encode(digest(normalized_cpf, 'sha256'), 'hex'), right(normalized_cpf, 4),
      p_phone, lower(trim(p_email)), p_quantity, target_session.price_cents,
      nullif(trim(p_notes), ''), now() + interval '2 hours'
    ) returning * into created_reservation;
  end if;

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

-- Payment confirmation, checkout attachment, expiration and administrative status
-- changes only UPDATE reservations. The row trigger above synchronizes aliases for
-- every one of those writes in a legacy schema; their transition logic is unchanged.
do $$
begin
  if to_regprocedure('public.confirm_reservation_payment(uuid,text,text,integer,text,jsonb)') is null
     or to_regprocedure('public.attach_payment_checkout(uuid,text,text,text)') is null
     or to_regprocedure('public.cancel_pre_reservation(uuid)') is null then
    raise exception 'RESERVATION_WRITE_FUNCTION_MISSING';
  end if;
end;
$$;

revoke all on function public.create_pre_reservation(uuid, text, text, text, text, integer, text, uuid)
  from public, anon, authenticated;
grant execute on function public.create_pre_reservation(uuid, text, text, text, text, integer, text, uuid)
  to service_role;
