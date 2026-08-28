-- Confiabilidade da confirmação de pagamento — P0 de integridade de capacidade.
--
-- ## O que estava quebrado
--
-- `expire_pre_reservations()` roda a cada minuto pelo pg_cron e libera a vaga
-- assumindo que "não recebi confirmação = não pagou". `available_spots()` vai
-- além: para de contar a pré-reserva no instante em que `expires_at` passa, sem
-- sequer esperar o cron. Como o webhook da InfinitePay é hoje o único caminho
-- automático de confirmação — o retorno do navegador depende do cliente voltar e
-- a verificação administrativa depende de uma pessoa clicar — qualquer webhook
-- perdido, atrasado, rejeitado ou respondido com erro vira vaga revendida com o
-- dinheiro do primeiro cliente na conta.
--
-- ## O que esta migration muda
--
-- 1. **Janela de segurança na expiração.** Uma pré-reserva que chegou ao fim da
--    retenção e que chegou a gerar checkout não libera a vaga na hora: entra em
--    *hold*. O hold é implementado empurrando o próprio `expires_at`, e não com
--    um predicado novo de ocupação. Isso é deliberado: `available_spots`,
--    `create_pre_reservation`, `admin_confirm_reservation`,
--    `admin_change_reservation_session`, `reconcile_reservation_payment` e
--    `confirm_reservation_payment` já respeitam `expires_at > now()`, então
--    todas passam a respeitar o hold sem serem reescritas. Menos superfície
--    alterada, mesma garantia. O prazo original do cliente fica preservado em
--    `original_expires_at`.
--
-- 2. **Reconciliação com o gateway.** `claim_payment_reconciliation` entrega à
--    aplicação as reservas que precisam ser conferidas na InfinitePay, com
--    reivindicação `for update skip locked` para duas execuções simultâneas
--    nunca dobrarem trabalho.
--
-- 3. **Nada é liberado em silêncio.** Um hold que chega ao fim sem resposta
--    definitiva do gateway grava `PAYMENT_HOLD_EXHAUSTED` antes de a vaga voltar
--    ao mercado, e a reserva aparece na revisão administrativa.
--
-- 4. **Trilha durável.** `payment_webhook_log` registra cada etapa do fluxo —
--    inclusive webhook que não casou com nenhuma reserva, que hoje não deixa
--    rastro nenhum no banco. É o que responde "por que essa reserva não
--    confirmou?" sem abrir dez lugares.
--
-- 5. **Revisão administrativa.** `admin_payments_needing_review` e o contador no
--    dashboard substituem a conferência manual do extrato.
--
-- Aditiva e idempotente. Não altera nenhuma reserva existente, nenhum pagamento,
-- nenhum preço e nenhuma capacidade. As colunas novas entram nulas e só passam a
-- ter efeito quando o cron seguinte roda.

-- ---------------------------------------------------------------------------
-- 1. Estado de retenção e reconciliação na própria reserva
-- ---------------------------------------------------------------------------
alter table public.reservations add column if not exists payment_hold_until timestamptz;
alter table public.reservations add column if not exists payment_hold_started_at timestamptz;
alter table public.reservations add column if not exists original_expires_at timestamptz;
alter table public.reservations add column if not exists reconciliation_attempts integer not null default 0;
alter table public.reservations add column if not exists last_reconciled_at timestamptz;
alter table public.reservations add column if not exists last_reconciliation_code text;

-- Mesma barreira de vazamento usada em integration_sync_jobs: o código é um
-- símbolo curto e maiúsculo, nunca uma mensagem do gateway.
do $$ begin
  alter table public.reservations
    add constraint reservations_reconciliation_code_check
    check (last_reconciliation_code is null or last_reconciliation_code ~ '^[A-Z0-9_]{1,64}$');
exception when duplicate_object then null;
end $$;

-- Fila da reconciliação: pré-reservas por vencer, em hold, e recém-expiradas.
create index if not exists reservations_reconciliation_idx
  on public.reservations (expires_at)
  where status in ('PRE_RESERVED', 'EXPIRED');

create index if not exists reservations_payment_hold_idx
  on public.reservations (payment_hold_until)
  where payment_hold_until is not null;

-- ---------------------------------------------------------------------------
-- 2. Parâmetros da janela de segurança
-- ---------------------------------------------------------------------------
--
-- Funções em vez de constantes espalhadas: dá para ajustar a janela com uma
-- migration de uma linha, sem tocar em nenhuma lógica.

-- Quanto tempo a vaga fica retida além do prazo do cliente antes de ser
-- liberada. Precisa ser maior que o intervalo do cron de reconciliação.
create or replace function public.payment_hold_minutes()
returns integer language sql immutable as $$ select 30 $$;

-- Teto absoluto de retenção, contado a partir do prazo original. Impede que um
-- gateway fora do ar congele a capacidade para sempre.
create or replace function public.payment_hold_max_minutes()
returns integer language sql immutable as $$ select 180 $$;

-- ---------------------------------------------------------------------------
-- 3. Trilha durável de pagamento
-- ---------------------------------------------------------------------------
--
-- `payment_events` só aceita evento ligado a uma reserva existente (FK not
-- null). Justamente o caso mais difícil de diagnosticar — webhook cujo
-- `order_nsu` não casa com reserva nenhuma, ou corpo que nem dá para ler — não
-- cabe lá. Esta tabela aceita, e por isso é ela que fecha o Caso B/F/G.
create table if not exists public.payment_webhook_log (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  request_id text not null,
  source text not null,
  step text not null,
  outcome text,
  order_id text,
  reservation_id uuid references public.reservations(id) on delete set null,
  provider_reference text,
  provider_event_id text,
  http_status integer,
  duration_ms integer,
  error_code text,
  payload jsonb not null default '{}'::jsonb
);

do $$ begin
  alter table public.payment_webhook_log
    add constraint payment_webhook_log_source_check
    check (source in ('WEBHOOK', 'RETURN_PAGE', 'ADMIN', 'RECONCILIATION', 'EXPIRATION'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.payment_webhook_log
    add constraint payment_webhook_log_step_check
    check (step ~ '^[A-Z0-9_]{1,64}$');
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.payment_webhook_log
    add constraint payment_webhook_log_error_code_check
    check (error_code is null or error_code ~ '^[A-Z0-9_]{1,64}$');
exception when duplicate_object then null;
end $$;

create index if not exists payment_webhook_log_received_idx
  on public.payment_webhook_log (received_at desc);
create index if not exists payment_webhook_log_reservation_idx
  on public.payment_webhook_log (reservation_id, received_at desc);
create index if not exists payment_webhook_log_failure_idx
  on public.payment_webhook_log (received_at desc)
  where outcome in ('FAILED', 'INVALID');

alter table public.payment_webhook_log enable row level security;
revoke all on public.payment_webhook_log from anon, authenticated;

-- Escrita da trilha. Nunca lança por dado ruim: uma etapa que não consegue ser
-- registrada não pode derrubar a confirmação de um pagamento. `order_id` chega
-- como texto porque um webhook pode trazer qualquer coisa ali; só vira
-- `reservation_id` quando é uuid e existe de fato.
create or replace function public.record_payment_step(
  p_request_id text,
  p_source text,
  p_step text,
  p_outcome text,
  p_order_id text,
  p_provider_reference text,
  p_provider_event_id text,
  p_http_status integer,
  p_duration_ms integer,
  p_error_code text,
  p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_reservation uuid;
  normalized_order text := nullif(trim(coalesce(p_order_id, '')), '');
  log_id uuid;
begin
  if normalized_order is not null and normalized_order ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select id into resolved_reservation from public.reservations where id = normalized_order::uuid;
  end if;

  insert into public.payment_webhook_log (
    request_id, source, step, outcome, order_id, reservation_id,
    provider_reference, provider_event_id, http_status, duration_ms, error_code, payload
  ) values (
    coalesce(nullif(trim(coalesce(p_request_id, '')), ''), 'unknown'),
    case when coalesce(p_source, '') in ('WEBHOOK', 'RETURN_PAGE', 'ADMIN', 'RECONCILIATION', 'EXPIRATION')
         then p_source else 'WEBHOOK' end,
    case when coalesce(p_step, '') ~ '^[A-Z0-9_]{1,64}$' then p_step else 'UNKNOWN_STEP' end,
    nullif(trim(coalesce(p_outcome, '')), ''),
    left(coalesce(normalized_order, ''), 200),
    resolved_reservation,
    left(nullif(trim(coalesce(p_provider_reference, '')), ''), 200),
    left(nullif(trim(coalesce(p_provider_event_id, '')), ''), 200),
    p_http_status,
    p_duration_ms,
    case when coalesce(p_error_code, '') ~ '^[A-Z0-9_]{1,64}$' then p_error_code else null end,
    coalesce(p_payload, '{}'::jsonb)
  )
  returning id into log_id;

  return log_id;
exception when others then
  -- Observabilidade nunca derruba pagamento.
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Expiração com janela de segurança
-- ---------------------------------------------------------------------------
--
-- Substitui a versão que liberava a vaga assumindo que ninguém pagou.
--
-- Três passos, nesta ordem:
--
--   1. **Retém.** Toda pré-reserva que chegou ao fim do prazo e que chegou a
--      gerar checkout — ou seja, que o cliente pode ter pago — tem o prazo
--      empurrado para `expires_at + payment_hold_minutes()`. A vaga continua
--      ocupada porque todo o resto do sistema já respeita `expires_at`.
--
--   2. **Denuncia.** Um hold que termina sem que a reconciliação tenha
--      concluído "não pago" grava `PAYMENT_HOLD_EXHAUSTED` antes de a vaga sair.
--      Nunca liberamos em silêncio uma reserva que pode estar paga.
--
--   3. **Expira.** Só o que está fora da janela. O predicado é o mesmo de
--      sempre, e é por isso que nenhuma outra função precisou mudar.
create or replace function public.expire_pre_reservations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  hold_minutes integer := public.payment_hold_minutes();
  affected integer;
begin
  -- 1. Retenção.
  with held as (
    update public.reservations r
    set original_expires_at = coalesce(r.original_expires_at, r.expires_at),
        payment_hold_started_at = now(),
        -- `greatest(..., now() + 1 min)` cobre o retroativo: uma reserva que
        -- venceu há horas (cron parado, primeira execução após o deploy) ainda
        -- ganha uma janela real de verificação em vez de nascer vencida.
        payment_hold_until = greatest(r.expires_at + make_interval(mins => hold_minutes), now() + interval '1 minute'),
        expires_at = greatest(r.expires_at + make_interval(mins => hold_minutes), now() + interval '1 minute'),
        updated_at = now()
    where r.status = 'PRE_RESERVED'
      and r.expires_at <= now()
      and r.payment_hold_until is null
      and r.checkout_url is not null
    returning r.id, r.payment_provider, r.original_expires_at, r.payment_hold_until
  )
  insert into public.payment_events (reservation_id, provider, provider_event_id, event_type, amount_cents, payload)
  select h.id,
         coalesce(h.payment_provider, 'UNKNOWN'),
         'hold:' || h.id::text,
         'EXPIRATION_HELD_FOR_PAYMENT_CHECK',
         0,
         jsonb_build_object(
           'original_expires_at', h.original_expires_at,
           'payment_hold_until', h.payment_hold_until,
           'hold_minutes', hold_minutes
         )
  from held h
  on conflict (provider, provider_event_id) do nothing;

  -- 2. Hold encerrado sem resposta definitiva do gateway.
  insert into public.payment_events (reservation_id, provider, provider_event_id, event_type, amount_cents, payload)
  select r.id,
         coalesce(r.payment_provider, 'UNKNOWN'),
         'hold-exhausted:' || r.id::text,
         'PAYMENT_HOLD_EXHAUSTED',
         0,
         jsonb_build_object(
           'original_expires_at', r.original_expires_at,
           'payment_hold_until', r.payment_hold_until,
           'reconciliation_attempts', r.reconciliation_attempts,
           'last_reconciliation_code', r.last_reconciliation_code
         )
  from public.reservations r
  where r.status = 'PRE_RESERVED'
    and r.expires_at <= now()
    and r.payment_hold_until is not null
    and coalesce(r.last_reconciliation_code, '') <> 'NOT_PAID'
  on conflict (provider, provider_event_id) do nothing;

  -- 3. Expiração propriamente dita.
  update public.reservations
  set status = 'EXPIRED', updated_at = now()
  where status = 'PRE_RESERVED' and expires_at <= now();
  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Operações de hold usadas pela reconciliação
-- ---------------------------------------------------------------------------

-- Estende a retenção enquanto o estado do pagamento continua incerto — gateway
-- fora do ar, resposta ambígua, Pix ainda liquidando. O teto é absoluto e
-- contado a partir do prazo original: capacidade não fica refém de um provedor
-- indisponível.
create or replace function public.hold_reservation_for_payment_check(
  p_reservation_id uuid,
  p_minutes integer,
  p_code text
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.reservations%rowtype;
  baseline timestamptz;
  ceiling_at timestamptz;
  new_until timestamptz;
begin
  select * into target from public.reservations where id = p_reservation_id for update;
  if not found or target.status <> 'PRE_RESERVED' then return null; end if;

  baseline := coalesce(target.original_expires_at, target.expires_at);
  ceiling_at := baseline + make_interval(mins => public.payment_hold_max_minutes());
  new_until := least(now() + make_interval(mins => greatest(coalesce(p_minutes, public.payment_hold_minutes()), 1)), ceiling_at);

  update public.reservations
  set original_expires_at = baseline,
      payment_hold_started_at = coalesce(payment_hold_started_at, now()),
      payment_hold_until = greatest(coalesce(payment_hold_until, new_until), new_until),
      expires_at = greatest(expires_at, new_until),
      last_reconciled_at = now(),
      last_reconciliation_code = case when coalesce(p_code, '') ~ '^[A-Z0-9_]{1,64}$' then p_code else last_reconciliation_code end,
      updated_at = now()
  where id = target.id
  returning payment_hold_until into new_until;

  return new_until;
end;
$$;

-- Devolve a vaga ao mercado. Só aceita conclusão definitiva: enquanto o estado
-- for incerto, a vaga não sai. É esta whitelist que impede a reconciliação de
-- "resolver" um erro de rede liberando a vaga de quem pagou.
create or replace function public.release_reservation_payment_hold(
  p_reservation_id uuid,
  p_code text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare normalized text := upper(trim(coalesce(p_code, '')));
begin
  if normalized not in ('NOT_PAID', 'CANCELLED', 'SESSION_CANCELLED', 'RESERVATION_NOT_FOUND') then
    return false;
  end if;

  update public.reservations
  set expires_at = least(expires_at, now()),
      payment_hold_until = now(),
      last_reconciled_at = now(),
      last_reconciliation_code = normalized,
      updated_at = now()
  where id = p_reservation_id
    and status = 'PRE_RESERVED'
    and payment_hold_until is not null;

  return found;
end;
$$;

-- Marca o resultado de uma tentativa sem mexer em prazo nem em vaga.
create or replace function public.record_reconciliation_result(
  p_reservation_id uuid,
  p_code text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.reservations
  set last_reconciled_at = now(),
      last_reconciliation_code = case when coalesce(p_code, '') ~ '^[A-Z0-9_]{1,64}$' then p_code else last_reconciliation_code end,
      updated_at = now()
  where id = p_reservation_id;
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Fila da reconciliação
-- ---------------------------------------------------------------------------
--
-- Entrega o conjunto de reservas cujo estado de pagamento precisa ser conferido
-- diretamente na InfinitePay. Quatro origens, todas do incidente real:
--
--   A. pré-reserva prestes a vencer — conferir *antes* de a vaga sair;
--   B. pré-reserva em hold — é para isso que o hold existe;
--   C. reserva recém-expirada com checkout gerado — pagamento atrasado;
--   D. reserva com sinal de pagamento em `payment_events` e sem confirmação —
--      webhook que chegou, foi registrado e não confirmou.
--
-- `for update skip locked` + carimbo de tentativa na própria reivindicação: duas
-- execuções simultâneas do cron nunca pegam a mesma linha, e o retry de uma
-- execução perdida não repete trabalho recente.
create or replace function public.claim_payment_reconciliation(
  p_limit integer,
  p_stale_minutes integer,
  p_lookback_hours integer
)
returns table (
  reservation_id uuid,
  reservation_status public.reservation_status,
  expires_at timestamptz,
  payment_hold_until timestamptz,
  original_expires_at timestamptz,
  total_cents integer,
  provider_reference text,
  reconciliation_attempts integer
)
language plpgsql
security definer
set search_path = public
as $$
-- `returns table (...)` transforma cada coluna de saída em variável plpgsql, e
-- todas elas têm o nome de uma coluna de `reservations`. Toda referência abaixo é
-- qualificada por alias, mas a diretiva torna a regra explícita e à prova de
-- edição futura: em caso de ambiguidade, vence a coluna.
#variable_conflict use_column
declare
  batch integer := least(greatest(coalesce(p_limit, 10), 1), 50);
  stale integer := greatest(coalesce(p_stale_minutes, 5), 1);
  lookback integer := least(greatest(coalesce(p_lookback_hours, 72), 1), 720);
begin
  return query
  update public.reservations r
  set reconciliation_attempts = r.reconciliation_attempts + 1,
      last_reconciled_at = now(),
      updated_at = now()
  where r.id in (
    select c.id
    from public.reservations c
    where c.status in ('PRE_RESERVED', 'EXPIRED')
      and c.checkout_url is not null
      -- Não reconferir o que acabou de ser conferido, exceto quando a janela
      -- está fechando: aí a urgência vence a economia de chamadas.
      and (
        c.last_reconciled_at is null
        or c.last_reconciled_at < now() - make_interval(mins => stale)
        or c.expires_at <= now() + interval '5 minutes'
      )
      and not exists (
        select 1 from public.payment_events pe
        where pe.reservation_id = c.id
          and pe.event_type in ('PAYMENT_CONFIRMED', 'PAYMENT_CONFIRMED_MANUAL', 'PAYMENT_CONFIRMED_RECONCILED')
      )
      and (
        -- A. prestes a vencer
        (c.status = 'PRE_RESERVED' and c.expires_at <= now() + interval '10 minutes')
        -- B. em janela de segurança
        or (c.status = 'PRE_RESERVED' and c.payment_hold_until is not null and c.payment_hold_until > now())
        -- C. expirada há pouco
        or (c.status = 'EXPIRED' and c.updated_at > now() - make_interval(hours => lookback))
        -- D. tem sinal de pagamento e não confirmou
        or exists (
          select 1 from public.payment_events pe
          where pe.reservation_id = c.id
            and pe.event_type in (
              'PAYMENT_WEBHOOK_RECEIVED', 'PAYMENT_NOT_CONFIRMED', 'PAYMENT_AMOUNT_MISMATCH',
              'PAYMENT_AFTER_EXPIRATION', 'PAYMENT_HOLD_EXHAUSTED'
            )
            and pe.processed_at > now() - make_interval(hours => lookback)
        )
      )
    order by c.expires_at asc
    limit batch
    for update skip locked
  )
  returning r.id, r.status, r.expires_at, r.payment_hold_until, r.original_expires_at,
            r.total_cents, r.provider_reference, r.reconciliation_attempts;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Reconciliação: incidente explícito quando falta capacidade
-- ---------------------------------------------------------------------------
--
-- Mesma lógica da versão anterior, com duas mudanças:
--
--   * o resultado fica carimbado em `last_reconciliation_code`, para a revisão
--     administrativa e a fila da reconciliação enxergarem o estado;
--   * `NO_CAPACITY` limpa o hold. A vaga já não é desta reserva — segurá-la só
--     bloquearia capacidade sem resolver nada. O evento
--     `PAYMENT_AFTER_EXPIRATION_NO_CAPACITY` permanece e é o que faz a reserva
--     aparecer, para sempre, em "Pagamentos para revisar".
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

-- ---------------------------------------------------------------------------
-- 8. Confirmação: limpa o estado de reconciliação
-- ---------------------------------------------------------------------------
--
-- Igual à versão anterior em tudo que decide a confirmação. A única diferença é
-- não deixar hold pendurado em reserva já confirmada — e, com o hold embutido em
-- `expires_at`, o caminho feliz passa a cobrir também a reserva paga dentro da
-- janela de segurança, que antes caía na reconciliação.
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

-- ---------------------------------------------------------------------------
-- 9. Status de pagamento derivado — passa a enxergar reconciliação e incidente
-- ---------------------------------------------------------------------------
create or replace function public.reservation_payment_status(p_reservation_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (
      select 1 from public.payment_events pe
      where pe.reservation_id = r.id
        and pe.event_type in ('PAYMENT_CONFIRMED', 'PAYMENT_CONFIRMED_MANUAL', 'PAYMENT_CONFIRMED_RECONCILED')
    ) then 'PAID'
    when exists (
      select 1 from public.payment_events pe
      where pe.reservation_id = r.id
        and pe.event_type = 'PAYMENT_AFTER_EXPIRATION_NO_CAPACITY'
    ) then 'PAID_NO_CAPACITY'
    when exists (
      select 1 from public.payment_events pe
      where pe.reservation_id = r.id and pe.event_type = 'PAYMENT_AFTER_EXPIRATION'
    ) then 'PAID_AFTER_EXPIRATION'
    when r.status = 'PRE_RESERVED' and r.expires_at > now() then 'PENDING'
    else 'NOT_PAID'
  end
  from public.reservations r
  where r.id = p_reservation_id;
$$;

-- Mesma correção na listagem do painel: uma reserva recuperada pela
-- reconciliação aparecia como NOT_PAID porque o CASE não conhecia
-- `PAYMENT_CONFIRMED_RECONCILED`.
create or replace function public.admin_list_reservations(p_actor_id uuid,p_date date,p_experience_id uuid,p_status public.reservation_status,p_name text,p_phone text,p_cpf text,p_session_id uuid,p_payment_status text,p_query text,p_sort text)
returns table (id uuid,public_code text,reservation_status public.reservation_status,full_name text,cpf_last4 char(4),phone text,email text,quantity integer,total_cents integer,notes text,expires_at timestamptz,payment_provider text,provider_reference text,payment_status text,confirmed_at timestamptz,cancelled_at timestamptz,created_at timestamptz,updated_at timestamptz,session_id uuid,starts_at timestamptz,experience_id uuid,experience_title text)
language plpgsql security definer set search_path=public,extensions as $$ declare normalized_cpf text:=regexp_replace(coalesce(p_cpf,''),E'\\D','','g'); begin
  if not public.is_active_admin(p_actor_id) then raise exception 'ADMIN_FORBIDDEN' using errcode='42501'; end if; perform public.expire_pre_reservations();
  return query with rows as(select r.*,s.starts_at,e.title experience_title,
    case when exists(select 1 from public.payment_events pe where pe.reservation_id=r.id and pe.event_type in('PAYMENT_CONFIRMED','PAYMENT_CONFIRMED_MANUAL','PAYMENT_CONFIRMED_RECONCILED')) then 'PAID'
         when exists(select 1 from public.payment_events pe where pe.reservation_id=r.id and pe.event_type='PAYMENT_AFTER_EXPIRATION_NO_CAPACITY') then 'PAID_NO_CAPACITY'
         when exists(select 1 from public.payment_events pe where pe.reservation_id=r.id and pe.event_type='PAYMENT_AFTER_EXPIRATION') then 'PAID_AFTER_EXPIRATION'
         when r.status='PRE_RESERVED' and r.expires_at>now() then 'PENDING' else 'NOT_PAID' end pay_status
    from public.reservations r join public.sessions s on s.id=r.session_id join public.experiences e on e.id=r.experience_id)
  select x.id,x.public_code,x.status,x.full_name,x.cpf_last4,x.phone,x.email,x.quantity,x.total_cents,x.notes,x.expires_at,x.payment_provider,x.provider_reference,x.pay_status,x.confirmed_at,x.cancelled_at,x.created_at,x.updated_at,x.session_id,x.starts_at,x.experience_id,x.experience_title from rows x
  where(p_date is null or(x.starts_at at time zone 'America/Sao_Paulo')::date=p_date) and(p_experience_id is null or x.experience_id=p_experience_id) and(p_status is null or x.status=p_status) and(p_session_id is null or x.session_id=p_session_id)
  and(nullif(trim(p_name),'') is null or x.full_name ilike '%'||trim(p_name)||'%') and(nullif(regexp_replace(coalesce(p_phone,''),E'\\D','','g'),'') is null or regexp_replace(x.phone,E'\\D','','g') like '%'||regexp_replace(p_phone,E'\\D','','g')||'%')
  and(nullif(trim(p_payment_status),'') is null or x.pay_status=p_payment_status) and(nullif(trim(p_query),'') is null or x.full_name ilike '%'||trim(p_query)||'%' or x.public_code ilike '%'||trim(p_query)||'%')
  and(normalized_cpf='' or(char_length(normalized_cpf)=11 and x.cpf_hash=encode(digest(normalized_cpf,'sha256'),'hex'))or(char_length(normalized_cpf)<=4 and x.cpf_last4=right(normalized_cpf,4)))
  order by case when p_sort='oldest' then x.created_at end asc,case when p_sort='session' then x.starts_at end asc,x.created_at desc limit 500;
end $$;

-- ---------------------------------------------------------------------------
-- 10. Revisão administrativa: "Pagamentos para revisar"
-- ---------------------------------------------------------------------------
--
-- Substitui a conferência manual do extrato. Sem CPF, sem nome, sem telefone,
-- sem e-mail e sem payload: só o que a equipe precisa para agir.
create or replace function public.payment_review_reason(p_reservation_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (select 1 from public.payment_events pe where pe.reservation_id = r.id and pe.event_type = 'PAYMENT_AFTER_EXPIRATION_NO_CAPACITY')
      then 'APPROVED_NO_CAPACITY'
    when exists (select 1 from public.payment_events pe where pe.reservation_id = r.id and pe.event_type = 'PAYMENT_AFTER_EXPIRATION')
      then 'PAID_NOT_CONFIRMED'
    when exists (select 1 from public.payment_events pe where pe.reservation_id = r.id and pe.event_type = 'PAYMENT_AMOUNT_MISMATCH')
      then 'AMOUNT_MISMATCH'
    when exists (select 1 from public.payment_events pe where pe.reservation_id = r.id and pe.event_type = 'PAYMENT_HOLD_EXHAUSTED')
      then 'HOLD_EXHAUSTED'
    when r.reconciliation_attempts >= 5 and coalesce(r.last_reconciliation_code, '') in ('PROVIDER_UNAVAILABLE', 'RECONCILE_FAILED')
      then 'RECONCILIATION_FAILING'
    when r.status = 'EXPIRED' and exists (select 1 from public.payment_events pe where pe.reservation_id = r.id and pe.event_type = 'PAYMENT_WEBHOOK_RECEIVED')
      then 'EXPIRED_WITH_PAYMENT_SIGNAL'
    else null
  end
  from public.reservations r
  where r.id = p_reservation_id;
$$;

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
    where r.status <> 'CONFIRMED'
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

-- Contador barato para o dashboard e para alerta. Não exige admin porque não
-- projeta nada: devolve só números, e o grant continua restrito ao service role.
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
      where r.status <> 'CONFIRMED'
        and r.created_at > now() - interval '30 days'
        and public.payment_review_reason(r.id) is not null
    ),
    'approvedNoCapacity', (
      select count(distinct pe.reservation_id) from public.payment_events pe
      join public.reservations r on r.id = pe.reservation_id
      where pe.event_type = 'PAYMENT_AFTER_EXPIRATION_NO_CAPACITY'
        and r.status <> 'CONFIRMED'
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

-- Dashboard: mesmo conteúdo de antes mais o contador de revisão.
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
    'paymentReview', public.payment_review_counters(),
    'lastUpdatedAt', greatest(coalesce((select max(updated_at) from public.experiences), '-infinity'::timestamptz), coalesce((select max(updated_at) from public.sessions), '-infinity'::timestamptz), coalesce((select max(updated_at) from public.reservations), '-infinity'::timestamptz))
  ) into result; return result;
end $$;

-- ---------------------------------------------------------------------------
-- 11. Grants
-- ---------------------------------------------------------------------------
revoke all on function public.payment_hold_minutes() from public, anon, authenticated;
revoke all on function public.payment_hold_max_minutes() from public, anon, authenticated;
revoke all on function public.record_payment_step(text, text, text, text, text, text, text, integer, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.hold_reservation_for_payment_check(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.release_reservation_payment_hold(uuid, text) from public, anon, authenticated;
revoke all on function public.record_reconciliation_result(uuid, text) from public, anon, authenticated;
revoke all on function public.claim_payment_reconciliation(integer, integer, integer) from public, anon, authenticated;
revoke all on function public.payment_review_reason(uuid) from public, anon, authenticated;
revoke all on function public.payment_review_counters() from public, anon, authenticated;
revoke all on function public.admin_payments_needing_review(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.reservation_payment_status(uuid) from public, anon, authenticated;
revoke all on function public.admin_list_reservations(uuid, date, uuid, public.reservation_status, text, text, text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.admin_dashboard_metrics(uuid) from public, anon, authenticated;

grant execute on function public.record_payment_step(text, text, text, text, text, text, text, integer, integer, text, jsonb) to service_role;
grant execute on function public.hold_reservation_for_payment_check(uuid, integer, text) to service_role;
grant execute on function public.release_reservation_payment_hold(uuid, text) to service_role;
grant execute on function public.record_reconciliation_result(uuid, text) to service_role;
grant execute on function public.claim_payment_reconciliation(integer, integer, integer) to service_role;
grant execute on function public.payment_review_reason(uuid) to service_role;
grant execute on function public.payment_review_counters() to service_role;
grant execute on function public.admin_payments_needing_review(uuid, integer, integer) to service_role;
grant execute on function public.reservation_payment_status(uuid) to service_role;
grant execute on function public.admin_list_reservations(uuid, date, uuid, public.reservation_status, text, text, text, uuid, text, text, text) to service_role;
grant execute on function public.admin_dashboard_metrics(uuid) to service_role;
grant execute on function public.expire_pre_reservations() to service_role;
