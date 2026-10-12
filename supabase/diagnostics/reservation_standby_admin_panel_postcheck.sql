-- PAINEL DE STAND-BY — POSTCHECK (SOMENTE LEITURA)
--
-- Rodar no SQL Editor DEPOIS de `202610140001_reservation_standby_admin_panel.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita e
-- nenhum dado pessoal retornado.
--
-- A linha final, STANDBY_PAINEL_POSTCHECK_OK, só fica OK quando todas as outras
-- estão. As quatro contagens precisam devolver os mesmos números do preflight
-- (fora o que aconteceu de verdade no site entre as duas execuções): a migration
-- só cria funções e não toca nenhuma linha.

with expected(fn, lf, crlf) as (values
    ('admin_list_standby_reservations_page', 'a771c692cf79b720ad91698343468a7c', '9abfa712f42d4153d2c31ad82e9c87f1'),
    ('admin_reschedule_standby_same_price', '4fd9f60fe6fe1cc1e9c8a108f7cae071', 'dec3a43993cf9c6abe30e144b080ea0c'),
    ('admin_reservation_standby_history', 'af6c1208eb383c7ca14e8f5192a85c2d', 'a67642071716a88d5f82489f83dc85aa'),
    ('admin_standby_reschedule_options', 'd5d6bae1784e13e3cb9a94a511bc2517', '0b5903da2cd136c6101ab9a324baf1eb')
),
untouched(fn, lf, crlf) as (values
    ('admin_change_reservation_session', '02510c8110db73848ed0e8d0046533b2', ''),
    ('admin_reschedule_reservation_from_standby', '42bbaea1abbad4dc11e258ce4aa67762', '43eb10503558dc6dd418514fba04aa60'),
    ('reservation_latest_standby', '769baa3c30a33be6bce7f708e0bb0841', '51d73805e9495a5f1de6a016644c8af4'),
    ('reservation_standby_resolve', 'ee2c16b8a8e2960656a6eb45c8021924', '0d0eef68e34f06f31639971e8c4e9fdb'),
    ('reservation_standby_target_rejection', '202b1b5e84a5e0b387bfd94b1e4ed6e4', '958d5d630c0d8d5af66278a9ff571721')
),
prod as (
  select p.oid, p.proname as fn, md5(p.prosrc) as h, md5(replace(replace(p.prosrc, E'\r\n', E'\n'), E'\r', '')) as h_lf,
         p.prosecdef, p.proconfig, count(*) over (partition by p.proname) as overloads
  from pg_proc p where p.pronamespace = 'public'::regnamespace
),
functions as (
  select e.fn, pr.oid, pr.prosecdef, pr.proconfig,
         case when pr.fn is null then 'AUSENTE'
              when pr.overloads > 1 then 'SOBRECARGA'
              when pr.h = e.lf then 'IDENTICA'
              when pr.h = e.crlf or pr.h_lf = e.lf then 'IDENTICA_CRLF'
              else 'DIFERENTE' end as verdict
  from expected e left join prod pr on pr.fn = e.fn
),
previous as (
  select e.fn,
         case when pr.fn is null then 'AUSENTE'
              when pr.overloads > 1 then 'SOBRECARGA'
              when pr.h = e.lf then 'IDENTICA'
              when pr.h = e.crlf or pr.h_lf = e.lf then 'IDENTICA_CRLF'
              else 'DIFERENTE' end as verdict
  from untouched e left join prod pr on pr.fn = e.fn
),
checks as (
  select 'FUNCOES_DO_PAINEL_COM_A_DEFINICAO_DO_REPOSITORIO' as check_name,
         coalesce((select string_agg(fn || '=' || verdict, ', ' order by fn) from functions where verdict not in ('IDENTICA', 'IDENTICA_CRLF')), 'todas as ' || (select count(*) from functions) || ' idênticas') as result,
         (select bool_and(verdict in ('IDENTICA', 'IDENTICA_CRLF')) from functions) as ok
  union all
  select 'FUNCOES_SECURITY_DEFINER_COM_SEARCH_PATH',
         coalesce((select string_agg(fn, ', ' order by fn) from functions
                   where not coalesce(prosecdef, false) or proconfig is null or not exists (select 1 from unnest(proconfig) c where c like 'search_path=%')), 'todas'),
         not exists (select 1 from functions where not coalesce(prosecdef, false) or proconfig is null or not exists (select 1 from unnest(proconfig) c where c like 'search_path=%'))
  union all
  select 'NENHUMA_FUNCAO_EXECUTAVEL_PELA_API_PUBLICA',
         coalesce((select string_agg(fn, ', ' order by fn) from functions
                   where oid is not null and (has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE'))), 'nenhuma'),
         not exists (select 1 from functions where oid is not null and (has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE')))
  union all
  select 'FUNCOES_EXECUTAVEIS_PELA_SERVICE_ROLE',
         (select count(*)::text from functions where oid is not null and has_function_privilege('service_role', oid, 'EXECUTE')),
         (select count(*) = 4 from functions where oid is not null and has_function_privilege('service_role', oid, 'EXECUTE'))
  union all
  select 'FUNCOES_ANTERIORES_INTACTAS',
         coalesce((select string_agg(fn || '=' || verdict, ', ' order by fn) from previous where verdict not in ('IDENTICA', 'IDENTICA_CRLF')), 'todas as ' || (select count(*) from previous) || ' idênticas'),
         (select bool_and(verdict in ('IDENTICA', 'IDENTICA_CRLF')) from previous)
  union all
  select 'TRIGGER_DA_INVARIANTE_ATIVA',
         coalesce((select tgenabled::text from pg_trigger where tgrelid = 'public.reservations'::regclass and tgname = 'reservations_standby_guard'), 'ausente'),
         exists (select 1 from pg_trigger where tgrelid = 'public.reservations'::regclass and tgname = 'reservations_standby_guard' and tgenabled = 'O')
  union all
  select 'RESERVAS_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.reservations group by 1) x),
         true
  union all
  select 'EVENTOS_DE_PAGAMENTO', (select count(*)::text from public.payment_events), true
  union all
  select 'HISTORICO_DE_TROCAS', (select count(*)::text from public.reservation_session_changes), true
  union all
  select 'AUTORIZACOES_DE_STANDBY',
         (select count(*)::text || ' no total, ' || count(*) filter (where resolved_at is null)::text || ' aberta(s)' from public.reservation_standby),
         true
)
select check_name, result, case when ok then 'OK' else 'FALHOU' end as status from checks
union all
select 'STANDBY_PAINEL_POSTCHECK_OK', (select count(*) filter (where not ok)::text || ' falha(s)' from checks),
       case when (select bool_and(ok) from checks) then 'OK' else 'FALHOU' end;
