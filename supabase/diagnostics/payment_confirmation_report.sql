-- Diagnóstico de pagamentos não confirmados. SOMENTE LEITURA.
-- Não projeta nome, email, telefone, CPF nem payload integral.
-- Rode no SQL Editor do Supabase para investigar reservas pagas que ficaram pendentes.

-- 1. Reservas com checkout gerado que não estão confirmadas -------------------
--    "tem link da InfinitePay mas não virou CONFIRMED"
select
  r.id                                            as reservation_id,
  r.public_code,
  r.status,
  r.quantity,
  r.total_cents,
  r.payment_provider,
  left(coalesce(r.provider_reference, ''), 12)    as provider_reference_prefix,
  (r.checkout_url is not null)                    as has_checkout,
  r.created_at,
  r.expires_at,
  r.confirmed_at,
  s.starts_at                                     as session_starts_at,
  count(pe.id)                                    as payment_event_count,
  array_agg(pe.event_type order by pe.processed_at) filter (where pe.id is not null) as event_types,
  max(pe.processed_at)                            as last_event_at
from public.reservations r
join public.sessions s on s.id = r.session_id
left join public.payment_events pe on pe.reservation_id = r.id
where r.checkout_url is not null
  and r.status <> 'CONFIRMED'
  and r.created_at > now() - interval '90 days'
group by r.id, s.starts_at
order by r.created_at desc;

-- 2. Reservas com evidência de pagamento e status incoerente ------------------
--    Estas são as candidatas reais à reconciliação.
select
  r.id           as reservation_id,
  r.public_code,
  r.status       as reservation_status,
  r.total_cents,
  pe.event_type,
  pe.amount_cents,
  pe.processed_at,
  left(pe.provider_event_id, 16) as provider_event_id_prefix,
  (pe.payload ? 'receipt_url')   as has_receipt
from public.reservations r
join public.payment_events pe on pe.reservation_id = r.id
where pe.event_type in (
        'PAYMENT_AFTER_EXPIRATION',
        'PAYMENT_AFTER_EXPIRATION_NO_CAPACITY',
        'PAYMENT_AMOUNT_MISMATCH',
        'PAYMENT_NOT_CONFIRMED',
        'PAYMENT_WEBHOOK_RECEIVED'
      )
  and r.status <> 'CONFIRMED'
order by pe.processed_at desc;

-- 3. Reservas sem NENHUM evento de pagamento ---------------------------------
--    Se o cliente pagou e não existe evento algum, o webhook não chegou ou foi
--    rejeitado antes de gravar. Confira os logs da Vercel em
--    /api/payments/infinitepay/webhook no intervalo created_at → starts_at.
select
  r.id          as reservation_id,
  r.public_code,
  r.status,
  r.total_cents,
  r.created_at,
  r.expires_at
from public.reservations r
where r.checkout_url is not null
  and r.status in ('PRE_RESERVED', 'EXPIRED')
  and r.created_at > now() - interval '90 days'
  and not exists (select 1 from public.payment_events pe where pe.reservation_id = r.id)
order by r.created_at desc;

-- 4. Capacidade atual das sessões envolvidas ---------------------------------
--    Antes de reconciliar, confirme que ainda cabe a vaga.
select
  s.id             as session_id,
  s.starts_at,
  s.capacity,
  public.available_spots(s.id) as available_spots
from public.sessions s
where s.id in (
  select r.session_id
  from public.reservations r
  where r.checkout_url is not null
    and r.status <> 'CONFIRMED'
    and r.created_at > now() - interval '90 days'
)
order by s.starts_at;
