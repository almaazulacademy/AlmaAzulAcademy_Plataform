-- LISTA DE ESPERA, FASE 6 (AVISO DE VAGA) — POSTCHECK (SOMENTE LEITURA)
--
-- Rodar no SQL Editor DEPOIS de `202610260002_waitlist_spot_email.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita e
-- nenhum dado pessoal retornado.
--
-- A linha final, WAITLIST_AVISO_POSTCHECK_OK, fica OK quando nenhuma linha
-- FALHOU. ASSINATURA_DAS_FUNCOES_EXISTENTES e as contagens precisam devolver os
-- mesmos valores do preflight. Rodado antes da migration, falha em
-- REGRA_DO_ENVIO (a função ainda não existe) em vez de aprovar.

with expected(fn, kind, exact, norm) as (values
    ('claim_pending_waitlist_spot_emails', 'SERVIDOR', 'b47654ae269ec80a18ba985ae95a0da1', 'fcf6a0d8b95fd3e4f5ce1093eee3d805'),
    ('complete_waitlist_spot_email', 'SERVIDOR', 'ca374f61b02e551f7d4f4f4a58a2823b', '2c3e9374047c21ab4028218c432a0d2f'),
    ('waitlist_spot_payload', 'INTERNA', '63344f4d07045c6e61af22a5086a5bf7', 'b2efae7255d3557bac68541e9870596e'),
    ('waitlist_spot_rejection', 'INTERNA', 'ea2785c1e4eeed9382c75a95ff748feb', '94a740dd57fd778d8d0fe561a16c71d1'),
    ('waitlist_spot_take', 'INTERNA', '7a5a1d4cc7a3986f8f1e2bcac54f8977', 'e684e4896c0f89f78fe8435cf0fea8a2'),
    ('fail_waitlist_email', 'EXISTENTE', '3cf7275d494382311ba91de409d5fb30', 'aad45a5ac4ed4bdb93f77eac073f0dac'),
    ('freeze_waitlist_email', 'EXISTENTE', '115df869ac486f60c3ed3c283217ce89', '7057e507f8a3e6598d732db389d49430'),
    ('waitlist_cancel_token', 'EXISTENTE', 'c4fc03a731bc475353af6925d9314993', 'b8e0445c63e079608b992ad6927df767'),
    ('waitlist_detection_spots', 'EXISTENTE', '9e9c15c211c779943886bc1e86e5c156', '43df8923e16003b51bfeebea2bf817c6')
),
prod as (
  select p.oid, p.proname as fn,
         md5(p.prosrc) as exact,
         md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g')) as norm,
         p.prosecdef, p.proconfig, count(*) over (partition by p.proname) as overloads
  from pg_proc p where p.pronamespace = 'public'::regnamespace
),
functions as (
  select e.fn, e.kind, pr.oid, pr.prosecdef, pr.proconfig,
         case when pr.fn is null then 'AUSENTE'
              when pr.overloads > 1 then 'SOBRECARGA'
              when pr.exact = e.exact then 'IDENTICA'
              when pr.norm = e.norm then 'IDENTICA_SO_FORMATACAO'
              else 'DIFERENTE' end as verdict
  from expected e left join prod pr on pr.fn = e.fn
),
created as (select * from functions where kind in ('SERVIDOR', 'INTERNA')),
wrong_grants as (
  select fn from created
  where oid is null
     or has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE')
     or (kind = 'SERVIDOR' and not has_function_privilege('service_role', oid, 'EXECUTE'))
     or (kind = 'INTERNA' and has_function_privilege('service_role', oid, 'EXECUTE'))
),
checks as (
  select 'FUNCOES_NOVAS_COM_A_DEFINICAO_DO_REPOSITORIO' as check_name,
         (select count(*) filter (where verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO'))::text || ' de ' || count(*)::text
                 || coalesce(' | ' || string_agg(fn || '=' || verdict, ', ' order by fn) filter (where verdict not in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')), '')
          from created) as result,
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from created) then 'OK' else 'FALHOU' end as status
  union all
  -- Chama a régua: antes da migration, o postcheck para aqui com erro.
  select 'REGRA_DO_ENVIO',
         coalesce(public.waitlist_spot_rejection('00000000-0000-4000-8000-000000000000'::uuid), 'sem resposta'),
         case when public.waitlist_spot_rejection('00000000-0000-4000-8000-000000000000'::uuid) = 'NOT_FOUND' then 'OK' else 'FALHOU' end
  union all
  select 'FUNCOES_SECURITY_DEFINER_COM_SEARCH_PATH',
         coalesce((select string_agg(fn, ', ' order by fn) from created
                   where not coalesce(prosecdef, false) or proconfig is null or not exists (select 1 from unnest(proconfig) c where c like 'search_path=%')), 'todas'),
         case when not exists (select 1 from created where not coalesce(prosecdef, false) or proconfig is null or not exists (select 1 from unnest(proconfig) c where c like 'search_path=%')) then 'OK' else 'FALHOU' end
  union all
  select 'PERMISSOES_DAS_FUNCOES',
         (select count(*) filter (where kind = 'SERVIDOR')::text || ' do servidor, ' || count(*) filter (where kind = 'INTERNA')::text || ' internas' from created)
           || coalesce(' | erradas: ' || (select string_agg(fn, ', ' order by fn) from wrong_grants), ''),
         case when exists (select 1 from wrong_grants) then 'FALHOU' else 'OK' end
  union all
  select 'FUNCOES_REAPROVEITADAS_INALTERADAS',
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions where kind = 'EXISTENTE'),
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from functions where kind = 'EXISTENTE') then 'OK' else 'FALHOU' end
  union all
  select 'INTERRUPTOR_DA_DETECCAO',
         (select case when detection_enabled then 'LIGADO' else 'desligado' end from public.waitlist_settings),
         case when (select detection_enabled from public.waitlist_settings) then 'ATENCAO' else 'OK' end
  union all
  select 'AGENDAMENTOS_DA_LISTA',
         coalesce((select string_agg(jobname || '=' || coalesce(schedule, '?') || case when active then '' else ' (inativo)' end, ', ' order by jobname) from cron.job where jobname ilike '%waitlist%'), 'nenhum'),
         case when exists (select 1 from cron.job where jobname ilike '%waitlist%') then 'ATENCAO' else 'OK' end
  union all
  select 'ASSINATURA_DAS_FUNCOES_EXISTENTES',
         (select count(*)::text || ' funções, ' || md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), '|' order by p.oid::regprocedure::text))
          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not in (select fn from created)),
         'OK'
  union all
  select 'INSCRICOES_POR_STATUS',
         coalesce((select string_agg(status || '=' || n, ', ' order by status) from (select status, count(*) n from public.waitlist_entries group by 1) x), 'nenhuma'),
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
select 'WAITLIST_AVISO_POSTCHECK_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
