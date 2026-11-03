-- CUPONS DE DESCONTO — RELATÓRIO DE USOS (SOMENTE LEITURA)
--
-- Uma linha por cupom: situação, limite, usos por estado, excedentes e valores.
-- Sem nome, CPF, e-mail ou telefone. Rodar no SQL Editor a qualquer momento
-- depois da migration `202611020001_discount_coupons.sql`.
--
-- `situacao` é a situação operacional (a mesma `state` do painel). O excesso de
-- limite é independente dela: `limite_excedido` e `excedentes` (usos pagos além
-- do limite) aparecem com o cupom ativo, inativo, expirado ou agendado. É o
-- pagamento tardio acima do limite: uma pré-reserva expirou (e liberou o uso),
-- outra pessoa ocupou o uso, e o primeiro pagamento foi confirmado depois pela
-- reconciliação. O pagamento vale — o dinheiro já entrou pelo valor com
-- desconto —, mas o caso precisa ser lido pela operação.
--
-- Valores em centavos. `receita_confirmada` soma o que foi efetivamente cobrado
-- (reservas confirmadas ou em Stand-by); `desconto_confirmado` é o que deixou
-- de ser cobrado nessas mesmas reservas.

with uses as (
  select cr.coupon_id, cr.total_cents, cr.discount_cents,
         public.coupon_redemption_state(cr.released_at, r.status::text, r.confirmed_at, r.expires_at) as state
  from public.coupon_redemptions cr
  join public.reservations r on r.id = cr.reservation_id
),
per_coupon as (
  select c.id,
         count(u.*) filter (where u.state = 'RESERVED')::integer as reservados,
         count(u.*) filter (where u.state = 'CONFIRMED')::integer as confirmados,
         count(u.*) filter (where u.state = 'CANCELLED_AFTER_PAYMENT')::integer as cancelados_apos_pagamento,
         count(u.*) filter (where u.state = 'RELEASED')::integer as liberados,
         count(u.*) filter (where u.state = 'LAPSED')::integer as expirados_sem_pagamento,
         coalesce(sum(u.total_cents) filter (where u.state = 'CONFIRMED'), 0)::bigint as receita_confirmada,
         coalesce(sum(u.discount_cents) filter (where u.state = 'CONFIRMED'), 0)::bigint as desconto_confirmado
  from public.coupons c
  left join uses u on u.coupon_id = c.id
  group by c.id
)
select c.code as codigo,
       c.percent_off as percentual,
       c.status,
       case
         when c.status = 'INACTIVE' then 'INACTIVE'
         when c.valid_until is not null and public.coupon_today() > c.valid_until then 'EXPIRED'
         when c.valid_from is not null and public.coupon_today() < c.valid_from then 'SCHEDULED'
         when c.max_uses is not null and p.reservados + p.confirmados + p.cancelados_apos_pagamento >= c.max_uses then 'EXHAUSTED'
         else 'ACTIVE'
       end as situacao,
       coalesce(c.max_uses is not null and p.confirmados + p.cancelados_apos_pagamento > c.max_uses, false) as limite_excedido,
       c.valid_from as valido_de,
       c.valid_until as valido_ate,
       c.max_uses as limite,
       p.reservados + p.confirmados + p.cancelados_apos_pagamento as usos_contados,
       p.reservados,
       p.confirmados,
       p.cancelados_apos_pagamento,
       p.liberados,
       p.expirados_sem_pagamento,
       case when c.max_uses is null then 0
            else greatest(p.confirmados + p.cancelados_apos_pagamento - c.max_uses, 0) end as excedentes,
       p.receita_confirmada,
       p.desconto_confirmado
from public.coupons c
join per_coupon p on p.id = c.id
order by c.created_at desc, c.code;
