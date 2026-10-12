-- =============================================================================
-- ROLLBACK de 202610130002_reservation_standby.sql — SOMENTE PARA REVISÃO.
-- NÃO EXECUTAR sem decisão explícita. Não está em supabase/migrations/ de
-- propósito, para nenhuma ferramenta aplicá-lo automaticamente.
-- =============================================================================
--
-- O que faz: remove as operações de Stand-by e a trigger da invariante, e devolve
-- as sete funções substituídas (pagamento, revisão e métricas) ao texto anterior.
--
-- O que NÃO faz, de propósito:
--   * não remove o valor AWAITING_RESCHEDULE do enum — o Postgres não permite.
--     Sem as operações, nada mais consegue gravá-lo e ele fica inerte;
--   * não apaga a tabela `reservation_standby` nem as colunas novas de
--     `reservation_session_changes`: são histórico. A remoção está no fim,
--     comentada, e só faz sentido com a tabela vazia.
--
-- ORDEM IMPORTA. Antes de executar:
--   1. publicar uma versão do app que não chame nenhuma RPC de Stand-by;
--   2. resolver TODAS as reservas em Stand-by (reagendar, desfazer ou cancelar).
--      Sem as travas, uma reserva em AWAITING_RESCHEDULE poderia ser reconfirmada
--      na turma antiga por um webhook repetido. O bloco abaixo recusa o rollback
--      enquanto existir alguma.
--
-- Não perde: reservas, pagamentos, presença, auditoria nem histórico de trocas.

begin;

do $$
begin
  if exists (select 1 from public.reservations where status = 'AWAITING_RESCHEDULE')
     or exists (select 1 from public.reservation_standby where resolved_at is null) then
    raise exception 'ROLLBACK_BLOCKED_OPEN_STANDBY'
      using hint = 'Resolva todas as reservas em Stand-by antes de reverter.';
  end if;
end;
$$;

-- 1. Remove as operações exclusivas desta migration.
drop function if exists public.customer_reschedule_reservation(text, text, text, uuid, uuid);
drop function if exists public.customer_reschedule_options(text, text, text);
drop function if exists public.admin_revoke_reservation_standby_link(uuid, uuid);
drop function if exists public.admin_generate_reservation_standby_link(uuid, uuid);
drop function if exists public.admin_list_standby_reservations(uuid);
drop function if exists public.admin_reschedule_reservation_from_standby(uuid, uuid, uuid, text);
drop function if exists public.admin_undo_reservation_standby(uuid, uuid, text);
drop function if exists public.admin_set_reservation_standby(uuid, uuid, text);
drop function if exists public.reservation_latest_standby(uuid);
drop function if exists public.reservation_standby_access(text, text, text);
drop function if exists public.reservation_standby_resolve(uuid, uuid, text, uuid, text, text);
drop function if exists public.reservation_standby_result(uuid, boolean);
drop function if exists public.reservation_standby_target_rejection(uuid, uuid, text);
drop function if exists public.reservation_has_confirmed_payment(uuid);

drop trigger if exists reservations_standby_guard on public.reservations;
drop function if exists public.enforce_reservation_standby_transition();

-- 2. Devolve as funções substituídas à definição anterior. `create or replace`
--    preserva os grants existentes.
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
    'expectedRevenueCents', (select coalesce(sum(total_cents), 0) from base_reservations where status = 'CONFIRMED' or (status = 'PRE_RESERVED' and expires_at > now())),
    'confirmedRevenueCents', (select coalesce(sum(total_cents), 0) from base_reservations where status = 'CONFIRMED'),
    'totalParticipants', (select coalesce(sum(quantity), 0) from base_reservations where status = 'CONFIRMED'),
    'averageOccupancyRate', (select coalesce(round(avg((u.capacity - public.available_spots(u.id)) * 100.0 / nullif(u.capacity, 0)), 1), 0) from upcoming u),
    'topExperience', (
      select be.title from base_reservations r join base_experiences be on be.id = r.experience_id
      where r.status = 'CONFIRMED' group by be.id, be.title order by sum(r.quantity) desc limit 1
    ),
    'monthlyRevenueCents', (select coalesce(sum(total_cents), 0) from base_reservations where status = 'CONFIRMED' and confirmed_at >= date_trunc('month', now())),
    'averageTicketCents', (select coalesce(round(avg(total_cents)), 0) from base_reservations where status = 'CONFIRMED'),
    'revenueByMonth', (
      select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m.month, 'Mon'), 'revenueCents', coalesce(x.total, 0)) order by m.month), '[]'::jsonb)
      from generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') m(month)
      left join lateral (
        select sum(total_cents) total from base_reservations
        where status = 'CONFIRMED' and confirmed_at >= m.month and confirmed_at < m.month + interval '1 month'
      ) x on true
    ),
    'lastUpdatedAt', greatest(
      coalesce((select max(updated_at) from base_sessions), '-infinity'::timestamptz),
      coalesce((select max(updated_at) from base_reservations), '-infinity'::timestamptz)
    )
  ) into result;

  return result;
end;
$$;

commit;

-- 3. Opcional, em outra execução, e só com `reservation_standby` vazia: remover
--    a estrutura. Com qualquer linha gravada, isto apaga histórico.
--
-- begin;
-- alter table public.reservation_session_changes drop constraint if exists reservation_session_changes_distinct_sessions;
-- alter table public.reservation_session_changes add constraint reservation_session_changes_distinct_sessions check (previous_session_id <> target_session_id);
-- drop index if exists public.reservation_session_changes_standby_key;
-- alter table public.reservation_session_changes
--   drop constraint if exists reservation_session_changes_origin_consistent,
--   drop constraint if exists reservation_session_changes_origin_allowed,
--   drop constraint if exists reservation_session_changes_actor_type_allowed,
--   drop column if exists standby_id,
--   drop column if exists origin,
--   drop column if exists actor_type;
-- drop table if exists public.reservation_standby;
-- commit;
