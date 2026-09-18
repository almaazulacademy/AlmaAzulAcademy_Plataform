-- Postcheck de 202609200001_instructor_access.sql. Só leitura.
-- Esperado: todo ADMIN/OPERATOR ativo com admin_ok = true; nenhum INSTRUCTOR
-- com admin_ok = true; nenhuma RPC nova executável por anon/authenticated.

select au.role, au.is_active, u.email,
       public.is_active_admin(au.user_id) as admin_ok,
       public.is_active_checkin_staff(au.user_id) as checkin_ok,
       public.is_active_owner_admin(au.user_id) as team_ok
from public.admin_users au
join auth.users u on u.id = au.user_id
order by au.role, u.email;

select p.proname,
       has_function_privilege('anon', p.oid, 'execute') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (p.proname like 'admin\_%' or p.proname like 'instructor\_%' or p.proname like 'is\_active\_%' or p.proname like 'checkin\_qr\_%')
  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));

select has_table_privilege('authenticated', 'public.instructor_invites', 'select') as authenticated_reads_invites,
       has_table_privilege('authenticated', 'public.admin_users', 'update') as authenticated_updates_admin_users,
       has_table_privilege('authenticated', 'public.admin_users', 'insert') as authenticated_inserts_admin_users;
