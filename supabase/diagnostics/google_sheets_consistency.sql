-- Impressão digital das reservas confirmadas por sessão, para comparar com a
-- planilha operacional.
--
-- SOMENTE LEITURA. Devolve uma única célula JSON (o SQL Editor limita a 100
-- linhas). Por sessão: s = session_id, c = reservas confirmadas, v = vagas
-- confirmadas, h = md5 dos ids das reservas confirmadas em ordem, n = reservas
-- não confirmadas (canceladas, expiradas, pré-reservas). Sem dados pessoais.
select jsonb_agg(
  jsonb_build_object('s', t.session_id, 'c', t.confirmadas, 'v', t.vagas, 'h', t.digital, 'n', t.nao_confirmadas)
  order by t.session_id
)
from (
  select
    r.session_id,
    count(*) filter (where r.status = 'CONFIRMED')                          as confirmadas,
    coalesce(sum(r.quantity) filter (where r.status = 'CONFIRMED'), 0)      as vagas,
    coalesce(md5(string_agg(r.id::text, ',' order by r.id) filter (where r.status = 'CONFIRMED')), '') as digital,
    count(*) filter (where r.status <> 'CONFIRMED')                         as nao_confirmadas
  from public.reservations r
  group by r.session_id
) t;
