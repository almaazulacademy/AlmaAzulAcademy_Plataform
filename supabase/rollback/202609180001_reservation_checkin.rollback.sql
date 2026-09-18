-- =============================================================================
-- ROLLBACK de 202609180001_reservation_checkin.sql — SOMENTE PARA REVISÃO.
-- NÃO EXECUTAR sem decisão explícita. Não está em supabase/migrations/ de
-- propósito, para nenhuma ferramenta aplicá-lo automaticamente.
-- =============================================================================
--
-- O que é PERDIDO se executado (etapa 4):
--   * checkin_token de todas as reservas → os QR Codes já enviados por e-mail
--     deixam de funcionar para sempre. Um novo rollout geraria tokens NOVOS,
--     diferentes dos que os clientes têm.
--   * checked_in_count / checked_in_at / checked_in_by / checkin_method →
--     todo o histórico de presença real (quantas pessoas vieram).
--   * O registro em admin_audit_log (CHECKIN_REGISTERED/UPDATED/UNDONE,
--     CHECKIN_QR_RESENT) NÃO é apagado: continua como trilha histórica.
--
-- O que NÃO é afetado: status, pagamento, quantidade, capacidade, dados de
-- cliente, sessões, experiências. A migration nunca mexeu neles.
--
-- Recomendação: rodar primeiro só as etapas 1–3 (desliga a funcionalidade sem
-- perder dado) e deixar a etapa 4 para depois, com o snapshot da etapa 0.
--
-- Antes: publicar uma versão do app sem a Lista de Presença, ou o painel vai
-- chamar RPCs que deixaram de existir. O e-mail de confirmação continua
-- funcionando: sem o campo checkinToken, ele sai sem a seção do QR.

begin;

-- 0. (Opcional, recomendado) Snapshot dos dados que seriam perdidos.
create table if not exists public.reservation_checkin_rollback_snapshot as
select id as reservation_id, checkin_token, checked_in_count, checked_in_at, checked_in_by, checkin_method, now() as snapshot_at
from public.reservations
where checkin_token is not null or checked_in_count is not null;

-- 1. Restaura o payload do e-mail de confirmação exatamente como em
--    202608190001_reservation_confirmation_email.sql (sem checkinToken).
create or replace function public.reservation_confirmation_email(p_reservation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'reservationId', r.id,
    'publicCode', r.public_code,
    'fullName', r.full_name,
    'email', r.email,
    'quantity', r.quantity,
    'status', r.status,
    'experienceTitle', e.title,
    'startsAt', s.starts_at
  )
  from public.reservations r
  join public.sessions s on s.id = r.session_id
  join public.experiences e on e.id = r.experience_id
  where r.id = p_reservation_id
    and r.status = 'CONFIRMED';
$$;
revoke all on function public.reservation_confirmation_email(uuid) from public, anon, authenticated;
grant execute on function public.reservation_confirmation_email(uuid) to service_role;

-- 2. Remove as funções novas (nenhum outro objeto depende delas).
drop function if exists public.admin_reservation_qr_email(uuid, uuid);
drop function if exists public.admin_register_checkin(uuid, uuid, integer, text, uuid, boolean);
drop function if exists public.admin_checkin_lookup(uuid, uuid, uuid);
drop function if exists public.admin_attendance_session(uuid, uuid);
drop function if exists public.admin_attendance_sessions(uuid, date);
drop function if exists public.public_checkin_ticket(uuid);

-- 3. Para de gerar tokens em novas confirmações.
drop trigger if exists reservations_ensure_checkin_token on public.reservations;
drop function if exists public.ensure_reservation_checkin_token();

-- 4. DESTRUTIVO — apaga tokens e presença (ver "O que é PERDIDO" acima).
--    Comentado de propósito. Descomente só com decisão explícita.
-- drop index if exists public.reservations_checkin_token_key;
-- alter table public.reservations drop constraint if exists reservations_checked_in_count_range;
-- alter table public.reservations drop constraint if exists reservations_checkin_method_check;
-- alter table public.reservations drop column if exists checkin_method;
-- alter table public.reservations drop column if exists checked_in_by;
-- alter table public.reservations drop column if exists checked_in_at;
-- alter table public.reservations drop column if exists checked_in_count;
-- alter table public.reservations drop column if exists checkin_token;

commit;
