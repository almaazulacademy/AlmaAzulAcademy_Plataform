-- Somente leitura: nenhuma identidade de cliente, credencial ou corpo de e-mail.
select enabled,first_activated_at,active_since from public.last_minute_alert_settings;
select status,priority,count(*) as alerts,min(created_at) as oldest,max(sent_at) as latest_acceptance
  from public.last_minute_alerts group by status,priority order by status,priority;
select status,last_error_code,count(*) as alerts from public.last_minute_alerts
  where status in ('FAILED','UNCERTAIN') group by status,last_error_code;
select jobname,schedule,active from cron.job where jobname='alma-azul-last-minute-alerts';
select status,count(*) as runs,max(end_time) as latest_end from cron.job_run_details
  where jobid in(select jobid from cron.job where jobname='alma-azul-last-minute-alerts')
    and start_time>=now()-interval '24 hours' group by status;
