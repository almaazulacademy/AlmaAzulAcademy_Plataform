-- ROTAS DO CÁPSULA BAR — PREFLIGHT (SOMENTE LEITURA)
--
-- Rodar no SQL Editor ANTES de 202610120001_rotas_capsula_bar.sql.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita,
-- nenhuma função nova e nenhum dado pessoal retornado.
--
-- A linha final, PRONTO_PARA_APLICAR, só fica OK quando todas as outras estão OK.
-- As linhas ROTA_* são informativas: mostram o cadastro, as sessões e as
-- reservas que já existem em cada rota — tudo isso é preservado.

with routes as (
  select e.*, b.slug as base_slug, b.status as base_status,
         (select count(*) from public.sessions s where s.experience_id = e.id) as sessions,
         (select count(*) from public.reservations r where r.experience_id = e.id) as reservations
  from public.experiences e
  join public.bases b on b.id = e.base_id
  where e.slug in ('caminhos-do-paranoa-rota-ermida-ponte-jk', 'rota-ermida-ponte-jk',
                   'caminhos-do-paranoa-rota-prainha-do-congresso', 'rota-prainha-do-congresso')
),
checks as (
  select 'BASE_CAPSULA_BAR_ATIVA' as check_name,
         (select name || ' · ' || status from public.bases where slug = 'concha-acustica') as result,
         coalesce((select status = 'ACTIVE' from public.bases where slug = 'concha-acustica'), false) as ok
  union all
  select 'DUAS_ROTAS_CADASTRADAS_NA_BASE',
         (select string_agg(slug || ':' || status, ', ' order by slug) from routes),
         (select count(*) = 2 and bool_and(base_slug = 'concha-acustica') from routes)
  union all
  select 'SLUGS_NOVOS_LIVRES_OU_JA_DAS_ROTAS',
         coalesce((select string_agg(e.slug || ' → ' || b.slug, ', ') from public.experiences e join public.bases b on b.id = e.base_id
                   where e.slug in ('rota-ermida-ponte-jk', 'rota-prainha-do-congresso')), 'livres'),
         (select count(*) = 0 from public.experiences e join public.bases b on b.id = e.base_id
           where e.slug in ('rota-ermida-ponte-jk', 'rota-prainha-do-congresso') and b.slug <> 'concha-acustica')
  union all
  select 'ROTA_' || upper(replace(replace(replace(slug, 'caminhos-do-paranoa-', ''), 'rota-', ''), '-', '_')),
         format('id=%s | título=%s | status=%s | %s centavos | %s min | %s vagas padrão | landing=%s | sessões=%s | reservas=%s',
                id, title, status, price_cents, duration_minutes, default_capacity,
                case when editorial_content is null or editorial_content = '{}'::jsonb then 'vazia (será preenchida)' else 'já preenchida (será mantida)' end,
                sessions, reservations),
         true
  from routes
  union all
  select 'DEMAIS_EXPERIENCIAS_DA_BASE',
         (select string_agg(e.slug || ':' || e.status, ', ' order by e.slug) from public.experiences e join public.bases b on b.id = e.base_id
           where b.slug = 'concha-acustica' and e.slug not like '%rota-%'),
         true
)
select check_name, result, case when ok then 'OK' else 'REVISAR' end as status from checks
union all
select 'PRONTO_PARA_APLICAR', '', case when (select bool_and(ok) from checks) then 'OK' else 'REVISAR' end;
