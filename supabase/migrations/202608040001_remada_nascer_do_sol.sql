-- Publish Remada do Nascer do Sol and its first confirmed session.
-- This migration is additive and idempotent. Apply it only after Sprint 5.2 and Remada Sunset.

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
  sunset_order integer;
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

  select display_order into sunset_order
  from public.experiences
  where slug = 'remada-sunset';

  if sunset_order is null then
    raise exception 'REMADA_SUNSET_REQUIRED';
  end if;

  if not exists (select 1 from public.experiences where slug = 'remada-nascer-do-sol') then
    update public.experiences
    set display_order = display_order + 1,
        updated_at = now()
    where display_order > sunset_order;
  end if;

  experience_editorial := $editorial$
  {
    "version": 1,
    "hero": {
      "eyebrow": "AMANHECER NO LAGO PARANOÁ",
      "title": "Sinta o despertar do Lago Paranoá.",
      "subtitle": "Uma remada ao amanhecer para contemplar Brasília despertando, ouvir os sons da natureza e começar o dia com mais presença, energia e leveza.",
      "image": {
        "src": "/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-hero.webp",
        "alt": "Canoa havaiana no Lago Paranoá diante do sol nascente"
      },
      "primaryCta": { "label": "Reservar minha vaga", "href": "#reservas" },
      "secondaryCta": { "label": "Conhecer a experiência", "href": "#sobre" },
      "details": ["Duração: 1h30", "Horário: 6h", "Nível: iniciantes ao avançado"]
    },
    "quickFacts": [
      { "label": "Duração", "value": "1h30" },
      { "label": "Horário de saída", "value": "6h" },
      { "label": "Chegada recomendada", "value": "5h50" },
      { "label": "Local", "value": "Base da Alma Azul Academy, Lago Norte" },
      { "label": "Nível", "value": "iniciantes ao avançado" },
      { "label": "Dias habituais", "value": "sextas-feiras e sábados" },
      { "label": "Valor", "value": "R$ 70 por pessoa" },
      { "label": "Capacidade padrão", "value": "28 pessoas" }
    ],
    "about": {
      "eyebrow": "Sobre a experiência",
      "title": "Remada do Nascer do Sol",
      "paragraphs": [
        "A Remada do Nascer do Sol é um convite para começar o dia de uma forma diferente: dentro de uma canoa havaiana, sobre as águas tranquilas do Lago Paranoá e cercado pelos sons da natureza.",
        "Durante a experiência, o grupo acompanha as primeiras luzes da manhã, faz pausas para banho no meio do lago e em uma prainha e compartilha um café preto ainda dentro da canoa.",
        "O retorno acontece no início da manhã, com o sol iluminando Brasília e deixando o restante do dia mais leve."
      ],
      "image": {
        "src": "/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-sobre.webp",
        "alt": "Participantes remando em uma canoa havaiana nas primeiras luzes da manhã"
      }
    },
    "gallery": {
      "eyebrow": "Galeria",
      "title": "Remada do Nascer do Sol",
      "description": "Uma remada nas primeiras luzes do dia, com banho no lago, café preto dentro da canoa e os sons da natureza ao redor.",
      "images": [
        { "src": "/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-galeria-01.webp", "alt": "Canoa havaiana vista de frente nas águas do Lago Paranoá ao amanhecer" },
        { "src": "/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-galeria-02.webp", "alt": "Canoa havaiana navegando sob o céu alaranjado do amanhecer" },
        { "src": "/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-galeria-03.webp", "alt": "Participantes remando no Lago Paranoá antes do nascer do sol" },
        { "src": "/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-galeria-04.webp", "alt": "Sol nascendo diante de uma canoa havaiana no Lago Paranoá" },
        { "src": "/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-galeria-05.webp", "alt": "Canoa havaiana refletida nas águas calmas do Lago Paranoá pela manhã" },
        { "src": "/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-galeria-06.webp", "alt": "Grupo reunido em uma canoa havaiana sob o céu azul do amanhecer" },
        { "src": "/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-galeria-07.webp", "alt": "Participantes contemplando o céu colorido sobre o Lago Paranoá" }
      ]
    },
    "steps": {
      "eyebrow": "Como funciona",
      "title": "Como funciona",
      "description": "",
      "items": [
        { "title": "Recepção e preparação", "description": "O encontro acontece na base da Alma Azul Academy. A equipe recebe o grupo, entrega os equipamentos e apresenta as orientações para a experiência." },
        { "title": "Instrução e remada", "description": "Antes de entrar na água, todos recebem instruções de segurança e técnica de remada. Depois, seguimos pelo Lago Paranoá em um ritmo confortável, acompanhando o despertar da manhã." },
        { "title": "Banho e café na canoa", "description": "Durante o percurso, fazemos pausas para banho no meio do lago e em uma prainha. Também compartilhamos um café preto dentro da canoa enquanto contemplamos as primeiras luzes do dia." }
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
        { "icon": "Droplets", "title": "Paradas para banho", "description": "" },
        { "icon": "Sparkles", "title": "Café preto compartilhado dentro da canoa", "description": "" },
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
        "Agasalho para o início da manhã"
      ]
    },
    "faq": {
      "eyebrow": "Dúvidas frequentes",
      "title": "Antes de entrar na água.",
      "items": [
        { "question": "Que horas devo chegar?", "answer": "A chegada está programada para 5h50, para que o grupo possa se preparar com tranquilidade antes da saída às 6h." },
        { "question": "Faz frio pela manhã?", "answer": "Pode fazer frio nas primeiras horas do dia, principalmente antes do sol nascer. Recomendamos levar um agasalho leve." },
        { "question": "Tem café da manhã?", "answer": "Não servimos café da manhã ou lanche. Durante a remada, compartilhamos um café preto dentro da canoa." }
      ]
    },
    "reservations": {
      "eyebrow": "Remada do Nascer do Sol",
      "title": "Reservar minha vaga",
      "description": "Uma experiência ao amanhecer para contemplar o despertar de Brasília, mergulhar no Lago Paranoá e começar o dia com mais energia e leveza.",
      "image": {
        "src": "/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-reservas.webp",
        "alt": "Canoa havaiana navegando no Lago Paranoá sob o céu colorido da manhã"
      }
    },
    "seo": {
      "title": "Remada do Nascer do Sol no Lago Paranoá | Alma Azul Academy",
      "description": "Veja Brasília despertar de dentro de uma canoa havaiana. Remada de 1h30 com banho no lago, café preto na canoa, fotos e acompanhamento completo."
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
        'remada-nascer-do-sol',
        'Remada do Nascer do Sol',
        'AMANHECER NO LAGO PARANOÁ',
        'Uma experiência ao amanhecer para contemplar o despertar de Brasília, mergulhar no Lago Paranoá e começar o dia com mais energia e leveza.',
        'Uma experiência ao amanhecer para contemplar o despertar de Brasília, mergulhar no Lago Paranoá e começar o dia com mais energia e leveza.',
        90,
        'Base da Alma Azul Academy, Lago Norte, Brasília',
        '/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-hero.webp',
        $1 #> '{gallery,images}',
        $1 #> '{included,items}',
        true,
        'Uma remada nas primeiras luzes do dia, com banho no lago, café preto dentro da canoa e os sons da natureza ao redor.',
        7000,
        28,
        'PUBLISHED',
        '/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-hero.webp',
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
    $legacy_insert$ using experience_editorial, sunset_order + 1;
  else
    insert into public.experiences (
      slug, title, summary, description, duration_minutes, price_cents,
      default_capacity, status, image_url, display_order, editorial_content,
      created_at, updated_at
    )
    values (
      'remada-nascer-do-sol',
      'Remada do Nascer do Sol',
      'Uma remada nas primeiras luzes do dia, com banho no lago, café preto dentro da canoa e os sons da natureza ao redor.',
      'Uma experiência ao amanhecer para contemplar o despertar de Brasília, mergulhar no Lago Paranoá e começar o dia com mais energia e leveza.',
      90,
      7000,
      28,
      'PUBLISHED',
      '/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-hero.webp',
      sunset_order + 1,
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

-- 06:00 in America/Sao_Paulo is 09:00 UTC on 2026-08-07.
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
  make_timestamptz(2026, 8, 7, 6, 0, 0, 'America/Sao_Paulo'),
  90,
  7000,
  28,
  'OPEN'::public.session_status
from public.experiences experience
where experience.slug = 'remada-nascer-do-sol'
  and not exists (
    select 1
    from public.sessions session
    where session.experience_id = experience.id
      and session.starts_at = make_timestamptz(2026, 8, 7, 6, 0, 0, 'America/Sao_Paulo')
  );
