-- Publish Remada Sunset and its first confirmed session.
-- This migration is additive and idempotent. Apply it only after Sprint 5.2.

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'experiences'
      and column_name = 'editorial_content'
  ) or to_regprocedure('public.list_public_experiences()') is null then
    raise exception 'DYNAMIC_EXPERIENCES_MIGRATION_REQUIRED';
  end if;
end;
$$;

-- The reviewed production database retains seven legacy editorial columns.
-- A clean installation has none of them. Refuse an unknown partial/type-mismatched
-- legacy shape before shifting catalog positions or writing the new experience.
do $migration$
declare
  paranoa_order integer;
  legacy_column_count integer;
  incompatible_legacy_columns text;
  unsupported_required_columns text;
  experience_editorial jsonb;
begin
  select count(*)
  into legacy_column_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'experiences'
    and column_name = any (array[
      'eyebrow', 'short_description', 'location', 'cover_image',
      'gallery', 'included', 'active'
    ]);

  if legacy_column_count not in (0, 7) then
    raise exception using
      message = 'EXPERIENCES_LEGACY_SCHEMA_INCOMPLETE',
      detail = format('Expected none or all 7 compatibility columns, found %s.', legacy_column_count),
      hint = 'Run supabase/diagnostics/202608030003_experiences_schema_preflight.sql and review the schema.';
  end if;

  if legacy_column_count = 7 then
    with expected(column_name, accepted_data_types) as (
      values
        ('eyebrow', array['text', 'character varying']::text[]),
        ('short_description', array['text', 'character varying']::text[]),
        ('location', array['text', 'character varying']::text[]),
        ('cover_image', array['text', 'character varying']::text[]),
        ('gallery', array['jsonb']::text[]),
        ('included', array['jsonb']::text[]),
        ('active', array['boolean']::text[])
    )
    select string_agg(format('%I is %s', expected.column_name, actual.data_type), ', ' order by expected.column_name)
    into incompatible_legacy_columns
    from expected
    join information_schema.columns actual
      on actual.table_schema = 'public'
     and actual.table_name = 'experiences'
     and actual.column_name = expected.column_name
    where not (actual.data_type = any (expected.accepted_data_types));

    if incompatible_legacy_columns is not null then
      raise exception using
        message = 'EXPERIENCES_LEGACY_SCHEMA_INCOMPATIBLE',
        detail = incompatible_legacy_columns,
        hint = 'Run supabase/diagnostics/202608030003_experiences_schema_preflight.sql and review the schema.';
    end if;
  end if;

  select string_agg(column_name, ', ' order by ordinal_position)
  into unsupported_required_columns
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'experiences'
    and is_nullable = 'NO'
    and column_default is null
    and is_identity = 'NO'
    and is_generated = 'NEVER'
    and not (column_name = any (array[
      'slug', 'title', 'eyebrow', 'short_description', 'description',
      'duration_minutes', 'location', 'cover_image', 'gallery', 'included',
      'active', 'summary', 'price_cents', 'default_capacity', 'status',
      'image_url', 'display_order', 'editorial_content', 'created_at', 'updated_at'
    ]));

  if unsupported_required_columns is not null then
    raise exception using
      message = 'EXPERIENCES_REQUIRED_COLUMNS_UNSUPPORTED',
      detail = format('Required columns without defaults are not mapped: %s.', unsupported_required_columns),
      hint = 'Run supabase/diagnostics/202608030003_experiences_schema_preflight.sql and review the schema.';
  end if;

  select display_order into paranoa_order
  from public.experiences
  where slug = 'imersao-paranoa';

  if paranoa_order is null then
    raise exception 'IMERSAO_PARANOA_REQUIRED';
  end if;

  if not exists (select 1 from public.experiences where slug = 'remada-sunset') then
    update public.experiences
    set display_order = display_order + 1,
        updated_at = now()
    where display_order > paranoa_order;
  end if;

  experience_editorial := $editorial$
  {
    "version": 1,
    "hero": {
      "eyebrow": "PÔR DO SOL NO LAGO PARANOÁ",
      "title": "O melhor pôr do sol de Brasília visto de dentro de uma canoa.",
      "subtitle": "Uma remada de 1h30 para desacelerar, mergulhar no Lago Paranoá e acompanhar as últimas luzes do dia em um dos cenários mais bonitos da cidade.",
      "image": {
        "src": "/images/experiences/remada-sunset/remada-sunset-hero.webp",
        "alt": "Participantes em canoas erguendo os remos diante do pôr do sol no Lago Paranoá"
      },
      "primaryCta": { "label": "Reservar minha vaga", "href": "#reservas" },
      "secondaryCta": { "label": "Conhecer a experiência", "href": "#sobre" },
      "details": ["Duração: 1h30", "Local: Lago Norte", "Nível: Iniciantes são bem-vindos"]
    },
    "quickFacts": [
      { "label": "Duração", "value": "1h30" },
      { "label": "Local", "value": "Base da Alma Azul Academy, Lago Norte" },
      { "label": "Nível", "value": "Iniciantes são bem-vindos" },
      { "label": "Dias habituais", "value": "sextas-feiras e domingos" },
      { "label": "Valor", "value": "R$ 70 por pessoa" },
      { "label": "Capacidade padrão", "value": "28 pessoas" }
    ],
    "about": {
      "eyebrow": "Sobre a experiência",
      "title": "Remada Sunset",
      "paragraphs": [
        "A Remada Sunset foi criada para quem quer terminar o dia de uma forma diferente: sobre as águas do Lago Paranoá, dentro de uma canoa havaiana e diante de um dos melhores pores do sol de Brasília.",
        "Durante 1h30, navegamos em um ritmo tranquilo, com tempo para remar, conversar, contemplar a paisagem e fazer paradas prolongadas para banho e apreciação.",
        "Não é preciso ter experiência anterior. Antes de entrar na água, nossos instrutores apresentam os equipamentos, ensinam os movimentos básicos da remada e acompanham todo o percurso dentro das canoas.",
        "A experiência termina com uma parada em uma prainha, onde o grupo aproveita os últimos momentos de luz antes de retornar à base pouco antes de escurecer."
      ],
      "image": {
        "src": "/images/experiences/remada-sunset/remada-sunset-sobre.webp",
        "alt": "Grupo em uma canoa no Lago Paranoá sob o céu colorido do entardecer"
      }
    },
    "gallery": {
      "eyebrow": "Galeria",
      "title": "Remada Sunset",
      "description": "Uma remada ao entardecer com pausas para banho, contemplação e as últimas luzes do dia no Lago Paranoá.",
      "images": [
        { "src": "/images/experiences/remada-sunset/remada-sunset-galeria-01.webp", "alt": "Canoa havaiana navegando no Lago Paranoá durante o pôr do sol" },
        { "src": "/images/experiences/remada-sunset/remada-sunset-galeria-02.webp", "alt": "Participantes remando juntos em uma canoa havaiana no Lago Paranoá" },
        { "src": "/images/experiences/remada-sunset/remada-sunset-galeria-03.webp", "alt": "Canoas e participantes reunidos na margem ao final da tarde" },
        { "src": "/images/experiences/remada-sunset/remada-sunset-galeria-04.webp", "alt": "Grupo remando em direção ao pôr do sol no Lago Paranoá" },
        { "src": "/images/experiences/remada-sunset/remada-sunset-galeria-05.webp", "alt": "Participantes tomando banho no Lago Paranoá durante o entardecer" }
      ]
    },
    "steps": {
      "eyebrow": "Como funciona",
      "title": "Remada Sunset",
      "description": "Uma experiência de 1h30 em ritmo tranquilo, com paradas prolongadas para banho, contemplação e registros fotográficos feitos pelos instrutores.",
      "items": [
        { "title": "Recepção e preparação", "description": "O encontro acontece na base da Alma Azul Academy. A equipe recebe o grupo, entrega os equipamentos e explica como será a experiência." },
        { "title": "Instrução e remada", "description": "Antes de sair, todos recebem uma instrução completa sobre segurança e técnica de remada. Depois, seguimos pelo Lago Paranoá em um ritmo confortável, com instrutores em cada canoa." },
        { "title": "Banho, contemplação e prainha", "description": "Durante o percurso, fazemos pausas prolongadas para banho e contemplação. A experiência termina em uma prainha, acompanhando as últimas luzes do pôr do sol antes do retorno à base." }
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
        { "icon": "ShieldCheck", "title": "Instrução completa para iniciantes", "description": "" },
        { "icon": "Droplets", "title": "Paradas para banho e contemplação", "description": "" },
        { "icon": "Sparkles", "title": "Fotos registradas pelos instrutores", "description": "" },
        { "icon": "Droplets", "title": "Acesso ao banheiro e à ducha da base", "description": "" }
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
        "A Remada Sunset é indicada para iniciantes, famílias, crianças acompanhadas pelos responsáveis, pessoas idosas, casais, grupos de amigos e também para quem deseja participar sozinho.",
        "Não é necessário saber nadar, pois todos utilizam colete salva-vidas e permanecem acompanhados pelos instrutores durante toda a experiência.",
        "Iniciantes podem participar.",
        "Crianças podem participar acompanhadas pelos pais ou responsáveis.",
        "Pessoas idosas podem participar.",
        "Não há idade mínima fixa nesta etapa.",
        "Em caso de condição física ou de saúde específica, o participante deve conversar previamente com a equipe."
      ]
    },
    "reservations": {
      "eyebrow": "Remada Sunset",
      "title": "Reservar minha vaga",
      "description": "Uma experiência de 1h30 em canoa havaiana para contemplar o pôr do sol, aproveitar o Lago Paranoá e encerrar o dia em uma prainha, cercado pela natureza.",
      "image": {
        "src": "/images/experiences/remada-sunset/remada-sunset-reservas.webp",
        "alt": "Participantes ao lado das canoas durante o pôr do sol no Lago Paranoá"
      }
    },
    "seo": {
      "title": "Remada Sunset no Lago Paranoá | Alma Azul Academy",
      "description": "Contemple o pôr do sol de Brasília em uma canoa havaiana. Experiência de 1h30 com instrução, banho no lago, fotos e acompanhamento completo."
    }
  }
  $editorial$::jsonb;

  if legacy_column_count = 7 then
    execute $legacy_insert$
      insert into public.experiences (
        slug, title, eyebrow, short_description, description, duration_minutes,
        location, cover_image, gallery, included, active,
        summary, price_cents, default_capacity, status, image_url, display_order,
        editorial_content, created_at, updated_at
      )
      values (
        'remada-sunset',
        'Remada Sunset',
        'PÔR DO SOL NO LAGO PARANOÁ',
        'Uma remada ao entardecer com pausas para banho, contemplação e as últimas luzes do dia no Lago Paranoá.',
        'Uma experiência de 1h30 em canoa havaiana para contemplar o pôr do sol, aproveitar o Lago Paranoá e encerrar o dia em uma prainha, cercado pela natureza.',
        90,
        'Base da Alma Azul Academy, Lago Norte, Brasília',
        '/images/experiences/remada-sunset/remada-sunset-hero.webp',
        $1 #> '{gallery,images}',
        $1 #> '{included,items}',
        true,
        'Uma remada ao entardecer com pausas para banho, contemplação e as últimas luzes do dia no Lago Paranoá.',
        7000,
        28,
        'PUBLISHED',
        '/images/experiences/remada-sunset/remada-sunset-hero.webp',
        $2,
        $1,
        now(),
        now()
      )
      on conflict (slug) do update
      set title = excluded.title,
          eyebrow = excluded.eyebrow,
          short_description = excluded.short_description,
          description = excluded.description,
          duration_minutes = excluded.duration_minutes,
          location = excluded.location,
          cover_image = excluded.cover_image,
          gallery = excluded.gallery,
          included = excluded.included,
          active = excluded.active,
          summary = excluded.summary,
          price_cents = excluded.price_cents,
          default_capacity = excluded.default_capacity,
          status = excluded.status,
          image_url = excluded.image_url,
          display_order = excluded.display_order,
          editorial_content = excluded.editorial_content,
          updated_at = now()
    $legacy_insert$ using experience_editorial, paranoa_order + 1;
  else
    insert into public.experiences (
      slug, title, summary, description, duration_minutes, price_cents,
      default_capacity, status, image_url, display_order, editorial_content,
      created_at, updated_at
    )
    values (
      'remada-sunset',
      'Remada Sunset',
      'Uma remada ao entardecer com pausas para banho, contemplação e as últimas luzes do dia no Lago Paranoá.',
      'Uma experiência de 1h30 em canoa havaiana para contemplar o pôr do sol, aproveitar o Lago Paranoá e encerrar o dia em uma prainha, cercado pela natureza.',
      90,
      7000,
      28,
      'PUBLISHED',
      '/images/experiences/remada-sunset/remada-sunset-hero.webp',
      paranoa_order + 1,
      experience_editorial,
      now(),
      now()
    )
    on conflict (slug) do update
    set title = excluded.title,
        summary = excluded.summary,
        description = excluded.description,
        duration_minutes = excluded.duration_minutes,
        price_cents = excluded.price_cents,
        default_capacity = excluded.default_capacity,
        status = excluded.status,
        image_url = excluded.image_url,
        display_order = excluded.display_order,
        editorial_content = excluded.editorial_content,
        updated_at = now();
  end if;
end;
$migration$;

-- 17:00 in America/Sao_Paulo is 20:00 UTC on 2026-08-09.
insert into public.sessions (
  experience_id,
  starts_at,
  duration_minutes,
  price_cents,
  capacity,
  status
)
select
  experience.id,
  make_timestamptz(2026, 8, 9, 17, 0, 0, 'America/Sao_Paulo'),
  90,
  7000,
  28,
  'OPEN'::public.session_status
from public.experiences experience
where experience.slug = 'remada-sunset'
  and not exists (
    select 1
    from public.sessions session
    where session.experience_id = experience.id
      and session.starts_at = make_timestamptz(2026, 8, 9, 17, 0, 0, 'America/Sao_Paulo')
  );
