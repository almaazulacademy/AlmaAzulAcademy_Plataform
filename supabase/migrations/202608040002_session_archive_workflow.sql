-- Substitui o bloqueio total de exclusão de sessões com histórico por um
-- fluxo de arquivamento. Nenhuma reserva, pagamento ou participante é
-- apagado ou tocado por esta migration; nenhum DELETE em cascata é usado.
--
--   * sessões SEM reservas: continuam sendo excluídas definitivamente
--     (mesmo comportamento de antes);
--   * sessões COM reservas: em vez de bloquear a exclusão, a sessão passa
--     para status = 'ARCHIVED'. Isso já basta para sumir do site público e
--     parar de aceitar novas reservas, porque list_open_sessions,
--     create_pre_reservation e a policy de RLS pública só liberam
--     status = 'OPEN'.

-- 1. admin_delete_session: exclui de verdade só quando não há reservas;
--    caso contrário arquiva. Assinatura (uuid, uuid) inalterada.
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
  has_reservations boolean;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  select * into target from public.sessions where id = p_session_id for update;
  if not found then return false; end if;

  select exists (
    select 1 from public.reservations where session_id = p_session_id
  ) into has_reservations;

  if has_reservations then
    if target.status = 'ARCHIVED' then
      raise exception 'SESSION_ALREADY_ARCHIVED' using errcode = '22023';
    end if;

    update public.sessions set status = 'ARCHIVED' where id = p_session_id;
    insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
    values (
      p_actor_id,
      'SESSION_ARCHIVED',
      'SESSION',
      p_session_id,
      jsonb_build_object('starts_at', target.starts_at, 'capacity', target.capacity)
    );
    return true;
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

-- 2. admin_restore_session: reabre uma sessão arquivada, desde que a data
--    ainda esteja no futuro e não colida com outra sessão ativa da mesma
--    experiência no mesmo horário.
create or replace function public.admin_restore_session(
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

  if target.status <> 'ARCHIVED' then
    raise exception 'SESSION_NOT_ARCHIVED' using errcode = '22023';
  end if;

  if target.starts_at <= now() then
    raise exception 'SESSION_RESTORE_PAST' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.sessions
    where experience_id = target.experience_id
      and starts_at = target.starts_at
      and id <> target.id
      and status <> 'ARCHIVED'
  ) then
    raise exception 'SESSION_RESTORE_CONFLICT' using errcode = '23505';
  end if;

  update public.sessions set status = 'OPEN' where id = p_session_id;
  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (
    p_actor_id,
    'SESSION_RESTORED',
    'SESSION',
    p_session_id,
    jsonb_build_object('starts_at', target.starts_at, 'capacity', target.capacity)
  );
  return true;
end;
$$;

revoke all on function public.admin_restore_session(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_restore_session(uuid, uuid) to service_role;

-- 3. admin_list_sessions: adiciona filtro opcional de status de arquivamento.
--    p_filter aceita 'ACTIVE' (padrão, exclui arquivadas), 'ARCHIVED'
--    (somente arquivadas) ou 'ALL' (todas). Assinatura muda de (uuid) para
--    (uuid, text default 'ACTIVE'); a versão antiga é removida para não
--    deixar uma sobrecarga duplicada.
drop function if exists public.admin_list_sessions(uuid);
create function public.admin_list_sessions(p_actor_id uuid, p_filter text default 'ACTIVE')
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
  updated_at timestamptz,
  participants jsonb
)
language plpgsql security definer set search_path = public as $$
declare
  normalized_filter text := upper(coalesce(nullif(trim(p_filter), ''), 'ACTIVE'));
begin
  if not public.is_active_admin(p_actor_id) then raise exception 'ADMIN_FORBIDDEN' using errcode = '42501'; end if;
  perform public.expire_pre_reservations();
  return query
  select s.id, e.id, e.title, s.starts_at, s.duration_minutes, s.price_cents, s.capacity, public.available_spots(s.id), count(r.id), s.status, s.internal_notes, s.created_at, s.updated_at,
    coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.full_name, 'quantity', r.quantity, 'status', r.status) order by r.full_name) filter (where r.id is not null and r.status in ('CONFIRMED', 'PRE_RESERVED', 'CANCELLED')), '[]'::jsonb)
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  left join public.reservations r on r.session_id = s.id
  where
    normalized_filter = 'ALL'
    or (normalized_filter = 'ARCHIVED' and s.status = 'ARCHIVED')
    or (normalized_filter not in ('ALL', 'ARCHIVED') and s.status <> 'ARCHIVED')
  group by s.id, e.id, e.title
  order by s.starts_at desc;
end $$;

revoke all on function public.admin_list_sessions(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_list_sessions(uuid, text) to service_role;

-- 4. admin_dashboard_metrics: sessões arquivadas não devem contar como
--    "próxima sessão", "sessões futuras" nem entrar na ocupação média,
--    igual ao tratamento que sessões CANCELLED já recebem. Nenhuma métrica
--    de reservas/receita muda, pois elas nunca filtraram por sessions.status.
create or replace function public.admin_dashboard_metrics(p_actor_id uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare result jsonb; begin
  if not public.is_active_admin(p_actor_id) then raise exception 'ADMIN_FORBIDDEN' using errcode = '42501'; end if;
  select jsonb_build_object(
    'nextSession', (select jsonb_build_object('id', s.id, 'experienceTitle', e.title, 'startsAt', s.starts_at, 'remainingSpots', public.available_spots(s.id)) from public.sessions s join public.experiences e on e.id = s.experience_id where s.starts_at > now() and s.status not in ('CANCELLED', 'ARCHIVED') order by s.starts_at limit 1),
    'futureSessions', (select count(*) from public.sessions where starts_at > now() and status not in ('CANCELLED', 'ARCHIVED')),
    'confirmedReservations', (select count(*) from public.reservations where status = 'CONFIRMED'),
    'totalReservations', (select count(*) from public.reservations),
    'preReservations', (select count(*) from public.reservations where status = 'PRE_RESERVED' and expires_at > now()),
    'expectedRevenueCents', (select coalesce(sum(total_cents), 0) from public.reservations where status = 'CONFIRMED' or (status = 'PRE_RESERVED' and expires_at > now())),
    'confirmedRevenueCents', (select coalesce(sum(total_cents), 0) from public.reservations where status = 'CONFIRMED'),
    'totalParticipants', (select coalesce(sum(quantity), 0) from public.reservations where status = 'CONFIRMED'),
    'averageOccupancyRate', (select coalesce(round(avg((s.capacity - public.available_spots(s.id)) * 100.0 / nullif(s.capacity, 0)), 1), 0) from public.sessions s where s.starts_at > now() and s.status not in ('CANCELLED', 'ARCHIVED')),
    'topExperience', (select e.title from public.reservations r join public.experiences e on e.id = r.experience_id where r.status = 'CONFIRMED' group by e.id, e.title order by sum(r.quantity) desc limit 1),
    'monthlyRevenueCents', (select coalesce(sum(total_cents), 0) from public.reservations where status = 'CONFIRMED' and confirmed_at >= date_trunc('month', now())),
    'averageTicketCents', (select coalesce(round(avg(total_cents)), 0) from public.reservations where status = 'CONFIRMED'),
    'revenueByMonth', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m.month, 'Mon'), 'revenueCents', coalesce(x.total, 0)) order by m.month), '[]'::jsonb) from generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') m(month) left join lateral (select sum(total_cents) total from public.reservations where status = 'CONFIRMED' and confirmed_at >= m.month and confirmed_at < m.month + interval '1 month') x on true),
    'lastUpdatedAt', greatest(coalesce((select max(updated_at) from public.experiences), '-infinity'::timestamptz), coalesce((select max(updated_at) from public.sessions), '-infinity'::timestamptz), coalesce((select max(updated_at) from public.reservations), '-infinity'::timestamptz))
  ) into result; return result;
end $$;
