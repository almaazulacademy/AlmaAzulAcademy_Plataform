-- Eventos especiais — segurança antes da abertura.
--
-- Auditoria de produção (31/10/2026): com o evento publicado e o interruptor
-- `special_event_settings.publication_enabled` desligado, a chave pública ainda
-- lê o evento por seis funções antigas e pelas tabelas; sessão aberta é legível
-- mesmo com o evento em rascunho; e `create_reservation`, função do schema legado
-- fora do repositório, é executável por qualquer um.
--
-- Depende de `202610280001` (experiences.kind e o interruptor). Nada aqui publica,
-- abre sessão ou toca linha.
--
--   1. Funções auxiliares. `event_publication_allows` responde se o tipo pode
--      aparecer: regular sempre; evento só com o interruptor ligado.
--   2. Seis leituras antigas ganham essa condição, sem mudar assinatura, colunas ou
--      ordem. `get_booking_session` lê de `list_open_sessions` e herda. Para
--      experiência regular a condição é sempre verdadeira.
--   3. Políticas RESTRITIVAS de leitura em `experiences` e `sessions`, para `anon`
--      e `authenticated`. Restritiva soma um E a todas as permissivas: as atuais
--      (`status`, `active`, sessão aberta) continuam valendo para regulares, e
--      evento só é legível publicado com o interruptor ligado, seja qual for
--      `active`. O servidor usa a service role, que ignora RLS, e as funções são
--      SECURITY DEFINER: nenhum caminho do site passa por estas políticas.
--   4. `create_reservation` (só existe em produção): perde a execução de todos os
--      papéis. Não é chamada por nenhum código e hoje falha antes de gravar.
--   5. Gatilho em `reservations` e `waitlist_entries`, só em INSERT: recusa nova
--      reserva ou inscrição de evento com o interruptor desligado, como última
--      barreira. Reservas existentes, pagamento, check-in e e-mails não passam por ele.

create or replace function public.event_publication_allows(p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_kind is distinct from 'EVENT'
      or coalesce((select ses.publication_enabled from public.special_event_settings ses where ses.singleton), false);
$$;

create or replace function public.experience_row_is_public(p_kind text, p_status text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_kind is distinct from 'EVENT'
      or (p_status = 'PUBLISHED' and public.event_publication_allows(p_kind))
      or public.is_active_admin(auth.uid());
$$;

create or replace function public.session_experience_is_public(p_experience_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select public.experience_row_is_public(e.kind, e.status) from public.experiences e where e.id = p_experience_id),
    true
  );
$$;

revoke all on function public.event_publication_allows(text) from public, anon, authenticated, service_role;
revoke all on function public.experience_row_is_public(text, text) from public, anon, authenticated, service_role;
revoke all on function public.session_experience_is_public(uuid) from public, anon, authenticated, service_role;
-- Políticas rodam com o papel de quem lê: esses dois papéis precisam executar.
grant execute on function public.experience_row_is_public(text, text) to anon, authenticated;
grant execute on function public.session_experience_is_public(uuid) to anon, authenticated;

CREATE OR REPLACE FUNCTION public.list_public_experiences()
 RETURNS TABLE(id uuid, slug text, title text, summary text, image_url text, display_order integer, editorial_content jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select e.id, e.slug, e.title, e.summary, e.image_url, e.display_order, e.editorial_content
  from public.experiences e
  where e.status = 'PUBLISHED' and e.editorial_content <> '{}'::jsonb
    and public.event_publication_allows(e.kind)
  order by e.display_order, e.title;
$function$;

CREATE OR REPLACE FUNCTION public.list_public_catalog()
 RETURNS TABLE(id uuid, slug text, title text, summary text, status text, image_url text, display_order integer, editorial_content jsonb, base_id uuid, base_slug text, is_exclusive boolean, modality text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select e.id, e.slug, e.title, e.summary, e.status, e.image_url,
         e.display_order,
         case when e.status = 'PUBLISHED' then e.editorial_content else '{}'::jsonb end,
         b.id, b.slug, e.is_exclusive, coalesce(e.modality, e.slug)
  from public.experiences e
  join public.bases b on b.id = e.base_id
  where b.status <> 'INACTIVE'
    and public.event_publication_allows(e.kind)
    and (
      (e.status = 'PUBLISHED' and e.editorial_content <> '{}'::jsonb)
      or e.status = 'COMING_SOON'
    )
  order by b.display_order, e.display_order, e.title;
$function$;

CREATE OR REPLACE FUNCTION public.get_public_experience(p_slug text)
 RETURNS TABLE(id uuid, slug text, title text, summary text, image_url text, display_order integer, editorial_content jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select e.id, e.slug, e.title, e.summary, e.image_url, e.display_order, e.editorial_content
  from public.experiences e
  where e.slug = lower(trim(p_slug)) and e.status = 'PUBLISHED'
    and public.event_publication_allows(e.kind);
$function$;

CREATE OR REPLACE FUNCTION public.list_open_sessions(p_experience_slug text)
 RETURNS TABLE(id uuid, experience_id uuid, experience_slug text, experience_title text, experience_summary text, starts_at timestamp with time zone, duration_minutes integer, price_cents integer, remaining_spots integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    s.id,
    e.id,
    e.slug,
    e.title,
    e.summary,
    s.starts_at,
    s.duration_minutes,
    s.price_cents,
    public.available_spots(s.id)
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  where e.slug = p_experience_slug
    and e.status = 'PUBLISHED'
    and public.event_publication_allows(e.kind)
    and s.status = 'OPEN'
    and s.starts_at > now()
    and public.available_spots(s.id) > 0
  order by s.starts_at;
$function$;

CREATE OR REPLACE FUNCTION public.list_public_sessions(p_experience_slug text)
 RETURNS TABLE(id uuid, experience_id uuid, experience_slug text, experience_title text, experience_summary text, starts_at timestamp with time zone, duration_minutes integer, price_cents integer, remaining_spots integer, sold_out boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    and public.event_publication_allows(e.kind)
    and s.status = 'OPEN'
    and s.starts_at > now()
  order by s.starts_at, s.id;
$function$;

CREATE OR REPLACE FUNCTION public.public_session_context(p_session_id uuid)
 RETURNS TABLE(experience_slug text, experience_title text, experience_status text, base_slug text, base_name text, base_status text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select e.slug, e.title, e.status, b.slug, b.name, b.status
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  join public.bases b on b.id = e.base_id
  where s.id = p_session_id
    and e.status in ('PUBLISHED', 'COMING_SOON')
    and b.status <> 'INACTIVE'
    and public.event_publication_allows(e.kind);
$function$;

drop policy if exists "events hidden until published" on public.experiences;
create policy "events hidden until published" on public.experiences
  as restrictive for select to anon, authenticated
  using (public.experience_row_is_public(kind, status));

drop policy if exists "event sessions hidden until published" on public.sessions;
create policy "event sessions hidden until published" on public.sessions
  as restrictive for select to anon, authenticated
  using (public.session_experience_is_public(experience_id));

do $revoke$
begin
  if to_regprocedure('public.create_reservation(uuid, text, text, text, integer, text)') is not null then
    revoke execute on function public.create_reservation(uuid, text, text, text, integer, text)
      from public, anon, authenticated, service_role;
  end if;
end;
$revoke$;

create or replace function public.enforce_event_publication_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from public.sessions s
    join public.experiences e on e.id = s.experience_id
    where s.id = new.session_id and not public.event_publication_allows(e.kind)
  ) then
    raise exception 'EVENT_NOT_PUBLIC' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_event_publication_on_insert() from public, anon, authenticated, service_role;

drop trigger if exists reservations_event_publication_guard on public.reservations;
create trigger reservations_event_publication_guard
  before insert on public.reservations
  for each row execute function public.enforce_event_publication_on_insert();

drop trigger if exists waitlist_entries_event_publication_guard on public.waitlist_entries;
create trigger waitlist_entries_event_publication_guard
  before insert on public.waitlist_entries
  for each row execute function public.enforce_event_publication_on_insert();
