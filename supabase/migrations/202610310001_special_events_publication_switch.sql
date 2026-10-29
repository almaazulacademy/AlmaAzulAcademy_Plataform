-- Eventos especiais — interruptor de publicação também nas leituras públicas.
--
-- Depende só de `202610280001_special_events_foundation.sql` (aplicada). Não
-- depende de `202610300001_waitlist_event_scope.sql`: as duas podem ser
-- aplicadas em qualquer ordem.
--
-- Até aqui `special_event_settings.publication_enabled` só travava o ato de
-- publicar (trigger de `experiences`). Desligá-lo depois não escondia o evento:
-- as leituras públicas filtravam por `kind = 'EVENT'` e `status = 'PUBLISHED'`.
-- Esta migration acrescenta o interruptor a essas leituras:
--
--   * `list_public_events()`         — corpo novo: + interruptor ligado.
--   * `list_public_event_sessions()` — corpo novo: + interruptor ligado.
--   * `get_public_event(slug)`       — **não muda**: lê de `list_public_events`
--                                      e passa a respeitar o interruptor junto.
--
-- Mesmas assinaturas, mesmas colunas, mesma ordem, `security definer` e
-- `search_path` iguais; as permissões existentes ficam (create or replace não
-- mexe em grants). Nenhuma leitura das experiências regulares é tocada, nada é
-- escrito em tabela, nenhum agendamento.
--
-- Interruptor desligado: as três leituras ficam vazias para eventos — página,
-- menu, home, sitemap e redirecionamento somem; a reserva (`POST
-- /api/reservations`) e a inscrição na lista de espera, que conferem o evento
-- por essas leituras no servidor, recusam. Religado: volta o que estiver
-- publicado e com sessão; rascunho continua rascunho e venda fechada continua
-- fechada.

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
    and coalesce((select ses.publication_enabled from public.special_event_settings ses where ses.singleton), false)
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
    and coalesce((select ses.publication_enabled from public.special_event_settings ses where ses.singleton), false)
    and s.status <> 'ARCHIVED'
  order by s.starts_at, s.id;
$$;
