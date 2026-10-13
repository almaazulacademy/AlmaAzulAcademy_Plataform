-- E-MAIL DE REAGENDAMENTO — SITUAÇÃO DA FILA (SOMENTE LEITURA)
--
-- Responde "os e-mails de reagendamento estão saindo?" com os registros de
-- `reservation_reschedule_emails` e das tentativas. Só contagens, datas, códigos
-- de erro e o id técnico da reserva (o mesmo de /admin/reservas/<id>): nenhum
-- nome, e-mail, telefone, CPF ou código de reserva é retornado.
--
-- Como ler:
--   NA_FILA (QUEUED)      reagendado; ninguém tentou enviar ainda. Com o envio
--                         desligado, é aqui que tudo fica.
--   EM_ENVIO (SENDING)    reivindicado. PRESOS conta os que passaram do prazo.
--   ENVIADOS (SENT)       o provedor aceitou a mensagem.
--   COM_ERRO (FAILED)     a última tentativa falhou; ULTIMOS_ERROS diz o motivo.
--                         ESGOTADOS já gastaram as 3 tentativas automáticas e
--                         esperam o botão "Reenviar e-mail de reagendamento".
--   NAO_ENVIADOS (SKIPPED) descartados de propósito; MOTIVOS diz por quê.
--   ABERTO_<n>            um por e-mail ainda não resolvido, o mais antigo primeiro.

with queue as (
  select q.* from public.reservation_reschedule_emails q
),
report as (
  select 1 as position, 'NA_FILA' as check_name, (select count(*)::text from queue where status = 'QUEUED') as result
  union all
  select 2, 'EM_ENVIO', (select count(*)::text from queue where status = 'SENDING')
  union all
  select 3, 'PRESOS_ALEM_DO_PRAZO', (select count(*)::text from queue where status = 'SENDING' and locked_until <= now())
  union all
  select 4, 'ENVIADOS_TOTAL', (select count(*)::text from queue where status = 'SENT')
  union all
  select 5, 'ULTIMO_ENVIO', (select coalesce(to_char(max(sent_at) at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'), 'nenhum') from queue where status = 'SENT')
  union all
  select 6, 'COM_ERRO', (select count(*)::text from queue where status = 'FAILED')
  union all
  select 7, 'ESGOTADOS_AGUARDANDO_REENVIO_MANUAL', (select count(*)::text from queue where status = 'FAILED' and attempts >= 3)
  union all
  select 8, 'ULTIMOS_ERROS', (select coalesce(string_agg(code || ' ×' || total, ', ' order by total desc, code), 'nenhum')
                               from (select coalesce(last_error_code, 'sem código') as code, count(*) as total from queue where status = 'FAILED' group by 1) errors)
  union all
  select 9, 'NAO_ENVIADOS', (select count(*)::text from queue where status = 'SKIPPED')
  union all
  select 10, 'MOTIVOS_DOS_NAO_ENVIADOS', (select coalesce(string_agg(code || ' ×' || total, ', ' order by total desc, code), 'nenhum')
                                           from (select coalesce(last_error_code, 'sem código') as code, count(*) as total from queue where status = 'SKIPPED' group by 1) reasons)
  union all
  select 11, 'TENTATIVAS_REGISTRADAS', (select coalesce(string_agg(outcome || '=' || total, ', ' order by outcome), 'nenhuma')
                                         from (select coalesce(outcome, 'EM_CURSO') as outcome, count(*) as total from public.reservation_reschedule_email_attempts group by 1) attempts)
  union all
  select 100 + row_number() over (order by q.created_at, q.id),
         'ABERTO_' || row_number() over (order by q.created_at, q.id),
         'reserva ' || q.reservation_id::text
           || ' | ' || q.status
           || ' | tentativas=' || q.attempts::text
           || ' | erro=' || coalesce(q.last_error_code, '-')
           || ' | reagendada em ' || to_char(q.created_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
           || ' | turma em ' || to_char(s.starts_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
  from queue q
  join public.sessions s on s.id = q.target_session_id
  where q.status in ('QUEUED', 'SENDING', 'FAILED')
)
select check_name, result from report order by position
limit 90;
