-- =============================================================================
-- ROLLBACK de 202610310001_special_events_publication_switch.sql — SOMENTE PARA
-- REVISÃO. NÃO EXECUTAR sem decisão explícita. Não está em supabase/migrations/
-- de propósito, para nenhuma ferramenta aplicá-lo automaticamente.
-- =============================================================================
--
-- Devolve às duas leituras o corpo da fundação (`202610280001`), sem o
-- interruptor. Depois dele, desligar o interruptor volta a NÃO esconder evento
-- já publicado — para tirar um evento do ar, remover `EVENTS_PUBLIC_ENABLED` ou
-- voltar o evento a rascunho. Não toca permissões, linhas nem outras funções.

begin;
set local lock_timeout = '5s';

create or replace function public.list_public_events()
returns table (
  id uuid,
  slug text,
  title text,
  summary text,
  image_url text,
  display_order integer,
  editorial_content jsonb,
  base_slug text,
  base_name text,
  base_address text,
  base_meeting_point text,
  base_maps_url text,
  session_id uuid,
  starts_at timestamptz,
  duration_minutes integer,
  price_cents integer,
  remaining_spots integer,
  availability text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    e.id, e.slug, e.title, e.summary, e.image_url, e.display_order, e.editorial_content,
    b.slug, b.name, b.address, b.meeting_point, b.maps_url,
    hs.id, hs.starts_at, hs.duration_minutes, hs.price_cents,
    case when hs.availability in ('AVAILABLE', 'SOLD_OUT') then coalesce(public.available_spots(hs.id), 0) end,
    coalesce(hs.availability, 'NO_SESSION')
  from public.experiences e
  join public.bases b on b.id = e.base_id
  left join lateral (
    select s.id, s.starts_at, s.duration_minutes, s.price_cents,
           public.special_event_availability(s.id) as availability
    from public.sessions s
    where s.experience_id = e.id
      and s.status <> 'ARCHIVED'
    order by (s.starts_at > now() and s.status <> 'CANCELLED') desc,
             case when s.starts_at > now() then s.starts_at end asc,
             s.starts_at desc
    limit 1
  ) hs on true
  where e.kind = 'EVENT'
    and e.status = 'PUBLISHED'
    and e.editorial_content <> '{}'::jsonb
    and b.status <> 'INACTIVE'
  order by (hs.starts_at > now()) desc nulls last,
           case when hs.starts_at > now() then hs.starts_at end asc,
           hs.starts_at desc,
           e.display_order, e.title;
$$;

create or replace function public.list_public_event_sessions(p_slug text)
returns table (
  id uuid,
  experience_id uuid,
  experience_slug text,
  experience_title text,
  starts_at timestamptz,
  duration_minutes integer,
  price_cents integer,
  remaining_spots integer,
  availability text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.id, e.id, e.slug, e.title, s.starts_at, s.duration_minutes, s.price_cents,
    case when st.availability in ('AVAILABLE', 'SOLD_OUT') then coalesce(public.available_spots(s.id), 0) end,
    st.availability
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  cross join lateral (select public.special_event_availability(s.id) as availability) st
  where e.slug = lower(trim(p_slug))
    and e.kind = 'EVENT'
    and e.status = 'PUBLISHED'
    and s.status <> 'ARCHIVED'
  order by s.starts_at, s.id;
$$;

commit;
