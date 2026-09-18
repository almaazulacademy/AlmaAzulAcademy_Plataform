-- Acesso de instrutores (perfil INSTRUCTOR) restrito à Lista de Presença.
--
-- Aditiva e idempotente. Reaproveita `admin_users` como tabela de perfis e
-- `admin_audit_log` como trilha de auditoria — nada de tabela paralela.
--
--   * `admin_users.role` passa a aceitar 'INSTRUCTOR'.
--   * `is_active_admin` passa a exigir role ADMIN ou OPERATOR. Até aqui ela só
--     olhava `is_active`; como TODAS as RPCs administrativas se autorizam por
--     ela, esta é a trava que impede um instrutor de chegar a qualquer uma delas.
--     Linhas existentes (ADMIN/OPERATOR) continuam passando: o admin atual não
--     perde acesso em nenhum momento.
--   * `is_active_checkin_staff` (ADMIN, OPERATOR ou INSTRUCTOR ativo) passa a
--     autorizar só as quatro RPCs da Lista de Presença.
--   * `instructor_invites` guarda apenas o hash SHA-256 do token do convite.
--     O token puro existe só no link entregue ao administrador.
--
-- Envio/reenvio de QR por e-mail (individual e em lote) continua exclusivo do
-- administrador: é comunicação com o cliente, não operação de check-in.

-- 1. Role INSTRUCTOR ---------------------------------------------------------
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.admin_users'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%role%'
      and c.conname <> 'admin_users_role_allowed'
  loop
    execute format('alter table public.admin_users drop constraint %I', constraint_name);
  end loop;

  if not exists (select 1 from pg_constraint where conname = 'admin_users_role_allowed') then
    alter table public.admin_users
      add constraint admin_users_role_allowed
      check (role in ('ADMIN', 'OPERATOR', 'INSTRUCTOR'));
  end if;
end;
$$;

-- 2. Autorização -------------------------------------------------------------
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
    where user_id = p_user_id
      and is_active
      and role in ('ADMIN', 'OPERATOR')
  );
$$;

create or replace function public.is_active_checkin_staff(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_users
    where user_id = p_user_id
      and is_active
      and role in ('ADMIN', 'OPERATOR', 'INSTRUCTOR')
  );
$$;

-- Gestão da equipe é só do ADMIN (nem OPERATOR convida ou desativa pessoas).
create or replace function public.is_active_owner_admin(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_users
    where user_id = p_user_id
      and is_active
      and role = 'ADMIN'
  );
$$;

-- 3. Lista de presença: mesmas RPCs, autorizadas para a equipe de check-in ---
--
-- Corpos idênticos aos de 202609180001, trocando apenas a checagem de acesso.
-- `admin_checkin_lookup` só devolve o e-mail do cliente a ADMIN/OPERATOR.
create or replace function public.admin_attendance_sessions(p_actor_id uuid, p_date date)
returns table (
  session_id uuid,
  experience_id uuid,
  experience_title text,
  base_name text,
  starts_at timestamptz,
  session_status text,
  capacity integer,
  reservations_count integer,
  reserved_spots integer,
  present_count integer,
  checked_in_reservations integer,
  pending_reservations integer,
  pending_spots integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_checkin_staff(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  return query
  select
    s.id,
    e.id,
    e.title,
    b.name,
    s.starts_at,
    s.status::text,
    s.capacity,
    count(r.id)::integer,
    coalesce(sum(r.quantity), 0)::integer,
    coalesce(sum(r.checked_in_count), 0)::integer,
    count(r.id) filter (where r.checked_in_count is not null)::integer,
    count(r.id) filter (where r.checked_in_count is null)::integer,
    coalesce(sum(r.quantity) filter (where r.checked_in_count is null), 0)::integer
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  left join public.bases b on b.id = e.base_id
  left join public.reservations r on r.session_id = s.id and r.status = 'CONFIRMED'
  where (s.starts_at at time zone 'America/Sao_Paulo')::date = p_date
    and s.status::text <> 'CANCELLED'
  group by s.id, e.id, e.title, b.name, s.starts_at, s.status, s.capacity
  order by s.starts_at, e.title;
end;
$$;

create or replace function public.admin_attendance_session(p_actor_id uuid, p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_active_checkin_staff(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'sessionId', s.id,
    'experienceId', e.id,
    'experienceTitle', e.title,
    'baseName', b.name,
    'startsAt', s.starts_at,
    'sessionStatus', s.status::text,
    'capacity', s.capacity,
    'reservations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'reservationId', r.id,
        'publicCode', r.public_code,
        'fullName', r.full_name,
        'quantity', r.quantity,
        'checkedInCount', r.checked_in_count,
        'checkedInAt', r.checked_in_at,
        'checkinMethod', r.checkin_method,
        'checkedInByName', au.display_name
      ) order by r.full_name)
      from public.reservations r
      left join public.admin_users au on au.user_id = r.checked_in_by
      where r.session_id = s.id and r.status = 'CONFIRMED'
    ), '[]'::jsonb)
  )
  into result
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  left join public.bases b on b.id = e.base_id
  where s.id = p_session_id;

  return result;
end;
$$;

create or replace function public.admin_checkin_lookup(
  p_actor_id uuid,
  p_token uuid default null,
  p_reservation_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
  show_email boolean;
begin
  if not public.is_active_checkin_staff(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if p_token is null and p_reservation_id is null then return null; end if;
  show_email := public.is_active_admin(p_actor_id);

  select jsonb_build_object(
    'reservationId', r.id,
    'publicCode', r.public_code,
    'status', r.status::text,
    'fullName', r.full_name,
    'email', case when show_email then r.email else null end,
    'quantity', r.quantity,
    'sessionId', s.id,
    'experienceTitle', e.title,
    'startsAt', s.starts_at,
    'hasToken', r.checkin_token is not null,
    'checkedInCount', r.checked_in_count,
    'checkedInAt', r.checked_in_at,
    'checkinMethod', r.checkin_method,
    'checkedInByName', au.display_name
  )
  into result
  from public.reservations r
  join public.sessions s on s.id = r.session_id
  join public.experiences e on e.id = r.experience_id
  left join public.admin_users au on au.user_id = r.checked_in_by
  where (p_token is null or r.checkin_token = p_token)
    and (p_reservation_id is null or r.id = p_reservation_id);

  return result;
end;
$$;

create or replace function public.admin_register_checkin(
  p_actor_id uuid,
  p_reservation_id uuid,
  p_count integer,
  p_method text,
  p_expected_session_id uuid default null,
  p_allow_update boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_row public.reservations%rowtype;
  action_name text;
begin
  if not public.is_active_checkin_staff(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if p_method is null or p_method not in ('QR', 'MANUAL') then
    raise exception 'CHECKIN_INVALID_METHOD' using errcode = '22023';
  end if;

  select * into current_row from public.reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'RESERVATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if current_row.status <> 'CONFIRMED' then
    raise exception 'RESERVATION_NOT_CONFIRMED' using errcode = '22023';
  end if;
  if p_expected_session_id is not null and current_row.session_id <> p_expected_session_id then
    raise exception 'CHECKIN_WRONG_SESSION' using errcode = '22023';
  end if;
  if p_count is not null and (p_count < 0 or p_count > current_row.quantity) then
    raise exception 'CHECKIN_INVALID_COUNT' using errcode = '22023';
  end if;
  if current_row.checked_in_count is not null and not coalesce(p_allow_update, false) then
    raise exception 'CHECKIN_ALREADY_DONE' using errcode = '23505';
  end if;
  if p_count is null and current_row.checked_in_count is null then
    raise exception 'CHECKIN_NOT_DONE' using errcode = '22023';
  end if;

  action_name := case
    when p_count is null then 'CHECKIN_UNDONE'
    when current_row.checked_in_count is null then 'CHECKIN_REGISTERED'
    else 'CHECKIN_UPDATED'
  end;

  update public.reservations
  set checked_in_count = p_count,
      checked_in_at = case when p_count is null then null else now() end,
      checked_in_by = case when p_count is null then null else p_actor_id end,
      checkin_method = case when p_count is null then null else p_method end
  where id = p_reservation_id;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (
    p_actor_id,
    action_name,
    'RESERVATION',
    p_reservation_id,
    jsonb_build_object(
      'quantity', current_row.quantity,
      'previousCount', current_row.checked_in_count,
      'newCount', p_count,
      'previousMethod', current_row.checkin_method,
      'method', p_method,
      'sessionId', current_row.session_id
    )
  );

  return public.admin_checkin_lookup(p_actor_id, null, p_reservation_id);
end;
$$;

-- 4. Convites ----------------------------------------------------------------
create table if not exists public.instructor_invites (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  constraint instructor_invites_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint instructor_invites_expiry_after_creation check (expires_at > created_at),
  constraint instructor_invites_used_consistency check ((used_at is null) = (used_by is null))
);

create unique index if not exists instructor_invites_token_hash_key on public.instructor_invites (token_hash);
create index if not exists instructor_invites_created_idx on public.instructor_invites (created_at desc);

alter table public.instructor_invites enable row level security;
revoke all on public.instructor_invites from public, anon, authenticated;

-- Estado derivado; nunca gravado, para não divergir das colunas.
create or replace function public.instructor_invite_state(p_invite public.instructor_invites)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when p_invite.used_at is not null then 'USED'
    when p_invite.revoked_at is not null then 'REVOKED'
    when p_invite.expires_at <= now() then 'EXPIRED'
    else 'VALID'
  end;
$$;

-- Criação: o hash chega pronto; o token puro nunca passa pelo banco.
create or replace function public.admin_create_instructor_invite(
  p_actor_id uuid,
  p_token_hash text,
  p_valid_days integer default 7
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  invite public.instructor_invites%rowtype;
begin
  if not public.is_active_owner_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if p_valid_days is null or p_valid_days < 1 or p_valid_days > 30 then
    raise exception 'INVITE_INVALID_VALIDITY' using errcode = '22023';
  end if;

  insert into public.instructor_invites (token_hash, created_by, expires_at)
  values (lower(p_token_hash), p_actor_id, now() + make_interval(days => p_valid_days))
  returning * into invite;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (p_actor_id, 'INSTRUCTOR_INVITE_CREATED', 'INSTRUCTOR_INVITE', invite.id,
          jsonb_build_object('expiresAt', invite.expires_at));

  return jsonb_build_object('inviteId', invite.id, 'expiresAt', invite.expires_at);
end;
$$;

create or replace function public.admin_revoke_instructor_invite(p_actor_id uuid, p_invite_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_owner_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  update public.instructor_invites
  set revoked_at = now()
  where id = p_invite_id and used_at is null and revoked_at is null;
  if not found then return false; end if;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (p_actor_id, 'INSTRUCTOR_INVITE_REVOKED', 'INSTRUCTOR_INVITE', p_invite_id, '{}'::jsonb);
  return true;
end;
$$;

-- Consulta pública (tela de cadastro): só o estado, nada sobre quem convidou.
create or replace function public.instructor_invite_status(p_token_hash text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select public.instructor_invite_state(i) from public.instructor_invites i where i.token_hash = lower(p_token_hash)),
    'INVALID'
  );
$$;

-- Consumo atômico. Chamado pelo servidor depois de criar o usuário no Auth;
-- o role é sempre INSTRUCTOR, definido aqui e nunca recebido do cliente.
-- `for update` serializa dois cadastros com o mesmo convite: o segundo encontra
-- USED e falha, e o servidor desfaz o usuário que acabou de criar.
create or replace function public.instructor_invite_claim(
  p_token_hash text,
  p_user_id uuid,
  p_display_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  invite public.instructor_invites%rowtype;
  state text;
  name text := nullif(btrim(coalesce(p_display_name, '')), '');
begin
  if p_user_id is null then
    raise exception 'INVITE_INVALID_USER' using errcode = '22023';
  end if;
  if name is null or char_length(name) > 80 then
    raise exception 'INVITE_INVALID_NAME' using errcode = '22023';
  end if;

  select * into invite from public.instructor_invites where token_hash = lower(p_token_hash) for update;
  if not found then
    raise exception 'INVITE_INVALID' using errcode = 'P0002';
  end if;
  state := public.instructor_invite_state(invite);
  if state <> 'VALID' then
    raise exception 'INVITE_%', state using errcode = '22023';
  end if;
  if exists (select 1 from public.admin_users where user_id = p_user_id) then
    raise exception 'INVITE_ACCOUNT_EXISTS' using errcode = '23505';
  end if;

  insert into public.admin_users (user_id, display_name, role, is_active)
  values (p_user_id, name, 'INSTRUCTOR', true);

  update public.instructor_invites
  set used_at = now(), used_by = p_user_id
  where id = invite.id;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values
    (p_user_id, 'INSTRUCTOR_INVITE_USED', 'INSTRUCTOR_INVITE', invite.id, jsonb_build_object('invitedBy', invite.created_by)),
    (p_user_id, 'INSTRUCTOR_REGISTERED', 'ADMIN_USER', p_user_id, jsonb_build_object('inviteId', invite.id));

  return jsonb_build_object('userId', p_user_id, 'role', 'INSTRUCTOR');
end;
$$;

-- 5. Gestão da equipe ------------------------------------------------------------
create or replace function public.admin_list_instructors(p_actor_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_owner_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'instructors', coalesce((
      select jsonb_agg(jsonb_build_object(
        'userId', au.user_id,
        'displayName', au.display_name,
        'email', u.email,
        'isActive', au.is_active,
        'createdAt', au.created_at,
        'lastSignInAt', u.last_sign_in_at
      ) order by au.is_active desc, au.display_name)
      from public.admin_users au
      join auth.users u on u.id = au.user_id
      where au.role = 'INSTRUCTOR'
    ), '[]'::jsonb),
    'invites', coalesce((
      select jsonb_agg(jsonb_build_object(
        'inviteId', i.id,
        'state', public.instructor_invite_state(i),
        'createdAt', i.created_at,
        'expiresAt', i.expires_at,
        'usedAt', i.used_at,
        'usedByName', used.display_name
      ) order by i.created_at desc)
      from (select * from public.instructor_invites order by created_at desc limit 30) i
      left join public.admin_users used on used.user_id = i.used_by
    ), '[]'::jsonb)
  );
end;
$$;

-- Só alcança linhas INSTRUCTOR: esta RPC nunca desativa nem promove um admin.
create or replace function public.admin_set_instructor_active(p_actor_id uuid, p_user_id uuid, p_active boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  previous boolean;
begin
  if not public.is_active_owner_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if p_active is null then
    raise exception 'INSTRUCTOR_INVALID_STATE' using errcode = '22023';
  end if;

  select is_active into previous
  from public.admin_users
  where user_id = p_user_id and role = 'INSTRUCTOR'
  for update;
  if not found then
    raise exception 'INSTRUCTOR_NOT_FOUND' using errcode = 'P0002';
  end if;
  if previous = p_active then return false; end if;

  update public.admin_users set is_active = p_active where user_id = p_user_id and role = 'INSTRUCTOR';

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (p_actor_id, case when p_active then 'INSTRUCTOR_REACTIVATED' else 'INSTRUCTOR_DEACTIVATED' end,
          'ADMIN_USER', p_user_id, '{}'::jsonb);
  return true;
end;
$$;

-- 6. Grants -----------------------------------------------------------------------
revoke all on function public.is_active_checkin_staff(uuid) from public, anon, authenticated;
revoke all on function public.is_active_owner_admin(uuid) from public, anon, authenticated;
revoke all on function public.instructor_invite_state(public.instructor_invites) from public, anon, authenticated;
revoke all on function public.admin_create_instructor_invite(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.admin_revoke_instructor_invite(uuid, uuid) from public, anon, authenticated;
revoke all on function public.instructor_invite_status(text) from public, anon, authenticated;
revoke all on function public.instructor_invite_claim(text, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_list_instructors(uuid) from public, anon, authenticated;
revoke all on function public.admin_set_instructor_active(uuid, uuid, boolean) from public, anon, authenticated;
-- Recriadas acima: reforça que continuam fora do alcance de anon/authenticated.
revoke all on function public.is_active_admin(uuid) from public, anon, authenticated;
revoke all on function public.admin_attendance_sessions(uuid, date) from public, anon, authenticated;
revoke all on function public.admin_attendance_session(uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_checkin_lookup(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_register_checkin(uuid, uuid, integer, text, uuid, boolean) from public, anon, authenticated;

grant execute on function public.is_active_checkin_staff(uuid) to service_role;
grant execute on function public.is_active_owner_admin(uuid) to service_role;
grant execute on function public.instructor_invite_state(public.instructor_invites) to service_role;
grant execute on function public.admin_create_instructor_invite(uuid, text, integer) to service_role;
grant execute on function public.admin_revoke_instructor_invite(uuid, uuid) to service_role;
grant execute on function public.instructor_invite_status(text) to service_role;
grant execute on function public.instructor_invite_claim(text, uuid, text) to service_role;
grant execute on function public.admin_list_instructors(uuid) to service_role;
grant execute on function public.admin_set_instructor_active(uuid, uuid, boolean) to service_role;
grant execute on function public.is_active_admin(uuid) to service_role;
grant execute on function public.admin_attendance_sessions(uuid, date) to service_role;
grant execute on function public.admin_attendance_session(uuid, uuid) to service_role;
grant execute on function public.admin_checkin_lookup(uuid, uuid, uuid) to service_role;
grant execute on function public.admin_register_checkin(uuid, uuid, integer, text, uuid, boolean) to service_role;
