-- E-mail de confirmação de reserva.
--
-- Aditiva e idempotente. Não cria tabela nova: reaproveita
-- `integration_sync_jobs`, que já é a fila durável de integrações do projeto e
-- já tem a unicidade `(integration, entity_type, entity_id)` de que este envio
-- precisa. A integração se chama 'RESERVATION_CONFIRMATION_EMAIL'.
--
-- Nada aqui altera reserva, sessão, capacidade, pagamento ou disponibilidade.
--
-- Duas garantias ficam no banco, não na aplicação:
--
--   1. **Só reserva confirmada gera e-mail.** A reivindicação verifica o status
--      antes de qualquer coisa. Pendente, expirada ou cancelada não passa daqui,
--      então o código da aplicação não tem como enviar por engano.
--
--   2. **Exatamente um envio por reserva.** O `on conflict ... do update ... where`
--      só devolve id quando a linha ainda não existe ou quando existe e falhou.
--      Um job já SYNCED nunca é reivindicado de novo — webhook duplicado,
--      reprocessamento e clique repetido convergem para zero e-mails extras.

-- 1. Reivindicação exatamente-uma-vez -----------------------------------------
--
-- Devolve o id do job quando (e somente quando) o chamador tem direito de
-- enviar. Devolve null em todos os outros casos: reserva não confirmada, e-mail
-- já enviado, envio em andamento ou tentativas esgotadas.
create or replace function public.claim_reservation_confirmation_email(
  p_reservation_id uuid,
  p_max_attempts integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  job_id uuid;
  max_attempts integer := greatest(coalesce(p_max_attempts, 3), 1);
begin
  if p_reservation_id is null then return null; end if;

  -- Requisito central: nunca enviar para reserva que não esteja confirmada.
  if not exists (
    select 1 from public.reservations
    where id = p_reservation_id and status = 'CONFIRMED'
  ) then
    return null;
  end if;

  insert into public.integration_sync_jobs (integration, entity_type, entity_id, operation)
  values ('RESERVATION_CONFIRMATION_EMAIL', 'RESERVATION', p_reservation_id, 'SEND')
  on conflict (integration, entity_type, entity_id) do update
    set status = 'PENDING',
        updated_at = now()
    where integration_sync_jobs.status = 'FAILED'
      and integration_sync_jobs.attempts < max_attempts
  returning id into job_id;

  return job_id;
end;
$$;

-- 2. Reivindicação de pendências para nova tentativa ---------------------------
--
-- Recupera envios que falharam e também os que ficaram presos em PENDING —
-- o caso de uma instância serverless morrer no meio do envio. A janela de
-- carência evita disputar um envio que ainda está acontecendo agora.
create or replace function public.claim_pending_confirmation_emails(
  p_limit integer,
  p_max_attempts integer,
  p_stale_minutes integer
)
returns table (id uuid, reservation_id uuid, attempts integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.integration_sync_jobs j
  set updated_at = now()
  where j.id in (
    select k.id
    from public.integration_sync_jobs k
    join public.reservations r on r.id = k.entity_id
    where k.integration = 'RESERVATION_CONFIRMATION_EMAIL'
      and k.status <> 'SYNCED'
      and k.attempts < greatest(coalesce(p_max_attempts, 3), 1)
      and k.updated_at < now() - make_interval(mins => greatest(coalesce(p_stale_minutes, 15), 1))
      -- Uma reserva cancelada depois da confirmação não deve receber o e-mail
      -- em uma tentativa posterior.
      and r.status = 'CONFIRMED'
    order by k.updated_at asc
    limit least(greatest(coalesce(p_limit, 1), 0), 10)
    for update skip locked
  )
  returning j.id, j.entity_id, j.attempts;
end;
$$;

-- 3. Conteúdo do e-mail --------------------------------------------------------
--
-- O mínimo necessário para escrever a mensagem. Diferente do snapshot da
-- planilha, aqui o e-mail e o nome são indispensáveis — é para essa pessoa que
-- a mensagem vai. CPF, hash de CPF, endereço, telefone, checkout_url,
-- referência do provedor e payload de pagamento continuam fora.
create or replace function public.reservation_confirmation_email(p_reservation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'reservationId', r.id,
    'publicCode', r.public_code,
    'fullName', r.full_name,
    'email', r.email,
    'quantity', r.quantity,
    'status', r.status,
    'experienceTitle', e.title,
    'startsAt', s.starts_at
  )
  from public.reservations r
  join public.sessions s on s.id = r.session_id
  join public.experiences e on e.id = r.experience_id
  where r.id = p_reservation_id
    and r.status = 'CONFIRMED';
$$;

-- 4. Grants --------------------------------------------------------------------
revoke all on function public.claim_reservation_confirmation_email(uuid, integer) from public, anon, authenticated;
revoke all on function public.claim_pending_confirmation_emails(integer, integer, integer) from public, anon, authenticated;
revoke all on function public.reservation_confirmation_email(uuid) from public, anon, authenticated;

grant execute on function public.claim_reservation_confirmation_email(uuid, integer) to service_role;
grant execute on function public.claim_pending_confirmation_emails(integer, integer, integer) to service_role;
grant execute on function public.reservation_confirmation_email(uuid) to service_role;
