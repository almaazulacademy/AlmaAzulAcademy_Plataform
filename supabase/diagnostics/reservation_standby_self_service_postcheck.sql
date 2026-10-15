-- AUTOATENDIMENTO DO STAND-BY — POSTCHECK (SOMENTE LEITURA)
--
-- Rodar no SQL Editor DEPOIS de `202610160001_reservation_standby_self_service.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita e
-- nenhum dado pessoal retornado — nem o segredo do limite, só o tamanho dele.
--
-- A linha final, STANDBY_AUTOATENDIMENTO_POSTCHECK_OK, fica OK quando nenhuma
-- linha FALHOU. As cinco contagens precisam devolver os mesmos números do
-- preflight: a migration cria duas tabelas e duas funções e não toca nenhuma
-- linha existente.
--
-- Rodado antes da migration, ele falha com "relation does not exist" em vez de
-- aprovar.

with expected(fn, kind, exact, norm) as (values
    ('customer_reschedule_overview', 'NOVA', 'e9d06691889941446abc4f952cd13bd5', '05ec424150d165682012b95f02ed6c3c'),
    ('register_customer_access_attempt', 'NOVA', '034d0ad135acab10b46eedf44e4264ee', 'f41f122a37c6798d1bee4059e6f8c951'),
    ('customer_reschedule_options', 'ETAPA_2', '9cb629730d6b1aa3da298647d1d4774a', '73845f5f1bdec1737703903b7fd8c2eb'),
    ('customer_reschedule_reservation', 'ETAPA_2', '527e7caf2007bf809cf0a0f9070e293a', '2de122ee7dee9b72d0ce9e223f5a2ee9'),
    ('reservation_latest_standby', 'ETAPA_2', '769baa3c30a33be6bce7f708e0bb0841', 'ba75c6375310e323ed450a34bf93a530'),
    ('reservation_standby_access', 'ETAPA_2', '18f750997161dcb9c104ac19623baab1', '72e74fd4e58b390fc82820b8ae817892'),
    ('reservation_standby_resolve', 'ETAPA_2', 'ee2c16b8a8e2960656a6eb45c8021924', 'd8a5f75fdaf19ae2926cac272fac224b'),
    ('reservation_standby_target_rejection', 'ETAPA_2', '202b1b5e84a5e0b387bfd94b1e4ed6e4', '2ba6e8597a398c70dfde960adc0f78d8')
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
limit_tables as (
  select c.oid, c.relname, c.relrowsecurity,
         (select count(*) from pg_policy p where p.polrelid = c.oid) as policies,
         has_table_privilege('service_role', c.oid, 'SELECT') or has_table_privilege('service_role', c.oid, 'INSERT')
           or has_table_privilege('service_role', c.oid, 'UPDATE') or has_table_privilege('service_role', c.oid, 'DELETE') as service_access,
         has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'SELECT')
           or has_table_privilege('anon', c.oid, 'INSERT') or has_table_privilege('authenticated', c.oid, 'INSERT') as public_access
  from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relname in ('customer_access_throttle', 'customer_access_throttle_secret')
),
checks as (
  select 'FUNCOES_NOVAS_COM_A_DEFINICAO_DO_REPOSITORIO' as check_name,
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from created) as result,
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from created) then 'OK' else 'FALHOU' end as status
  union all
  select 'FUNCOES_SECURITY_DEFINER_COM_SEARCH_PATH',
         coalesce((select string_agg(fn, ', ' order by fn) from created
                   where not coalesce(prosecdef, false) or proconfig is null or not exists (select 1 from unnest(proconfig) c where c like 'search_path=%')), 'todas'),
         case when not exists (select 1 from created where not coalesce(prosecdef, false) or proconfig is null or not exists (select 1 from unnest(proconfig) c where c like 'search_path=%')) then 'OK' else 'FALHOU' end
  union all
  select 'NENHUMA_FUNCAO_EXECUTAVEL_PELA_API_PUBLICA',
         coalesce((select string_agg(fn, ', ' order by fn) from created
                   where oid is not null and (has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE'))), 'nenhuma'),
         case when not exists (select 1 from created where oid is not null and (has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE'))) then 'OK' else 'FALHOU' end
  union all
  select 'FUNCOES_EXECUTAVEIS_PELA_SERVICE_ROLE',
         (select count(*)::text from created where oid is not null and has_function_privilege('service_role', oid, 'EXECUTE')) || ' de 2',
         case when (select count(*) = 2 from created where oid is not null and has_function_privilege('service_role', oid, 'EXECUTE')) then 'OK' else 'FALHOU' end
  union all
  -- Contadores e segredo: RLS ligada, nenhuma policy e nenhum acesso — nem da
  -- service role. Só a função do limite os alcança.
  select 'TABELAS_DO_LIMITE_FECHADAS',
         coalesce((select string_agg(relname || ': rls=' || relrowsecurity::text || ', policies=' || policies::text
                                      || ', service_role=' || service_access::text || ', api pública=' || public_access::text,
                                      ' | ' order by relname) from limit_tables), 'ausentes'),
         case when (select count(*) = 2 from limit_tables where relrowsecurity and policies = 0 and not service_access and not public_access)
              then 'OK' else 'FALHOU' end
  union all
  select 'SEGREDO_DO_LIMITE',
         (select count(*)::text || ' linha(s), ' || coalesce(max(octet_length(secret)), 0)::text || ' bytes' from public.customer_access_throttle_secret),
         case when (select count(*) = 1 and min(octet_length(secret)) = 32 from public.customer_access_throttle_secret) then 'OK' else 'FALHOU' end
  union all
  select 'CONTADORES_DO_LIMITE',
         (select count(*)::text || ' balde(s)' from public.customer_access_throttle),
         'OK'
  union all
  select 'FUNCOES_DA_ETAPA_2_INALTERADAS',
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions where kind = 'ETAPA_2'),
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from functions where kind = 'ETAPA_2') then 'OK' else 'FALHOU' end
  union all
  select 'TRIGGER_DO_EMAIL_ATIVA',
         coalesce((select tgenabled::text from pg_trigger where tgrelid = 'public.reservation_session_changes'::regclass and tgname = 'reservation_session_changes_reschedule_email'), 'ausente'),
         case when exists (select 1 from pg_trigger where tgrelid = 'public.reservation_session_changes'::regclass and tgname = 'reservation_session_changes_reschedule_email' and tgenabled = 'O')
              then 'OK' else 'FALHOU' end
  union all
  select 'RESERVAS_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.reservations group by 1) x),
         'OK'
  union all
  select 'EVENTOS_DE_PAGAMENTO', (select count(*)::text from public.payment_events), 'OK'
  union all
  select 'HISTORICO_DE_TROCAS', (select count(*)::text from public.reservation_session_changes), 'OK'
  union all
  select 'AUTORIZACOES_DE_STANDBY',
         (select count(*)::text || ' no total, ' || count(*) filter (where resolved_at is null)::text || ' aberta(s), '
                 || count(*) filter (where link_token_hash is not null and resolved_at is null)::text || ' com link ativo'
          from public.reservation_standby),
         'OK'
  union all
  select 'FILA_DE_REAGENDAMENTO',
         coalesce((select string_agg(status || '=' || n, ', ' order by status) from (select status, count(*) n from public.reservation_reschedule_emails group by 1) x), 'vazia'),
         'OK'
)
select check_name, result, status from checks
union all
select 'STANDBY_AUTOATENDIMENTO_POSTCHECK_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
