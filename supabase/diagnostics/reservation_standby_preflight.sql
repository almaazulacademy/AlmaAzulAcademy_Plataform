-- STAND-BY DE RESERVAS — PREFLIGHT (SOMENTE LEITURA)
--
-- Rodar no SQL Editor ANTES de `202610130001_reservation_status_awaiting_reschedule.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita,
-- nenhuma função nova e nenhum dado pessoal retornado.
--
-- A linha final, STANDBY_PREFLIGHT_OK, só fica OK quando todas as outras estão.
-- Guarde o resultado de RESERVAS_POR_STATUS, EVENTOS_DE_PAGAMENTO e
-- HISTORICO_DE_TROCAS: o postcheck precisa devolver exatamente os mesmos números.
--
-- As sete funções listadas em FUNCOES_A_SUBSTITUIR são as que a migration
-- `202610130002_reservation_standby.sql` substitui. O hash confere que a definição de produção é a do
-- repositório (com quebra de linha LF ou CRLF) — ou seja, que a migration parte
-- do mesmo texto que está em produção e não desfaz nenhuma alteração feita à mão.

with expected(fn, lf, crlf) as (values
    ('admin_base_dashboard_metrics', 'd0810aef3b0c5dfdfee7668b14b251d8', '8faedc9585e9d56069afd30399bf6bee'),
    ('admin_confirm_reservation', '23cffc76bb714a71d9e366cb35c5afc4', 'a353d6fb3eaeaedd743d2509c1e73438'),
    ('admin_dashboard_metrics', '57253206a0cec603628e758389c2e76e', 'db423fdf375cd583709d2fba1eb0d0d2'),
    ('admin_payments_needing_review', '30292197aa7a4daff0c08f3346da0d95', 'ea0fa1bdd27d2ccca51dc4b5163c105f'),
    ('confirm_reservation_payment', '59b8b0454f4d664fb3f9962b59c0c785', '30f81c002df2af368c1962498366535c'),
    ('payment_review_counters', '2641b59a635e3308170801bc20a8faa4', 'f20f7723e322f966b158c68842f30c03'),
    ('reconcile_reservation_payment', '24df22f3f5ed30398f880f2ceed29b19', 'fb8285ebf9703fb5873bd34dd4c505bd')
),
prod as (
  select p.proname as fn, md5(p.prosrc) as h, count(*) over (partition by p.proname) as overloads
  from pg_proc p where p.pronamespace = 'public'::regnamespace
),
functions as (
  select e.fn,
         case when pr.fn is null then 'AUSENTE'
              when pr.overloads > 1 then 'SOBRECARGA'
              when pr.h = e.lf then 'IDENTICA'
              when pr.h = e.crlf then 'IDENTICA_CRLF'
              else 'DIFERENTE' end as verdict
  from expected e left join prod pr on pr.fn = e.fn
),
checks as (
  select 'POSTGRES' as check_name, current_setting('server_version') as result,
         current_setting('server_version_num')::int >= 120000 as ok
  union all
  select 'ENUM_AINDA_SEM_O_STATUS_NOVO',
         (select string_agg(e.enumlabel, ', ' order by e.enumsortorder) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'reservation_status'),
         (select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'reservation_status')
           = array['PRE_RESERVED', 'CONFIRMED', 'EXPIRED', 'CANCELLED']
  union all
  select 'TABELA_DE_STANDBY_AINDA_NAO_EXISTE',
         coalesce(to_regclass('public.reservation_standby')::text, 'ausente'),
         to_regclass('public.reservation_standby') is null
  union all
  select 'FUNCOES_A_SUBSTITUIR',
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions),
         (select bool_and(verdict in ('IDENTICA', 'IDENTICA_CRLF')) from functions)
  union all
  select 'TROCA_ADMINISTRATIVA_PRESENTE',
         (select count(*)::text from pg_proc where pronamespace = 'public'::regnamespace and proname = 'admin_change_reservation_session'),
         (select count(*) = 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'admin_change_reservation_session')
  union all
  select 'CONSTRAINT_DE_SESSOES_DISTINTAS',
         coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.reservation_session_changes'::regclass and conname = 'reservation_session_changes_distinct_sessions'), 'ausente'),
         exists (select 1 from pg_constraint where conrelid = 'public.reservation_session_changes'::regclass and conname = 'reservation_session_changes_distinct_sessions')
  union all
  select 'RESERVATIONS_SEM_ESCRITA_PELA_API_PUBLICA',
         coalesce((select string_agg(grantee || ':' || privilege_type, ', ' order by grantee, privilege_type)
                   from information_schema.role_table_grants
                   where table_schema = 'public' and table_name = 'reservations' and grantee in ('anon', 'authenticated', 'PUBLIC')), 'nenhum grant'),
         not exists (select 1 from information_schema.role_table_grants
                     where table_schema = 'public' and table_name = 'reservations'
                       and grantee in ('anon', 'authenticated', 'PUBLIC') and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'))
  union all
  select 'PGCRYPTO_DISPONIVEL',
         coalesce((select n.nspname from pg_extension x join pg_namespace n on n.oid = x.extnamespace where x.extname = 'pgcrypto'), 'ausente'),
         exists (select 1 from pg_extension x join pg_namespace n on n.oid = x.extnamespace where x.extname = 'pgcrypto' and n.nspname = 'extensions')
  union all
  select 'RESERVAS_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.reservations group by 1) x),
         true
  union all
  select 'EVENTOS_DE_PAGAMENTO', (select count(*)::text from public.payment_events), true
  union all
  select 'HISTORICO_DE_TROCAS', (select count(*)::text from public.reservation_session_changes), true
)
select check_name, result, case when ok then 'OK' else 'FALHOU' end as status from checks
union all
select 'STANDBY_PREFLIGHT_OK', (select count(*) filter (where not ok)::text || ' falha(s)' from checks),
       case when (select bool_and(ok) from checks) then 'OK' else 'FALHOU' end;
