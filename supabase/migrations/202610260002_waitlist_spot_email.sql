-- Lista de espera — fase 6: envio do aviso de vaga.
--
-- Depende das migrations da lista de espera `202610250001`, `202610250002` e
-- `202610260001`. Aditiva e idempotente. **Não substitui o corpo de nenhuma
-- função existente**, não cria trigger, não cria tabela e não toca linha
-- existente. Cria cinco funções.
--
-- Depois de aplicada, nada sai sozinho: só o servidor envia, e só com
-- `WAITLIST_NOTIFY_ENABLED=true`, o provedor de e-mail configurado e alguém
-- acionando a rota `/api/cron/waitlist-notifications`. E só há o que enviar
-- quando a detecção (fase 5) estiver ligada e enfileirando avisos.
--
-- ## O que entra
--
-- A fila do aviso de vaga (`SPOT_AVAILABLE`) com o mesmo protocolo da
-- confirmação da inscrição (fase 3): reivindicação exclusiva com prazo,
-- mensagem congelada antes do envio, chave de idempotência por geração,
-- resultado desconhecido nunca tratado como "não enviado", `UNCERTAIN` em
-- conflito de chave ou janela vencida.
--
-- **Reaproveitado sem mudança**, da fase 3: `freeze_waitlist_email` (só congela
-- para o e-mail da própria inscrição) e `fail_waitlist_email` (classifica a
-- falha e agenda a próxima tentativa). Os dois já valem para qualquer tipo.
--
-- **Novo**, porque o aviso de vaga tem regras que a confirmação não tem:
--
--   * `waitlist_spot_rejection` — antes de **cada** tentativa, confere de novo:
--     inscrição ativa; turma aberta, futura, de experiência publicada; abertura
--     ainda aberta; vaga para o grupo inteiro agora (`waitlist_detection_spots`,
--     que parte de `available_spots`); menos de 3 avisos enviados e o último há
--     12 horas ou mais. Senão, `SKIPPED` com o motivo — e nada sai.
--   * `waitlist_spot_take` — o núcleo da reivindicação, irmão do da fase 3.
--   * `claim_pending_waitlist_spot_emails` — pendências, na ordem da fila da turma.
--   * `waitlist_spot_payload` — o que o e-mail precisa, inclusive o link de
--     cancelamento recalculado.
--   * `complete_waitlist_spot_email` — marca enviado **e** conta o aviso na
--     inscrição (`notifications_sent`, `last_notified_at`), uma única vez. É o que
--     faz valer o intervalo de 12 horas e o limite de 3 avisos (D3).
--
-- A lista continua sem reservar nem bloquear vaga (opção A): nada aqui escreve
-- em `reservations` ou `sessions`.

-- ---------------------------------------------------------------------------
-- 1. A régua do envio
-- ---------------------------------------------------------------------------

create or replace function public.waitlist_spot_rejection(p_notification_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when n.id is null then 'NOT_FOUND'
    when we.id is null or we.anonymized_at is not null or we.status <> 'ACTIVE' then 'ENTRY_CLOSED'
    when s.starts_at <= now() then 'SESSION_STARTED'
    when s.status <> 'OPEN' or e.status <> 'PUBLISHED' then 'SESSION_UNAVAILABLE'
    when o.id is null or o.closed_at is not null then 'OPENING_CLOSED'
    when public.waitlist_detection_spots(s.id) < we.quantity then 'NO_SPOTS'
    when we.notifications_sent >= 3 then 'LIMIT_REACHED'
    when we.last_notified_at is not null and we.last_notified_at > now() - interval '12 hours' then 'TOO_SOON'
    else null
  end
  from (select p_notification_id as id) wanted
  left join public.waitlist_notifications n on n.id = wanted.id and n.kind = 'SPOT_AVAILABLE'
  left join public.waitlist_entries we on we.id = n.entry_id
  left join public.sessions s on s.id = we.session_id
  left join public.experiences e on e.id = s.experience_id
  left join public.waitlist_openings o on o.id = n.opening_id;
$$;

-- O que o servidor precisa para montar o aviso. Inclui as vagas de agora e o
-- token do link de cancelamento, recalculado (nunca guardado).
create or replace function public.waitlist_spot_payload(p_notification_id uuid)
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
    'priceCents', s.price_cents,
    'remainingSpots', public.waitlist_detection_spots(s.id),
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
  where n.id = p_notification_id and n.kind = 'SPOT_AVAILABLE';
$$;

-- ---------------------------------------------------------------------------
-- 2. O núcleo da reivindicação
-- ---------------------------------------------------------------------------

-- Igual ao da fase 3, com a régua do aviso de vaga. Trava a inscrição
-- (compartilhado) e depois a linha da fila — a mesma ordem do cancelamento, da
-- remoção e da varredura. Não trava sessão nem reserva.
create or replace function public.waitlist_spot_take(
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
  select n.entry_id into owner_entry from public.waitlist_notifications n where n.id = p_notification_id and n.kind = 'SPOT_AVAILABLE';
  if not found then return null; end if;

  perform 1 from public.waitlist_entries we where we.id = owner_entry for share;
  select * into queued from public.waitlist_notifications where id = p_notification_id for update skip locked;
  if not found then return null; end if;

  if queued.status in ('SENT', 'SKIPPED', 'UNCERTAIN') then return null; end if;
  if queued.status = 'SENDING' and queued.locked_until > now() then return null; end if;

  if queued.status = 'SENDING' then
    update public.waitlist_notification_attempts
    set finished_at = now(), error_code = 'LEASE_EXPIRED'
    where notification_id = queued.id and attempt = queued.attempts and outcome is null and finished_at is null;

    update public.waitlist_notifications
    set status = 'FAILED', last_error_code = 'LEASE_EXPIRED', locked_until = null, claim_token = null,
        generation_uncertain = generation_uncertain or frozen_message is not null
    where id = queued.id
    returning * into queued;
  end if;

  -- A vaga, a turma e a inscrição são conferidas de novo antes de cada tentativa.
  -- Um aviso que já não descreve uma vaga real não sai.
  rejection := public.waitlist_spot_rejection(queued.id);
  if rejection is not null then
    update public.waitlist_notifications
    set status = 'SKIPPED', skipped_at = now(), skip_reason = rejection,
        locked_until = null, claim_token = null, frozen_message = null
    where id = queued.id;
    return null;
  end if;

  if queued.attempts >= max_attempts then return null; end if;
  if queued.status = 'FAILED' and queued.next_attempt_at > now() then return null; end if;

  fresh := queued.attempts = 0 or queued.frozen_message is null or not queued.generation_uncertain;

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

  return jsonb_build_object(
    'notificationId', queued.id,
    'claimToken', token,
    'attempt', queued.attempts,
    'generation', queued.generation,
    'message', queued.frozen_message,
    'payload', public.waitlist_spot_payload(queued.id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Operações (service role)
-- ---------------------------------------------------------------------------

-- Pendências de aviso de vaga: nunca tentadas, falhas com tentativa sobrando e
-- espera cumprida, e envios cujo prazo venceu. A ordem é a da onda: abertura
-- mais antiga primeiro e, dentro dela, a ordem da fila da turma. A escolha não
-- trava nada; quem trava é o núcleo, um por vez, e duas execuções simultâneas
-- dividem a fila. Array das reivindicações obtidas.
create or replace function public.claim_pending_waitlist_spot_emails(
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
    join public.waitlist_entries we on we.id = n.entry_id
    where n.kind = 'SPOT_AVAILABLE'
      and (
        n.status = 'QUEUED'
        or (n.status = 'FAILED' and n.attempts < max_attempts and n.next_attempt_at <= now())
        or (n.status = 'SENDING' and n.locked_until <= now())
      )
    order by n.created_at, we.queue_sequence, n.id
    limit least(greatest(coalesce(p_limit, 1), 0), 50)
  loop
    begin
      claim := public.waitlist_spot_take(candidate.id, max_attempts, p_lease_minutes, p_window_minutes);
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

-- O provedor aceitou. Marca enviado e conta o aviso na inscrição — uma vez só:
-- a tentativa que responde depois do prazo, ou a mesma conclusão repetida, não
-- conta de novo. A mensagem congelada é apagada.
create or replace function public.complete_waitlist_spot_email(
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
  select * into queued from public.waitlist_notifications where id = p_notification_id and kind = 'SPOT_AVAILABLE' for update;
  if not found then return false; end if;

  select a.id into attempt_id from public.waitlist_notification_attempts a
  where a.notification_id = p_notification_id and a.claim_token = p_claim_token;
  if not found then return false; end if;

  update public.waitlist_notification_attempts
  set finished_at = coalesce(finished_at, now()), outcome = 'SENT', error_code = null
  where id = attempt_id;

  if queued.status <> 'SENT' then
    update public.waitlist_notifications
    set status = 'SENT', sent_at = now(), skipped_at = null, skip_reason = null, last_error_code = null,
        locked_until = null, claim_token = null, frozen_message = null
    where id = queued.id;

    update public.waitlist_entries
    set notifications_sent = notifications_sent + 1, last_notified_at = now()
    where id = queued.entry_id;
  end if;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------
revoke all on function public.waitlist_spot_rejection(uuid) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_spot_payload(uuid) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_spot_take(uuid, integer, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.claim_pending_waitlist_spot_emails(integer, integer, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.complete_waitlist_spot_email(uuid, uuid) from public, anon, authenticated, service_role;

grant execute on function public.claim_pending_waitlist_spot_emails(integer, integer, integer, integer) to service_role;
grant execute on function public.complete_waitlist_spot_email(uuid, uuid) to service_role;
