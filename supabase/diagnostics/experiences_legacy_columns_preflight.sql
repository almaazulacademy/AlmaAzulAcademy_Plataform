-- EXPERIÊNCIAS — COLUNAS LEGADAS NA CRIAÇÃO — PREFLIGHT (SOMENTE LEITURA)
--
-- Rodar no SQL Editor ANTES de `202610310002_experiences_legacy_columns_on_insert.sql`.
-- Um único SELECT no formato check_name | result | status. A última linha,
-- EXPERIENCIAS_LEGADO_PREFLIGHT_OK, precisa estar OK. Guarde
-- ASSINATURA_DAS_FUNCOES e as contagens.
--
-- COLUNAS_OBRIGATORIAS_SEM_PADRAO lista TODA coluna NOT NULL sem valor padrão de
-- `experiences`. Cada uma precisa vir do INSERT de `admin_create_experience` ou
-- do gatilho desta migration; qualquer outra é FALHOU (o cadastro falharia nela).

with mandatory as (
  select c.column_name, c.data_type
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'experiences'
    and c.is_nullable = 'NO' and c.column_default is null
),
covered(column_name) as (values
  -- inseridas por admin_create_experience
  ('slug'), ('title'), ('summary'), ('description'), ('duration_minutes'), ('price_cents'), ('default_capacity'),
  ('status'), ('image_url'), ('display_order'), ('editorial_content'), ('base_id'),
  -- preenchidas pelo gatilho
  ('eyebrow'), ('short_description'), ('location'), ('cover_image'), ('gallery'), ('included'), ('active')
),
legacy(column_name, accepted) as (values
  ('eyebrow', array['text', 'character varying']), ('short_description', array['text', 'character varying']),
  ('location', array['text', 'character varying']), ('cover_image', array['text', 'character varying']),
  ('gallery', array['jsonb', 'json', 'ARRAY']), ('included', array['jsonb', 'json', 'ARRAY']), ('active', array['boolean'])
),
legacy_found as (
  select l.column_name, c.data_type, c.is_nullable, c.column_default is not null as has_default,
         c.column_name is null or c.data_type = any (l.accepted) as type_ok
  from legacy l left join information_schema.columns c
    on c.table_schema = 'public' and c.table_name = 'experiences' and c.column_name = l.column_name
),
checks as (
  select 'COLUNAS_OBRIGATORIAS_SEM_PADRAO' as check_name,
         coalesce((select string_agg(column_name, ', ' order by column_name) from mandatory), 'nenhuma') as result,
         case when exists (select 1 from mandatory m where m.column_name not in (select column_name from covered)) then 'FALHOU' else 'OK' end as status
  union all
  select 'COLUNAS_LEGADAS',
         (select string_agg(column_name || '=' || coalesce(data_type || case when is_nullable = 'NO' then ' obrigatória' else '' end || case when has_default then ' com padrão' else '' end, 'ausente'), ', ' order by column_name) from legacy_found),
         case when (select bool_and(type_ok) from legacy_found) then 'OK' else 'FALHOU' end
  union all
  select 'GATILHO_E_FUNCAO_AINDA_AUSENTES',
         'função=' || exists (select 1 from pg_proc where proname = 'experiences_fill_legacy_columns' and pronamespace = 'public'::regnamespace)::text
           || ', gatilho=' || exists (select 1 from pg_trigger where tgname = 'experiences_fill_legacy_columns' and tgrelid = 'public.experiences'::regclass)::text,
         case when exists (select 1 from pg_proc where proname = 'experiences_fill_legacy_columns' and pronamespace = 'public'::regnamespace)
               or exists (select 1 from pg_trigger where tgname = 'experiences_fill_legacy_columns' and tgrelid = 'public.experiences'::regclass) then 'ATENCAO' else 'OK' end
  union all
  select 'GATILHOS_DE_EXPERIENCES',
         coalesce((select string_agg(tgname, ', ' order by tgname) from pg_trigger where tgrelid = 'public.experiences'::regclass and not tgisinternal), 'nenhum'),
         'OK'
  union all
  select 'ASSINATURA_DAS_FUNCOES',
         (select count(*)::text || ' funções, ' || md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), '|' order by p.oid::regprocedure::text))
          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname <> 'experiences_fill_legacy_columns'),
         'OK'
  union all
  select 'EXPERIENCIAS_POR_TIPO_E_STATUS',
         (select string_agg(kind || '/' || status || '=' || n, ', ' order by kind, status) from (select kind, status, count(*) n from public.experiences group by 1, 2) x),
         'OK'
  union all
  select 'ESSENCIA_AUSENTE',
         case when exists (select 1 from public.experiences where slug = 'essencia') then 'existe' else 'ausente' end,
         case when exists (select 1 from public.experiences where slug = 'essencia') then 'FALHOU' else 'OK' end
  union all
  select 'RESERVAS_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.reservations group by 1) x),
         'OK'
)
select check_name, result, status from checks
union all
select 'EXPERIENCIAS_LEGADO_PREFLIGHT_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
