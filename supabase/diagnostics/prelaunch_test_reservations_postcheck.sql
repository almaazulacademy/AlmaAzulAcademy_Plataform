-- PRE-LAUNCH RESERVATION POSTCHECK (READ ONLY)
-- Run only after the maintenance transaction commits.
-- Compare the three fingerprints with the archived preflight output.

select
  (select count(*) from public.reservations) as reservations_expected_zero,
  (select coalesce(sum(quantity), 0) from public.reservations) as participants_expected_zero,
  (select count(*) from public.reservations where status = 'PRE_RESERVED') as holds_expected_zero,
  (select count(*) from public.payment_events) as payment_events_expected_zero,
  (select count(*) from public.admin_audit_log where upper(entity_type) = 'RESERVATION' or action like 'RESERVATION_%') as reservation_audit_rows_expected_zero;

select
  count(*) filter (where status = 'PRE_RESERVED' and expires_at > now()) as active_holds_expected_zero,
  count(*) filter (where status = 'PRE_RESERVED' and expires_at <= now()) as expired_holds_expected_zero,
  count(*) filter (where status = 'CONFIRMED') as confirmed_expected_zero,
  count(*) filter (where status = 'CANCELLED') as cancelled_expected_zero,
  count(*) filter (where status = 'EXPIRED') as expired_expected_zero
from public.reservations;

select
  (select count(*) from public.experiences) as experience_count,
  (select count(*) from public.sessions) as session_count,
  (select count(*) from public.admin_users) as admin_user_count,
  (select count(*) from auth.users) as auth_user_count,
  (select count(*) from public.platform_settings) as platform_settings_count,
  (select md5(coalesce(string_agg(id::text || ':' || slug || ':' || status || ':' || coalesce(price_cents::text, '') || ':' || coalesce(default_capacity::text, ''), '|' order by id), '')) from public.experiences) as experiences_fingerprint,
  (select md5(coalesce(string_agg(id::text || ':' || experience_id::text || ':' || starts_at::text || ':' || price_cents::text || ':' || capacity::text || ':' || status::text, '|' order by id), '')) from public.sessions) as sessions_fingerprint,
  (select md5(coalesce(string_agg(user_id::text || ':' || role || ':' || is_active::text, '|' order by user_id), '')) from public.admin_users) as admin_users_fingerprint;

select
  e.slug as experience_slug,
  s.id as session_id,
  s.starts_at,
  s.price_cents,
  s.capacity,
  public.available_spots(s.id) as available_spots,
  case when public.available_spots(s.id) = s.capacity then 'FULL_CAPACITY_AVAILABLE' else 'REVIEW_REQUIRED' end as availability_status
from public.sessions s
join public.experiences e on e.id = s.experience_id
order by s.starts_at, s.id;

select orphan_check, orphan_count
from (
  select 'reservations_without_experience' as orphan_check, count(*) as orphan_count
  from public.reservations r left join public.experiences e on e.id = r.experience_id
  where e.id is null
  union all
  select 'reservations_without_session', count(*)
  from public.reservations r left join public.sessions s on s.id = r.session_id
  where s.id is null
  union all
  select 'payment_events_without_reservation', count(*)
  from public.payment_events pe left join public.reservations r on r.id = pe.reservation_id
  where r.id is null
  union all
  select 'sessions_without_experience', count(*)
  from public.sessions s left join public.experiences e on e.id = s.experience_id
  where e.id is null
) checks
order by orphan_check;

select
  case
    when exists (select 1 from public.reservations)
      or exists (select 1 from public.payment_events)
      or exists (
        select 1 from public.admin_audit_log
        where upper(entity_type) = 'RESERVATION' or action like 'RESERVATION_%'
      )
      then 'POSTCHECK_FAILED'
    when exists (
      select 1 from public.sessions where public.available_spots(id) <> capacity
    )
      then 'POSTCHECK_FAILED_AVAILABILITY'
    else 'POSTCHECK_OK'
  end as postcheck_status;
