-- Diagnóstico da troca administrativa de turma.
--
-- Roda dentro de uma transação que termina em ROLLBACK: nenhuma reserva,
-- sessão, pagamento ou linha de histórico sobrevive à execução. Serve para
-- provar, contra um Postgres de verdade (staging, nunca produção), o que os
-- testes locais só conseguem afirmar lendo o SQL:
--
--   * uma reserva confirmada muda de turma preservando status, código e valor;
--   * as vagas saem da turma antiga e entram na nova;
--   * turma lotada, passada, fechada e a própria turma são recusadas;
--   * duas trocas simultâneas não ocupam a mesma última vaga.
--
-- Pré-requisitos: a migration 202608240001 aplicada e um usuário administrativo
-- ativo em `admin_users`.
--
-- Uso:
--   psql "$DATABASE_URL" \
--     -v actor="'00000000-0000-0000-0000-000000000000'" \
--     -f supabase/diagnostics/admin_change_reservation_session_check.sql

\set ON_ERROR_STOP off

begin;

-- Todos os identificadores descartáveis vivem aqui. A variável :actor é
-- resolvida uma única vez, fora de qualquer bloco DO — dentro de um bloco
-- dollar-quoted o psql não substitui variáveis.
create temporary table diag_ids (label text primary key, id uuid) on commit drop;

insert into diag_ids (label, id) values ('actor', :actor);

with experience as (
  insert into public.experiences (slug, title, summary, description, duration_minutes, price_cents, default_capacity, status)
  values ('diag-troca-de-turma', 'Diagnóstico', 'Turma de diagnóstico.', 'Registro temporário de diagnóstico.', 90, 7000, 28, 'DRAFT')
  returning id
)
insert into diag_ids (label, id) select 'experience', id from experience;

-- 09:00 (origem), 12:00 (destino apertado, capacidade 3), uma passada e uma fechada.
with created as (
  insert into public.sessions (experience_id, starts_at, duration_minutes, price_cents, capacity, status)
  select d.id, v.starts_at, 90, v.price_cents, v.capacity, v.status::public.session_status
  from diag_ids d
  cross join (values
    ('session_0900',   now() + interval '30 days',           7000, 28, 'OPEN'),
    ('session_1200',   now() + interval '30 days 3 hours',   9000,  3, 'OPEN'),
    ('session_past',   now() - interval '2 days',            7000, 28, 'OPEN'),
    ('session_closed', now() + interval '31 days',           7000, 28, 'CLOSED')
  ) as v(label, starts_at, price_cents, capacity, status)
  where d.label = 'experience'
  returning id, starts_at, capacity, status
)
insert into diag_ids (label, id)
select
  case
    when c.status = 'CLOSED' then 'session_closed'
    when c.starts_at < now() then 'session_past'
    when c.capacity = 3 then 'session_1200'
    else 'session_0900'
  end,
  c.id
from created c;

with created as (
  insert into public.reservations (
    public_code, idempotency_key, experience_id, session_id, status, full_name,
    cpf_hash, cpf_last4, phone, email, quantity, unit_price_cents, expires_at, confirmed_at
  )
  select
    'DIAG000001', gen_random_uuid(),
    (select id from diag_ids where label = 'experience'),
    (select id from diag_ids where label = 'session_0900'),
    'CONFIRMED', 'Diagnóstico da Silva',
    repeat('0', 64), '0000', '+5561999990000', 'diagnostico@example.test',
    3, 7000, now() + interval '2 hours', now()
  returning id
)
insert into diag_ids (label, id) select 'reservation', id from created;

-- 1. Recusas esperadas ------------------------------------------------------
do $$
declare
  actor uuid := (select id from diag_ids where label = 'actor');
  reservation_id uuid := (select id from diag_ids where label = 'reservation');
  scenarios text[][] := array[
    array['session_0900', 'SAME_SESSION'],
    array['session_past', 'SESSION_MUST_BE_FUTURE'],
    array['session_closed', 'SESSION_NOT_OPEN']
  ];
  scenario text[];
begin
  foreach scenario slice 1 in array scenarios loop
    begin
      perform public.admin_change_reservation_session(
        actor,
        reservation_id,
        (select id from diag_ids where label = scenario[1]),
        'diagnóstico'
      );
      raise warning 'FALHOU: % deveria ter sido recusada com %', scenario[1], scenario[2];
    exception when others then
      if sqlerrm like '%' || scenario[2] || '%' then
        raise notice 'OK: % recusada com %', scenario[1], scenario[2];
      else
        raise warning 'FALHOU: % recusada com "%" (esperado %)', scenario[1], sqlerrm, scenario[2];
      end if;
    end;
  end loop;
end $$;

-- 2. Turma lotada -----------------------------------------------------------
-- A turma das 12:00 tem capacidade 3 e já recebe uma reserva de 2 pessoas:
-- sobra 1 vaga, e a reserva de 3 pessoas não pode ser partida.
insert into public.reservations (
  public_code, idempotency_key, experience_id, session_id, status, full_name,
  cpf_hash, cpf_last4, phone, email, quantity, unit_price_cents, expires_at, confirmed_at
)
select
  'DIAG000002', gen_random_uuid(),
  (select id from diag_ids where label = 'experience'),
  (select id from diag_ids where label = 'session_1200'),
  'CONFIRMED', 'Ocupante da Vaga',
  repeat('1', 64), '1111', '+5561999991111', 'ocupante@example.test',
  2, 9000, now() + interval '2 hours', now();

do $$
declare
  actor uuid := (select id from diag_ids where label = 'actor');
begin
  perform public.admin_change_reservation_session(
    actor,
    (select id from diag_ids where label = 'reservation'),
    (select id from diag_ids where label = 'session_1200'),
    'diagnóstico'
  );
  raise warning 'FALHOU: 3 pessoas não cabem em 1 vaga restante';
exception when others then
  if sqlerrm like '%INSUFFICIENT_SPOTS%' then
    raise notice 'OK: turma lotada recusada com INSUFFICIENT_SPOTS';
  else
    raise warning 'FALHOU: recusada com "%" (esperado INSUFFICIENT_SPOTS)', sqlerrm;
  end if;
end $$;

-- 3. Caminho feliz ----------------------------------------------------------
update public.reservations set status = 'CANCELLED', cancelled_at = now() where public_code = 'DIAG000002';

select public.admin_change_reservation_session(
  (select id from diag_ids where label = 'actor'),
  (select id from diag_ids where label = 'reservation'),
  (select id from diag_ids where label = 'session_1200'),
  'Cliente solicitou mudança de horário'
) as resultado_da_troca;

-- 4. O que permaneceu igual e o que mudou -----------------------------------
--
-- Esperado:
--   DIAG000001 | CONFIRMED | 3 | 7000 | 21000 | t | t | 28 | 0
--
-- O preço unitário continua 7000 mesmo com a turma nova valendo 9000: nenhuma
-- diferença é cobrada nem estornada nesta versão.
select
  r.public_code                              as codigo_preservado,
  r.status                                   as status_preservado,
  r.quantity                                 as pessoas_preservadas,
  r.unit_price_cents                         as preco_unitario_preservado,
  r.total_cents                              as valor_pago_preservado,
  r.confirmed_at is not null                 as confirmacao_preservada,
  r.session_id = (select id from diag_ids where label = 'session_1200') as turma_nova_vinculada,
  public.available_spots((select id from diag_ids where label = 'session_0900')) as vagas_turma_antiga,
  public.available_spots((select id from diag_ids where label = 'session_1200')) as vagas_turma_nova
from public.reservations r
where r.public_code = 'DIAG000001';

-- 5. Histórico gravado ------------------------------------------------------
select
  c.quantity,
  c.unit_price_cents,
  c.total_cents,
  c.previous_session_price_cents,
  c.target_session_price_cents,
  c.reason,
  c.actor_user_id is not null as ator_registrado
from public.reservation_session_changes c
join public.reservations r on r.id = c.reservation_id
where r.public_code = 'DIAG000001';

-- 6. Concorrência (execução manual, dois psql abertos ao mesmo tempo) --------
--
-- Prepare duas reservas confirmadas de 1 pessoa em turmas diferentes e uma
-- turma de destino com exatamente 1 vaga. Em duas sessões psql:
--
--   psql A: begin;
--           select public.admin_change_reservation_session(:actor, :reserva_a, :destino, null);
--           -- ainda sem commit
--   psql B: begin;
--           select public.admin_change_reservation_session(:actor, :reserva_b, :destino, null);
--           -- fica bloqueada no lock da sessão de destino
--   psql A: commit;
--   psql B: -- desbloqueia e falha com INSUFFICIENT_SPOTS
--
-- É esse bloqueio que impede as duas de ocuparem a mesma última vaga. Repita
-- invertendo origem e destino entre A e B: a ordem fixa de lock por id faz as
-- duas pedirem os mesmos locks na mesma sequência, sem deadlock.

rollback;
