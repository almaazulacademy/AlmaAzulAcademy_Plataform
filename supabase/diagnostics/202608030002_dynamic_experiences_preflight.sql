-- Read-only preflight for Sprint 5.2 dynamic experiences.
-- This file contains SELECT statements only and does not change the database.

select
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'experiences'
      and column_name = 'editorial_content'
  ) as editorial_content_exists,
  (
    select data_type
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'experiences'
      and column_name = 'editorial_content'
  ) as editorial_content_data_type,
  (
    select is_nullable
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'experiences'
      and column_name = 'editorial_content'
  ) as editorial_content_is_nullable,
  (
    select column_default
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'experiences'
      and column_name = 'editorial_content'
  ) as editorial_content_default;

with expected_functions(function_name) as (
  values
    ('admin_create_experience'),
    ('admin_update_experience'),
    ('admin_list_experiences'),
    ('get_public_experience'),
    ('list_public_experiences'),
    ('experience_editorial_is_publishable')
)
select
  expected.function_name,
  proc.oid is not null as function_exists,
  pg_get_function_identity_arguments(proc.oid) as identity_arguments,
  pg_get_function_result(proc.oid) as result_type,
  lang.lanname as language,
  proc.prosecdef as security_definer,
  proc.provolatile as volatility,
  proc.proconfig as function_settings,
  proc.proacl as explicit_acl,
  case when proc.oid is null then null else has_function_privilege('anon', proc.oid, 'EXECUTE') end as anon_can_execute,
  case when proc.oid is null then null else has_function_privilege('authenticated', proc.oid, 'EXECUTE') end as authenticated_can_execute,
  case when proc.oid is null then null else has_function_privilege('service_role', proc.oid, 'EXECUTE') end as service_role_can_execute
from expected_functions expected
left join pg_namespace ns
  on ns.nspname = 'public'
left join pg_proc proc
  on proc.pronamespace = ns.oid
 and proc.proname = expected.function_name
left join pg_language lang
  on lang.oid = proc.prolang
order by expected.function_name, identity_arguments;
