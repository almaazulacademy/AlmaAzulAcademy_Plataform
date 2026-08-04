-- Publish Remada da Lua Cheia without creating sessions.
-- This migration is additive and idempotent. Apply it after the dynamic experiences migrations.

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
  sunrise_order integer;
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

  select display_order into sunrise_order
  from public.experiences
  where slug = 'remada-nascer-do-sol';

  if sunrise_order is null then
    raise exception 'REMADA_NASCER_DO_SOL_REQUIRED';
  end if;

  if not exists (select 1 from public.experiences where slug = 'remada-lua-cheia') then
    update public.experiences
    set display_order = display_order + 1,
        updated_at = now()
    where display_order > sunrise_order;
  end if;

  experience_editorial := $editorial$
  {
    "version": 1,
    "hero": {
      "eyebrow": "NOITE DE LUA CHEIA",
      "title": "Reme sob a luz da lua cheia.",
      "subtitle": "Uma experiência contemplativa para acompanhar a lua nascendo no horizonte, mergulhar no Lago Paranoá e encerrar a noite ao redor da fogueira.",
      "image": {
        "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-hero.webp",
        "alt": "Lua cheia refletida no Lago Paranoá diante de canoas havaianas"
      },
      "primaryCta": { "label": "Ver próximas datas", "href": "#reservas" },
      "secondaryCta": { "label": "Conhecer a experiência", "href": "#sobre" },
      "details": ["Duração: 1h30", "Frequência: programação mensal", "Nível: iniciantes ao avançado"]
    },
    "quickFacts": [
      { "label": "Duração da remada", "value": "1h30" },
      { "label": "Frequência", "value": "programação mensal" },
      { "label": "Local", "value": "Base da Alma Azul Academy, Lago Norte" },
      { "label": "Nível", "value": "iniciantes ao avançado" },
      { "label": "Valor", "value": "R$ 70 por pessoa" },
      { "label": "Capacidade padrão", "value": "28 pessoas" },
      { "label": "Encerramento", "value": "fogueira à beira do lago" }
    ],
    "about": {
      "eyebrow": "Sobre a experiência",
      "title": "Remada da Lua Cheia",
      "paragraphs": [
        "A Remada da Lua Cheia é um convite para contemplar o Lago Paranoá sob uma nova luz. De dentro da canoa havaiana, acompanhamos a lua surgindo no horizonte e refletindo sobre as águas.",
        "Nos primeiros dias da programação, a experiência pode começar ainda com a luz do entardecer, permitindo acompanhar o pôr do sol e, logo depois, o nascimento da lua — algumas vezes, os dois no mesmo horizonte.",
        "Durante a remada, fazemos pausas para contemplação e banho. Para quem busca mais aventura, há a possibilidade de mergulhar no meio do lago. Para um momento mais tranquilo, também paramos em uma prainha.",
        "O retorno acontece já no escuro e a experiência termina com uma fogueira à beira do lago, criando um último momento de encontro e conexão com a natureza."
      ],
      "image": {
        "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-sobre.webp",
        "alt": "Participantes em uma canoa havaiana à noite com a lua refletida no lago"
      }
    },
    "gallery": {
      "eyebrow": "Galeria",
      "title": "Remada da Lua Cheia",
      "description": "Uma remada sob a lua cheia, com banho no lago, contemplação no horizonte e fogueira à beira da água.",
      "images": [
        { "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-01.webp", "alt": "Lua cheia sobre canoas havaianas alinhadas na margem do Lago Paranoá" },
        { "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-02.webp", "alt": "Grupo remando em uma canoa havaiana durante o pôr do sol" },
        { "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-03.webp", "alt": "Lua cheia próxima ao horizonte sobre o Lago Paranoá" },
        { "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-04.webp", "alt": "Participantes remando com a lua cheia no horizonte" },
        { "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-05.webp", "alt": "Remada noturna sob a lua cheia e seu reflexo no lago" },
        { "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-fogueira.webp", "alt": "Fogueira acesa à beira do Lago Paranoá durante a noite" },
        { "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-06.webp", "alt": "Grupo reunido à noite na margem do Lago Paranoá" },
        { "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-07.webp", "alt": "Participantes em uma canoa havaiana nas águas do Lago Paranoá" }
      ]
    },
    "steps": {
      "eyebrow": "Como funciona",
      "title": "Como funciona",
      "description": "",
      "items": [
        { "title": "Recepção e preparação", "description": "O encontro acontece na base da Alma Azul Academy. A equipe recebe o grupo, entrega os equipamentos e apresenta as orientações de segurança e remada." },
        { "title": "Pôr do sol e nascimento da lua", "description": "Dependendo da data, iniciamos a experiência ainda com a luz do entardecer. Remamos pelo Lago Paranoá acompanhando o pôr do sol e a lua cheia surgindo no horizonte." },
        { "title": "Banho e contemplação", "description": "Durante o percurso, fazemos uma pausa no meio do lago para quem busca mais aventura e outra em uma prainha para um banho tranquilo e um momento de contemplação." },
        { "title": "Fogueira à beira do lago", "description": "Depois do retorno à base, encerramos a experiência com cerca de 30 minutos de fogueira à beira do lago." }
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
        { "icon": "Sparkles", "title": "Momento de contemplação no lago", "description": "" },
        { "icon": "Sparkles", "title": "Fotos registradas pelos instrutores", "description": "" },
        { "icon": "Sparkles", "title": "Aproximadamente 30 minutos de fogueira após a remada", "description": "" },
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
        "Agasalho para o retorno noturno"
      ]
    },
    "faq": {
      "eyebrow": "Dúvidas frequentes",
      "title": "Antes de entrar na água.",
      "items": [
        { "question": "A experiência termina no escuro?", "answer": "Sim. O retorno à base normalmente acontece já à noite, depois do nascimento da lua. Toda a atividade é acompanhada pelos instrutores." },
        { "question": "Pode fazer frio durante a remada?", "answer": "Sim. A temperatura pode diminuir depois do pôr do sol e durante o retorno. Recomendamos levar um agasalho." },
        { "question": "O que acontece se a lua estiver encoberta?", "answer": "Se a previsão indicar céu muito nublado e nenhuma possibilidade de avistar a lua, a experiência poderá ser cancelada. Nesse caso, o participante poderá escolher entre o reembolso integral ou deixar o valor como crédito para uma nova data." },
        { "question": "Quanto tempo dura a fogueira?", "answer": "Após a remada, reservamos aproximadamente 30 minutos para um momento de fogueira à beira do lago." },
        { "question": "Posso levar algo para comer ou beber na fogueira?", "answer": "Sim. A Alma Azul não fornece alimentos ou bebidas nesta experiência, mas cada participante pode levar algo para consumo próprio durante a fogueira." },
        { "question": "Crianças podem participar?", "answer": "Sim. Crianças são bem-vindas quando acompanhadas pelos pais ou responsáveis e habituadas a participar de experiências na natureza." }
      ]
    },
    "reservations": {
      "eyebrow": "Remada da Lua Cheia",
      "title": "Ver próximas datas",
      "description": "Uma experiência noturna em canoa havaiana para acompanhar a lua cheia nascendo no horizonte, mergulhar no Lago Paranoá e terminar a noite ao redor da fogueira.",
      "image": {
        "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-reservas.webp",
        "alt": "Lua cheia refletida no Lago Paranoá ao lado de uma canoa havaiana"
      }
    },
    "seo": {
      "title": "Remada da Lua Cheia no Lago Paranoá | Alma Azul Academy",
      "description": "Reme sob a lua cheia no Lago Paranoá. Experiência de canoa havaiana com banho, contemplação, fotos e fogueira à beira do lago."
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
        'remada-lua-cheia',
        'Remada da Lua Cheia',
        'NOITE DE LUA CHEIA',
        'Uma experiência noturna em canoa havaiana para acompanhar a lua cheia nascendo no horizonte, mergulhar no Lago Paranoá e terminar a noite ao redor da fogueira.',
        'Uma experiência noturna em canoa havaiana para acompanhar a lua cheia nascendo no horizonte, mergulhar no Lago Paranoá e terminar a noite ao redor da fogueira.',
        90,
        'Base da Alma Azul Academy, Lago Norte, Brasília',
        '/images/experiences/remada-lua-cheia/remada-lua-cheia-hero.webp',
        $1 #> '{gallery,images}',
        $1 #> '{included,items}',
        true,
        'Uma remada sob a lua cheia, com banho no lago, contemplação no horizonte e fogueira à beira da água.',
        7000,
        28,
        'PUBLISHED',
        '/images/experiences/remada-lua-cheia/remada-lua-cheia-hero.webp',
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
    $legacy_insert$ using experience_editorial, sunrise_order + 1;
  else
    insert into public.experiences (
      slug, title, summary, description, duration_minutes, price_cents,
      default_capacity, status, image_url, display_order, editorial_content,
      created_at, updated_at
    )
    values (
      'remada-lua-cheia',
      'Remada da Lua Cheia',
      'Uma remada sob a lua cheia, com banho no lago, contemplação no horizonte e fogueira à beira da água.',
      'Uma experiência noturna em canoa havaiana para acompanhar a lua cheia nascendo no horizonte, mergulhar no Lago Paranoá e terminar a noite ao redor da fogueira.',
      90,
      7000,
      28,
      'PUBLISHED',
      '/images/experiences/remada-lua-cheia/remada-lua-cheia-hero.webp',
      sunrise_order + 1,
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
