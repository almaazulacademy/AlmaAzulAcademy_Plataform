-- Verificação SOMENTE LEITURA logo após aplicar 202609180001_reservation_checkin.sql.
-- Rode também reservation_checkin_snapshot.sql e compare com o "antes".
-- Todas as colunas "problemas_*" devem ser 0.
select
  (select count(*) from public.reservations where status = 'CONFIRMED' and checkin_token is null) as problemas_confirmada_sem_token,
  (select count(*) from public.reservations where status <> 'CONFIRMED' and checkin_token is not null) as info_nao_confirmada_com_token,
  (select count(*) - count(distinct checkin_token) from public.reservations where checkin_token is not null) as problemas_token_duplicado,
  (select count(*) from public.reservations where checkin_token is not null
     and checkin_token::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') as problemas_token_invalido,
  (select count(*) from public.reservations where checked_in_count is not null or checked_in_at is not null
     or checked_in_by is not null or checkin_method is not null) as problemas_presenca_preenchida,
  (select count(*) from public.reservations where checkin_token is not null) as tokens_criados;

-- Objetos criados
select proname from pg_proc where pronamespace = 'public'::regnamespace and proname in (
  'ensure_reservation_checkin_token','public_checkin_ticket','admin_attendance_sessions','admin_attendance_session',
  'admin_checkin_lookup','admin_register_checkin','admin_reservation_qr_email') order by 1;
select tgname from pg_trigger where tgname = 'reservations_ensure_checkin_token';

-- RPC somente leitura: payload do e-mail agora traz checkinToken (sem enviar nada).
select public.reservation_confirmation_email(id) ? 'checkinToken' as email_tem_token
from public.reservations where status = 'CONFIRMED' limit 1;
