-- DESTRUCTIVE MAINTENANCE: CLEAR APPROVED TEST RESERVATIONS BEFORE LAUNCH
-- NEVER run from migrations, deploy or CI. Run manually only after:
--   1. preflight reviewed and archived;
--   2. local encrypted backup completed and verified;
--   3. any payment evidence reconciled as test data;
--   4. a maintenance window blocks new booking attempts.
-- This script makes no HTTP requests and cannot trigger provider, e-mail,
-- WhatsApp, notification, cancellation or refund actions.

begin;

-- SAFETY GATES: edit only the values on this row after manual approval.
-- Keep both booleans false in version control.
create temporary table _prelaunch_cleanup_config on commit drop as
select
  false::boolean as confirm_delete_test_reservations,
  false::boolean as confirm_all_payment_evidence_is_test,
  null::timestamptz as approved_test_data_cutoff;

do $guard$
declare
  config record;
  unexpected_dependencies text;
begin
  select * into config from _prelaunch_cleanup_config;

  if to_regclass('public.reservations') is null
     or to_regclass('public.payment_events') is null
     or to_regclass('public.admin_audit_log') is null
     or to_regclass('public.sessions') is null
     or to_regclass('public.experiences') is null
     or to_regclass('public.admin_users') is null
     or to_regclass('public.platform_settings') is null then
    raise exception 'EXPECTED_ALMA_AZUL_SCHEMA_NOT_FOUND';
  end if;

  if not exists (
    select 1
    from public.platform_settings
    where singleton is true and company_name ilike 'Alma Azul%'
  ) then
    raise exception 'ALMA_AZUL_PROJECT_MARKER_NOT_FOUND';
  end if;

  if (
    select count(*)
    from public.experiences
    where slug in ('imersao-paranoa', 'remada-sunset', 'remada-nascer-do-sol', 'remada-lua-cheia')
  ) <> 4 then
    raise exception 'EXPECTED_EXPERIENCE_SET_NOT_FOUND';
  end if;

  select string_agg(format('%I.%I(%I)', tc.table_schema, tc.table_name, kcu.column_name), ', ' order by tc.table_schema, tc.table_name)
  into unexpected_dependencies
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
    and ccu.table_schema = 'public'
    and ccu.table_name = 'reservations'
    and not (
      tc.table_schema = 'public'
      and tc.table_name = 'payment_events'
      and kcu.column_name = 'reservation_id'
    );

  if unexpected_dependencies is not null then
    raise exception using
      message = 'UNEXPECTED_RESERVATION_DEPENDENCIES',
      detail = unexpected_dependencies,
      hint = 'Review the preflight FK inventory and add an explicit deletion strategy. Do not use CASCADE.';
  end if;

  if not config.confirm_delete_test_reservations then
    raise exception using
      message = 'DELETE_GATE_IS_FALSE',
      hint = 'After preflight, backup and approval, change confirm_delete_test_reservations to true.';
  end if;

  if config.approved_test_data_cutoff is null then
    raise exception using
      message = 'APPROVED_TEST_DATA_CUTOFF_REQUIRED',
      hint = 'Copy the reviewed max reservations.created_at from preflight into approved_test_data_cutoff.';
  end if;
end;
$guard$;

-- Prevent a new booking or webhook row from appearing after approval checks.
lock table public.reservations, public.payment_events, public.admin_audit_log in access exclusive mode;

do $financial_guard$
declare
  config record;
  payment_evidence_count bigint;
begin
  select * into config from _prelaunch_cleanup_config;

  if exists (
    select 1 from public.reservations where created_at > config.approved_test_data_cutoff
  ) then
    raise exception using
      message = 'RESERVATIONS_CREATED_AFTER_APPROVED_CUTOFF',
      hint = 'Stop. Re-run preflight, review the new rows and create a fresh backup.';
  end if;

  select
    (select count(*) from public.payment_events)
    + (select count(*) from public.reservations
       where status = 'CONFIRMED'
          or confirmed_at is not null
          or payment_provider is not null
          or provider_reference is not null
          or checkout_url is not null)
  into payment_evidence_count;

  if payment_evidence_count > 0 and not config.confirm_all_payment_evidence_is_test then
    raise exception using
      message = 'PAYMENT_EVIDENCE_REQUIRES_MANUAL_CONFIRMATION',
      detail = format('%s aggregate payment indicators were found.', payment_evidence_count),
      hint = 'Reconcile them without invoking provider APIs. Only after proof that every record is test data, change confirm_all_payment_evidence_is_test to true.';
  end if;
end;
$financial_guard$;

create temporary table _prelaunch_target_reservations on commit drop as
select id from public.reservations;

create temporary table _prelaunch_before_counts on commit drop as
select
  (select count(*) from _prelaunch_target_reservations) as reservations,
  (select coalesce(sum(quantity), 0) from public.reservations) as participants,
  (select count(*) from public.reservations where status = 'PRE_RESERVED' and expires_at > now()) as active_holds,
  (select count(*) from public.reservations where status = 'PRE_RESERVED' and expires_at <= now()) as expired_holds,
  (select count(*) from public.payment_events) as payment_events,
  (select count(*) from public.admin_audit_log where upper(entity_type) = 'RESERVATION' or action like 'RESERVATION_%') as reservation_audit_rows;

select * from _prelaunch_before_counts;

-- Explicit deletion order. No DROP, no CASCADE and no sequence/UUID reset.
delete from public.admin_audit_log
where upper(entity_type) = 'RESERVATION'
   or action like 'RESERVATION_%';

delete from public.payment_events
where reservation_id in (select id from _prelaunch_target_reservations);

delete from public.reservations
where id in (select id from _prelaunch_target_reservations);

do $verify$
begin
  if exists (select 1 from public.reservations) then
    raise exception 'RESERVATIONS_REMAIN_AFTER_DELETE';
  end if;
  if exists (select 1 from public.payment_events) then
    raise exception 'PAYMENT_EVENTS_REMAIN_AFTER_DELETE';
  end if;
  if exists (
    select 1 from public.admin_audit_log
    where upper(entity_type) = 'RESERVATION' or action like 'RESERVATION_%'
  ) then
    raise exception 'RESERVATION_AUDIT_ROWS_REMAIN_AFTER_DELETE';
  end if;
end;
$verify$;

select
  (select count(*) from public.reservations) as reservations_after,
  (select count(*) from public.payment_events) as payment_events_after,
  (select count(*) from public.admin_audit_log where upper(entity_type) = 'RESERVATION' or action like 'RESERVATION_%') as reservation_audit_rows_after,
  (select count(*) from public.experiences) as experiences_preserved,
  (select count(*) from public.sessions) as sessions_preserved,
  (select count(*) from public.admin_users) as admin_users_preserved,
  (select count(*) from auth.users) as auth_users_preserved,
  (select count(*) from public.platform_settings) as platform_settings_preserved;

-- For a rehearsal, replace COMMIT with ROLLBACK before running the whole file.
commit;
