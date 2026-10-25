-- Lista de espera — fase 1: fundação no banco.
--
-- Aditiva e idempotente. Cria tabelas e funções novas e **não substitui o corpo
-- de nenhuma função existente**: `list_open_sessions`, `get_booking_session`,
-- `available_spots`, `create_pre_reservation`, as funções de pagamento e as de
-- Stand-by continuam exatamente como estão. Nenhuma trigger é criada em tabela
-- existente e nenhuma linha existente é tocada.
--
-- Depois de aplicada, **nada muda no site**: nenhuma rota chama estas funções
-- ainda. Não há agendamento (`pg_cron`), não há envio de e-mail e não há
-- detecção de vagas. A inscrição pública, o painel e os avisos vêm nas fases
-- seguintes, cada uma atrás da própria variável.
--
-- ## Regras aprovadas (25/10/2026)
--
--   * A lista **não reserva nem bloqueia vaga** (opção A). Ninguém aqui lê ou
--     escreve `reservations` além da conferência de conversão, que só lê.
--   * Só se entra na lista de uma turma com **zero vagas** (D4).
--   * Avisos de vaga em ondas, por ordem de inscrição, até
--     `greatest(5, 3 × vagas)` por onda (D2); no máximo 3 avisos por inscrição,
--     com pelo menos 12 horas entre eles (D3). Esta fase só prepara a régua
--     (`waitlist_eligible_entries`); nada a chama.
--   * Dados pessoais anonimizados 90 dias depois da turma (D6). A função existe;
--     nada a agenda.
--   * Contra abuso: limite de tentativas no banco, campo isca e, na rota que vier
--     na fase 3, checagem de origem (D5).
--
-- ## O que entra
--
--   1. `list_public_sessions(slug)` — as mesmas turmas de `list_open_sessions`
--      **mais as esgotadas**, com `sold_out`. Só leitura; não decide reserva.
--   2. `waitlist_entries` — uma linha por inscrição. Uma inscrição ativa por
--      e-mail e turma.
--   3. `waitlist_openings`, `waitlist_notifications` e
--      `waitlist_notification_attempts` — estrutura dos avisos futuros. A
--      inscrição já grava, na mesma transação, a linha `JOINED` (confirmação),
--      que fica `QUEUED`: ninguém a envia nesta fase.
--   4. `waitlist_throttle` e `waitlist_throttle_secret` — limite de tentativas
--      próprio, separado do da consulta de reservas.
--   5. Funções do cliente (inscrever, ver e cancelar pelo link), do painel
--      (turmas, lista, detalhe, remover) e de manutenção (expirar, marcar
--      conversão, anonimizar, régua de elegibilidade) — estas sem permissão
--      para ninguém além do dono.
--
-- ## Acesso
--
-- RLS ligada em todas as tabelas novas, sem policy e sem privilégio para
-- `anon`, `authenticated` ou mesmo `service_role`: tudo passa por função
-- `security definer` com `search_path` fixo. Só `list_public_sessions` é pública,
-- como `list_open_sessions`. As funções do cliente e do painel são só da
-- service role; as do painel conferem `is_active_admin` (ADMIN ou OPERATOR).

-- ---------------------------------------------------------------------------
-- 1. Turmas públicas, inclusive as esgotadas
-- ---------------------------------------------------------------------------
--
-- Mesmas regras de `list_open_sessions` — experiência publicada (o que já exige
-- base em operação), sessão OPEN e no futuro — sem o filtro de vagas. As
-- colunas são as mesmas, na mesma ordem, mais `sold_out`. Reservar continua
-- dependendo de `get_booking_session` e `create_pre_reservation`, que não
-- mudam: uma turma esgotada listada aqui continua sem poder ser reservada.
create or replace function public.list_public_sessions(p_experience_slug text)
returns table (
  id uuid,
  experience_id uuid,
  experience_slug text,
  experience_title text,
  experience_summary text,
  starts_at timestamptz,
  duration_minutes integer,
  price_cents integer,
  remaining_spots integer,
  sold_out boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.id,
    e.id,
    e.slug,
    e.title,
    e.summary,
    s.starts_at,
    s.duration_minutes,
    s.price_cents,
    spots.remaining,
    spots.remaining = 0
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  cross join lateral (select coalesce(public.available_spots(s.id), 0) as remaining) spots
  where e.slug = p_experience_slug
    and e.status = 'PUBLISHED'
    and s.status = 'OPEN'
    and s.starts_at > now()
  order by s.starts_at, s.id;
$$;

comment on function public.list_public_sessions(text) is
  'Turmas abertas e futuras de uma experiência publicada, inclusive as esgotadas (sold_out). Só exibição: reservar continua passando por get_booking_session e create_pre_reservation.';

-- ---------------------------------------------------------------------------
-- 2. Limite de tentativas da lista de espera
-- ---------------------------------------------------------------------------
--
-- Próprio, e não o de `register_customer_access_attempt`: aquele protege CPF +
-- código, com outros limites, e tem rollback próprio. Mesmo desenho: janela
-- fixa por balde, um `insert ... on conflict do update` atômico, baldes
-- guardados como HMAC com um segredo que só existe aqui.

create table if not exists public.waitlist_throttle_secret (
  singleton boolean primary key default true check (singleton),
  secret bytea not null,
  created_at timestamptz not null default now()
);

insert into public.waitlist_throttle_secret (singleton, secret)
select true, extensions.gen_random_bytes(32)
where not exists (select 1 from public.waitlist_throttle_secret);

create table if not exists public.waitlist_throttle (
  bucket text primary key,
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0,
  constraint waitlist_throttle_bucket_format
    check (bucket ~ '^(signup-client|signup-email|cancel-client):[0-9a-f]{64}$'),
  constraint waitlist_throttle_attempts_positive check (attempts > 0)
);

create index if not exists waitlist_throttle_window_idx on public.waitlist_throttle (window_started_at);

-- ---------------------------------------------------------------------------
-- 3. Inscrições
-- ---------------------------------------------------------------------------
--
-- A turma é a sessão: experiência, base, data e horário vêm dela por join. Uma
-- sessão com inscrição sempre tem reservas (só se entra com zero vagas), e o
-- banco já proíbe mudar a experiência ou excluir uma sessão com reservas — o
-- vínculo não tem como divergir. O `on delete cascade` existe só para que uma
-- exclusão de sessão nunca falhe por causa da lista.
--
-- Status:
--   ACTIVE    — esperando vaga.
--   CONVERTED — o mesmo e-mail fez uma reserva paga na turma depois de se inscrever.
--   CANCELLED — o próprio cliente cancelou, pelo link.
--   REMOVED   — removida pela equipe, com motivo (na auditoria).
--   EXPIRED   — a turma começou, foi cancelada ou foi arquivada.
--
-- Uma inscrição ACTIVE de turma que já começou é lida como EXPIRED em todas as
-- funções (`waitlist_effective_status`), antes mesmo de alguém gravar o status.
--
-- O link de cancelamento não é guardado: o token é um HMAC do id com o segredo
-- da lista (`waitlist_cancel_token`), recalculável quando o e-mail for montado.
-- Aqui fica só o SHA-256 dele, para achar a inscrição.
--
-- A ordem da fila é `queue_sequence`, atribuída na gravação: duas inscrições no
-- mesmo instante nunca empatam.
--
-- Nome, e-mail e telefone viram null na anonimização (90 dias depois da turma).

create table if not exists public.waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  status text not null default 'ACTIVE',
  queue_sequence bigint generated always as identity,
  full_name text,
  email text,
  phone text,
  quantity integer not null,
  cancel_token_hash text not null,
  notifications_sent integer not null default 0,
  last_notified_at timestamptz,
  converted_reservation_id uuid references public.reservations(id) on delete set null,
  closed_at timestamptz,
  closed_reason text,
  anonymized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint waitlist_entries_status_check
    check (status in ('ACTIVE', 'CONVERTED', 'CANCELLED', 'REMOVED', 'EXPIRED')),
  constraint waitlist_entries_closed_consistency check ((status = 'ACTIVE') = (closed_at is null)),
  constraint waitlist_entries_closed_reason_format check (closed_reason is null or closed_reason ~ '^[A-Z0-9_]{1,64}$'),
  constraint waitlist_entries_quantity_range check (quantity between 1 and 20),
  constraint waitlist_entries_full_name_length check (full_name is null or char_length(full_name) between 5 and 120),
  constraint waitlist_entries_email_format check (
    email is null or (email = lower(email) and char_length(email) <= 254 and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')
  ),
  constraint waitlist_entries_phone_format check (phone is null or phone ~ '^\+55[0-9]{10,11}$'),
  constraint waitlist_entries_personal_data check (
    (anonymized_at is null) = (full_name is not null and email is not null and phone is not null)
  ),
  constraint waitlist_entries_anonymized_closed check (anonymized_at is null or status <> 'ACTIVE'),
  constraint waitlist_entries_cancel_token_format check (cancel_token_hash ~ '^[0-9a-f]{64}$'),
  constraint waitlist_entries_notifications_range check (notifications_sent >= 0)
);

-- Uma inscrição ativa por e-mail e turma. É a última barreira contra duplicidade;
-- a função de inscrição já serializa o mesmo e-mail antes de chegar aqui.
create unique index if not exists waitlist_entries_active_email_key
  on public.waitlist_entries (session_id, email) where status = 'ACTIVE';
create unique index if not exists waitlist_entries_cancel_token_key
  on public.waitlist_entries (cancel_token_hash);
create unique index if not exists waitlist_entries_queue_sequence_key
  on public.waitlist_entries (queue_sequence);
create index if not exists waitlist_entries_session_queue_idx
  on public.waitlist_entries (session_id, status, queue_sequence);
create index if not exists waitlist_entries_email_active_idx
  on public.waitlist_entries (email) where status = 'ACTIVE';
create index if not exists waitlist_entries_status_created_idx
  on public.waitlist_entries (status, created_at);

drop trigger if exists waitlist_entries_set_updated_at on public.waitlist_entries;
create trigger waitlist_entries_set_updated_at
  before update on public.waitlist_entries
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Estrutura dos avisos (preparada, sem uso nesta fase)
-- ---------------------------------------------------------------------------
--
-- Uma "abertura" é o intervalo em que uma turma esgotada voltou a ter vaga. O
-- aviso de vaga é único por inscrição e abertura: a disponibilidade oscilando
-- dentro da mesma abertura (retenção vencendo, outra pessoa reservando) não
-- gera aviso repetido. Quem abre e fecha aberturas é a detecção da fase 5.

create table if not exists public.waitlist_openings (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  spots_at_open integer not null,
  waves integer not null default 0,
  last_wave_at timestamptz,
  constraint waitlist_openings_spots_positive check (spots_at_open > 0),
  constraint waitlist_openings_waves_range check (waves >= 0),
  constraint waitlist_openings_closed_after_open check (closed_at is null or closed_at >= opened_at)
);

create unique index if not exists waitlist_openings_open_session_key
  on public.waitlist_openings (session_id) where closed_at is null;

-- A fila dos dois e-mails da lista, no desenho da fila de reagendamento:
-- reivindicação com prazo (`claim_token`, `locked_until`), espera entre
-- tentativas (`next_attempt_at`), geração da chave de idempotência e a mensagem
-- congelada para repetir byte a byte. As funções que operam a fila vêm com o
-- envio (fases 3 e 6). A mensagem congelada não pode sobreviver a um estado
-- final.
--
--   JOINED         — confirmação da inscrição. Nasce com a inscrição.
--   SPOT_AVAILABLE — "abriu vaga". Nasce na detecção, um por inscrição e abertura.
create table if not exists public.waitlist_notifications (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.waitlist_entries(id) on delete cascade,
  kind text not null,
  status text not null default 'QUEUED',
  opening_id uuid references public.waitlist_openings(id) on delete cascade,
  spots_at_queue integer,
  attempts integer not null default 0,
  generation integer not null default 1,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  claim_token uuid,
  frozen_message jsonb,
  sent_at timestamptz,
  skipped_at timestamptz,
  skip_reason text,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint waitlist_notifications_kind_check check (kind in ('JOINED', 'SPOT_AVAILABLE')),
  constraint waitlist_notifications_status_check
    check (status in ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'UNCERTAIN', 'SKIPPED')),
  constraint waitlist_notifications_opening_kind check ((kind = 'JOINED') = (opening_id is null)),
  constraint waitlist_notifications_attempts_range check (attempts >= 0 and generation >= 1),
  constraint waitlist_notifications_spots_range check (spots_at_queue is null or spots_at_queue > 0),
  constraint waitlist_notifications_skip_reason_format check (skip_reason is null or skip_reason ~ '^[A-Z0-9_]{1,64}$'),
  constraint waitlist_notifications_error_code_format check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,64}$'),
  constraint waitlist_notifications_sent_consistency check ((status = 'SENT') = (sent_at is not null)),
  constraint waitlist_notifications_skipped_consistency check ((status = 'SKIPPED') = (skipped_at is not null and skip_reason is not null)),
  constraint waitlist_notifications_no_message_when_final
    check (frozen_message is null or status not in ('SENT', 'SKIPPED', 'UNCERTAIN'))
);

create unique index if not exists waitlist_notifications_joined_key
  on public.waitlist_notifications (entry_id) where kind = 'JOINED';
create unique index if not exists waitlist_notifications_opening_key
  on public.waitlist_notifications (entry_id, opening_id) where kind = 'SPOT_AVAILABLE';
create index if not exists waitlist_notifications_pending_idx
  on public.waitlist_notifications (next_attempt_at) where status in ('QUEUED', 'FAILED');
create index if not exists waitlist_notifications_entry_idx
  on public.waitlist_notifications (entry_id, created_at);

drop trigger if exists waitlist_notifications_set_updated_at on public.waitlist_notifications;
create trigger waitlist_notifications_set_updated_at
  before update on public.waitlist_notifications
  for each row execute function public.set_updated_at();

-- Uma linha por tentativa de envio. Só símbolos curtos: nenhuma resposta do
-- provedor chega ao banco.
create table if not exists public.waitlist_notification_attempts (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.waitlist_notifications(id) on delete cascade,
  attempt integer not null,
  generation integer not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text,
  error_code text,
  constraint waitlist_notification_attempts_number check (attempt >= 1 and generation >= 1),
  constraint waitlist_notification_attempts_outcome_check
    check (outcome is null or outcome in ('SENT', 'REJECTED', 'UNKNOWN', 'KEY_REFUSED')),
  constraint waitlist_notification_attempts_error_code_format check (error_code is null or error_code ~ '^[A-Z0-9_]{1,64}$')
);

create unique index if not exists waitlist_notification_attempts_number_key
  on public.waitlist_notification_attempts (notification_id, attempt);

-- ---------------------------------------------------------------------------
-- 5. Acesso às tabelas
-- ---------------------------------------------------------------------------
--
-- O Supabase concede privilégios a anon, authenticated e service_role em toda
-- tabela nova do schema public. Aqui ninguém lê nem escreve pela API — nem a
-- service role: só as funções abaixo alcançam as tabelas.
alter table public.waitlist_throttle_secret enable row level security;
alter table public.waitlist_throttle enable row level security;
alter table public.waitlist_entries enable row level security;
alter table public.waitlist_openings enable row level security;
alter table public.waitlist_notifications enable row level security;
alter table public.waitlist_notification_attempts enable row level security;

revoke all on table public.waitlist_throttle_secret from public, anon, authenticated, service_role;
revoke all on table public.waitlist_throttle from public, anon, authenticated, service_role;
revoke all on table public.waitlist_entries from public, anon, authenticated, service_role;
revoke all on table public.waitlist_openings from public, anon, authenticated, service_role;
revoke all on table public.waitlist_notifications from public, anon, authenticated, service_role;
revoke all on table public.waitlist_notification_attempts from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Apoio interno
-- ---------------------------------------------------------------------------

-- O status como as telas devem vê-lo: uma inscrição ativa de turma que já
-- começou, foi cancelada ou foi arquivada está encerrada, mesmo antes de
-- `waitlist_expire_entries` gravar isso.
create or replace function public.waitlist_effective_status(
  p_status text,
  p_starts_at timestamptz,
  p_session_status public.session_status
)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_status = 'ACTIVE' and (p_starts_at <= now() or p_session_status::text in ('CANCELLED', 'ARCHIVED')) then 'EXPIRED'
    else p_status
  end;
$$;

-- Token do link de cancelamento: HMAC do id com o segredo da lista, em
-- hexadecimal (64 caracteres). Não é guardado em lugar nenhum; quem montar o
-- e-mail recalcula. Trocar o segredo invalida todos os links.
create or replace function public.waitlist_cancel_token(p_entry_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  key bytea;
begin
  select s.secret into key from public.waitlist_throttle_secret s where s.singleton;
  if key is null then
    raise exception 'WAITLIST_NOT_CONFIGURED' using errcode = '55000';
  end if;
  return encode(hmac(convert_to('waitlist-cancel:' || p_entry_id::text, 'UTF8'), key, 'sha256'), 'hex');
end;
$$;

-- O que se faz com um texto vindo do link antes de compará-lo: só aceita o
-- formato do token e devolve o hash guardado na inscrição.
create or replace function public.waitlist_token_hash(p_token text)
returns text
language sql
immutable
security definer
set search_path = public, extensions
as $$
  select case
    when lower(trim(coalesce(p_token, ''))) ~ '^[0-9a-f]{64}$'
      then encode(digest(convert_to(lower(trim(p_token)), 'UTF8'), 'sha256'), 'hex')
    else null
  end;
$$;

-- Avisos pendentes de uma inscrição que acabou de ser encerrada não saem mais.
-- O que já está sendo enviado (SENDING) fica com quem enviou: a fila da fase 3/6
-- confere a inscrição de novo antes de cada tentativa.
create or replace function public.waitlist_skip_pending_notifications(p_entry_id uuid, p_reason text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  update public.waitlist_notifications
  set status = 'SKIPPED', skipped_at = now(), skip_reason = p_reason, frozen_message = null,
      claim_token = null, locked_until = null
  where entry_id = p_entry_id and status in ('QUEUED', 'FAILED');
  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- Registra uma tentativa e diz se ela cabe no limite. Toda tentativa conta,
-- inclusive a barrada e a inválida.
--
--   SIGNUP — 10 por origem a cada hora (quando há endereço confiável) e 6 por
--            e-mail a cada hora. O balde do e-mail limita quantas confirmações
--            alguém consegue disparar para a caixa de outra pessoa.
--   CANCEL — 30 por origem a cada 15 minutos. O token tem 256 bits: o limite só
--            corta varredura.
--
-- Sem endereço não há balde de origem — nunca um balde comum a todos.
create or replace function public.register_waitlist_attempt(p_action text, p_client_address text, p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  key bytea;
  action text := upper(trim(coalesce(p_action, '')));
  client_value text := lower(trim(coalesce(p_client_address, '')));
  email_value text := lower(trim(coalesce(p_email, '')));
  client_prefix text;
  client_limit integer;
  client_window interval;
  email_prefix text;
  email_limit integer;
  email_window interval;
  bucket_name text;
  counted public.waitlist_throttle%rowtype;
  allowed boolean := true;
  retry_after integer := 0;
begin
  select s.secret into key from public.waitlist_throttle_secret s where s.singleton;
  if key is null then
    raise exception 'WAITLIST_NOT_CONFIGURED' using errcode = '55000';
  end if;

  if action = 'SIGNUP' then
    client_prefix := 'signup-client'; client_limit := 10; client_window := interval '1 hour';
    email_prefix := 'signup-email'; email_limit := 6; email_window := interval '1 hour';
  elsif action = 'CANCEL' then
    client_prefix := 'cancel-client'; client_limit := 30; client_window := interval '15 minutes';
  else
    raise exception 'WAITLIST_INVALID_ACTION' using errcode = '22023';
  end if;

  -- A origem antes do e-mail, sempre nesta ordem: duas tentativas nunca
  -- esperam uma pela outra em ordem cruzada.
  if client_value <> '' then
    bucket_name := client_prefix || ':' || encode(hmac(convert_to(client_prefix || ':' || left(client_value, 128), 'UTF8'), key, 'sha256'), 'hex');
    insert into public.waitlist_throttle as t (bucket, window_started_at, attempts)
    values (bucket_name, now(), 1)
    on conflict (bucket) do update
    set attempts = case when t.window_started_at <= now() - client_window then 1 else t.attempts + 1 end,
        window_started_at = case when t.window_started_at <= now() - client_window then now() else t.window_started_at end
    returning * into counted;
    if counted.attempts > client_limit then
      allowed := false;
      retry_after := greatest(retry_after, ceil(extract(epoch from (counted.window_started_at + client_window - now())))::integer);
    end if;
  end if;

  if email_prefix is not null and email_value <> '' then
    bucket_name := email_prefix || ':' || encode(hmac(convert_to(email_prefix || ':' || left(email_value, 254), 'UTF8'), key, 'sha256'), 'hex');
    insert into public.waitlist_throttle as t (bucket, window_started_at, attempts)
    values (bucket_name, now(), 1)
    on conflict (bucket) do update
    set attempts = case when t.window_started_at <= now() - email_window then 1 else t.attempts + 1 end,
        window_started_at = case when t.window_started_at <= now() - email_window then now() else t.window_started_at end
    returning * into counted;
    if counted.attempts > email_limit then
      allowed := false;
      retry_after := greatest(retry_after, ceil(extract(epoch from (counted.window_started_at + email_window - now())))::integer);
    end if;
  end if;

  -- Faxina: baldes parados há mais de um dia. Poucos por chamada.
  delete from public.waitlist_throttle
  where bucket in (
    select t.bucket from public.waitlist_throttle t
    where t.window_started_at < now() - interval '1 day'
    limit 50
  );

  return jsonb_build_object('allowed', allowed, 'retryAfterSeconds', case when allowed then 0 else greatest(retry_after, 1) end);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Cliente
-- ---------------------------------------------------------------------------

-- Inscrição. Nunca lança por entrada do cliente: devolve um status, para que a
-- tentativa fique contada no limite mesmo quando é recusada.
--
--   ACCEPTED           — inscrito. **Também** é a resposta quando o e-mail já
--                        está na lista desta turma (nada é gravado de novo e
--                        nenhuma confirmação nova nasce) e quando o campo isca
--                        veio preenchido (nada é gravado). A resposta é idêntica
--                        nos três casos: não revela quem está inscrito.
--   RATE_LIMITED       — passou do limite; traz `retryAfterSeconds`.
--   INVALID            — campo inválido; traz `field`.
--   SESSION_UNAVAILABLE — turma inexistente, fechada, cancelada, arquivada, já
--                        iniciada ou de experiência não publicada.
--   NOT_SOLD_OUT       — a turma tem vaga: o caminho é reservar (D4). Traz
--                        `remainingSpots`, que a página pública já mostra.
--   LIMIT_REACHED      — o e-mail já tem 10 inscrições ativas.
--   WAITLIST_FULL      — a turma já tem 100 inscrições ativas.
--
-- Não pede lock na sessão: a lista não disputa vaga com a reserva, e uma
-- inscrição concorrente com uma mudança de disponibilidade não tem consequência
-- (opção A). A única espera possível é a da chave estrangeira: gravar a
-- inscrição pega `FOR KEY SHARE` na sessão, como gravar uma reserva, e isso
-- espera o `FOR UPDATE` de uma pré-reserva em curso naquela turma (e vice-versa)
-- pelo tempo de uma chamada. Não há ciclo: a pré-reserva não toca nada da lista.
-- O mesmo e-mail é serializado por um advisory lock da transação.
--
-- A confirmação por e-mail nasce aqui, na mesma transação (`JOINED`, `QUEUED`).
-- Nesta fase ninguém a envia.
create or replace function public.waitlist_join(
  p_session_id uuid,
  p_full_name text,
  p_email text,
  p_phone text,
  p_quantity integer,
  p_client_address text,
  p_trap text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  normalized_name text := regexp_replace(trim(coalesce(p_full_name, '')), '\s+', ' ', 'g');
  normalized_email text := lower(trim(coalesce(p_email, '')));
  normalized_phone text := trim(coalesce(p_phone, ''));
  attempt jsonb;
  target_session public.sessions%rowtype;
  target_experience public.experiences%rowtype;
  spots integer;
  new_id uuid := gen_random_uuid();
  inserted uuid;
begin
  attempt := public.register_waitlist_attempt('SIGNUP', p_client_address, normalized_email);
  if not (attempt ->> 'allowed')::boolean then
    return jsonb_build_object('status', 'RATE_LIMITED', 'retryAfterSeconds', (attempt ->> 'retryAfterSeconds')::integer);
  end if;

  -- Campo isca: gente não preenche um campo que não vê. Responde como sucesso,
  -- sem gravar, para o robô não aprender nada.
  if char_length(trim(coalesce(p_trap, ''))) > 0 then
    return jsonb_build_object('status', 'ACCEPTED');
  end if;

  if char_length(normalized_name) < 5 or char_length(normalized_name) > 120 or position(' ' in normalized_name) = 0 then
    return jsonb_build_object('status', 'INVALID', 'field', 'fullName');
  end if;
  if char_length(normalized_email) > 254 or normalized_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    return jsonb_build_object('status', 'INVALID', 'field', 'email');
  end if;
  if normalized_phone !~ '^\+55[0-9]{10,11}$' then
    return jsonb_build_object('status', 'INVALID', 'field', 'phone');
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 20 then
    return jsonb_build_object('status', 'INVALID', 'field', 'quantity');
  end if;

  select * into target_session from public.sessions where id = p_session_id;
  if not found or target_session.status <> 'OPEN' or target_session.starts_at <= now() then
    return jsonb_build_object('status', 'SESSION_UNAVAILABLE');
  end if;
  select * into target_experience from public.experiences where id = target_session.experience_id and status = 'PUBLISHED';
  if not found then
    return jsonb_build_object('status', 'SESSION_UNAVAILABLE');
  end if;

  -- Um grupo maior que a turma inteira nunca seria avisado.
  if p_quantity > target_session.capacity then
    return jsonb_build_object('status', 'INVALID', 'field', 'quantity');
  end if;

  spots := coalesce(public.available_spots(target_session.id), 0);
  if spots > 0 then
    return jsonb_build_object('status', 'NOT_SOLD_OUT', 'remainingSpots', spots);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('waitlist-email:' || normalized_email, 0));

  if exists (
    select 1 from public.waitlist_entries
    where session_id = target_session.id and email = normalized_email and status = 'ACTIVE'
  ) then
    return jsonb_build_object('status', 'ACCEPTED');
  end if;

  if (select count(*) from public.waitlist_entries where email = normalized_email and status = 'ACTIVE') >= 10 then
    return jsonb_build_object('status', 'LIMIT_REACHED');
  end if;
  if (select count(*) from public.waitlist_entries where session_id = target_session.id and status = 'ACTIVE') >= 100 then
    return jsonb_build_object('status', 'WAITLIST_FULL');
  end if;

  insert into public.waitlist_entries (id, session_id, full_name, email, phone, quantity, cancel_token_hash)
  values (
    new_id,
    target_session.id,
    normalized_name,
    normalized_email,
    normalized_phone,
    p_quantity,
    public.waitlist_token_hash(public.waitlist_cancel_token(new_id))
  )
  on conflict (session_id, email) where status = 'ACTIVE' do nothing
  returning id into inserted;

  if inserted is not null then
    insert into public.waitlist_notifications (entry_id, kind) values (inserted, 'JOINED');
  end if;

  return jsonb_build_object('status', 'ACCEPTED');
end;
$$;

-- O que a página do link mostra antes de o cliente confirmar o cancelamento.
-- Ver e cancelar são dois passos de propósito: um leitor de e-mail que abre os
-- links sozinho nunca cancela nada.
--
--   NOT_FOUND    — token com formato inválido ou que não corresponde a nada.
--   RATE_LIMITED — passou do limite.
--   ACTIVE / CONVERTED / CANCELLED / REMOVED / EXPIRED — o estado da inscrição,
--                  com a turma, a quantidade e o primeiro nome. Nunca e-mail,
--                  telefone ou sobrenome.
create or replace function public.waitlist_cancel_overview(p_token text, p_client_address text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  attempt jsonb;
  token_hash text;
  found_row record;
begin
  attempt := public.register_waitlist_attempt('CANCEL', p_client_address, null);
  if not (attempt ->> 'allowed')::boolean then
    return jsonb_build_object('status', 'RATE_LIMITED', 'retryAfterSeconds', (attempt ->> 'retryAfterSeconds')::integer);
  end if;

  token_hash := public.waitlist_token_hash(p_token);
  if token_hash is null then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  select we.quantity, we.full_name, s.starts_at, s.duration_minutes, e.title, coalesce(b.name, '') as base_name,
         public.waitlist_effective_status(we.status, s.starts_at, s.status) as effective
  into found_row
  from public.waitlist_entries we
  join public.sessions s on s.id = we.session_id
  join public.experiences e on e.id = s.experience_id
  left join public.bases b on b.id = e.base_id
  where we.cancel_token_hash = token_hash;
  if not found then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  return jsonb_build_object(
    'status', found_row.effective,
    'firstName', coalesce(split_part(found_row.full_name, ' ', 1), ''),
    'quantity', found_row.quantity,
    'session', jsonb_build_object(
      'startsAt', found_row.starts_at,
      'durationMinutes', found_row.duration_minutes,
      'experienceTitle', found_row.title,
      'baseName', found_row.base_name
    )
  );
end;
$$;

-- Cancelamento pelo link. Idempotente: repetir devolve ALREADY_CLOSED com o
-- estado atual.
--
--   CANCELLED      — cancelada agora.
--   ALREADY_CLOSED — já não estava ativa; traz `state`. Uma inscrição ativa de
--                    turma que já começou é gravada EXPIRED aqui.
--   NOT_FOUND / RATE_LIMITED — como na leitura.
create or replace function public.waitlist_cancel(p_token text, p_client_address text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  attempt jsonb;
  token_hash text;
  target public.waitlist_entries%rowtype;
  target_session public.sessions%rowtype;
  effective text;
begin
  attempt := public.register_waitlist_attempt('CANCEL', p_client_address, null);
  if not (attempt ->> 'allowed')::boolean then
    return jsonb_build_object('status', 'RATE_LIMITED', 'retryAfterSeconds', (attempt ->> 'retryAfterSeconds')::integer);
  end if;

  token_hash := public.waitlist_token_hash(p_token);
  if token_hash is null then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  select * into target from public.waitlist_entries where cancel_token_hash = token_hash for update;
  if not found then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  select * into target_session from public.sessions where id = target.session_id;
  effective := public.waitlist_effective_status(target.status, target_session.starts_at, target_session.status);

  if target.status <> 'ACTIVE' then
    return jsonb_build_object('status', 'ALREADY_CLOSED', 'state', target.status);
  end if;

  if effective = 'EXPIRED' then
    update public.waitlist_entries
    set status = 'EXPIRED', closed_at = now(),
        closed_reason = case when target_session.starts_at <= now() then 'SESSION_STARTED' else 'SESSION_UNAVAILABLE' end
    where id = target.id;
    perform public.waitlist_skip_pending_notifications(target.id, 'ENTRY_CLOSED');
    return jsonb_build_object('status', 'ALREADY_CLOSED', 'state', 'EXPIRED');
  end if;

  update public.waitlist_entries
  set status = 'CANCELLED', closed_at = now(), closed_reason = 'CUSTOMER'
  where id = target.id;
  perform public.waitlist_skip_pending_notifications(target.id, 'ENTRY_CLOSED');

  return jsonb_build_object('status', 'CANCELLED');
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Painel
-- ---------------------------------------------------------------------------

-- Turmas com inscrições, a mais próxima primeiro. `p_include_past` traz também
-- as que já começaram.
create or replace function public.admin_waitlist_sessions(p_actor_id uuid, p_include_past boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(item order by starts_at, session_id), '[]'::jsonb) into result
  from (
    select
      s.id as session_id,
      s.starts_at,
      jsonb_build_object(
        'sessionId', s.id,
        'startsAt', s.starts_at,
        'sessionStatus', s.status,
        'capacity', s.capacity,
        'remainingSpots', coalesce(public.available_spots(s.id), 0),
        'experienceId', e.id,
        'experienceTitle', e.title,
        'baseId', b.id,
        'baseName', coalesce(b.name, ''),
        'activeEntries', count(*) filter (where public.waitlist_effective_status(we.status, s.starts_at, s.status) = 'ACTIVE'),
        'activeParticipants', coalesce(sum(we.quantity) filter (where public.waitlist_effective_status(we.status, s.starts_at, s.status) = 'ACTIVE'), 0),
        'totalEntries', count(*),
        'lastSignupAt', max(we.created_at)
      ) as item
    from public.waitlist_entries we
    join public.sessions s on s.id = we.session_id
    join public.experiences e on e.id = s.experience_id
    left join public.bases b on b.id = e.base_id
    where coalesce(p_include_past, false) or s.starts_at > now()
    group by s.id, s.starts_at, s.status, s.capacity, e.id, e.title, b.id, b.name
  ) x;

  return result;
end;
$$;

-- Lista paginada. A ordem é a da fila: turma mais próxima, depois quem se
-- inscreveu primeiro (`queue_sequence`). `position` é o lugar na fila entre as
-- ativas da turma. Busca por nome, e-mail ou telefone (a partir de 4 dígitos), comparada
-- literalmente. `total` e `totalParticipants` são do conjunto filtrado inteiro.
create or replace function public.admin_list_waitlist_entries_page(
  p_actor_id uuid,
  p_session_id uuid,
  p_base_id uuid,
  p_status text,
  p_query text,
  p_limit integer,
  p_offset integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  batch integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  skip integer := greatest(coalesce(p_offset, 0), 0);
  status_filter text := upper(nullif(trim(coalesce(p_status, '')), ''));
  needle text := nullif(trim(coalesce(p_query, '')), '');
  digits text := regexp_replace(coalesce(p_query, ''), '\D', '', 'g');
  pattern text;
  result jsonb;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if status_filter is not null and status_filter not in ('ACTIVE', 'CONVERTED', 'CANCELLED', 'REMOVED', 'EXPIRED') then
    raise exception 'WAITLIST_INVALID_FILTER' using errcode = '22023';
  end if;
  if needle is not null and char_length(needle) > 120 then
    raise exception 'WAITLIST_INVALID_FILTER' using errcode = '22023';
  end if;
  if needle is not null then
    pattern := '%' || replace(replace(replace(needle, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
  end if;

  with ranked as (
    select
      we.*,
      s.starts_at,
      s.status as session_status,
      e.title as experience_title,
      b.id as base_id,
      coalesce(b.name, '') as base_name,
      public.waitlist_effective_status(we.status, s.starts_at, s.status) as effective,
      row_number() over (partition by we.session_id, we.status order by we.queue_sequence) as queue_number
    from public.waitlist_entries we
    join public.sessions s on s.id = we.session_id
    join public.experiences e on e.id = s.experience_id
    left join public.bases b on b.id = e.base_id
  ),
  matched as (
    select * from ranked r
    where (p_session_id is null or r.session_id = p_session_id)
      and (p_base_id is null or r.base_id = p_base_id)
      and (status_filter is null or r.effective = status_filter)
      and (
        pattern is null
        or r.full_name ilike pattern
        or r.email ilike pattern
        or (char_length(digits) >= 4 and regexp_replace(coalesce(r.phone, ''), '\D', '', 'g') like '%' || digits || '%')
      )
  ),
  page as (
    select * from matched order by starts_at, session_id, queue_sequence limit batch offset skip
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'entryId', p.id,
        'status', p.effective,
        'sessionId', p.session_id,
        'startsAt', p.starts_at,
        'sessionStatus', p.session_status,
        'experienceTitle', p.experience_title,
        'baseId', p.base_id,
        'baseName', p.base_name,
        'fullName', p.full_name,
        'email', p.email,
        'phone', p.phone,
        'quantity', p.quantity,
        'position', case when p.effective = 'ACTIVE' then p.queue_number else null end,
        'notificationsSent', p.notifications_sent,
        'lastNotifiedAt', p.last_notified_at,
        'createdAt', p.created_at,
        'closedAt', p.closed_at,
        'closedReason', p.closed_reason,
        'anonymized', p.anonymized_at is not null
      ) order by p.starts_at, p.session_id, p.queue_sequence)
      from page p
    ), '[]'::jsonb),
    'total', (select count(*) from matched),
    'totalParticipants', (select coalesce(sum(quantity), 0) from matched),
    'limit', batch,
    'offset', skip
  ) into result;

  return result;
end;
$$;

-- Detalhe de uma inscrição: os dados, os avisos (com as tentativas) e as ações
-- da equipe registradas na auditoria. Nunca devolve o hash do link nem a
-- mensagem congelada.
create or replace function public.admin_waitlist_entry(p_actor_id uuid, p_entry_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'entryId', we.id,
    'status', public.waitlist_effective_status(we.status, s.starts_at, s.status),
    'storedStatus', we.status,
    'sessionId', s.id,
    'startsAt', s.starts_at,
    'sessionStatus', s.status,
    'capacity', s.capacity,
    'remainingSpots', coalesce(public.available_spots(s.id), 0),
    'experienceTitle', e.title,
    'baseName', coalesce(b.name, ''),
    'fullName', we.full_name,
    'email', we.email,
    'phone', we.phone,
    'quantity', we.quantity,
    'notificationsSent', we.notifications_sent,
    'lastNotifiedAt', we.last_notified_at,
    'convertedReservationId', we.converted_reservation_id,
    'createdAt', we.created_at,
    'closedAt', we.closed_at,
    'closedReason', we.closed_reason,
    'anonymized', we.anonymized_at is not null,
    'notifications', coalesce((
      select jsonb_agg(jsonb_build_object(
        'notificationId', n.id,
        'kind', n.kind,
        'status', n.status,
        'spotsAtQueue', n.spots_at_queue,
        'attempts', n.attempts,
        'createdAt', n.created_at,
        'sentAt', n.sent_at,
        'skippedAt', n.skipped_at,
        'skipReason', n.skip_reason,
        'lastErrorCode', n.last_error_code,
        'tries', coalesce((
          select jsonb_agg(jsonb_build_object(
            'attempt', a.attempt, 'startedAt', a.started_at, 'finishedAt', a.finished_at,
            'outcome', a.outcome, 'errorCode', a.error_code
          ) order by a.attempt)
          from public.waitlist_notification_attempts a where a.notification_id = n.id
        ), '[]'::jsonb)
      ) order by n.created_at, n.id)
      from public.waitlist_notifications n where n.entry_id = we.id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'action', l.action, 'reason', l.reason, 'createdAt', l.created_at,
        'actorName', coalesce(au.display_name, '')
      ) order by l.created_at, l.id)
      from public.admin_audit_log l
      left join public.admin_users au on au.user_id = l.actor_user_id
      where l.entity_type = 'waitlist_entry' and l.entity_id = we.id
    ), '[]'::jsonb)
  ) into result
  from public.waitlist_entries we
  join public.sessions s on s.id = we.session_id
  join public.experiences e on e.id = s.experience_id
  left join public.bases b on b.id = e.base_id
  where we.id = p_entry_id;

  return result;
end;
$$;

-- Remoção pela equipe. Motivo obrigatório (3 a 500 caracteres), gravado na
-- auditoria sem dado pessoal nos metadados. Idempotente: uma inscrição que já
-- não está ativa devolve `removed = false` com o status atual.
create or replace function public.admin_remove_waitlist_entry(p_actor_id uuid, p_entry_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_reason text := trim(coalesce(p_reason, ''));
  target public.waitlist_entries%rowtype;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if char_length(clean_reason) < 3 or char_length(clean_reason) > 500 then
    raise exception 'WAITLIST_INVALID_REASON' using errcode = '22023';
  end if;

  select * into target from public.waitlist_entries where id = p_entry_id for update;
  if not found then
    raise exception 'WAITLIST_ENTRY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if target.status <> 'ACTIVE' then
    return jsonb_build_object('removed', false, 'status', target.status);
  end if;

  update public.waitlist_entries
  set status = 'REMOVED', closed_at = now(), closed_reason = 'ADMIN'
  where id = target.id;
  perform public.waitlist_skip_pending_notifications(target.id, 'ENTRY_CLOSED');

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, reason, metadata)
  values (
    p_actor_id, 'WAITLIST_ENTRY_REMOVED', 'waitlist_entry', target.id, clean_reason,
    jsonb_build_object('sessionId', target.session_id, 'quantity', target.quantity, 'previousStatus', target.status)
  );

  return jsonb_build_object('removed', true, 'status', 'REMOVED');
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Manutenção e régua dos avisos (preparadas; nada as chama nem agenda)
-- ---------------------------------------------------------------------------

-- Grava EXPIRED nas inscrições ativas de turmas que começaram, foram canceladas
-- ou foram arquivadas. As telas já as leem assim; isto só registra.
create or replace function public.waitlist_expire_entries(p_limit integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  closed record;
  affected integer := 0;
begin
  for closed in
    select we.id, case when s.starts_at <= now() then 'SESSION_STARTED' else 'SESSION_UNAVAILABLE' end as reason
    from public.waitlist_entries we
    join public.sessions s on s.id = we.session_id
    where we.status = 'ACTIVE'
      and (s.starts_at <= now() or s.status::text in ('CANCELLED', 'ARCHIVED'))
    order by s.starts_at, we.created_at
    limit least(greatest(coalesce(p_limit, 200), 1), 1000)
    for update of we skip locked
  loop
    update public.waitlist_entries set status = 'EXPIRED', closed_at = now(), closed_reason = closed.reason where id = closed.id;
    perform public.waitlist_skip_pending_notifications(closed.id, 'ENTRY_CLOSED');
    affected := affected + 1;
  end loop;
  return affected;
end;
$$;

-- Marca CONVERTED a inscrição ativa cujo e-mail tem reserva paga naquela turma,
-- criada depois da inscrição (estritamente: uma reserva do mesmo instante não
-- conta). Só lê `reservations`; não grava nada lá.
create or replace function public.waitlist_mark_conversions(p_limit integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  converted record;
  affected integer := 0;
begin
  for converted in
    select we.id, (
      select r.id from public.reservations r
      where r.session_id = we.session_id
        and r.email = we.email
        and r.status::text in ('CONFIRMED', 'AWAITING_RESCHEDULE')
        and r.created_at > we.created_at
      order by r.confirmed_at nulls last, r.id
      limit 1
    ) as reservation_id
    from public.waitlist_entries we
    where we.status = 'ACTIVE'
      and exists (
        select 1 from public.reservations r
        where r.session_id = we.session_id
          and r.email = we.email
          and r.status::text in ('CONFIRMED', 'AWAITING_RESCHEDULE')
          and r.created_at > we.created_at
      )
    order by we.created_at
    limit least(greatest(coalesce(p_limit, 200), 1), 1000)
    for update of we skip locked
  loop
    update public.waitlist_entries
    set status = 'CONVERTED', closed_at = now(), closed_reason = 'RESERVATION_CONFIRMED', converted_reservation_id = converted.reservation_id
    where id = converted.id;
    perform public.waitlist_skip_pending_notifications(converted.id, 'ENTRY_CLOSED');
    affected := affected + 1;
  end loop;
  return affected;
end;
$$;

-- Anonimiza as inscrições de turmas que começaram há mais de 90 dias (D6):
-- nome, e-mail e telefone viram null e as mensagens congeladas são apagadas. A
-- linha fica, sem dado pessoal, para as contagens e o histórico de avisos.
create or replace function public.waitlist_anonymize_entries(p_limit integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  target record;
  affected integer := 0;
begin
  for target in
    select we.id, we.status
    from public.waitlist_entries we
    join public.sessions s on s.id = we.session_id
    where we.anonymized_at is null
      and s.starts_at < now() - interval '90 days'
    order by s.starts_at, we.created_at
    limit least(greatest(coalesce(p_limit, 200), 1), 1000)
    for update of we skip locked
  loop
    update public.waitlist_entries
    set full_name = null, email = null, phone = null, anonymized_at = now(),
        status = case when target.status = 'ACTIVE' then 'EXPIRED' else status end,
        closed_at = coalesce(closed_at, now()),
        closed_reason = case when target.status = 'ACTIVE' then 'SESSION_STARTED' else closed_reason end
    where id = target.id;
    perform public.waitlist_skip_pending_notifications(target.id, 'ENTRY_CLOSED');
    update public.waitlist_notifications set frozen_message = null where entry_id = target.id and frozen_message is not null;
    affected := affected + 1;
  end loop;
  return affected;
end;
$$;

-- Tamanho de uma onda de avisos (D2): até max(5, 3 × vagas).
create or replace function public.waitlist_wave_size(p_spots integer)
returns integer
language sql
immutable
security definer
set search_path = public
as $$
  select case when coalesce(p_spots, 0) <= 0 then 0 else greatest(5, 3 * p_spots) end;
$$;

-- Quem seria avisado agora, com `p_spots` vagas abertas, na ordem da fila (D2 e
-- D3): inscrição ativa e não anonimizada, grupo que cabe nas vagas, menos de 3
-- avisos de vaga enviados, o último há pelo menos 12 horas e nenhum aviso de
-- vaga ainda pendente. A detecção da fase 5 enfileira o resultado; nesta fase
-- ninguém a chama.
create or replace function public.waitlist_eligible_entries(p_session_id uuid, p_spots integer)
returns table (entry_id uuid, quantity integer, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select we.id, we.quantity, we.created_at
  from public.waitlist_entries we
  where we.session_id = p_session_id
    and we.status = 'ACTIVE'
    and we.anonymized_at is null
    and we.quantity <= coalesce(p_spots, 0)
    and we.notifications_sent < 3
    and (we.last_notified_at is null or we.last_notified_at <= now() - interval '12 hours')
    and not exists (
      select 1 from public.waitlist_notifications n
      where n.entry_id = we.id and n.kind = 'SPOT_AVAILABLE' and n.status in ('QUEUED', 'SENDING', 'FAILED')
    )
  order by we.queue_sequence
  limit public.waitlist_wave_size(p_spots);
$$;

-- ---------------------------------------------------------------------------
-- 10. Grants
-- ---------------------------------------------------------------------------
--
-- O Postgres concede EXECUTE a PUBLIC em toda função nova, e o Supabase também
-- a anon, authenticated e service_role. Tudo é revogado e só o necessário volta:
--
--   * `list_public_sessions` — pública, como `list_open_sessions`;
--   * cliente e painel — só a service role (o servidor confere origem e sessão
--     antes de chamar; o banco confere o limite e o admin);
--   * apoio, manutenção e régua — ninguém além do dono. As fases seguintes
--     concedem o que forem usar.
revoke all on function public.list_public_sessions(text) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_effective_status(text, timestamptz, public.session_status) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_cancel_token(uuid) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_token_hash(text) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_skip_pending_notifications(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.register_waitlist_attempt(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_join(uuid, text, text, text, integer, text, text) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_cancel_overview(text, text) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_cancel(text, text) from public, anon, authenticated, service_role;
revoke all on function public.admin_waitlist_sessions(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_list_waitlist_entries_page(uuid, uuid, uuid, text, text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_waitlist_entry(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_remove_waitlist_entry(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_expire_entries(integer) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_mark_conversions(integer) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_anonymize_entries(integer) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_wave_size(integer) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_eligible_entries(uuid, integer) from public, anon, authenticated, service_role;

grant execute on function public.list_public_sessions(text) to anon, authenticated, service_role;
grant execute on function public.waitlist_join(uuid, text, text, text, integer, text, text) to service_role;
grant execute on function public.waitlist_cancel_overview(text, text) to service_role;
grant execute on function public.waitlist_cancel(text, text) to service_role;
grant execute on function public.admin_waitlist_sessions(uuid, boolean) to service_role;
grant execute on function public.admin_list_waitlist_entries_page(uuid, uuid, uuid, text, text, integer, integer) to service_role;
grant execute on function public.admin_waitlist_entry(uuid, uuid) to service_role;
grant execute on function public.admin_remove_waitlist_entry(uuid, uuid, text) to service_role;
