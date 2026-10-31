-- =============================================================================
-- ROLLBACK de 202610310004_event_publication_security.sql — SOMENTE PARA REVISÃO.
-- NÃO EXECUTAR sem decisão explícita. Não está em supabase/migrations/ de
-- propósito, para nenhuma ferramenta aplicá-lo.
-- =============================================================================
--
-- Tira os gatilhos e as políticas restritivas, devolve às seis leituras o corpo
-- anterior e remove as funções auxiliares. **Não devolve a execução de
-- create_reservation**: a função não é usada e não deve voltar a ser pública.
-- Depois dele, evento publicado volta a ser legível com o interruptor desligado.
-- Não toca linhas.

begin;
set local lock_timeout = '5s';

drop trigger if exists reservations_event_publication_guard on public.reservations;
drop trigger if exists waitlist_entries_event_publication_guard on public.waitlist_entries;
drop function if exists public.enforce_event_publication_on_insert();

drop policy if exists "events hidden until published" on public.experiences;
drop policy if exists "event sessions hidden until published" on public.sessions;

CREATE OR REPLACE FUNCTION public.list_public_experiences()
 RETURNS TABLE(id uuid, slug text, title text, summary text, image_url text, display_order integer, editorial_content jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select e.id, e.slug, e.title, e.summary, e.image_url, e.display_order, e.editorial_content
  from public.experiences e
  where e.status = 'PUBLISHED' and e.editorial_content <> '{}'::jsonb
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
  where e.slug = lower(trim(p_slug)) and e.status = 'PUBLISHED';
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
    and b.status <> 'INACTIVE';
$function$;

drop function if exists public.session_experience_is_public(uuid);
drop function if exists public.experience_row_is_public(text, text);
drop function if exists public.event_publication_allows(text);

commit;
