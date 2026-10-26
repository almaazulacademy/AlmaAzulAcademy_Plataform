-- =============================================================================
-- REMOVE O AGENDAMENTO DO ENVIO DOS AVISOS DE VAGA — só com decisão explícita.
-- =============================================================================
--
-- Tira `waitlist-notify` do pg_cron. Não apaga o segredo do Vault nem avisos da
-- fila. O botão de emergência mais rápido é outro: `WAITLIST_NOTIFY_ENABLED`
-- desligada faz a rota responder DISABLED sem enviar nada.

select cron.unschedule(jobname) from cron.job where jobname = 'waitlist-notify';

select count(*) as agendamentos_restantes from cron.job where jobname = 'waitlist-notify';
