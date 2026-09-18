-- Envio em lote dos QRs de check-in pendentes ("Enviar QRs pendentes").
--
-- Aditiva. Não cria tabela nem coluna, não altera reserva, token, pagamento,
-- sessão ou presença. Reaproveita:
--   * `integration_sync_jobs` como trava por reserva (integração
--     'RESERVATION_QR_BULK'), com a mesma unicidade (integration, entity_type,
--     entity_id) já usada pelo e-mail de confirmação;
--   * `admin_audit_log` com a ação 'CHECKIN_QR_RESENT', a mesma do botão
--     "Reenviar QR Code";
--   * `reservation_confirmation_email`, que devolve o token existente.
--
-- Garantias:
--   1. Elegibilidade num único lugar (`checkin_qr_bulk_eligibility`), idêntica
--      ao dry run do rollout, usada para listar E para revalidar cada reserva
--      imediatamente antes do envio.
--   2. Exatamente um envio por reserva: a reivindicação só devolve job quando
--      não há outro em andamento; dois administradores ao mesmo tempo nunca
--      pegam a mesma reserva.
--   3. `CHECKIN_QR_RESENT` é gravado na MESMA transação que marca o job como
--      concluído, e só depois do envio. Falha de e-mail não grava auditoria:
--      a reserva continua elegível para nova tentativa.
--   4. Nenhum token é gerado aqui. Reserva sem token não é elegível.
--   5. O reenvio individual ("Reenviar QR Code") passa a seguir a mesma regra:
--      carrega o payload (seção 6a), envia e só então registra (seção 6b).

-- Corte do rollout: a partir daqui o e-mail automático de confirmação já sai
-- com o QR (PR #17 em produção às 16:02 UTC; margem até 16:10).
create or replace function public.checkin_qr_bulk_cutoff()
returns timestamptz
language sql
immutable
as $$ select timestamptz '2026-09-18 16:10:00+00' $$;

-- 1. Elegibilidade -------------------------------------------------------------
--
-- Mesma ordem de critérios do dry run. Devolve 'ELIGIBLE' ou o motivo.
create or replace function public.checkin_qr_bulk_eligibility(p_reservation_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case
      when r.status <> 'CONFIRMED' then 'NOT_CONFIRMED'
      when s.starts_at <= now() then 'PAST_SESSION'
      when r.checkin_token is null then 'NO_TOKEN'
      when r.email is null or r.email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then 'NO_EMAIL'
      when exists (
        select 1 from public.admin_audit_log a
        where a.entity_id = r.id and a.action = 'CHECKIN_QR_RESENT'
      ) then 'ALREADY_RESENT'
      when exists (
        select 1 from public.integration_sync_jobs j
        where j.integration = 'RESERVATION_CONFIRMATION_EMAIL'
          and j.entity_type = 'RESERVATION' and j.entity_id = r.id
          and j.status = 'SYNCED' and j.synced_at >= public.checkin_qr_bulk_cutoff()
      ) then 'QR_IN_CONFIRMATION'
      else 'ELIGIBLE'
    end
    from public.reservations r
    join public.sessions s on s.id = r.session_id
    where r.id = p_reservation_id
  ), 'NOT_FOUND');
$$;

-- 2. Candidatos ----------------------------------------------------------------
--
-- Elegíveis agora, fora os que outro lote está enviando neste instante
-- (job PENDING recente). Um PENDING com mais de 30 minutos é de uma execução
-- que morreu no meio e volta a ser candidato.
create or replace function public.admin_checkin_qr_bulk_candidates(p_actor_id uuid)
returns table (reservation_id uuid, public_code text, quantity integer)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  return query
  select r.id, r.public_code, r.quantity
  from public.reservations r
  join public.sessions s on s.id = r.session_id
  where r.status = 'CONFIRMED'
    and s.starts_at > now()
    and public.checkin_qr_bulk_eligibility(r.id) = 'ELIGIBLE'
    and not exists (
      select 1 from public.integration_sync_jobs j
      where j.integration = 'RESERVATION_QR_BULK'
        and j.entity_type = 'RESERVATION' and j.entity_id = r.id
        and j.status = 'PENDING'
        and j.updated_at > now() - interval '30 minutes'
    )
  order by s.starts_at, r.created_at;
end;
$$;

-- 3. Reivindicação de uma reserva ----------------------------------------------
--
-- Trava a linha da reserva, revalida a elegibilidade e reivindica o job. Só
-- devolve `jobId` + `payload` para quem pode enviar. Qualquer outro caso volta
-- com `skipped` = motivo, e nada é enviado.
create or replace function public.admin_checkin_qr_bulk_claim(p_actor_id uuid, p_reservation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  reason text;
  job_id uuid;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  perform 1 from public.reservations where id = p_reservation_id for update;
  if not found then
    return jsonb_build_object('skipped', 'NOT_FOUND');
  end if;

  reason := public.checkin_qr_bulk_eligibility(p_reservation_id);
  if reason <> 'ELIGIBLE' then
    return jsonb_build_object('skipped', reason);
  end if;

  insert into public.integration_sync_jobs (integration, entity_type, entity_id, operation)
  values ('RESERVATION_QR_BULK', 'RESERVATION', p_reservation_id, 'SEND')
  on conflict (integration, entity_type, entity_id) do update
    set status = 'PENDING',
        updated_at = now()
    where integration_sync_jobs.status = 'FAILED'
       or (integration_sync_jobs.status = 'PENDING'
           and integration_sync_jobs.updated_at <= now() - interval '30 minutes')
  returning id into job_id;

  if job_id is null then
    -- Outro lote está com esta reserva agora (ou já concluiu).
    return jsonb_build_object('skipped', 'IN_PROGRESS');
  end if;

  return jsonb_build_object(
    'jobId', job_id,
    'payload', public.reservation_confirmation_email(p_reservation_id)
  );
end;
$$;

-- 4. Conclusão: auditoria + job concluído, na mesma transação -------------------
create or replace function public.admin_checkin_qr_bulk_complete(p_actor_id uuid, p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  reservation_id uuid;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  update public.integration_sync_jobs
  set status = 'SYNCED', last_error_code = null, synced_at = now(), updated_at = now()
  where id = p_job_id and integration = 'RESERVATION_QR_BULK' and status = 'PENDING'
  returning entity_id into reservation_id;

  if reservation_id is null then return false; end if;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (p_actor_id, 'CHECKIN_QR_RESENT', 'RESERVATION', reservation_id, jsonb_build_object('source', 'BULK'));

  return true;
end;
$$;

-- 5. Falha: libera a reserva para nova tentativa --------------------------------
create or replace function public.admin_checkin_qr_bulk_fail(p_actor_id uuid, p_job_id uuid, p_error_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (select 1 from public.integration_sync_jobs where id = p_job_id and integration = 'RESERVATION_QR_BULK') then
    return false;
  end if;
  return public.fail_integration_sync_job(p_job_id, p_error_code);
end;
$$;

-- 6. Reenvio individual em duas etapas -----------------------------------------
--
-- Substituem, no código novo, a antiga `admin_reservation_qr_email`, que grava
-- CHECKIN_QR_RESENT ANTES do envio. A antiga fica intocada nesta migration: o
-- código em produção ainda a usa até o deploy deste PR. Depois dele, nada a
-- chama mais e ela pode ser removida numa limpeza futura.

-- 6a. Payload: só leitura. Não gera token, não grava auditoria, não altera nada.
create or replace function public.admin_reservation_qr_email_payload(p_actor_id uuid, p_reservation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  current_status text;
  current_token uuid;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  select status::text, checkin_token into current_status, current_token
  from public.reservations where id = p_reservation_id;

  if current_status is null or current_status <> 'CONFIRMED' then
    raise exception 'RESERVATION_NOT_CONFIRMED' using errcode = '22023';
  end if;
  if current_token is null then
    raise exception 'RESERVATION_WITHOUT_TOKEN' using errcode = '22023';
  end if;

  return public.reservation_confirmation_email(p_reservation_id);
end;
$$;

-- 6b. Registro do envio: chamado só depois de o provedor confirmar o envio.
create or replace function public.admin_reservation_qr_email_complete(p_actor_id uuid, p_reservation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (select 1 from public.reservations where id = p_reservation_id) then
    raise exception 'RESERVATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (p_actor_id, 'CHECKIN_QR_RESENT', 'RESERVATION', p_reservation_id, jsonb_build_object('source', 'INDIVIDUAL'));
  return true;
end;
$$;

-- 7. Grants --------------------------------------------------------------------
revoke all on function public.checkin_qr_bulk_cutoff() from public, anon, authenticated;
revoke all on function public.checkin_qr_bulk_eligibility(uuid) from public, anon, authenticated;
revoke all on function public.admin_checkin_qr_bulk_candidates(uuid) from public, anon, authenticated;
revoke all on function public.admin_checkin_qr_bulk_claim(uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_checkin_qr_bulk_complete(uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_checkin_qr_bulk_fail(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_reservation_qr_email_payload(uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_reservation_qr_email_complete(uuid, uuid) from public, anon, authenticated;

grant execute on function public.checkin_qr_bulk_cutoff() to service_role;
grant execute on function public.checkin_qr_bulk_eligibility(uuid) to service_role;
grant execute on function public.admin_checkin_qr_bulk_candidates(uuid) to service_role;
grant execute on function public.admin_checkin_qr_bulk_claim(uuid, uuid) to service_role;
grant execute on function public.admin_checkin_qr_bulk_complete(uuid, uuid) to service_role;
grant execute on function public.admin_checkin_qr_bulk_fail(uuid, uuid, text) to service_role;
grant execute on function public.admin_reservation_qr_email_payload(uuid, uuid) to service_role;
grant execute on function public.admin_reservation_qr_email_complete(uuid, uuid) to service_role;
