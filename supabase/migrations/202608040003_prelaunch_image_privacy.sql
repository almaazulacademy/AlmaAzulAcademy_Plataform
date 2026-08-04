-- Synchronize privacy-reviewed public imagery without changing product data.
-- Additive and idempotent: safe to re-run after 202608040002.

do $privacy$
declare
  imersao_gallery jsonb := $json$
  [
    { "src": "/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-2074.webp", "alt": "Canoas navegando sob a mata do Córrego do Torto" },
    { "src": "/images/experiences/imersao-paranoa/lago/alma-azul-original.webp", "alt": "Participantes vistos de costas remando no Córrego do Torto" },
    { "src": "/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-1956.webp", "alt": "Grupo remando no corredor natural" },
    { "src": "/images/experiences/imersao-paranoa/grupos/img-3964.webp", "alt": "Grupo visto de costas em canoas sob a mata do Córrego do Torto" },
    { "src": "/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-2672.webp", "alt": "Paisagem aberta entre o córrego e a vegetação" },
    { "src": "/images/experiences/imersao-paranoa/lago/img-4363.webp", "alt": "Participantes vistos de costas remando sob a mata" }
  ]
  $json$::jsonb;
  moonlight_gallery jsonb := $json$
  [
    { "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-01.webp", "alt": "Lua cheia sobre canoas havaianas alinhadas na margem do Lago Paranoá" },
    { "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-02.webp", "alt": "Grupo remando em uma canoa havaiana durante o pôr do sol" },
    { "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-03.webp", "alt": "Lua cheia próxima ao horizonte sobre o Lago Paranoá" },
    { "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-04.webp", "alt": "Participantes remando com a lua cheia no horizonte" },
    { "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-05.webp", "alt": "Remada noturna sob a lua cheia e seu reflexo no lago" },
    { "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-fogueira.webp", "alt": "Fogueira acesa à beira do Lago Paranoá durante a noite" },
    { "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-06.webp", "alt": "Participantes preparando canoas na margem do Lago Paranoá vistos de costas" },
    { "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-07.webp", "alt": "Remadores vistos de costas diante da lua cheia no horizonte" }
  ]
  $json$::jsonb;
begin
  if to_regclass('public.experiences') is null
     or not exists (
       select 1
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'experiences'
         and column_name = 'editorial_content'
         and data_type = 'jsonb'
     ) then
    raise exception 'DYNAMIC_EXPERIENCES_MIGRATION_REQUIRED';
  end if;

  if not exists (select 1 from public.experiences where slug = 'imersao-paranoa')
     or not exists (select 1 from public.experiences where slug = 'remada-lua-cheia') then
    raise exception 'PRIVACY_TARGET_EXPERIENCES_NOT_FOUND';
  end if;

  update public.experiences
  set editorial_content = jsonb_set(editorial_content, '{gallery,images}', imersao_gallery, false),
      image_url = '/images/backgrounds/hero-alma-azul-lago.webp',
      updated_at = now()
  where slug = 'imersao-paranoa';

  update public.experiences
  set editorial_content = jsonb_set(
        jsonb_set(
          editorial_content,
          '{about,image,alt}',
          to_jsonb('Lua cheia sobre o céu do Lago Paranoá ao entardecer'::text),
          false
        ),
        '{gallery,images}',
        moonlight_gallery,
        false
      ),
      image_url = editorial_content #>> '{hero,image,src}',
      updated_at = now()
  where slug = 'remada-lua-cheia';

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'experiences' and column_name = 'cover_image'
  ) then
    update public.experiences
    set cover_image = editorial_content #>> '{hero,image,src}'
    where slug in ('imersao-paranoa', 'remada-lua-cheia');
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'experiences' and column_name = 'gallery' and data_type = 'jsonb'
  ) then
    update public.experiences
    set gallery = editorial_content #> '{gallery,images}'
    where slug in ('imersao-paranoa', 'remada-lua-cheia');
  end if;
end;
$privacy$;
