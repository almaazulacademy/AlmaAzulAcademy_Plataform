-- Reagendamento administrativo entre experiências diferentes.
--
-- A migration 202608240001 abriu o caminho da troca de turma: a *mesma* reserva
-- passa a apontar para outra sessão, sem nova cobrança, sem novo `public_code` e
-- sem perder o pagamento. Ela deliberadamente parou na fronteira da experiência
-- — `SESSION_EXPERIENCE_MISMATCH` — porque `reservations.experience_id` é uma
-- coluna própria da reserva e, movendo só o `session_id`, a reserva ficaria
-- apontando para a experiência antiga com a data da nova.
--
-- Isso não é hipotético: `admin_get_reservation`, `admin_list_reservations`,
-- `lookup_reservation` (acompanhamento público por CPF + código) e
-- `reservation_confirmation_email` resolvem a experiência por
-- `join public.experiences e on e.id = r.experience_id`. Mover só a sessão
-- deixaria as quatro contando uma história errada.
--
-- Esta migration remove a fronteira **pelo caminho certo**: a operação passa a
-- escrever as duas colunas — `session_id` e `experience_id` — dentro da mesma
-- transação, e a coerência entre elas vira invariante do banco, garantida por
-- trigger e reconferida depois da escrita. A proteção não foi retirada; ela foi
-- substituída por uma mais forte.
--
-- Aditiva e idempotente. Não reescreve nenhuma migration histórica, não apaga
-- nenhuma linha e não altera nenhuma reserva existente.
--
-- ## O que continua valendo, sem exceção
--
--   * a reserva é a mesma: mesmo `id`, mesmo `public_code`, mesmo status
--     CONFIRMED, mesmo `confirmed_at`, mesmo cliente, mesma quantidade;
--   * nenhuma reserva nova é criada e nenhuma reserva antiga é cancelada;
--   * nenhum evento de pagamento, cobrança, estorno ou checkout é gerado;
--   * `unit_price_cents` — o valor efetivamente pago — não é recalculado. Uma
--     experiência de destino mais cara ou mais barata **não** muda o que foi
--     pago. A diferença é registrada no histórico como informação, nunca
--     cobrada;
--   * capacidade é validada com as duas sessões travadas, na mesma ordem
--     determinística de antes, e a reserva vai inteira ou não vai.

-- 1. Histórico: as duas experiências, explicitamente ------------------------
--
-- As experiências poderiam ser derivadas por join a partir das sessões, mas
-- derivação não é histórico: se uma sessão futura for corrigida para outra
-- experiência (o que `admin_update_session` permite enquanto ela não tem
-- reservas), o passado passaria a ser lido errado. As duas colunas guardam o
-- que era verdade no instante da troca.
alter table public.reservation_session_changes
  add column if not exists previous_experience_id uuid references public.experiences(id) on delete restrict,
  add column if not exists target_experience_id uuid references public.experiences(id) on delete restrict;

-- Backfill do histórico já gravado. Toda linha existente nasceu sob a regra
-- "mesma experiência", então as duas colunas recebem a experiência da sessão
-- correspondente e ficam iguais entre si — que é exatamente o que aconteceu.
update public.reservation_session_changes c
set previous_experience_id = coalesce(c.previous_experience_id, previous.experience_id),
    target_experience_id = coalesce(c.target_experience_id, destination.experience_id)
from public.sessions previous, public.sessions destination
where previous.id = c.previous_session_id
  and destination.id = c.target_session_id
  and (c.previous_experience_id is null or c.target_experience_id is null);

do $$ begin
  alter table public.reservation_session_changes
    alter column previous_experience_id set not null,
    alter column target_experience_id set not null;
exception when others then
  -- Um histórico órfão impossível de resolver não pode travar a migration
  -- inteira; as colunas continuam preenchidas dali em diante pela RPC.
  raise notice 'reservation_session_changes: colunas de experiência mantidas anuláveis (%).', sqlerrm;
end $$;

create index if not exists reservation_session_changes_previous_experience_idx
  on public.reservation_session_changes (previous_experience_id, created_at desc);
create index if not exists reservation_session_changes_target_experience_idx
  on public.reservation_session_changes (target_experience_id, created_at desc);

-- 2. A coerência reserva ↔ sessão ↔ experiência vira invariante do banco ----
--
-- Esta é a proteção que substitui `SESSION_EXPERIENCE_MISMATCH`. Antes, a regra
-- era "não deixe a experiência mudar"; agora é "a experiência da reserva é
-- sempre a experiência da sessão da reserva" — o que permite a troca e, ao
-- mesmo tempo, torna impossível a divergência que a regra antiga evitava.
--
-- Só valida quando o par (session_id, experience_id) é escrito. Confirmar,
-- cancelar, expirar ou anexar checkout não tocam nesse par e não pagam nada por
-- esta trigger — nem uma linha histórica eventualmente inconsistente passa a
-- travar operações que nada têm a ver com ela.
create or replace function public.enforce_reservation_experience_consistency()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  session_experience uuid;
begin
  if tg_op = 'UPDATE'
     and new.session_id is not distinct from old.session_id
     and new.experience_id is not distinct from old.experience_id then
    return new;
  end if;

  select s.experience_id into session_experience
  from public.sessions s
  where s.id = new.session_id;

  if session_experience is null then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001';
  end if;

  if new.experience_id is distinct from session_experience then
    raise exception 'RESERVATION_EXPERIENCE_DESYNC' using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.enforce_reservation_experience_consistency() is
  'Invariante: reservations.experience_id é sempre a experiência de reservations.session_id. Validada apenas quando o par é escrito.';

drop trigger if exists reservations_experience_consistency on public.reservations;
create trigger reservations_experience_consistency
  before insert or update on public.reservations
  for each row execute function public.enforce_reservation_experience_consistency();

-- 3. A operação transacional, agora entre experiências ----------------------
--
-- ## O que mudou em relação a 202608240001
--
--   * a recusa `SESSION_EXPERIENCE_MISMATCH` deixa de existir e dá lugar a
--     `EXPERIENCE_NOT_AVAILABLE`: o destino pode ser de outra experiência, desde
--     que ela esteja PUBLISHED. Mover um cliente pagante para dentro de um
--     produto em rascunho ou arquivado seria movê-lo para algo que não está à
--     venda. A própria experiência da reserva é sempre aceita, o que preserva o
--     fluxo antigo mesmo para uma experiência despublicada depois da venda;
--   * o UPDATE passa a escrever `experience_id` junto com `session_id`;
--   * depois da escrita, a linha é relida e conferida. Se `experience_id` não
--     for exatamente a da sessão de destino, a transação inteira aborta.
--
-- ## O que não mudou
--
-- Os locks. Duas sessões entram na transação e são travadas sempre na ordem dos
-- ids — nunca "origem primeiro" — para que mover A de S1 para S2 enquanto
-- alguém move B de S2 para S1 não trave as duas transações uma esperando a
-- outra. A ocupação do destino continua sendo recalculada depois do lock, a
-- partir das linhas reais de `reservations`, e é esse recálculo que decide.
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
  origin_experience public.experiences%rowtype;
  destination_experience public.experiences%rowtype;
  moved public.reservations%rowtype;
  occupied integer;
  normalized_reason text := nullif(trim(coalesce(p_reason, '')), '');
  experience_changed boolean;
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

  select * into origin_experience from public.experiences where id = origin_session.experience_id;
  select * into destination_experience from public.experiences where id = destination_session.experience_id;
  if destination_experience.id is null then
    raise exception 'EXPERIENCE_NOT_FOUND' using errcode = 'P0001';
  end if;

  experience_changed := destination_experience.id is distinct from target.experience_id;

  -- Trocar de experiência é permitido; trocar para uma experiência que não está
  -- publicada, não. A própria experiência da reserva é sempre aceita: se ela foi
  -- despublicada depois da venda, o cliente ainda precisa poder trocar de
  -- horário dentro dela.
  if experience_changed and destination_experience.status <> 'PUBLISHED' then
    raise exception 'EXPERIENCE_NOT_AVAILABLE' using errcode = 'P0001';
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

  -- A mudança em si: as duas colunas do vínculo, juntas. A turma antiga deixa
  -- de contar esta reserva e a nova passa a contá-la, porque `available_spots`
  -- soma as reservas *daquela* sessão — não existe contador paralelo para
  -- dessincronizar. Tudo que não está aqui permanece como estava: status,
  -- confirmed_at, public_code, quantity, unit_price_cents, total_cents,
  -- cliente, CPF, provedor e referência de pagamento.
  update public.reservations
  set session_id = destination_session.id,
      experience_id = destination_session.experience_id,
      updated_at = now()
  where id = target.id
  returning * into moved;

  -- Reconferência dentro da transação. A trigger de coerência já impediria a
  -- divergência, e esta releitura garante que nenhuma outra trigger futura a
  -- reintroduza em silêncio.
  if moved.session_id is distinct from destination_session.id
     or moved.experience_id is distinct from destination_session.experience_id then
    raise exception 'RESERVATION_EXPERIENCE_DESYNC' using errcode = '23514';
  end if;

  insert into public.reservation_session_changes (
    reservation_id,
    previous_session_id,
    target_session_id,
    previous_experience_id,
    target_experience_id,
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
    origin_session.experience_id,
    destination_session.experience_id,
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
      'previousExperienceId', origin_session.experience_id,
      'previousExperienceTitle', coalesce(origin_experience.title, ''),
      'targetSessionId', destination_session.id,
      'targetStartsAt', destination_session.starts_at,
      'targetExperienceId', destination_session.experience_id,
      'targetExperienceTitle', destination_experience.title,
      'experienceChanged', experience_changed,
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
    'unitPriceCents', target.unit_price_cents,
    'experienceChanged', experience_changed,
    'previousSessionId', origin_session.id,
    'previousStartsAt', origin_session.starts_at,
    'previousExperienceId', origin_session.experience_id,
    'previousExperienceTitle', coalesce(origin_experience.title, ''),
    'previousSessionPriceCents', origin_session.price_cents,
    'targetSessionId', destination_session.id,
    'targetStartsAt', destination_session.starts_at,
    'targetExperienceId', destination_session.experience_id,
    'targetExperienceTitle', destination_experience.title,
    'targetSessionPriceCents', destination_session.price_cents
  );
end;
$$;

-- 4. Turmas de destino: a agenda inteira, não só a experiência atual --------
--
-- O recorte continua no banco, não na tela. O que mudou é a fronteira: saiu
-- `s.experience_id = target.experience_id` e entrou a agenda elegível inteira —
-- toda sessão futura, aberta, de uma experiência publicada (ou da própria
-- experiência da reserva), com vagas para o grupo inteiro.
--
-- Turmas sem vaga para a quantidade da reserva não são oferecidas: com a agenda
-- inteira na lista, uma opção impossível a cada três seria ruído. Elas são
-- contadas em `hiddenForCapacity`, para a tela poder dizer quantas ficaram de
-- fora e por quê, em vez de simplesmente não existirem.
--
-- `fits` continua no payload e continua vindo do banco: a tela reaplica a mesma
-- régua antes de habilitar a opção, e a RPC de mudança recusa de novo com as
-- sessões travadas. A lista é conveniência, não autorização.
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
  hidden_for_capacity integer;
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
    'experienceStatus', e.status,
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
        'experienceStatus', e.status,
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
    where s.id <> target.session_id
      and s.status = 'OPEN'
      and s.starts_at > now()
      and (e.status = 'PUBLISHED' or e.id = target.experience_id)
  ) candidate;

  return jsonb_build_object(
    'reservationId', target.id,
    'publicCode', target.public_code,
    'fullName', target.full_name,
    'status', target.status,
    'quantity', target.quantity,
    'totalCents', target.total_cents,
    'unitPriceCents', target.unit_price_cents,
    'hiddenForCapacity', coalesce(hidden_for_capacity, 0),
    'current', current_block,
    'options', options
  );
end;
$$;

-- 5. Histórico exibido no detalhe da reserva --------------------------------
--
-- Passa a devolver as duas experiências, com título, para o painel poder
-- escrever "Imersão Paranoá → Remada Sunset" em vez de só duas datas.
drop function if exists public.admin_list_reservation_session_changes(uuid, uuid);
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
  previous_experience_id uuid,
  previous_experience_title text,
  target_session_id uuid,
  target_starts_at timestamptz,
  target_experience_id uuid,
  target_experience_title text,
  experience_changed boolean,
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
    coalesce(c.previous_experience_id, previous.experience_id),
    coalesce(previous_experience.title, ''),
    c.target_session_id,
    destination.starts_at,
    coalesce(c.target_experience_id, destination.experience_id),
    coalesce(destination_experience.title, ''),
    coalesce(c.previous_experience_id, previous.experience_id)
      is distinct from coalesce(c.target_experience_id, destination.experience_id),
    c.quantity,
    c.unit_price_cents,
    c.total_cents,
    c.previous_session_price_cents,
    c.target_session_price_cents,
    c.reason
  from public.reservation_session_changes c
  join public.sessions previous on previous.id = c.previous_session_id
  join public.sessions destination on destination.id = c.target_session_id
  left join public.experiences previous_experience
    on previous_experience.id = coalesce(c.previous_experience_id, previous.experience_id)
  left join public.experiences destination_experience
    on destination_experience.id = coalesce(c.target_experience_id, destination.experience_id)
  left join public.admin_users a on a.user_id = c.actor_user_id
  where c.reservation_id = p_reservation_id
  order by c.created_at desc
  limit 100;
end;
$$;

-- 6. Grants ------------------------------------------------------------------
--
-- Mesma regra das demais RPCs administrativas: execução revogada de public,
-- anon e authenticated; somente a service role executa, e o servidor deriva
-- `p_actor_id` da sessão validada — nunca do payload do cliente. Reafirmados
-- aqui porque `admin_list_reservation_session_changes` foi recriada com uma
-- assinatura de retorno nova, o que descarta os grants anteriores.
revoke all on function public.admin_change_reservation_session(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_reservation_session_options(uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_list_reservation_session_changes(uuid, uuid) from public, anon, authenticated;

grant execute on function public.admin_change_reservation_session(uuid, uuid, uuid, text) to service_role;
grant execute on function public.admin_reservation_session_options(uuid, uuid) to service_role;
grant execute on function public.admin_list_reservation_session_changes(uuid, uuid) to service_role;
