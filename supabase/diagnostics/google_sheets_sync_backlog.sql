-- Fila da planilha: reservas e sessões afetadas pela grade cheia de 07/10/2026.
--
-- SOMENTE LEITURA. Uma linha por sessão que tem reserva confirmada depois da
-- última gravação nova na planilha, ou job de sincronização não concluído.
-- Não devolve nome, telefone, CPF nem e-mail.
with cutoff as (
  select timestamptz '2026-10-07 13:20:57+00' as at
),
reservation_jobs as (
  select j.entity_id, j.status, j.attempts, j.last_error_code
  from public.integration_sync_jobs j
  where j.integration = 'GOOGLE_SHEETS' and j.entity_type = 'RESERVATION'
),
session_jobs as (
  select j.entity_id, j.status, j.attempts, j.last_error_code
  from public.integration_sync_jobs j
  where j.integration = 'GOOGLE_SHEETS' and j.entity_type = 'SESSION'
)
select
  s.id                                                        as session_id,
  coalesce(b.name, '(sem base)')                              as base,
  e.title                                                     as experiencia,
  to_char(s.starts_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') as turma,
  count(*) filter (where r.status = 'CONFIRMED')              as reservas_confirmadas,
  coalesce(sum(r.quantity) filter (where r.status = 'CONFIRMED'), 0) as vagas_confirmadas,
  count(*) filter (where r.status = 'CONFIRMED' and r.confirmed_at > c.at) as confirmadas_apos_corte,
  count(*) filter (where rj.status is distinct from 'SYNCED' and rj.entity_id is not null) as jobs_reserva_pendentes,
  count(*) filter (where rj.status <> 'SYNCED' and rj.attempts >= 5) as jobs_reserva_esgotados,
  count(*) filter (where r.status = 'CONFIRMED' and rj.entity_id is null) as confirmadas_sem_job,
  string_agg(distinct rj.last_error_code, ', ') filter (where rj.status <> 'SYNCED') as erros_reserva,
  max(sj.status)                                              as job_sessao,
  max(sj.attempts)                                            as tentativas_sessao,
  max(sj.last_error_code)                                     as erro_sessao
from public.sessions s
cross join cutoff c
join public.experiences e on e.id = s.experience_id
left join public.bases b on b.id = e.base_id
left join public.reservations r on r.session_id = s.id
left join reservation_jobs rj on rj.entity_id = r.id
left join session_jobs sj on sj.entity_id = s.id
group by s.id, b.name, e.title, s.starts_at
having count(*) filter (where r.status = 'CONFIRMED' and r.confirmed_at > (select at from cutoff)) > 0
    or count(*) filter (where rj.status <> 'SYNCED') > 0
    or max(sj.status) filter (where sj.status <> 'SYNCED') is not null
order by s.starts_at;
