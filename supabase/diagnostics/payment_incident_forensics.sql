-- Forense do incidente de confirmação de pagamento. SOMENTE LEITURA.
--
-- ## Como usar
--
-- Cole no SQL Editor do Supabase de **produção** e rode bloco a bloco. Nenhuma
-- consulta escreve, cria ou altera qualquer coisa: não há INSERT, UPDATE,
-- DELETE nem chamada de RPC que mude estado.
--
-- ## O que NÃO sai daqui
--
-- CPF, hash de CPF, nome, telefone, e-mail, checkout_url, token, chave da
-- InfinitePay, service role e payload integral de pagamento. Identificadores
-- saem mascarados (oito primeiros caracteres + quatro últimos), o suficiente
-- para correlacionar com os logs da Vercel e insuficiente para vazar.
--
-- ## O que responder com o resultado
--
-- O bloco 1 é a tabela pedida no diagnóstico:
--   horário do pagamento | horário do webhook | status anterior | status final |
--   evento encontrado? | confirmação executada? | causa
--
-- Os blocos seguintes separam os casos A–J.

-- Janela de análise. Ajuste se precisar olhar mais para trás.
\set janela '60 days'

-- ---------------------------------------------------------------------------
-- Helper de mascaramento (sessão apenas; nada é persistido).
-- ---------------------------------------------------------------------------
create or replace function pg_temp.mask(value text)
returns text language sql immutable as $$
  select case
    when value is null or value = '' then null
    when length(value) <= 8 then left(value, 2) || '…'
    else left(value, 8) || '…' || right(value, 4)
  end;
$$;

-- ---------------------------------------------------------------------------
-- 1. TABELA PRINCIPAL — linha do tempo por reserva não confirmada
-- ---------------------------------------------------------------------------
--
-- `causa` é a leitura automática do que aconteceu, derivada dos eventos e dos
-- carimbos de tempo. É esta coluna que classifica os casos A–J.
with base as (
  select
    r.id,
    r.public_code,
    r.status,
    r.total_cents,
    r.created_at,
    r.expires_at,
    r.confirmed_at,
    r.checkout_url is not null                                        as tem_checkout,
    r.provider_reference,
    s.starts_at,
    s.capacity,
    (
      select min(pe.processed_at) from public.payment_events pe
      where pe.reservation_id = r.id
        and pe.event_type in ('PAYMENT_CONFIRMED', 'PAYMENT_CONFIRMED_RECONCILED', 'PAYMENT_AFTER_EXPIRATION',
                              'PAYMENT_AFTER_EXPIRATION_NO_CAPACITY', 'PAYMENT_CONFIRMED_MANUAL')
    )                                                                 as pagamento_em,
    (
      select min(pe.processed_at) from public.payment_events pe
      where pe.reservation_id = r.id and pe.event_type = 'PAYMENT_WEBHOOK_RECEIVED'
    )                                                                 as webhook_em,
    (
      select count(*) from public.payment_events pe where pe.reservation_id = r.id
    )                                                                 as eventos,
    (
      select array_agg(distinct pe.event_type order by pe.event_type)
      from public.payment_events pe where pe.reservation_id = r.id
    )                                                                 as tipos_de_evento,
    -- De onde veio a tentativa: webhook, retorno do navegador ou admin.
    -- É esta coluna que responde o Caso I (dependência silenciosa do retorno).
    (
      select array_agg(distinct pe.payload ->> 'stage')
      from public.payment_events pe
      where pe.reservation_id = r.id and pe.payload ? 'stage'
    )                                                                 as origens
  from public.reservations r
  join public.sessions s on s.id = r.session_id
  where r.created_at > now() - interval :'janela'
    and r.status <> 'CONFIRMED'
    and r.checkout_url is not null
)
select
  pg_temp.mask(b.id::text)                                            as reservation_id_mascarado,
  pg_temp.mask(b.public_code)                                         as public_code_mascarado,
  b.pagamento_em                                                      as "horário do pagamento",
  b.webhook_em                                                        as "horário do webhook",
  'PRE_RESERVED'                                                      as "status anterior",
  b.status                                                            as "status final",
  (b.eventos > 0)                                                     as "evento encontrado?",
  (b.confirmed_at is not null)                                        as "confirmação executada?",
  case
    when b.eventos = 0 and b.status = 'EXPIRED'
      then 'F/B — nenhum evento: webhook não chegou ou foi rejeitado antes de gravar'
    when 'PAYMENT_AFTER_EXPIRATION_NO_CAPACITY' = any(b.tipos_de_evento)
      then 'Pago sem capacidade — exige realocação ou estorno'
    when 'PAYMENT_AFTER_EXPIRATION' = any(b.tipos_de_evento)
      then 'D/E — pagamento aprovado depois de expires_at'
    when 'PAYMENT_AMOUNT_MISMATCH' = any(b.tipos_de_evento)
      then 'J — valor divergente barrou a confirmação'
    when 'PAYMENT_NOT_CONFIRMED' = any(b.tipos_de_evento)
      then 'C — payment_check respondeu não pago e nada retentou'
    when 'PAYMENT_WEBHOOK_RECEIVED' = any(b.tipos_de_evento)
      then 'C — webhook registrado e confirmação não concluída'
    else 'A conferir nos logs da Vercel'
  end                                                                 as causa,
  b.origens                                                           as origens_das_tentativas,
  b.tipos_de_evento,
  b.created_at                                                        as reserva_criada_em,
  b.expires_at                                                        as retencao_expirava_em,
  b.starts_at                                                         as turma_em,
  b.total_cents,
  pg_temp.mask(b.provider_reference)                                  as provider_reference_mascarada,
  extract(epoch from (b.webhook_em - b.created_at)) / 60              as minutos_ate_o_webhook,
  extract(epoch from (b.webhook_em - b.expires_at)) / 60              as minutos_apos_a_expiracao
from base b
order by b.created_at desc;

-- ---------------------------------------------------------------------------
-- 2. CASO A — reserva PRE_RESERVED ou EXPIRED com evidência de pagamento
-- ---------------------------------------------------------------------------
--
-- Estas são as candidatas reais à correção consciente. **Não altere nada aqui.**
select
  pg_temp.mask(r.id::text)          as reservation_id_mascarado,
  pg_temp.mask(r.public_code)       as public_code_mascarado,
  r.status,
  r.total_cents,
  pe.event_type,
  pe.amount_cents,
  pe.processed_at,
  pg_temp.mask(pe.provider_event_id) as provider_event_id_mascarado,
  (pe.payload ? 'receipt_url')      as tem_recibo,
  pe.payload ->> 'capture_method'   as forma_de_pagamento,
  s.starts_at                       as turma_em,
  public.available_spots(s.id)      as vagas_disponiveis_agora
from public.reservations r
join public.sessions s on s.id = r.session_id
join public.payment_events pe on pe.reservation_id = r.id
where r.status in ('PRE_RESERVED', 'EXPIRED')
  and pe.event_type in ('PAYMENT_CONFIRMED', 'PAYMENT_CONFIRMED_RECONCILED', 'PAYMENT_AFTER_EXPIRATION',
                        'PAYMENT_AFTER_EXPIRATION_NO_CAPACITY')
  and r.created_at > now() - interval :'janela'
order by pe.processed_at desc;

-- ---------------------------------------------------------------------------
-- 3. CASO F/B — reserva com checkout e nenhum evento
-- ---------------------------------------------------------------------------
--
-- Se o cliente pagou e não existe evento algum, o webhook não chegou ou foi
-- rejeitado antes de gravar. Cruze `reservation_id_mascarado` com os logs da
-- Vercel em /api/payments/infinitepay/webhook no intervalo criada_em → turma_em,
-- e com o extrato da InfinitePay pelo horário.
select
  pg_temp.mask(r.id::text)     as reservation_id_mascarado,
  pg_temp.mask(r.public_code)  as public_code_mascarado,
  r.status,
  r.total_cents,
  r.created_at                 as criada_em,
  r.expires_at                 as expirava_em,
  s.starts_at                  as turma_em
from public.reservations r
join public.sessions s on s.id = r.session_id
where r.checkout_url is not null
  and r.status in ('PRE_RESERVED', 'EXPIRED')
  and r.created_at > now() - interval :'janela'
  and not exists (select 1 from public.payment_events pe where pe.reservation_id = r.id)
order by r.created_at desc;

-- ---------------------------------------------------------------------------
-- 4. CASO I — quanto do fluxo depende do retorno do navegador
-- ---------------------------------------------------------------------------
--
-- Se `return_page` responder por uma fatia relevante das confirmações, o webhook
-- está degradado em produção e ninguém percebeu porque a maioria dos clientes
-- volta ao site. É a consulta mais reveladora deste arquivo.
select
  coalesce(pe.payload ->> 'stage', 'sem_origem_registrada') as origem,
  pe.event_type,
  count(*)                                                  as ocorrencias,
  min(pe.processed_at)                                      as primeira,
  max(pe.processed_at)                                      as ultima
from public.payment_events pe
where pe.processed_at > now() - interval :'janela'
group by 1, 2
order by 1, 3 desc;

-- ---------------------------------------------------------------------------
-- 5. Tempo real entre pagamento e confirmação nas reservas que CONFIRMARAM
-- ---------------------------------------------------------------------------
--
-- É o número que diz se a retenção de 2 horas é generosa ou apertada, e é a
-- referência para dimensionar a janela de segurança.
with confirmadas as (
  select
    r.id,
    r.created_at,
    r.confirmed_at,
    (
      select min(pe.processed_at) from public.payment_events pe
      where pe.reservation_id = r.id and pe.event_type = 'PAYMENT_WEBHOOK_RECEIVED'
    ) as webhook_em,
    (
      select array_agg(distinct pe.payload ->> 'stage')
      from public.payment_events pe
      where pe.reservation_id = r.id and pe.payload ? 'stage'
    ) as origens
  from public.reservations r
  where r.status = 'CONFIRMED'
    and r.confirmed_at is not null
    and r.created_at > now() - interval :'janela'
)
select
  count(*)                                                                          as reservas_confirmadas,
  round(avg(extract(epoch from (confirmed_at - created_at)) / 60)::numeric, 1)      as media_min_criacao_ate_confirmacao,
  round(max(extract(epoch from (confirmed_at - created_at)) / 60)::numeric, 1)      as maximo_min_criacao_ate_confirmacao,
  round(avg(extract(epoch from (confirmed_at - webhook_em)) / 60)::numeric, 2)      as media_min_webhook_ate_confirmacao,
  round(max(extract(epoch from (confirmed_at - webhook_em)) / 60)::numeric, 2)      as maximo_min_webhook_ate_confirmacao,
  count(*) filter (where webhook_em is null)                                        as confirmadas_sem_webhook_registrado,
  count(*) filter (where 'return_page' = any(origens))                              as tocadas_pelo_retorno,
  count(*) filter (where 'webhook_received' = any(origens))                         as tocadas_pelo_webhook,
  count(*) filter (where 'admin_verification' = any(origens))                       as tocadas_pelo_admin
from confirmadas;

-- ---------------------------------------------------------------------------
-- 6. Risco de overbooking agora
-- ---------------------------------------------------------------------------
--
-- Sessões futuras com reservas pagas e não confirmadas: se a vaga já foi
-- revendida, `vagas_disponiveis` chega a zero e o pagamento fica sem lugar.
select
  pg_temp.mask(s.id::text)                     as session_id_mascarado,
  s.starts_at                                  as turma_em,
  s.capacity                                   as capacidade,
  public.available_spots(s.id)                 as vagas_disponiveis,
  count(*) filter (where r.status = 'CONFIRMED')                                          as confirmadas,
  count(*) filter (where r.status = 'PRE_RESERVED' and r.expires_at > now())              as pre_reservadas_vigentes,
  count(*) filter (
    where r.status <> 'CONFIRMED'
      and exists (
        select 1 from public.payment_events pe
        where pe.reservation_id = r.id
          and pe.event_type in ('PAYMENT_AFTER_EXPIRATION', 'PAYMENT_AFTER_EXPIRATION_NO_CAPACITY',
                                'PAYMENT_CONFIRMED', 'PAYMENT_CONFIRMED_RECONCILED')
      )
  )                                                                                       as pagas_sem_confirmacao
from public.sessions s
join public.reservations r on r.session_id = s.id
where s.starts_at > now()
  and s.status not in ('CANCELLED', 'ARCHIVED')
group by s.id, s.starts_at, s.capacity
having count(*) filter (
  where r.status <> 'CONFIRMED'
    and exists (
      select 1 from public.payment_events pe
      where pe.reservation_id = r.id
        and pe.event_type in ('PAYMENT_AFTER_EXPIRATION', 'PAYMENT_AFTER_EXPIRATION_NO_CAPACITY',
                              'PAYMENT_CONFIRMED', 'PAYMENT_CONFIRMED_RECONCILED')
    )
) > 0
order by s.starts_at;

-- ---------------------------------------------------------------------------
-- 7. Estado da infraestrutura de expiração
-- ---------------------------------------------------------------------------
--
-- Se o job não existir, não estiver ativo ou estiver falhando, a expiração nem
-- está rodando — e o diagnóstico muda completamente.
select jobid, schedule, command, nodename, active
from cron.job
where command ilike '%expire_pre_reservations%';

select
  j.jobid,
  d.status,
  count(*)          as execucoes,
  max(d.end_time)   as ultima_execucao
from cron.job j
left join cron.job_run_details d on d.jobid = j.jobid
where j.command ilike '%expire_pre_reservations%'
  and d.start_time > now() - interval '7 days'
group by j.jobid, d.status
order by j.jobid, d.status;

-- ---------------------------------------------------------------------------
-- 8. Após aplicar 202608280001 — trilha durável do webhook
-- ---------------------------------------------------------------------------
--
-- Enquanto a migration nova não estiver aplicada, este bloco falha com "relation
-- does not exist". É o esperado e não invalida os blocos anteriores.
select
  l.received_at,
  l.source,
  l.step,
  l.outcome,
  l.http_status,
  l.error_code,
  pg_temp.mask(l.order_id)          as order_id_mascarado,
  (l.reservation_id is not null)    as casou_com_reserva,
  l.payload ->> 'body_format'       as formato_do_corpo,
  l.payload ->> 'content_type'      as content_type
from public.payment_webhook_log l
where l.received_at > now() - interval :'janela'
order by l.received_at desc
limit 200;
