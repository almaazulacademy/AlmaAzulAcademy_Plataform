-- PRE-LAUNCH RESERVATION PREFLIGHT (READ ONLY)
-- Run manually in the intended Supabase project before any backup or cleanup.
-- This script returns only aggregates, schema metadata and technical session IDs.
-- It never returns names, CPF hashes, phone numbers, e-mails, tokens, checkout URLs,
-- provider references, receipt URLs or payment payloads.

select
  current_database() as database_name,
  current_user as database_user,
  now() as checked_at,
  (select company_name from public.platform_settings where singleton is true) as company_marker,
  (select count(*) from public.experiences) as experiences_preserved,
  (select count(*) from public.sessions) as sessions_preserved,
  (select count(*) from public.admin_users) as admin_users_preserved;

select
  object_kind,
  object_name,
  purpose,
  cleanup_action
from (values
  ('TABLE', 'public.reservations', 'Reservas, participantes agregados, holds, checkout e dados pessoais', 'DELETE'),
  ('TABLE', 'public.payment_events', 'Eventos financeiros/webhooks ligados a reservas', 'DELETE_AFTER_PAYMENT_REVIEW'),
  ('TABLE', 'public.admin_audit_log', 'Ações administrativas; somente linhas de reserva serão removidas', 'DELETE_RESERVATION_ROWS_ONLY'),
  ('TABLE', 'public.experiences', 'Catálogo e conteúdo editorial', 'PRESERVE'),
  ('TABLE', 'public.sessions', 'Datas, preços e capacidades', 'PRESERVE'),
  ('TABLE', 'public.admin_users', 'Contas administrativas', 'PRESERVE'),
  ('TABLE', 'auth.users', 'Autenticação', 'PRESERVE'),
  ('TABLE', 'public.platform_settings', 'Configurações e integrações', 'PRESERVE'),
  ('FUNCTION', 'public.expire_pre_reservations()', 'Expiração dos holds armazenados em reservations', 'PRESERVE'),
  ('FUNCTION', 'public.available_spots(uuid)', 'Vagas derivadas de capacidade menos reservas válidas', 'PRESERVE'),
  ('FUNCTION', 'public.create_pre_reservation(...)', 'Criação de pré-reserva', 'PRESERVE'),
  ('FUNCTION', 'public.attach_payment_checkout(...)', 'Vínculo de checkout', 'PRESERVE'),
  ('FUNCTION', 'public.confirm_reservation_payment(...)', 'Confirmação financeira', 'PRESERVE'),
  ('FUNCTION', 'public.lookup_reservation(...)', 'Acompanhamento de reserva', 'PRESERVE'),
  ('FUNCTION', 'public.admin_list_reservations(...)', 'Painel administrativo', 'PRESERVE')
) as inventory(object_kind, object_name, purpose, cleanup_action)
order by object_kind, object_name;

-- Real foreign keys and ON DELETE rules. Any unexpected table referencing reservations
-- must be reviewed and added explicitly to the maintenance script before cleanup.
select
  tc.table_schema,
  tc.table_name,
  kcu.column_name,
  ccu.table_schema as referenced_schema,
  ccu.table_name as referenced_table,
  ccu.column_name as referenced_column,
  rc.delete_rule
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on kcu.constraint_catalog = tc.constraint_catalog
 and kcu.constraint_schema = tc.constraint_schema
 and kcu.constraint_name = tc.constraint_name
join information_schema.referential_constraints rc
  on rc.constraint_catalog = tc.constraint_catalog
 and rc.constraint_schema = tc.constraint_schema
 and rc.constraint_name = tc.constraint_name
join information_schema.constraint_column_usage ccu
  on ccu.constraint_catalog = rc.unique_constraint_catalog
 and ccu.constraint_schema = rc.unique_constraint_schema
 and ccu.constraint_name = rc.unique_constraint_name
where tc.constraint_type = 'FOREIGN KEY'
  and (
    tc.table_name in ('reservations', 'payment_events')
    or ccu.table_name in ('reservations', 'payment_events')
  )
order by tc.table_schema, tc.table_name, kcu.column_name;

-- Views and RPCs that read or mutate the reservation flow. Definitions are not returned.
select 'VIEW' as object_kind, schemaname as object_schema, viewname as object_name
from pg_views
where schemaname not in ('pg_catalog', 'information_schema')
  and definition ~* '\m(reservations|payment_events)\M'
union all
select 'FUNCTION', n.nspname, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and pg_get_functiondef(p.oid) ~* '\m(reservations|payment_events)\M'
order by object_kind, object_schema, object_name;

select 'reservations' as relation_name, count(*) as row_count, min(created_at) as oldest_at, max(created_at) as newest_at
from public.reservations
union all
select 'payment_events', count(*), min(processed_at), max(processed_at)
from public.payment_events
union all
select 'reservation_admin_audit', count(*), min(created_at), max(created_at)
from public.admin_audit_log
where upper(entity_type) = 'RESERVATION' or action like 'RESERVATION_%'
order by relation_name;

select status, count(*) as reservation_count, coalesce(sum(quantity), 0) as participant_count
from public.reservations
group by status
order by status;

select
  count(*) as total_reservations,
  coalesce(sum(quantity), 0) as total_participants,
  count(*) filter (where status = 'PRE_RESERVED' and expires_at > now()) as active_holds,
  count(*) filter (where status = 'PRE_RESERVED' and expires_at <= now()) as expired_holds_not_yet_marked,
  count(*) filter (where status = 'EXPIRED') as expired_reservations,
  count(*) filter (where status = 'CONFIRMED') as confirmed_reservations,
  count(*) filter (where status = 'CANCELLED') as cancelled_reservations,
  count(*) filter (where status = 'PRE_RESERVED') as pending_reservations
from public.reservations;

select
  e.slug as experience_slug,
  count(r.id) as reservation_count,
  coalesce(sum(r.quantity), 0) as participant_count
from public.experiences e
left join public.reservations r on r.experience_id = e.id
group by e.id, e.slug
order by e.slug;

select
  s.id as session_id,
  e.slug as experience_slug,
  s.starts_at,
  count(r.id) as reservation_count,
  coalesce(sum(r.quantity), 0) as participant_count,
  s.capacity,
  s.price_cents
from public.sessions s
join public.experiences e on e.id = s.experience_id
left join public.reservations r on r.session_id = s.id
group by s.id, e.slug, s.starts_at, s.capacity, s.price_cents
order by s.starts_at, s.id;

select
  provider,
  event_type,
  count(*) as event_count,
  coalesce(sum(amount_cents), 0) as amount_cents_total,
  min(processed_at) as oldest_at,
  max(processed_at) as newest_at
from public.payment_events
group by provider, event_type
order by provider, event_type;

-- Payment review gate. Any nonzero value requires reconciliation outside this script.
-- Do not activate the maintenance script until every flagged record is proved to be test data.
select
  count(*) filter (where status = 'CONFIRMED' or confirmed_at is not null) as confirmed_reservation_evidence,
  count(*) filter (where payment_provider is not null) as reservations_with_payment_provider,
  count(*) filter (where provider_reference is not null) as reservations_with_provider_reference,
  count(*) filter (where checkout_url is not null) as reservations_with_checkout,
  (select count(*) from public.payment_events) as payment_event_count,
  (select count(*) from public.payment_events where event_type in ('PAYMENT_CONFIRMED', 'PAYMENT_CONFIRMED_MANUAL', 'PAYMENT_AFTER_EXPIRATION')) as payment_confirmation_evidence,
  case
    when count(*) filter (where status = 'CONFIRMED' or confirmed_at is not null or payment_provider is not null or provider_reference is not null or checkout_url is not null) = 0
     and not exists (select 1 from public.payment_events)
      then 'NO_PAYMENT_EVIDENCE_FOUND'
    else 'MANUAL_FINANCIAL_REVIEW_REQUIRED'
  end as payment_review_status
from public.reservations;

select action, count(*) as audit_row_count, min(created_at) as oldest_at, max(created_at) as newest_at
from public.admin_audit_log
where upper(entity_type) = 'RESERVATION' or action like 'RESERVATION_%'
group by action
order by action;

-- Replace NULL below with the official operation start timestamp before approval.
-- The query intentionally cannot assert that all rows are tests while the date is NULL.
with config as (
  select null::timestamptz as official_operation_started_at
)
select
  official_operation_started_at,
  case
    when official_operation_started_at is null then null
    else (select count(*) from public.reservations where created_at >= official_operation_started_at)
  end as reservations_created_after_operation_start,
  case
    when official_operation_started_at is null then 'CONFIGURE_OFFICIAL_OPERATION_START_AND_RERUN'
    when exists (select 1 from public.reservations where created_at >= official_operation_started_at) then 'MANUAL_RESERVATION_REVIEW_REQUIRED'
    else 'NO_RESERVATIONS_AFTER_OPERATION_START'
  end as operation_start_review_status
from config;

-- Preserve this fingerprint with the backup evidence and compare it to postcheck output.
select
  (select count(*) from public.experiences) as experience_count,
  (select count(*) from public.sessions) as session_count,
  (select count(*) from public.admin_users) as admin_user_count,
  (select count(*) from auth.users) as auth_user_count,
  (select count(*) from public.platform_settings) as platform_settings_count,
  (select md5(coalesce(string_agg(id::text || ':' || slug || ':' || status || ':' || coalesce(price_cents::text, '') || ':' || coalesce(default_capacity::text, ''), '|' order by id), '')) from public.experiences) as experiences_fingerprint,
  (select md5(coalesce(string_agg(id::text || ':' || experience_id::text || ':' || starts_at::text || ':' || price_cents::text || ':' || capacity::text || ':' || status::text, '|' order by id), '')) from public.sessions) as sessions_fingerprint,
  (select md5(coalesce(string_agg(user_id::text || ':' || role || ':' || is_active::text, '|' order by user_id), '')) from public.admin_users) as admin_users_fingerprint;
