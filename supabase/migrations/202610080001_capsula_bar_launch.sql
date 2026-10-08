-- Lançamento da Base Cápsula Bar — Concha Acústica (domingo, 11/10/2026).
--
-- Aditiva e idempotente. Nenhuma tabela, coluna ou linha é removida, e nenhuma
-- RPC de reserva ou pagamento é alterada (create_pre_reservation,
-- list_open_sessions, get_booking_session, confirm_reservation_payment,
-- attach_payment_checkout, lookup_reservation e available_spots ficam intactas).
--
-- O que muda:
--   1. bases ganha meeting_point e maps_url: a localização passa a ter uma
--      única fonte, lida por site, e-mails, QR e painel.
--   2. A base concha-acustica vira "Cápsula Bar — Concha Acústica", com
--      endereço, ponto de encontro e link do Google Maps, e passa para ACTIVE.
--   3. As experiências da base recebem preço (R$ 70), duração (90 min) e
--      capacidade padrão (24). "Caminhos do Paranoá" vira os dois roteiros.
--   4. Só a Remada Sunset é publicada, com a sessão de 11/10/2026 às 17h
--      (24 vagas). As demais continuam "em breve", prontas para receber horários.
--   5. As leituras que alimentam e-mail, QR de check-in e planilha passam a
--      devolver a base da reserva (reserva → sessão → experiência → base).
--
-- Nada do Lago Norte é escrito: nenhuma experiência, sessão ou reserva da base
-- é tocada, e meeting_point/maps_url do Lago Norte ficam nulos (o e-mail e as
-- páginas continuam mostrando exatamente o endereço atual).
--
-- Reaplicar é seguro: os blocos de dados só agem enquanto a base ainda está
-- COMING_SOON ou o valor ainda é o "não definido" da migration multi-base, então
-- edições feitas depois pelo painel nunca são sobrescritas.

do $$
begin
  if to_regclass('public.bases') is null
     or to_regprocedure('public.list_public_catalog()') is null then
    raise exception 'MULTI_BASE_MIGRATION_REQUIRED';
  end if;
  if to_regprocedure('public.public_checkin_ticket(uuid)') is null then
    raise exception 'RESERVATION_CHECKIN_MIGRATION_REQUIRED';
  end if;
  if not exists (select 1 from public.bases where slug = 'concha-acustica') then
    raise exception 'CONCHA_ACUSTICA_BASE_REQUIRED';
  end if;
  if not exists (select 1 from public.experiences where slug = 'remada-sunset-concha-acustica') then
    raise exception 'REMADA_SUNSET_CONCHA_REQUIRED';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Localização centralizada na base
-- ---------------------------------------------------------------------------
alter table public.bases
  add column if not exists meeting_point text,
  add column if not exists maps_url text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bases'::regclass and conname = 'bases_maps_url_https'
  ) then
    alter table public.bases add constraint bases_maps_url_https
      check (maps_url is null or (maps_url ~ '^https://' and char_length(maps_url) <= 2048));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bases'::regclass and conname = 'bases_meeting_point_length'
  ) then
    alter table public.bases add constraint bases_meeting_point_length
      check (meeting_point is null or char_length(btrim(meeting_point)) between 2 and 160);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Base Cápsula Bar — Concha Acústica: identidade, localização e abertura
-- ---------------------------------------------------------------------------
-- Só age enquanto a base ainda está "em breve": depois de aberta, nome, textos
-- e endereço pertencem a quem administra.
update public.bases
set name = 'Cápsula Bar — Concha Acústica',
    short_description = 'A base da Alma Azul no Cápsula Bar, ao lado da Concha Acústica.',
    description = 'Uma nova forma de viver o Lago Paranoá: remadas que partem do Cápsula Bar, ao lado da Concha Acústica, com a cidade vista a partir da água.',
    location_label = 'Concha Acústica · Brasília',
    address = 'SHTN Trecho 1, Lote 8 — Brasília/DF',
    meeting_point = 'Em frente ao Cápsula Bar — Concha Acústica',
    maps_url = 'https://maps.app.goo.gl/ueSCiLvHAggrzuAX7',
    partner_name = 'Cápsula Bar',
    status = 'ACTIVE'
where slug = 'concha-acustica'
  and status = 'COMING_SOON';

-- ---------------------------------------------------------------------------
-- 3. Experiências da base: valores, nomes e os dois roteiros
-- ---------------------------------------------------------------------------
do $migration$
declare
  capsula_id uuid;
  legacy_column_count integer;
  route_ermida constant text := 'caminhos-do-paranoa-rota-ermida-ponte-jk';
  route_prainha constant text := 'caminhos-do-paranoa-rota-prainha-do-congresso';
  route_prainha_summary constant text := 'Uma remada pelo Lago Paranoá em direção à prainha do Clube do Congresso.';
  route_image constant text := '/images/bases/concha-acustica/experiencia-caminhos-do-paranoa.webp';
begin
  select id into capsula_id from public.bases where slug = 'concha-acustica';

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

  -- "Caminhos do Paranoá" era um cadastro só. Vira o primeiro roteiro; o slug
  -- só muda enquanto não existe nenhuma sessão ligada a ele.
  update public.experiences e
  set slug = route_ermida,
      modality = route_ermida,
      title = 'Caminhos do Paranoá — Rota Ermida x Ponte JK',
      summary = 'Uma remada contemplativa pela Ponte JK, com parada na prainha da Ermida Dom Bosco.',
      description = 'Uma remada contemplativa pela Ponte JK, com parada na prainha da Ermida Dom Bosco.',
      image_url = route_image
  where e.slug = 'caminhos-do-paranoa'
    and e.base_id = capsula_id
    and not exists (select 1 from public.sessions s where s.experience_id = e.id)
    and not exists (select 1 from public.experiences other where other.slug = route_ermida);

  if legacy_column_count = 7 then
    execute $legacy_insert$
      insert into public.experiences (
        slug, title, eyebrow, short_description, description, location, cover_image,
        gallery, included, active, summary, duration_minutes, price_cents, default_capacity, status,
        image_url, display_order, editorial_content, base_id, is_exclusive, modality
      )
      values (
        $1, 'Caminhos do Paranoá — Rota Prainha do Congresso', 'Remada de dia', $2, $2,
        'Cápsula Bar — Concha Acústica, Brasília', $3,
        '[]'::jsonb, '[]'::jsonb, false, $2, 90, 7000, 24, 'COMING_SOON',
        $3, 100, '{}'::jsonb, $4, false, $1
      )
      on conflict (slug) do nothing
    $legacy_insert$
    using route_prainha, route_prainha_summary, route_image, capsula_id;

    -- Texto legado de local: só troca o valor semeado pela migration multi-base.
    execute $legacy_location$
      update public.experiences
      set location = 'Cápsula Bar — Concha Acústica, Brasília'
      where base_id = $1 and location = 'Concha Acústica, Brasília'
    $legacy_location$
    using capsula_id;
  else
    insert into public.experiences (
      slug, title, summary, description, duration_minutes, price_cents, default_capacity, status,
      image_url, display_order, editorial_content, base_id, is_exclusive, modality
    )
    values (
      route_prainha, 'Caminhos do Paranoá — Rota Prainha do Congresso', route_prainha_summary, route_prainha_summary,
      90, 7000, 24, 'COMING_SOON', route_image, 100, '{}'::jsonb, capsula_id, false, route_prainha
    )
    on conflict (slug) do nothing;
  end if;

  -- Nomes no padrão do Lago Norte. Só troca o título semeado.
  update public.experiences set title = 'Remada do Nascer do Sol'
  where base_id = capsula_id and slug = 'remada-nascer-do-sol-concha-acustica' and title = 'Remada Nascer do Sol';

  update public.experiences set title = 'Remada da Lua Cheia'
  where base_id = capsula_id and slug = 'remada-lua-cheia-concha-acustica' and title = 'Remada Lua Cheia';

  -- Fotos próprias da base nos cards, no lugar das temporárias do Lago Norte.
  update public.experiences set image_url = '/images/bases/concha-acustica/experiencia-remada-do-nascer-do-sol.webp'
  where base_id = capsula_id and slug = 'remada-nascer-do-sol-concha-acustica'
    and image_url = '/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-hero.webp';

  update public.experiences set image_url = '/images/bases/concha-acustica/experiencia-remada-da-lua-cheia.webp'
  where base_id = capsula_id and slug = 'remada-lua-cheia-concha-acustica'
    and image_url = '/images/experiences/remada-lua-cheia/remada-lua-cheia-hero.webp';

  -- Condições iniciais: R$ 70, 90 minutos, 24 vagas por sessão. 0 era o "ainda
  -- não definido" da migration multi-base; valor já editado não é tocado.
  update public.experiences set price_cents = 7000
  where base_id = capsula_id and price_cents = 0;

  update public.experiences set default_capacity = 24
  where base_id = capsula_id and default_capacity = 0;

  update public.experiences set duration_minutes = 90
  where base_id = capsula_id and duration_minutes is distinct from 90 and status = 'COMING_SOON'
    and not exists (select 1 from public.sessions s where s.experience_id = experiences.id);
end;
$migration$;

-- ---------------------------------------------------------------------------
-- 4. Remada Sunset · Cápsula Bar: landing, publicação e a sessão de inauguração
-- ---------------------------------------------------------------------------
do $migration$
declare
  sunset_id uuid;
  sunset_status text;
  legacy_column_count integer;
  legacy_spots boolean;
  inauguration constant timestamptz := make_timestamptz(2026, 10, 11, 17, 0, 0, 'America/Sao_Paulo');
  experience_editorial jsonb;
begin
  select e.id, e.status into sunset_id, sunset_status
  from public.experiences e
  join public.bases b on b.id = e.base_id
  where e.slug = 'remada-sunset-concha-acustica' and b.slug = 'concha-acustica';

  if sunset_id is null then
    raise exception 'REMADA_SUNSET_CONCHA_REQUIRED';
  end if;

  select count(*) into legacy_column_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'experiences'
    and column_name = any (array['eyebrow', 'short_description', 'location', 'cover_image', 'gallery', 'included', 'active']);

  experience_editorial := $editorial$
  {
    "version": 1,
    "hero": {
      "eyebrow": "PÔR DO SOL · CÁPSULA BAR — CONCHA ACÚSTICA",
      "title": "O pôr do sol de Brasília visto de dentro de uma canoa.",
      "subtitle": "Uma remada de 1h30 em canoa havaiana, saindo do Cápsula Bar, ao lado da Concha Acústica, para acompanhar as últimas luzes do dia no Lago Paranoá.",
      "image": {
        "src": "/images/bases/concha-acustica/capsula-lago-por-do-sol-desktop.webp",
        "alt": "Cápsula Bar às margens do Lago Paranoá ao pôr do sol, com palmeiras e o píer sobre a água"
      },
      "primaryCta": { "label": "Reservar minha vaga", "href": "#reservas" },
      "secondaryCta": { "label": "Conhecer a experiência", "href": "#sobre" },
      "details": ["Duração: 1h30", "Local: Cápsula Bar — Concha Acústica", "Nível: Iniciantes são bem-vindos"]
    },
    "cardImage": {
      "src": "/images/bases/concha-acustica/experiencia-remada-sunset.webp",
      "alt": "Canoa havaiana sob nuvens alaranjadas do pôr do sol no Lago Paranoá"
    },
    "quickFacts": [
      { "label": "Duração", "value": "1h30" },
      { "label": "Local", "value": "Cápsula Bar — Concha Acústica" },
      { "label": "Ponto de encontro", "value": "Em frente ao Cápsula Bar" },
      { "label": "Nível", "value": "Iniciantes são bem-vindos" },
      { "label": "Valor", "value": "R$ 70 por pessoa" }
    ],
    "about": {
      "eyebrow": "Sobre a experiência",
      "title": "Remada Sunset",
      "paragraphs": [
        "A Remada Sunset chega à nova base da Alma Azul: uma saída em canoa havaiana a partir do Cápsula Bar, ao lado da Concha Acústica, para terminar o dia sobre as águas do Lago Paranoá.",
        "Durante 1h30, navegamos em um ritmo tranquilo, com tempo para remar, conversar e contemplar o pôr do sol com Brasília vista a partir da água.",
        "Não é preciso ter experiência anterior. Antes de entrar na água, nossos instrutores apresentam os equipamentos, ensinam os movimentos básicos da remada e acompanham todo o percurso dentro das canoas."
      ],
      "image": {
        "src": "/images/bases/concha-acustica/experiencia-remada-sunset.webp",
        "alt": "Canoa havaiana sob nuvens alaranjadas do pôr do sol no Lago Paranoá",
        "credit": "Registros de experiências Alma Azul no Lago Paranoá"
      }
    },
    "steps": {
      "eyebrow": "Como funciona",
      "title": "Remada Sunset",
      "description": "Uma experiência de 1h30 em ritmo tranquilo, conduzida pela equipe Alma Azul.",
      "items": [
        { "title": "Encontro e preparação", "description": "O encontro acontece em frente ao Cápsula Bar. A equipe recebe o grupo, entrega os equipamentos e explica como será a experiência." },
        { "title": "Instrução e remada", "description": "Antes de sair, todos recebem uma instrução completa sobre segurança e técnica de remada. Depois, seguimos pelo Lago Paranoá em um ritmo confortável, com instrutores em cada canoa." },
        { "title": "Pôr do sol na água", "description": "Acompanhamos as últimas luzes do dia de dentro da canoa e retornamos ao ponto de encontro ao final da experiência." }
      ]
    },
    "included": {
      "eyebrow": "O que está incluído",
      "title": "O que está incluído",
      "description": "",
      "items": [
        { "icon": "Compass", "title": "Canoa havaiana", "description": "" },
        { "icon": "Sparkles", "title": "Remo", "description": "" },
        { "icon": "LifeBuoy", "title": "Colete salva-vidas", "description": "" },
        { "icon": "Compass", "title": "Instrutores em cada canoa", "description": "" },
        { "icon": "ShieldCheck", "title": "Instrução completa para iniciantes", "description": "" }
      ]
    },
    "whatToBring": {
      "eyebrow": "O que levar",
      "title": "O que levar",
      "items": [
        "Roupa confortável para atividade física",
        "Roupa de banho",
        "Chinelo",
        "Repelente",
        "Garrafa de água",
        "Agasalho leve para o retorno"
      ]
    },
    "restrictions": {
      "eyebrow": "Público e requisitos",
      "title": "Público e requisitos",
      "items": [
        "A Remada Sunset é indicada para iniciantes, famílias, casais, grupos de amigos e também para quem deseja participar sozinho.",
        "Não é necessário saber nadar, pois todos utilizam colete salva-vidas e permanecem acompanhados pelos instrutores durante toda a experiência.",
        "Crianças podem participar acompanhadas pelos pais ou responsáveis.",
        "Em caso de condição física ou de saúde específica, o participante deve conversar previamente com a equipe."
      ]
    },
    "faq": {
      "eyebrow": "Dúvidas frequentes",
      "title": "Antes de entrar na água.",
      "locationLabel": "Cápsula Bar — Concha Acústica · SHTN Trecho 1, Lote 8",
      "items": [
        { "question": "Onde é o ponto de encontro?", "answer": "Em frente ao Cápsula Bar, ao lado da Concha Acústica: SHTN Trecho 1, Lote 8 — Brasília/DF. O link do Google Maps está nesta página e no e-mail de confirmação da reserva." },
        { "question": "Existe estacionamento?", "answer": "As orientações de chegada e de estacionamento no Cápsula Bar são enviadas pela nossa equipe no grupo da experiência, criado até um dia antes." },
        { "question": "Há banheiro no local?", "answer": "O ponto de encontro fica no Cápsula Bar. As orientações sobre a estrutura disponível no dia são enviadas pela nossa equipe no grupo da experiência." }
      ]
    },
    "reservations": {
      "eyebrow": "Remada Sunset · Cápsula Bar",
      "title": "Reservar minha vaga",
      "description": "Uma experiência de 1h30 em canoa havaiana para contemplar o pôr do sol no Lago Paranoá, saindo do Cápsula Bar, ao lado da Concha Acústica.",
      "image": {
        "src": "/images/experiences/remada-sunset/remada-sunset-reservas.webp",
        "alt": "Participantes ao lado das canoas durante o pôr do sol no Lago Paranoá",
        "credit": "Registros de experiências Alma Azul no Lago Paranoá"
      }
    },
    "seo": {
      "title": "Remada Sunset no Cápsula Bar — Concha Acústica | Alma Azul Academy",
      "description": "Contemple o pôr do sol de Brasília em uma canoa havaiana, saindo do Cápsula Bar, ao lado da Concha Acústica. Experiência de 1h30 com instrução e acompanhamento completo."
    }
  }
  $editorial$::jsonb;

  -- Publica só a partir do "em breve" semeado: uma experiência já publicada ou
  -- arquivada pelo painel não é republicada nem tem a landing sobrescrita.
  if sunset_status = 'COMING_SOON' then
    update public.experiences
    set summary = 'As últimas luzes do dia vistas de dentro de uma canoa havaiana, saindo do Cápsula Bar.',
        description = 'Uma experiência de 1h30 em canoa havaiana para contemplar o pôr do sol no Lago Paranoá, saindo do Cápsula Bar, ao lado da Concha Acústica.',
        duration_minutes = 90,
        price_cents = 7000,
        default_capacity = 24,
        image_url = '/images/bases/concha-acustica/experiencia-remada-sunset.webp',
        editorial_content = experience_editorial,
        status = 'PUBLISHED'
    where id = sunset_id;

    if legacy_column_count = 7 then
      execute $legacy_update$
        update public.experiences
        set eyebrow = 'PÔR DO SOL · CÁPSULA BAR — CONCHA ACÚSTICA',
            short_description = summary,
            location = 'Cápsula Bar — Concha Acústica, Brasília',
            cover_image = image_url,
            included = $2 #> '{included,items}',
            active = true
        where id = $1
      $legacy_update$
      using sunset_id, experience_editorial;
    end if;
  end if;

  -- Sessão de inauguração: domingo, 11/10/2026, 17h (Brasília) — 90 min,
  -- R$ 70, 24 vagas. Única sessão criada; nenhuma recorrência.
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'sessions' and column_name = 'spots_available'
  ) into legacy_spots;

  execute format($insert$
    insert into public.sessions (experience_id, starts_at, duration_minutes, price_cents, capacity, status%1$s)
    select $1, $2, 90, 7000, 24, 'OPEN'::public.session_status%2$s
    where not exists (
      select 1 from public.sessions session
      where session.experience_id = $1 and session.starts_at = $2
    )
  $insert$,
    case when legacy_spots then ', spots_available' else '' end,
    case when legacy_spots then ', 24' else '' end)
  using sunset_id, inauguration;
end;
$migration$;

-- ---------------------------------------------------------------------------
-- 5. Leituras públicas com a localização da base
-- ---------------------------------------------------------------------------
-- list_public_bases ganha duas colunas de retorno; o Postgres exige recriar a
-- função para isso. A troca acontece dentro da transação da migration e o
-- código antigo ignora as colunas novas.
drop function if exists public.list_public_bases();

create function public.list_public_bases()
returns table (
  id uuid, slug text, name text, status text, short_description text, description text,
  location_label text, address text, partner_name text, image_url text, display_order integer,
  meeting_point text, maps_url text
)
language sql stable security definer set search_path = public as $$
  select b.id, b.slug, b.name, b.status, b.short_description, b.description,
         b.location_label, b.address, b.partner_name, b.image_url, b.display_order,
         b.meeting_point, b.maps_url
  from public.bases b
  where b.status <> 'INACTIVE'
  order by b.display_order, b.name;
$$;

revoke all on function public.list_public_bases() from public;
grant execute on function public.list_public_bases() to anon, authenticated, service_role;

-- E-mail de confirmação e lembrete do QR: a localização vem da base da
-- experiência da reserva, e a duração vem da sessão reservada.
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
    'startsAt', s.starts_at,
    'durationMinutes', s.duration_minutes,
    'checkinToken', r.checkin_token,
    'baseSlug', b.slug,
    'baseName', b.name,
    'meetingPoint', b.meeting_point,
    'address', b.address,
    'mapsUrl', b.maps_url
  )
  from public.reservations r
  join public.sessions s on s.id = r.session_id
  join public.experiences e on e.id = r.experience_id
  left join public.bases b on b.id = e.base_id
  where r.id = p_reservation_id
    and r.status = 'CONFIRMED';
$$;

revoke all on function public.reservation_confirmation_email(uuid) from public, anon, authenticated;
grant execute on function public.reservation_confirmation_email(uuid) to service_role;

-- Ingresso público do QR: ganha o local de encontro. Continua sem nome,
-- e-mail, telefone ou código da reserva.
create or replace function public.public_checkin_ticket(p_token uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'experienceTitle', e.title,
    'startsAt', s.starts_at,
    'quantity', r.quantity,
    'checkedIn', r.checked_in_count is not null,
    'baseSlug', b.slug,
    'baseName', b.name,
    'meetingPoint', b.meeting_point,
    'address', b.address,
    'mapsUrl', b.maps_url
  )
  from public.reservations r
  join public.sessions s on s.id = r.session_id
  join public.experiences e on e.id = r.experience_id
  left join public.bases b on b.id = e.base_id
  where p_token is not null
    and r.checkin_token = p_token
    and r.status = 'CONFIRMED';
$$;

revoke all on function public.public_checkin_ticket(uuid) from public, anon, authenticated;
grant execute on function public.public_checkin_ticket(uuid) to service_role;

-- Planilha operacional: o bloco da sessão passa a dizer a base, para a turma
-- do Cápsula Bar não se confundir com a Remada Sunset do Lago Norte.
create or replace function public.google_sheets_session_block(p_session_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', s.id,
    'experienceTitle', e.title,
    'baseSlug', b.slug,
    'baseName', b.name,
    'startsAt', s.starts_at,
    'durationMinutes', s.duration_minutes,
    'capacity', s.capacity,
    'confirmedSpots', coalesce((
      select sum(r.quantity)::integer
      from public.reservations r
      where r.session_id = s.id and r.status = 'CONFIRMED'
    ), 0),
    'remainingSpots', public.available_spots(s.id),
    'status', s.status
  )
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  left join public.bases b on b.id = e.base_id
  where s.id = p_session_id;
$$;

revoke all on function public.google_sheets_session_block(uuid) from public, anon, authenticated;
grant execute on function public.google_sheets_session_block(uuid) to service_role;
