-- =============================================================================
-- ROLLBACK de 202610260002_waitlist_spot_email.sql — SOMENTE PARA REVISÃO.
-- NÃO EXECUTAR sem decisão explícita. Não está em supabase/migrations/ de
-- propósito, para nenhuma ferramenta aplicá-lo automaticamente.
-- =============================================================================
--
-- O que faz: tira o agendamento `waitlist-notify` do pg_cron (se existir) e
-- remove as cinco funções do aviso de vaga.
--
-- O que NÃO faz: não toca inscrição, aviso na fila, tentativa registrada,
-- contagem de avisos, reserva, sessão nem nenhuma função das fases anteriores.
-- Avisos ainda `QUEUED` continuam na fila, sem sair.
--
-- ORDEM IMPORTA. Antes de executar, desligar `WAITLIST_NOTIFY_ENABLED` e
-- publicar de novo; sem as funções, a rota responde FAILED (503), sem enviar.

begin;
set local lock_timeout = '5s';

select cron.unschedule(jobname) from cron.job where jobname = 'waitlist-notify';

drop function if exists public.complete_waitlist_spot_email(uuid, uuid);
drop function if exists public.claim_pending_waitlist_spot_emails(integer, integer, integer, integer);
drop function if exists public.waitlist_spot_take(uuid, integer, integer, integer);
drop function if exists public.waitlist_spot_payload(uuid);
drop function if exists public.waitlist_spot_rejection(uuid);

commit;
