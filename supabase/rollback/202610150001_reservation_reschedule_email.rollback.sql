-- =============================================================================
-- ROLLBACK de 202610150001_reservation_reschedule_email.sql — SOMENTE PARA
-- REVISÃO. NÃO EXECUTAR sem decisão explícita. Não está em supabase/migrations/
-- de propósito, para nenhuma ferramenta aplicá-lo automaticamente.
-- =============================================================================
--
-- O que faz: remove a trigger que enfileira o e-mail de reagendamento e as treze
-- funções da fila. Depois dele, reagendar uma reserva em Stand-by volta a ser
-- exatamente o que era na etapa 3: nenhuma linha é enfileirada e nenhum e-mail
-- sai.
--
-- O que NÃO faz: não apaga as duas tabelas. `reservation_reschedule_emails` e
-- `reservation_reschedule_email_attempts` são o registro do que foi enviado, do
-- que falhou e por quê; ficam inertes, sem nada que as leia ou escreva. Para
-- removê-las também, os dois `drop table` estão comentados no fim.
--
-- O que apaga, de dado: as mensagens guardadas para repetição
-- (`frozen_message`) dos e-mails que ainda não terminaram. Elas têm o nome e o
-- e-mail do cliente e, sem as funções, nunca mais seriam usadas nem apagadas.
--
-- Nenhuma reserva, sessão, pagamento, autorização de Stand-by ou linha do
-- histórico de trocas é tocada. O e-mail de confirmação de pagamento e a fila
-- dele (`integration_sync_jobs`) não são afetados.
--
-- ORDEM IMPORTA. Antes de executar:
--   1. desligar o envio: `STANDBY_RESCHEDULE_EMAIL_ENABLED` ausente ou diferente
--      de `true` no ambiente publicado. Com o envio ligado e sem estas funções,
--      cada reagendamento continua funcionando, mas o painel passa a avisar
--      "o e-mail de confirmação não saiu agora" a cada vez.
--
-- E-mails ainda na fila (QUEUED ou FAILED) NÃO impedem este rollback: eles
-- simplesmente deixam de ser enviados. Consulte
-- `supabase/diagnostics/reservation_reschedule_email_report.sql` antes, para
-- saber quais clientes precisam ser avisados por outro canal.
--
-- Se o objetivo for reverter também `202610140001` ou `202610130002`, este
-- arquivo vem PRIMEIRO: a trigger lê colunas criadas pela `202610130002`, e as
-- tabelas (se mantidas) apontam para `reservation_standby`.

begin;

drop trigger if exists reservation_session_changes_reschedule_email on public.reservation_session_changes;

-- Um envio cujo resultado ficou desconhecido só pode ser repetido com a mensagem
-- exata que foi enviada. Sem ela — e ela é apagada logo abaixo — repetir seria
-- arriscar um segundo e-mail: esses envios passam à decisão de uma pessoa, e não
-- voltam à fila como "não enviados" se a migration for reaplicada.
update public.reservation_reschedule_emails
set status = 'UNCERTAIN', last_error_code = 'ROLLED_BACK', locked_until = null, next_attempt_at = null, frozen_message = null
where frozen_message is not null
  and (status = 'SENDING' or (status = 'FAILED' and generation_uncertain));

-- Nada mais vai repetir os demais: a mensagem guardada deixa de ter uso.
update public.reservation_reschedule_emails set frozen_message = null where frozen_message is not null;

drop function if exists public.admin_claim_reservation_reschedule_email(uuid, uuid, integer, integer, boolean);
drop function if exists public.admin_list_undelivered_reschedule_emails(uuid, integer);
drop function if exists public.admin_reservation_reschedule_emails(uuid, uuid);
drop function if exists public.fail_reservation_reschedule_email(uuid, uuid, text, text, integer);
drop function if exists public.complete_reservation_reschedule_email(uuid, uuid);
drop function if exists public.freeze_reservation_reschedule_email(uuid, uuid, jsonb);
drop function if exists public.claim_pending_reservation_reschedule_emails(integer, integer, integer, integer);
drop function if exists public.claim_reservation_reschedule_email(uuid, integer, integer, integer);
drop function if exists public.reservation_reschedule_email_take(uuid, integer, integer, integer, text, uuid, boolean);
drop function if exists public.reservation_reschedule_email_fingerprint(uuid);
drop function if exists public.reservation_reschedule_email_payload(uuid);
drop function if exists public.reservation_reschedule_email_rejection(uuid);
drop function if exists public.enqueue_reservation_reschedule_email();

commit;

-- Remoção completa, incluindo o registro de envios. Só depois do bloco acima e
-- só com decisão explícita: não há como recuperar o histórico depois.
--
-- drop table if exists public.reservation_reschedule_email_attempts;
-- drop table if exists public.reservation_reschedule_emails;
