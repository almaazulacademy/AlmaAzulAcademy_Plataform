-- ROTAS DO CÁPSULA BAR — POSTCHECK (SOMENTE LEITURA)
--
-- Rodar no SQL Editor DEPOIS de 202610120001_rotas_capsula_bar.sql.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita,
-- nenhuma função nova e nenhum dado pessoal retornado.
--
-- A linha final, ROTAS_CAPSULA_BAR_OK, só fica OK quando todas as outras estão OK.
-- Compare as linhas ROTA_* com as do preflight: id, valores, sessões e reservas
-- precisam ser os mesmos.

with routes as (
  select e.*, b.slug as base_slug,
         (select count(*) from public.sessions s where s.experience_id = e.id) as sessions,
         (select count(*) from public.reservations r where r.experience_id = e.id) as reservations
  from public.experiences e
  join public.bases b on b.id = e.base_id
  where e.slug in ('rota-ermida-ponte-jk', 'rota-prainha-do-congresso')
),
checks as (
  select 'DUAS_ROTAS_COM_SLUG_NOVO' as check_name,
         (select string_agg(slug || ' = ' || title, ', ' order by slug) from routes) as result,
         (select count(*) = 2 and bool_and(base_slug = 'concha-acustica') from routes) as ok
  union all
  select 'NOME_ANTIGO_FORA_DO_CADASTRO',
         (select count(*)::text from public.experiences where slug like 'caminhos%' or title ilike '%caminhos%' or modality like 'caminhos%'),
         (select count(*) = 0 from public.experiences where slug like 'caminhos%' or title ilike '%caminhos%' or modality like 'caminhos%')
  union all
  select 'LANDING_PUBLICAVEL_NAS_DUAS',
         (select string_agg(slug || ':' || public.experience_editorial_is_publishable(editorial_content)::text, ', ' order by slug) from routes),
         (select bool_and(public.experience_editorial_is_publishable(editorial_content)) from routes)
  union all
  select 'DURACAO_PADRAO_DE_90_MINUTOS',
         (select string_agg(slug || ':' || duration_minutes || ' min', ', ' order by slug) from routes),
         (select bool_and(duration_minutes = 90) from routes)
  union all
  select 'SLUGS_ANTIGOS_APOSENTADOS',
         coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.experiences'::regclass and conname = 'experiences_retired_slugs'), 'constraint ausente'),
         exists (select 1 from pg_constraint where conrelid = 'public.experiences'::regclass and conname = 'experiences_retired_slugs')
  union all
  select 'ROTA_' || upper(replace(replace(slug, 'rota-', ''), '-', '_')),
         format('id=%s | título=%s | status=%s | %s centavos | %s min | %s vagas padrão | sessões=%s | reservas=%s',
                id, title, status, price_cents, duration_minutes, default_capacity, sessions, reservations),
         true
  from routes
  union all
  select 'CINCO_EXPERIENCIAS_NA_BASE',
         (select string_agg(e.slug || ':' || e.status, ', ' order by e.slug) from public.experiences e join public.bases b on b.id = e.base_id where b.slug = 'concha-acustica'),
         (select count(*) = 5 from public.experiences e join public.bases b on b.id = e.base_id where b.slug = 'concha-acustica')
  union all
  select 'NASCER_DO_SOL_E_LUA_CHEIA_SEGUEM_EM_BREVE',
         (select string_agg(slug || ':' || status, ', ' order by slug) from public.experiences
           where slug in ('remada-nascer-do-sol-concha-acustica', 'remada-lua-cheia-concha-acustica')),
         (select count(*) = 2 and bool_and(status = 'COMING_SOON') from public.experiences
           where slug in ('remada-nascer-do-sol-concha-acustica', 'remada-lua-cheia-concha-acustica'))
  union all
  select 'REMADA_SUNSET_SEGUE_PUBLICADA',
         (select status from public.experiences where slug = 'remada-sunset-concha-acustica'),
         coalesce((select status = 'PUBLISHED' from public.experiences where slug = 'remada-sunset-concha-acustica'), false)
)
select check_name, result, case when ok then 'OK' else 'REVISAR' end as status from checks
union all
select 'ROTAS_CAPSULA_BAR_OK', '', case when (select bool_and(coalesce(ok, false)) from checks) then 'OK' else 'REVISAR' end;
