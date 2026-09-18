-- Preflight de 202609200001_instructor_access.sql. Só leitura: rodar ANTES.
-- Esperado: projeto correto; migrations anteriores (check-in e QR em lote)
-- presentes; admin atual ativo com role ADMIN; nada desta migration ainda.

-- 1. Projeto e banco
select current_database() as database, now() as checked_at;

-- 2. Histórico da CLI (vazio se as migrations foram aplicadas pelo SQL Editor)
select to_regclass('supabase_migrations.schema_migrations') as cli_history_table;

-- 3. Migrations anteriores aplicadas (cada linha deve ser true)
select
  to_regclass('public.bases') is not null                                         as multi_base_202609150001,
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'reservations' and column_name = 'checkin_token') as checkin_202609180001,
  to_regprocedure('public.admin_register_checkin(uuid, uuid, integer, text, uuid, boolean)') is not null as checkin_rpc_202609180001,
  to_regprocedure('public.admin_checkin_qr_bulk_claim(uuid, uuid)') is not null   as qr_bulk_202609190001,
  to_regprocedure('public.admin_reservation_qr_email_complete(uuid, uuid)') is not null as qr_email_202609190001;

-- 4. Nada desta migration ainda (cada linha deve ser false)
select
  to_regclass('public.instructor_invites') is not null                  as invites_table_exists,
  to_regprocedure('public.is_active_checkin_staff(uuid)') is not null  as staff_fn_exists,
  exists (select 1 from pg_constraint where conname = 'admin_users_role_allowed') as new_role_check_exists;

-- 5. Contas administrativas (esperado: sua conta, role ADMIN, is_active true)
select au.user_id, u.email, au.display_name, au.role, au.is_active
from public.admin_users au
left join auth.users u on u.id = au.user_id
order by au.role, u.email;

-- 6. Check de role atual (esperado: role IN ('ADMIN','OPERATOR'))
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.admin_users'::regclass and contype = 'c';

-- 7. Corpo atual de is_active_admin (esperado: só is_active, sem role)
select pg_get_functiondef('public.is_active_admin(uuid)'::regprocedure);
