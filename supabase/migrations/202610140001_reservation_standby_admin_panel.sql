-- Stand-by de reservas: leituras e reagendamento do painel administrativo.
--
-- Depende de `202610130002_reservation_standby.sql`. Idempotente. Faz duas
-- coisas, e só elas:
--
--   1. cria quatro funções;
--   2. retira da service role a permissão de executar
--      `admin_reschedule_reservation_from_standby` — o reagendamento de
--      Stand-by **sem** régua de preço, da etapa anterior (seção 6).
--
-- Nenhuma tabela, trigger, constraint ou linha é tocada, e o corpo de nenhuma
-- função existente muda. `admin_change_reservation_session` (reagendamento
-- tradicional) e `reservation_standby_resolve` continuam exatamente como estão,
-- com os mesmos privilégios.
--
-- Depois de aplicada, nada muda no comportamento do sistema: as funções só são
-- chamadas pelas rotas do painel de Stand-by, que ficam desligadas enquanto a
-- variável `STANDBY_ADMIN_ENABLED` não for `true`.
--
-- ## O que entra
--
--   * `admin_list_standby_reservations_page` — a lista "Aguardando
--     reagendamento" com busca, filtros e paginação. A função da etapa
--     anterior, `admin_list_standby_reservations`, devolve no máximo 500
--     linhas sem página seguinte; ela permanece, sem uso pelo painel.
--   * `admin_standby_reschedule_options` — o que o admin vê ao reagendar: a
--     reserva, a turma original, se dá para desfazer e as turmas elegíveis.
--   * `admin_reschedule_standby_same_price` — reagenda pelo painel exigindo a
--     mesma régua do cliente: turma aberta, futura, publicada, base em operação
--     e **preço por participante igual ao valor unitário pago**.
--   * `admin_reservation_standby_history` — a trilha de cada entrada em
--     Stand-by, para o detalhe da reserva. Nunca devolve token nem hash.
--
-- ## O que sai do alcance do servidor
--
--   * `admin_reschedule_reservation_from_standby` continua no banco, com o mesmo
--     corpo, mas ninguém mais a executa pela API: o único reagendamento de
--     Stand-by ao alcance do painel passa a ser o que exige o mesmo valor.

-- ---------------------------------------------------------------------------
-- 1. Lista paginada
-- ---------------------------------------------------------------------------
--
-- Só autorizações abertas de reservas ainda em Stand-by, a mais antiga primeiro
-- (quem espera há mais tempo aparece antes). Traz o contato porque é para a
-- equipe falar com o cliente; nunca CPF, hash de CPF nem o hash do link.
--
-- `total`, `totalParticipants` e `totalCents` são do conjunto filtrado inteiro,
-- não só da página.
create or replace function public.admin_list_standby_reservations_page(
  p_actor_id uuid,
  p_query text,
  p_base_id uuid,
  p_link text,
  p_limit integer,
  p_offset integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  batch integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  skip integer := greatest(coalesce(p_offset, 0), 0);
  needle text := nullif(trim(coalesce(p_query, '')), '');
  digits text := regexp_replace(coalesce(p_query, ''), E'\\D', '', 'g');
  link_filter text := upper(nullif(trim(coalesce(p_link, '')), ''));
  pattern text;
  result jsonb;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if link_filter is not null and link_filter not in ('WITH', 'WITHOUT') then
    raise exception 'STANDBY_INVALID_FILTER' using errcode = '22023';
  end if;
  if needle is not null and char_length(needle) > 120 then
    raise exception 'STANDBY_INVALID_FILTER' using errcode = '22023';
  end if;

  -- O texto digitado é comparado literalmente: % e _ não viram curinga.
  if needle is not null then
    pattern := '%' || replace(replace(replace(needle, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
  end if;

  with matched as (
    select
      sb.id as standby_id,
      sb.created_at as entered_at,
      r.quantity,
      r.total_cents,
      jsonb_build_object(
        'standbyId', sb.id,
        'reservationId', r.id,
        'publicCode', r.public_code,
        'fullName', r.full_name,
        'phone', r.phone,
        'email', r.email,
        'quantity', r.quantity,
        'unitPriceCents', r.unit_price_cents,
        'totalCents', r.total_cents,
        'originalSessionId', sb.original_session_id,
        'originalStartsAt', sb.original_starts_at,
        'originalExperienceId', sb.original_experience_id,
        'originalExperienceTitle', coalesce(e.title, ''),
        'originalBaseId', sb.original_base_id,
        'originalBaseName', coalesce(b.name, ''),
        'enteredAt', sb.created_at,
        'enteredByName', coalesce(au.display_name, ''),
        'reason', sb.reason,
        'hasActiveLink', sb.link_token_hash is not null,
        'linkCreatedAt', case when sb.link_token_hash is not null then sb.link_created_at else null end
      ) as item
    from public.reservation_standby sb
    join public.reservations r on r.id = sb.reservation_id
    left join public.experiences e on e.id = sb.original_experience_id
    left join public.bases b on b.id = sb.original_base_id
    left join public.admin_users au on au.user_id = sb.created_by
    where sb.resolved_at is null
      and r.status = 'AWAITING_RESCHEDULE'
      and (p_base_id is null or sb.original_base_id = p_base_id)
      and (link_filter is null or (link_filter = 'WITH') = (sb.link_token_hash is not null))
      and (
        pattern is null
        or r.full_name ilike pattern
        or r.public_code ilike pattern
        or (char_length(digits) >= 4 and regexp_replace(r.phone, E'\\D', '', 'g') like '%' || digits || '%')
      )
  )
  select jsonb_build_object(
    'total', (select count(*) from matched),
    'totalParticipants', (select coalesce(sum(quantity), 0) from matched),
    'totalCents', (select coalesce(sum(total_cents), 0) from matched),
    'limit', batch,
    'offset', skip,
    'items', (
      select coalesce(jsonb_agg(page.item order by page.entered_at, page.standby_id), '[]'::jsonb)
      from (
        select m.item, m.entered_at, m.standby_id
        from matched m
        order by m.entered_at, m.standby_id
        limit batch offset skip
      ) page
    )
  ) into result;

  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Opções de reagendamento do painel
-- ---------------------------------------------------------------------------
--
-- A lista de turmas usa a régua `CUSTOMER` de
-- `reservation_standby_target_rejection` — a mesma que decide o reagendamento
-- em `admin_reschedule_standby_same_price`, logo abaixo. A tela e a decisão não
-- têm como divergir. Turmas sem vaga para o grupo inteiro não são oferecidas e
-- são contadas à parte.
--
-- `restore` diz se "Desfazer Stand-by" é possível agora: a turma original
-- precisa estar aberta, no futuro e com vagas para o grupo. Informativo — quem
-- decide de verdade é `admin_undo_reservation_standby`, com a sessão travada.
create or replace function public.admin_standby_reschedule_options(
  p_actor_id uuid,
  p_reservation_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  target public.reservations%rowtype;
  standby public.reservation_standby%rowtype;
  options jsonb;
  hidden_for_capacity integer;
  restore_rejection text;
  restore_spots integer;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  select * into target from public.reservations where id = p_reservation_id;
  if not found then return null; end if;

  select * into standby
  from public.reservation_standby
  where reservation_id = p_reservation_id and resolved_at is null;
  if not found or target.status <> 'AWAITING_RESCHEDULE' then
    raise exception 'RESERVATION_NOT_IN_STANDBY' using errcode = 'P0001';
  end if;

  select
    coalesce(jsonb_agg(candidate.option order by candidate.starts_at, candidate.experience_title) filter (where candidate.fits), '[]'::jsonb),
    count(*) filter (where not candidate.fits)::integer
  into options, hidden_for_capacity
  from (
    select
      s.starts_at,
      e.title as experience_title,
      public.available_spots(s.id) >= target.quantity as fits,
      jsonb_build_object(
        'sessionId', s.id,
        'experienceId', e.id,
        'experienceTitle', e.title,
        'baseId', b.id,
        'baseName', b.name,
        'startsAt', s.starts_at,
        'durationMinutes', s.duration_minutes,
        'capacity', s.capacity,
        'remainingSpots', public.available_spots(s.id),
        'priceCents', s.price_cents,
        'isOriginal', s.id = standby.original_session_id
      ) as option
    from public.sessions s
    join public.experiences e on e.id = s.experience_id
    join public.bases b on b.id = e.base_id
    where s.status = 'OPEN'
      and s.starts_at > now()
      and public.reservation_standby_target_rejection(target.id, s.id, 'CUSTOMER') is null
  ) candidate;

  restore_rejection := public.reservation_standby_target_rejection(target.id, standby.original_session_id, 'RESTORE');
  restore_spots := coalesce(public.available_spots(standby.original_session_id), 0);
  if restore_rejection is null and restore_spots < target.quantity then
    restore_rejection := 'INSUFFICIENT_SPOTS';
  end if;

  return jsonb_build_object(
    'standbyId', standby.id,
    'reservationId', target.id,
    'publicCode', target.public_code,
    'fullName', target.full_name,
    'status', target.status,
    'quantity', target.quantity,
    'unitPriceCents', target.unit_price_cents,
    'totalCents', target.total_cents,
    'enteredAt', standby.created_at,
    'reason', standby.reason,
    'original', (
      select jsonb_build_object(
        'sessionId', standby.original_session_id,
        'startsAt', standby.original_starts_at,
        'experienceId', standby.original_experience_id,
        'experienceTitle', coalesce(e.title, ''),
        'baseName', coalesce(b.name, '')
      )
      from (select 1) one
      left join public.experiences e on e.id = standby.original_experience_id
      left join public.bases b on b.id = standby.original_base_id
    ),
    'restore', jsonb_build_object(
      'allowed', restore_rejection is null,
      'rejection', restore_rejection,
      'remainingSpots', restore_spots
    ),
    'hasActiveLink', standby.link_token_hash is not null,
    'linkCreatedAt', case when standby.link_token_hash is not null then standby.link_created_at else null end,
    'hiddenForCapacity', coalesce(hidden_for_capacity, 0),
    'options', options
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Reagendamento pelo painel, com a régua do mesmo valor
-- ---------------------------------------------------------------------------
--
-- `admin_reschedule_reservation_from_standby`, da etapa anterior, segue a regra
-- do reagendamento tradicional: sem restrição de preço. O painel de Stand-by
-- exige mais — a turma de destino precisa custar, por participante, exatamente
-- o valor unitário pago — e essa exigência fica aqui, no banco, e não só na
-- tela. A seção 6 tira a função antiga do alcance da service role, para esta ser
-- a única porta.
--
-- A conferência do preço e a mudança acontecem na mesma transação — a desta
-- chamada. Se a régua recusa, a exceção desfaz tudo; se aceita, a sessão de
-- destino continua travada até o núcleo terminar, então o preço conferido é o
-- preço com que a reserva é movida.
--
-- Locks: reserva primeiro, sessão de destino depois — a mesma ordem do núcleo
-- (`reservation_standby_resolve`), que volta a travar as duas dentro da mesma
-- transação. A régua é conferida com as duas linhas travadas; capacidade,
-- consumo da autorização, histórico e auditoria continuam sendo do núcleo.
--
-- Com a autorização já encerrada a régua não é reaplicada: o núcleo devolve o
-- resultado gravado quando é a repetição da mesma requisição, ou recusa com
-- STANDBY_ALREADY_USED.
create or replace function public.admin_reschedule_standby_same_price(
  p_actor_id uuid,
  p_reservation_id uuid,
  p_target_session_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.reservations%rowtype;
  latest_id uuid;
  rejection text;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if p_target_session_id is null then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001';
  end if;

  select * into target from public.reservations where id = p_reservation_id for update;
  if not found then return null; end if;

  latest_id := public.reservation_latest_standby(p_reservation_id);
  if latest_id is null then
    raise exception 'RESERVATION_NOT_IN_STANDBY' using errcode = 'P0001';
  end if;

  if target.status = 'AWAITING_RESCHEDULE' then
    perform 1 from public.sessions where id = p_target_session_id for update;
    if not found then
      raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001';
    end if;
    rejection := public.reservation_standby_target_rejection(target.id, p_target_session_id, 'CUSTOMER');
    if rejection is not null then
      raise exception '%', rejection using errcode = 'P0001';
    end if;
  end if;

  return public.reservation_standby_resolve(latest_id, p_target_session_id, 'ADMIN', p_actor_id, 'ADMIN', p_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Trilha do Stand-by de uma reserva
-- ---------------------------------------------------------------------------
--
-- `cycles`: uma entrada por vez que a reserva esteve em Stand-by — quem colocou,
-- por quê, quando, e como saiu. `events`: as ações registradas na auditoria,
-- inclusive geração e revogação de link. Do link só saem datas e nomes: o token
-- não existe no banco e o hash nunca é devolvido. Os metadados da auditoria
-- também ficam de fora; só o tipo de ator e a forma de acesso são lidos deles.
create or replace function public.admin_reservation_standby_history(
  p_actor_id uuid,
  p_reservation_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  cycles jsonb;
  events jsonb;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (select 1 from public.reservations where id = p_reservation_id) then
    return null;
  end if;

  select coalesce(jsonb_agg(cycle.item order by cycle.entered_at, cycle.standby_id), '[]'::jsonb) into cycles
  from (
    select
      sb.created_at as entered_at,
      sb.id as standby_id,
      jsonb_build_object(
        'standbyId', sb.id,
        'enteredAt', sb.created_at,
        'enteredByName', coalesce(entered_by.display_name, ''),
        'reason', sb.reason,
        'quantity', sb.quantity,
        'totalCents', sb.total_cents,
        'originalSessionId', sb.original_session_id,
        'originalStartsAt', sb.original_starts_at,
        'originalExperienceTitle', coalesce(origin_experience.title, ''),
        'originalBaseName', coalesce(origin_base.name, ''),
        'open', sb.resolved_at is null,
        'resolution', sb.resolution,
        'resolvedAt', sb.resolved_at,
        'resolvedByType', sb.resolved_by_type,
        'resolvedByName', coalesce(resolved_by.display_name, ''),
        'resolvedAccess', sb.resolved_access,
        'resolvedReason', sb.resolved_reason,
        'targetSessionId', sb.resolved_session_id,
        'targetStartsAt', destination.starts_at,
        'targetExperienceTitle', coalesce(destination_experience.title, ''),
        'targetBaseName', coalesce(destination_base.name, ''),
        'hasActiveLink', sb.resolved_at is null and sb.link_token_hash is not null,
        'linkCreatedAt', sb.link_created_at,
        'linkCreatedByName', coalesce(link_by.display_name, ''),
        'linkRevokedAt', sb.link_revoked_at
      ) as item
    from public.reservation_standby sb
    left join public.admin_users entered_by on entered_by.user_id = sb.created_by
    left join public.admin_users resolved_by on resolved_by.user_id = sb.resolved_by
    left join public.admin_users link_by on link_by.user_id = sb.link_created_by
    left join public.experiences origin_experience on origin_experience.id = sb.original_experience_id
    left join public.bases origin_base on origin_base.id = sb.original_base_id
    left join public.sessions destination on destination.id = sb.resolved_session_id
    left join public.experiences destination_experience on destination_experience.id = destination.experience_id
    left join public.bases destination_base on destination_base.id = destination_experience.base_id
    where sb.reservation_id = p_reservation_id
  ) cycle;

  select coalesce(jsonb_agg(entry.item order by entry.created_at, entry.id), '[]'::jsonb) into events
  from (
    select
      a.created_at,
      a.id,
      jsonb_build_object(
        'id', a.id,
        'at', a.created_at,
        'action', a.action,
        'actorName', coalesce(au.display_name, ''),
        'actorType', coalesce(a.metadata ->> 'actorType', 'ADMIN'),
        'access', a.metadata ->> 'access',
        'reason', a.reason
      ) as item
    from public.admin_audit_log a
    left join public.admin_users au on au.user_id = a.actor_user_id
    where a.entity_type = 'RESERVATION'
      and a.entity_id = p_reservation_id
      and a.action in (
        'RESERVATION_STANDBY_SET',
        'RESERVATION_STANDBY_RESTORED',
        'RESERVATION_STANDBY_RESCHEDULED',
        'RESERVATION_STANDBY_LINK_GENERATED',
        'RESERVATION_STANDBY_LINK_REVOKED'
      )
  ) entry;

  return jsonb_build_object('cycles', cycles, 'events', events);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------
--
-- No Supabase, função nova nasce executável por PUBLIC e, pelos privilégios
-- padrão do projeto, por anon e authenticated. Tudo é revogado antes de
-- conceder: somente a service role executa, e cada função confere o ator.
revoke all on function public.admin_list_standby_reservations_page(uuid, text, uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_standby_reschedule_options(uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_reschedule_standby_same_price(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_reservation_standby_history(uuid, uuid) from public, anon, authenticated;

grant execute on function public.admin_list_standby_reservations_page(uuid, text, uuid, text, integer, integer) to service_role;
grant execute on function public.admin_standby_reschedule_options(uuid, uuid) to service_role;
grant execute on function public.admin_reschedule_standby_same_price(uuid, uuid, uuid, text) to service_role;
grant execute on function public.admin_reservation_standby_history(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. O reagendamento sem régua de preço sai do alcance do servidor
-- ---------------------------------------------------------------------------
--
-- `admin_reschedule_reservation_from_standby` reagenda uma reserva em Stand-by
-- para turma de qualquer preço. Nenhum código a chama — o painel usa
-- `admin_reschedule_standby_same_price` e o cliente usa
-- `customer_reschedule_reservation`, as duas com a régua do mesmo valor — mas,
-- enquanto a service role pudesse executá-la, uma rota futura poderia contornar
-- a regra por engano.
--
-- A função é preservada, com o mesmo corpo: só o privilégio de execução é
-- retirado. Sem ele, a chamada pela API é recusada pelo Postgres antes de
-- qualquer linha ser lida. O rollback desta migration devolve o privilégio.
--
-- `admin_change_reservation_session` não é tocada: o reagendamento tradicional,
-- de reserva confirmada, continua sem régua de preço, por decisão de negócio.
--
-- Reaplicar `202610130002_reservation_standby.sql` depois desta migration
-- devolveria o privilégio (ela o concede). O postcheck do painel acusa.
revoke all on function public.admin_reschedule_reservation_from_standby(uuid, uuid, uuid, text) from public, anon, authenticated, service_role;
