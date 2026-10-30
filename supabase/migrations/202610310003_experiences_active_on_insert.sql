-- Experiências: rascunho não nasce com o `active` legado ligado.
--
-- Causa (31/10/2026, antes do cadastro do ESSÊNCIA): em produção a coluna legada
-- `experiences.active` é obrigatória com padrão `true`, e existe a política RLS
-- de leitura `active = true OR is_admin()`. O gatilho da `202610310002` só
-- preenche coluna que chega nula, e o padrão já chega preenchido: uma experiência
-- criada em rascunho nasceria com `active = true`, legível pela chave pública.
--
-- Correção: mesmo gatilho, corpo novo em uma única regra. Na inserção, se
-- `active` vier `true` e o status não for `PUBLISHED`, grava `false`. Inserção
-- publicada não muda. Vale para criar evento, duplicar evento e criar experiência
-- pelo painel, porque todos passam por este INSERT.
--
-- Só `create or replace` da função criada pela `202610310002`: mesma assinatura,
-- mesmas permissões, mesmo gatilho (só INSERT). Nenhuma linha existente é tocada,
-- nenhuma outra função muda, nenhuma restrição ou política é alterada. Em banco
-- sem a coluna `active`, nada muda.
--
-- Não resolve (fica para a auditoria de RLS antes de publicar): linhas já
-- existentes, UPDATE de status e as demais leituras pela chave pública.

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
  -- `active` tem padrão `true` em produção, então chega preenchida mesmo quando
  -- ninguém a informou. Experiência que não nasce publicada não pode nascer ativa.
  if current_row ? 'active'
     and (current_row -> 'active' = 'null'::jsonb
          or (current_row ->> 'active' = 'true' and new.status <> 'PUBLISHED')) then
    fill := fill || jsonb_build_object('active', new.status = 'PUBLISHED');
  end if;

  if fill <> '{}'::jsonb then
    new := jsonb_populate_record(new, fill);
  end if;
  return new;
end;
$$;
