-- Imagem própria para o card público da Imersão Paranoá.
--
-- Contexto: o card da Home e o Hero da página individual liam o mesmo campo
-- canônico (editorial_content -> hero -> image). Esta migration adiciona a chave
-- opcional `cardImage`, lida com prioridade apenas pelo card, de modo que a foto
-- do córrego apareça na Home sem alterar o Hero, a galeria ou qualquer texto.
--
-- Aditiva e idempotente: reexecutar produz exatamente o mesmo estado.
-- Afeta somente a experiência de slug 'imersao-paranoa'.
-- Não toca em reservas, sessões, preços, capacidades, pagamentos ou outras experiências.

do $card_image$
declare
  imersao_card jsonb := $json$
  {
    "src": "/images/experiences/imersao-paranoa/imersao-paranoa-corrego-mata.webp",
    "alt": "Canoas da Alma Azul navegando dentro do Córrego do Torto, cercadas pela mata fechada"
  }
  $json$::jsonb;
  previous_hero text;
  previous_gallery jsonb;
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

  if not exists (select 1 from public.experiences where slug = 'imersao-paranoa') then
    raise exception 'IMERSAO_PARANOA_NOT_FOUND';
  end if;

  -- Guarda o estado atual do Hero e da galeria para provar que nada mais mudou.
  select editorial_content #>> '{hero,image,src}', editorial_content #> '{gallery,images}'
    into previous_hero, previous_gallery
    from public.experiences
   where slug = 'imersao-paranoa';

  update public.experiences
  set editorial_content = jsonb_set(editorial_content, '{cardImage}', imersao_card, true),
      updated_at = now()
  where slug = 'imersao-paranoa'
    and editorial_content #> '{cardImage}' is distinct from imersao_card;

  -- Trava de segurança: Hero e galeria precisam continuar idênticos.
  if exists (
    select 1
    from public.experiences
    where slug = 'imersao-paranoa'
      and (
        editorial_content #>> '{hero,image,src}' is distinct from previous_hero
        or editorial_content #> '{gallery,images}' is distinct from previous_gallery
      )
  ) then
    raise exception 'IMERSAO_PARANOA_EDITORIAL_UNEXPECTED_CHANGE';
  end if;
end;
$card_image$;

-- Nota sobre campos legados: `image_url` e `cover_image` continuam apontando para
-- o Hero. Eles só são consultados como fallback quando o editorial não traz uma
-- imagem válida, e o card agora resolve por `cardImage`. Sincronizá-los mudaria o
-- Hero e a listagem administrativa sem necessidade, então foram deixados intactos.
