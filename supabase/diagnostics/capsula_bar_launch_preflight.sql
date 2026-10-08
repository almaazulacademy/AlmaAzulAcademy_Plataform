-- CÁPSULA BAR — PREFLIGHT (SOMENTE LEITURA)
--
-- Rodar no SQL Editor ANTES de 202610080001_capsula_bar_launch.sql.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita,
-- nenhuma função nova e nenhum dado pessoal retornado.
--
-- A linha final, PRONTO_PARA_APLICAR, só fica OK quando todas as outras estão OK.

with checks as (
  select 'MIGRATION_MULTI_BASE_APLICADA' as check_name,
         coalesce(to_regprocedure('public.list_public_catalog()')::text, 'ausente') as result,
         to_regprocedure('public.list_public_catalog()') is not null as ok
  union all
  select 'MIGRATION_CHECKIN_APLICADA',
         coalesce(to_regprocedure('public.public_checkin_ticket(uuid)')::text, 'ausente'),
         to_regprocedure('public.public_checkin_ticket(uuid)') is not null
  union all
  select 'BASES_ATUAIS',
         (select string_agg(slug || ':' || status, ', ' order by display_order) from public.bases),
         (select bool_or(slug = 'lago-norte' and status = 'ACTIVE') and bool_or(slug = 'concha-acustica') from public.bases)
  union all
  select 'EXPERIENCIAS_DA_SEGUNDA_BASE',
         (select string_agg(e.slug || ':' || e.status, ', ' order by e.display_order) from public.experiences e join public.bases b on b.id = e.base_id where b.slug = 'concha-acustica'),
         (select bool_or(e.slug = 'remada-sunset-concha-acustica') from public.experiences e join public.bases b on b.id = e.base_id where b.slug = 'concha-acustica')
  union all
  select 'SESSOES_JA_EXISTENTES_NA_SEGUNDA_BASE',
         (select count(*)::text from public.sessions s join public.experiences e on e.id = s.experience_id join public.bases b on b.id = e.base_id where b.slug = 'concha-acustica'),
         true
  union all
  select 'RESERVAS_FORA_DO_LAGO_NORTE',
         (select count(*)::text from public.reservations r join public.experiences e on e.id = r.experience_id join public.bases b on b.id = e.base_id where b.slug <> 'lago-norte'),
         (select count(*) = 0 from public.reservations r join public.experiences e on e.id = r.experience_id join public.bases b on b.id = e.base_id where b.slug <> 'lago-norte')
  union all
  select 'COLUNAS_LEGADAS_DE_EXPERIENCES',
         (select count(*)::text || ' de 7' from information_schema.columns
           where table_schema = 'public' and table_name = 'experiences'
             and column_name = any (array['eyebrow', 'short_description', 'location', 'cover_image', 'gallery', 'included', 'active'])),
         (select count(*) in (0, 7) from information_schema.columns
           where table_schema = 'public' and table_name = 'experiences'
             and column_name = any (array['eyebrow', 'short_description', 'location', 'cover_image', 'gallery', 'included', 'active']))
  union all
  select 'COLUNAS_OBRIGATORIAS_NAO_MAPEADAS_EM_EXPERIENCES',
         coalesce((select string_agg(column_name, ', ' order by ordinal_position) from information_schema.columns
           where table_schema = 'public' and table_name = 'experiences' and is_nullable = 'NO' and column_default is null
             and is_identity = 'NO' and is_generated = 'NEVER'
             and not (column_name = any (array['slug', 'title', 'eyebrow', 'short_description', 'description', 'duration_minutes', 'location',
               'cover_image', 'gallery', 'included', 'active', 'summary', 'price_cents', 'default_capacity', 'status', 'image_url',
               'display_order', 'editorial_content', 'base_id', 'is_exclusive', 'modality', 'created_at', 'updated_at']))), 'nenhuma'),
         (select count(*) = 0 from information_schema.columns
           where table_schema = 'public' and table_name = 'experiences' and is_nullable = 'NO' and column_default is null
             and is_identity = 'NO' and is_generated = 'NEVER'
             and not (column_name = any (array['slug', 'title', 'eyebrow', 'short_description', 'description', 'duration_minutes', 'location',
               'cover_image', 'gallery', 'included', 'active', 'summary', 'price_cents', 'default_capacity', 'status', 'image_url',
               'display_order', 'editorial_content', 'base_id', 'is_exclusive', 'modality', 'created_at', 'updated_at'])))
  union all
  select 'COLUNAS_OBRIGATORIAS_NAO_MAPEADAS_EM_SESSIONS',
         coalesce((select string_agg(column_name, ', ' order by ordinal_position) from information_schema.columns
           where table_schema = 'public' and table_name = 'sessions' and is_nullable = 'NO' and column_default is null
             and is_identity = 'NO' and is_generated = 'NEVER'
             and not (column_name = any (array['experience_id', 'starts_at', 'duration_minutes', 'price_cents', 'capacity', 'status', 'spots_available']))), 'nenhuma'),
         (select count(*) = 0 from information_schema.columns
           where table_schema = 'public' and table_name = 'sessions' and is_nullable = 'NO' and column_default is null
             and is_identity = 'NO' and is_generated = 'NEVER'
             and not (column_name = any (array['experience_id', 'starts_at', 'duration_minutes', 'price_cents', 'capacity', 'status', 'spots_available'])))
  union all
  select 'SESSOES_FUTURAS_ABERTAS_NO_LAGO_NORTE',
         (select count(*)::text from public.sessions s join public.experiences e on e.id = s.experience_id join public.bases b on b.id = e.base_id
           where b.slug = 'lago-norte' and s.status = 'OPEN' and s.starts_at > now()),
         true
)
select check_name, result, case when ok then 'OK' else 'REVISAR' end as status from checks
union all
select 'PRONTO_PARA_APLICAR', '', case when (select bool_and(ok) from checks) then 'OK' else 'REVISAR' end;
