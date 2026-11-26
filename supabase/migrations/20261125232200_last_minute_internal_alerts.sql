-- Alertas internos. Aditiva, DESLIGADA por padrão, sem backfill e sem HTTP.
-- Aplicar esta migration não ativa captura, cron, Resend ou notificações.
create table public.last_minute_alert_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  first_activated_at timestamptz,
  active_since timestamptz,
  epoch uuid,
  check (not enabled or (first_activated_at is not null and active_since is not null and epoch is not null))
);
insert into public.last_minute_alert_settings(singleton) values(true);
create sequence public.last_minute_alert_event_sequence;
revoke all on sequence public.last_minute_alert_event_sequence from public,anon,authenticated,service_role;

-- Mudanças coletivas ficam duráveis mesmo se uma confirmação concorrente ainda
-- não estiver visível ao trigger. O worker reavalia até o início da sessão.
create table public.last_minute_session_events (
  id uuid primary key default gen_random_uuid(),
  sequence_id bigint not null default nextval('public.last_minute_alert_event_sequence'),
  epoch uuid not null,
  session_id uuid not null references public.sessions(id),
  starts_at timestamptz not null,
  occurred_at timestamptz not null default clock_timestamp()
);
create index last_minute_session_events_active_idx on public.last_minute_session_events(epoch,starts_at);

create table public.last_minute_alerts (
  id uuid primary key default gen_random_uuid(),
  sequence_id bigint not null default nextval('public.last_minute_alert_event_sequence'),
  epoch uuid not null,
  event_key text not null,
  reservation_id uuid not null references public.reservations(id),
  session_id uuid not null references public.sessions(id),
  origin text not null check (origin in ('CONFIRMATION','RESCHEDULE','SESSION_TIME_CHANGED')),
  priority text not null check (priority in ('URGENTE','PRIORITARIO')),
  late_confirmation boolean not null default false,
  starts_at timestamptz not null,
  confirmed_at timestamptz not null,
  occurred_at timestamptz not null,
  quantity integer not null check (quantity > 0),
  experience_title text not null,
  base_name text not null,
  deadline timestamptz not null,
  status text not null default 'QUEUED' check (status in ('QUEUED','SENDING','SENT','FAILED','UNCERTAIN','SKIPPED')),
  attempts integer not null default 0,
  claim_token uuid,
  locked_until timestamptz,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz default now(),
  frozen_message jsonb,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,64}$'),
  sent_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique(epoch,event_key)
);
create index last_minute_alerts_pending_idx on public.last_minute_alerts(next_attempt_at,created_at)
  where status in ('QUEUED','FAILED','SENDING');
create index last_minute_alerts_reservation_sequence_idx on public.last_minute_alerts(reservation_id,sequence_id);

create table public.last_minute_alert_attempts (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.last_minute_alerts(id),
  attempt integer not null,
  claim_token uuid not null unique,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  outcome text check (outcome in ('ACCEPTED','NOT_SENT','UNKNOWN','LEASE_EXPIRED','SKIPPED')),
  error_code text check (error_code is null or error_code ~ '^[A-Z0-9_]{1,64}$'),
  unique(alert_id,attempt)
);
alter table public.last_minute_alert_settings enable row level security;
alter table public.last_minute_alerts enable row level security;
alter table public.last_minute_alert_attempts enable row level security;
alter table public.last_minute_session_events enable row level security;
revoke all on public.last_minute_alert_settings,public.last_minute_alerts,public.last_minute_alert_attempts,public.last_minute_session_events from public,anon,authenticated;
grant select on public.last_minute_alert_settings,public.last_minute_alerts,public.last_minute_alert_attempts,public.last_minute_session_events to service_role;

-- Ativação explícita. O primeiro marco nunca recua; reativação ganha nova época
-- e não recupera backlog de uma ativação anterior ou do período de pausa.
create function public.admin_configure_last_minute_alerts(p_actor_id uuid,p_enabled boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare cfg public.last_minute_alert_settings%rowtype; activated timestamptz := clock_timestamp();
begin
  if not public.is_active_admin(p_actor_id) then raise exception 'ADMIN_FORBIDDEN' using errcode='42501'; end if;
  select * into cfg from public.last_minute_alert_settings where singleton for update;
  if cfg.enabled = p_enabled then return jsonb_build_object('enabled',cfg.enabled,'activatedAt',cfg.first_activated_at); end if;
  update public.last_minute_alert_settings
  set enabled=p_enabled,
      first_activated_at=case when p_enabled then coalesce(first_activated_at,activated) else first_activated_at end,
      active_since=case when p_enabled then activated else active_since end,
      epoch=case when p_enabled then gen_random_uuid() else epoch end
  where singleton returning * into cfg;
  insert into public.admin_audit_log(actor_user_id,action,entity_type,reason,metadata)
  values(p_actor_id,'LAST_MINUTE_ALERTS_CONFIGURED','INTEGRATION','Configuração de alertas internos',jsonb_build_object('enabled',cfg.enabled,'activatedAt',cfg.first_activated_at,'activeSince',cfg.active_since));
  return jsonb_build_object('enabled',cfg.enabled,'activatedAt',cfg.first_activated_at,'activeSince',cfg.active_since);
end $$;

create function public.enqueue_last_minute_alert(p_reservation_id uuid,p_event_key text,p_origin text,p_occurred_at timestamptz default null,p_event_sequence bigint default null)
returns void language plpgsql security definer set search_path=public as $$
declare cfg public.last_minute_alert_settings%rowtype; r public.reservations%rowtype;
  s public.sessions%rowtype; title text; base text; happened timestamptz := coalesce(p_occurred_at,clock_timestamp()); late boolean;
begin
  select * into cfg from public.last_minute_alert_settings where singleton for share;
  if not cfg.enabled then return; end if;
  select * into r from public.reservations where id=p_reservation_id;
  if p_origin='CONFIRMATION' then happened:=r.confirmed_at; end if;
  -- Corte conservador: reservas já existentes na primeira ativação nunca entram,
  -- nem por webhook repetido, confirmação pendente ou remarcação posterior.
  if not found or r.status <> 'CONFIRMED' or r.confirmed_at is null
     or r.created_at < cfg.first_activated_at or happened < cfg.active_since then return; end if;
  if exists(select 1 from public.last_minute_alerts where epoch=cfg.epoch and event_key=p_event_key) then return; end if;
  if p_event_sequence is not null and exists(select 1 from public.last_minute_alerts where reservation_id=r.id and sequence_id>p_event_sequence) then return; end if;
  select * into s from public.sessions where id=r.session_id;
  if not found or s.status in ('CANCELLED','ARCHIVED') then return; end if;
  late := s.starts_at <= happened;
  if late and p_origin <> 'CONFIRMATION' then return; end if;
  if s.starts_at > happened + interval '48 hours' then return; end if;
  select e.title,case when b.slug='concha-acustica' then 'Cápsula Bar' else b.name end
    into title,base from public.experiences e join public.bases b on b.id=e.base_id where e.id=s.experience_id;
  if title is null or base is null then return; end if;
  insert into public.last_minute_alerts(sequence_id,epoch,event_key,reservation_id,session_id,origin,priority,late_confirmation,
    starts_at,confirmed_at,occurred_at,quantity,experience_title,base_name,deadline)
  values(coalesce(p_event_sequence,nextval('public.last_minute_alert_event_sequence')),cfg.epoch,p_event_key,r.id,s.id,p_origin,
    case when s.starts_at <= happened + interval '24 hours' then 'URGENTE' else 'PRIORITARIO' end,late,
    s.starts_at,r.confirmed_at,happened,r.quantity,title,base,
    case when late then happened+interval '1 hour' else s.starts_at end)
  on conflict(epoch,event_key) do nothing;
end $$;

create function public.capture_last_minute_confirmation() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if new.status='CONFIRMED' and old.status in ('PRE_RESERVED','EXPIRED')
     and old.confirmed_at is null and new.confirmed_at is not null then
    perform public.enqueue_last_minute_alert(new.id,'confirmation/'||new.id::text,'CONFIRMATION');
  end if;
  return null;
end $$;
create trigger reservations_last_minute_confirmation after update of status on public.reservations
for each row execute function public.capture_last_minute_confirmation();

create function public.capture_last_minute_reschedule() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  perform public.enqueue_last_minute_alert(new.reservation_id,'reschedule/'||new.id::text,'RESCHEDULE');
  return null;
end $$;
create trigger reservation_changes_last_minute after insert on public.reservation_session_changes
for each row execute function public.capture_last_minute_reschedule();

create function public.capture_last_minute_session_time() returns trigger
language plpgsql security definer set search_path=public as $$
declare cfg public.last_minute_alert_settings%rowtype;
begin
  if new.starts_at is not distinct from old.starts_at then return null; end if;
  select * into cfg from public.last_minute_alert_settings where singleton for share;
  if not cfg.enabled or new.starts_at<=clock_timestamp() or new.starts_at>clock_timestamp()+interval '48 hours' then return null; end if;
  insert into public.last_minute_session_events(epoch,session_id,starts_at) values(cfg.epoch,new.id,new.starts_at);
  return null;
end $$;
create trigger sessions_last_minute_time after update of starts_at on public.sessions
for each row execute function public.capture_last_minute_session_time();

create function public.last_minute_alert_rejection(p_alert_id uuid) returns text
language sql stable security definer set search_path=public as $$
  select case
    when not cfg.enabled or a.epoch is distinct from cfg.epoch then 'ACTIVATION_CHANGED'
    when r.created_at < cfg.first_activated_at or a.occurred_at < cfg.active_since then 'BEFORE_ACTIVATION'
    when r.status <> 'CONFIRMED' then 'RESERVATION_NOT_CONFIRMED'
    when exists(select 1 from public.last_minute_alerts newer where newer.reservation_id=a.reservation_id
      and newer.sequence_id>a.sequence_id) then 'EVENT_SUPERSEDED'
    when r.session_id <> a.session_id or s.starts_at <> a.starts_at or r.quantity <> a.quantity then 'RESERVATION_CHANGED'
    when s.status in ('CANCELLED','ARCHIVED') then 'SESSION_UNAVAILABLE'
    when clock_timestamp() >= a.deadline then 'ALERT_EXPIRED'
    else null end
  from public.last_minute_alerts a join public.reservations r on r.id=a.reservation_id
  join public.sessions s on s.id=r.session_id cross join public.last_minute_alert_settings cfg
  where a.id=p_alert_id and cfg.singleton;
$$;

create function public.claim_last_minute_alerts(p_limit integer default 2) returns jsonb
language plpgsql security definer set search_path=public set lock_timeout='3s' as $$
declare candidate record; event record; a public.last_minute_alerts%rowtype; reason text; token uuid; taken integer:=0; results jsonb:='[]'::jsonb;
begin
  if not exists(select 1 from public.last_minute_alert_settings where singleton and enabled) then return results; end if;
  -- Só eventos de horário capturados após a ativação. Repetir esta expansão é
  -- seguro pela chave do evento e cobre confirmações concorrentes que só ficaram
  -- visíveis depois da transação da alteração. Nenhum lock novo na reserva aqui.
  for event in
    select ev.id,ev.sequence_id,greatest(ev.occurred_at,r.confirmed_at) as occurred_at,r.id as reservation_id,
      exists(select 1 from public.last_minute_alerts latest where latest.reservation_id=r.id
        and latest.sequence_id=(select max(a1.sequence_id) from public.last_minute_alerts a1 where a1.reservation_id=r.id)
        and latest.session_id=s.id and latest.starts_at<>s.starts_at and latest.sequence_id>ev.sequence_id) as repair_snapshot
    from public.last_minute_session_events ev
    join public.last_minute_alert_settings cfg on cfg.singleton and cfg.enabled and cfg.epoch=ev.epoch
    join public.sessions s on s.id=ev.session_id and s.starts_at=ev.starts_at
    join public.reservations r on r.session_id=s.id and r.status='CONFIRMED'
      and r.created_at>=cfg.first_activated_at
    where ev.starts_at>clock_timestamp() and ev.occurred_at>=cfg.active_since
      -- Não gastar o lote reavaliando confirmações mais novas que já capturaram
      -- o horário correto. Isso evita starvation em alterações coletivas grandes.
      and not exists(select 1 from public.last_minute_alerts latest where latest.reservation_id=r.id
        and latest.sequence_id=(select max(a1.sequence_id) from public.last_minute_alerts a1 where a1.reservation_id=r.id)
        and latest.sequence_id>ev.sequence_id and (latest.session_id<>s.id or latest.starts_at=s.starts_at))
      and not exists(select 1 from public.last_minute_alerts a0 where a0.epoch=ev.epoch
        and a0.event_key='schedule/'||ev.id::text||'/'||r.id::text)
    order by ev.occurred_at desc,r.id limit 100
  loop
    perform public.enqueue_last_minute_alert(event.reservation_id,'schedule/'||event.id::text||'/'||event.reservation_id::text,
      'SESSION_TIME_CHANGED',event.occurred_at,case when event.repair_snapshot then null else event.sequence_id end);
  end loop;
  for candidate in select id,reservation_id from public.last_minute_alerts
    where (status in ('QUEUED','FAILED') and next_attempt_at <= clock_timestamp())
       or (status='SENDING' and locked_until <= clock_timestamp())
    order by created_at limit 100
  loop
    exit when taken >= least(greatest(coalesce(p_limit,2),1),10);
    -- Mesma ordem de locks do domínio: reserva antes da fila.
    perform 1 from public.reservations where id=candidate.reservation_id for share;
    perform 1 from public.last_minute_alert_settings where singleton for share;
    select * into a from public.last_minute_alerts where id=candidate.id for update skip locked;
    if not found then continue; end if;
    if not ((a.status in ('QUEUED','FAILED') and a.next_attempt_at <= clock_timestamp())
      or (a.status='SENDING' and a.locked_until <= clock_timestamp())) then continue; end if;
    if a.status='SENDING' then
      update public.last_minute_alert_attempts set finished_at=clock_timestamp(),outcome='LEASE_EXPIRED'
        where claim_token=a.claim_token and outcome is null;
    end if;
    reason:=public.last_minute_alert_rejection(a.id);
    if reason is not null then
      update public.last_minute_alerts set status='SKIPPED',last_error_code=reason,next_attempt_at=null,locked_until=null where id=a.id;
      continue;
    end if;
    -- A chave do Resend dura 24h. Paramos antes; nunca reenviar cegamente depois.
    if a.first_attempt_at + interval '23 hours' <= clock_timestamp() then
      update public.last_minute_alerts set status='UNCERTAIN',last_error_code='IDEMPOTENCY_WINDOW_EXPIRED',next_attempt_at=null,locked_until=null where id=a.id;
      continue;
    end if;
    if a.attempts >= 6 then
      update public.last_minute_alerts set status='UNCERTAIN',last_error_code='ATTEMPTS_EXHAUSTED',next_attempt_at=null,locked_until=null where id=a.id;
      continue;
    end if;
    token:=gen_random_uuid();
    update public.last_minute_alerts set status='SENDING',claim_token=token,attempts=attempts+1,
      first_attempt_at=coalesce(first_attempt_at,clock_timestamp()),locked_until=clock_timestamp()+interval '2 minutes',next_attempt_at=null
      where id=a.id returning * into a;
    insert into public.last_minute_alert_attempts(alert_id,attempt,claim_token) values(a.id,a.attempts,token);
    taken:=taken+1;
    results:=results||jsonb_build_array(jsonb_build_object('id',a.id,'claimToken',token,'attempt',a.attempts,'message',a.frozen_message,
      'payload',jsonb_build_object('reservationId',a.reservation_id,'priority',a.priority,'lateConfirmation',a.late_confirmation,
      'origin',a.origin,'experienceTitle',a.experience_title,'baseName',a.base_name,'startsAt',a.starts_at,
      'confirmedAt',a.confirmed_at,'occurredAt',a.occurred_at,'quantity',a.quantity)));
  end loop;
  return results;
end $$;

create function public.freeze_last_minute_alert(p_alert_id uuid,p_claim_token uuid,p_message jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
declare a public.last_minute_alerts%rowtype; owner_id uuid; reason text;
begin
  select reservation_id into owner_id from public.last_minute_alerts where id=p_alert_id;
  perform 1 from public.reservations where id=owner_id for share;
  perform 1 from public.last_minute_alert_settings where singleton for share;
  select * into a from public.last_minute_alerts where id=p_alert_id for update;
  if not found or a.status<>'SENDING' or a.claim_token is distinct from p_claim_token or a.locked_until <= clock_timestamp() then return null; end if;
  reason:=public.last_minute_alert_rejection(a.id);
  if reason is not null then
    update public.last_minute_alerts set status='SKIPPED',last_error_code=reason,locked_until=null where id=a.id;
    update public.last_minute_alert_attempts set outcome='SKIPPED',finished_at=clock_timestamp(),error_code=reason where claim_token=p_claim_token;
    return null;
  end if;
  if a.frozen_message is not null then return a.frozen_message; end if;
  if p_message->>'to' is distinct from 'almaazulacademy@gmail.com'
     or jsonb_typeof(p_message->'subject') is distinct from 'string'
     or jsonb_typeof(p_message->'text') is distinct from 'string'
     or jsonb_typeof(p_message->'html') is distinct from 'string' then raise exception 'INVALID_ALERT_MESSAGE'; end if;
  update public.last_minute_alerts set frozen_message=p_message where id=a.id;
  return p_message;
end $$;

create function public.complete_last_minute_alert(p_alert_id uuid,p_claim_token uuid) returns boolean
language plpgsql security definer set search_path=public as $$
begin
  update public.last_minute_alerts set status='SENT',sent_at=clock_timestamp(),locked_until=null,last_error_code=null
    where id=p_alert_id and status='SENDING' and claim_token=p_claim_token;
  if not found then return false; end if;
  update public.last_minute_alert_attempts set outcome='ACCEPTED',finished_at=clock_timestamp() where claim_token=p_claim_token;
  return true;
end $$;

create function public.fail_last_minute_alert(p_alert_id uuid,p_claim_token uuid,p_error_code text,p_retryable boolean,p_unknown boolean) returns boolean
language plpgsql security definer set search_path=public as $$
declare a public.last_minute_alerts%rowtype;
begin
  select * into a from public.last_minute_alerts where id=p_alert_id for update;
  if not found or a.status<>'SENDING' or a.claim_token is distinct from p_claim_token then return false; end if;
  update public.last_minute_alert_attempts set outcome=case when p_unknown then 'UNKNOWN' else 'NOT_SENT' end,
    error_code=p_error_code,finished_at=clock_timestamp() where claim_token=p_claim_token;
  update public.last_minute_alerts set status=case when p_unknown and a.attempts>=6 then 'UNCERTAIN' else 'FAILED' end,
    last_error_code=p_error_code,locked_until=null,
    next_attempt_at=case when p_retryable and a.attempts<6 then clock_timestamp()+make_interval(secs => (array[5,30,120,600,1800])[a.attempts]) else null end
    where id=a.id;
  return true;
end $$;

-- Funções internas e de trigger não são endpoints públicos. Só quatro operações
-- de fila e a ativação administrativa ficam disponíveis ao backend.
revoke all on function public.admin_configure_last_minute_alerts(uuid,boolean),public.enqueue_last_minute_alert(uuid,text,text,timestamptz,bigint),
  public.capture_last_minute_confirmation(),public.capture_last_minute_reschedule(),public.capture_last_minute_session_time(),
  public.last_minute_alert_rejection(uuid),public.claim_last_minute_alerts(integer),public.freeze_last_minute_alert(uuid,uuid,jsonb),
  public.complete_last_minute_alert(uuid,uuid),public.fail_last_minute_alert(uuid,uuid,text,boolean,boolean)
  from public,anon,authenticated,service_role;
grant execute on function public.admin_configure_last_minute_alerts(uuid,boolean),public.claim_last_minute_alerts(integer),
  public.freeze_last_minute_alert(uuid,uuid,jsonb),public.complete_last_minute_alert(uuid,uuid),
  public.fail_last_minute_alert(uuid,uuid,text,boolean,boolean) to service_role;
