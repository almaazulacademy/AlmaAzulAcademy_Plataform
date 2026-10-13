-- E-mail de confirmação do reagendamento vindo de Stand-by (etapa 4 de 6).
--
-- Depende de `202610130002_reservation_standby.sql` e de
-- `202610140001_reservation_standby_admin_panel.sql`.
--
-- Aditiva e idempotente. Cria duas tabelas, uma trigger e as funções da fila.
-- **Não substitui o corpo de nenhuma função existente** e não altera reserva,
-- sessão, pagamento, autorização de Stand-by nem linha de histórico. Depois de
-- aplicada, nada muda no comportamento do site: a fila só recebe uma linha
-- quando uma reserva em Stand-by é reagendada — o que hoje nenhuma tela faz — e
-- nenhum e-mail sai sem o servidor publicado com `STANDBY_RESCHEDULE_EMAIL_ENABLED`.
--
-- ## Por que uma fila própria, e não `integration_sync_jobs`
--
-- A fila que o projeto já tem serve ao e-mail de confirmação de pagamento e à
-- planilha, e não cabe aqui por três motivos:
--
--   1. Ela é uma linha por (integração, entidade), e a entidade só pode ser
--      RESERVATION ou SESSION. Uma reserva pode ser reagendada mais de uma vez;
--      a chave precisa ser o reagendamento, não a reserva. Reaproveitar a linha
--      do e-mail de pagamento seria exatamente reusar a chave de idempotência
--      dele.
--   2. Lá a linha nasce quando alguém reivindica o envio. Aqui ela precisa nascer
--      na transação que move a reserva, antes de existir quem envie — e a fila
--      atual não tem estado para "enfileirado, sem dono".
--   3. Alargar as constraints dela mexeria na fila de que dependem o e-mail de
--      pagamento e a sincronização com a planilha.
--
-- ## O evento
--
-- Um reagendamento efetivo é uma linha em `reservation_session_changes` com
-- `origin = 'STANDBY_RESCHEDULE'`. Ela é gravada por `reservation_standby_resolve`
-- depois de a reserva voltar a CONFIRMED na turma nova, existe no máximo uma por
-- autorização (`reservation_session_changes_standby_key`) e cobre os dois
-- caminhos — admin e cliente. Desfazer o Stand-by grava STANDBY_RESTORE, e o
-- reagendamento tradicional grava DIRECT: nenhum dos dois entra na fila.
--
-- A linha da fila é inserida por uma trigger nessa tabela, na mesma transação.
-- Se qualquer coisa falhar depois — auditoria, invariante, resposta — a
-- transação desfaz o reagendamento e a linha da fila junto: **sem reagendamento
-- gravado não existe e-mail a enviar**. A requisição repetida que o núcleo
-- devolve com `replayed = true` não escreve nada, logo não gera segundo evento.
--
-- ## Estados
--
--   QUEUED  — nasceu com o reagendamento; ninguém tentou enviar ainda.
--   SENDING — reivindicado; ninguém mais pode enviar até `locked_until`.
--   SENT    — o provedor aceitou. Definitivo.
--   FAILED  — a última tentativa falhou. Volta sozinho à fila enquanto houver
--             tentativa; depois espera ação humana.
--   SKIPPED — não enviado de propósito, e nunca será: `last_error_code` diz o
--             motivo (a reserva saiu da turma, foi cancelada, ou a turma já
--             começou). Definitivo.

-- ---------------------------------------------------------------------------
-- 1. Fila
-- ---------------------------------------------------------------------------
create table if not exists public.reservation_reschedule_emails (
  id uuid primary key default gen_random_uuid(),

  -- O reagendamento. `change_id` é a chave de idempotência deste e-mail.
  change_id uuid not null references public.reservation_session_changes(id) on delete restrict,
  standby_id uuid not null references public.reservation_standby(id) on delete restrict,
  reservation_id uuid not null references public.reservations(id) on delete restrict,
  target_session_id uuid not null references public.sessions(id) on delete restrict,
  actor_type text not null,

  status text not null default 'QUEUED',
  -- Tentativas iniciadas, não falhas: uma instância que morre no meio do envio
  -- também gastou uma.
  attempts integer not null default 0,
  last_error_code text,
  locked_until timestamptz,
  last_attempt_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$ begin
  alter table public.reservation_reschedule_emails
    add constraint reservation_reschedule_emails_status_allowed
    check (status in ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.reservation_reschedule_emails
    add constraint reservation_reschedule_emails_actor_type_allowed
    check (actor_type in ('ADMIN', 'CUSTOMER'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.reservation_reschedule_emails
    add constraint reservation_reschedule_emails_attempts_nonnegative
    check (attempts >= 0);
exception when duplicate_object then null;
end $$;

-- Mesma barreira de vazamento de `integration_sync_jobs`: o código de erro é um
-- símbolo curto, nunca a resposta do provedor.
do $$ begin
  alter table public.reservation_reschedule_emails
    add constraint reservation_reschedule_emails_error_code_format
    check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,64}$');
exception when duplicate_object then null;
end $$;

-- Reivindicado tem prazo; enviado tem data. Nunca pela metade.
do $$ begin
  alter table public.reservation_reschedule_emails
    add constraint reservation_reschedule_emails_state_consistent
    check ((status = 'SENDING') = (locked_until is not null) and (status = 'SENT') = (sent_at is not null));
exception when duplicate_object then null;
end $$;

-- Um e-mail por reagendamento efetivo. É esta unicidade, e não uma checagem da
-- aplicação, que impede o segundo evento.
create unique index if not exists reservation_reschedule_emails_change_key
  on public.reservation_reschedule_emails (change_id);

create unique index if not exists reservation_reschedule_emails_standby_key
  on public.reservation_reschedule_emails (standby_id);

create index if not exists reservation_reschedule_emails_reservation_idx
  on public.reservation_reschedule_emails (reservation_id, created_at desc);

create index if not exists reservation_reschedule_emails_open_idx
  on public.reservation_reschedule_emails (created_at)
  where status in ('QUEUED', 'SENDING', 'FAILED');

drop trigger if exists reservation_reschedule_emails_set_updated_at on public.reservation_reschedule_emails;
create trigger reservation_reschedule_emails_set_updated_at
  before update on public.reservation_reschedule_emails
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Registro das tentativas
-- ---------------------------------------------------------------------------
--
-- Uma linha por tentativa iniciada: quando começou, por onde, como terminou e
-- com que erro. `claim_token` identifica a tentativa para quem a iniciou — é o
-- que permite aceitar a conclusão de um envio que respondeu depois do prazo e
-- recusar a falha de um envio que já não é o atual.
create table if not exists public.reservation_reschedule_email_attempts (
  id uuid primary key default gen_random_uuid(),
  email_id uuid not null references public.reservation_reschedule_emails(id) on delete cascade,
  attempt integer not null,
  claim_token uuid not null default gen_random_uuid(),
  source text not null,
  -- Só no reenvio pedido pelo painel.
  actor_user_id uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text,
  error_code text
);

do $$ begin
  alter table public.reservation_reschedule_email_attempts
    add constraint reservation_reschedule_email_attempts_source_allowed
    check (source in ('RESCHEDULE', 'RETRY', 'ADMIN'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.reservation_reschedule_email_attempts
    add constraint reservation_reschedule_email_attempts_outcome_allowed
    check (outcome is null or outcome in ('SENT', 'FAILED', 'LEASE_EXPIRED'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.reservation_reschedule_email_attempts
    add constraint reservation_reschedule_email_attempts_error_code_format
    check (error_code is null or error_code ~ '^[A-Z0-9_]{1,64}$');
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.reservation_reschedule_email_attempts
    add constraint reservation_reschedule_email_attempts_finish_consistent
    check ((outcome is null) = (finished_at is null) and attempt > 0);
exception when duplicate_object then null;
end $$;

create unique index if not exists reservation_reschedule_email_attempts_number_key
  on public.reservation_reschedule_email_attempts (email_id, attempt);

create unique index if not exists reservation_reschedule_email_attempts_token_key
  on public.reservation_reschedule_email_attempts (claim_token);

-- Tudo passa por RPC `security definer`. Nem a API pública nem a service role
-- escrevem aqui; a service role só lê, para diagnóstico.
alter table public.reservation_reschedule_emails enable row level security;
alter table public.reservation_reschedule_email_attempts enable row level security;
revoke all on table public.reservation_reschedule_emails from public, anon, authenticated, service_role;
revoke all on table public.reservation_reschedule_email_attempts from public, anon, authenticated, service_role;
grant select on table public.reservation_reschedule_emails to service_role;
grant select on table public.reservation_reschedule_email_attempts to service_role;

-- ---------------------------------------------------------------------------
-- 3. O evento nasce com o reagendamento
-- ---------------------------------------------------------------------------
--
-- Sem bloco de exceção de propósito: se a linha da fila não puder ser gravada, o
-- reagendamento também não é. "Reagendou" e "tem e-mail a enviar" são o mesmo
-- fato, gravado uma vez.
create or replace function public.enqueue_reservation_reschedule_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.origin = 'STANDBY_RESCHEDULE' and new.standby_id is not null then
    insert into public.reservation_reschedule_emails (
      change_id, standby_id, reservation_id, target_session_id, actor_type
    ) values (
      new.id, new.standby_id, new.reservation_id, new.target_session_id, new.actor_type
    )
    on conflict do nothing;
  end if;
  return null;
end;
$$;

comment on function public.enqueue_reservation_reschedule_email() is
  'Enfileira o e-mail de confirmação na mesma transação do reagendamento vindo de Stand-by. Desfazer (STANDBY_RESTORE) e troca direta (DIRECT) não entram.';

drop trigger if exists reservation_session_changes_reschedule_email on public.reservation_session_changes;
create trigger reservation_session_changes_reschedule_email
  after insert on public.reservation_session_changes
  for each row
  when (new.origin = 'STANDBY_RESCHEDULE')
  execute function public.enqueue_reservation_reschedule_email();

-- ---------------------------------------------------------------------------
-- 4. Peças internas
-- ---------------------------------------------------------------------------
--
-- Nenhuma função desta seção é executável por `anon`, `authenticated` ou
-- `service_role`. Só as RPCs das seções 5 e 6 as chamam.

-- O e-mail ainda descreve a reserva? Devolve null quando sim, ou o motivo pelo
-- qual ele não deve mais sair. Um envio que falhou hoje pode ser retentado
-- amanhã: nesse intervalo a reserva pode ter sido cancelada, voltado ao Stand-by
-- ou mudado de turma, e a turma pode já ter acontecido.
create or replace function public.reservation_reschedule_email_rejection(p_email_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  queued public.reservation_reschedule_emails%rowtype;
  target public.reservations%rowtype;
  changed_at timestamptz;
  session_starts_at timestamptz;
begin
  select * into queued from public.reservation_reschedule_emails where id = p_email_id;
  if not found then return 'EMAIL_NOT_FOUND'; end if;

  select * into target from public.reservations where id = queued.reservation_id;
  if not found or target.status <> 'CONFIRMED' then return 'RESERVATION_NOT_CONFIRMED'; end if;

  -- Outra turma, ou a mesma turma depois de um novo percurso: o que vale é a
  -- troca mais recente, e ela tem (ou dispensa) o próprio e-mail.
  select c.created_at into changed_at from public.reservation_session_changes c where c.id = queued.change_id;
  if target.session_id is distinct from queued.target_session_id
     or exists (
       select 1 from public.reservation_session_changes later
       where later.reservation_id = queued.reservation_id
         and later.id <> queued.change_id
         and later.created_at > changed_at
     ) then
    return 'SUPERSEDED';
  end if;

  select s.starts_at into session_starts_at from public.sessions s where s.id = queued.target_session_id;
  if session_starts_at is null or session_starts_at <= now() then return 'SESSION_STARTED'; end if;

  return null;
end;
$$;

-- Conteúdo do e-mail: o mesmo payload do e-mail de confirmação — é a função
-- vigente, chamada, não copiada, para a base, a duração e o QR nunca divergirem
-- — mais a identificação do reagendamento. Sem CPF, telefone, endereço do
-- cliente, link de checkout nem dado de pagamento.
create or replace function public.reservation_reschedule_email_payload(p_email_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.reservation_confirmation_email(q.reservation_id)
         || jsonb_build_object(
              'emailId', q.id,
              'changeId', q.change_id,
              'actorType', q.actor_type,
              'rescheduledAt', c.created_at
            )
  from public.reservation_reschedule_emails q
  join public.reservation_session_changes c on c.id = q.change_id
  where q.id = p_email_id;
$$;

-- O núcleo da fila. Toda reivindicação — a imediata, a da rotina e a do painel
-- — passa por aqui, e só por aqui.
--
-- Trava a linha, decide e grava na mesma transação. Duas reivindicações
-- simultâneas se enfileiram no lock: a segunda encontra SENDING dentro do prazo
-- e devolve null. Quem recebe null não envia.
--
-- `p_max_attempts` null é o reenvio pedido por uma pessoa: sem teto.
create or replace function public.reservation_reschedule_email_take(
  p_email_id uuid,
  p_max_attempts integer,
  p_lease_minutes integer,
  p_source text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  queued public.reservation_reschedule_emails%rowtype;
  rejection text;
  token uuid;
  lease interval := make_interval(mins => least(greatest(coalesce(p_lease_minutes, 15), 1), 120));
begin
  select * into queued from public.reservation_reschedule_emails where id = p_email_id for update;
  if not found then return null; end if;

  if queued.status in ('SENT', 'SKIPPED') then return null; end if;
  if queued.status = 'SENDING' and queued.locked_until > now() then return null; end if;

  -- Prazo vencido sem resposta: a tentativa anterior fica registrada como tal.
  if queued.status = 'SENDING' then
    update public.reservation_reschedule_email_attempts
    set finished_at = now(), outcome = 'LEASE_EXPIRED'
    where email_id = queued.id and attempt = queued.attempts and outcome is null;
  end if;

  rejection := public.reservation_reschedule_email_rejection(queued.id);
  if rejection is not null then
    update public.reservation_reschedule_emails
    set status = 'SKIPPED', last_error_code = rejection, locked_until = null
    where id = queued.id;
    return null;
  end if;

  if p_max_attempts is not null and queued.attempts >= greatest(p_max_attempts, 1) then
    if queued.status = 'SENDING' then
      update public.reservation_reschedule_emails
      set status = 'FAILED', last_error_code = 'LEASE_EXPIRED', locked_until = null
      where id = queued.id;
    end if;
    return null;
  end if;

  insert into public.reservation_reschedule_email_attempts (email_id, attempt, source, actor_user_id)
  values (queued.id, queued.attempts + 1, p_source, p_actor_id)
  returning claim_token into token;

  update public.reservation_reschedule_emails
  set status = 'SENDING',
      attempts = queued.attempts + 1,
      locked_until = now() + lease,
      last_attempt_at = now()
  where id = queued.id;

  return jsonb_build_object(
    'emailId', queued.id,
    'claimToken', token,
    'attempt', queued.attempts + 1,
    'reservationId', queued.reservation_id,
    'changeId', queued.change_id,
    'payload', public.reservation_reschedule_email_payload(queued.id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Operações da fila (service role)
-- ---------------------------------------------------------------------------

-- Reivindica o e-mail de um reagendamento específico. É o que o servidor chama
-- logo depois de o reagendamento ser gravado. Devolve null quando não há o que
-- enviar: já enviado, envio em curso, tentativas esgotadas, reserva que não
-- está mais naquela turma — ou reagendamento que nunca existiu.
create or replace function public.claim_reservation_reschedule_email(
  p_change_id uuid,
  p_max_attempts integer,
  p_lease_minutes integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  email_id uuid;
begin
  select q.id into email_id from public.reservation_reschedule_emails q where q.change_id = p_change_id;
  if not found then return null; end if;

  return public.reservation_reschedule_email_take(
    email_id, greatest(coalesce(p_max_attempts, 3), 1), p_lease_minutes, 'RESCHEDULE', null
  );
end;
$$;

-- Reivindica pendências: nunca tentadas, falhas com tentativa sobrando e
-- envios cujo prazo venceu sem resposta. `skip locked` deixa duas execuções
-- simultâneas da rotina dividirem a fila em vez de disputarem a mesma linha.
-- Devolve um array com as reivindicações obtidas.
create or replace function public.claim_pending_reservation_reschedule_emails(
  p_limit integer,
  p_max_attempts integer,
  p_lease_minutes integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate record;
  claim jsonb;
  claims jsonb := '[]'::jsonb;
  max_attempts integer := greatest(coalesce(p_max_attempts, 3), 1);
begin
  for candidate in
    select q.id
    from public.reservation_reschedule_emails q
    where q.status = 'QUEUED'
       or (q.status = 'FAILED' and q.attempts < max_attempts)
       or (q.status = 'SENDING' and q.locked_until <= now())
    order by q.created_at, q.id
    limit least(greatest(coalesce(p_limit, 1), 0), 25)
    for update skip locked
  loop
    claim := public.reservation_reschedule_email_take(candidate.id, max_attempts, p_lease_minutes, 'RETRY', null);
    if claim is not null then
      claims := claims || jsonb_build_array(claim);
    end if;
  end loop;

  return claims;
end;
$$;

-- O provedor aceitou. Vale também para a tentativa que respondeu depois do
-- prazo: o e-mail saiu, e é isso que a fila precisa saber para ninguém mais
-- enviar.
create or replace function public.complete_reservation_reschedule_email(
  p_email_id uuid,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  queued public.reservation_reschedule_emails%rowtype;
  attempt_id uuid;
begin
  select * into queued from public.reservation_reschedule_emails where id = p_email_id for update;
  if not found then return false; end if;

  select a.id into attempt_id
  from public.reservation_reschedule_email_attempts a
  where a.email_id = p_email_id and a.claim_token = p_claim_token;
  if not found then return false; end if;

  update public.reservation_reschedule_email_attempts
  set finished_at = coalesce(finished_at, now()), outcome = 'SENT', error_code = null
  where id = attempt_id;

  if queued.status <> 'SENT' then
    update public.reservation_reschedule_emails
    set status = 'SENT', sent_at = now(), last_error_code = null, locked_until = null
    where id = queued.id;
  end if;

  return true;
end;
$$;

-- A tentativa falhou. Só é gravado um símbolo curto: o que não tiver esse
-- formato — a resposta do provedor, uma mensagem com endereço de e-mail — vira
-- UNKNOWN_ERROR, sem que nenhum pedaço do texto original seja guardado. Só a
-- tentativa atual devolve o e-mail à fila — a falha de uma tentativa antiga fica
-- no registro, mas não desfaz um envio concluído nem solta um envio em curso.
create or replace function public.fail_reservation_reschedule_email(
  p_email_id uuid,
  p_claim_token uuid,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  queued public.reservation_reschedule_emails%rowtype;
  attempted public.reservation_reschedule_email_attempts%rowtype;
  normalized text := upper(trim(coalesce(p_error_code, '')));
begin
  if normalized !~ '^[A-Z0-9_]{1,64}$' then
    normalized := 'UNKNOWN_ERROR';
  end if;

  select * into queued from public.reservation_reschedule_emails where id = p_email_id for update;
  if not found then return false; end if;

  select * into attempted
  from public.reservation_reschedule_email_attempts a
  where a.email_id = p_email_id and a.claim_token = p_claim_token;
  if not found or attempted.outcome in ('SENT', 'FAILED') then return false; end if;

  update public.reservation_reschedule_email_attempts
  set finished_at = coalesce(finished_at, now()), outcome = 'FAILED', error_code = normalized
  where id = attempted.id;

  -- FAILED aqui é a tentativa atual encerrada por prazo vencido: o erro real
  -- chegou atrasado e substitui o LEASE_EXPIRED.
  if queued.attempts = attempted.attempt and queued.status in ('SENDING', 'FAILED') then
    update public.reservation_reschedule_emails
    set status = 'FAILED', last_error_code = normalized, locked_until = null
    where id = queued.id;
  end if;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Painel
-- ---------------------------------------------------------------------------

-- Estado do e-mail de cada reagendamento da reserva, o mais recente primeiro.
-- Só estado: nenhum dado do cliente e nenhum token.
create or replace function public.admin_reservation_reschedule_emails(
  p_actor_id uuid,
  p_reservation_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'emailId', q.id,
      'standbyId', q.standby_id,
      'changeId', q.change_id,
      'actorType', q.actor_type,
      'status', q.status,
      'inFlight', q.status = 'SENDING' and q.locked_until > now(),
      'attempts', q.attempts,
      'lastErrorCode', q.last_error_code,
      'lastAttemptAt', q.last_attempt_at,
      'sentAt', q.sent_at,
      'createdAt', q.created_at
    ) order by q.created_at desc, q.id)
    from public.reservation_reschedule_emails q
    where q.reservation_id = p_reservation_id
  ), '[]'::jsonb);
end;
$$;

-- "Reenviar e-mail de reagendamento": reivindica o e-mail do reagendamento mais
-- recente da reserva, sem teto de tentativas — é uma pessoa pedindo. As demais
-- regras são as mesmas: enviado não reenvia, envio em curso não é atropelado e
-- reserva que saiu daquela turma não recebe.
create or replace function public.admin_claim_reservation_reschedule_email(
  p_actor_id uuid,
  p_reservation_id uuid,
  p_lease_minutes integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  latest_id uuid;
  claim jsonb;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  select q.id into latest_id
  from public.reservation_reschedule_emails q
  where q.reservation_id = p_reservation_id
  order by q.created_at desc, q.id
  limit 1;
  if not found then return null; end if;

  claim := public.reservation_reschedule_email_take(latest_id, null, p_lease_minutes, 'ADMIN', p_actor_id);

  if claim is not null then
    insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
    values (
      p_actor_id,
      'RESERVATION_RESCHEDULE_EMAIL_RESEND',
      'RESERVATION',
      p_reservation_id,
      jsonb_build_object('emailId', latest_id, 'attempt', claim -> 'attempt')
    );
  end if;

  return claim;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Grants
-- ---------------------------------------------------------------------------
--
-- O Postgres concede EXECUTE a PUBLIC em toda função nova. As peças internas
-- não são executáveis por ninguém pela API; as operações, só pela service role.
revoke all on function public.enqueue_reservation_reschedule_email() from public, anon, authenticated, service_role;
revoke all on function public.reservation_reschedule_email_rejection(uuid) from public, anon, authenticated, service_role;
revoke all on function public.reservation_reschedule_email_payload(uuid) from public, anon, authenticated, service_role;
revoke all on function public.reservation_reschedule_email_take(uuid, integer, integer, text, uuid) from public, anon, authenticated, service_role;

revoke all on function public.claim_reservation_reschedule_email(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.claim_pending_reservation_reschedule_emails(integer, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_reservation_reschedule_email(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fail_reservation_reschedule_email(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_reservation_reschedule_emails(uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_claim_reservation_reschedule_email(uuid, uuid, integer) from public, anon, authenticated;

grant execute on function public.claim_reservation_reschedule_email(uuid, integer, integer) to service_role;
grant execute on function public.claim_pending_reservation_reschedule_emails(integer, integer, integer) to service_role;
grant execute on function public.complete_reservation_reschedule_email(uuid, uuid) to service_role;
grant execute on function public.fail_reservation_reschedule_email(uuid, uuid, text) to service_role;
grant execute on function public.admin_reservation_reschedule_emails(uuid, uuid) to service_role;
grant execute on function public.admin_claim_reservation_reschedule_email(uuid, uuid, integer) to service_role;
