-- CAPACIDADE PADRÃO DAS EXPERIÊNCIAS REGULARES (LAGO NORTE 24, CÁPSULA BAR 12) — PREFLIGHT (SOMENTE LEITURA)
--
-- `experiences.default_capacity` é o campo "Capacidade padrão" do formulário de
-- experiência no painel. No código do repositório nenhuma sessão é criada a
-- partir dele (o formulário de sessão começa com a capacidade em branco e as
-- agendas em lote gravam a capacidade na própria sessão). Este preflight
-- confirma isso também no banco de produção, que tem funções legadas fora do
-- repositório: lista toda função, gatilho e visão que cita `default_capacity`.
--
-- Plano (supabase/maintenance/experiences_default_capacity_2026.sql): só a
-- coluna default_capacity das cinco experiências regulares da programação.
--   Lago Norte  — imersao-paranoa, remada-nascer-do-sol, remada-sunset → 24
--   Cápsula Bar — remada-sunset-concha-acustica, rota-ermida-ponte-jk  → 12
-- Sessões, reservas, eventos especiais e demais experiências não mudam.

with wanted (base_slug, experience_slug, new_capacity) as (
  values
    ('lago-norte', 'imersao-paranoa', 24),
    ('lago-norte', 'remada-nascer-do-sol', 24),
    ('lago-norte', 'remada-sunset', 24),
    ('concha-acustica', 'remada-sunset-concha-acustica', 12),
    ('concha-acustica', 'rota-ermida-ponte-jk', 12)
),
targets as (
  select w.*, e.id, e.kind::text as kind, e.status, e.default_capacity
  from wanted w
  join public.bases b on b.slug = w.base_slug
  join public.experiences e on e.slug = w.experience_slug and e.base_id = b.id
),
future_capacity as (
  select e.slug, string_agg(format('%s×%s', g.capacity, g.total), ', ' order by g.capacity) as capacities
  from (select s.experience_id, s.capacity, count(*) as total from public.sessions s
        where s.starts_at > now() and s.status::text = 'OPEN' group by 1, 2) g
  join public.experiences e on e.id = g.experience_id
  group by e.slug
),
facts as (
  select
    (select count(*) from targets) as found,
    (select string_agg(format('%s/%s: %s/%s, padrão atual %s → %s; turmas abertas futuras %s', t.base_slug, t.experience_slug, t.kind, t.status,
              t.default_capacity, t.new_capacity, coalesce(f.capacities, 'nenhuma')), ' · ' order by t.base_slug, t.experience_slug)
     from targets t left join future_capacity f on f.slug = t.experience_slug) as plan,
    (select count(*) from targets where kind <> 'REGULAR') as not_regular,
    (select count(*) from targets where default_capacity <> new_capacity) as to_change,
    (select string_agg(format('%s/%s: %s/%s, padrão %s', b.slug, e.slug, e.kind, e.status, e.default_capacity), ' · ' order by b.slug, e.slug)
     from public.experiences e join public.bases b on b.id = e.base_id
     where not exists (select 1 from wanted w where w.experience_slug = e.slug and w.base_slug = b.slug)) as other_experiences,
    (select string_agg(format('%s.%s', n.nspname, p.proname), ', ' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosrc ilike '%default_capacity%') as functions_citing,
    (select string_agg(t.tgname, ', ') from pg_trigger t join pg_proc p on p.oid = t.tgfoid
     where not t.tgisinternal and p.prosrc ilike '%default_capacity%') as triggers_citing,
    (select string_agg(v.table_name, ', ') from information_schema.views v
     where v.table_schema = 'public' and v.view_definition ilike '%default_capacity%') as views_citing,
    (select column_default from information_schema.columns
     where table_schema = 'public' and table_name = 'sessions' and column_name = 'capacity') as sessions_capacity_default,
    (select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.sessions s) as sessions_fingerprint
)
select checks.check_name, checks.result, checks.status
from (
  select 1 as ord, 'targets_found' as check_name, format('%s de 5', facts.found) as result,
         case when facts.found = 5 then 'OK' else 'REVIEW_REQUIRED' end as status from facts
  union all select 2, 'plan', coalesce(facts.plan, '-'), 'INFO' from facts
  union all select 3, 'targets_not_regular', facts.not_regular::text, case when facts.not_regular = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 4, 'to_change', facts.to_change::text, 'INFO' from facts
  union all select 5, 'other_experiences_unchanged', coalesce(facts.other_experiences, 'nenhuma'), 'INFO: fora do plano' from facts
  union all select 6, 'functions_citing_default_capacity', coalesce(facts.functions_citing, 'nenhuma'), 'INFO: conferir se alguma cria sessão a partir dele' from facts
  union all select 7, 'triggers_citing_default_capacity', coalesce(facts.triggers_citing, 'nenhum'),
         case when facts.triggers_citing is null then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 8, 'views_citing_default_capacity', coalesce(facts.views_citing, 'nenhuma'), 'INFO' from facts
  union all select 9, 'sessions_capacity_column_default', coalesce(facts.sessions_capacity_default, 'sem default'), 'INFO: não depende da experiência' from facts
  union all select 10, 'sessions_fingerprint', facts.sessions_fingerprint, 'INFO: comparar no postcheck' from facts
  union all select 11, 'READY_TO_UPDATE_DEFAULT_CAPACITY',
         case when facts.found = 5 and facts.not_regular = 0 and facts.triggers_citing is null
              then format('pronto: %s experiência(s) mudam de padrão', facts.to_change)
              else 'conferir as linhas acima' end,
         case when facts.found = 5 and facts.not_regular = 0 and facts.triggers_citing is null then 'OK' else 'REVIEW_REQUIRED' end
  from facts
) checks
order by checks.ord;
