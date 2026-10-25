-- =============================================================================
-- ROLLBACK de 202610250002_waitlist_signup_email.sql — SOMENTE PARA REVISÃO.
-- NÃO EXECUTAR sem decisão explícita. Não está em supabase/migrations/ de
-- propósito, para nenhuma ferramenta aplicá-lo automaticamente.
-- =============================================================================
--
-- O que faz: remove as oito funções da fila do e-mail de confirmação, o índice
-- do token por tentativa e as três colunas que a migration acrescentou.
--
-- O que NÃO faz: não toca inscrição, linha da fila, tentativa registrada,
-- reserva, sessão nem função da fase 1. Confirmações ainda na fila continuam
-- QUEUED e não saem enquanto a migration não voltar.
--
-- ORDEM IMPORTA. Antes de executar, desligar `WAITLIST_SIGNUP_ENABLED` no
-- ambiente publicado e publicar de novo. Com a variável ligada e sem estas
-- funções, a inscrição continua gravando e o e-mail fica na fila, sem sair.
--
-- Reaplicar a migration depois devolve tudo; o histórico de geração das
-- tentativas anteriores recomeça como "sem incerteza".

begin;
set local lock_timeout = '5s';

drop function if exists public.fail_waitlist_email(uuid, uuid, text, text, integer);
drop function if exists public.complete_waitlist_email(uuid, uuid);
drop function if exists public.freeze_waitlist_email(uuid, uuid, jsonb);
drop function if exists public.claim_pending_waitlist_emails(integer, integer, integer, integer);
drop function if exists public.claim_waitlist_joined_email(uuid, text, integer, integer, integer);
drop function if exists public.waitlist_notification_take(uuid, integer, integer, integer);
drop function if exists public.waitlist_notification_payload(uuid);
drop function if exists public.waitlist_notification_rejection(uuid);

drop index if exists public.waitlist_notification_attempts_token_key;
alter table public.waitlist_notification_attempts drop column if exists claim_token;
alter table public.waitlist_notifications drop column if exists generation_started_at;
alter table public.waitlist_notifications drop column if exists generation_uncertain;

commit;
