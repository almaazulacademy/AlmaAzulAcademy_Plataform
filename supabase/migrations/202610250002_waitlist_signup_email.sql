-- Lista de espera — fase 3: a fila do e-mail de confirmação da inscrição.
--
-- Depende de `202610250001_waitlist_foundation.sql`. Aditiva e idempotente.
-- **Não substitui o corpo de nenhuma função existente** — nem as da fase 1 —,
-- não cria trigger e não toca linha existente. Acrescenta duas colunas às
-- tabelas da fila da fase 1 e as funções que a operam.
--
-- Depois de aplicada, nada sai sozinho: só o servidor envia, e só com
-- `WAITLIST_SIGNUP_ENABLED=true` e o provedor de e-mail configurado.
--
-- ## O protocolo
--
-- O mesmo da fila do e-mail de reagendamento (`202610150001`), aplicado à linha
-- `JOINED` que `waitlist_join` grava na mesma transação da inscrição:
--
--   * **Reivindicação exclusiva com prazo.** Só envia quem reivindica; a linha
--     fica `SENDING` até `locked_until`. Duas instâncias nunca enviam o mesmo
--     e-mail ao mesmo tempo.
--   * **Mensagem congelada antes do envio.** Enquanto uma geração tiver alguma
--     tentativa de resultado desconhecido, toda nova tentativa manda exatamente
--     a mensagem gravada, com a mesma chave de idempotência — é o que faz o
--     provedor reconhecer a repetição. Chave nova só depois de recusa comprovada.
--   * **Desconhecido nunca vira "não enviado".** Duas recusas da chave na mesma
--     geração, ou a janela de 23 horas vencida com resultado desconhecido, param
--     a fila em `UNCERTAIN`: nada sai sozinho.
--   * **Só se ainda fizer sentido.** Antes de cada tentativa: inscrição ativa,
--     não anonimizada, turma ainda não iniciada, nem cancelada, nem arquivada.
--     Senão, `SKIPPED` com o motivo.
--
-- Ordem dos locks: a inscrição (compartilhado) e depois a linha da fila — a
-- mesma do cancelamento e da remoção da fase 1, que travam a inscrição antes de
-- descartar os avisos dela. Sem ciclo de espera possível.
--
-- Só `JOINED` é operado aqui. `SPOT_AVAILABLE` (aviso de vaga) é da fase 6.

-- ---------------------------------------------------------------------------
-- 1. Estado da geração e token por tentativa
-- ---------------------------------------------------------------------------

-- Alguma tentativa da geração atual pode ter saído: as próximas repetem a mesma
-- chave e a mesma mensagem.
alter table public.waitlist_notifications add column if not exists generation_uncertain boolean not null default false;
-- Quando a geração atual começou: a janela de idempotência do provedor conta daí.
alter table public.waitlist_notifications add column if not exists generation_started_at timestamptz;
-- O token de cada tentativa. Uma tentativa que responde depois do prazo ainda
-- consegue registrar que o e-mail saiu.
alter table public.waitlist_notification_attempts add column if not exists claim_token uuid;

create unique index if not exists waitlist_notification_attempts_token_key
  on public.waitlist_notification_attempts (claim_token) where claim_token is not null;

-- ---------------------------------------------------------------------------
-- 2. Apoio interno
-- ---------------------------------------------------------------------------

-- Por que este e-mail não deve mais sair, ou null se deve.
create or replace function public.waitlist_notification_rejection(p_notification_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when we.id is null or we.anonymized_at is not null or we.status <> 'ACTIVE' then 'ENTRY_CLOSED'
    when s.starts_at <= now() then 'SESSION_STARTED'
    when s.status::text in ('CANCELLED', 'ARCHIVED') then 'SESSION_UNAVAILABLE'
    else null
  end
  from public.waitlist_notifications n
  left join public.waitlist_entries we on we.id = n.entry_id
  left join public.sessions s on s.id = we.session_id
  where n.id = p_notification_id;
$$;

-- O que o servidor precisa para montar o e-mail. Inclui o token do link de
-- cancelamento, recalculado aqui (nunca guardado); só a service role chega a
-- ele, pela reivindicação.
create or replace function public.waitlist_notification_payload(p_notification_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'notificationId', n.id,
    'kind', n.kind,
    'entryId', we.id,
    'fullName', we.full_name,
    'email', we.email,
    'quantity', we.quantity,
    'sessionId', s.id,
    'startsAt', s.starts_at,
    'durationMinutes', s.duration_minutes,
    'experienceTitle', e.title,
    'experienceSlug', e.slug,
    'baseName', coalesce(b.name, ''),
    'cancelToken', public.waitlist_cancel_token(we.id)
  )
  from public.waitlist_notifications n
  join public.waitlist_entries we on we.id = n.entry_id
  join public.sessions s on s.id = we.session_id
  join public.experiences e on e.id = s.experience_id
  left join public.bases b on b.id = e.base_id
  where n.id = p_notification_id;
$$;

-- O núcleo da reivindicação. Devolve null quando não há o que enviar agora.
create or replace function public.waitlist_notification_take(
  p_notification_id uuid,
  p_max_attempts integer,
  p_lease_minutes integer,
  p_window_minutes integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '3s'
as $$
declare
  queued public.waitlist_notifications%rowtype;
  owner_entry uuid;
  rejection text;
  token uuid := gen_random_uuid();
  fresh boolean;
  max_attempts integer := least(greatest(coalesce(p_max_attempts, 6), 1), 20);
  lease interval := make_interval(mins => least(greatest(coalesce(p_lease_minutes, 2), 1), 120));
  idempotency_window interval := make_interval(mins => least(greatest(coalesce(p_window_minutes, 1380), 1), 1440));
begin
  select n.entry_id into owner_entry from public.waitlist_notifications n where n.id = p_notification_id and n.kind = 'JOINED';
  if not found then return null; end if;

  perform 1 from public.waitlist_entries we where we.id = owner_entry for share;
  select * into queued from public.waitlist_notifications where id = p_notification_id for update skip locked;
  if not found then return null; end if;

  if queued.status in ('SENT', 'SKIPPED', 'UNCERTAIN') then return null; end if;
  if queued.status = 'SENDING' and queued.locked_until > now() then return null; end if;

  -- Prazo vencido sem resposta. Se a mensagem chegou a ser congelada, o envio
  -- pode ter acontecido: a geração fica marcada como incerta.
  if queued.status = 'SENDING' then
    update public.waitlist_notification_attempts
    set finished_at = now(), error_code = 'LEASE_EXPIRED'
    where notification_id = queued.id and attempt = queued.attempts and outcome is null and finished_at is null;

    update public.waitlist_notifications
    set status = 'FAILED',
        last_error_code = 'LEASE_EXPIRED',
        locked_until = null,
        claim_token = null,
        generation_uncertain = generation_uncertain or frozen_message is not null
    where id = queued.id
    returning * into queued;
  end if;

  rejection := public.waitlist_notification_rejection(queued.id);
  if rejection is not null then
    update public.waitlist_notifications
    set status = 'SKIPPED', skipped_at = now(), skip_reason = rejection,
        locked_until = null, claim_token = null, frozen_message = null
    where id = queued.id;
    return null;
  end if;

  if queued.attempts >= max_attempts then return null; end if;
  if queued.status = 'FAILED' and queued.next_attempt_at > now() then return null; end if;

  -- Geração nova quando nada pode ter saído com a chave atual.
  fresh := queued.attempts = 0 or queued.frozen_message is null or not queued.generation_uncertain;

  -- Mesma entrega com resultado desconhecido e a chave já fora da janela do
  -- provedor: repetir poderia entregar de novo. Para aqui.
  if not fresh and queued.generation_started_at + idempotency_window <= now() then
    update public.waitlist_notifications
    set status = 'UNCERTAIN', last_error_code = 'IDEMPOTENCY_WINDOW_EXPIRED',
        locked_until = null, claim_token = null, frozen_message = null
    where id = queued.id;
    return null;
  end if;

  update public.waitlist_notifications
  set status = 'SENDING',
      attempts = attempts + 1,
      locked_until = now() + lease,
      claim_token = token,
      generation = case when fresh and queued.attempts > 0 then generation + 1 else generation end,
      generation_started_at = case when fresh then now() else generation_started_at end,
      generation_uncertain = case when fresh then false else generation_uncertain end,
      frozen_message = case when fresh then null else frozen_message end
  where id = queued.id
  returning * into queued;

  insert into public.waitlist_notification_attempts (notification_id, attempt, generation, claim_token)
  values (queued.id, queued.attempts, queued.generation, token);

  -- `message` vem preenchida quando a tentativa repete uma geração: é ela, e não
  -- uma renderização nova, que precisa ser enviada.
  return jsonb_build_object(
    'notificationId', queued.id,
    'claimToken', token,
    'attempt', queued.attempts,
    'generation', queued.generation,
    'message', queued.frozen_message,
    'payload', public.waitlist_notification_payload(queued.id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Operações da fila (service role)
-- ---------------------------------------------------------------------------

-- A confirmação de uma inscrição, pela turma e pelo e-mail: é o que a rota de
-- inscrição chama logo depois de gravar. A resposta da inscrição é a mesma para
-- quem já estava inscrito, e aqui também nada muda: o e-mail que já saiu não é
-- reivindicado de novo. Null quando não há o que enviar.
create or replace function public.claim_waitlist_joined_email(
  p_session_id uuid,
  p_email text,
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
  notification_id uuid;
begin
  select n.id into notification_id
  from public.waitlist_entries we
  join public.waitlist_notifications n on n.entry_id = we.id and n.kind = 'JOINED'
  where we.session_id = p_session_id
    and we.email = lower(trim(coalesce(p_email, '')))
    and we.status = 'ACTIVE';
  if not found then return null; end if;

  begin
    return public.waitlist_notification_take(notification_id, p_max_attempts, p_lease_minutes, p_window_minutes);
  exception when lock_not_available then
    return null;
  end;
end;
$$;

-- Pendências: nunca tentadas, falhas com tentativa sobrando e espera cumprida, e
-- envios cujo prazo venceu. A escolha não trava nada; quem trava é o núcleo, um
-- por vez, e duas execuções simultâneas dividem a fila. Array das obtidas.
create or replace function public.claim_pending_waitlist_emails(
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
  max_attempts integer := least(greatest(coalesce(p_max_attempts, 6), 1), 20);
begin
  for candidate in
    select n.id
    from public.waitlist_notifications n
    where n.kind = 'JOINED'
      and (
        n.status = 'QUEUED'
        or (n.status = 'FAILED' and n.attempts < max_attempts and n.next_attempt_at <= now())
        or (n.status = 'SENDING' and n.locked_until <= now())
      )
    order by n.created_at, n.id
    limit least(greatest(coalesce(p_limit, 1), 0), 25)
  loop
    begin
      claim := public.waitlist_notification_take(candidate.id, max_attempts, p_lease_minutes, p_window_minutes);
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

-- Congela a mensagem de uma geração nova, antes do envio. Só a tentativa em
-- curso, só uma vez, e só para o e-mail da própria inscrição: a aplicação não
-- tem como fazer a fila escrever para outro endereço.
create or replace function public.freeze_waitlist_email(
  p_notification_id uuid,
  p_claim_token uuid,
  p_message jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  queued public.waitlist_notifications%rowtype;
  attempted public.waitlist_notification_attempts%rowtype;
  recipient text;
begin
  select * into queued from public.waitlist_notifications where id = p_notification_id for update;
  if not found then return false; end if;

  select * into attempted from public.waitlist_notification_attempts a
  where a.notification_id = p_notification_id and a.claim_token = p_claim_token;
  if not found or attempted.outcome is not null or attempted.finished_at is not null then return false; end if;

  if queued.status <> 'SENDING'
     or queued.claim_token is distinct from p_claim_token
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

  select we.email into recipient from public.waitlist_entries we where we.id = queued.entry_id;
  if recipient is null or lower(trim(p_message ->> 'to')) <> recipient then return false; end if;

  update public.waitlist_notifications
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
-- enviar. Nada de pessoal fica: a mensagem congelada é apagada.
create or replace function public.complete_waitlist_email(
  p_notification_id uuid,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  queued public.waitlist_notifications%rowtype;
  attempt_id uuid;
begin
  select * into queued from public.waitlist_notifications where id = p_notification_id for update;
  if not found then return false; end if;

  select a.id into attempt_id from public.waitlist_notification_attempts a
  where a.notification_id = p_notification_id and a.claim_token = p_claim_token;
  if not found then return false; end if;

  update public.waitlist_notification_attempts
  set finished_at = coalesce(finished_at, now()), outcome = 'SENT', error_code = null
  where id = attempt_id;

  if queued.status <> 'SENT' then
    update public.waitlist_notifications
    set status = 'SENT',
        sent_at = now(),
        skipped_at = null,
        skip_reason = null,
        last_error_code = null,
        locked_until = null,
        claim_token = null,
        frozen_message = null
    where id = queued.id;
  end if;

  return true;
end;
$$;

-- A tentativa não deu certo. `p_outcome`:
--
--   REJECTED    — o provedor recusou: nada saiu. A próxima tentativa começa
--                 geração nova, com chave e mensagem novas.
--   UNKNOWN     — não se sabe se saiu: a geração fica incerta e as próximas
--                 tentativas repetem a mesma chave e a mesma mensagem.
--   KEY_REFUSED — o provedor recusou a chave. Na primeira vez, como UNKNOWN; na
--                 segunda na mesma geração, é conflito: UNCERTAIN.
--
-- Qualquer outro valor é UNKNOWN, e qualquer código fora do formato vira
-- UNKNOWN_ERROR: nenhuma resposta do provedor é gravada. Só a tentativa atual
-- devolve o e-mail à fila; a falha de uma tentativa antiga fica no registro sem
-- desfazer um envio concluído nem soltar um envio em curso.
create or replace function public.fail_waitlist_email(
  p_notification_id uuid,
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
  queued public.waitlist_notifications%rowtype;
  attempted public.waitlist_notification_attempts%rowtype;
  normalized text := upper(trim(coalesce(p_error_code, '')));
  kind text := upper(trim(coalesce(p_outcome, '')));
  retry_after interval := make_interval(secs => least(greatest(coalesce(p_retry_after_seconds, 0), 0), 86400));
  key_conflict boolean := false;
begin
  if normalized !~ '^[A-Z0-9_]{1,64}$' then normalized := 'UNKNOWN_ERROR'; end if;
  if kind not in ('REJECTED', 'UNKNOWN', 'KEY_REFUSED') then kind := 'UNKNOWN'; end if;

  select * into queued from public.waitlist_notifications where id = p_notification_id for update;
  if not found then return false; end if;

  select * into attempted from public.waitlist_notification_attempts a
  where a.notification_id = p_notification_id and a.claim_token = p_claim_token;
  if not found or attempted.outcome is not null then return false; end if;

  key_conflict := kind = 'KEY_REFUSED' and exists (
    select 1 from public.waitlist_notification_attempts earlier
    where earlier.notification_id = attempted.notification_id
      and earlier.generation = attempted.generation
      and earlier.id <> attempted.id
      and earlier.outcome = 'KEY_REFUSED'
  );

  update public.waitlist_notification_attempts
  set finished_at = coalesce(finished_at, now()), outcome = kind, error_code = normalized
  where id = attempted.id;

  if queued.status in ('SENT', 'SKIPPED', 'UNCERTAIN') then return true; end if;

  -- A incerteza é da geração: vale mesmo que a tentativa já não seja a atual.
  if kind <> 'REJECTED' and attempted.generation = queued.generation then
    update public.waitlist_notifications set generation_uncertain = true where id = queued.id
    returning * into queued;
  end if;

  if queued.attempts = attempted.attempt and queued.status in ('SENDING', 'FAILED') then
    if key_conflict then
      update public.waitlist_notifications
      set status = 'UNCERTAIN', last_error_code = 'IDEMPOTENCY_CONFLICT',
          locked_until = null, claim_token = null, frozen_message = null
      where id = queued.id;
    else
      update public.waitlist_notifications
      set status = 'FAILED', last_error_code = normalized,
          locked_until = null, claim_token = null,
          next_attempt_at = now() + retry_after
      where id = queued.id;
    end if;
  end if;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------
--
-- Apoio e núcleo: ninguém além do dono. Operações da fila: só a service role.
revoke all on function public.waitlist_notification_rejection(uuid) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_notification_payload(uuid) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_notification_take(uuid, integer, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.claim_waitlist_joined_email(uuid, text, integer, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.claim_pending_waitlist_emails(integer, integer, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.freeze_waitlist_email(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.complete_waitlist_email(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.fail_waitlist_email(uuid, uuid, text, text, integer) from public, anon, authenticated, service_role;

grant execute on function public.claim_waitlist_joined_email(uuid, text, integer, integer, integer) to service_role;
grant execute on function public.claim_pending_waitlist_emails(integer, integer, integer, integer) to service_role;
grant execute on function public.freeze_waitlist_email(uuid, uuid, jsonb) to service_role;
grant execute on function public.complete_waitlist_email(uuid, uuid) to service_role;
grant execute on function public.fail_waitlist_email(uuid, uuid, text, text, integer) to service_role;
