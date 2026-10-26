-- =============================================================================
-- REMOVE O AGENDAMENTO DA DETECÇÃO DE VAGAS — só com decisão explícita.
-- =============================================================================
--
-- Tira `waitlist-scan` do pg_cron. Não apaga aberturas nem avisos já
-- enfileirados, e não mexe no interruptor (`waitlist_settings`). Rodar sem o
-- agendamento existir não faz nada.

select cron.unschedule(jobname) from cron.job where jobname = 'waitlist-scan';

select count(*) as agendamentos_restantes from cron.job where jobname = 'waitlist-scan';
