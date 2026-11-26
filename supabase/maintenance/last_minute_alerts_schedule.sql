-- INSTALAÇÃO MANUAL FUTURA, APÓS HOMOLOGAÇÃO. Não foi executado.
-- Pré-requisitos no Vault, cadastrados pelo administrador, sem imprimir valores:
-- last_minute_alert_worker_url = URL HTTPS exata do worker de produção
-- last_minute_alert_worker_secret = mesmo segredo dedicado da Vercel
-- Não usar service_role nem chave do Resend para autenticar esta chamada.
-- Isto não ativa a captura: settings.enabled continua sendo uma barreira.
begin;
create extension if not exists pg_net with schema extensions;
do $$
begin
  if not exists(select 1 from vault.secrets where name='last_minute_alert_worker_secret')
    or not exists(select 1 from vault.decrypted_secrets where name='last_minute_alert_worker_url'
      and decrypted_secret='https://www.almaazulacademy.com.br/api/cron/last-minute-alerts') then
    raise exception 'ALERT_WORKER_VAULT_CONFIGURATION_REQUIRED';
  end if;
  if exists(select 1 from cron.job where jobname='alma-azul-last-minute-alerts') then
    perform cron.unschedule('alma-azul-last-minute-alerts');
  end if;
  perform cron.schedule('alma-azul-last-minute-alerts','* * * * *',$command$
    select net.http_post(
      url:=(select decrypted_secret from vault.decrypted_secrets where name='last_minute_alert_worker_url'),
      headers:=jsonb_build_object('Content-Type','application/json','Authorization',
        'Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='last_minute_alert_worker_secret')),
      body:='{}'::jsonb, timeout_milliseconds:=30000
    )
    where exists(select 1 from public.last_minute_alert_settings where singleton and enabled)
      and (exists(select 1 from public.last_minute_alerts
        where (status in ('QUEUED','FAILED') and next_attempt_at<=now())
           or (status='SENDING' and locked_until<=now()))
        or exists(select 1 from public.last_minute_session_events ev
          join public.last_minute_alert_settings cfg on cfg.singleton and cfg.epoch=ev.epoch
          join public.sessions s on s.id=ev.session_id and s.starts_at=ev.starts_at
          where ev.starts_at>now()));
  $command$);
end $$;
commit;
