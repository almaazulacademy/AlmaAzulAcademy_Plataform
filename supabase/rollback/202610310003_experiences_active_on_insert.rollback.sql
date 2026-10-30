-- =============================================================================
-- ROLLBACK de 202610310003_experiences_active_on_insert.sql — SOMENTE PARA
-- REVISÃO. NÃO EXECUTAR sem decisão explícita. Não está em supabase/migrations/
-- de propósito, para nenhuma ferramenta aplicá-lo.
-- =============================================================================
--
-- Devolve à função o corpo da 202610310002. Linhas já criadas ficam como estão.
-- Depois dele, rascunho volta a nascer com `active = true` em produção, legível
-- pela chave pública, e o cadastro do ESSÊNCIA para em ESSENCIA_ATIVO.

begin;
set local lock_timeout = '5s';

create or replace function public.experiences_fill_legacy_columns()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  current_row jsonb := to_jsonb(new);
  fill jsonb := '{}'::jsonb;
  place text;
begin
  if current_row ? 'eyebrow' and current_row ->> 'eyebrow' is null then
    fill := fill || jsonb_build_object('eyebrow', coalesce(nullif(trim(new.editorial_content #>> '{hero,eyebrow}'), ''), new.title));
  end if;
  if current_row ? 'short_description' and current_row ->> 'short_description' is null then
    fill := fill || jsonb_build_object('short_description', new.summary);
  end if;
  if current_row ? 'location' and current_row ->> 'location' is null then
    select coalesce(nullif(trim(b.location_label), ''), b.name) into place from public.bases b where b.id = new.base_id;
    fill := fill || jsonb_build_object('location', coalesce(place, 'Brasília - DF'));
  end if;
  if current_row ? 'cover_image' and current_row ->> 'cover_image' is null then
    fill := fill || jsonb_build_object('cover_image', coalesce(new.image_url, ''));
  end if;
  if current_row ? 'gallery' and current_row -> 'gallery' = 'null'::jsonb then
    fill := fill || jsonb_build_object('gallery', '[]'::jsonb);
  end if;
  if current_row ? 'included' and current_row -> 'included' = 'null'::jsonb then
    fill := fill || jsonb_build_object('included', '[]'::jsonb);
  end if;
  if current_row ? 'active' and current_row -> 'active' = 'null'::jsonb then
    fill := fill || jsonb_build_object('active', new.status = 'PUBLISHED');
  end if;

  if fill <> '{}'::jsonb then
    new := jsonb_populate_record(new, fill);
  end if;
  return new;
end;
$$;

commit;
