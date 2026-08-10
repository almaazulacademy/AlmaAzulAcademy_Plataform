-- Capacidade padrão da Imersão Paranoá: 15 -> 28.
--
-- Causa do valor 15: a linha da Imersão Paranoá é a experiência original e
-- existia antes da coluna default_capacity. A migration
-- 202608030001_sprint5_complete_operations.sql criou a coluna e preencheu as
-- linhas antigas com `default_capacity = coalesce(default_capacity, 15)`, além
-- de definir `alter column default_capacity set default 15`. O 15 é, portanto,
-- um fallback genérico de backfill — nenhuma migration decidiu 15 para a
-- Imersão Paranoá. As experiências criadas depois (Remada Sunset, Remada do
-- Nascer do Sol e Remada da Lua Cheia) já nasceram com 28 explicitamente nas
-- suas próprias migrations, e o editorial delas anuncia "Capacidade padrão:
-- 28 pessoas". O editorial da Imersão Paranoá não declara capacidade, então
-- esta correção não contradiz nenhum texto publicado.
--
-- Aditiva e idempotente: reexecutar não muda mais nada, porque o UPDATE só
-- alcança a linha quando o valor ainda é diferente de 28.
--
-- Afeta exclusivamente public.experiences.default_capacity da linha de slug
-- 'imersao-paranoa'. Não altera sessões já existentes (cada sessão guarda a
-- própria capacity), reservas, pagamentos, autenticação, conteúdo editorial,
-- preço, status, ordem de exibição, nem a capacidade de qualquer outra
-- experiência. default_capacity só é usada como ponto de partida de sessões
-- novas — é dela que a agenda de setembro tira as 28 vagas.

do $imersao_capacity$
declare
  target_slug constant text := 'imersao-paranoa';
  target_capacity constant integer := 28;
  previous_capacity integer;
  others_before text;
  others_after text;
  applied_capacity integer;
begin
  if to_regclass('public.experiences') is null
     or not exists (
       select 1
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'experiences'
         and column_name = 'default_capacity'
     ) then
    raise exception 'EXPERIENCES_DEFAULT_CAPACITY_REQUIRED';
  end if;

  select default_capacity
  into previous_capacity
  from public.experiences
  where slug = target_slug;

  if not found then
    raise exception 'IMERSAO_PARANOA_NOT_FOUND';
  end if;

  -- Retrato das demais experiências, para provar depois que nenhuma delas mudou.
  select string_agg(format('%s=%s', slug, coalesce(default_capacity::text, 'null')), ', ' order by slug)
  into others_before
  from public.experiences
  where slug <> target_slug;

  update public.experiences
  set default_capacity = target_capacity,
      updated_at = now()
  where slug = target_slug
    and default_capacity is distinct from target_capacity;

  select string_agg(format('%s=%s', slug, coalesce(default_capacity::text, 'null')), ', ' order by slug)
  into others_after
  from public.experiences
  where slug <> target_slug;

  if others_after is distinct from others_before then
    raise exception using
      message = 'EXPERIENCES_UNEXPECTED_CAPACITY_CHANGE',
      detail = format('Antes: %s. Depois: %s.', coalesce(others_before, '(nenhuma)'), coalesce(others_after, '(nenhuma)')),
      hint = 'Nenhuma experiência além da Imersão Paranoá pode mudar nesta migration.';
  end if;

  select default_capacity
  into applied_capacity
  from public.experiences
  where slug = target_slug;

  if applied_capacity <> target_capacity then
    raise exception using
      message = 'IMERSAO_PARANOA_CAPACITY_NOT_APPLIED',
      detail = format('default_capacity ficou em %s, esperado %s.', applied_capacity, target_capacity);
  end if;

  if previous_capacity = target_capacity then
    raise notice 'Imersão Paranoá já estava com default_capacity = %; nada a fazer.', target_capacity;
  else
    raise notice 'Imersão Paranoá: default_capacity % -> %.', previous_capacity, target_capacity;
  end if;
end;
$imersao_capacity$;

-- Nota: o default da coluna continua 15 (definido na migration da Sprint 5) e
-- não é alterado aqui. Ele só valeria para uma experiência nova criada sem
-- informar capacidade, e o formulário administrativo sempre envia o valor.
-- Mudar o default da coluna seria uma decisão de schema separada desta correção
-- de dado.
