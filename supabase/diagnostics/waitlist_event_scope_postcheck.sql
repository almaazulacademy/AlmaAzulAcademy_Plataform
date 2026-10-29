-- EVENTOS ESPECIAIS, ETAPA 5C-2 (LISTA DE ESPERA POR TIPO) — POSTCHECK (SOMENTE LEITURA)
--
-- Rodar no SQL Editor DEPOIS de `202610300001_waitlist_event_scope.sql`.
-- Mesmo formato do preflight. ASSINATURA_DAS_FUNCOES_EXISTENTES e as contagens
-- precisam ser iguais às do preflight. A linha final, WAITLIST_EVENTOS_POSTCHECK_OK,
-- fica OK quando nenhuma linha FALHOU.

with expected(fn, norm) as (values
    ('claim_pending_waitlist_spot_emails_by_kind', '65a6294ea0053666f44786106c5ff417'),
    ('waitlist_cancel_overview_with_kind', 'faf34d42b9ae3e1638caff5bfb8c9d61')
),
prod as (
  select p.proname as fn, md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g')) as norm, p.oid
  from pg_proc p where p.pronamespace = 'public'::regnamespace
),
new_names(name) as (values ('waitlist_cancel_overview_with_kind'), ('claim_pending_waitlist_spot_emails_by_kind')),
grants as (
  select pr.fn,
         has_function_privilege('service_role', pr.oid, 'execute') as service,
         has_function_privilege('anon', pr.oid, 'execute') or has_function_privilege('authenticated', pr.oid, 'execute') as public_api
  from prod pr where pr.fn in (select name from new_names)
),
checks as (
  select 'FUNCOES_NOVAS_COM_A_DEFINICAO_DO_REPOSITORIO' as check_name,
         (select count(*) filter (where pr.norm = e.norm)::text || ' de ' || count(*)::text from expected e left join prod pr on pr.fn = e.fn) as result,
         case when (select bool_and(pr.norm = e.norm) from expected e left join prod pr on pr.fn = e.fn) then 'OK' else 'FALHOU' end as status
  union all
  select 'SO_A_SERVICE_ROLE_EXECUTA',
         coalesce((select string_agg(fn || ': service=' || service::text || ', api=' || public_api::text, '; ' order by fn) from grants), 'ausentes'),
         case when (select count(*) from grants) = 2 and (select bool_and(service and not public_api) from grants) then 'OK' else 'FALHOU' end
  union all
  select 'FUNCOES_ANTERIORES_INTACTAS',
         'claim_pending_waitlist_spot_emails=' || exists (select 1 from prod where fn = 'claim_pending_waitlist_spot_emails')::text
           || ', waitlist_cancel_overview=' || exists (select 1 from prod where fn = 'waitlist_cancel_overview')::text,
         case when exists (select 1 from prod where fn = 'claim_pending_waitlist_spot_emails') and exists (select 1 from prod where fn = 'waitlist_cancel_overview') then 'OK' else 'FALHOU' end
  union all
  select 'NENHUM_AGENDAMENTO_NOVO',
         coalesce((select string_agg(jobname || '=' || active::text, ', ' order by jobname) from cron.job where jobname ilike '%waitlist%'), 'nenhum da lista'),
         case when exists (select 1 from cron.job where jobname ilike '%waitlist%' and active) then 'ATENCAO' else 'OK' end
  union all
  select 'ASSINATURA_DAS_FUNCOES_EXISTENTES',
         (select count(*)::text || ' funções, ' || md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), '|' order by p.oid::regprocedure::text))
          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not in (select name from new_names)),
         'OK'
  union all
  select 'INSCRICOES_POR_TIPO_E_STATUS',
         coalesce((select string_agg(kind || '/' || status || '=' || n, ', ' order by kind, status) from (
           select e.kind, we.status, count(*) n from public.waitlist_entries we join public.sessions s on s.id = we.session_id join public.experiences e on e.id = s.experience_id group by 1, 2) x), 'nenhuma'),
         'OK'
  union all
  select 'FILA_DA_LISTA_POR_STATUS',
         coalesce((select string_agg(kind || '/' || status || '=' || n, ', ' order by kind, status) from (select kind, status, count(*) n from public.waitlist_notifications group by 1, 2) x), 'vazia'),
         'OK'
  union all
  select 'RESERVAS_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.reservations group by 1) x),
         'OK'
)
select check_name, result, status from checks
union all
select 'WAITLIST_EVENTOS_POSTCHECK_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
