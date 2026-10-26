-- Lista de espera — fase 5: detecção automática de vagas.
--
-- Depende de `202610250001_waitlist_foundation.sql` e de
-- `202610250002_waitlist_signup_email.sql`. Aditiva e idempotente. **Não
-- substitui o corpo de nenhuma função existente** — nem de reserva, pagamento ou
-- Stand-by, nem da lista de espera —, não cria trigger e não toca linha
-- existente. Cria uma tabela de configuração, uma coluna em `waitlist_openings`
-- e três funções.
--
-- Depois de aplicada, **nada acontece sozinho**:
--
--   * a detecção nasce **desligada** (`waitlist_settings.detection_enabled =
--     false`): `waitlist_scan()` responde `{enabled: false}` e não lê nem grava
--     nada;
--   * não há agendamento: o `pg_cron` da varredura está num script à parte
--     (`supabase/maintenance/waitlist_scan_schedule.sql`), não aplicado;
--   * os avisos que a varredura enfileira (`SPOT_AVAILABLE`) ficam `QUEUED`: as
--     funções de envio da fase 3 só operam `JOINED`. O envio é a fase 6.
--
-- ## De onde vêm as vagas
--
-- Cancelamento, Stand-by, troca de turma, expiração de pré-reserva, fim da
-- janela de pagamento, aumento de capacidade, reabertura de turma — todos mudam
-- o que `available_spots` devolve, e nem todos gravam alguma coisa (a expiração
-- de uma pré-reserva vale no instante em que `expires_at` passa, antes de
-- qualquer escrita). Por isso a detecção é uma **varredura**, e não trigger:
-- ela olha `available_spots`, a fonte oficial, nas turmas que têm alguém na
-- lista, e não depende de nenhum fluxo de reserva avisar nada.
--
-- ## A oscilação da janela de pagamento
--
-- Uma pré-reserva com checkout que venceu deixa de contar em `available_spots`
-- na hora, mas até `expire_pre_reservations` (pg_cron, a cada minuto) abrir a
-- janela de pagamento ela ainda não está em hold: a vaga "aparece" por até um
-- minuto e some quando o hold empurra `expires_at` para a frente. A detecção
-- desconta essas pré-reservas — vencidas, com checkout, ainda sem hold —
-- (`waitlist_detection_spots`), só na leitura. `available_spots` não muda.
--
-- Além disso, uma abertura só recebe a primeira onda depois de uma carência
-- (`opening_grace_seconds`, 2 minutos por padrão): uma vaga que some antes
-- disso — alguém reservou na hora — não gera aviso.
--
-- ## Regras aprovadas (D2 e D3)
--
-- Por turma, uma abertura por vez (`waitlist_openings`, índice único da fase 1).
-- Cada onda vai a até `greatest(5, 3 × vagas)` inscrições, na ordem da fila, só
-- de quem cabe nas vagas, com menos de 3 avisos enviados e o último há 12 horas
-- ou mais, e sem outro aviso pendente — é `waitlist_eligible_entries`, da fase 1.
-- Ondas seguintes da mesma abertura só depois de `wave_interval_minutes` (30 por
-- padrão). Um aviso por inscrição e abertura (índice único da fase 1). Quando a
-- vaga some, a abertura fecha e os avisos dela ainda na fila são descartados.
--
-- A lista nunca reserva nem bloqueia vaga (opção A): a varredura só lê
-- `sessions` e `reservations`.

-- ---------------------------------------------------------------------------
-- 1. Configuração (o interruptor)
-- ---------------------------------------------------------------------------

create table if not exists public.waitlist_settings (
  singleton boolean primary key default true check (singleton),
  -- Desligada por padrão. Ligar é uma decisão: `update public.waitlist_settings
  -- set detection_enabled = true;` no SQL Editor.
  detection_enabled boolean not null default false,
  wave_interval_minutes integer not null default 30,
  opening_grace_seconds integer not null default 120,
  max_sessions_per_scan integer not null default 200,
  updated_at timestamptz not null default now(),
  constraint waitlist_settings_wave_interval check (wave_interval_minutes between 5 and 1440),
  constraint waitlist_settings_grace check (opening_grace_seconds between 0 and 3600),
  constraint waitlist_settings_batch check (max_sessions_per_scan between 1 and 1000)
);

insert into public.waitlist_settings (singleton) select true
where not exists (select 1 from public.waitlist_settings);

drop trigger if exists waitlist_settings_set_updated_at on public.waitlist_settings;
create trigger waitlist_settings_set_updated_at
  before update on public.waitlist_settings
  for each row execute function public.set_updated_at();

alter table public.waitlist_settings enable row level security;
revoke all on table public.waitlist_settings from public, anon, authenticated, service_role;

-- Por que uma abertura foi fechada: sem vaga, ou turma que deixou de aceitar
-- reserva (fechada, cancelada, arquivada, iniciada ou despublicada).
alter table public.waitlist_openings add column if not exists closed_reason text;

do $$ begin
  alter table public.waitlist_openings
    add constraint waitlist_openings_closed_reason_format
    check (closed_reason is null or closed_reason ~ '^[A-Z0-9_]{1,64}$');
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Vagas para a detecção
-- ---------------------------------------------------------------------------

-- `available_spots`, menos as pré-reservas com checkout que venceram mas ainda
-- não entraram na janela de pagamento: o cron de expiração vai devolvê-las à
-- ocupação no próximo minuto. Só leitura.
create or replace function public.waitlist_detection_spots(p_session_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select greatest(
    0,
    coalesce(public.available_spots(p_session_id), 0)
      - coalesce((
          select sum(r.quantity)::integer
          from public.reservations r
          where r.session_id = p_session_id
            and r.status = 'PRE_RESERVED'
            and r.expires_at <= now()
            and r.payment_hold_until is null
            and r.checkout_url is not null
        ), 0)
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Uma turma
-- ---------------------------------------------------------------------------

-- Avalia uma turma: fecha a abertura se a vaga sumiu ou a turma deixou de
-- aceitar reserva; abre uma nova quando a vaga aparece; e, passada a carência e
-- o intervalo entre ondas, enfileira a próxima onda. Devolve o que fez.
create or replace function public.waitlist_scan_session(
  p_session_id uuid,
  p_wave_interval_minutes integer,
  p_grace_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target record;
  bookable boolean;
  spots integer := 0;
  opening public.waitlist_openings%rowtype;
  queued integer := 0;
  skipped integer := 0;
  just_opened boolean := false;
begin
  select s.id, s.status, s.starts_at, e.status as experience_status
  into target
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  where s.id = p_session_id;

  bookable := found
    and target.status = 'OPEN'
    and target.starts_at > now()
    and target.experience_status = 'PUBLISHED';
  if bookable then
    spots := public.waitlist_detection_spots(p_session_id);
  end if;

  select * into opening
  from public.waitlist_openings
  where session_id = p_session_id and closed_at is null
  for update;

  if spots <= 0 then
    if opening.id is null then
      return jsonb_build_object('opened', 0, 'closed', 0, 'queued', 0, 'skipped', 0);
    end if;
    update public.waitlist_openings
    set closed_at = now(), closed_reason = case when bookable then 'NO_SPOTS' else 'SESSION_UNAVAILABLE' end
    where id = opening.id;
    -- O que ainda não saiu desta abertura já não descreve uma vaga.
    update public.waitlist_notifications
    set status = 'SKIPPED', skipped_at = now(), skip_reason = 'OPENING_CLOSED', frozen_message = null,
        claim_token = null, locked_until = null
    where opening_id = opening.id and kind = 'SPOT_AVAILABLE' and status in ('QUEUED', 'FAILED');
    get diagnostics skipped = row_count;
    return jsonb_build_object('opened', 0, 'closed', 1, 'queued', 0, 'skipped', skipped);
  end if;

  if opening.id is null then
    insert into public.waitlist_openings (session_id, spots_at_open)
    values (p_session_id, spots)
    returning * into opening;
    just_opened := true;
    if coalesce(p_grace_seconds, 0) > 0 then
      return jsonb_build_object('opened', 1, 'closed', 0, 'queued', 0, 'skipped', 0);
    end if;
  end if;

  -- Carência da abertura e intervalo entre ondas.
  if not just_opened and opening.opened_at > now() - make_interval(secs => greatest(coalesce(p_grace_seconds, 0), 0)) then
    return jsonb_build_object('opened', 0, 'closed', 0, 'queued', 0, 'skipped', 0);
  end if;
  if opening.waves > 0 and opening.last_wave_at > now() - make_interval(mins => greatest(coalesce(p_wave_interval_minutes, 30), 1)) then
    return jsonb_build_object('opened', just_opened::integer, 'closed', 0, 'queued', 0, 'skipped', 0);
  end if;

  insert into public.waitlist_notifications (entry_id, kind, opening_id, spots_at_queue)
  select eligible.entry_id, 'SPOT_AVAILABLE', opening.id, spots
  from public.waitlist_eligible_entries(p_session_id, spots) eligible
  order by eligible.created_at
  on conflict (entry_id, opening_id) where kind = 'SPOT_AVAILABLE' do nothing;
  get diagnostics queued = row_count;

  if queued > 0 then
    update public.waitlist_openings set waves = waves + 1, last_wave_at = now() where id = opening.id;
  end if;

  return jsonb_build_object('opened', just_opened::integer, 'closed', 0, 'queued', queued, 'skipped', 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. A varredura
-- ---------------------------------------------------------------------------

-- Uma execução por vez (advisory lock da transação: a segunda volta na hora
-- com `ALREADY_RUNNING`). Encerra inscrições de turmas passadas, marca as que
-- viraram reserva e avalia, uma a uma, as turmas com inscrição ativa ou com
-- abertura aberta. Uma turma presa em outra transação (lock de mais de 2 s) é
-- pulada e fica para a próxima execução, sem derrubar as outras.
--
-- Pensada para o pg_cron a cada minuto. Nunca envia nada.
create or replace function public.waitlist_scan()
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '2s'
as $$
declare
  settings public.waitlist_settings%rowtype;
  candidate record;
  result jsonb;
  expired integer;
  converted integer;
  sessions_scanned integer := 0;
  sessions_skipped integer := 0;
  opened integer := 0;
  closed integer := 0;
  queued integer := 0;
  discarded integer := 0;
begin
  select * into settings from public.waitlist_settings where singleton;
  if not found or not settings.detection_enabled then
    return jsonb_build_object('enabled', false);
  end if;

  if not pg_try_advisory_xact_lock(hashtextextended('alma-azul:waitlist_scan', 0)) then
    return jsonb_build_object('enabled', true, 'skipped', 'ALREADY_RUNNING');
  end if;

  expired := public.waitlist_expire_entries(500);
  converted := public.waitlist_mark_conversions(500);

  for candidate in
    select s.id
    from public.sessions s
    where exists (select 1 from public.waitlist_entries we where we.session_id = s.id and we.status = 'ACTIVE')
       or exists (select 1 from public.waitlist_openings o where o.session_id = s.id and o.closed_at is null)
    order by s.starts_at, s.id
    limit settings.max_sessions_per_scan
  loop
    begin
      result := public.waitlist_scan_session(candidate.id, settings.wave_interval_minutes, settings.opening_grace_seconds);
      sessions_scanned := sessions_scanned + 1;
      opened := opened + (result ->> 'opened')::integer;
      closed := closed + (result ->> 'closed')::integer;
      queued := queued + (result ->> 'queued')::integer;
      discarded := discarded + (result ->> 'skipped')::integer;
    exception when lock_not_available then
      sessions_skipped := sessions_skipped + 1;
    end;
  end loop;

  return jsonb_build_object(
    'enabled', true,
    'expiredEntries', expired,
    'convertedEntries', converted,
    'sessionsScanned', sessions_scanned,
    'sessionsSkipped', sessions_skipped,
    'openingsOpened', opened,
    'openingsClosed', closed,
    'notificationsQueued', queued,
    'notificationsDiscarded', discarded
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------
--
-- Ninguém pela API: o pg_cron roda como o dono, e a fase 6 decide se o servidor
-- precisa de alguma delas.
revoke all on function public.waitlist_detection_spots(uuid) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_scan_session(uuid, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_scan() from public, anon, authenticated, service_role;
