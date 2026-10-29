-- Eventos especiais — etapa 5C-2: lista de espera do evento, por tipo.
--
-- Depende das migrations da lista de espera (`202610250001`, `202610250002`,
-- `202610260001`, `202610260002`) e da fundação dos eventos (`202610280001`,
-- coluna `experiences.kind`). Aditiva e idempotente: **não substitui o corpo de
-- nenhuma função existente**, não cria tabela nem trigger e não toca linha.
-- Cria duas funções, só para a service role.
--
--   * `waitlist_cancel_overview_with_kind` — a página do link de saída precisa
--     saber se a inscrição é de um evento, para falar de "evento" e voltar para
--     a página dele. Chama `waitlist_cancel_overview` (o limite de tentativas
--     conta uma vez só, lá dentro) e acrescenta `experienceKind` e, para evento,
--     `experienceSlug`. Mesma resposta, mesmas recusas, nenhum dado pessoal novo.
--
--   * `claim_pending_waitlist_spot_emails_by_kind` — a reivindicação dos avisos
--     de vaga, igual à de sempre (`claim_pending_waitlist_spot_emails`, que não
--     muda), mas só dos tipos pedidos. O servidor pede `EVENT` só com a venda e
--     a lista dos eventos abertas: com a venda fechada, o aviso do evento nem é
--     reivindicado — não gasta tentativa, não conta envio e continua na fila,
--     conferido de novo (vaga, turma, abertura, limites) quando a venda abrir.
--     Do mesmo jeito, aviso de evento com o interruptor de publicação
--     (`special_event_settings.publication_enabled`) desligado não é
--     reivindicado: evento escondido não recebe aviso, e nada é consumido.
--
-- A lista continua sem reservar nem bloquear vaga: nada aqui escreve em
-- `reservations` ou `sessions`. Nenhum agendamento é criado.

create or replace function public.waitlist_cancel_overview_with_kind(p_token text, p_client_address text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  overview jsonb;
  token_hash text;
  experience_kind text;
  experience_slug text;
begin
  overview := public.waitlist_cancel_overview(p_token, p_client_address);
  if coalesce(overview ->> 'status', '') not in ('ACTIVE', 'CONVERTED', 'CANCELLED', 'REMOVED', 'EXPIRED') then
    return overview;
  end if;

  token_hash := public.waitlist_token_hash(p_token);
  select e.kind, e.slug into experience_kind, experience_slug
  from public.waitlist_entries we
  join public.sessions s on s.id = we.session_id
  join public.experiences e on e.id = s.experience_id
  where we.cancel_token_hash = token_hash;
  if not found then
    return overview;
  end if;

  return overview || jsonb_build_object(
    'experienceKind', coalesce(experience_kind, 'REGULAR'),
    'experienceSlug', case when experience_kind = 'EVENT' then experience_slug end
  );
end;
$$;

create or replace function public.claim_pending_waitlist_spot_emails_by_kind(
  p_kinds text[],
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
    join public.sessions s on s.id = we.session_id
    join public.experiences e on e.id = s.experience_id
    where n.kind = 'SPOT_AVAILABLE'
      and e.kind = any(coalesce(p_kinds, array[]::text[]))
      and (e.kind <> 'EVENT' or coalesce((select ses.publication_enabled from public.special_event_settings ses where ses.singleton), false))
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

revoke all on function public.waitlist_cancel_overview_with_kind(text, text) from public, anon, authenticated, service_role;
revoke all on function public.claim_pending_waitlist_spot_emails_by_kind(text[], integer, integer, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.waitlist_cancel_overview_with_kind(text, text) to service_role;
grant execute on function public.claim_pending_waitlist_spot_emails_by_kind(text[], integer, integer, integer, integer) to service_role;
