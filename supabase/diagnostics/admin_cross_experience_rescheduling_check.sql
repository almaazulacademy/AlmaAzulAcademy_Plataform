-- Diagnóstico do reagendamento administrativo entre experiências diferentes.
--
-- Roda dentro de uma transação que termina em ROLLBACK: nenhuma reserva,
-- sessão, experiência ou linha de histórico sobrevive à execução. Serve para
-- provar, contra um Postgres de verdade (staging, nunca produção), o que os
-- testes locais só conseguem afirmar lendo o SQL:
--
--   * uma reserva confirmada da experiência A vira uma reserva da experiência B
--     preservando id, `public_code`, status, pagamento e valor;
--   * `reservations.experience_id` acompanha a sessão nova;
--   * as vagas saem da turma antiga e entram na nova;
--   * a volta (B → A) funciona igual;
--   * experiência não publicada, turma lotada, passada, fechada e a própria
--     turma são recusadas;
--   * o histórico grava as duas experiências;
--   * a invariante reserva ↔ sessão ↔ experiência não pode ser burlada por um
--     UPDATE direto.
--
-- Pré-requisitos: as migrations 202608240001 e 202608310001 aplicadas e um
-- usuário administrativo ativo em `admin_users`.
--
-- Uso:
--   psql "$DATABASE_URL" \
--     -v actor="'00000000-0000-0000-0000-000000000000'" \
--     -f supabase/diagnostics/admin_cross_experience_rescheduling_check.sql

\set ON_ERROR_STOP off

begin;

create temporary table diag_ids (label text primary key, id uuid) on commit drop;

insert into diag_ids (label, id) values ('actor', :actor);

-- Duas experiências publicadas, com preços diferentes de propósito, e uma
-- terceira em rascunho para provar a recusa por publicação.
with created as (
  insert into public.experiences (slug, title, summary, description, duration_minutes, price_cents, default_capacity, status)
  values
    ('diag-cross-a', 'Diagnóstico A', 'Experiência A.', 'Registro temporário de diagnóstico.', 240, 21000, 28, 'PUBLISHED'),
    ('diag-cross-b', 'Diagnóstico B', 'Experiência B.', 'Registro temporário de diagnóstico.', 90, 14000, 12, 'PUBLISHED'),
    ('diag-cross-rascunho', 'Diagnóstico Rascunho', 'Experiência não publicada.', 'Registro temporário de diagnóstico.', 90, 14000, 12, 'DRAFT')
  returning id, slug
)
insert into diag_ids (label, id)
select case c.slug
    when 'diag-cross-a' then 'experience_a'
    when 'diag-cross-b' then 'experience_b'
    else 'experience_draft'
  end,
  c.id
from created c;

-- Turmas: origem em A, destino em B, um destino lotado em B, um destino em uma
-- experiência não publicada, uma passada e uma fechada.
with created as (
  insert into public.sessions (experience_id, starts_at, duration_minutes, price_cents, capacity, status)
  select
    (select id from diag_ids where label = v.experience_label),
    v.starts_at, v.duration, v.price_cents, v.capacity, v.status::public.session_status
  from (values
    ('session_a',       'experience_a',       now() + interval '30 days',         240, 21000, 28, 'OPEN'),
    ('session_a_tarde', 'experience_a',       now() + interval '30 days 6 hours', 240, 21000, 28, 'OPEN'),
    ('session_b',       'experience_b',       now() + interval '40 days',          90, 14000, 12, 'OPEN'),
    ('session_b_cheia', 'experience_b',       now() + interval '41 days',          90, 14000,  3, 'OPEN'),
    ('session_draft',   'experience_draft',   now() + interval '42 days',          90, 14000, 12, 'OPEN'),
    ('session_past',    'experience_b',       now() - interval '2 days',           90, 14000, 12, 'OPEN'),
    ('session_closed',  'experience_b',       now() + interval '43 days',          90, 14000, 12, 'CLOSED')
  ) as v(label, experience_label, starts_at, duration, price_cents, capacity, status)
  returning id, starts_at, capacity, status, experience_id
)
insert into diag_ids (label, id)
select
  case
    when c.status = 'CLOSED' then 'session_closed'
    when c.starts_at < now() then 'session_past'
    when c.experience_id = (select id from diag_ids where label = 'experience_draft') then 'session_draft'
    when c.capacity = 3 then 'session_b_cheia'
    when c.experience_id = (select id from diag_ids where label = 'experience_b') then 'session_b'
    when c.starts_at > now() + interval '30 days 3 hours' then 'session_a_tarde'
    else 'session_a'
  end,
  c.id
from created c;

-- A reserva do cenário: 3 pessoas, confirmadas, pagas a 21000 por pessoa.
with created as (
  insert into public.reservations (
    public_code, idempotency_key, experience_id, session_id, status, full_name,
    cpf_hash, cpf_last4, phone, email, quantity, unit_price_cents, expires_at, confirmed_at
  )
  select
    'DIAGX00001', gen_random_uuid(),
    (select id from diag_ids where label = 'experience_a'),
    (select id from diag_ids where label = 'session_a'),
    'CONFIRMED', 'Diagnóstico Cruzado',
    repeat('0', 64), '0000', '+5561999990000', 'diagnostico.cruzado@example.test',
    3, 21000, now() + interval '2 hours', now()
  returning id
)
insert into diag_ids (label, id) select 'reservation', id from created;

-- 1. Recusas esperadas ------------------------------------------------------
do $$
declare
  actor uuid := (select id from diag_ids where label = 'actor');
  reservation_id uuid := (select id from diag_ids where label = 'reservation');
  scenarios text[][] := array[
    array['session_a', 'SAME_SESSION'],
    array['session_past', 'SESSION_MUST_BE_FUTURE'],
    array['session_closed', 'SESSION_NOT_OPEN'],
    array['session_draft', 'EXPERIENCE_NOT_AVAILABLE']
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

-- 2. Turma de outra experiência sem vagas suficientes -----------------------
-- `session_b_cheia` tem capacidade 3 e já recebe 2 pessoas: sobra 1 vaga, e a
-- reserva de 3 não pode ser partida.
insert into public.reservations (
  public_code, idempotency_key, experience_id, session_id, status, full_name,
  cpf_hash, cpf_last4, phone, email, quantity, unit_price_cents, expires_at, confirmed_at
)
select
  'DIAGX00002', gen_random_uuid(),
  (select id from diag_ids where label = 'experience_b'),
  (select id from diag_ids where label = 'session_b_cheia'),
  'CONFIRMED', 'Ocupante da Vaga',
  repeat('1', 64), '1111', '+5561999991111', 'ocupante.cruzado@example.test',
  2, 14000, now() + interval '2 hours', now();

do $$
begin
  perform public.admin_change_reservation_session(
    (select id from diag_ids where label = 'actor'),
    (select id from diag_ids where label = 'reservation'),
    (select id from diag_ids where label = 'session_b_cheia'),
    'diagnóstico'
  );
  raise warning 'FALHOU: 3 pessoas não cabem em 1 vaga restante';
exception when others then
  if sqlerrm like '%INSUFFICIENT_SPOTS%' then
    raise notice 'OK: turma lotada de outra experiência recusada com INSUFFICIENT_SPOTS';
  else
    raise warning 'FALHOU: recusada com "%" (esperado INSUFFICIENT_SPOTS)', sqlerrm;
  end if;
end $$;

-- 3. Experiência A → experiência B ------------------------------------------
select public.admin_change_reservation_session(
  (select id from diag_ids where label = 'actor'),
  (select id from diag_ids where label = 'reservation'),
  (select id from diag_ids where label = 'session_b'),
  'Cliente pediu para trocar de experiência'
) as resultado_a_para_b;

-- Esperado:
--   DIAGX00001 | CONFIRMED | 3 | 21000 | 63000 | t | t | t | 28 | 9
--
-- O preço unitário continua 21000 mesmo com a experiência nova valendo 14000:
-- nenhuma diferença é cobrada nem estornada.
select
  r.public_code                          as codigo_preservado,
  r.status                               as status_preservado,
  r.quantity                             as pessoas_preservadas,
  r.unit_price_cents                     as preco_unitario_preservado,
  r.total_cents                          as valor_pago_preservado,
  r.confirmed_at is not null             as confirmacao_preservada,
  r.session_id = (select id from diag_ids where label = 'session_b')       as turma_nova_vinculada,
  r.experience_id = (select id from diag_ids where label = 'experience_b') as experiencia_nova_vinculada,
  public.available_spots((select id from diag_ids where label = 'session_a')) as vagas_turma_antiga,
  public.available_spots((select id from diag_ids where label = 'session_b')) as vagas_turma_nova
from public.reservations r
where r.public_code = 'DIAGX00001';

-- O painel e o acompanhamento público leem a experiência pela reserva: as duas
-- precisam mostrar Diagnóstico B agora.
select
  (select e.title from public.experiences e
    join public.reservations r on r.experience_id = e.id
    where r.public_code = 'DIAGX00001') as experiencia_lida_pela_reserva,
  (select e.title from public.experiences e
    join public.sessions s on s.experience_id = e.id
    join public.reservations r on r.session_id = s.id
    where r.public_code = 'DIAGX00001') as experiencia_lida_pela_sessao;

-- 4. A volta: experiência B → experiência A ---------------------------------
select public.admin_change_reservation_session(
  (select id from diag_ids where label = 'actor'),
  (select id from diag_ids where label = 'reservation'),
  (select id from diag_ids where label = 'session_a_tarde'),
  'Cliente voltou atrás'
) as resultado_b_para_a;

-- Esperado: t | 28 | 12 — a reserva voltou para A e B liberou as vagas.
select
  r.experience_id = (select id from diag_ids where label = 'experience_a') as voltou_para_a,
  public.available_spots((select id from diag_ids where label = 'session_b')) as vagas_b_liberadas,
  public.available_spots((select id from diag_ids where label = 'session_a_tarde')) as vagas_a_ocupadas
from public.reservations r
where r.public_code = 'DIAGX00001';

-- 5. Histórico com as duas experiências -------------------------------------
--
-- Esperado: duas linhas, a mais recente primeiro —
--   Diagnóstico B → Diagnóstico A | t
--   Diagnóstico A → Diagnóstico B | t
select
  c.previous_experience_title,
  c.target_experience_title,
  c.experience_changed,
  c.quantity,
  c.unit_price_cents,
  c.previous_session_price_cents,
  c.target_session_price_cents,
  c.reason,
  c.actor_user_id is not null as ator_registrado
from public.admin_list_reservation_session_changes(
  (select id from diag_ids where label = 'actor'),
  (select id from diag_ids where label = 'reservation')
) c;

-- 6. A lista de destinos oferecida ao admin ---------------------------------
--
-- Esperado: turmas de A e de B, nunca a da experiência em rascunho, nunca a
-- passada, a fechada ou a atual, e nenhuma sem vaga para as 3 pessoas.
select
  jsonb_array_length(options -> 'options') as turmas_oferecidas,
  options -> 'hiddenForCapacity'           as ocultas_por_falta_de_vaga,
  (select bool_and((item ->> 'remainingSpots')::integer >= 3)
     from jsonb_array_elements(options -> 'options') item) as todas_cabem,
  (select bool_and(item ->> 'experienceStatus' = 'PUBLISHED')
     from jsonb_array_elements(options -> 'options') item) as todas_publicadas,
  (select count(distinct item ->> 'experienceId')
     from jsonb_array_elements(options -> 'options') item) as experiencias_distintas
from public.admin_reservation_session_options(
  (select id from diag_ids where label = 'actor'),
  (select id from diag_ids where label = 'reservation')
) as options;

-- 7. A invariante não pode ser burlada por um UPDATE direto -----------------
do $$
begin
  update public.reservations
  set session_id = (select id from diag_ids where label = 'session_b')
  where public_code = 'DIAGX00001';
  raise warning 'FALHOU: mover a sessão sem a experiência deveria ter sido recusado';
exception when others then
  if sqlerrm like '%RESERVATION_EXPERIENCE_DESYNC%' then
    raise notice 'OK: UPDATE direto recusado com RESERVATION_EXPERIENCE_DESYNC';
  else
    raise warning 'FALHOU: recusado com "%" (esperado RESERVATION_EXPERIENCE_DESYNC)', sqlerrm;
  end if;
end $$;

-- E confirmar ou cancelar uma reserva continua não passando pela validação:
-- o par (session_id, experience_id) não é escrito nessas operações.
do $$
begin
  update public.reservations set notes = 'diagnóstico' where public_code = 'DIAGX00001';
  raise notice 'OK: um UPDATE que não toca no vínculo passa normalmente';
exception when others then
  raise warning 'FALHOU: UPDATE sem relação com o vínculo foi recusado com "%"', sqlerrm;
end $$;

-- 8. Ator sem permissão administrativa --------------------------------------
do $$
begin
  perform public.admin_change_reservation_session(
    gen_random_uuid(),
    (select id from diag_ids where label = 'reservation'),
    (select id from diag_ids where label = 'session_b'),
    'diagnóstico'
  );
  raise warning 'FALHOU: um ator não administrativo executou a troca';
exception when others then
  if sqlerrm like '%ADMIN_FORBIDDEN%' then
    raise notice 'OK: ator não administrativo recusado com ADMIN_FORBIDDEN';
  else
    raise warning 'FALHOU: recusado com "%" (esperado ADMIN_FORBIDDEN)', sqlerrm;
  end if;
end $$;

-- 9. Concorrência (execução manual, dois psql abertos ao mesmo tempo) --------
--
-- Prepare duas reservas confirmadas de 1 pessoa em experiências diferentes e
-- uma turma de destino com exatamente 1 vaga. Em duas sessões psql:
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
-- Repita invertendo origem e destino entre A e B, com as duas em experiências
-- diferentes: a ordem fixa de lock por id não depende de experiência, então as
-- duas transações pedem os mesmos locks na mesma sequência, sem deadlock.

rollback;
