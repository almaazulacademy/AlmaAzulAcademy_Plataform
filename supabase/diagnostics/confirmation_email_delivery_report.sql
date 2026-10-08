-- E-MAIL DE CONFIRMAÇÃO — EVIDÊNCIA DE ENVIO (SOMENTE LEITURA)
--
-- Responde "o sistema está realmente enviando?" com os registros da fila
-- `integration_sync_jobs`. Só contagens e datas: nenhum nome, e-mail, telefone,
-- CPF ou código de reserva é retornado.
--
-- Como ler:
--   ENVIADOS (SYNCED)        o provedor aceitou a mensagem.
--   FALHAS (FAILED)          tentativa recusada; ULTIMOS_ERROS diz o motivo.
--   PRESOS (PENDING antigo)  reivindicado e nunca concluído.
--   CONFIRMADAS_SEM_REGISTRO reservas confirmadas que nunca geraram um envio —
--                            com o provedor configurado, o esperado é 0 a partir
--                            da data em que o e-mail foi ligado.

with jobs as (
  select j.* from public.integration_sync_jobs j
  where j.integration = 'RESERVATION_CONFIRMATION_EMAIL'
),
confirmed as (
  select r.id, r.confirmed_at from public.reservations r where r.status = 'CONFIRMED'
),
report as (
  select 1 as position, 'ENVIADOS_TOTAL' as check_name, (select count(*)::text from jobs where status = 'SYNCED') as result
  union all
  select 2, 'ENVIADOS_ULTIMOS_30_DIAS', (select count(*)::text from jobs where status = 'SYNCED' and synced_at > now() - interval '30 days')
  union all
  select 3, 'PRIMEIRO_ENVIO', (select coalesce(to_char(min(synced_at) at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'), 'nenhum') from jobs where status = 'SYNCED')
  union all
  select 4, 'ULTIMO_ENVIO', (select coalesce(to_char(max(synced_at) at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'), 'nenhum') from jobs where status = 'SYNCED')
  union all
  select 5, 'FALHAS_ABERTAS', (select count(*)::text from jobs where status = 'FAILED')
  union all
  select 6, 'ULTIMOS_ERROS', (select coalesce(string_agg(code || ' ×' || total, ', ' order by total desc), 'nenhum')
                               from (select coalesce(last_error_code, 'sem código') as code, count(*) as total from jobs where status = 'FAILED' group by 1) errors)
  union all
  select 7, 'PRESOS_HA_MAIS_DE_15_MIN', (select count(*)::text from jobs where status = 'PENDING' and updated_at < now() - interval '15 minutes')
  union all
  select 8, 'CONFIRMADAS_TOTAL', (select count(*)::text from confirmed)
  union all
  select 9, 'CONFIRMADAS_SEM_REGISTRO_DE_ENVIO', (select count(*)::text from confirmed c where not exists (select 1 from jobs j where j.entity_id = c.id))
  union all
  select 10, 'CONFIRMADAS_ULTIMOS_30_DIAS_SEM_ENVIO',
         (select count(*)::text from confirmed c
           where c.confirmed_at > now() - interval '30 days'
             and not exists (select 1 from jobs j where j.entity_id = c.id and j.status = 'SYNCED'))
  union all
  select 11, 'QR_REENVIADOS_PELO_PAINEL', (select count(*)::text from public.admin_audit_log where action = 'CHECKIN_QR_RESENT')
)
select check_name, result from report order by position;
