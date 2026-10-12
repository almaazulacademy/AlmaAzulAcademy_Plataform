-- STAND-BY DE RESERVAS — POSTCHECK (SOMENTE LEITURA)
--
-- Rodar no SQL Editor DEPOIS de `202610130002_reservation_standby.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita e
-- nenhum dado pessoal retornado.
--
-- A linha final, STANDBY_POSTCHECK_OK, só fica OK quando todas as outras estão.
-- RESERVAS_POR_STATUS, EVENTOS_DE_PAGAMENTO e HISTORICO_DE_TROCAS precisam
-- devolver os mesmos números do preflight (fora o que aconteceu de verdade no
-- site entre as duas execuções): a migration não toca nenhuma linha.

with expected(fn, lf, crlf) as (values
    ('admin_base_dashboard_metrics', '8a5eab456a1583d67b781f21197aef47', 'e82ff2b4da8a910b237713e37db8a1fa'),
    ('admin_confirm_reservation', '9ebf28fe299008479473381df4d8477b', '906432e8a0afaf41522b5b051fd9c861'),
    ('admin_dashboard_metrics', 'b2dc026158461d9757f493527c187c5b', 'a0a939575631a6ddbaac5271a1d9c378'),
    ('admin_generate_reservation_standby_link', '3c0797cd2a4b43b58530ce12ef7a9ef6', '51c8f6621cfddefd77a43090f44a0973'),
    ('admin_list_standby_reservations', '40ecc499547bd64fd02559868dbcdcd0', 'f67a475c81e7fbad6d0225245374f17e'),
    ('admin_payments_needing_review', 'fdf87eea92f5b9b10a79b2116edb89c4', '54878877b393ae69a4ab32af2b840b87'),
    ('admin_reschedule_reservation_from_standby', '42bbaea1abbad4dc11e258ce4aa67762', '43eb10503558dc6dd418514fba04aa60'),
    ('admin_revoke_reservation_standby_link', 'bb808c3c16195ca65ffa5cb1bcdbc393', '4770fc50bcc1ee0772eda0fb8837156a'),
    ('admin_set_reservation_standby', '08773c0703c57e803507cd2e0121f540', '165a3ab660bc3ada72a8ec20d0239708'),
    ('admin_undo_reservation_standby', '157d86d7522469542cea6c9069ae451a', '020ddba4cc9f4931c0f1e3a74e634460'),
    ('confirm_reservation_payment', '706f067a9b6c531f2bffca2fb828bbea', 'bbf12e8e7a07902f81528d9b0e0cafe2'),
    ('customer_reschedule_options', '9cb629730d6b1aa3da298647d1d4774a', 'a4571a2eaf512bf0dfdc1ddeefaea611'),
    ('customer_reschedule_reservation', '527e7caf2007bf809cf0a0f9070e293a', 'd833e59a4018a1e0810c6cd5aab6bb6e'),
    ('enforce_reservation_standby_transition', '913e94c18fffabc7f7ebd4723c4811b4', 'e7b44ade3f2e1e95e41d54a96ad23656'),
    ('payment_review_counters', 'af9108833ac7b9dbf70d2fd101884e08', '51c8cb67c2a8c14c362733e2feb5ec92'),
    ('reconcile_reservation_payment', '4a0d76110a898481ebdc8a9cbc16c7e9', '58ea3dbec2585409460a130dfa30ef23'),
    ('reservation_has_confirmed_payment', '8bd1a806fbf40089896c12d57152fc23', '0d372a2d01444ceadc5d07d37c0b051a'),
    ('reservation_latest_standby', '769baa3c30a33be6bce7f708e0bb0841', '51d73805e9495a5f1de6a016644c8af4'),
    ('reservation_standby_access', '18f750997161dcb9c104ac19623baab1', '9d58f2ff097cbf9b7384781dfc1e68ec'),
    ('reservation_standby_resolve', 'ee2c16b8a8e2960656a6eb45c8021924', '0d0eef68e34f06f31639971e8c4e9fdb'),
    ('reservation_standby_result', '68a62665d59d33b85bf72bf705d06216', '407d1a7e63a28c38e41b0786863cc604'),
    ('reservation_standby_target_rejection', '202b1b5e84a5e0b387bfd94b1e4ed6e4', '958d5d630c0d8d5af66278a9ff571721')
),
prod as (
  select p.oid, p.proname as fn, md5(p.prosrc) as h, p.prosecdef, p.proconfig,
         count(*) over (partition by p.proname) as overloads
  from pg_proc p where p.pronamespace = 'public'::regnamespace
),
functions as (
  select e.fn, pr.oid, pr.prosecdef, pr.proconfig,
         case when pr.fn is null then 'AUSENTE'
              when pr.overloads > 1 then 'SOBRECARGA'
              when pr.h = e.lf then 'IDENTICA'
              when pr.h = e.crlf then 'IDENTICA_CRLF'
              else 'DIFERENTE' end as verdict
  from expected e left join prod pr on pr.fn = e.fn
),
checks as (
  select 'ENUM_COM_O_STATUS_NOVO' as check_name,
         (select string_agg(e.enumlabel, ', ' order by e.enumsortorder) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'reservation_status') as result,
         exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'reservation_status' and e.enumlabel = 'AWAITING_RESCHEDULE') as ok
  union all
  select 'FUNCOES_COM_A_DEFINICAO_DO_REPOSITORIO',
         coalesce((select string_agg(fn || '=' || verdict, ', ' order by fn) from functions where verdict not in ('IDENTICA', 'IDENTICA_CRLF')), 'todas as ' || (select count(*) from functions) || ' idênticas'),
         (select bool_and(verdict in ('IDENTICA', 'IDENTICA_CRLF')) from functions)
  union all
  select 'FUNCOES_SECURITY_DEFINER_COM_SEARCH_PATH',
         coalesce((select string_agg(fn, ', ' order by fn) from functions
                   where not prosecdef or proconfig is null or not exists (select 1 from unnest(proconfig) c where c like 'search_path=%')), 'todas'),
         not exists (select 1 from functions where not prosecdef or proconfig is null or not exists (select 1 from unnest(proconfig) c where c like 'search_path=%'))
  union all
  select 'NENHUMA_FUNCAO_EXECUTAVEL_PELA_API_PUBLICA',
         coalesce((select string_agg(fn, ', ' order by fn) from functions
                   where has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE')), 'nenhuma'),
         not exists (select 1 from functions where has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE'))
  union all
  select 'INTERNAS_FORA_DO_ALCANCE_DA_SERVICE_ROLE',
         coalesce((select string_agg(fn, ', ' order by fn) from functions
                   where fn in ('enforce_reservation_standby_transition', 'reservation_has_confirmed_payment', 'reservation_standby_target_rejection', 'reservation_standby_result', 'reservation_standby_resolve', 'reservation_standby_access', 'reservation_latest_standby') and has_function_privilege('service_role', oid, 'EXECUTE')), 'nenhuma exposta'),
         not exists (select 1 from functions where fn in ('enforce_reservation_standby_transition', 'reservation_has_confirmed_payment', 'reservation_standby_target_rejection', 'reservation_standby_result', 'reservation_standby_resolve', 'reservation_standby_access', 'reservation_latest_standby') and has_function_privilege('service_role', oid, 'EXECUTE'))
  union all
  select 'RPCS_DO_SERVIDOR_EXECUTAVEIS_PELA_SERVICE_ROLE',
         (select count(*)::text from functions where fn in ('admin_set_reservation_standby', 'admin_undo_reservation_standby', 'admin_reschedule_reservation_from_standby', 'admin_list_standby_reservations', 'admin_generate_reservation_standby_link', 'admin_revoke_reservation_standby_link', 'customer_reschedule_options', 'customer_reschedule_reservation') and has_function_privilege('service_role', oid, 'EXECUTE')),
         (select count(*) = 8 from functions where fn in ('admin_set_reservation_standby', 'admin_undo_reservation_standby', 'admin_reschedule_reservation_from_standby', 'admin_list_standby_reservations', 'admin_generate_reservation_standby_link', 'admin_revoke_reservation_standby_link', 'customer_reschedule_options', 'customer_reschedule_reservation') and has_function_privilege('service_role', oid, 'EXECUTE'))
  union all
  select 'TABELA_COM_RLS_E_SEM_POLICY',
         (select 'rls=' || c.relrowsecurity || ', policies=' || (select count(*) from pg_policies where schemaname = 'public' and tablename = 'reservation_standby')
          from pg_class c where c.oid = 'public.reservation_standby'::regclass),
         (select c.relrowsecurity from pg_class c where c.oid = 'public.reservation_standby'::regclass)
           and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'reservation_standby')
  union all
  select 'TABELA_SEM_ACESSO_PELA_API_PUBLICA',
         coalesce((select string_agg(grantee || ':' || privilege_type, ', ' order by grantee, privilege_type)
                   from information_schema.role_table_grants where table_schema = 'public' and table_name = 'reservation_standby'
                     and grantee in ('anon', 'authenticated', 'PUBLIC', 'service_role')), 'nenhum grant'),
         not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name = 'reservation_standby'
                       and (grantee in ('anon', 'authenticated', 'PUBLIC') or (grantee = 'service_role' and privilege_type <> 'SELECT')))
  union all
  select 'TRIGGER_DA_INVARIANTE_ATIVA',
         coalesce((select tgenabled::text from pg_trigger where tgrelid = 'public.reservations'::regclass and tgname = 'reservations_standby_guard'), 'ausente'),
         exists (select 1 from pg_trigger where tgrelid = 'public.reservations'::regclass and tgname = 'reservations_standby_guard' and tgenabled = 'O')
  union all
  select 'UMA_AUTORIZACAO_ABERTA_POR_RESERVA',
         coalesce((select indexdef from pg_indexes where schemaname = 'public' and indexname = 'reservation_standby_one_open_per_reservation'), 'ausente'),
         exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'reservation_standby_one_open_per_reservation' and indexdef like 'CREATE UNIQUE INDEX%')
  union all
  select 'NENHUMA_RESERVA_EM_STANDBY',
         (select count(*)::text from public.reservations where status = 'AWAITING_RESCHEDULE') || ' reserva(s), ' || (select count(*)::text from public.reservation_standby) || ' autorização(ões)',
         (select count(*) = 0 from public.reservations where status = 'AWAITING_RESCHEDULE') and (select count(*) = 0 from public.reservation_standby)
  union all
  select 'HISTORICO_ANTERIOR_DESCRITO_COMO_TROCA_DIRETA',
         (select count(*)::text || ' linha(s), ' || count(*) filter (where actor_type = 'ADMIN' and origin = 'DIRECT' and standby_id is null)::text || ' diretas' from public.reservation_session_changes),
         (select coalesce(bool_and(actor_type = 'ADMIN' and origin = 'DIRECT' and standby_id is null), true) from public.reservation_session_changes)
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
select 'STANDBY_POSTCHECK_OK', (select count(*) filter (where not ok)::text || ' falha(s)' from checks),
       case when (select bool_and(ok) from checks) then 'OK' else 'FALHOU' end;
