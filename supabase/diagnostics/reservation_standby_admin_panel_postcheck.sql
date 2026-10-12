-- PAINEL DE STAND-BY — POSTCHECK (SOMENTE LEITURA)
--
-- Rodar no SQL Editor DEPOIS de `202610140001_reservation_standby_admin_panel.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita e
-- nenhum dado pessoal retornado.
--
-- Três estados: OK, ATENCAO (não é falha da migration, mas precisa ser lido) e
-- FALHOU. A linha final, STANDBY_PAINEL_POSTCHECK_OK, fica OK quando nenhuma
-- linha FALHOU; o texto dela diz quantos pontos de atenção existem. As quatro
-- contagens precisam devolver os mesmos números do preflight (fora o que
-- aconteceu de verdade no site entre as duas execuções): a migration cria
-- funções e retira um privilégio, e não toca nenhuma linha.
--
-- As funções são conferidas como no preflight: pelo texto exato e pelo texto com
-- o espaço em branco normalizado. Diferença só de formatação (LF/CRLF, espaços,
-- recuo) vira IDENTICA_SO_FORMATACAO e continua OK; diferença de conteúdo é
-- DIFERENTE. Para as quatro funções criadas e para as três que elas chamam,
-- DIFERENTE é FALHOU. Para as duas que a migration não substitui, é ATENCAO.

with expected(fn, kind, exact, norm) as (values
    ('admin_list_standby_reservations_page', 'CRIADA', 'a771c692cf79b720ad91698343468a7c', '504ad355c1c16b58aedf828c4ac6380f'),
    ('admin_reschedule_standby_same_price', 'CRIADA', '4fd9f60fe6fe1cc1e9c8a108f7cae071', 'c45d8f153f95f6023e197d3514d8b941'),
    ('admin_reservation_standby_history', 'CRIADA', 'af6c1208eb383c7ca14e8f5192a85c2d', 'cea4376f39b15e721c8ea7241453d6a0'),
    ('admin_standby_reschedule_options', 'CRIADA', 'd5d6bae1784e13e3cb9a94a511bc2517', 'cc3f57264800295d3f1b13fc30b5b112'),
    ('reservation_latest_standby', 'CHAMADA', '769baa3c30a33be6bce7f708e0bb0841', 'ba75c6375310e323ed450a34bf93a530'),
    ('reservation_standby_resolve', 'CHAMADA', 'ee2c16b8a8e2960656a6eb45c8021924', 'd8a5f75fdaf19ae2926cac272fac224b'),
    ('reservation_standby_target_rejection', 'CHAMADA', '202b1b5e84a5e0b387bfd94b1e4ed6e4', '2ba6e8597a398c70dfde960adc0f78d8'),
    ('admin_change_reservation_session', 'NAO_SUBSTITUIDA', '02510c8110db73848ed0e8d0046533b2', '3913fee3b625ce4364e332be01a1772d'),
    ('admin_reschedule_reservation_from_standby', 'NAO_SUBSTITUIDA', '42bbaea1abbad4dc11e258ce4aa67762', 'a183eaaf2359d286e004af5dfb7d8fba')
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
created as (select * from functions where kind = 'CRIADA'),
checks as (
  select 'FUNCOES_DO_PAINEL_COM_A_DEFINICAO_DO_REPOSITORIO' as check_name,
         coalesce((select string_agg(fn || '=' || verdict, ', ' order by fn) from created where verdict <> 'IDENTICA'), 'todas as ' || (select count(*) from created) || ' idênticas') as result,
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
         (select count(*)::text from created where oid is not null and has_function_privilege('service_role', oid, 'EXECUTE')),
         case when (select count(*) = 4 from created where oid is not null and has_function_privilege('service_role', oid, 'EXECUTE')) then 'OK' else 'FALHOU' end
  union all
  -- A função continua no banco, mas nenhum papel da API a executa.
  select 'REAGENDAMENTO_SEM_REGUA_FORA_DO_ALCANCE',
         coalesce((select case when f.oid is null then 'função ausente'
                               else 'presente; executável por: ' || coalesce(nullif(concat_ws(', ',
                                      case when has_function_privilege('service_role', f.oid, 'EXECUTE') then 'service_role' end,
                                      case when has_function_privilege('authenticated', f.oid, 'EXECUTE') then 'authenticated' end,
                                      case when has_function_privilege('anon', f.oid, 'EXECUTE') then 'anon' end), ''), 'nenhum papel da API') end
                   from functions f where f.fn = 'admin_reschedule_reservation_from_standby'), 'função ausente'),
         case when exists (select 1 from functions f where f.fn = 'admin_reschedule_reservation_from_standby' and f.oid is not null
                             and not has_function_privilege('service_role', f.oid, 'EXECUTE')
                             and not has_function_privilege('authenticated', f.oid, 'EXECUTE')
                             and not has_function_privilege('anon', f.oid, 'EXECUTE'))
              then 'OK' else 'FALHOU' end
  union all
  -- A proteção da planilha lê `reservation_standby` como service role. A tabela
  -- tem RLS ligada e nenhuma policy: sem o privilégio de leitura **e** sem
  -- ignorar RLS, a leitura voltaria vazia em silêncio e a proteção não agiria.
  select 'SERVICE_ROLE_LE_AS_AUTORIZACOES',
         'select=' || has_table_privilege('service_role', 'public.reservation_standby', 'SELECT')::text
           || ', ignora_rls=' || coalesce((select rolbypassrls::text from pg_roles where rolname = 'service_role'), 'papel ausente'),
         case when has_table_privilege('service_role', 'public.reservation_standby', 'SELECT')
                   and coalesce((select rolbypassrls from pg_roles where rolname = 'service_role'), false)
              then 'OK' else 'FALHOU' end
  union all
  select 'FUNCOES_QUE_O_PAINEL_CHAMA',
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions where kind = 'CHAMADA'),
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from functions where kind = 'CHAMADA') then 'OK' else 'FALHOU' end
  union all
  select 'FUNCOES_NAO_SUBSTITUIDAS',
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions where kind = 'NAO_SUBSTITUIDA'),
         case when exists (select 1 from functions where kind = 'NAO_SUBSTITUIDA' and verdict in ('AUSENTE', 'SOBRECARGA')) then 'FALHOU'
              when exists (select 1 from functions where kind = 'NAO_SUBSTITUIDA' and verdict = 'DIFERENTE') then 'ATENCAO'
              else 'OK' end
  union all
  select 'TRIGGER_DA_INVARIANTE_ATIVA',
         coalesce((select tgenabled::text from pg_trigger where tgrelid = 'public.reservations'::regclass and tgname = 'reservations_standby_guard'), 'ausente'),
         case when exists (select 1 from pg_trigger where tgrelid = 'public.reservations'::regclass and tgname = 'reservations_standby_guard' and tgenabled = 'O') then 'OK' else 'FALHOU' end
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
         (select count(*)::text || ' no total, ' || count(*) filter (where resolved_at is null)::text || ' aberta(s)' from public.reservation_standby),
         'OK'
)
select check_name, result, status from checks
union all
select 'STANDBY_PAINEL_POSTCHECK_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
