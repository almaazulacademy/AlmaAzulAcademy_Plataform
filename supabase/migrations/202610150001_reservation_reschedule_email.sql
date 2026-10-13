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
--   QUEUED    — nasceu com o reagendamento; ninguém tentou enviar ainda.
--   SENDING   — reivindicado; ninguém mais pode enviar até `locked_until`.
--   SENT      — o provedor aceitou. Definitivo.
--   FAILED    — a última tentativa não deu certo. Volta sozinho à fila, depois
--               de `next_attempt_at`, enquanto houver tentativa; depois espera
--               uma pessoa.
--   UNCERTAIN — não se sabe se o e-mail saiu, e já não há como perguntar ao
--               provedor sem arriscar uma segunda entrega. Nada é enviado
--               sozinho daqui em diante: só uma pessoa decide reenviar.
--   SKIPPED   — não enviado de propósito, e nunca será: `last_error_code` diz o
--               motivo (a reserva saiu da turma, foi cancelada, ou a turma já
--               começou). Definitivo.
--
-- ## Idempotência no provedor: gerações
--
-- "Não deu certo" esconde três situações diferentes, e a fila as trata de formas
-- diferentes:
--
--   REJECTED — o provedor respondeu recusando (4xx). O e-mail comprovadamente
--              não saiu.
--   UNKNOWN  — timeout, erro de rede, 5xx, prazo vencido no meio do envio, ou o
--              provedor recusando a chave (409). O e-mail pode ter saído.
--              **Nunca é tratado como "não enviado".**
--   SENT     — o provedor aceitou.
--
-- Uma *geração* é um conjunto de tentativas que compartilham a mesma chave de
-- idempotência e a mesma mensagem, byte a byte (`frozen_message`). Enquanto uma
-- geração tem alguma tentativa UNKNOWN, toda nova tentativa reusa a chave e a
-- mensagem — é o que faz o provedor reconhecer a repetição e não entregar de
-- novo, mesmo que o template ou o nome do cliente tenham mudado nesse meio-tempo.
--
-- Só começa geração nova, com chave nova e mensagem renderizada de novo, quando:
--
--   * a geração atual só teve recusas comprovadas (nada saiu com aquela chave);
--   * o destinatário ou os dados da turma mudaram (`content_fingerprint`): é
--     outra entrega — outro endereço, ou uma correção do que foi informado;
--   * uma pessoa pede o reenvio de um e-mail UNCERTAIN.
--
-- A chave do provedor vale por tempo limitado. Passada a janela com resultado
-- ainda desconhecido, a fila para e marca UNCERTAIN em vez de reenviar às cegas.

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
  -- Espera entre tentativas automáticas. Um reenvio pedido por uma pessoa a ignora.
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  sent_at timestamptz,

  -- A geração atual: a chave de idempotência em uso no provedor, desde quando,
  -- se alguma tentativa dela ficou sem resultado conhecido, de que dados ela foi
  -- montada e a mensagem exata que foi (ou pode ter sido) enviada.
  generation integer not null default 0,
  generation_started_at timestamptz,
  generation_uncertain boolean not null default false,
  content_fingerprint text,
  -- Contém o nome e o e-mail do cliente. Existe só enquanto pode ser preciso
  -- repetir o envio; é apagada quando o e-mail é concluído ou descartado.
  frozen_message jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$ begin
  alter table public.reservation_reschedule_emails
    add constraint reservation_reschedule_emails_status_allowed
    check (status in ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'UNCERTAIN', 'SKIPPED'));
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
    add constraint reservation_reschedule_emails_counters_valid
    check (attempts >= 0 and generation >= 0 and generation <= attempts);
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

-- A mensagem congelada tem exatamente os quatro campos de um e-mail e só existe
-- enquanto ainda pode ser repetida: some quando o e-mail é concluído,
-- descartado ou entregue à decisão de uma pessoa.
do $$ begin
  alter table public.reservation_reschedule_emails
    add constraint reservation_reschedule_emails_frozen_message_valid
    check (
      frozen_message is null
      or (
        status not in ('SENT', 'SKIPPED', 'UNCERTAIN')
        and jsonb_typeof(frozen_message) = 'object'
        and jsonb_typeof(frozen_message -> 'to') = 'string'
        and jsonb_typeof(frozen_message -> 'subject') = 'string'
        and jsonb_typeof(frozen_message -> 'html') = 'string'
        and jsonb_typeof(frozen_message -> 'text') = 'string'
      )
    );
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
  where status in ('QUEUED', 'SENDING', 'FAILED', 'UNCERTAIN');

drop trigger if exists reservation_reschedule_emails_set_updated_at on public.reservation_reschedule_emails;
create trigger reservation_reschedule_emails_set_updated_at
  before update on public.reservation_reschedule_emails
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Registro das tentativas
-- ---------------------------------------------------------------------------
--
-- Uma linha por tentativa iniciada: quando começou, por onde, com que chave
-- (`generation`), como terminou e com que erro. `claim_token` identifica a
-- tentativa para quem a iniciou — é o que permite aceitar a conclusão de um
-- envio que respondeu depois do prazo e recusar a falha de um envio que já não é
-- o atual.
create table if not exists public.reservation_reschedule_email_attempts (
  id uuid primary key default gen_random_uuid(),
  email_id uuid not null references public.reservation_reschedule_emails(id) on delete cascade,
  attempt integer not null,
  generation integer not null,
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
    check (outcome is null or outcome in ('SENT', 'REJECTED', 'UNKNOWN', 'KEY_REFUSED', 'LEASE_EXPIRED'));
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
    check ((outcome is null) = (finished_at is null) and attempt > 0 and generation > 0);
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

-- Resumo do que, se mudar, faz o e-mail ser *outra entrega*: para quem vai e o
-- que ele informa sobre a turma. O nome do cliente e o layout ficam de fora de
-- propósito — mudar um deles entre duas tentativas não justifica arriscar um
-- segundo e-mail. Lê as tabelas, e não o JSON do payload, para o resultado não
-- depender do fuso da conexão.
create or replace function public.reservation_reschedule_email_fingerprint(p_email_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select md5(concat_ws('|',
    lower(trim(coalesce(r.email, ''))),
    r.public_code,
    r.quantity::text,
    coalesce(r.checkin_token::text, ''),
    s.id::text,
    extract(epoch from s.starts_at)::text,
    e.title,
    coalesce(b.slug, ''),
    coalesce(b.name, ''),
    coalesce(b.meeting_point, ''),
    coalesce(b.address, ''),
    coalesce(b.maps_url, '')
  ))
  from public.reservation_reschedule_emails q
  join public.reservations r on r.id = q.reservation_id
  join public.sessions s on s.id = r.session_id
  join public.experiences e on e.id = r.experience_id
  left join public.bases b on b.id = e.base_id
  where q.id = p_email_id;
$$;

-- O núcleo da fila. Toda reivindicação — a imediata, a da rotina e a do painel
-- — passa por aqui, e só por aqui.
--
-- ## Locks
--
-- A reserva é travada primeiro, em modo compartilhado, depois a linha da fila —
-- sempre nesta ordem, que é também a das operações de Stand-by (reserva antes de
-- tudo). Como nenhuma função trava a linha da fila antes da reserva, não há
-- ciclo de espera possível.
--
-- Com a reserva travada, um cancelamento, uma volta ao Stand-by ou uma troca de
-- turma que esteja em andamento termina antes de esta função decidir, e nenhum
-- começa enquanto ela decide. A espera pela reserva é limitada (`lock_timeout`):
-- se não vier, a função falha e nada é enviado.
--
-- A linha da fila é pega com `skip locked`: se outra instância já a tem —
-- reivindicando, concluindo ou registrando uma falha — esta devolve null em vez
-- de esperar. Quem recebe null não envia.
--
-- `p_max_attempts` null é o reenvio pedido por uma pessoa: sem teto, sem espera
-- entre tentativas e com direito a reabrir um e-mail UNCERTAIN.
create or replace function public.reservation_reschedule_email_take(
  p_email_id uuid,
  p_max_attempts integer,
  p_lease_minutes integer,
  p_window_minutes integer,
  p_source text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '3s'
as $$
declare
  queued public.reservation_reschedule_emails%rowtype;
  owner_reservation uuid;
  rejection text;
  token uuid;
  fingerprint text;
  fresh boolean;
  manual boolean := p_max_attempts is null;
  lease interval := make_interval(mins => least(greatest(coalesce(p_lease_minutes, 2), 1), 120));
  idempotency_window interval := make_interval(mins => least(greatest(coalesce(p_window_minutes, 1380), 1), 1440));
begin
  select q.reservation_id into owner_reservation from public.reservation_reschedule_emails q where q.id = p_email_id;
  if not found then return null; end if;

  perform 1 from public.reservations r where r.id = owner_reservation for share;
  select * into queued from public.reservation_reschedule_emails where id = p_email_id for update skip locked;
  if not found then return null; end if;

  if queued.status in ('SENT', 'SKIPPED') then return null; end if;
  if queued.status = 'SENDING' and queued.locked_until > now() then return null; end if;

  -- Prazo vencido sem resposta. Se a tentativa chegou a congelar a mensagem, ela
  -- pode ter enviado: o resultado é desconhecido, e a geração fica marcada.
  if queued.status = 'SENDING' then
    update public.reservation_reschedule_email_attempts
    set finished_at = now(), outcome = 'LEASE_EXPIRED'
    where email_id = queued.id and attempt = queued.attempts and outcome is null;

    update public.reservation_reschedule_emails
    set status = 'FAILED',
        last_error_code = 'LEASE_EXPIRED',
        locked_until = null,
        generation_uncertain = generation_uncertain or frozen_message is not null
    where id = queued.id
    returning * into queued;
  end if;

  rejection := public.reservation_reschedule_email_rejection(queued.id);
  if rejection is not null then
    update public.reservation_reschedule_emails
    set status = 'SKIPPED', last_error_code = rejection, locked_until = null, next_attempt_at = null, frozen_message = null
    where id = queued.id;
    return null;
  end if;

  if not manual then
    if queued.status = 'UNCERTAIN' then return null; end if;
    if queued.attempts >= greatest(p_max_attempts, 1) then return null; end if;
    if queued.next_attempt_at is not null and queued.next_attempt_at > now() then return null; end if;
  end if;

  fingerprint := public.reservation_reschedule_email_fingerprint(queued.id);

  -- Geração nova quando nada pode ter saído com a chave atual, ou quando o que
  -- seria enviado agora é outra entrega.
  fresh := queued.generation = 0
        or queued.frozen_message is null
        or not queued.generation_uncertain
        or queued.content_fingerprint is distinct from fingerprint;

  -- Mesma entrega, resultado desconhecido, e o provedor já não deduplica:
  -- reenviar sozinho seria apostar. Só uma pessoa decide.
  if not fresh and queued.generation_started_at + idempotency_window <= now() then
    if not manual then
      update public.reservation_reschedule_emails
      set status = 'UNCERTAIN', last_error_code = 'IDEMPOTENCY_WINDOW_EXPIRED', next_attempt_at = null, frozen_message = null
      where id = queued.id;
      return null;
    end if;
    fresh := true;
  end if;

  insert into public.reservation_reschedule_email_attempts (email_id, attempt, generation, source, actor_user_id)
  values (
    queued.id,
    queued.attempts + 1,
    case when fresh then queued.generation + 1 else queued.generation end,
    p_source,
    p_actor_id
  )
  returning claim_token into token;

  update public.reservation_reschedule_emails
  set status = 'SENDING',
      attempts = attempts + 1,
      locked_until = now() + lease,
      last_attempt_at = now(),
      next_attempt_at = null,
      generation = case when fresh then generation + 1 else generation end,
      generation_started_at = case when fresh then now() else generation_started_at end,
      generation_uncertain = case when fresh then false else generation_uncertain end,
      content_fingerprint = case when fresh then fingerprint else content_fingerprint end,
      frozen_message = case when fresh then null else frozen_message end
  where id = queued.id
  returning * into queued;

  -- `message` vem preenchida quando a tentativa repete uma geração: é ela, e não
  -- uma renderização nova, que precisa ser enviada.
  return jsonb_build_object(
    'emailId', queued.id,
    'claimToken', token,
    'attempt', queued.attempts,
    'generation', queued.generation,
    'reservationId', queued.reservation_id,
    'changeId', queued.change_id,
    'message', queued.frozen_message,
    'payload', public.reservation_reschedule_email_payload(queued.id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Operações da fila (service role)
-- ---------------------------------------------------------------------------

-- Reivindica o e-mail de um reagendamento específico. É o que o servidor chama
-- logo depois de o reagendamento ser gravado. Devolve null quando não há o que
-- enviar agora: já enviado, envio em curso, espera entre tentativas, tentativas
-- esgotadas, reserva que não está mais naquela turma — ou reagendamento que
-- nunca existiu.
create or replace function public.claim_reservation_reschedule_email(
  p_change_id uuid,
  p_max_attempts integer,
  p_lease_minutes integer,
  p_window_minutes integer
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
    email_id, greatest(coalesce(p_max_attempts, 6), 1), p_lease_minutes, p_window_minutes, 'RESCHEDULE', null
  );
end;
$$;

-- Reivindica pendências: nunca tentadas, falhas com tentativa sobrando e espera
-- cumprida, e envios cujo prazo venceu sem resposta. A consulta só escolhe os
-- candidatos, sem travar nada; quem trava — reserva, depois a linha da fila — é
-- o núcleo, um por vez. Duas execuções simultâneas dividem a fila: a linha que
-- uma pegou a outra pula. Uma reserva presa em outra transação não derruba o
-- lote: aquele e-mail fica para a próxima execução. Devolve um array com as
-- reivindicações obtidas.
create or replace function public.claim_pending_reservation_reschedule_emails(
  p_limit integer,
  p_max_attempts integer,
  p_lease_minutes integer,
  p_window_minutes integer
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
  max_attempts integer := greatest(coalesce(p_max_attempts, 6), 1);
begin
  for candidate in
    select q.id
    from public.reservation_reschedule_emails q
    where q.status = 'QUEUED'
       or (q.status = 'FAILED' and q.attempts < max_attempts and (q.next_attempt_at is null or q.next_attempt_at <= now()))
       or (q.status = 'SENDING' and q.locked_until <= now())
    order by q.created_at, q.id
    limit least(greatest(coalesce(p_limit, 1), 0), 25)
  loop
    begin
      claim := public.reservation_reschedule_email_take(candidate.id, max_attempts, p_lease_minutes, p_window_minutes, 'RETRY', null);
    exception when lock_not_available then
      claim := null;
    end;
    if claim is not null then
      claims := claims || jsonb_build_array(claim);
    end if;
  end loop;

  return claims;
end;
$$;

-- Congela a mensagem de uma geração nova, **antes** do envio. A partir daqui,
-- toda tentativa desta geração envia exatamente estes bytes. Só a tentativa em
-- curso congela, só uma vez, e só para o e-mail cadastrado na reserva: a
-- aplicação não tem como fazer a fila escrever para outro endereço.
create or replace function public.freeze_reservation_reschedule_email(
  p_email_id uuid,
  p_claim_token uuid,
  p_message jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  queued public.reservation_reschedule_emails%rowtype;
  attempted public.reservation_reschedule_email_attempts%rowtype;
  recipient text;
begin
  select * into queued from public.reservation_reschedule_emails where id = p_email_id for update;
  if not found then return false; end if;

  select * into attempted
  from public.reservation_reschedule_email_attempts a
  where a.email_id = p_email_id and a.claim_token = p_claim_token;
  if not found or attempted.outcome is not null then return false; end if;

  if queued.status <> 'SENDING'
     or queued.attempts <> attempted.attempt
     or queued.generation <> attempted.generation
     or queued.frozen_message is not null then
    return false;
  end if;

  if p_message is null
     or jsonb_typeof(p_message) <> 'object'
     or coalesce(p_message ->> 'to', '') = ''
     or coalesce(p_message ->> 'subject', '') = ''
     or coalesce(p_message ->> 'html', '') = ''
     or coalesce(p_message ->> 'text', '') = ''
     or length(p_message ->> 'html') > 500000
     or length(p_message ->> 'text') > 100000 then
    return false;
  end if;

  select lower(trim(r.email)) into recipient from public.reservations r where r.id = queued.reservation_id;
  if recipient is null or lower(trim(p_message ->> 'to')) <> recipient then return false; end if;

  update public.reservation_reschedule_emails
  set frozen_message = jsonb_build_object(
        'to', p_message ->> 'to',
        'subject', p_message ->> 'subject',
        'html', p_message ->> 'html',
        'text', p_message ->> 'text'
      )
  where id = queued.id;

  return true;
end;
$$;

-- O provedor aceitou. Vale também para a tentativa que respondeu depois do
-- prazo: o e-mail saiu, e é isso que a fila precisa saber para ninguém mais
-- enviar. A mensagem congelada é apagada: não há mais o que repetir.
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
    set status = 'SENT',
        sent_at = now(),
        last_error_code = null,
        locked_until = null,
        next_attempt_at = null,
        frozen_message = null
    where id = queued.id;
  end if;

  return true;
end;
$$;

-- A tentativa não deu certo. `p_outcome` diz o que se sabe:
--
--   REJECTED    — o provedor recusou: nada saiu.
--   UNKNOWN     — não se sabe se saiu. A geração fica marcada como incerta, e as
--                 próximas tentativas reusam a chave e a mensagem.
--   KEY_REFUSED — o provedor recusou a chave de idempotência. Há dois motivos
--                 possíveis, e quem enviou não sabe qual: outro pedido com a
--                 chave ainda em curso (passa sozinho) ou a chave já usada com
--                 outro corpo (não passa nunca). Na primeira vez, vale repetir,
--                 como em UNKNOWN. Na segunda vez **na mesma geração**, já não
--                 é pedido em curso: o e-mail vai para UNCERTAIN.
--
-- Qualquer outro valor é lido como UNKNOWN: na dúvida, a fila nunca conclui que
-- o e-mail não saiu.
--
-- Só é gravado um símbolo curto: o que não tiver esse formato — a resposta do
-- provedor, uma mensagem com endereço de e-mail — vira UNKNOWN_ERROR, sem que
-- nenhum pedaço do texto original seja guardado. Só a tentativa atual devolve o
-- e-mail à fila — a falha de uma tentativa antiga fica no registro, mas não
-- desfaz um envio concluído nem solta um envio em curso.
create or replace function public.fail_reservation_reschedule_email(
  p_email_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_outcome text,
  p_retry_after_seconds integer
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
  kind text := upper(trim(coalesce(p_outcome, '')));
  retry_after interval := make_interval(secs => least(greatest(coalesce(p_retry_after_seconds, 0), 0), 86400));
  key_conflict boolean := false;
begin
  if normalized !~ '^[A-Z0-9_]{1,64}$' then
    normalized := 'UNKNOWN_ERROR';
  end if;
  if kind not in ('REJECTED', 'UNKNOWN', 'KEY_REFUSED') then
    kind := 'UNKNOWN';
  end if;

  select * into queued from public.reservation_reschedule_emails where id = p_email_id for update;
  if not found then return false; end if;

  select * into attempted
  from public.reservation_reschedule_email_attempts a
  where a.email_id = p_email_id and a.claim_token = p_claim_token;
  if not found or attempted.outcome in ('SENT', 'REJECTED', 'UNKNOWN', 'KEY_REFUSED') then return false; end if;

  -- Segunda recusa da mesma chave: um pedido em curso já teria terminado.
  key_conflict := kind = 'KEY_REFUSED' and exists (
    select 1 from public.reservation_reschedule_email_attempts earlier
    where earlier.email_id = attempted.email_id
      and earlier.generation = attempted.generation
      and earlier.id <> attempted.id
      and earlier.outcome = 'KEY_REFUSED'
  );

  update public.reservation_reschedule_email_attempts
  set finished_at = coalesce(finished_at, now()),
      outcome = kind,
      error_code = normalized
  where id = attempted.id;

  if queued.status in ('SENT', 'SKIPPED') then return true; end if;

  -- A incerteza é da geração: vale mesmo que a tentativa já não seja a atual.
  if kind <> 'REJECTED' and attempted.generation = queued.generation then
    update public.reservation_reschedule_emails
    set generation_uncertain = true
    where id = queued.id;
  end if;

  -- FAILED aqui é a tentativa atual encerrada por prazo vencido: o erro real
  -- chegou atrasado e substitui o LEASE_EXPIRED.
  if queued.attempts = attempted.attempt and queued.status in ('SENDING', 'FAILED') then
    update public.reservation_reschedule_emails
    set status = case when key_conflict then 'UNCERTAIN' else 'FAILED' end,
        last_error_code = case when key_conflict then 'IDEMPOTENCY_CONFLICT' else normalized end,
        locked_until = null,
        next_attempt_at = case when key_conflict then null else now() + retry_after end,
        frozen_message = case when key_conflict then null else frozen_message end
    where id = queued.id;
  end if;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Painel
-- ---------------------------------------------------------------------------

-- Estado do e-mail de cada reagendamento da reserva, o mais recente primeiro.
-- Só estado: nenhum dado do cliente, nenhum token e nunca a mensagem congelada.
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
      'nextAttemptAt', q.next_attempt_at,
      'sentAt', q.sent_at,
      'createdAt', q.created_at
    ) order by q.created_at desc, q.id)
    from public.reservation_reschedule_emails q
    where q.reservation_id = p_reservation_id
  ), '[]'::jsonb);
end;
$$;

-- "Clientes que ainda não receberam a confirmação": e-mails que não saíram e
-- ainda fazem sentido — reserva confirmada naquela turma, turma no futuro. A
-- turma mais próxima vem primeiro. Traz o contato porque é para a equipe avisar
-- o cliente por outro canal; nunca CPF nem a mensagem congelada.
create or replace function public.admin_list_undelivered_reschedule_emails(
  p_actor_id uuid,
  p_limit integer
)
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

  with pending as (
    select q.id, q.reservation_id, q.status, q.attempts, q.last_error_code, q.next_attempt_at, q.created_at,
           q.status = 'SENDING' and q.locked_until > now() as in_flight,
           r.public_code, r.full_name, r.phone,
           s.starts_at, e.title as experience_title, coalesce(b.name, '') as base_name
    from public.reservation_reschedule_emails q
    join public.reservations r on r.id = q.reservation_id
    join public.sessions s on s.id = q.target_session_id
    join public.experiences e on e.id = s.experience_id
    left join public.bases b on b.id = e.base_id
    where q.status in ('QUEUED', 'SENDING', 'FAILED', 'UNCERTAIN')
      and r.status = 'CONFIRMED'
      and r.session_id = q.target_session_id
      and s.starts_at > now()
  )
  select jsonb_build_object(
    'total', (select count(*) from pending),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'emailId', p.id,
        'reservationId', p.reservation_id,
        'publicCode', p.public_code,
        'fullName', p.full_name,
        'phone', p.phone,
        'status', p.status,
        'inFlight', p.in_flight,
        'attempts', p.attempts,
        'lastErrorCode', p.last_error_code,
        'nextAttemptAt', p.next_attempt_at,
        'rescheduledAt', p.created_at,
        'targetStartsAt', p.starts_at,
        'experienceTitle', p.experience_title,
        'baseName', p.base_name
      ) order by p.starts_at, p.id)
      from (select * from pending order by starts_at, id limit least(greatest(coalesce(p_limit, 20), 1), 100)) p
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

-- "Reenviar e-mail de reagendamento": reivindica o e-mail do reagendamento mais
-- recente da reserva, sem teto de tentativas — é uma pessoa pedindo. As demais
-- regras são as mesmas: enviado não reenvia, envio em curso não é atropelado e
-- reserva que saiu daquela turma não recebe. É também o único caminho que reabre
-- um e-mail UNCERTAIN, e isso fica registrado na auditoria.
create or replace function public.admin_claim_reservation_reschedule_email(
  p_actor_id uuid,
  p_reservation_id uuid,
  p_lease_minutes integer,
  p_window_minutes integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  latest_id uuid;
  previous_status text;
  claim jsonb;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  select q.id, q.status into latest_id, previous_status
  from public.reservation_reschedule_emails q
  where q.reservation_id = p_reservation_id
  order by q.created_at desc, q.id
  limit 1;
  if not found then return null; end if;

  claim := public.reservation_reschedule_email_take(latest_id, null, p_lease_minutes, p_window_minutes, 'ADMIN', p_actor_id);

  if claim is not null then
    insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
    values (
      p_actor_id,
      'RESERVATION_RESCHEDULE_EMAIL_RESEND',
      'RESERVATION',
      p_reservation_id,
      jsonb_build_object(
        'emailId', latest_id,
        'attempt', claim -> 'attempt',
        'generation', claim -> 'generation',
        'previousStatus', previous_status
      )
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
revoke all on function public.reservation_reschedule_email_fingerprint(uuid) from public, anon, authenticated, service_role;
revoke all on function public.reservation_reschedule_email_take(uuid, integer, integer, integer, text, uuid) from public, anon, authenticated, service_role;

revoke all on function public.claim_reservation_reschedule_email(uuid, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.claim_pending_reservation_reschedule_emails(integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.freeze_reservation_reschedule_email(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.complete_reservation_reschedule_email(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fail_reservation_reschedule_email(uuid, uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.admin_reservation_reschedule_emails(uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_list_undelivered_reschedule_emails(uuid, integer) from public, anon, authenticated;
revoke all on function public.admin_claim_reservation_reschedule_email(uuid, uuid, integer, integer) from public, anon, authenticated;

grant execute on function public.claim_reservation_reschedule_email(uuid, integer, integer, integer) to service_role;
grant execute on function public.claim_pending_reservation_reschedule_emails(integer, integer, integer, integer) to service_role;
grant execute on function public.freeze_reservation_reschedule_email(uuid, uuid, jsonb) to service_role;
grant execute on function public.complete_reservation_reschedule_email(uuid, uuid) to service_role;
grant execute on function public.fail_reservation_reschedule_email(uuid, uuid, text, text, integer) to service_role;
grant execute on function public.admin_reservation_reschedule_emails(uuid, uuid) to service_role;
grant execute on function public.admin_list_undelivered_reschedule_emails(uuid, integer) to service_role;
grant execute on function public.admin_claim_reservation_reschedule_email(uuid, uuid, integer, integer) to service_role;
