-- IMERSÃO PARANOÁ — AUDITORIA DOS HORÁRIOS DAS TURMAS (SOMENTE LEITURA)
--
-- Rode manualmente no SQL Editor do Supabase quando quiser conferir se as
-- turmas cadastradas batem com as turmas divulgadas (09:00, 12:00 e 15:00).
--
-- Este script não insere, não atualiza e não apaga nada. Nenhum dado pessoal de
-- participante é retornado: só id de sessão, horário, status e contagens.
--
-- A fonte de verdade é `sessions.id` + `sessions.starts_at`. Toda conversão de
-- fuso acontece aqui, no banco, com `at time zone 'America/Sao_Paulo'` — do
-- mesmo jeito que o site converte com Intl e o fuso America/Sao_Paulo.

-- 1. Todas as sessões futuras da Imersão Paranoá, com o horário local ao lado
--    do UTC gravado. É a leitura direta do par id + starts_at que o produto usa.
select
  session.id as session_id,
  (session.starts_at at time zone 'America/Sao_Paulo')::date as local_date,
  to_char(session.starts_at at time zone 'America/Sao_Paulo', 'HH24:MI') as local_time,
  to_char(session.starts_at at time zone 'America/Sao_Paulo', 'Dy') as weekday,
  session.starts_at as starts_at_utc,
  session.status,
  session.capacity,
  public.available_spots(session.id) as remaining_spots
from public.sessions session
join public.experiences experience on experience.id = session.experience_id
where experience.slug = 'imersao-paranoa'
  and session.starts_at > now()
order by session.starts_at;

-- 2. Quais horários existem, e quantas sessões em cada um. O esperado hoje é
--    09:00, 12:00 e 15:00 — qualquer outra linha aqui é uma turma que o site
--    vai exibir e que talvez ninguém tenha divulgado.
select
  to_char(session.starts_at at time zone 'America/Sao_Paulo', 'HH24:MI') as local_time,
  count(*) as sessions_total,
  count(*) filter (where session.status = 'OPEN') as open_sessions,
  min(session.starts_at) as first_starts_at_utc,
  max(session.starts_at) as last_starts_at_utc
from public.sessions session
join public.experiences experience on experience.id = session.experience_id
where experience.slug = 'imersao-paranoa'
  and session.starts_at > now()
group by 1
order by 1;

-- 3. Horários incoerentes: minuto fora de :00, hora antes das 05:00 ou depois
--    das 20:00. Nenhuma linha é o resultado saudável.
select
  session.id as session_id,
  to_char(session.starts_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') as local_starts_at,
  session.status,
  case
    when extract(minute from session.starts_at at time zone 'America/Sao_Paulo') <> 0 then 'minuto fora de :00'
    else 'hora fora da faixa operacional'
  end as issue
from public.sessions session
join public.experiences experience on experience.id = session.experience_id
where experience.slug = 'imersao-paranoa'
  and session.starts_at > now()
  and (
    extract(minute from session.starts_at at time zone 'America/Sao_Paulo') <> 0
    or extract(hour from session.starts_at at time zone 'America/Sao_Paulo') not between 5 and 20
  )
order by session.starts_at;

-- 4. Turmas duplicadas: mesma experiência e mesmo horário em mais de uma linha.
--    Duas sessões idênticas dividem as vagas e confundem quem escolhe.
--    Nenhuma linha é o resultado saudável.
select
  to_char(session.starts_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') as local_starts_at,
  count(*) as sessions_with_same_start,
  array_agg(session.id order by session.id) as session_ids,
  array_agg(session.status::text order by session.id) as statuses
from public.sessions session
join public.experiences experience on experience.id = session.experience_id
where experience.slug = 'imersao-paranoa'
group by session.experience_id, session.starts_at
having count(*) > 1
order by 1;

-- 5. Distribuição das reservas por turma. Não prova intenção do cliente, mas
--    mostra se 12:00 e 15:00 estão sendo escolhidas e onde estão as
--    reclamações. Só contagens agregadas — nenhum dado de participante.
select
  to_char(session.starts_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY') as local_date,
  to_char(session.starts_at at time zone 'America/Sao_Paulo', 'HH24:MI') as local_time,
  session.id as session_id,
  count(reservation.id) filter (where reservation.status = 'CONFIRMED') as confirmed_reservations,
  coalesce(sum(reservation.quantity) filter (where reservation.status = 'CONFIRMED'), 0) as confirmed_spots,
  count(reservation.id) filter (where reservation.status = 'PRE_RESERVED') as pre_reserved_reservations,
  count(reservation.id) filter (where reservation.status = 'CANCELLED') as cancelled_reservations
from public.sessions session
join public.experiences experience on experience.id = session.experience_id
left join public.reservations reservation on reservation.session_id = session.id
where experience.slug = 'imersao-paranoa'
group by session.id, session.starts_at
order by session.starts_at;

-- 6. Coerência entre a reserva e a sessão: toda reserva tem que apontar para uma
--    sessão existente e da mesma experiência gravada na reserva. Nenhuma linha é
--    o resultado saudável.
select
  reservation.id as reservation_id,
  reservation.session_id,
  reservation.experience_id as reservation_experience_id,
  session.experience_id as session_experience_id,
  case when session.id is null then 'sessão inexistente' else 'experiência divergente' end as issue
from public.reservations reservation
left join public.sessions session on session.id = reservation.session_id
where session.id is null
   or session.experience_id <> reservation.experience_id;
