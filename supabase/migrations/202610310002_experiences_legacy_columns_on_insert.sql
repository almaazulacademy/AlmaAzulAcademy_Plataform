-- Experiências: preencher as colunas do schema legado ao criar uma experiência.
--
-- Causa (30/10/2026, cadastro do ESSÊNCIA): a tabela `experiences` de produção
-- veio do schema legado (julho/2026, fora do repositório) e ainda tem sete
-- colunas editoriais antigas, obrigatórias e sem valor padrão — `eyebrow`,
-- `short_description`, `location`, `cover_image`, `gallery`, `included` e
-- `active`. As migrations que inserem experiências já sabiam disso (ver
-- `202609150001_multi_base.sql`, que preenche as sete quando elas existem), mas
-- `admin_create_experience` — o caminho do painel, usado por `admin_create_event`
-- — insere só as colunas atuais. Em produção, qualquer criação por esse caminho
-- falha com `23502 null value in column "eyebrow"`, e a transação inteira volta.
--
-- Correção mínima, sem mudar o corpo de nenhuma função e sem afrouxar nenhuma
-- restrição: um gatilho `before insert` em `experiences` que, **só quando a
-- coluna legada existe e veio nula**, a preenche a partir das colunas atuais da
-- mesma linha — o mesmo critério da `202609150001`:
--
--   eyebrow           ← `editorial_content.hero.eyebrow`, ou o título
--   short_description ← o resumo
--   location          ← o rótulo de local da base, ou o nome dela
--   cover_image       ← `image_url` (vazio se não houver)
--   gallery, included ← '[]'
--   active            ← status = 'PUBLISHED'
--
-- Valor informado nunca é trocado. Em banco sem as colunas legadas (o do
-- repositório), o gatilho não faz nada. Nenhuma linha existente é tocada, nada
-- de reserva, sessão, pagamento ou lista de espera. Aditiva e idempotente: uma
-- função nova e um gatilho novo.

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

revoke all on function public.experiences_fill_legacy_columns() from public, anon, authenticated, service_role;

drop trigger if exists experiences_fill_legacy_columns on public.experiences;
create trigger experiences_fill_legacy_columns
  before insert on public.experiences
  for each row execute function public.experiences_fill_legacy_columns();
