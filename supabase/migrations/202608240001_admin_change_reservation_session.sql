-- Alteração administrativa da turma de uma reserva já confirmada.
--
-- O caso real: o cliente pagou, a reserva está CONFIRMED, e depois precisa
-- trocar de dia ou de horário. Hoje isso só era possível cancelando e refazendo
-- a reserva — o que gera nova cobrança, novo `public_code` e perde o histórico
-- de pagamento. Esta migration cria o caminho correto: a **mesma** reserva
-- passa a apontar para outra sessão.
--
-- Aditiva e idempotente. Não reescreve nenhuma migration histórica, não altera
-- nenhuma função existente e não toca em nenhuma linha de reservations,
-- sessions, experiences ou payment_events na aplicação.
--
-- ## O que esta operação deliberadamente NÃO faz
--
--   * não cria reserva nova nem cancela a atual;
--   * não gera cobrança, estorno ou evento de pagamento;
--   * não recalcula preço — `unit_price_cents` é coluna da própria reserva e
--     `total_cents` é gerada a partir dela, então o valor pago sobrevive
--     intacto a qualquer diferença de preço entre as duas sessões. A diferença
--     é *registrada* no histórico, nunca cobrada;
--   * não muda `public_code`, cliente, CPF, quantidade, status nem
--     `confirmed_at`.
--
-- O resultado é exatamente um UPDATE de `session_id` — cercado pelas validações
-- e pelos locks que impedem overbooking.

-- 1. Histórico tipado da mudança ---------------------------------------------
--
-- `admin_audit_log` já existe e continua recebendo uma linha por alteração,
-- porque é a trilha única de toda mutação administrativa. Mas ela guarda o
-- contexto em `metadata jsonb` e só um `entity_id`, o que não permite responder
-- "quais reservas saíram da turma das 09:00?" sem varrer JSON.
--
-- Esta tabela é a resposta tipada: duas FKs de sessão, o ator, a quantidade
-- movida e o valor preservado. Nada aqui é apagado, e `on delete restrict`
-- garante que o histórico não some junto com uma sessão excluída.
create table if not exists public.reservation_session_changes (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete restrict,
  previous_session_id uuid not null references public.sessions(id) on delete restrict,
  target_session_id uuid not null references public.sessions(id) on delete restrict,
  actor_user_id uuid references auth.users(id) on delete set null,
  quantity integer not null,
  unit_price_cents integer not null,
  total_cents integer not null,
  previous_session_price_cents integer,
  target_session_price_cents integer,
  reason text,
  created_at timestamptz not null default now()
);

alter table public.reservation_session_changes
  add column if not exists previous_session_price_cents integer,
  add column if not exists target_session_price_cents integer,
  add column if not exists reason text;

do $$ begin
  alter table public.reservation_session_changes
    add constraint reservation_session_changes_distinct_sessions
    check (previous_session_id <> target_session_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.reservation_session_changes
    add constraint reservation_session_changes_quantity_positive
    check (quantity > 0);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.reservation_session_changes
    add constraint reservation_session_changes_amounts_nonnegative
    check (unit_price_cents >= 0 and total_cents >= 0);
exception when duplicate_object then null;
end $$;

-- O motivo é texto operacional interno e nunca aparece no site público. O
-- limite acompanha o de `reservations.notes` e o dos motivos já usados nas
-- outras ações administrativas.
do $$ begin
  alter table public.reservation_session_changes
    add constraint reservation_session_changes_reason_length
    check (reason is null or char_length(reason) <= 500);
exception when duplicate_object then null;
end $$;

create index if not exists reservation_session_changes_reservation_idx
  on public.reservation_session_changes (reservation_id, created_at desc);
create index if not exists reservation_session_changes_target_idx
  on public.reservation_session_changes (target_session_id, created_at desc);
create index if not exists reservation_session_changes_previous_idx
  on public.reservation_session_changes (previous_session_id, created_at desc);
create index if not exists reservation_session_changes_actor_idx
  on public.reservation_session_changes (actor_user_id, created_at desc);

-- 2. A operação transacional --------------------------------------------------
--
-- ## Por que os locks são desta forma
--
-- Duas trocas simultâneas disputando as últimas vagas da mesma turma precisam
-- ser serializadas, exatamente como `create_pre_reservation` já serializa duas
-- pré-reservas. A diferença é que aqui **duas** sessões entram na transação, o
-- que abre espaço para deadlock: mover A de S1 para S2 enquanto alguém move B
-- de S2 para S1 travaria as duas transações se cada uma pegasse "a sua origem"
-- primeiro.
--
-- A solução é travar as duas sessões sempre na mesma ordem — a ordem dos ids —
-- independentemente de qual é a origem e qual é o destino. Com isso as duas
-- transações pedem os mesmos locks na mesma sequência e uma simplesmente espera
-- a outra.
--
-- A ocupação do destino é recalculada **depois** do lock, a partir das linhas
-- reais de `reservations`. É esse recálculo, e não o número que o navegador
-- exibiu, que decide se a mudança acontece.
--
-- Qualquer exceção levantada aqui aborta a transação inteira: nem o
-- `session_id`, nem o histórico, nem a linha de auditoria sobrevivem
-- parcialmente.
create or replace function public.admin_change_reservation_session(
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
  origin_session public.sessions%rowtype;
  destination_session public.sessions%rowtype;
  occupied integer;
  normalized_reason text := nullif(trim(coalesce(p_reason, '')), '');
  change_id uuid;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if p_target_session_id is null then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001';
  end if;
  if normalized_reason is not null and char_length(normalized_reason) > 500 then
    raise exception 'REASON_TOO_LONG' using errcode = '22023';
  end if;

  -- Trava a reserva antes de qualquer leitura de sessão: enquanto esta
  -- transação vive, ninguém confirma, cancela ou move esta mesma reserva.
  select * into target from public.reservations where id = p_reservation_id for update;
  if not found then return null; end if;

  -- Só reserva confirmada troca de turma. Pré-reserva tem caminho próprio
  -- (expira sozinha), e expirada ou cancelada não ocupa vaga para mover.
  if target.status <> 'CONFIRMED' then
    raise exception 'RESERVATION_NOT_CONFIRMED' using errcode = 'P0001';
  end if;

  -- Mover para a própria turma é ruído: gera histórico falso e nenhuma mudança.
  if target.session_id = p_target_session_id then
    raise exception 'SAME_SESSION' using errcode = 'P0001';
  end if;

  -- Ordem determinística de lock. Ver a nota de deadlock acima.
  if target.session_id < p_target_session_id then
    select * into origin_session from public.sessions where id = target.session_id for update;
    select * into destination_session from public.sessions where id = p_target_session_id for update;
  else
    select * into destination_session from public.sessions where id = p_target_session_id for update;
    select * into origin_session from public.sessions where id = target.session_id for update;
  end if;

  if destination_session.id is null then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001';
  end if;
  if origin_session.id is null then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- Trocar de experiência é trocar de produto, não de horário: mudaria o que
  -- foi comprado e deixaria `reservations.experience_id` divergindo da sessão.
  -- Fora do escopo desta versão, e barrado no banco para não depender da tela.
  if destination_session.experience_id is distinct from target.experience_id then
    raise exception 'SESSION_EXPERIENCE_MISMATCH' using errcode = 'P0001';
  end if;

  -- "Disponível para receber reservas" é exatamente o que o motor público já
  -- entende por isso: status OPEN. Fechada, cancelada ou arquivada não recebe.
  if destination_session.status <> 'OPEN' then
    raise exception 'SESSION_NOT_OPEN' using errcode = 'P0001';
  end if;

  if destination_session.starts_at <= now() then
    raise exception 'SESSION_MUST_BE_FUTURE' using errcode = '22023';
  end if;

  -- Retenções vencidas do destino deixam de ocupar vaga, do mesmo jeito que
  -- `admin_confirm_reservation` já faz antes de contar. Recorte por sessão:
  -- esta transação não precisa varrer a tabela inteira.
  update public.reservations
  set status = 'EXPIRED', updated_at = now()
  where session_id = destination_session.id
    and status = 'PRE_RESERVED'
    and expires_at <= now();

  select coalesce(sum(quantity), 0)::integer into occupied
  from public.reservations
  where session_id = destination_session.id
    and id <> target.id
    and (status = 'CONFIRMED' or (status = 'PRE_RESERVED' and expires_at > now()));

  -- A reserva vai inteira ou não vai: `target.quantity` entra na conta de uma
  -- vez só. Não existe mover parte dos participantes.
  if occupied + target.quantity > destination_session.capacity then
    raise exception 'INSUFFICIENT_SPOTS' using errcode = 'P0001';
  end if;

  -- A mudança em si. Tudo que não está aqui permanece como estava:
  -- status, confirmed_at, public_code, quantity, unit_price_cents,
  -- total_cents (gerada), cliente, CPF, provedor e referência de pagamento.
  update public.reservations
  set session_id = destination_session.id,
      updated_at = now()
  where id = target.id;

  insert into public.reservation_session_changes (
    reservation_id,
    previous_session_id,
    target_session_id,
    actor_user_id,
    quantity,
    unit_price_cents,
    total_cents,
    previous_session_price_cents,
    target_session_price_cents,
    reason
  ) values (
    target.id,
    origin_session.id,
    destination_session.id,
    p_actor_id,
    target.quantity,
    target.unit_price_cents,
    target.total_cents,
    origin_session.price_cents,
    destination_session.price_cents,
    normalized_reason
  )
  returning id into change_id;

  -- A trilha administrativa única continua recebendo a ação, como toda outra
  -- mutação do painel.
  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, reason, metadata)
  values (
    p_actor_id,
    'RESERVATION_SESSION_CHANGED',
    'RESERVATION',
    target.id,
    normalized_reason,
    jsonb_build_object(
      'changeId', change_id,
      'previousSessionId', origin_session.id,
      'previousStartsAt', origin_session.starts_at,
      'targetSessionId', destination_session.id,
      'targetStartsAt', destination_session.starts_at,
      'quantity', target.quantity,
      'unitPriceCents', target.unit_price_cents,
      'totalCents', target.total_cents,
      'priceDiffers', origin_session.price_cents is distinct from destination_session.price_cents
    )
  );

  return jsonb_build_object(
    'moved', true,
    'changeId', change_id,
    'reservationId', target.id,
    'publicCode', target.public_code,
    'status', target.status,
    'quantity', target.quantity,
    'totalCents', target.total_cents,
    'previousSessionId', origin_session.id,
    'previousStartsAt', origin_session.starts_at,
    'targetSessionId', destination_session.id,
    'targetStartsAt', destination_session.starts_at
  );
end;
$$;

-- 3. Turmas de destino oferecidas ao admin ------------------------------------
--
-- A regra de disponibilidade fica aqui, não na tela: o navegador recebe uma
-- lista já recortada e um `fits` calculado pelo banco. Se a tela errar, a RPC de
-- mudança recusa de novo — a lista é conveniência, não autorização.
create or replace function public.admin_reservation_session_options(
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
  current_block jsonb;
  options jsonb;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  select * into target from public.reservations where id = p_reservation_id;
  if not found then return null; end if;

  select jsonb_build_object(
    'sessionId', s.id,
    'experienceId', e.id,
    'experienceTitle', e.title,
    'startsAt', s.starts_at,
    'durationMinutes', s.duration_minutes,
    'capacity', s.capacity,
    'remainingSpots', public.available_spots(s.id),
    'priceCents', s.price_cents,
    'status', s.status
  ) into current_block
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  where s.id = target.session_id;

  -- `available_spots` já ignora retenções vencidas, então a lista não depende
  -- de o cron ter rodado no último minuto.
  select coalesce(jsonb_agg(candidate.option order by candidate.starts_at), '[]'::jsonb)
  into options
  from (
    select
      s.starts_at,
      jsonb_build_object(
        'sessionId', s.id,
        'experienceId', e.id,
        'experienceTitle', e.title,
        'startsAt', s.starts_at,
        'durationMinutes', s.duration_minutes,
        'capacity', s.capacity,
        'remainingSpots', public.available_spots(s.id),
        'priceCents', s.price_cents,
        'status', s.status,
        'fits', public.available_spots(s.id) >= target.quantity
      ) as option
    from public.sessions s
    join public.experiences e on e.id = s.experience_id
    where s.experience_id = target.experience_id
      and s.id <> target.session_id
      and s.status = 'OPEN'
      and s.starts_at > now()
  ) candidate;

  return jsonb_build_object(
    'reservationId', target.id,
    'publicCode', target.public_code,
    'fullName', target.full_name,
    'status', target.status,
    'quantity', target.quantity,
    'totalCents', target.total_cents,
    'current', current_block,
    'options', options
  );
end;
$$;

-- 4. Histórico exibido no detalhe da reserva -----------------------------------
create or replace function public.admin_list_reservation_session_changes(
  p_actor_id uuid,
  p_reservation_id uuid
)
returns table (
  id uuid,
  created_at timestamptz,
  actor_user_id uuid,
  actor_name text,
  previous_session_id uuid,
  previous_starts_at timestamptz,
  target_session_id uuid,
  target_starts_at timestamptz,
  quantity integer,
  unit_price_cents integer,
  total_cents integer,
  previous_session_price_cents integer,
  target_session_price_cents integer,
  reason text
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
    c.id,
    c.created_at,
    c.actor_user_id,
    coalesce(a.display_name, ''),
    c.previous_session_id,
    previous.starts_at,
    c.target_session_id,
    destination.starts_at,
    c.quantity,
    c.unit_price_cents,
    c.total_cents,
    c.previous_session_price_cents,
    c.target_session_price_cents,
    c.reason
  from public.reservation_session_changes c
  join public.sessions previous on previous.id = c.previous_session_id
  join public.sessions destination on destination.id = c.target_session_id
  left join public.admin_users a on a.user_id = c.actor_user_id
  where c.reservation_id = p_reservation_id
  order by c.created_at desc
  limit 100;
end;
$$;

-- 5. Grants --------------------------------------------------------------------
--
-- Mesma regra das demais RPCs administrativas: execução revogada de public,
-- anon e authenticated; somente a service role executa, e o servidor deriva
-- `p_actor_id` da sessão validada — nunca do payload do cliente.
alter table public.reservation_session_changes enable row level security;
revoke all on public.reservation_session_changes from anon, authenticated;

revoke all on function public.admin_change_reservation_session(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_reservation_session_options(uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_list_reservation_session_changes(uuid, uuid) from public, anon, authenticated;

grant execute on function public.admin_change_reservation_session(uuid, uuid, uuid, text) to service_role;
grant execute on function public.admin_reservation_session_options(uuid, uuid) to service_role;
grant execute on function public.admin_list_reservation_session_changes(uuid, uuid) to service_role;
