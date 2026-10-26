-- =============================================================================
-- ROLLBACK de 202610260001_waitlist_detection.sql — SOMENTE PARA REVISÃO.
-- NÃO EXECUTAR sem decisão explícita. Não está em supabase/migrations/ de
-- propósito, para nenhuma ferramenta aplicá-lo automaticamente.
-- =============================================================================
--
-- O que faz: tira o agendamento `waitlist-scan` do pg_cron (se existir) e
-- remove as três funções da detecção, a tabela de configuração e a coluna
-- `waitlist_openings.closed_reason`.
--
-- O que NÃO faz: não apaga aberturas nem avisos já enfileirados
-- (`SPOT_AVAILABLE`), não toca inscrição, reserva, sessão, pagamento, Stand-by
-- nem nenhuma função existente. Avisos que ficaram `QUEUED` continuam na fila,
-- sem sair: as funções de envio da fase 3 só operam `JOINED`.
--
-- Reaplicar a migration depois devolve tudo, com a detecção desligada.

begin;
set local lock_timeout = '5s';

select cron.unschedule(jobname) from cron.job where jobname = 'waitlist-scan';

drop function if exists public.waitlist_scan();
drop function if exists public.waitlist_scan_session(uuid, integer, integer);
drop function if exists public.waitlist_detection_spots(uuid);
drop table if exists public.waitlist_settings;

alter table public.waitlist_openings drop constraint if exists waitlist_openings_closed_reason_format;
alter table public.waitlist_openings drop column if exists closed_reason;

commit;
