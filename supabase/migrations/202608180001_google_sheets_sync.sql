-- Sincronização operacional com o Google Sheets.
--
-- A planilha é uma integração secundária: serve para montar os grupos de
-- WhatsApp de cada turma. O Supabase continua sendo a fonte de verdade das
-- reservas, das vagas e dos pagamentos. Nada aqui altera disponibilidade,
-- capacidade, pré-reserva, cancelamento ou confirmação de pagamento.
--
-- Esta migration é aditiva e idempotente. Não reescreve nenhuma migration
-- histórica, não altera nenhuma função existente e não toca em nenhuma linha
-- de reservations, sessions, experiences ou payment_events.
--
-- Duas responsabilidades:
--
--   1. Uma fila durável (integration_sync_jobs) para que uma indisponibilidade
--      do Google nunca desfaça um pagamento nem derrube o webhook: a reserva
--      confirma, o job fica pendente e é reprocessado depois.
--
--   2. RPCs de snapshot que devolvem *somente* o mínimo operacional. A regra de
--      privacidade fica no banco, não na aplicação: cpf_hash, cpf_last4, email,
--      checkout_url, provider_reference e payloads de pagamento simplesmente não
--      saem daqui, então o código da aplicação não tem como enviá-los à planilha.

-- 1. Fila de sincronização ---------------------------------------------------
--
-- Uma linha por (integração, entidade) — não por evento. O job representa o
-- *estado desejado*, não o histórico: 20 webhooks duplicados da mesma reserva
-- convergem para uma única linha PENDING. É essa unicidade que dá idempotência
-- à fila, antes mesmo de a planilha ser tocada.
create table if not exists public.integration_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  integration text not null,
  entity_type text not null,
  entity_id uuid not null,
  operation text not null,
  status text not null default 'PENDING',
  attempts integer not null default 0,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  synced_at timestamptz
);

alter table public.integration_sync_jobs add column if not exists operation text;
alter table public.integration_sync_jobs add column if not exists attempts integer not null default 0;
alter table public.integration_sync_jobs add column if not exists last_error_code text;
alter table public.integration_sync_jobs add column if not exists synced_at timestamptz;

do $$ begin
  alter table public.integration_sync_jobs
    add constraint integration_sync_jobs_entity_type_check
    check (entity_type in ('RESERVATION', 'SESSION'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.integration_sync_jobs
    add constraint integration_sync_jobs_status_check
    check (status in ('PENDING', 'SYNCED', 'FAILED'));
exception when duplicate_object then null;
end $$;

-- Barreira de vazamento: o código de erro é um símbolo curto e maiúsculo, nunca
-- uma mensagem do Google, nunca um corpo de resposta, nunca uma credencial.
-- O banco recusa qualquer coisa fora desse formato.
do $$ begin
  alter table public.integration_sync_jobs
    add constraint integration_sync_jobs_error_code_check
    check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,64}$');
exception when duplicate_object then null;
end $$;

create unique index if not exists integration_sync_jobs_entity_key
  on public.integration_sync_jobs (integration, entity_type, entity_id);

create index if not exists integration_sync_jobs_pending_idx
  on public.integration_sync_jobs (integration, updated_at)
  where status <> 'SYNCED';

drop trigger if exists integration_sync_jobs_set_updated_at on public.integration_sync_jobs;
create trigger integration_sync_jobs_set_updated_at
  before update on public.integration_sync_jobs
  for each row execute function public.set_updated_at();

-- 2. Operações da fila -------------------------------------------------------

-- Marca uma entidade como precisando de sincronização. Idempotente por
-- construção: reenfileirar a mesma entidade reaproveita a linha existente e
-- zera o contador de tentativas, porque o que mudou é o estado desejado.
create or replace function public.enqueue_integration_sync_job(
  p_integration text,
  p_entity_type text,
  p_entity_id uuid,
  p_operation text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare job_id uuid;
begin
  if p_entity_id is null then return null; end if;

  insert into public.integration_sync_jobs (integration, entity_type, entity_id, operation)
  values (
    coalesce(nullif(trim(p_integration), ''), 'GOOGLE_SHEETS'),
    p_entity_type,
    p_entity_id,
    coalesce(nullif(trim(p_operation), ''), 'UPSERT')
  )
  on conflict (integration, entity_type, entity_id) do update
    set operation = excluded.operation,
        status = 'PENDING',
        attempts = 0,
        last_error_code = null,
        updated_at = now()
  returning id into job_id;

  return job_id;
end;
$$;

-- Retira do topo da fila os jobs que ainda valem uma tentativa. `skip locked`
-- evita que duas execuções concorrentes (dois webhooks simultâneos, por
-- exemplo) reprocessem o mesmo job.
--
-- Reservar não conta tentativa: quem conta é a falha. Assim `attempts` significa
-- literalmente "quantas vezes isto já deu errado", que é o número que decide se
-- vale insistir. Mover `updated_at` basta para o job ir para o fim da fila e não
-- ser repescado duas vezes na mesma drenagem.
create or replace function public.claim_integration_sync_jobs(
  p_integration text,
  p_limit integer,
  p_max_attempts integer
)
returns table (
  id uuid,
  entity_type text,
  entity_id uuid,
  operation text,
  attempts integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.integration_sync_jobs j
  set status = 'PENDING',
      updated_at = now()
  where j.id in (
    select k.id
    from public.integration_sync_jobs k
    where k.integration = coalesce(nullif(trim(p_integration), ''), 'GOOGLE_SHEETS')
      and k.status <> 'SYNCED'
      and k.attempts < greatest(coalesce(p_max_attempts, 5), 1)
    order by k.updated_at asc
    limit least(greatest(coalesce(p_limit, 1), 0), 25)
    for update skip locked
  )
  returning j.id, j.entity_type, j.entity_id, j.operation, j.attempts;
end;
$$;

create or replace function public.complete_integration_sync_job(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.integration_sync_jobs
  set status = 'SYNCED',
      last_error_code = null,
      synced_at = now(),
      updated_at = now()
  where id = p_job_id;
  return found;
end;
$$;

-- Normaliza o código de erro antes de gravar. Mesmo que a aplicação escorregue
-- e mande uma mensagem inteira, sobra só um símbolo curto — a constraint da
-- tabela nunca é violada e nada sensível é persistido.
create or replace function public.fail_integration_sync_job(p_job_id uuid, p_error_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare normalized text;
begin
  normalized := left(
    upper(regexp_replace(coalesce(nullif(trim(p_error_code), ''), 'UNKNOWN_ERROR'), '[^A-Za-z0-9_]', '_', 'g')),
    64
  );

  update public.integration_sync_jobs
  set status = 'FAILED',
      attempts = attempts + 1,
      last_error_code = normalized,
      updated_at = now()
  where id = p_job_id;
  return found;
end;
$$;

-- Estado da sincronização de uma entidade, para o painel administrativo exibir
-- "Sincronizado", "Pendente" ou "Erro". Devolve null quando nunca houve job.
create or replace function public.integration_sync_state(
  p_integration text,
  p_entity_type text,
  p_entity_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'status', j.status,
    'attempts', j.attempts,
    'operation', j.operation,
    'lastErrorCode', j.last_error_code,
    'syncedAt', j.synced_at,
    'updatedAt', j.updated_at
  )
  from public.integration_sync_jobs j
  where j.integration = coalesce(nullif(trim(p_integration), ''), 'GOOGLE_SHEETS')
    and j.entity_type = p_entity_type
    and j.entity_id = p_entity_id;
$$;

-- 3. Snapshots operacionais --------------------------------------------------
--
-- O contrato de privacidade da integração vive aqui. Estas funções devolvem
-- exatamente o que a planilha precisa para montar o grupo de WhatsApp:
--
--   nome, telefone, quantidade, valor, status, forma de pagamento,
--   código da reserva, experiência e sessão.
--
-- E nada além disso. Não existe caminho pelo qual cpf_hash, cpf_last4, email,
-- endereço, checkout_url, provider_reference ou payload de pagamento cheguem à
-- aplicação por estas RPCs.

-- Forma de pagamento observada, derivada dos eventos já sanitizados.
-- `capture_method` ('pix', 'credit_card', 'boleto') não é dado sensível.
create or replace function public.reservation_payment_method(p_reservation_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select nullif(trim(pe.payload ->> 'capture_method'), '')
      from public.payment_events pe
      where pe.reservation_id = p_reservation_id
        and nullif(trim(pe.payload ->> 'capture_method'), '') is not null
      order by pe.processed_at desc
      limit 1
    ),
    (
      select 'manual'
      from public.payment_events pe
      where pe.reservation_id = p_reservation_id
        and pe.event_type = 'PAYMENT_CONFIRMED_MANUAL'
      limit 1
    ),
    ''
  );
$$;

-- Status de pagamento derivado exatamente como o painel administrativo já
-- deriva, para a planilha nunca contar uma história diferente da do admin.
create or replace function public.reservation_payment_status(p_reservation_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (
      select 1 from public.payment_events pe
      where pe.reservation_id = r.id
        and pe.event_type in ('PAYMENT_CONFIRMED', 'PAYMENT_CONFIRMED_MANUAL', 'PAYMENT_CONFIRMED_RECONCILED')
    ) then 'PAID'
    when exists (
      select 1 from public.payment_events pe
      where pe.reservation_id = r.id and pe.event_type = 'PAYMENT_AFTER_EXPIRATION'
    ) then 'PAID_AFTER_EXPIRATION'
    when r.status = 'PRE_RESERVED' and r.expires_at > now() then 'PENDING'
    else 'NOT_PAID'
  end
  from public.reservations r
  where r.id = p_reservation_id;
$$;

-- Bloco de sessão: capacidade, confirmados e vagas restantes vêm daqui. A
-- planilha nunca recalcula disponibilidade por conta própria.
create or replace function public.google_sheets_session_block(p_session_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', s.id,
    'experienceTitle', e.title,
    'startsAt', s.starts_at,
    'durationMinutes', s.duration_minutes,
    'capacity', s.capacity,
    'confirmedSpots', coalesce((
      select sum(r.quantity)::integer
      from public.reservations r
      where r.session_id = s.id and r.status = 'CONFIRMED'
    ), 0),
    'remainingSpots', public.available_spots(s.id),
    'status', s.status
  )
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  where s.id = p_session_id;
$$;

create or replace function public.google_sheets_reservation_block(p_reservation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', r.id,
    'sessionId', r.session_id,
    'publicCode', r.public_code,
    'fullName', r.full_name,
    'phone', r.phone,
    'quantity', r.quantity,
    'totalCents', r.total_cents,
    'status', r.status,
    'paymentStatus', public.reservation_payment_status(r.id),
    'paymentMethod', public.reservation_payment_method(r.id),
    'createdAt', r.created_at,
    'confirmedAt', r.confirmed_at,
    'cancelledAt', r.cancelled_at
  )
  from public.reservations r
  where r.id = p_reservation_id;
$$;

-- Snapshot de uma reserva: a própria reserva mais a sessão a que ela pertence.
create or replace function public.google_sheets_reservation_snapshot(p_reservation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  reservation jsonb;
  session_block jsonb;
begin
  reservation := public.google_sheets_reservation_block(p_reservation_id);
  if reservation is null then return null; end if;

  session_block := public.google_sheets_session_block((reservation ->> 'sessionId')::uuid);
  if session_block is null then return null; end if;

  return jsonb_build_object(
    'session', session_block,
    'reservations', jsonb_build_array(reservation)
  );
end;
$$;

-- Snapshot de uma sessão inteira: usado pela reconstrução administrativa
-- ("Sincronizar lista"), que reconcilia a turma inteira a partir do Supabase.
-- Traz também as canceladas e expiradas, porque a planilha precisa saber quais
-- vagas desativar — o histórico não é apagado.
create or replace function public.google_sheets_session_snapshot(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  session_block jsonb;
  reservation_blocks jsonb;
begin
  session_block := public.google_sheets_session_block(p_session_id);
  if session_block is null then return null; end if;

  select coalesce(jsonb_agg(public.google_sheets_reservation_block(r.id) order by r.created_at), '[]'::jsonb)
  into reservation_blocks
  from public.reservations r
  where r.session_id = p_session_id;

  return jsonb_build_object('session', session_block, 'reservations', reservation_blocks);
end;
$$;

-- Sessões que valem a pena manter na aba de seleção da planilha. Recorta o
-- passado distante para o dropdown não crescer indefinidamente.
create or replace function public.google_sheets_active_sessions(p_since_days integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(public.google_sheets_session_block(s.id) order by s.starts_at), '[]'::jsonb)
  from public.sessions s
  where s.starts_at >= now() - make_interval(days => greatest(coalesce(p_since_days, 90), 0));
$$;

-- 4. Grants ------------------------------------------------------------------
--
-- Tudo restrito ao service_role. A integração roda apenas no servidor; nenhuma
-- credencial do Google e nenhum destes dados passam pelo navegador.
alter table public.integration_sync_jobs enable row level security;
revoke all on public.integration_sync_jobs from anon, authenticated;

revoke all on function public.enqueue_integration_sync_job(text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.claim_integration_sync_jobs(text, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_integration_sync_job(uuid) from public, anon, authenticated;
revoke all on function public.fail_integration_sync_job(uuid, text) from public, anon, authenticated;
revoke all on function public.integration_sync_state(text, text, uuid) from public, anon, authenticated;
revoke all on function public.reservation_payment_method(uuid) from public, anon, authenticated;
revoke all on function public.reservation_payment_status(uuid) from public, anon, authenticated;
revoke all on function public.google_sheets_session_block(uuid) from public, anon, authenticated;
revoke all on function public.google_sheets_reservation_block(uuid) from public, anon, authenticated;
revoke all on function public.google_sheets_reservation_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.google_sheets_session_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.google_sheets_active_sessions(integer) from public, anon, authenticated;

grant execute on function public.enqueue_integration_sync_job(text, text, uuid, text) to service_role;
grant execute on function public.claim_integration_sync_jobs(text, integer, integer) to service_role;
grant execute on function public.complete_integration_sync_job(uuid) to service_role;
grant execute on function public.fail_integration_sync_job(uuid, text) to service_role;
grant execute on function public.integration_sync_state(text, text, uuid) to service_role;
grant execute on function public.reservation_payment_method(uuid) to service_role;
grant execute on function public.reservation_payment_status(uuid) to service_role;
grant execute on function public.google_sheets_session_block(uuid) to service_role;
grant execute on function public.google_sheets_reservation_block(uuid) to service_role;
grant execute on function public.google_sheets_reservation_snapshot(uuid) to service_role;
grant execute on function public.google_sheets_session_snapshot(uuid) to service_role;
grant execute on function public.google_sheets_active_sessions(integer) to service_role;
