-- =============================================================================
-- ROLLBACK de 202609200001_instructor_access.sql — SOMENTE PARA REVISÃO.
-- NÃO EXECUTAR sem decisão explícita. Não está em supabase/migrations/ de
-- propósito, para nenhuma ferramenta aplicá-lo automaticamente.
-- =============================================================================
--
-- ORDEM IMPORTA. A versão antiga de `is_active_admin` só olha `is_active`:
-- restaurá-la com instrutores ativos daria a eles acesso a TODAS as RPCs
-- administrativas. Por isso a etapa 1 desativa os instrutores antes de tudo.
--
-- Antes: publicar uma versão do app sem /instrutor e sem /admin/equipe.
-- Não perde: reservas, presença registrada, auditoria. Os usuários de Auth dos
-- instrutores continuam existindo (sem acesso a nada).

begin;

-- 1. Instrutores sem acesso, antes de afrouxar qualquer checagem.
update public.admin_users set is_active = false where role = 'INSTRUCTOR';

-- 2. Remove o que é exclusivo desta migration.
drop function if exists public.admin_set_instructor_active(uuid, uuid, boolean);
drop function if exists public.admin_list_instructors(uuid);
drop function if exists public.instructor_invite_claim(text, uuid, text);
drop function if exists public.instructor_invite_status(text);
drop function if exists public.admin_revoke_instructor_invite(uuid, uuid);
drop function if exists public.admin_create_instructor_invite(uuid, text, integer);
drop function if exists public.instructor_invite_state(public.instructor_invites);
drop table if exists public.instructor_invites;

-- 3. Reaplicar as RPCs de check-in de 202609180001 (etapas 6 a 9 daquele
--    arquivo) para voltarem a usar is_active_admin, e depois:
-- drop function if exists public.is_active_checkin_staff(uuid);
-- drop function if exists public.is_active_owner_admin(uuid);

-- 4. Opcional e só depois de confirmar a etapa 1: remover as linhas INSTRUCTOR
--    e voltar o check de role ao original.
-- delete from public.admin_users where role = 'INSTRUCTOR';
-- alter table public.admin_users drop constraint admin_users_role_allowed;
-- alter table public.admin_users add constraint admin_users_role_check check (role in ('ADMIN', 'OPERATOR'));

commit;
