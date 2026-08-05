-- Confiabilidade da confirmação de pagamento InfinitePay.
--
-- Corrige dois buracos que deixam o cliente pago e a reserva pendente:
--
--   1. Não havia nenhum registro de webhook que falhasse antes da confirmação.
--      Um webhook rejeitado não deixava rastro em payment_events, então era
--      impossível diagnosticar depois. `record_payment_attempt` resolve isso.
--
--   2. `confirm_reservation_payment` recusa confirmar quando expires_at já passou
--      e ainda força a reserva para EXPIRED, devolvendo false. O dinheiro fica
--      com a Alma Azul e a vaga não. `reconcile_reservation_payment` recupera
--      esse caso quando ainda existe capacidade, e informa explicitamente quando
--      não existe, para tratamento humano (estorno/realocação).
--
-- Aditiva e idempotente. Não altera nenhuma função existente, nenhuma reserva,
-- nenhum payment_event já gravado, nenhum preço, capacidade ou sessão.

-- 1. Registro de tentativa de pagamento -------------------------------------
--
-- Grava qualquer etapa observada do fluxo (webhook recebido, verificação
-- falhada, valor divergente...) sem confirmar nada. Idempotente por
-- (provider, provider_event_id). Devolve false quando a reserva não existe,
-- para o chamador distinguir "order_nsu desconhecido" de "gravado".
create or replace function public.record_payment_attempt(
  p_reservation_id uuid,
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_amount_cents integer,
  p_payload jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_reservation_id is null
     or not exists (select 1 from public.reservations where id = p_reservation_id) then
    return false;
  end if;

  insert into public.payment_events (
    reservation_id, provider, provider_event_id, event_type, amount_cents, payload
  ) values (
    p_reservation_id,
    coalesce(nullif(trim(p_provider), ''), 'UNKNOWN'),
    coalesce(nullif(trim(p_provider_event_id), ''), 'attempt-' || gen_random_uuid()::text),
    coalesce(nullif(trim(p_event_type), ''), 'PAYMENT_ATTEMPT'),
    greatest(coalesce(p_amount_cents, 0), 0),
    coalesce(p_payload, '{}'::jsonb)
  )
  on conflict (provider, provider_event_id) do nothing;

  return true;
end;
$$;

-- 2. Reconciliação de pagamento comprovado ----------------------------------
--
-- Só deve ser chamada depois que o backend confirmou com o payment_check da
-- InfinitePay que o pagamento existe e está pago. Confirma a reserva mesmo
-- fora da janela de retenção, desde que a sessão ainda comporte a vaga.
--
-- Retorna um texto de resultado, nunca lança para caso de negócio:
--   ALREADY_CONFIRMED | RECONCILED | AMOUNT_MISMATCH
--   NO_CAPACITY | CANCELLED | SESSION_CANCELLED | NOT_FOUND
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
  -- Trava a reserva primeiro e a sessão depois: mesma ordem usada por
  -- create_pre_reservation e admin_confirm_reservation_manually, o que evita
  -- deadlock na corrida entre webhook, retorno do pagamento e expiração.
  select * into target from public.reservations where id = p_reservation_id for update;
  if not found then return 'NOT_FOUND'; end if;
  if target.status = 'CONFIRMED' then return 'ALREADY_CONFIRMED'; end if;
  if target.status = 'CANCELLED' then return 'CANCELLED'; end if;

  if target.total_cents <> p_amount_cents then
    perform public.record_payment_attempt(
      target.id, p_provider, coalesce(nullif(trim(p_provider_event_id), ''), gen_random_uuid()::text) || ':mismatch',
      'PAYMENT_AMOUNT_MISMATCH', greatest(coalesce(p_amount_cents, 0), 0),
      coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('expected_cents', target.total_cents)
    );
    return 'AMOUNT_MISMATCH';
  end if;

  select * into target_session from public.sessions where id = target.session_id for update;
  if not found then return 'NOT_FOUND'; end if;
  if target_session.status = 'CANCELLED' then return 'SESSION_CANCELLED'; end if;

  -- Materializa vencidas das outras reservas antes de recontar a ocupação.
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
      -- Empurra expires_at para o futuro: impede que expire_pre_reservations ou
      -- qualquer recontagem volte a tratar esta reserva como vencida.
      expires_at = greatest(expires_at, now() + interval '1 hour'),
      updated_at = now()
  where id = target.id;

  return 'RECONCILED';
end;
$$;

-- 3. Grants ------------------------------------------------------------------
revoke all on function public.record_payment_attempt(uuid, text, text, text, integer, jsonb)
  from public, anon, authenticated;
revoke all on function public.reconcile_reservation_payment(uuid, text, text, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_payment_attempt(uuid, text, text, text, integer, jsonb) to service_role;
grant execute on function public.reconcile_reservation_payment(uuid, text, text, integer, text, jsonb) to service_role;
