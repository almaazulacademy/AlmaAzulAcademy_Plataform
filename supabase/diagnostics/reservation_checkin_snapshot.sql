-- Snapshot SOMENTE LEITURA para o rollout de 202609180001_reservation_checkin.sql.
-- Rodar ANTES e DEPOIS da migration e comparar. Não retorna dado pessoal:
-- só contagens, somas e um hash agregado.

-- 1. Totais por status (reservas e vagas)
select status::text, count(*) as reservas, sum(quantity) as vagas
from public.reservations group by status order by status;

-- 2. Totais gerais, confirmadas e confirmadas futuras
select
  (select count(*) from public.reservations) as total_reservas,
  (select count(*) from public.reservations where status = 'CONFIRMED') as confirmadas,
  (select count(*) from public.reservations r join public.sessions s on s.id = r.session_id
    where r.status = 'CONFIRMED' and s.starts_at > now()) as confirmadas_futuras,
  (select coalesce(sum(r.quantity), 0) from public.reservations r join public.sessions s on s.id = r.session_id
    where r.status = 'CONFIRMED' and s.starts_at > now()) as vagas_confirmadas_futuras,
  (select count(*) from public.payment_events) as payment_events,
  (select count(*) from public.sessions) as sessoes,
  (select coalesce(sum(capacity), 0) from public.sessions) as capacidade_total;

-- 3. Impressão digital (hash) das colunas que NÃO podem mudar.
--    Deve ser idêntica antes e depois. Não expõe nenhum valor.
select md5(string_agg(concat_ws('|', id, status, quantity, unit_price_cents, total_cents, session_id,
         experience_id, full_name, email, phone, cpf_hash, payment_provider, provider_reference,
         confirmed_at, cancelled_at, expires_at), ',' order by id)) as hash_reservas
from public.reservations;
select md5(string_agg(concat_ws('|', id, experience_id, starts_at, capacity, status, price_cents), ',' order by id)) as hash_sessoes
from public.sessions;

-- 4. Confirmadas futuras por experiência/turma (para um eventual reenvio do QR)
select e.title, to_char(s.starts_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') as turma,
       count(*) as reservas, sum(r.quantity) as vagas
from public.reservations r
join public.sessions s on s.id = r.session_id
join public.experiences e on e.id = r.experience_id
where r.status = 'CONFIRMED' and s.starts_at > now()
group by e.title, s.starts_at order by s.starts_at;
