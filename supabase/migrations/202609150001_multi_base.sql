-- Multi-base: Alma Azul → Base → Experiência → Sessão → Reserva.
--
-- Aditiva e idempotente. Nenhuma tabela, coluna, linha ou tipo é removido.
-- Sessões e reservas NÃO ganham uma coluna de base: a base é derivada da
-- experiência (sessions.experience_id → experiences.base_id), então não existe
-- um segundo vínculo que possa divergir. Todo o histórico atual passa a ser
-- Base Lago Norte pelo preenchimento de experiences.base_id.
--
-- A única alteração de constraint é ampliar experiences_status_check para
-- aceitar COMING_SOON. Nenhum valor existente deixa de ser válido.
--
-- Reservar continua exigindo experiência PUBLISHED em list_open_sessions,
-- get_booking_session e create_pre_reservation — esta migration não toca
-- nenhuma delas. O bloqueio de uma base que não está ativa vem de uma
-- invariante nova: uma experiência só pode ser PUBLISHED se a base estiver
-- ACTIVE. Assim a Concha Acústica não é reservável por nenhum caminho.

do $$
begin
  if to_regprocedure('public.list_public_experiences()') is null
     or to_regprocedure('public.is_active_admin(uuid)') is null then
    raise exception 'DYNAMIC_EXPERIENCES_MIGRATION_REQUIRED';
  end if;
  if not exists (select 1 from public.experiences where slug = 'imersao-paranoa') then
    raise exception 'IMERSAO_PARANOA_REQUIRED';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Bases
-- ---------------------------------------------------------------------------
create table if not exists public.bases (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  status text not null default 'COMING_SOON',
  short_description text not null default '',
  description text not null default '',
  location_label text not null default '',
  address text,
  partner_name text,
  image_url text,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bases_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint bases_name_length check (char_length(btrim(name)) between 2 and 80),
  constraint bases_status_check check (status in ('ACTIVE', 'COMING_SOON', 'INACTIVE')),
  constraint bases_image_url_length check (image_url is null or char_length(image_url) <= 2048),
  constraint bases_display_order_nonnegative check (display_order >= 0)
);

drop trigger if exists bases_set_updated_at on public.bases;
create trigger bases_set_updated_at before update on public.bases
  for each row execute function public.set_updated_at();

create index if not exists bases_display_order_idx on public.bases (display_order, name);

alter table public.bases enable row level security;
revoke all on table public.bases from anon, authenticated;
grant select on table public.bases to anon, authenticated;
grant select, insert, update on table public.bases to service_role;
drop policy if exists "visible bases are readable" on public.bases;
create policy "visible bases are readable" on public.bases
  for select to anon, authenticated using (status <> 'INACTIVE');

-- Não sobrescreve edições posteriores: reaplicar a migration não restaura textos.
insert into public.bases (slug, name, status, short_description, description, location_label, address, partner_name, image_url, display_order)
values
  (
    'lago-norte',
    'Lago Norte',
    'ACTIVE',
    'Nossa base de origem, entre a mata do Córrego do Torto e as águas abertas do Lago Paranoá.',
    'É daqui que saem todas as experiências da Alma Azul hoje. Uma base à beira do Lago Paranoá, perto de um dos trechos mais preservados de Brasília, com canoas havaianas, equipamentos e instrutores prontos para receber quem nunca remou e quem já é da casa.',
    'Lago Norte · Brasília',
    'QL 5 Conjunto 5 - Lago Norte',
    null,
    '/images/experiences/imersao-paranoa/lago/vista-aerea-lago.webp',
    0
  ),
  (
    'concha-acustica',
    'Concha Acústica',
    'COMING_SOON',
    'Alma Azul na Concha Acústica, em parceria com o Cápsula Bar.',
    'Uma nova forma de viver o Lago Paranoá: remadas que partem do coração de Brasília, com a cidade vista a partir da água. A programação ainda não está aberta.',
    'Concha Acústica · Brasília',
    null,
    'Cápsula Bar',
    '/images/experiences/remada-sunset/remada-sunset-sobre.webp',
    1
  )
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Experiências ganham base, exclusividade e modalidade
-- ---------------------------------------------------------------------------
alter table public.experiences
  add column if not exists base_id uuid references public.bases(id) on delete restrict,
  add column if not exists is_exclusive boolean not null default false,
  add column if not exists modality text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.experiences'::regclass and conname = 'experiences_modality_format'
  ) then
    alter table public.experiences add constraint experiences_modality_format
      check (modality is null or modality ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
  end if;
end;
$$;

-- Backfill: tudo o que existe hoje é operação da Base Lago Norte.
update public.experiences
set base_id = (select id from public.bases where slug = 'lago-norte')
where base_id is null;

update public.experiences
set modality = slug
where modality is null;

update public.experiences
set is_exclusive = true
where slug = 'imersao-paranoa' and is_exclusive = false;

alter table public.experiences alter column base_id set not null;

create index if not exists experiences_base_display_order_idx
  on public.experiences (base_id, display_order, title);

-- Base NÃO tem valor padrão: o backfill acima é explícito e só vale para o que
-- já existia. Daqui em diante, experiência sem base é recusada pelo NOT NULL —
-- nenhuma experiência nova cai no Lago Norte por omissão.
--
-- `modality` é só apresentação (agrupa a mesma modalidade na vitrine). O padrão
-- é o próprio slug, então nenhuma experiência é agrupada com outra sem que
-- alguém declare isso explicitamente.
create or replace function public.apply_experience_modality_default()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.modality is null then
    new.modality := new.slug;
  end if;
  return new;
end;
$$;

drop trigger if exists experiences_modality_default on public.experiences;
create trigger experiences_modality_default
  before insert on public.experiences
  for each row execute function public.apply_experience_modality_default();

-- ---------------------------------------------------------------------------
-- 3. Status COMING_SOON para experiências
-- ---------------------------------------------------------------------------
-- Troca somente o CHECK de status que ainda não aceita COMING_SOON (o nome pode
-- variar entre a instalação limpa e o banco legado). Os valores atuais
-- continuam válidos, então nenhuma linha é afetada.
do $$
declare
  status_constraint record;
begin
  for status_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.experiences'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
      and pg_get_constraintdef(oid) ilike '%PUBLISHED%'
      and pg_get_constraintdef(oid) not ilike '%COMING_SOON%'
  loop
    execute format('alter table public.experiences drop constraint %I', status_constraint.conname);
  end loop;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.experiences'::regclass and conname = 'experiences_status_check'
  ) then
    alter table public.experiences add constraint experiences_status_check
      check (status in ('DRAFT', 'PUBLISHED', 'COMING_SOON', 'ARCHIVED'));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Invariante: reservável ⇔ experiência PUBLISHED ⇒ base ACTIVE
-- ---------------------------------------------------------------------------
create or replace function public.enforce_experience_base_active()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'PUBLISHED'
     and not exists (select 1 from public.bases where id = new.base_id and status = 'ACTIVE') then
    raise exception 'BASE_NOT_ACTIVE'
      using errcode = 'P0001',
            detail = 'Uma experiência só pode ser publicada em uma base ativa.';
  end if;
  return new;
end;
$$;

drop trigger if exists experiences_base_requires_active on public.experiences;
create trigger experiences_base_requires_active
  before insert or update of status, base_id on public.experiences
  for each row execute function public.enforce_experience_base_active();

create or replace function public.enforce_base_status_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status <> 'ACTIVE'
     and old.status = 'ACTIVE'
     and exists (select 1 from public.experiences where base_id = new.id and status = 'PUBLISHED') then
    raise exception 'BASE_HAS_PUBLISHED_EXPERIENCES'
      using errcode = 'P0001',
            detail = 'Retire as experiências publicadas da base antes de mudar o status dela.';
  end if;
  return new;
end;
$$;

drop trigger if exists bases_status_guard on public.bases;
create trigger bases_status_guard
  before update of status on public.bases
  for each row execute function public.enforce_base_status_change();

-- Sessão só existe em base ativa. Garante no banco que a Concha não tenha
-- nenhum horário — nem criado pelo painel, nem movido de outra experiência.
-- Só dispara ao gravar experience_id: status, arquivamento e reservas de
-- sessões existentes não passam por aqui.
create or replace function public.enforce_session_base_active()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- UPDATE que regrava o mesmo experience_id (o painel sempre envia o campo) não é mudança.
  if tg_op = 'UPDATE' and new.experience_id is not distinct from old.experience_id then
    return new;
  end if;
  if not exists (
    select 1
    from public.experiences e
    join public.bases b on b.id = e.base_id
    where e.id = new.experience_id and b.status = 'ACTIVE'
  ) then
    raise exception 'SESSION_BASE_NOT_ACTIVE'
      using errcode = 'P0001',
            detail = 'Sessões só podem ser criadas em experiências de uma base ativa.';
  end if;
  return new;
end;
$$;

drop trigger if exists sessions_base_requires_active on public.sessions;
create trigger sessions_base_requires_active
  before insert or update of experience_id on public.sessions
  for each row execute function public.enforce_session_base_active();

revoke all on function public.apply_experience_modality_default() from public, anon, authenticated;
revoke all on function public.enforce_session_base_active() from public, anon, authenticated;
revoke all on function public.enforce_experience_base_active() from public, anon, authenticated;
revoke all on function public.enforce_base_status_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Experiências planejadas da Base Concha Acústica (EM BREVE)
-- ---------------------------------------------------------------------------
-- Sem sessões, sem preço e sem capacidade: price_cents e default_capacity ficam
-- em 0 como "ainda não definido" e precisam ser preenchidos antes da abertura.
-- editorial_content fica vazio: a landing completa só é exigida para publicar.
do $migration$
declare
  concha_id uuid;
  legacy_column_count integer;
  item record;
begin
  select id into concha_id from public.bases where slug = 'concha-acustica';
  if concha_id is null then
    raise exception 'CONCHA_ACUSTICA_BASE_REQUIRED';
  end if;

  select count(*) into legacy_column_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'experiences'
    and column_name = any (array['eyebrow', 'short_description', 'location', 'cover_image', 'gallery', 'included', 'active']);

  if legacy_column_count not in (0, 7) then
    raise exception using
      message = 'EXPERIENCES_LEGACY_SCHEMA_INCOMPLETE',
      detail = format('Expected none or all 7 compatibility columns, found %s.', legacy_column_count);
  end if;

  for item in
    select *
    from (values
      (
        'caminhos-do-paranoa', 'Caminhos do Paranoá', 'caminhos-do-paranoa', 'Remada de dia',
        'Uma remada pelo Lago Paranoá para descobrir Brasília a partir da água.',
        '/images/backgrounds/hero-alma-azul-lago.webp', 100
      ),
      (
        'remada-nascer-do-sol-concha-acustica', 'Remada Nascer do Sol', 'remada-nascer-do-sol', 'Amanhecer no lago',
        'O dia começando devagar, com o sol nascendo sobre o Lago Paranoá.',
        '/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-hero.webp', 101
      ),
      (
        'remada-sunset-concha-acustica', 'Remada Sunset', 'remada-sunset', 'Pôr do sol no lago',
        'As últimas luzes do dia vistas de dentro de uma canoa havaiana.',
        '/images/experiences/remada-sunset/remada-sunset-hero.webp', 102
      ),
      (
        'remada-lua-cheia-concha-acustica', 'Remada Lua Cheia', 'remada-lua-cheia', 'Noite de lua cheia',
        'Uma remada noturna guiada pelo ritmo da água e pela luz da lua.',
        '/images/experiences/remada-lua-cheia/remada-lua-cheia-hero.webp', 103
      )
    ) as seed(slug, title, modality, eyebrow, summary, image_url, display_order)
  loop
    if legacy_column_count = 7 then
      execute $legacy_insert$
        insert into public.experiences (
          slug, title, eyebrow, short_description, description, location, cover_image,
          gallery, included, active, summary, price_cents, default_capacity, status,
          image_url, display_order, editorial_content, base_id, is_exclusive, modality
        )
        values (
          $1, $2, $3, $4, $4, 'Concha Acústica, Brasília', $5,
          '[]'::jsonb, '[]'::jsonb, false, $4, 0, 0, 'COMING_SOON',
          $5, $6, '{}'::jsonb, $7, false, $8
        )
        on conflict (slug) do nothing
      $legacy_insert$
      using item.slug, item.title, item.eyebrow, item.summary, item.image_url, item.display_order, concha_id, item.modality;
    else
      insert into public.experiences (
        slug, title, summary, description, price_cents, default_capacity, status,
        image_url, display_order, editorial_content, base_id, is_exclusive, modality
      )
      values (
        item.slug, item.title, item.summary, item.summary, 0, 0, 'COMING_SOON',
        item.image_url, item.display_order, '{}'::jsonb, concha_id, false, item.modality
      )
      on conflict (slug) do nothing;
    end if;
  end loop;
end;
$migration$;

-- ---------------------------------------------------------------------------
-- 6. Leituras públicas
-- ---------------------------------------------------------------------------
create or replace function public.list_public_bases()
returns table (
  id uuid, slug text, name text, status text, short_description text, description text,
  location_label text, address text, partner_name text, image_url text, display_order integer
)
language sql stable security definer set search_path = public as $$
  select b.id, b.slug, b.name, b.status, b.short_description, b.description,
         b.location_label, b.address, b.partner_name, b.image_url, b.display_order
  from public.bases b
  where b.status <> 'INACTIVE'
  order by b.display_order, b.name;
$$;

-- Catálogo público multi-base: publicadas (com landing) e "em breve".
-- Não devolve preço, duração, capacidade nem campos administrativos.
create or replace function public.list_public_catalog()
returns table (
  id uuid, slug text, title text, summary text, status text, image_url text,
  display_order integer, editorial_content jsonb, base_id uuid, base_slug text,
  is_exclusive boolean, modality text
)
language sql stable security definer set search_path = public as $$
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
$$;

-- Contexto de uma URL de reserva. Permite explicar "em breve" em vez de
-- "sessão indisponível". Nunca devolve dados de reserva nem de sessão.
create or replace function public.public_session_context(p_session_id uuid)
returns table (
  experience_slug text, experience_title text, experience_status text,
  base_slug text, base_name text, base_status text
)
language sql stable security definer set search_path = public as $$
  select e.slug, e.title, e.status, b.slug, b.name, b.status
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  join public.bases b on b.id = e.base_id
  where s.id = p_session_id
    and e.status in ('PUBLISHED', 'COMING_SOON')
    and b.status <> 'INACTIVE';
$$;

revoke all on function public.list_public_bases() from public;
revoke all on function public.list_public_catalog() from public;
revoke all on function public.public_session_context(uuid) from public;
grant execute on function public.list_public_bases() to anon, authenticated, service_role;
grant execute on function public.list_public_catalog() to anon, authenticated, service_role;
grant execute on function public.public_session_context(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Painel: base obrigatória ao criar e editar experiência
-- ---------------------------------------------------------------------------
-- Novas sobrecargas com p_base_id. As anteriores continuam existindo, mas uma
-- criação sem base agora falha no NOT NULL de base_id — de propósito.
create or replace function public.admin_create_experience(p_actor_id uuid,p_slug text,p_title text,p_summary text,p_status text,p_image_url text,p_display_order integer,p_description text,p_duration_minutes integer,p_price_cents integer,p_default_capacity integer,p_editorial_content jsonb,p_base_id uuid)
returns uuid language plpgsql security definer set search_path=public as $$ declare created_id uuid; begin
  if not public.is_active_admin(p_actor_id) then raise exception 'ADMIN_FORBIDDEN' using errcode='42501'; end if;
  if p_base_id is null then raise exception 'BASE_REQUIRED' using errcode='22023'; end if;
  if not exists(select 1 from public.bases where id=p_base_id) then raise exception 'BASE_NOT_FOUND' using errcode='22023'; end if;
  if p_slug in ('admin','api','login','reservar','pagamento','acompanhar-reserva','experiencias','imersao-paranoa','bases') then raise exception 'RESERVED_EXPERIENCE_SLUG' using errcode='22023'; end if;
  if exists(select 1 from public.experiences where slug=p_slug) then raise exception 'EXPERIENCE_SLUG_EXISTS' using errcode='23505'; end if;
  if p_status='PUBLISHED' and not public.experience_editorial_is_publishable(p_editorial_content) then raise exception 'INCOMPLETE_EDITORIAL_CONTENT' using errcode='22023'; end if;
  insert into public.experiences(slug,title,summary,description,duration_minutes,price_cents,default_capacity,status,image_url,display_order,editorial_content,base_id)
  values(p_slug,p_title,p_summary,p_description,p_duration_minutes,p_price_cents,p_default_capacity,p_status,nullif(p_image_url,''),p_display_order,coalesce(p_editorial_content,'{}'::jsonb),p_base_id) returning id into created_id;
  insert into public.admin_audit_log(actor_user_id,action,entity_type,entity_id,metadata) values(p_actor_id,'EXPERIENCE_CREATED','experience',created_id,jsonb_build_object('title',p_title,'slug',p_slug,'baseId',p_base_id));
  return created_id;
end $$;

-- Trocar a base só é permitido enquanto a experiência não tem sessões: as
-- sessões, reservas e a receita dela pertencem à base em que aconteceram.
create or replace function public.admin_update_experience(p_actor_id uuid,p_experience_id uuid,p_title text,p_summary text,p_status text,p_image_url text,p_display_order integer,p_description text,p_duration_minutes integer,p_price_cents integer,p_default_capacity integer,p_editorial_content jsonb,p_base_id uuid)
returns boolean language plpgsql security definer set search_path=public as $$ declare current_base uuid; begin
  if not public.is_active_admin(p_actor_id) then raise exception 'ADMIN_FORBIDDEN' using errcode='42501'; end if;
  if p_base_id is null then raise exception 'BASE_REQUIRED' using errcode='22023'; end if;
  if not exists(select 1 from public.bases where id=p_base_id) then raise exception 'BASE_NOT_FOUND' using errcode='22023'; end if;
  select base_id into current_base from public.experiences where id=p_experience_id for update;
  if not found then raise exception 'EXPERIENCE_NOT_FOUND'; end if;
  if current_base <> p_base_id and exists(select 1 from public.sessions where experience_id=p_experience_id) then raise exception 'EXPERIENCE_BASE_LOCKED' using errcode='P0001'; end if;
  if p_status='PUBLISHED' and not public.experience_editorial_is_publishable(p_editorial_content) then raise exception 'INCOMPLETE_EDITORIAL_CONTENT' using errcode='22023'; end if;
  update public.experiences set title=p_title,summary=p_summary,description=p_description,duration_minutes=p_duration_minutes,price_cents=p_price_cents,default_capacity=p_default_capacity,status=p_status,image_url=nullif(p_image_url,''),display_order=p_display_order,editorial_content=coalesce(p_editorial_content,'{}'::jsonb),base_id=p_base_id,updated_at=now() where id=p_experience_id;
  insert into public.admin_audit_log(actor_user_id,action,entity_type,entity_id,metadata) values(p_actor_id,'EXPERIENCE_UPDATED','experience',p_experience_id,jsonb_build_object('title',p_title,'status',p_status,'baseId',p_base_id,'previousBaseId',current_base));
  return true;
end $$;

revoke all on function public.admin_create_experience(uuid,text,text,text,text,text,integer,text,integer,integer,integer,jsonb,uuid) from public, anon, authenticated;
revoke all on function public.admin_update_experience(uuid,uuid,text,text,text,text,integer,text,integer,integer,integer,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.admin_create_experience(uuid,text,text,text,text,text,integer,text,integer,integer,integer,jsonb,uuid) to service_role;
grant execute on function public.admin_update_experience(uuid,uuid,text,text,text,text,integer,text,integer,integer,integer,jsonb,uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Dashboard administrativo por base
-- ---------------------------------------------------------------------------
-- Mesmas definições de admin_dashboard_metrics, recortadas por base.
-- p_base_id nulo = todas as bases. A função original continua intacta.
create or replace function public.admin_base_dashboard_metrics(p_actor_id uuid, p_base_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  result jsonb;
begin
  if not public.is_active_admin(p_actor_id) then
    raise exception 'ADMIN_FORBIDDEN' using errcode = '42501';
  end if;

  with
    base_experiences as (
      select e.id, e.title from public.experiences e
      where p_base_id is null or e.base_id = p_base_id
    ),
    base_sessions as (
      select s.* from public.sessions s join base_experiences be on be.id = s.experience_id
    ),
    base_reservations as (
      select r.* from public.reservations r join base_experiences be on be.id = r.experience_id
    ),
    upcoming as (
      select s.id, s.starts_at, s.capacity, s.status, be.title
      from base_sessions s join base_experiences be on be.id = s.experience_id
      where s.starts_at > now() and s.status not in ('CANCELLED', 'ARCHIVED')
    )
  select jsonb_build_object(
    'nextSession', (
      select jsonb_build_object('id', u.id, 'experienceTitle', u.title, 'startsAt', u.starts_at, 'remainingSpots', public.available_spots(u.id))
      from upcoming u order by u.starts_at limit 1
    ),
    'upcomingSessions', (
      select coalesce(jsonb_agg(item order by item->>'startsAt'), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'id', u.id, 'experienceTitle', u.title, 'startsAt', u.starts_at, 'status', u.status,
          'capacity', u.capacity, 'remainingSpots', public.available_spots(u.id)
        ) as item
        from upcoming u order by u.starts_at limit 8
      ) next_sessions
    ),
    'experiencesCount', (select count(*) from base_experiences),
    'sessionsCount', (select count(*) from base_sessions where status <> 'ARCHIVED'),
    'futureSessions', (select count(*) from upcoming),
    'confirmedReservations', (select count(*) from base_reservations where status = 'CONFIRMED'),
    'cancelledReservations', (select count(*) from base_reservations where status = 'CANCELLED'),
    'totalReservations', (select count(*) from base_reservations),
    'preReservations', (select count(*) from base_reservations where status = 'PRE_RESERVED' and expires_at > now()),
    'expectedRevenueCents', (select coalesce(sum(total_cents), 0) from base_reservations where status = 'CONFIRMED' or (status = 'PRE_RESERVED' and expires_at > now())),
    'confirmedRevenueCents', (select coalesce(sum(total_cents), 0) from base_reservations where status = 'CONFIRMED'),
    'totalParticipants', (select coalesce(sum(quantity), 0) from base_reservations where status = 'CONFIRMED'),
    'averageOccupancyRate', (select coalesce(round(avg((u.capacity - public.available_spots(u.id)) * 100.0 / nullif(u.capacity, 0)), 1), 0) from upcoming u),
    'topExperience', (
      select be.title from base_reservations r join base_experiences be on be.id = r.experience_id
      where r.status = 'CONFIRMED' group by be.id, be.title order by sum(r.quantity) desc limit 1
    ),
    'monthlyRevenueCents', (select coalesce(sum(total_cents), 0) from base_reservations where status = 'CONFIRMED' and confirmed_at >= date_trunc('month', now())),
    'averageTicketCents', (select coalesce(round(avg(total_cents)), 0) from base_reservations where status = 'CONFIRMED'),
    'revenueByMonth', (
      select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m.month, 'Mon'), 'revenueCents', coalesce(x.total, 0)) order by m.month), '[]'::jsonb)
      from generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') m(month)
      left join lateral (
        select sum(total_cents) total from base_reservations
        where status = 'CONFIRMED' and confirmed_at >= m.month and confirmed_at < m.month + interval '1 month'
      ) x on true
    ),
    'lastUpdatedAt', greatest(
      coalesce((select max(updated_at) from base_sessions), '-infinity'::timestamptz),
      coalesce((select max(updated_at) from base_reservations), '-infinity'::timestamptz)
    )
  ) into result;

  return result;
end;
$$;

revoke all on function public.admin_base_dashboard_metrics(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_base_dashboard_metrics(uuid, uuid) to service_role;
