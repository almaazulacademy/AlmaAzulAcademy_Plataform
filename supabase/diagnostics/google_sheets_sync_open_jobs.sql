-- Todos os jobs de integração não concluídos, de qualquer entidade.
--
-- SOMENTE LEITURA. Complementa google_sheets_sync_backlog.sql: mostra também
-- jobs de reservas canceladas ou expiradas e jobs cuja reserva ou sessão não
-- existe mais. Sem dados pessoais.
select
  j.integration,
  j.entity_type,
  j.status                                   as status_job,
  coalesce(j.last_error_code, '-')           as erro,
  j.attempts                                 as tentativas,
  j.operation                                as operacao,
  case
    when j.entity_type = 'RESERVATION' then coalesce(r.status::text, '(reserva inexistente)')
    else coalesce(s.status::text, '(sessão inexistente)')
  end                                        as situacao_entidade,
  count(*)                                   as jobs,
  to_char(min(j.updated_at) at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') as primeira_falha,
  to_char(max(j.updated_at) at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') as ultima_falha
from public.integration_sync_jobs j
left join public.reservations r on j.entity_type = 'RESERVATION' and r.id = j.entity_id
left join public.sessions s on j.entity_type = 'SESSION' and s.id = j.entity_id
where j.status <> 'SYNCED'
group by 1, 2, 3, 4, 5, 6, 7
order by 2, 9;
