-- QR Code de check-in e lista de presença.
--
-- Aditiva e idempotente. Nada aqui altera status, pagamento, quantidade,
-- capacidade, disponibilidade ou dado de cliente de reserva existente.
--
-- Presença é um eixo separado do status da reserva: uma reserva continua
-- CONFIRMED e ganha, ao lado, quantas pessoas de fato compareceram. Nenhum
-- filtro, RPC ou contagem de vagas que dependa de `status` é afetado.
--
--   checkin_token     uuid aleatório (gen_random_uuid, v4). É o único conteúdo
--                     do QR. Nunca muda depois de criado: reenviar o QR reenvia
--                     o mesmo token.
--   checked_in_count  pessoas presentes. null = aguardando check-in;
--                     0 = ausência registrada; < quantity = parcial;
--                     = quantity = completo.
--   checked_in_at     último registro de presença.
--   checked_in_by     usuário administrativo que registrou.
--   checkin_method    'QR' ou 'MANUAL'.
--
-- O histórico de correções vai para `admin_audit_log`, que já é a trilha de
-- auditoria do painel.

-- 1. Colunas ------------------------------------------------------------------
alter table public.reservations add column if not exists checkin_token uuid;
alter table public.reservations add column if not exists checked_in_count integer;
alter table public.reservations add column if not exists checked_in_at timestamptz;
alter table public.reservations add column if not exists checked_in_by uuid references auth.users(id) on delete set null;
alter table public.reservations add column if not exists checkin_method text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'reservations_checked_in_count_range') then
    alter table public.reservations
      add constraint reservations_checked_in_count_range
      check (checked_in_count is null or (checked_in_count >= 0 and checked_in_count <= quantity));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reservations_checkin_method_check') then
    alter table public.reservations
      add constraint reservations_checkin_method_check
      check (checkin_method is null or checkin_method in ('QR', 'MANUAL'));
  end if;
end;
$$;

create unique index if not exists reservations_checkin_token_key
  on public.reservations (checkin_token)
  where checkin_token is not null;

-- 2. Token gerado na confirmação ---------------------------------------------
--
-- Trigger em vez de mexer em cada RPC de confirmação: webhook, retorno do
-- pagamento, "Verificar pagamento" e confirmação manual convergem todos em
-- status = 'CONFIRMED'. O `if ... is null` garante que um token existente
-- jamais seja trocado — nem em troca de turma, nem em reprocessamento.
create or replace function public.ensure_reservation_checkin_token()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'CONFIRMED' and new.checkin_token is null then
    new.checkin_token := gen_random_uuid();
  end if;
  return new;
end;
$$;

drop trigger if exists reservations_ensure_checkin_token on public.reservations;
create trigger reservations_ensure_checkin_token
  before insert or update of status, checkin_token on public.reservations
  for each row execute function public.ensure_reservation_checkin_token();

-- 3. Backfill: reservas já confirmadas ------------------------------------------
--
-- Só toca linhas CONFIRMED sem token. Reexecutar não altera nada.
--
-- Efeito colateral conhecido e aceito: o trigger `reservations_set_updated_at`
-- move `updated_at` dessas reservas para o horário da migration. Analisado sem
-- consequência operacional: ordenação e filtros do painel usam created_at /
-- starts_at; Sheets, e-mail e cron usam integration_sync_jobs.updated_at; a
-- reconciliação de pagamento só olha updated_at de reservas EXPIRED (o
-- backfill só toca CONFIRMED). O único reflexo é o indicador "última
-- atualização" do dashboard, que passa a mostrar o horário da migration.
update public.reservations
set checkin_token = gen_random_uuid()
where status = 'CONFIRMED'
  and checkin_token is null;

-- 4. E-mail de confirmação passa a levar o token --------------------------------
--
-- Mesma assinatura e mesmas exclusões de antes (CPF, telefone, pagamento).
create or replace function public.reservation_confirmation_email(p_reservation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'reservationId', r.id,
    'publicCode', r.public_code,
    'fullName', r.full_name,
    'email', r.email,
    'quantity', r.quantity,
    'status', r.status,
    'experienceTitle', e.title,
    'startsAt', s.starts_at,
    'checkinToken', r.checkin_token
  )
  from public.reservations r
  join public.sessions s on s.id = r.session_id
  join public.experiences e on e.id = r.experience_id
  where r.id = p_reservation_id
    and r.status = 'CONFIRMED';
$$;

-- 5. Página pública do QR -------------------------------------------------------
--
-- Só identifica/valida o QR. Não devolve nome, e-mail, telefone, CPF nem código
-- da reserva: quem tem o QR vê apenas a experiência, a data e as vagas.
create or replace function public.public_checkin_ticket(p_token uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'experienceTitle', e.title,
    'startsAt', s.starts_at,
    'quantity', r.quantity,
    'checkedIn', r.checked_in_count is not null
  )
  from public.reservations r
  join public.sessions s on s.id = r.session_id
  join public.experiences e on e.id = r.experience_id
  where p_token is not null
    and r.checkin_token = p_token
    and r.status = 'CONFIRMED';
$$;

-- 6. Lista de presença: turmas de um dia ----------------------------------------
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
  if not public.is_active_admin(p_actor_id) then
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

-- 7. Lista de presença: reservas de uma turma -----------------------------------
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
  if not public.is_active_admin(p_actor_id) then
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

-- 8. Localizar uma reserva pelo QR (ou pelo id, no check-in manual) -------------
--
-- Só leitura. Devolve a reserva mesmo que não esteja confirmada, para o painel
-- explicar o motivo ("reserva cancelada") em vez de dizer "QR inválido".
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
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if p_token is null and p_reservation_id is null then return null; end if;

  select jsonb_build_object(
    'reservationId', r.id,
    'publicCode', r.public_code,
    'status', r.status::text,
    'fullName', r.full_name,
    'email', r.email,
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

-- 9. Registrar, corrigir ou desfazer presença -----------------------------------
--
-- Toda a validação que importa está aqui, não no navegador:
--   * só usuário administrativo ativo;
--   * só reserva CONFIRMED;
--   * quantidade entre 0 e as vagas da reserva (o check da tabela reforça);
--   * a reserva precisa ser da turma que o instrutor está operando, quando
--     informada — QR de outra turma nunca marca presença;
--   * `for update` serializa dois instrutores escaneando o mesmo QR: o segundo
--     recebe CHECKIN_ALREADY_DONE em vez de sobrescrever;
--   * corrigir um check-in existente exige p_allow_update explícito.
--
-- p_count null = desfazer (volta para "aguardando").
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
  if not public.is_active_admin(p_actor_id) then
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

-- 10. Reenvio do QR -------------------------------------------------------------
--
-- Devolve o mesmo payload do e-mail de confirmação, com o token existente
-- (a trigger só gera se, por algum motivo, uma reserva confirmada estiver sem
-- token — nunca troca). Registra o reenvio na auditoria.
create or replace function public.admin_reservation_qr_email(p_actor_id uuid, p_reservation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (select 1 from public.reservations where id = p_reservation_id and status = 'CONFIRMED') then
    raise exception 'RESERVATION_NOT_CONFIRMED' using errcode = '22023';
  end if;

  update public.reservations
  set checkin_token = gen_random_uuid()
  where id = p_reservation_id and checkin_token is null;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (p_actor_id, 'CHECKIN_QR_RESENT', 'RESERVATION', p_reservation_id, '{}'::jsonb);

  return public.reservation_confirmation_email(p_reservation_id);
end;
$$;

-- 11. Grants --------------------------------------------------------------------
revoke all on function public.ensure_reservation_checkin_token() from public, anon, authenticated;
revoke all on function public.public_checkin_ticket(uuid) from public, anon, authenticated;
revoke all on function public.admin_attendance_sessions(uuid, date) from public, anon, authenticated;
revoke all on function public.admin_attendance_session(uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_checkin_lookup(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_register_checkin(uuid, uuid, integer, text, uuid, boolean) from public, anon, authenticated;
revoke all on function public.admin_reservation_qr_email(uuid, uuid) from public, anon, authenticated;
revoke all on function public.reservation_confirmation_email(uuid) from public, anon, authenticated;

grant execute on function public.public_checkin_ticket(uuid) to service_role;
grant execute on function public.admin_attendance_sessions(uuid, date) to service_role;
grant execute on function public.admin_attendance_session(uuid, uuid) to service_role;
grant execute on function public.admin_checkin_lookup(uuid, uuid, uuid) to service_role;
grant execute on function public.admin_register_checkin(uuid, uuid, integer, text, uuid, boolean) to service_role;
grant execute on function public.admin_reservation_qr_email(uuid, uuid) to service_role;
grant execute on function public.reservation_confirmation_email(uuid) to service_role;
