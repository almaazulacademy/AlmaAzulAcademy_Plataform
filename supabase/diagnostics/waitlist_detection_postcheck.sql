-- LISTA DE ESPERA, FASE 5 (DETECÇÃO DE VAGAS) — POSTCHECK (SOMENTE LEITURA)
--
-- Rodar no SQL Editor DEPOIS de `202610260001_waitlist_detection.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita e
-- nenhum dado pessoal retornado.
--
-- A linha final, WAITLIST_DETECCAO_POSTCHECK_OK, fica OK quando nenhuma linha
-- FALHOU. ASSINATURA_DAS_FUNCOES_EXISTENTES e as contagens precisam devolver os
-- mesmos valores do preflight. Rodado antes da migration, falha com "relation
-- does not exist" em vez de aprovar.
--
-- Pode ser rodado de novo mais tarde: com a detecção ligada ou agendada, as
-- linhas INTERRUPTOR_DA_DETECCAO e AGENDAMENTO_DA_VARREDURA viram ATENCAO —
-- é o aviso de que algo já está funcionando, não uma falha.

with expected(fn, kind, exact, norm) as (values
    ('waitlist_detection_spots', 'NOVA', '9e9c15c211c779943886bc1e86e5c156', '43df8923e16003b51bfeebea2bf817c6'),
    ('waitlist_scan', 'NOVA', '6aa9c61ae0fdfa439f9ad34b2602a8ce', 'ccc6bda258c58d5a685b4a034fca8338'),
    ('waitlist_scan_session', 'NOVA', 'cc6dfb21797acc0e5741f19d9e0ee282', '2838c4e7cc4c4cb96d2688b323ec3cda'),
    ('available_spots', 'EXISTENTE', '0fe290aa82248812c1c035354d94e2fa', 'a3050f894ad24f6262b2b80d1d3a752f'),
    ('waitlist_eligible_entries', 'EXISTENTE', '34079b42518195d56fdcee936cd341de', 'fc7a55b6c2c1933aa4cbe554cf79b4f2'),
    ('waitlist_expire_entries', 'EXISTENTE', 'e089f98f87c3343b95564ec168f64a0a', 'e3ed7398ed28d180c50f96fd8fabb9e4'),
    ('waitlist_mark_conversions', 'EXISTENTE', '66d3e7e8ab76341a645ceb6cc14bca6b', '7531f851c0e56a47044ce77559d4bb6d'),
    ('waitlist_skip_pending_notifications', 'EXISTENTE', 'c76881471c82db58e1791c14aeff9414', '62a87376506864938255dc9d17ecfcb2'),
    ('waitlist_wave_size', 'EXISTENTE', 'bbc23d8db36d4689225b13e08138838b', 'b4149df44c87eb19aa56933e1325051f')
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
created as (select * from functions where kind = 'NOVA'),
exposed as (
  select fn from created
  where oid is null
     or has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE')
     or has_function_privilege('service_role', oid, 'EXECUTE')
),
settings_table as (
  select c.relrowsecurity and (select count(*) from pg_policy p where p.polrelid = c.oid) = 0
           and not exists (
             select 1 from unnest(array['anon', 'authenticated', 'service_role']) r(role),
                           unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p(priv)
             where has_table_privilege(r.role, c.oid, p.priv)
           ) as closed
  from pg_class c where c.oid = 'public.waitlist_settings'::regclass
),
checks as (
  select 'FUNCOES_NOVAS_COM_A_DEFINICAO_DO_REPOSITORIO' as check_name,
         (select count(*) filter (where verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO'))::text || ' de ' || count(*)::text
                 || coalesce(' | ' || string_agg(fn || '=' || verdict, ', ' order by fn) filter (where verdict not in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')), '')
          from created) as result,
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from created) then 'OK' else 'FALHOU' end as status
  union all
  select 'FUNCOES_SECURITY_DEFINER_COM_SEARCH_PATH',
         coalesce((select string_agg(fn, ', ' order by fn) from created
                   where not coalesce(prosecdef, false) or proconfig is null or not exists (select 1 from unnest(proconfig) c where c like 'search_path=%')), 'todas'),
         case when not exists (select 1 from created where not coalesce(prosecdef, false) or proconfig is null or not exists (select 1 from unnest(proconfig) c where c like 'search_path=%')) then 'OK' else 'FALHOU' end
  union all
  select 'NENHUMA_FUNCAO_PELA_API',
         coalesce('expostas: ' || (select string_agg(fn, ', ' order by fn) from exposed), 'nenhuma executável por anon, authenticated ou service_role'),
         case when exists (select 1 from exposed) then 'FALHOU' else 'OK' end
  union all
  select 'FUNCOES_EXISTENTES_INALTERADAS',
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions where kind = 'EXISTENTE'),
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from functions where kind = 'EXISTENTE') then 'OK' else 'FALHOU' end
  union all
  select 'CONFIGURACAO_FECHADA',
         (select count(*)::text || ' linha(s)' from public.waitlist_settings) || ', ' || coalesce((select case when closed then 'sem acesso pela API' else 'EXPOSTA' end from settings_table), 'ausente'),
         case when (select count(*) = 1 from public.waitlist_settings) and (select closed from settings_table) then 'OK' else 'FALHOU' end
  union all
  select 'INTERRUPTOR_DA_DETECCAO',
         (select case when detection_enabled then 'LIGADO' else 'desligado' end
                 || ', ondas a cada ' || wave_interval_minutes || ' min, carência de ' || opening_grace_seconds || ' s, até ' || max_sessions_per_scan || ' turmas por execução'
          from public.waitlist_settings),
         case when (select detection_enabled from public.waitlist_settings) then 'ATENCAO' else 'OK' end
  union all
  select 'AGENDAMENTO_DA_VARREDURA',
         coalesce((select string_agg(jobname || '=' || coalesce(schedule, '?') || case when active then '' else ' (inativo)' end, ', ') from cron.job where jobname ilike '%waitlist%'), 'nenhum'),
         case when exists (select 1 from cron.job where jobname ilike '%waitlist%') then 'ATENCAO' else 'OK' end
  union all
  select 'COLUNA_DO_MOTIVO_DE_FECHAMENTO',
         (select count(*) filter (where closed_reason is not null)::text || ' abertura(s) com motivo' from public.waitlist_openings),
         'OK'
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
  select 'ABERTURAS',
         (select count(*)::text || ' no total, ' || count(*) filter (where closed_at is null)::text || ' abertas' from public.waitlist_openings),
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
select 'WAITLIST_DETECCAO_POSTCHECK_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
