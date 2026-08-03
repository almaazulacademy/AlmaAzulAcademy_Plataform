-- Sprint 5.2: canonical, versioned editorial content for dynamic public experiences.
-- Additive by design: no historical or legacy field is removed or rewritten.

alter table public.experiences
  add column if not exists editorial_content jsonb;

update public.experiences
set editorial_content = '{}'::jsonb
where editorial_content is null;

alter table public.experiences
  alter column editorial_content set default '{}'::jsonb,
  alter column editorial_content set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.experiences'::regclass
      and conname = 'experiences_editorial_content_object'
  ) then
    alter table public.experiences add constraint experiences_editorial_content_object
      check (jsonb_typeof(editorial_content) = 'object');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.experiences'::regclass
      and conname = 'experiences_editorial_content_size'
  ) then
    alter table public.experiences add constraint experiences_editorial_content_size
      check (octet_length(editorial_content::text) <= 200000);
  end if;
end;
$$;

update public.experiences
set image_url = coalesce(image_url, '/images/backgrounds/corredor-corrego-do-torto.webp'),
    editorial_content = $editorial$
{
  "version": 1,
  "hero": {
    "eyebrow": "Experiência inaugural · Alma Azul Academy",
    "title": "Imersão Paranoá",
    "subtitle": "Explore o lado mais preservado do Lago Paranoá.",
    "image": { "src": "/images/backgrounds/hero-alma-azul-lago.webp", "alt": "Canoas da Alma Azul no Lago Paranoá vistas de cima" },
    "primaryCta": { "label": "Ver próximas datas", "href": "#reservas" },
    "secondaryCta": { "label": "Conheça o percurso", "href": "#sobre" },
    "details": ["Brasília, DF", "1h30 de experiência", "Nível iniciante"]
  },
  "quickFacts": [
    { "label": "Onde", "value": "Lago Paranoá" },
    { "label": "Formato", "value": "Em grupo" },
    { "label": "Duração", "value": "1h30" },
    { "label": "Reservas", "value": "Datas abertas" }
  ],
  "about": {
    "eyebrow": "Sobre a experiência",
    "title": "Explore o lado mais preservado do Lago Paranoá.",
    "paragraphs": [
      "Uma experiência de 1h30 navegando pelo Lago Paranoá por um dos lugares mais preservados e belos de Brasília: o Córrego do Torto.",
      "No caminho passamos por paisagens que poucas pessoas conhecem, fazemos uma pausa para banho em uma prainha no meio do lago e encerramos tudo com um lanche colaborativo na nossa base."
    ],
    "image": { "src": "/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-2672.webp", "alt": "Canoas saindo do corredor verde em direção ao lago" }
  },
  "gallery": {
    "eyebrow": "Galeria",
    "title": "Água, mata e boas companhias.",
    "description": "Registros reais da Alma Azul. Sem banco de imagens, sem cenário montado.",
    "images": [
      { "src": "/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-2074.webp", "alt": "Canoas navegando sob a mata do Córrego do Torto" },
      { "src": "/images/experiences/imersao-paranoa/lago/alma-azul-original.webp", "alt": "Participantes tomando banho no Lago Paranoá" },
      { "src": "/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-1956.webp", "alt": "Grupo remando no corredor natural" },
      { "src": "/images/experiences/imersao-paranoa/grupos/img-3964.webp", "alt": "Grupo reunido entre canoas" },
      { "src": "/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-2672.webp", "alt": "Paisagem aberta entre o córrego e a vegetação" },
      { "src": "/images/experiences/imersao-paranoa/lago/img-4363.webp", "alt": "Grupo celebrando a chegada ao lago com os remos erguidos" }
    ]
  },
  "steps": {
    "eyebrow": "Como funciona", "title": "Do encontro ao mergulho.", "description": "Uma jornada simples, bem conduzida e no ritmo do grupo.",
    "items": [
      { "title": "Encontro", "description": "Recepção do grupo, preparação dos equipamentos e orientações de segurança." },
      { "title": "Travessia", "description": "Remada guiada pelo corredor do Córrego do Torto, cercado pela mata." },
      { "title": "Lago", "description": "Chegada ao Paranoá, pausa para banho e tempo para aproveitar a paisagem." }
    ]
  },
  "included": {
    "eyebrow": "Tudo preparado", "title": "O que está incluso.", "description": "Você chega com disposição. A Alma Azul cuida da estrutura da experiência.",
    "items": [
      { "icon": "LifeBuoy", "title": "Equipamentos", "description": "Coletes salva-vidas e remos preparados para a experiência." },
      { "icon": "Compass", "title": "Instrutores em cada canoa", "description": "Acompanhamento próximo da equipe Alma Azul durante todo o percurso." },
      { "icon": "ShieldCheck", "title": "Instrução para iniciantes", "description": "Orientação completa antes da saída, mesmo para quem nunca remou." },
      { "icon": "Sparkles", "title": "Lanche colaborativo", "description": "Encontro na base ao final, com café preto por conta da casa." },
      { "icon": "Droplets", "title": "Banho no lago", "description": "Uma pausa para entrar na água e aproveitar o Lago Paranoá." }
    ]
  },
  "faq": {
    "eyebrow": "Dúvidas frequentes", "title": "Antes de entrar na água.", "locationLabel": "Brasília · Distrito Federal",
    "items": [
      { "question": "Preciso ter experiência com canoa?", "answer": "Não. A experiência é conduzida pela equipe Alma Azul e começa com orientações sobre remada e segurança. O percurso foi pensado para receber também quem está começando." },
      { "question": "Preciso saber nadar?", "answer": "O uso do colete salva-vidas é parte da experiência. As orientações específicas de participação e segurança serão confirmadas no momento da reserva, em uma próxima etapa da plataforma." },
      { "question": "O que devo levar?", "answer": "Roupas leves que possam molhar, proteção solar, garrafa de água e uma troca de roupa. A lista completa será enviada antes de cada edição." },
      { "question": "Quanto tempo dura a experiência?", "answer": "A experiência dura aproximadamente 1h30. O horário exato e as informações do encontro aparecem em cada sessão disponível." },
      { "question": "Quando as reservas serão abertas?", "answer": "As próximas sessões abertas aparecem automaticamente na seção Próximas datas. A reserva online será habilitada em uma etapa futura." }
    ]
  },
  "reservations": {
    "eyebrow": "Escolha seu dia", "title": "Próximas datas", "description": "Confira as sessões futuras e abertas, escolha sua data e garanta suas vagas com pagamento seguro.",
    "image": { "src": "/images/experiences/imersao-paranoa/lago/img-1225.webp", "alt": "Grupo observando o Lago Paranoá ao final da travessia" }
  },
  "seo": { "title": "Imersão Paranoá", "description": "Uma travessia de canoa pelo corredor do Córrego do Torto até o Lago Paranoá, em Brasília." }
}
$editorial$::jsonb,
    updated_at = now()
where slug = 'imersao-paranoa'
  and (editorial_content = '{}'::jsonb or editorial_content is null);

create or replace function public.experience_editorial_is_publishable(p_content jsonb)
returns boolean language sql immutable set search_path = public as $$
  select coalesce(
    jsonb_typeof(p_content) = 'object'
    and p_content->>'version' = '1'
    and jsonb_typeof(p_content->'hero') = 'object'
    and btrim(p_content->'hero'->>'title') <> ''
    and btrim(p_content->'hero'->>'subtitle') <> ''
    and btrim(p_content->'hero'->'image'->>'src') <> ''
    and btrim(p_content->'hero'->'image'->>'alt') <> ''
    and jsonb_typeof(p_content->'quickFacts') = 'array'
    and jsonb_array_length(p_content->'quickFacts') > 0
    and jsonb_typeof(p_content->'about') = 'object'
    and btrim(p_content->'about'->>'title') <> ''
    and jsonb_typeof(p_content->'about'->'paragraphs') = 'array'
    and jsonb_array_length(p_content->'about'->'paragraphs') > 0
    and btrim(p_content->'about'->'image'->>'src') <> ''
    and btrim(p_content->'about'->'image'->>'alt') <> ''
    and jsonb_typeof(p_content->'reservations') = 'object'
    and btrim(p_content->'reservations'->>'title') <> ''
    and btrim(p_content->'reservations'->>'description') <> ''
    and btrim(p_content->'reservations'->'image'->>'src') <> ''
    and btrim(p_content->'reservations'->'image'->>'alt') <> ''
    and jsonb_typeof(p_content->'seo') = 'object'
    and btrim(p_content->'seo'->>'title') <> ''
    and btrim(p_content->'seo'->>'description') <> '',
    false
  );
$$;

create or replace function public.get_public_experience(p_slug text)
returns table (id uuid, slug text, title text, summary text, image_url text, display_order integer, editorial_content jsonb)
language sql stable security definer set search_path = public as $$
  select e.id, e.slug, e.title, e.summary, e.image_url, e.display_order, e.editorial_content
  from public.experiences e
  where e.slug = lower(trim(p_slug)) and e.status = 'PUBLISHED';
$$;

create or replace function public.list_public_experiences()
returns table (id uuid, slug text, title text, summary text, image_url text, display_order integer, editorial_content jsonb)
language sql stable security definer set search_path = public as $$
  select e.id, e.slug, e.title, e.summary, e.image_url, e.display_order, e.editorial_content
  from public.experiences e
  where e.status = 'PUBLISHED' and e.editorial_content <> '{}'::jsonb
  order by e.display_order, e.title;
$$;

-- RETURNS TABLE changed in Sprint 5.2. PostgreSQL cannot replace a function
-- when its OUT columns change, so remove only this exact signature and only
-- when its current output contract is incompatible. No CASCADE is used: an
-- unexpected database dependency aborts safely instead of being removed.
do $$
declare
  function_oid oid := to_regprocedure('public.admin_list_experiences(uuid)');
  existing_output_types oid[];
  existing_output_names text[];
  expected_output_types oid[] := array[
    'uuid'::regtype::oid,
    'text'::regtype::oid,
    'text'::regtype::oid,
    'text'::regtype::oid,
    'text'::regtype::oid,
    'integer'::regtype::oid,
    'integer'::regtype::oid,
    'integer'::regtype::oid,
    'text'::regtype::oid,
    'text'::regtype::oid,
    'integer'::regtype::oid,
    'jsonb'::regtype::oid,
    'bigint'::regtype::oid,
    'timestamp with time zone'::regtype::oid,
    'timestamp with time zone'::regtype::oid
  ];
  expected_output_names text[] := array[
    'id', 'slug', 'title', 'summary', 'description', 'duration_minutes',
    'price_cents', 'default_capacity', 'status', 'image_url', 'display_order',
    'editorial_content', 'sessions_count', 'created_at', 'updated_at'
  ];
begin
  if function_oid is not null then
    select
      array_agg(argument.arg_type order by argument.ordinality),
      array_agg(argument.arg_name order by argument.ordinality)
    into existing_output_types, existing_output_names
    from pg_proc proc
    cross join lateral unnest(proc.proallargtypes, proc.proargmodes, proc.proargnames)
      with ordinality as argument(arg_type, arg_mode, arg_name, ordinality)
    where proc.oid = function_oid
      and argument.arg_mode in ('o', 't');

    if existing_output_types is distinct from expected_output_types
       or existing_output_names is distinct from expected_output_names then
      execute 'drop function public.admin_list_experiences(uuid)';
    end if;
  end if;
end;
$$;

create or replace function public.admin_list_experiences(p_actor_id uuid)
returns table (id uuid, slug text, title text, summary text, description text, duration_minutes integer, price_cents integer, default_capacity integer, status text, image_url text, display_order integer, editorial_content jsonb, sessions_count bigint, created_at timestamptz, updated_at timestamptz)
language plpgsql stable security definer set search_path=public as $$
begin
  if not public.is_active_admin(p_actor_id) then raise exception 'ADMIN_FORBIDDEN' using errcode='42501'; end if;
  return query select e.id,e.slug,e.title,e.summary,e.description,e.duration_minutes,e.price_cents,e.default_capacity,e.status,e.image_url,e.display_order,e.editorial_content,count(s.id),e.created_at,e.updated_at
  from public.experiences e left join public.sessions s on s.experience_id=e.id group by e.id order by e.display_order,e.title;
end $$;

-- The Sprint 5.2 overloads add p_editorial_content. Their scalar return types
-- remain uuid/boolean, so CREATE OR REPLACE is safe for partial or repeated runs.
-- Older overloads are retained for compatibility with earlier server builds.
create or replace function public.admin_create_experience(p_actor_id uuid,p_slug text,p_title text,p_summary text,p_status text,p_image_url text,p_display_order integer,p_description text,p_duration_minutes integer,p_price_cents integer,p_default_capacity integer,p_editorial_content jsonb)
returns uuid language plpgsql security definer set search_path=public as $$ declare created_id uuid; begin
  if not public.is_active_admin(p_actor_id) then raise exception 'ADMIN_FORBIDDEN' using errcode='42501'; end if;
  if p_slug in ('admin','api','login','reservar','pagamento','acompanhar-reserva','experiencias','imersao-paranoa') then raise exception 'RESERVED_EXPERIENCE_SLUG' using errcode='22023'; end if;
  if exists(select 1 from public.experiences where slug=p_slug) then raise exception 'EXPERIENCE_SLUG_EXISTS' using errcode='23505'; end if;
  if p_status='PUBLISHED' and not public.experience_editorial_is_publishable(p_editorial_content) then raise exception 'INCOMPLETE_EDITORIAL_CONTENT' using errcode='22023'; end if;
  insert into public.experiences(slug,title,summary,description,duration_minutes,price_cents,default_capacity,status,image_url,display_order,editorial_content)
  values(p_slug,p_title,p_summary,p_description,p_duration_minutes,p_price_cents,p_default_capacity,p_status,nullif(p_image_url,''),p_display_order,coalesce(p_editorial_content,'{}'::jsonb)) returning id into created_id;
  insert into public.admin_audit_log(actor_user_id,action,entity_type,entity_id,metadata) values(p_actor_id,'EXPERIENCE_CREATED','experience',created_id,jsonb_build_object('title',p_title,'slug',p_slug));
  return created_id;
end $$;

create or replace function public.admin_update_experience(p_actor_id uuid,p_experience_id uuid,p_title text,p_summary text,p_status text,p_image_url text,p_display_order integer,p_description text,p_duration_minutes integer,p_price_cents integer,p_default_capacity integer,p_editorial_content jsonb)
returns boolean language plpgsql security definer set search_path=public as $$ begin
  if not public.is_active_admin(p_actor_id) then raise exception 'ADMIN_FORBIDDEN' using errcode='42501'; end if;
  if p_status='PUBLISHED' and not public.experience_editorial_is_publishable(p_editorial_content) then raise exception 'INCOMPLETE_EDITORIAL_CONTENT' using errcode='22023'; end if;
  update public.experiences set title=p_title,summary=p_summary,description=p_description,duration_minutes=p_duration_minutes,price_cents=p_price_cents,default_capacity=p_default_capacity,status=p_status,image_url=nullif(p_image_url,''),display_order=p_display_order,editorial_content=coalesce(p_editorial_content,'{}'::jsonb),updated_at=now() where id=p_experience_id;
  if not found then raise exception 'EXPERIENCE_NOT_FOUND'; end if;
  insert into public.admin_audit_log(actor_user_id,action,entity_type,entity_id,metadata) values(p_actor_id,'EXPERIENCE_UPDATED','experience',p_experience_id,jsonb_build_object('title',p_title,'status',p_status));
  return true;
end $$;

revoke all on function public.get_public_experience(text) from public;
revoke all on function public.list_public_experiences() from public;
revoke all on function public.experience_editorial_is_publishable(jsonb) from public, anon, authenticated;
grant execute on function public.get_public_experience(text) to anon, authenticated, service_role;
grant execute on function public.list_public_experiences() to anon, authenticated, service_role;
grant execute on function public.experience_editorial_is_publishable(jsonb) to service_role;
revoke all on function public.admin_list_experiences(uuid) from public, anon, authenticated;
revoke all on function public.admin_create_experience(uuid,text,text,text,text,text,integer,text,integer,integer,integer,jsonb) from public, anon, authenticated;
revoke all on function public.admin_update_experience(uuid,uuid,text,text,text,text,integer,text,integer,integer,integer,jsonb) from public, anon, authenticated;
grant execute on function public.admin_list_experiences(uuid) to service_role;
grant execute on function public.admin_create_experience(uuid,text,text,text,text,text,integer,text,integer,integer,integer,jsonb) to service_role;
grant execute on function public.admin_update_experience(uuid,uuid,text,text,text,text,integer,text,integer,integer,integer,jsonb) to service_role;
