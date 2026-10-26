-- =============================================================================
-- AGENDAMENTO DO ENVIO DOS AVISOS DE VAGA — NÃO EXECUTAR sem decisão
-- explícita. Não está em supabase/migrations/ de propósito.
-- =============================================================================
--
-- O que faz: a cada minuto, o pg_cron chama `POST /api/cron/waitlist-notifications`
-- pelo `pg_net` — **só quando há aviso pendente na fila**. Sem aviso, nenhuma
-- chamada sai: o servidor só é acionado quando há o que enviar.
--
-- Pré-requisitos, nesta ordem:
--   1. migration `202610260002_waitlist_spot_email.sql` aplicada e postcheck OK;
--   2. `WAITLIST_NOTIFY_ENABLED=true` e `CRON_SECRET` em Production, com deploy;
--   3. o segredo no Vault (passo A abaixo), digitado por você no SQL Editor.
--
-- Custos: `pg_net` e Vault vêm com o Supabase, sem cobrança à parte. Cada
-- chamada é uma execução de função na Vercel, e só acontece com aviso pendente.
--
-- Agendar o envio **não liga a detecção**: sem `waitlist_settings.
-- detection_enabled = true` e sem o agendamento `waitlist-scan`, nenhum aviso
-- entra na fila e esta rotina não chama nada.

-- A. Extensão e segredo. Rodar uma vez. O valor é o mesmo `CRON_SECRET` da
--    Vercel. NUNCA salve o segredo neste arquivo nem em lugar nenhum do
--    repositório: troque o texto entre aspas na hora, no SQL Editor.
--
-- create extension if not exists pg_net with schema extensions;
-- select vault.create_secret('COLE_AQUI_O_CRON_SECRET', 'waitlist_cron_secret', 'Bearer de /api/cron/waitlist-notifications');

-- B. Agendamento. O segredo é lido do Vault a cada execução: não fica no
--    texto do agendamento, nem em cron.job.
select cron.schedule(
  'waitlist-notify',
  '* * * * *',
  $job$
    select net.http_post(
      url := 'https://www.almaazulacademy.com.br/api/cron/waitlist-notifications',
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'waitlist_cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 10000
    )
    where exists (select 1 from vault.decrypted_secrets where name = 'waitlist_cron_secret')
      and exists (
        select 1 from public.waitlist_notifications n
        where n.kind = 'SPOT_AVAILABLE'
          and (
            n.status = 'QUEUED'
            or (n.status = 'FAILED' and n.attempts < 6 and n.next_attempt_at <= now())
            or (n.status = 'SENDING' and n.locked_until <= now())
          )
      );
  $job$
);

-- Conferência: deve listar o agendamento, ativo.
select jobid, jobname, schedule, active from cron.job where jobname = 'waitlist-notify';

-- Acompanhamento das chamadas (as últimas respostas da rota):
-- select id, status_code, created from net._http_response order by created desc limit 10;
