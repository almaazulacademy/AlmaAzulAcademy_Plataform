-- Stand-by de reservas: estrutura, travas financeiras e operações transacionais.
--
-- Depende de `202610130001_reservation_status_awaiting_reschedule.sql`, que
-- precisa ter sido aplicada **em outra execução**: esta migration usa o valor
-- AWAITING_RESCHEDULE, e o Postgres não deixa usar um valor de enum na mesma
-- transação em que ele nasceu.
--
-- Aditiva e idempotente. Não altera nenhuma reserva, sessão, pagamento ou linha
-- de histórico existente. Depois de aplicada, **nada muda no comportamento do
-- sistema**: nenhuma reserva tem o status novo, e ele só pode ser gravado pelas
-- RPCs criadas aqui, que nenhum código publicado chama ainda.
--
-- ## O que é Stand-by
--
-- A reserva continua sendo a mesma — mesmo id, mesmo `public_code`, mesma
-- quantidade, mesmo `unit_price_cents`, mesmo `confirmed_at`, mesmos
-- `payment_events`, mesmo `checkin_token` — e passa a `AWAITING_RESCHEDULE`.
-- Como toda contagem de ocupação soma apenas CONFIRMED e pré-reservas válidas
-- por `session_id`, a vaga é liberada pelo próprio status, sem contador
-- paralelo e sem possibilidade de liberar a mais.
--
-- `session_id` e `experience_id` permanecem apontando para a turma original:
-- as colunas são obrigatórias, a trigger de coerência as valida em par e todas
-- as leituras (painel, acompanhamento público, planilha) fazem join por elas.
-- Enquanto a reserva está em Stand-by elas significam "turma anterior".
--
-- ## Autorização de uso único
--
-- Cada entrada em Stand-by cria uma linha em `reservation_standby`. Essa linha
-- é a autorização de reagendamento: no máximo uma aberta por reserva, encerrada
-- na mesma transação que resolve o Stand-by, nunca reaberta.
--
-- ## O que esta migration deliberadamente NÃO faz
--
--   * não cria reserva, cobrança, estorno nem `payment_events`;
--   * não altera `admin_change_reservation_session` — o reagendamento
--     administrativo tradicional continua exatamente como está;
--   * não envia e-mail, não enfileira job e não toca a planilha;
--   * não cria policy nem grant para `anon` ou `authenticated`.

-- ---------------------------------------------------------------------------
-- 1. Tabela de Stand-by
-- ---------------------------------------------------------------------------
create table if not exists public.reservation_standby (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete restrict,

  -- Retrato da turma original, gravado no instante da entrada. Derivar por join
  -- não é histórico: a sessão pode ser editada depois.
  original_session_id uuid not null references public.sessions(id) on delete restrict,
  original_experience_id uuid not null references public.experiences(id) on delete restrict,
  original_base_id uuid references public.bases(id) on delete restrict,
  original_starts_at timestamptz not null,

  -- Retrato financeiro. Nada aqui é fonte de verdade — a reserva continua
  -- sendo — mas o que estava pago no instante da entrada fica registrado.
  quantity integer not null,
  unit_price_cents integer not null,
  total_cents integer not null,

  -- Check-in que a reserva tinha ao entrar. Só entra reserva sem registro ou com
  -- ausência registrada (0); os campos ativos são limpos e o que havia fica aqui.
  previous_checked_in_count integer,
  previous_checked_in_at timestamptz,
  previous_checked_in_by uuid,
  previous_checkin_method text,

  created_by uuid references auth.users(id) on delete set null,
  reason text,
  created_at timestamptz not null default now(),

  -- Link individual. Só o SHA-256 do token é guardado; o texto do token existe
  -- apenas na resposta da geração.
  link_token_hash text,
  link_created_at timestamptz,
  link_created_by uuid references auth.users(id) on delete set null,
  link_revoked_at timestamptz,

  -- Resolução. Preenchida uma única vez, na transação que encerra o Stand-by.
  resolved_at timestamptz,
  resolution text,
  resolved_by_type text,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_access text,
  resolved_session_id uuid references public.sessions(id) on delete restrict,
  resolved_change_id uuid references public.reservation_session_changes(id) on delete restrict,
  resolved_reason text
);

do $$ begin
  alter table public.reservation_standby
    add constraint reservation_standby_amounts_valid
    check (quantity > 0 and unit_price_cents >= 0 and total_cents >= 0);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.reservation_standby
    add constraint reservation_standby_reason_length
    check ((reason is null or char_length(reason) <= 500)
       and (resolved_reason is null or char_length(resolved_reason) <= 500));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.reservation_standby
    add constraint reservation_standby_resolution_allowed
    check (resolution is null or resolution in ('RESCHEDULED', 'RESTORED', 'CANCELLED'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.reservation_standby
    add constraint reservation_standby_resolved_by_type_allowed
    check (resolved_by_type is null or resolved_by_type in ('ADMIN', 'CUSTOMER'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.reservation_standby
    add constraint reservation_standby_resolved_access_allowed
    check (resolved_access is null or resolved_access in ('ADMIN', 'CPF_CODE', 'LINK'));
exception when duplicate_object then null;
end $$;

-- Aberto ou resolvido, nunca pela metade: sem data não há tipo de resolução, e
-- uma resolução que devolve a reserva a uma turma sempre diz qual.
do $$ begin
  alter table public.reservation_standby
    add constraint reservation_standby_resolution_consistent
    check (
      (resolved_at is null and resolution is null and resolved_session_id is null and resolved_change_id is null)
      or (resolved_at is not null and resolution = 'CANCELLED')
      or (resolved_at is not null and resolution in ('RESCHEDULED', 'RESTORED') and resolved_session_id is not null)
    );
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.reservation_standby
    add constraint reservation_standby_link_hash_format
    check (link_token_hash is null or link_token_hash ~ '^[0-9a-f]{64}$');
exception when duplicate_object then null;
end $$;

-- No máximo uma autorização aberta por reserva. É esta unicidade, e não uma
-- checagem da aplicação, que impede duas entradas simultâneas em Stand-by.
create unique index if not exists reservation_standby_one_open_per_reservation
  on public.reservation_standby (reservation_id)
  where resolved_at is null;

create unique index if not exists reservation_standby_link_token_key
  on public.reservation_standby (link_token_hash)
  where link_token_hash is not null;

create index if not exists reservation_standby_reservation_idx
  on public.reservation_standby (reservation_id, created_at desc);

create index if not exists reservation_standby_open_idx
  on public.reservation_standby (created_at)
  where resolved_at is null;

-- Tudo passa por RPC `security definer`. Nem a API pública nem a service role
-- escrevem aqui diretamente; a service role só lê, para diagnóstico.
alter table public.reservation_standby enable row level security;
revoke all on table public.reservation_standby from public, anon, authenticated, service_role;
grant select on table public.reservation_standby to service_role;

-- ---------------------------------------------------------------------------
-- 2. Histórico de trocas: quem fez e de onde veio
-- ---------------------------------------------------------------------------
--
-- As linhas já gravadas nasceram todas do reagendamento administrativo direto,
-- então os defaults ('ADMIN', 'DIRECT', sem Stand-by) descrevem exatamente o
-- que aconteceu com elas.
alter table public.reservation_session_changes
  add column if not exists actor_type text not null default 'ADMIN',
  add column if not exists origin text not null default 'DIRECT',
  add column if not exists standby_id uuid references public.reservation_standby(id) on delete restrict;

do $$ begin
  alter table public.reservation_session_changes
    add constraint reservation_session_changes_actor_type_allowed
    check (actor_type in ('ADMIN', 'CUSTOMER'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.reservation_session_changes
    add constraint reservation_session_changes_origin_allowed
    check (origin in ('DIRECT', 'STANDBY_RESCHEDULE', 'STANDBY_RESTORE'));
exception when duplicate_object then null;
end $$;

-- Troca direta nunca tem Stand-by; troca vinda de Stand-by sempre tem. O
-- cliente só aparece como ator em troca vinda de Stand-by.
do $$ begin
  alter table public.reservation_session_changes
    add constraint reservation_session_changes_origin_consistent
    check ((origin = 'DIRECT') = (standby_id is null) and (actor_type = 'ADMIN' or standby_id is not null));
exception when duplicate_object then null;
end $$;

-- A regra "origem diferente do destino" continua valendo para a troca direta.
-- Saindo de um Stand-by, voltar para a turma original é permitido (desfazer, ou
-- o cliente escolher a mesma data de novo) e precisa caber no histórico.
alter table public.reservation_session_changes
  drop constraint if exists reservation_session_changes_distinct_sessions;
alter table public.reservation_session_changes
  add constraint reservation_session_changes_distinct_sessions
  check (previous_session_id <> target_session_id or standby_id is not null);

-- Uma autorização gera no máximo uma troca. É a âncora da idempotência.
create unique index if not exists reservation_session_changes_standby_key
  on public.reservation_session_changes (standby_id)
  where standby_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Invariante do status, garantida pelo banco
-- ---------------------------------------------------------------------------
--
-- As travas das funções de pagamento (seção 4) são a primeira linha de defesa.
-- Esta trigger é a segunda, e não depende de nenhuma função ter sido lembrada:
--
--   * uma reserva só entra em AWAITING_RESCHEDULE vindo de CONFIRMED e com uma
--     autorização aberta já gravada;
--   * uma reserva em AWAITING_RESCHEDULE só volta a CONFIRMED depois que a
--     autorização foi encerrada — o que só as operações de Stand-by fazem.
--     Webhook, reconciliação, confirmação manual ou qualquer função futura que
--     tente reconfirmar a reserva na turma antiga aborta aqui;
--   * cancelar uma reserva em Stand-by continua permitido e encerra a
--     autorização como CANCELLED;
--   * qualquer outro destino (EXPIRED, PRE_RESERVED) é recusado.
--
-- Só dispara quando `status` é escrito. `security definer` porque precisa ler e
-- encerrar `reservation_standby`, que não tem grant de escrita para ninguém.
create or replace function public.enforce_reservation_standby_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'AWAITING_RESCHEDULE' then
      raise exception 'STANDBY_REQUIRES_CONFIRMED_RESERVATION' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status = 'AWAITING_RESCHEDULE' then
    if old.status <> 'CONFIRMED' then
      raise exception 'STANDBY_REQUIRES_CONFIRMED_RESERVATION' using errcode = '23514';
    end if;
    if not exists (
      select 1 from public.reservation_standby
      where reservation_id = new.id and resolved_at is null
    ) then
      raise exception 'STANDBY_AUTHORIZATION_REQUIRED' using errcode = '23514';
    end if;
    return new;
  end if;

  if old.status = 'AWAITING_RESCHEDULE' then
    if new.status = 'CONFIRMED' then
      if exists (
        select 1 from public.reservation_standby
        where reservation_id = new.id and resolved_at is null
      ) then
        raise exception 'STANDBY_STILL_OPEN' using errcode = '23514';
      end if;
    elsif new.status = 'CANCELLED' then
      update public.reservation_standby
      set resolved_at = now(),
          resolution = 'CANCELLED',
          resolved_by_type = 'ADMIN'
      where reservation_id = new.id and resolved_at is null;
    else
      raise exception 'STANDBY_INVALID_TRANSITION' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.enforce_reservation_standby_transition() is
  'Invariante: AWAITING_RESCHEDULE só existe com autorização aberta em reservation_standby, e só volta a CONFIRMED pelas operações de Stand-by.';

drop trigger if exists reservations_standby_guard on public.reservations;
create trigger reservations_standby_guard
  before insert or update of status on public.reservations
  for each row execute function public.enforce_reservation_standby_transition();

-- ---------------------------------------------------------------------------
-- 4. Travas financeiras
-- ---------------------------------------------------------------------------
--
-- Uma reserva em Stand-by já está paga. Nenhum caminho de pagamento pode
-- reconfirmá-la na turma antiga, gravar um segundo evento financeiro ou mandá-la
-- para "Pagamentos para revisar". As três funções abaixo são as definições
-- vigentes, copiadas literalmente, com **uma única instrução acrescentada** em
-- cada uma, logo depois do retorno de CONFIRMED. Para qualquer outro status o
-- caminho percorrido é o mesmo de antes.

-- 4a. Reconciliação: devolve um código próprio, sem gravar evento, sem carimbar
-- `last_reconciliation_code` e sem tocar a reserva.

create or replace function public.reconcile_reservation_payment(
  p_reservation_id uuid,
  p_provider text,
  p_provider_event_id text,
  p_amount_cents integer,
  p_receipt_url text,
  p_payload jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.reservations%rowtype;
  target_session public.sessions%rowtype;
  occupied integer;
  event_id text;
begin
  select * into target from public.reservations where id = p_reservation_id for update;
  if not found then return 'NOT_FOUND'; end if;
  if target.status = 'CONFIRMED' then return 'ALREADY_CONFIRMED'; end if;
  if target.status = 'AWAITING_RESCHEDULE' then return 'AWAITING_RESCHEDULE'; end if;
  if target.status = 'CANCELLED' then
    perform public.record_reconciliation_result(target.id, 'CANCELLED');
    return 'CANCELLED';
  end if;

  if target.total_cents <> p_amount_cents then
    perform public.record_payment_attempt(
      target.id, p_provider, coalesce(nullif(trim(p_provider_event_id), ''), gen_random_uuid()::text) || ':mismatch',
      'PAYMENT_AMOUNT_MISMATCH', greatest(coalesce(p_amount_cents, 0), 0),
      coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('expected_cents', target.total_cents)
    );
    perform public.record_reconciliation_result(target.id, 'AMOUNT_MISMATCH');
    return 'AMOUNT_MISMATCH';
  end if;

  select * into target_session from public.sessions where id = target.session_id for update;
  if not found then return 'NOT_FOUND'; end if;
  if target_session.status = 'CANCELLED' then
    perform public.record_reconciliation_result(target.id, 'SESSION_CANCELLED');
    return 'SESSION_CANCELLED';
  end if;

  -- Materializa vencidas das outras reservas antes de recontar a ocupação.
  -- Reservas em janela de segurança têm `expires_at` no futuro e continuam
  -- ocupando — é o comportamento correto: elas também podem estar pagas.
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
    perform public.record_payment_attempt(
      target.id, p_provider, coalesce(nullif(trim(p_provider_event_id), ''), gen_random_uuid()::text) || ':no-capacity',
      'PAYMENT_AFTER_EXPIRATION_NO_CAPACITY', greatest(coalesce(p_amount_cents, 0), 0),
      coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('receipt_url', p_receipt_url, 'occupied', occupied, 'capacity', target_session.capacity)
    );
    -- Solta o hold: a vaga não é mais desta reserva. O incidente fica gravado e
    -- visível; o que não pode acontecer é a capacidade ficar bloqueada por uma
    -- reserva que já não tem para onde ir.
    update public.reservations
    set expires_at = least(expires_at, now()),
        payment_hold_until = now(),
        last_reconciled_at = now(),
        last_reconciliation_code = 'NO_CAPACITY',
        updated_at = now()
    where id = target.id and status = 'PRE_RESERVED';
    perform public.record_reconciliation_result(target.id, 'NO_CAPACITY');
    return 'NO_CAPACITY';
  end if;

  event_id := coalesce(nullif(trim(p_provider_event_id), ''), gen_random_uuid()::text) || ':reconciled';
  insert into public.payment_events (
    reservation_id, provider, provider_event_id, event_type, amount_cents, payload
  ) values (
    target.id, p_provider, event_id, 'PAYMENT_CONFIRMED_RECONCILED', p_amount_cents,
    coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('receipt_url', p_receipt_url, 'previous_status', target.status)
  )
  on conflict (provider, provider_event_id) do nothing;

  update public.reservations
  set status = 'CONFIRMED',
      confirmed_at = coalesce(confirmed_at, now()),
      cancelled_at = null,
      payment_provider = coalesce(payment_provider, p_provider),
      provider_reference = coalesce(provider_reference, p_provider_event_id),
      expires_at = greatest(expires_at, now() + interval '1 hour'),
      payment_hold_until = null,
      last_reconciled_at = now(),
      last_reconciliation_code = 'RECONCILED',
      updated_at = now()
  where id = target.id;

  return 'RECONCILED';
end;
$$;

-- 4b. Confirmação: sem esta instrução, o ramo "não é PRE_RESERVED" gravaria
-- PAYMENT_AFTER_EXPIRATION em uma reserva que está paga e em dia. Devolve false
-- — não houve confirmação agora — e a camada da aplicação resolve o resultado
-- pela reconciliação acima.

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
  if target.status = 'AWAITING_RESCHEDULE' then return false; end if;
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
  set status = 'CONFIRMED',
      confirmed_at = now(),
      provider_reference = p_provider_event_id,
      payment_hold_until = null,
      last_reconciled_at = now(),
      last_reconciliation_code = 'CONFIRMED',
      updated_at = now()
  where id = target.id;
  return true;
end;
$$;

-- 4c. Confirmação manual: recusa explícita. Sem ela, o painel gravaria um
-- segundo PAYMENT_CONFIRMED_MANUAL e devolveria a reserva à turma antiga.

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
  if target.status = 'AWAITING_RESCHEDULE' then
    raise exception 'RESERVATION_AWAITING_RESCHEDULE' using errcode = 'P0001';
  end if;
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

-- ---------------------------------------------------------------------------
-- 5. "Pagamentos para revisar" ignora reserva em Stand-by
-- ---------------------------------------------------------------------------
--
-- As duas funções listavam toda reserva "diferente de CONFIRMED" com algum
-- sinal de pagamento. Uma reserva recuperada pela reconciliação carrega esses
-- sinais para sempre; ao entrar em Stand-by ela reapareceria na fila de revisão
-- sem haver nada a revisar. A única alteração é o predicado de status.

create or replace function public.admin_payments_needing_review(
  p_actor_id uuid,
  p_limit integer,
  p_lookback_days integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  batch integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  lookback integer := least(greatest(coalesce(p_lookback_days, 30), 1), 365);
  items jsonb;
  orphans jsonb;
  failures integer;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(item), '[]'::jsonb) into items
  from (
    select jsonb_build_object(
      'reservationId', r.id,
      'publicCode', r.public_code,
      'status', r.status,
      'paymentStatus', public.reservation_payment_status(r.id),
      'reason', public.payment_review_reason(r.id),
      'quantity', r.quantity,
      'totalCents', r.total_cents,
      'createdAt', r.created_at,
      'originalExpiresAt', coalesce(r.original_expires_at, r.expires_at),
      'expiresAt', r.expires_at,
      'paymentHoldUntil', r.payment_hold_until,
      'reconciliationAttempts', r.reconciliation_attempts,
      'lastReconciledAt', r.last_reconciled_at,
      'lastReconciliationCode', r.last_reconciliation_code,
      'sessionId', r.session_id,
      'startsAt', s.starts_at,
      'experienceTitle', e.title,
      'availableSpots', public.available_spots(r.session_id),
      'lastEventAt', (select max(pe.processed_at) from public.payment_events pe where pe.reservation_id = r.id)
    ) as item
    from public.reservations r
    join public.sessions s on s.id = r.session_id
    join public.experiences e on e.id = r.experience_id
    where r.status not in ('CONFIRMED', 'AWAITING_RESCHEDULE')
      and r.created_at > now() - make_interval(days => lookback)
      and public.payment_review_reason(r.id) is not null
    order by r.created_at desc
    limit batch
  ) ranked;

  -- Webhook que chegou e não casou com reserva nenhuma: o Caso B/F só aparece
  -- aqui, porque `payment_events` exige uma reserva existente.
  select coalesce(jsonb_agg(orphan), '[]'::jsonb) into orphans
  from (
    select jsonb_build_object(
      'receivedAt', l.received_at,
      'requestId', l.request_id,
      'step', l.step,
      'outcome', l.outcome,
      'httpStatus', l.http_status,
      'errorCode', l.error_code,
      'orderIdMasked', case when length(coalesce(l.order_id, '')) > 8
                            then left(l.order_id, 8) || '…' || right(l.order_id, 4)
                            else nullif(l.order_id, '') end
    ) as orphan
    from public.payment_webhook_log l
    where l.reservation_id is null
      and l.source = 'WEBHOOK'
      and l.received_at > now() - make_interval(days => lookback)
      and coalesce(l.outcome, '') in ('INVALID', 'FAILED')
    order by l.received_at desc
    limit 50
  ) recent;

  select count(*)::integer into failures
  from public.payment_webhook_log l
  where l.received_at > now() - make_interval(days => lookback)
    and coalesce(l.http_status, 200) >= 400;

  return jsonb_build_object(
    'items', items,
    'orphanWebhooks', orphans,
    'webhookFailures', failures,
    'generatedAt', now()
  );
end;
$$;

create or replace function public.payment_review_counters()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'needsReview', (
      select count(*) from public.reservations r
      where r.status not in ('CONFIRMED', 'AWAITING_RESCHEDULE')
        and r.created_at > now() - interval '30 days'
        and public.payment_review_reason(r.id) is not null
    ),
    'approvedNoCapacity', (
      select count(distinct pe.reservation_id) from public.payment_events pe
      join public.reservations r on r.id = pe.reservation_id
      where pe.event_type = 'PAYMENT_AFTER_EXPIRATION_NO_CAPACITY'
        and r.status not in ('CONFIRMED', 'AWAITING_RESCHEDULE')
    ),
    'onHold', (
      select count(*) from public.reservations r
      where r.status = 'PRE_RESERVED' and r.payment_hold_until is not null and r.payment_hold_until > now()
    ),
    'webhookFailures', (
      select count(*) from public.payment_webhook_log l
      where l.received_at > now() - interval '7 days' and coalesce(l.http_status, 200) >= 400
    ),
    'orphanWebhooks', (
      select count(*) from public.payment_webhook_log l
      where l.reservation_id is null and l.source = 'WEBHOOK'
        and l.received_at > now() - interval '30 days'
        and coalesce(l.outcome, '') in ('INVALID', 'FAILED')
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- 6. Receita: Stand-by continua sendo dinheiro recebido
-- ---------------------------------------------------------------------------
--
-- Regra: tudo que mede **dinheiro** passa a somar CONFIRMED + AWAITING_RESCHEDULE
-- (`expectedRevenueCents`, `confirmedRevenueCents`, `monthlyRevenueCents`,
-- `averageTicketCents`, `revenueByMonth`). Tudo que mede **presença ou vaga**
-- continua somente CONFIRMED (`confirmedReservations`, `totalParticipants`,
-- `topExperience`, ocupação) — a reserva em Stand-by não ocupa vaga em turma
-- nenhuma. `awaitingReschedule` é novo e mostra quanto está parado.
--
-- Sem dupla contagem: é a mesma linha de `reservations`, somada uma vez. O mês
-- da receita vem de `confirmed_at`, que nem a entrada em Stand-by nem o
-- reagendamento alteram.
--
-- Por base (`admin_base_dashboard_metrics`): a receita é atribuída pela
-- `experience_id` da reserva. Em Stand-by ela ainda é a experiência original,
-- então o valor permanece na base de origem; ao reagendar para outra base, a
-- mesma linha passa a apontar para a experiência nova e o valor migra inteiro
-- para a base de destino — exatamente o que o reagendamento administrativo
-- entre bases já faz hoje. A soma das bases continua igual ao total geral.

create or replace function public.admin_dashboard_metrics(p_actor_id uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare result jsonb; begin
  if not public.is_active_admin(p_actor_id) then raise exception 'ADMIN_FORBIDDEN' using errcode = '42501'; end if;
  select jsonb_build_object(
    'nextSession', (select jsonb_build_object('id', s.id, 'experienceTitle', e.title, 'startsAt', s.starts_at, 'remainingSpots', public.available_spots(s.id)) from public.sessions s join public.experiences e on e.id = s.experience_id where s.starts_at > now() and s.status not in ('CANCELLED', 'ARCHIVED') order by s.starts_at limit 1),
    'futureSessions', (select count(*) from public.sessions where starts_at > now() and status not in ('CANCELLED', 'ARCHIVED')),
    'confirmedReservations', (select count(*) from public.reservations where status = 'CONFIRMED'),
    'totalReservations', (select count(*) from public.reservations),
    'preReservations', (select count(*) from public.reservations where status = 'PRE_RESERVED' and expires_at > now()),
    'expectedRevenueCents', (select coalesce(sum(total_cents), 0) from public.reservations where status in ('CONFIRMED', 'AWAITING_RESCHEDULE') or (status = 'PRE_RESERVED' and expires_at > now())),
    'confirmedRevenueCents', (select coalesce(sum(total_cents), 0) from public.reservations where status in ('CONFIRMED', 'AWAITING_RESCHEDULE')),
    'totalParticipants', (select coalesce(sum(quantity), 0) from public.reservations where status = 'CONFIRMED'),
    'averageOccupancyRate', (select coalesce(round(avg((s.capacity - public.available_spots(s.id)) * 100.0 / nullif(s.capacity, 0)), 1), 0) from public.sessions s where s.starts_at > now() and s.status not in ('CANCELLED', 'ARCHIVED')),
    'topExperience', (select e.title from public.reservations r join public.experiences e on e.id = r.experience_id where r.status = 'CONFIRMED' group by e.id, e.title order by sum(r.quantity) desc limit 1),
    'monthlyRevenueCents', (select coalesce(sum(total_cents), 0) from public.reservations where status in ('CONFIRMED', 'AWAITING_RESCHEDULE') and confirmed_at >= date_trunc('month', now())),
    'averageTicketCents', (select coalesce(round(avg(total_cents)), 0) from public.reservations where status in ('CONFIRMED', 'AWAITING_RESCHEDULE')),
    'revenueByMonth', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m.month, 'Mon'), 'revenueCents', coalesce(x.total, 0)) order by m.month), '[]'::jsonb) from generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') m(month) left join lateral (select sum(total_cents) total from public.reservations where status in ('CONFIRMED', 'AWAITING_RESCHEDULE') and confirmed_at >= m.month and confirmed_at < m.month + interval '1 month') x on true),
    'awaitingReschedule', (select jsonb_build_object('reservations', count(*), 'participants', coalesce(sum(quantity), 0), 'totalCents', coalesce(sum(total_cents), 0)) from public.reservations where status = 'AWAITING_RESCHEDULE'),
    'paymentReview', public.payment_review_counters(),
    'lastUpdatedAt', greatest(coalesce((select max(updated_at) from public.experiences), '-infinity'::timestamptz), coalesce((select max(updated_at) from public.sessions), '-infinity'::timestamptz), coalesce((select max(updated_at) from public.reservations), '-infinity'::timestamptz))
  ) into result; return result;
end $$;

create or replace function public.admin_base_dashboard_metrics(p_actor_id uuid, p_base_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  result jsonb;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  with
    base_experiences as (
      select e.id, e.title from public.experiences e
      where p_base_id is null or e.base_id = p_base_id
    ),
    base_sessions as (
      select s.* from public.sessions s join base_experiences be on be.id = s.experience_id
    ),
    base_reservations as (
      select r.* from public.reservations r join base_experiences be on be.id = r.experience_id
    ),
    upcoming as (
      select s.id, s.starts_at, s.capacity, s.status, be.title
      from base_sessions s join base_experiences be on be.id = s.experience_id
      where s.starts_at > now() and s.status not in ('CANCELLED', 'ARCHIVED')
    )
  select jsonb_build_object(
    'nextSession', (
      select jsonb_build_object('id', u.id, 'experienceTitle', u.title, 'startsAt', u.starts_at, 'remainingSpots', public.available_spots(u.id))
      from upcoming u order by u.starts_at limit 1
    ),
    'upcomingSessions', (
      select coalesce(jsonb_agg(item order by item->>'startsAt'), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'id', u.id, 'experienceTitle', u.title, 'startsAt', u.starts_at, 'status', u.status,
          'capacity', u.capacity, 'remainingSpots', public.available_spots(u.id)
        ) as item
        from upcoming u order by u.starts_at limit 8
      ) next_sessions
    ),
    'experiencesCount', (select count(*) from base_experiences),
    'sessionsCount', (select count(*) from base_sessions where status <> 'ARCHIVED'),
    'futureSessions', (select count(*) from upcoming),
    'confirmedReservations', (select count(*) from base_reservations where status = 'CONFIRMED'),
    'cancelledReservations', (select count(*) from base_reservations where status = 'CANCELLED'),
    'totalReservations', (select count(*) from base_reservations),
    'preReservations', (select count(*) from base_reservations where status = 'PRE_RESERVED' and expires_at > now()),
    'expectedRevenueCents', (select coalesce(sum(total_cents), 0) from base_reservations where status in ('CONFIRMED', 'AWAITING_RESCHEDULE') or (status = 'PRE_RESERVED' and expires_at > now())),
    'confirmedRevenueCents', (select coalesce(sum(total_cents), 0) from base_reservations where status in ('CONFIRMED', 'AWAITING_RESCHEDULE')),
    'totalParticipants', (select coalesce(sum(quantity), 0) from base_reservations where status = 'CONFIRMED'),
    'averageOccupancyRate', (select coalesce(round(avg((u.capacity - public.available_spots(u.id)) * 100.0 / nullif(u.capacity, 0)), 1), 0) from upcoming u),
    'topExperience', (
      select be.title from base_reservations r join base_experiences be on be.id = r.experience_id
      where r.status = 'CONFIRMED' group by be.id, be.title order by sum(r.quantity) desc limit 1
    ),
    'monthlyRevenueCents', (select coalesce(sum(total_cents), 0) from base_reservations where status in ('CONFIRMED', 'AWAITING_RESCHEDULE') and confirmed_at >= date_trunc('month', now())),
    'averageTicketCents', (select coalesce(round(avg(total_cents)), 0) from base_reservations where status in ('CONFIRMED', 'AWAITING_RESCHEDULE')),
    'revenueByMonth', (
      select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m.month, 'Mon'), 'revenueCents', coalesce(x.total, 0)) order by m.month), '[]'::jsonb)
      from generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') m(month)
      left join lateral (
        select sum(total_cents) total from base_reservations
        where status in ('CONFIRMED', 'AWAITING_RESCHEDULE') and confirmed_at >= m.month and confirmed_at < m.month + interval '1 month'
      ) x on true
    ),
    'awaitingReschedule', (select jsonb_build_object('reservations', count(*), 'participants', coalesce(sum(quantity), 0), 'totalCents', coalesce(sum(total_cents), 0)) from base_reservations where status = 'AWAITING_RESCHEDULE'),
    'lastUpdatedAt', greatest(
      coalesce((select max(updated_at) from base_sessions), '-infinity'::timestamptz),
      coalesce((select max(updated_at) from base_reservations), '-infinity'::timestamptz)
    )
  ) into result;

  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Peças internas
-- ---------------------------------------------------------------------------
--
-- Nenhuma das funções desta seção é executável por `anon`, `authenticated` ou
-- `service_role`. Só as RPCs das seções 8 a 10, que são `security definer`, as
-- chamam. É o que garante que não existe atalho para resolver um Stand-by sem
-- passar pela checagem de quem está pedindo.

-- Elegibilidade financeira: pagamento confirmado, pelos mesmos três eventos que
-- o painel e a planilha já usam para dizer "Pago".
create or replace function public.reservation_has_confirmed_payment(p_reservation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.payment_events pe
    where pe.reservation_id = p_reservation_id
      and pe.event_type in ('PAYMENT_CONFIRMED', 'PAYMENT_CONFIRMED_MANUAL', 'PAYMENT_CONFIRMED_RECONCILED')
  );
$$;

-- A régua única de "esta turma pode receber esta reserva", fora a capacidade.
-- Usada tanto para montar a lista oferecida ao cliente quanto para decidir,
-- com a sessão travada, se o reagendamento acontece — a lista e a decisão não
-- têm como divergir.
--
--   ADMIN    — a mesma regra do reagendamento administrativo tradicional:
--              sessão aberta e futura; experiência publicada, ou a própria
--              experiência da reserva. Sem regra de preço.
--   RESTORE  — igual a ADMIN. O destino é sempre a turma original.
--   CUSTOMER — sessão aberta e futura, experiência publicada, base em operação
--              e **preço por participante igual ao valor unitário pago**. Sem
--              antecedência mínima.
--
-- Devolve null quando a turma é elegível, ou o símbolo da recusa.
create or replace function public.reservation_standby_target_rejection(
  p_reservation_id uuid,
  p_session_id uuid,
  p_mode text
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  target public.reservations%rowtype;
  candidate public.sessions%rowtype;
  candidate_experience public.experiences%rowtype;
  base_status text;
begin
  if p_mode is null or p_mode not in ('ADMIN', 'CUSTOMER', 'RESTORE') then
    raise exception 'STANDBY_INVALID_MODE' using errcode = '22023';
  end if;

  select * into target from public.reservations where id = p_reservation_id;
  if not found then return 'RESERVATION_NOT_FOUND'; end if;

  select * into candidate from public.sessions where id = p_session_id;
  if not found then return 'SESSION_NOT_FOUND'; end if;

  select * into candidate_experience from public.experiences where id = candidate.experience_id;
  if not found then return 'EXPERIENCE_NOT_FOUND'; end if;

  if p_mode = 'CUSTOMER' then
    if candidate_experience.status <> 'PUBLISHED' then return 'EXPERIENCE_NOT_AVAILABLE'; end if;
    select b.status into base_status from public.bases b where b.id = candidate_experience.base_id;
    if base_status is distinct from 'ACTIVE' then return 'BASE_NOT_AVAILABLE'; end if;
  elsif candidate_experience.status <> 'PUBLISHED' and candidate_experience.id <> target.experience_id then
    return 'EXPERIENCE_NOT_AVAILABLE';
  end if;

  if candidate.status <> 'OPEN' then return 'SESSION_NOT_OPEN'; end if;
  if candidate.starts_at <= now() then return 'SESSION_MUST_BE_FUTURE'; end if;

  if p_mode = 'CUSTOMER' and candidate.price_cents <> target.unit_price_cents then
    return 'PRICE_NOT_ELIGIBLE';
  end if;

  return null;
end;
$$;

-- Resultado de um Stand-by já resolvido. Mesma função para a resposta da
-- operação e para a repetição da mesma requisição: quem repete recebe
-- exatamente o que recebeu da primeira vez. Sem nome, CPF, telefone ou e-mail.
create or replace function public.reservation_standby_result(p_standby_id uuid, p_replayed boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'resolved', true,
    'replayed', coalesce(p_replayed, false),
    'standbyId', sb.id,
    'changeId', sb.resolved_change_id,
    'resolution', sb.resolution,
    'actorType', sb.resolved_by_type,
    'access', sb.resolved_access,
    'resolvedAt', sb.resolved_at,
    'reservationId', r.id,
    'publicCode', r.public_code,
    'status', r.status,
    'quantity', r.quantity,
    'unitPriceCents', r.unit_price_cents,
    'totalCents', r.total_cents,
    'previousSessionId', sb.original_session_id,
    'previousStartsAt', sb.original_starts_at,
    'previousExperienceId', sb.original_experience_id,
    'previousExperienceTitle', coalesce(previous_experience.title, ''),
    'targetSessionId', destination.id,
    'targetStartsAt', destination.starts_at,
    'targetExperienceId', destination_experience.id,
    'targetExperienceTitle', destination_experience.title,
    'targetSessionPriceCents', destination.price_cents,
    'experienceChanged', destination_experience.id is distinct from sb.original_experience_id
  )
  from public.reservation_standby sb
  join public.reservations r on r.id = sb.reservation_id
  join public.sessions destination on destination.id = sb.resolved_session_id
  join public.experiences destination_experience on destination_experience.id = destination.experience_id
  left join public.experiences previous_experience on previous_experience.id = sb.original_experience_id
  where sb.id = p_standby_id
    and sb.resolved_at is not null
    and sb.resolution in ('RESCHEDULED', 'RESTORED');
$$;

-- O núcleo. Toda saída de Stand-by que devolve a reserva a uma turma — desfazer,
-- reagendar pelo admin, reagendar pelo cliente — passa por aqui, e só por aqui.
--
-- ## Locks
--
-- A reserva é travada primeiro, depois a linha da autorização, depois a sessão
-- de destino. Reserva-antes-de-sessão é a mesma ordem de
-- `admin_change_reservation_session`, e aqui só **uma** sessão entra na
-- transação — a origem não precisa de lock porque sua ocupação já foi liberada
-- na entrada em Stand-by. Sem segunda sessão, não há ciclo de espera possível
-- com a troca administrativa.
--
-- ## Idempotência
--
-- A autorização é consumida na mesma transação que move a reserva. Repetir a
-- mesma requisição (mesma autorização, mesmo destino, mesmo tipo de ator)
-- depois do sucesso devolve o resultado gravado, com `replayed = true`, sem
-- escrever nada. Qualquer outra tentativa sobre uma autorização já encerrada é
-- STANDBY_ALREADY_USED. Duas requisições simultâneas se enfileiram no lock da
-- reserva: a segunda encontra a autorização encerrada e cai em um desses dois
-- casos.
--
-- Qualquer exceção aborta tudo: status, vínculo com a turma, autorização,
-- histórico e auditoria sobrevivem juntos ou não sobrevivem.
create or replace function public.reservation_standby_resolve(
  p_standby_id uuid,
  p_target_session_id uuid,
  p_mode text,
  p_actor_id uuid,
  p_access text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  standby public.reservation_standby%rowtype;
  target public.reservations%rowtype;
  destination_session public.sessions%rowtype;
  moved public.reservations%rowtype;
  origin_price_cents integer;
  rejection text;
  occupied integer;
  change_id uuid;
  normalized_reason text := nullif(trim(coalesce(p_reason, '')), '');
  actor_kind text;
  outcome text;
begin
  if p_mode is null or p_mode not in ('ADMIN', 'CUSTOMER', 'RESTORE') then
    raise exception 'STANDBY_INVALID_MODE' using errcode = '22023';
  end if;
  if p_access is null or p_access not in ('ADMIN', 'CPF_CODE', 'LINK')
     or (p_mode = 'CUSTOMER') = (p_access = 'ADMIN') then
    raise exception 'STANDBY_INVALID_MODE' using errcode = '22023';
  end if;
  if p_target_session_id is null then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001';
  end if;
  if normalized_reason is not null and char_length(normalized_reason) > 500 then
    raise exception 'REASON_TOO_LONG' using errcode = '22023';
  end if;

  actor_kind := case when p_mode = 'CUSTOMER' then 'CUSTOMER' else 'ADMIN' end;
  outcome := case when p_mode = 'RESTORE' then 'RESTORED' else 'RESCHEDULED' end;

  select * into standby from public.reservation_standby where id = p_standby_id;
  if not found then
    raise exception 'STANDBY_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Trava a reserva e só então relê a autorização: o que vale é o estado dela
  -- depois que qualquer transação concorrente terminou.
  select * into target from public.reservations where id = standby.reservation_id for update;
  select * into standby from public.reservation_standby where id = p_standby_id for update;

  if standby.resolved_at is not null then
    if standby.resolution = outcome
       and standby.resolved_by_type = actor_kind
       and standby.resolved_session_id = p_target_session_id
       and target.status = 'CONFIRMED'
       and target.session_id = p_target_session_id then
      return public.reservation_standby_result(standby.id, true);
    end if;
    raise exception 'STANDBY_ALREADY_USED' using errcode = 'P0001';
  end if;

  if target.status <> 'AWAITING_RESCHEDULE' then
    raise exception 'STANDBY_ALREADY_USED' using errcode = 'P0001';
  end if;

  -- Desfazer só existe para a turma original.
  if p_mode = 'RESTORE' and p_target_session_id <> standby.original_session_id then
    raise exception 'STANDBY_INVALID_MODE' using errcode = '22023';
  end if;

  select * into destination_session from public.sessions where id = p_target_session_id for update;
  if not found then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001';
  end if;

  rejection := public.reservation_standby_target_rejection(target.id, destination_session.id, p_mode);
  if rejection is not null then
    raise exception '%', rejection using errcode = 'P0001';
  end if;

  -- Mesma sequência de toda confirmação: retenções vencidas do destino deixam
  -- de contar, e a ocupação é recontada com a sessão travada. A própria reserva
  -- está em Stand-by e não entra na soma, mesmo voltando para a turma original.
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

  -- A reserva vai inteira ou não vai.
  if occupied + target.quantity > destination_session.capacity then
    raise exception 'INSUFFICIENT_SPOTS' using errcode = 'P0001';
  end if;

  -- Encerra a autorização **antes** de mexer no status: a trigger
  -- `reservations_standby_guard` só deixa a reserva voltar a CONFIRMED sem
  -- autorização aberta.
  update public.reservation_standby
  set resolved_at = now(),
      resolution = outcome,
      resolved_by_type = actor_kind,
      resolved_by = case when actor_kind = 'ADMIN' then p_actor_id else null end,
      resolved_access = p_access,
      resolved_session_id = destination_session.id,
      resolved_reason = normalized_reason
  where id = standby.id;

  -- A mudança: status e as duas colunas do vínculo. Nada mais é escrito —
  -- public_code, quantity, unit_price_cents, total_cents, confirmed_at,
  -- checkin_token, cliente e referência de pagamento ficam como estavam.
  update public.reservations
  set status = 'CONFIRMED',
      session_id = destination_session.id,
      experience_id = destination_session.experience_id,
      updated_at = now()
  where id = target.id
  returning * into moved;

  -- Reconferência dentro da transação: se qualquer trigger, presente ou futura,
  -- tiver alterado o que não podia, nada disto é gravado.
  if moved.status <> 'CONFIRMED'
     or moved.session_id is distinct from destination_session.id
     or moved.experience_id is distinct from destination_session.experience_id
     or moved.quantity is distinct from target.quantity
     or moved.unit_price_cents is distinct from target.unit_price_cents
     or moved.total_cents is distinct from target.total_cents
     or moved.public_code is distinct from target.public_code
     or moved.confirmed_at is distinct from target.confirmed_at
     or moved.checkin_token is distinct from target.checkin_token then
    raise exception 'STANDBY_INVARIANT_VIOLATION' using errcode = '23514';
  end if;

  select s.price_cents into origin_price_cents from public.sessions s where s.id = standby.original_session_id;

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
    reason,
    actor_type,
    origin,
    standby_id
  ) values (
    target.id,
    standby.original_session_id,
    destination_session.id,
    standby.original_experience_id,
    destination_session.experience_id,
    case when actor_kind = 'ADMIN' then p_actor_id else null end,
    target.quantity,
    target.unit_price_cents,
    target.total_cents,
    origin_price_cents,
    destination_session.price_cents,
    normalized_reason,
    actor_kind,
    case when p_mode = 'RESTORE' then 'STANDBY_RESTORE' else 'STANDBY_RESCHEDULE' end,
    standby.id
  )
  returning id into change_id;

  update public.reservation_standby set resolved_change_id = change_id where id = standby.id;

  -- Trilha única das mutações. O cliente não é usuário do painel, então entra
  -- sem `actor_user_id` e com o tipo de ator e a forma de acesso nos metadados.
  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, reason, metadata)
  values (
    case when actor_kind = 'ADMIN' then p_actor_id else null end,
    case when p_mode = 'RESTORE' then 'RESERVATION_STANDBY_RESTORED' else 'RESERVATION_STANDBY_RESCHEDULED' end,
    'RESERVATION',
    target.id,
    normalized_reason,
    jsonb_build_object(
      'standbyId', standby.id,
      'changeId', change_id,
      'actorType', actor_kind,
      'access', p_access,
      'previousSessionId', standby.original_session_id,
      'previousStartsAt', standby.original_starts_at,
      'previousExperienceId', standby.original_experience_id,
      'targetSessionId', destination_session.id,
      'targetStartsAt', destination_session.starts_at,
      'targetExperienceId', destination_session.experience_id,
      'quantity', target.quantity,
      'unitPriceCents', target.unit_price_cents,
      'totalCents', target.total_cents
    )
  );

  return public.reservation_standby_result(standby.id, false);
end;
$$;

-- Quem está pedindo, pelo cliente: uma única função resolve as duas credenciais
-- — CPF + código, ou o token do link — para a mesma coisa: a autorização.
--
-- Devolve também autorizações já encerradas (`is_open = false`): é o que
-- permite reconhecer a repetição de uma requisição que já deu certo. Quem
-- decide o que uma autorização encerrada ainda permite é o núcleo, não esta
-- função. Um link revogado tem o hash apagado e simplesmente não é encontrado.
create or replace function public.reservation_standby_access(
  p_cpf text,
  p_public_code text,
  p_link_token text
)
returns table (standby_id uuid, reservation_id uuid, access text, is_open boolean)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  normalized_cpf text := regexp_replace(coalesce(p_cpf, ''), E'\\D', '', 'g');
  normalized_code text := upper(trim(coalesce(p_public_code, '')));
  token text := lower(trim(coalesce(p_link_token, '')));
begin
  if token <> '' then
    -- Formato exato do token gerado. Qualquer outra coisa nem chega ao índice.
    if token !~ '^[0-9a-f]{64}$' then return; end if;
    return query
    select sb.id, sb.reservation_id, 'LINK'::text, sb.resolved_at is null
    from public.reservation_standby sb
    where sb.link_token_hash = encode(digest(token, 'sha256'), 'hex');
    return;
  end if;

  if normalized_cpf !~ '^\d{11}$' or normalized_code = '' then return; end if;

  return query
  select sb.id, sb.reservation_id, 'CPF_CODE'::text, sb.resolved_at is null
  from public.reservations r
  join public.reservation_standby sb on sb.reservation_id = r.id
  where r.public_code = normalized_code
    and r.cpf_hash = encode(digest(normalized_cpf, 'sha256'), 'hex')
  order by (sb.resolved_at is null) desc, sb.created_at desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Operações administrativas
-- ---------------------------------------------------------------------------
--
-- Todas conferem `is_active_admin(p_actor_id)` — ADMIN ou OPERATOR ativo. A
-- execução é restrita à service role, mas isso não basta por si: o servidor
-- deriva `p_actor_id` da sessão validada e a função recusa quem não é da equipe.

-- Colocar em Stand-by.
create or replace function public.admin_set_reservation_standby(
  p_actor_id uuid,
  p_reservation_id uuid,
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
  origin_experience public.experiences%rowtype;
  normalized_reason text := trim(coalesce(p_reason, ''));
  new_standby_id uuid;
  entered_at timestamptz;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if char_length(normalized_reason) < 3 then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  if char_length(normalized_reason) > 500 then
    raise exception 'REASON_TOO_LONG' using errcode = '22023';
  end if;

  -- Enquanto esta transação vive, ninguém confirma, cancela, move ou registra
  -- presença nesta reserva.
  select * into target from public.reservations where id = p_reservation_id for update;
  if not found then return null; end if;

  if target.status = 'AWAITING_RESCHEDULE' then
    raise exception 'RESERVATION_ALREADY_IN_STANDBY' using errcode = 'P0001';
  end if;
  -- Pré-reserva, expirada e cancelada (inclusive cancelada depois de paga) não
  -- entram: só o que está confirmado.
  if target.status <> 'CONFIRMED' then
    raise exception 'RESERVATION_NOT_CONFIRMED' using errcode = 'P0001';
  end if;
  if not public.reservation_has_confirmed_payment(target.id) then
    raise exception 'RESERVATION_PAYMENT_NOT_CONFIRMED' using errcode = 'P0001';
  end if;
  -- Presença parcial ou completa significa experiência consumida. O admin
  -- precisa resolver o check-in antes; ausência registrada (0) e reserva sem
  -- registro passam.
  if coalesce(target.checked_in_count, 0) > 0 then
    raise exception 'STANDBY_CHECKIN_REGISTERED' using errcode = 'P0001';
  end if;

  -- Sessão original passada ou futura, aberta ou não: nada aqui depende disso.
  select * into origin_session from public.sessions where id = target.session_id;
  select * into origin_experience from public.experiences where id = target.experience_id;
  if origin_session.id is null or origin_experience.id is null then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001';
  end if;

  insert into public.reservation_standby (
    reservation_id,
    original_session_id,
    original_experience_id,
    original_base_id,
    original_starts_at,
    quantity,
    unit_price_cents,
    total_cents,
    previous_checked_in_count,
    previous_checked_in_at,
    previous_checked_in_by,
    previous_checkin_method,
    created_by,
    reason
  ) values (
    target.id,
    origin_session.id,
    origin_experience.id,
    origin_experience.base_id,
    origin_session.starts_at,
    target.quantity,
    target.unit_price_cents,
    target.total_cents,
    target.checked_in_count,
    target.checked_in_at,
    target.checked_in_by,
    target.checkin_method,
    p_actor_id,
    normalized_reason
  )
  returning id, created_at into new_standby_id, entered_at;

  -- A liberação da vaga é este UPDATE: a turma original deixa de somar a
  -- reserva porque ela deixou de ser CONFIRMED. Os campos de presença ativos são
  -- limpos para a reserva chegar à próxima turma sem registro herdado.
  update public.reservations
  set status = 'AWAITING_RESCHEDULE',
      checked_in_count = null,
      checked_in_at = null,
      checked_in_by = null,
      checkin_method = null,
      updated_at = now()
  where id = target.id;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, reason, metadata)
  values (
    p_actor_id,
    'RESERVATION_STANDBY_SET',
    'RESERVATION',
    target.id,
    normalized_reason,
    jsonb_build_object(
      'standbyId', new_standby_id,
      'originalSessionId', origin_session.id,
      'originalStartsAt', origin_session.starts_at,
      'originalExperienceId', origin_experience.id,
      'originalExperienceTitle', origin_experience.title,
      'originalBaseId', origin_experience.base_id,
      'quantity', target.quantity,
      'unitPriceCents', target.unit_price_cents,
      'totalCents', target.total_cents,
      'previousCheckedInCount', target.checked_in_count
    )
  );

  return jsonb_build_object(
    'standbyId', new_standby_id,
    'reservationId', target.id,
    'publicCode', target.public_code,
    'status', 'AWAITING_RESCHEDULE',
    'quantity', target.quantity,
    'unitPriceCents', target.unit_price_cents,
    'totalCents', target.total_cents,
    'originalSessionId', origin_session.id,
    'originalStartsAt', origin_session.starts_at,
    'originalExperienceId', origin_experience.id,
    'originalExperienceTitle', origin_experience.title,
    'enteredAt', entered_at
  );
end;
$$;

-- Autorização mais recente da reserva, com a aberta na frente. As duas
-- operações abaixo partem dela; se já estiver encerrada, o núcleo decide entre
-- "repetição da mesma requisição" e STANDBY_ALREADY_USED.
create or replace function public.reservation_latest_standby(p_reservation_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select sb.id
  from public.reservation_standby sb
  where sb.reservation_id = p_reservation_id
  order by (sb.resolved_at is null) desc, sb.created_at desc, sb.resolved_at desc
  limit 1;
$$;

-- Desfazer um Stand-by: devolve a reserva à turma original, se ela ainda puder
-- recebê-la. Sem vaga, com a turma fechada ou já iniciada, a operação é
-- recusada e o Stand-by continua aberto, intacto.
create or replace function public.admin_undo_reservation_standby(
  p_actor_id uuid,
  p_reservation_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  latest_id uuid;
  original_session uuid;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (select 1 from public.reservations where id = p_reservation_id) then
    return null;
  end if;

  latest_id := public.reservation_latest_standby(p_reservation_id);
  if latest_id is null then
    raise exception 'RESERVATION_NOT_IN_STANDBY' using errcode = 'P0001';
  end if;
  select original_session_id into original_session from public.reservation_standby where id = latest_id;

  return public.reservation_standby_resolve(latest_id, original_session, 'RESTORE', p_actor_id, 'ADMIN', p_reason);
end;
$$;

-- Reagendar, pelo admin, uma reserva que está em Stand-by. Mesmas regras de
-- destino do reagendamento tradicional — sem restrição de preço — e a turma
-- original também é um destino válido.
create or replace function public.admin_reschedule_reservation_from_standby(
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
  latest_id uuid;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (select 1 from public.reservations where id = p_reservation_id) then
    return null;
  end if;

  latest_id := public.reservation_latest_standby(p_reservation_id);
  if latest_id is null then
    raise exception 'RESERVATION_NOT_IN_STANDBY' using errcode = 'P0001';
  end if;

  return public.reservation_standby_resolve(latest_id, p_target_session_id, 'ADMIN', p_actor_id, 'ADMIN', p_reason);
end;
$$;

-- Lista "Aguardando reagendamento": só autorizações abertas, a mais antiga
-- primeiro. Traz o contato porque é para a equipe ligar para o cliente; nunca
-- CPF, hash de CPF nem o hash do link.
create or replace function public.admin_list_standby_reservations(p_actor_id uuid)
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

  select coalesce(jsonb_agg(item order by entered_at), '[]'::jsonb) into result
  from (
    select
      sb.created_at as entered_at,
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
        'originalBaseName', b.name,
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
    limit 500
  ) open_standbys;

  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Link individual
-- ---------------------------------------------------------------------------
--
-- 32 bytes do gerador criptográfico do pgcrypto, em hexadecimal (64
-- caracteres, 256 bits). O banco guarda apenas o SHA-256: com essa entropia não
-- há o que um salt acrescente, e um vazamento da tabela não entrega link
-- nenhum. O texto do token existe uma única vez, na resposta desta função.
--
-- O link vale enquanto a autorização estiver aberta. Gerar de novo substitui o
-- hash e invalida o anterior; revogar apaga o hash; resolver o Stand-by encerra
-- a autorização. A auditoria registra a ação, nunca o token nem o hash.
create or replace function public.admin_generate_reservation_standby_link(
  p_actor_id uuid,
  p_reservation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  standby public.reservation_standby%rowtype;
  token text;
  generated_at timestamptz := now();
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  perform 1 from public.reservations where id = p_reservation_id for update;
  if not found then return null; end if;

  select * into standby
  from public.reservation_standby
  where reservation_id = p_reservation_id and resolved_at is null
  for update;
  if not found then
    raise exception 'RESERVATION_NOT_IN_STANDBY' using errcode = 'P0001';
  end if;

  token := encode(gen_random_bytes(32), 'hex');

  update public.reservation_standby
  set link_token_hash = encode(digest(token, 'sha256'), 'hex'),
      link_created_at = generated_at,
      link_created_by = p_actor_id,
      link_revoked_at = null
  where id = standby.id;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (
    p_actor_id,
    'RESERVATION_STANDBY_LINK_GENERATED',
    'RESERVATION',
    p_reservation_id,
    jsonb_build_object('standbyId', standby.id, 'replacedPrevious', standby.link_token_hash is not null)
  );

  return jsonb_build_object('standbyId', standby.id, 'token', token, 'createdAt', generated_at);
end;
$$;

create or replace function public.admin_revoke_reservation_standby_link(
  p_actor_id uuid,
  p_reservation_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  standby public.reservation_standby%rowtype;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  perform 1 from public.reservations where id = p_reservation_id for update;
  if not found then return false; end if;

  select * into standby
  from public.reservation_standby
  where reservation_id = p_reservation_id and resolved_at is null
  for update;
  if not found then
    raise exception 'RESERVATION_NOT_IN_STANDBY' using errcode = 'P0001';
  end if;
  if standby.link_token_hash is null then return false; end if;

  update public.reservation_standby
  set link_token_hash = null,
      link_revoked_at = now()
  where id = standby.id;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (
    p_actor_id,
    'RESERVATION_STANDBY_LINK_REVOKED',
    'RESERVATION',
    p_reservation_id,
    jsonb_build_object('standbyId', standby.id)
  );

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Autoatendimento do cliente
-- ---------------------------------------------------------------------------
--
-- As duas funções recebem a credencial a cada chamada — CPF + código, ou o
-- token do link — e nunca um id de reserva, uma quantidade ou um valor. O que o
-- cliente escolhe é uma única coisa: a sessão de destino.
--
-- Executáveis apenas pela service role: o navegador fala com o servidor da
-- aplicação, que é quem aplica origem e limite de tentativas antes de chegar
-- aqui. A interface pública vem em outra etapa.

-- O que o cliente em Stand-by pode ver e escolher. Devolve null quando a
-- credencial não corresponde a uma autorização aberta — sem distinguir "não
-- existe" de "não está em Stand-by", para não confirmar a existência de reserva.
create or replace function public.customer_reschedule_options(
  p_cpf text,
  p_public_code text,
  p_link_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  access_row record;
  standby public.reservation_standby%rowtype;
  target public.reservations%rowtype;
  options jsonb;
  hidden_for_capacity integer;
begin
  select a.* into access_row
  from public.reservation_standby_access(p_cpf, p_public_code, p_link_token) a
  where a.is_open
  limit 1;
  if not found then return null; end if;

  select * into standby from public.reservation_standby where id = access_row.standby_id;
  select * into target from public.reservations where id = access_row.reservation_id;
  if target.status <> 'AWAITING_RESCHEDULE' or standby.resolved_at is not null then
    return null;
  end if;

  -- O recorte barato (aberta e futura) vem primeiro; a decisão é da mesma régua
  -- que o núcleo aplica na hora de confirmar. Turmas sem vaga para o grupo
  -- inteiro não são oferecidas e são contadas à parte.
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
        'experienceSlug', e.slug,
        'experienceTitle', e.title,
        'baseSlug', b.slug,
        'baseName', b.name,
        'startsAt', s.starts_at,
        'durationMinutes', s.duration_minutes,
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

  return jsonb_build_object(
    'standbyId', standby.id,
    'access', access_row.access,
    'publicCode', target.public_code,
    'firstName', split_part(trim(target.full_name), ' ', 1),
    'status', target.status,
    'quantity', target.quantity,
    'unitPriceCents', target.unit_price_cents,
    'totalCents', target.total_cents,
    'enteredAt', standby.created_at,
    'original', (
      select jsonb_build_object(
        'sessionId', standby.original_session_id,
        'startsAt', standby.original_starts_at,
        'experienceTitle', e.title,
        'baseName', b.name
      )
      from public.experiences e
      left join public.bases b on b.id = standby.original_base_id
      where e.id = standby.original_experience_id
    ),
    'hiddenForCapacity', coalesce(hidden_for_capacity, 0),
    'options', options
  );
end;
$$;

-- Confirma o reagendamento escolhido pelo cliente.
--
-- `p_standby_id` é a autorização que o cliente viu em
-- `customer_reschedule_options`. Ele precisa pertencer à reserva identificada
-- pela credencial — não basta conhecer um id. Daí em diante a decisão é toda do
-- núcleo: uma autorização aberta reagenda uma única vez; a mesma requisição
-- repetida devolve o resultado gravado; qualquer outra coisa é recusada.
create or replace function public.customer_reschedule_reservation(
  p_cpf text,
  p_public_code text,
  p_link_token text,
  p_standby_id uuid,
  p_target_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  access_row record;
begin
  if p_standby_id is null then
    raise exception 'STANDBY_NOT_AUTHORIZED' using errcode = '42501';
  end if;

  select a.* into access_row
  from public.reservation_standby_access(p_cpf, p_public_code, p_link_token) a
  where a.standby_id = p_standby_id
  limit 1;
  if not found then
    raise exception 'STANDBY_NOT_AUTHORIZED' using errcode = '42501';
  end if;

  return public.reservation_standby_resolve(
    p_standby_id, p_target_session_id, 'CUSTOMER', null, access_row.access, null
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Grants
-- ---------------------------------------------------------------------------
--
-- No Supabase, função nova nasce executável por PUBLIC e, pelos privilégios
-- padrão do projeto, por anon, authenticated e service_role. Por isso tudo é
-- revogado explicitamente antes de conceder.

-- Internas: ninguém executa diretamente. As RPCs abaixo são `security definer`
-- e as alcançam como proprietário.
revoke all on function public.enforce_reservation_standby_transition() from public, anon, authenticated, service_role;
revoke all on function public.reservation_has_confirmed_payment(uuid) from public, anon, authenticated, service_role;
revoke all on function public.reservation_standby_target_rejection(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.reservation_standby_result(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.reservation_standby_resolve(uuid, uuid, text, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.reservation_standby_access(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.reservation_latest_standby(uuid) from public, anon, authenticated, service_role;

-- RPCs do servidor: somente a service role.
revoke all on function public.admin_set_reservation_standby(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_undo_reservation_standby(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_reschedule_reservation_from_standby(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_list_standby_reservations(uuid) from public, anon, authenticated;
revoke all on function public.admin_generate_reservation_standby_link(uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_revoke_reservation_standby_link(uuid, uuid) from public, anon, authenticated;
revoke all on function public.customer_reschedule_options(text, text, text) from public, anon, authenticated;
revoke all on function public.customer_reschedule_reservation(text, text, text, uuid, uuid) from public, anon, authenticated;

grant execute on function public.admin_set_reservation_standby(uuid, uuid, text) to service_role;
grant execute on function public.admin_undo_reservation_standby(uuid, uuid, text) to service_role;
grant execute on function public.admin_reschedule_reservation_from_standby(uuid, uuid, uuid, text) to service_role;
grant execute on function public.admin_list_standby_reservations(uuid) to service_role;
grant execute on function public.admin_generate_reservation_standby_link(uuid, uuid) to service_role;
grant execute on function public.admin_revoke_reservation_standby_link(uuid, uuid) to service_role;
grant execute on function public.customer_reschedule_options(text, text, text) to service_role;
grant execute on function public.customer_reschedule_reservation(text, text, text, uuid, uuid) to service_role;

-- As funções substituídas nas seções 4 a 6 mantêm os grants que já tinham
-- (`create or replace` preserva o ACL). Reafirmados para que esta migration
-- seja suficiente mesmo em um banco reconstruído do zero.
revoke all on function public.reconcile_reservation_payment(uuid, text, text, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.confirm_reservation_payment(uuid, text, text, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.admin_confirm_reservation(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_payments_needing_review(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.payment_review_counters() from public, anon, authenticated;
revoke all on function public.admin_dashboard_metrics(uuid) from public, anon, authenticated;
revoke all on function public.admin_base_dashboard_metrics(uuid, uuid) from public, anon, authenticated;

grant execute on function public.reconcile_reservation_payment(uuid, text, text, integer, text, jsonb) to service_role;
grant execute on function public.confirm_reservation_payment(uuid, text, text, integer, text, jsonb) to service_role;
grant execute on function public.admin_confirm_reservation(uuid, uuid, text) to service_role;
grant execute on function public.admin_payments_needing_review(uuid, integer, integer) to service_role;
grant execute on function public.payment_review_counters() to service_role;
grant execute on function public.admin_dashboard_metrics(uuid) to service_role;
grant execute on function public.admin_base_dashboard_metrics(uuid, uuid) to service_role;
