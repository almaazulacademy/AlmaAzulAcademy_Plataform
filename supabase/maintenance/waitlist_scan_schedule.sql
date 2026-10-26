-- =============================================================================
-- AGENDAMENTO DA DETECÇÃO DE VAGAS DA LISTA DE ESPERA — NÃO EXECUTAR sem
-- decisão explícita. Não está em supabase/migrations/ de propósito.
-- =============================================================================
--
-- Pré-requisitos: migration `202610260001_waitlist_detection.sql` aplicada e
-- `supabase/diagnostics/waitlist_detection_postcheck.sql` aprovado.
--
-- O que faz: agenda `public.waitlist_scan()` a cada minuto no pg_cron — o
-- mesmo agendador que já roda `expire-alma-azul-pre-reservations`. Rodar de
-- novo só atualiza o agendamento existente (pg_cron identifica pelo nome).
--
-- Agendar **não liga** a detecção: com `waitlist_settings.detection_enabled =
-- false` (o padrão), cada execução responde `{enabled: false}` sem ler nem
-- gravar nada. Para ligar, uma decisão à parte:
--
--   update public.waitlist_settings set detection_enabled = true;
--
-- E mesmo ligada, a detecção só enfileira avisos (`SPOT_AVAILABLE`, `QUEUED`):
-- nenhum e-mail sai até a fase 6.
--
-- Para desfazer: `supabase/maintenance/waitlist_scan_unschedule.sql`, ou
-- desligar o interruptor acima (efeito imediato, sem tirar o agendamento).

select cron.schedule('waitlist-scan', '* * * * *', 'select public.waitlist_scan();');

-- Conferência: deve listar o agendamento, ativo.
select jobid, jobname, schedule, active from cron.job where jobname = 'waitlist-scan';
