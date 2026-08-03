-- Sprint 5: richer administrative operations. Additive and legacy-safe.
alter table public.experiences
  add column if not exists description text,
  add column if not exists duration_minutes integer,
  add column if not exists price_cents integer,
  add column if not exists default_capacity integer;

update public.experiences set
  description = coalesce(nullif(description, ''), summary, title),
  duration_minutes = coalesce(duration_minutes, 90),
  price_cents = coalesce(price_cents, 0),
  default_capacity = coalesce(default_capacity, 15);

alter table public.experiences
  alter column description set not null,
  alter column duration_minutes set default 90,
  alter column duration_minutes set not null,
  alter column price_cents set default 0,
  alter column price_cents set not null,
  alter column default_capacity set default 15,
  alter column default_capacity set not null;

drop function if exists public.admin_list_experiences(uuid);
create function public.admin_list_experiences(p_actor_id uuid)
returns table (id uuid, slug text, title text, summary text, description text, duration_minutes integer, price_cents integer, default_capacity integer, status text, image_url text, display_order integer, sessions_count bigint, created_at timestamptz, updated_at timestamptz)
language plpgsql stable security definer set search_path=public as $$
begin
  if not public.is_active_admin(p_actor_id) then raise exception 'ADMIN_FORBIDDEN' using errcode='42501'; end if;
  return query select e.id,e.slug,e.title,e.summary,e.description,e.duration_minutes,e.price_cents,e.default_capacity,e.status,e.image_url,e.display_order,count(s.id),e.created_at,e.updated_at
  from public.experiences e left join public.sessions s on s.experience_id=e.id group by e.id order by e.display_order,e.title;
end $$;

drop function if exists public.admin_create_experience(uuid,text,text,text,text,text,integer);
create function public.admin_create_experience(p_actor_id uuid,p_slug text,p_title text,p_summary text,p_status text,p_image_url text,p_display_order integer,p_description text,p_duration_minutes integer,p_price_cents integer,p_default_capacity integer)
returns uuid language plpgsql security definer set search_path=public as $$ declare created_id uuid; begin
  if not public.is_active_admin(p_actor_id) then raise exception 'ADMIN_FORBIDDEN' using errcode='42501'; end if;
  insert into public.experiences(slug,title,summary,description,duration_minutes,price_cents,default_capacity,status,image_url,display_order)
  values(p_slug,p_title,p_summary,p_description,p_duration_minutes,p_price_cents,p_default_capacity,p_status,nullif(p_image_url,''),p_display_order) returning id into created_id;
  insert into public.admin_audit_log(actor_user_id,action,entity_type,entity_id,metadata) values(p_actor_id,'EXPERIENCE_CREATED','experience',created_id,jsonb_build_object('title',p_title));
  return created_id;
end $$;

drop function if exists public.admin_update_experience(uuid,uuid,text,text,text,text,integer);
create function public.admin_update_experience(p_actor_id uuid,p_experience_id uuid,p_title text,p_summary text,p_status text,p_image_url text,p_display_order integer,p_description text,p_duration_minutes integer,p_price_cents integer,p_default_capacity integer)
returns boolean language plpgsql security definer set search_path=public as $$ begin
  if not public.is_active_admin(p_actor_id) then raise exception 'ADMIN_FORBIDDEN' using errcode='42501'; end if;
  update public.experiences set title=p_title,summary=p_summary,description=p_description,duration_minutes=p_duration_minutes,price_cents=p_price_cents,default_capacity=p_default_capacity,status=p_status,image_url=nullif(p_image_url,''),display_order=p_display_order,updated_at=now() where id=p_experience_id;
  if not found then raise exception 'EXPERIENCE_NOT_FOUND'; end if;
  insert into public.admin_audit_log(actor_user_id,action,entity_type,entity_id,metadata) values(p_actor_id,'EXPERIENCE_UPDATED','experience',p_experience_id,jsonb_build_object('title',p_title));
  return true;
end $$;

drop function if exists public.admin_list_sessions(uuid);
create function public.admin_list_sessions(p_actor_id uuid)
returns table (id uuid,experience_id uuid,experience_title text,starts_at timestamptz,duration_minutes integer,price_cents integer,capacity integer,remaining_spots integer,reservations_count bigint,status public.session_status,internal_notes text,created_at timestamptz,updated_at timestamptz,participants jsonb)
language plpgsql security definer set search_path=public as $$ begin
  if not public.is_active_admin(p_actor_id) then raise exception 'ADMIN_FORBIDDEN' using errcode='42501'; end if;
  perform public.expire_pre_reservations();
  return query select s.id,e.id,e.title,s.starts_at,s.duration_minutes,s.price_cents,s.capacity,public.available_spots(s.id),count(r.id),s.status,s.internal_notes,s.created_at,s.updated_at,
    coalesce(jsonb_agg(jsonb_build_object('id',r.id,'name',r.full_name,'quantity',r.quantity,'status',r.status) order by r.full_name) filter(where r.id is not null and r.status in('CONFIRMED','PRE_RESERVED','CANCELLED')),'[]'::jsonb)
  from public.sessions s join public.experiences e on e.id=s.experience_id left join public.reservations r on r.session_id=s.id
  group by s.id,e.id,e.title order by s.starts_at desc;
end $$;

create or replace function public.admin_dashboard_metrics(p_actor_id uuid) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare result jsonb; begin
  if not public.is_active_admin(p_actor_id) then raise exception 'ADMIN_FORBIDDEN' using errcode='42501'; end if;
  select jsonb_build_object(
    'nextSession',(select jsonb_build_object('id',s.id,'experienceTitle',e.title,'startsAt',s.starts_at,'remainingSpots',public.available_spots(s.id)) from public.sessions s join public.experiences e on e.id=s.experience_id where s.starts_at>now() and s.status<>'CANCELLED' order by s.starts_at limit 1),
    'futureSessions',(select count(*) from public.sessions where starts_at>now() and status<>'CANCELLED'),
    'confirmedReservations',(select count(*) from public.reservations where status='CONFIRMED'),
    'totalReservations',(select count(*) from public.reservations),
    'preReservations',(select count(*) from public.reservations where status='PRE_RESERVED' and expires_at>now()),
    'expectedRevenueCents',(select coalesce(sum(total_cents),0) from public.reservations where status='CONFIRMED' or(status='PRE_RESERVED' and expires_at>now())),
    'confirmedRevenueCents',(select coalesce(sum(total_cents),0) from public.reservations where status='CONFIRMED'),
    'totalParticipants',(select coalesce(sum(quantity),0) from public.reservations where status='CONFIRMED'),
    'averageOccupancyRate',(select coalesce(round(avg((s.capacity-public.available_spots(s.id))*100.0/nullif(s.capacity,0)),1),0) from public.sessions s where s.starts_at>now() and s.status<>'CANCELLED'),
    'topExperience',(select e.title from public.reservations r join public.experiences e on e.id=r.experience_id where r.status='CONFIRMED' group by e.id,e.title order by sum(r.quantity) desc limit 1),
    'monthlyRevenueCents',(select coalesce(sum(total_cents),0) from public.reservations where status='CONFIRMED' and confirmed_at>=date_trunc('month',now())),
    'averageTicketCents',(select coalesce(round(avg(total_cents)),0) from public.reservations where status='CONFIRMED'),
    'revenueByMonth',(select coalesce(jsonb_agg(jsonb_build_object('month',to_char(m.month,'Mon'),'revenueCents',coalesce(x.total,0)) order by m.month),'[]'::jsonb) from generate_series(date_trunc('month',now())-interval '5 months',date_trunc('month',now()),interval '1 month') m(month) left join lateral(select sum(total_cents) total from public.reservations where status='CONFIRMED' and confirmed_at>=m.month and confirmed_at<m.month+interval '1 month')x on true),
    'lastUpdatedAt',greatest(coalesce((select max(updated_at) from public.experiences),'-infinity'::timestamptz),coalesce((select max(updated_at) from public.sessions),'-infinity'::timestamptz),coalesce((select max(updated_at) from public.reservations),'-infinity'::timestamptz))
  ) into result; return result;
end $$;

drop function if exists public.admin_list_reservations(uuid,date,uuid,public.reservation_status,text,text,text,uuid);
create function public.admin_list_reservations(p_actor_id uuid,p_date date,p_experience_id uuid,p_status public.reservation_status,p_name text,p_phone text,p_cpf text,p_session_id uuid,p_payment_status text,p_query text,p_sort text)
returns table (id uuid,public_code text,reservation_status public.reservation_status,full_name text,cpf_last4 char(4),phone text,email text,quantity integer,total_cents integer,notes text,expires_at timestamptz,payment_provider text,provider_reference text,payment_status text,confirmed_at timestamptz,cancelled_at timestamptz,created_at timestamptz,updated_at timestamptz,session_id uuid,starts_at timestamptz,experience_id uuid,experience_title text)
language plpgsql security definer set search_path=public,extensions as $$ declare normalized_cpf text:=regexp_replace(coalesce(p_cpf,''),E'\\D','','g'); begin
  if not public.is_active_admin(p_actor_id) then raise exception 'ADMIN_FORBIDDEN' using errcode='42501'; end if; perform public.expire_pre_reservations();
  return query with rows as(select r.*,s.starts_at,e.title experience_title,
    case when exists(select 1 from public.payment_events pe where pe.reservation_id=r.id and pe.event_type in('PAYMENT_CONFIRMED','PAYMENT_CONFIRMED_MANUAL')) then 'PAID' when exists(select 1 from public.payment_events pe where pe.reservation_id=r.id and pe.event_type='PAYMENT_AFTER_EXPIRATION') then 'PAID_AFTER_EXPIRATION' when r.status='PRE_RESERVED' and r.expires_at>now() then 'PENDING' else 'NOT_PAID' end pay_status
    from public.reservations r join public.sessions s on s.id=r.session_id join public.experiences e on e.id=r.experience_id)
  select x.id,x.public_code,x.status,x.full_name,x.cpf_last4,x.phone,x.email,x.quantity,x.total_cents,x.notes,x.expires_at,x.payment_provider,x.provider_reference,x.pay_status,x.confirmed_at,x.cancelled_at,x.created_at,x.updated_at,x.session_id,x.starts_at,x.experience_id,x.experience_title from rows x
  where(p_date is null or(x.starts_at at time zone 'America/Sao_Paulo')::date=p_date) and(p_experience_id is null or x.experience_id=p_experience_id) and(p_status is null or x.status=p_status) and(p_session_id is null or x.session_id=p_session_id)
  and(nullif(trim(p_name),'') is null or x.full_name ilike '%'||trim(p_name)||'%') and(nullif(regexp_replace(coalesce(p_phone,''),E'\\D','','g'),'') is null or regexp_replace(x.phone,E'\\D','','g') like '%'||regexp_replace(p_phone,E'\\D','','g')||'%')
  and(nullif(trim(p_payment_status),'') is null or x.pay_status=p_payment_status) and(nullif(trim(p_query),'') is null or x.full_name ilike '%'||trim(p_query)||'%' or x.public_code ilike '%'||trim(p_query)||'%')
  and(normalized_cpf='' or(char_length(normalized_cpf)=11 and x.cpf_hash=encode(digest(normalized_cpf,'sha256'),'hex'))or(char_length(normalized_cpf)<=4 and x.cpf_last4=right(normalized_cpf,4)))
  order by case when p_sort='oldest' then x.created_at end asc,case when p_sort='session' then x.starts_at end asc,x.created_at desc limit 500;
end $$;

revoke all on function public.admin_list_experiences(uuid) from public,anon,authenticated;
revoke all on function public.admin_list_sessions(uuid) from public,anon,authenticated;
revoke all on function public.admin_dashboard_metrics(uuid) from public,anon,authenticated;
revoke all on function public.admin_create_experience(uuid,text,text,text,text,text,integer,text,integer,integer,integer) from public,anon,authenticated;
revoke all on function public.admin_update_experience(uuid,uuid,text,text,text,text,integer,text,integer,integer,integer) from public,anon,authenticated;
revoke all on function public.admin_list_reservations(uuid,date,uuid,public.reservation_status,text,text,text,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.admin_list_experiences(uuid),public.admin_list_sessions(uuid),public.admin_dashboard_metrics(uuid) to service_role;
grant execute on function public.admin_create_experience(uuid,text,text,text,text,text,integer,text,integer,integer,integer),public.admin_update_experience(uuid,uuid,text,text,text,text,integer,text,integer,integer,integer),public.admin_list_reservations(uuid,date,uuid,public.reservation_status,text,text,text,uuid,text,text,text) to service_role;
