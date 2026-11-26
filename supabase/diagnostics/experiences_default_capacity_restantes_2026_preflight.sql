-- CAPACIDADE PADRÃO — QUATRO EXPERIÊNCIAS REGULARES RESTANTES — PREFLIGHT (SOMENTE LEITURA)
--
-- Continuação de experiences_default_capacity_2026 (as cinco da programação,
-- aplicada em 23/11/2026). Padroniza as quatro experiências REGULARES que
-- ainda têm o valor antigo no campo "Capacidade padrão" do painel:
--   Cápsula Bar — rota-prainha-do-congresso, remada-lua-cheia-concha-acustica,
--                 remada-nascer-do-sol-concha-acustica: 24 → 12
--   Lago Norte  — remada-lua-cheia: 28 → 24
-- Eventos especiais (ESSÊNCIA e ESSÊNCIA Lua Cheia) ficam de fora de propósito:
-- têm configuração própria.
--
-- `experiences.default_capacity` só aparece no formulário de experiência do
-- painel; a capacidade de cada sessão é gravada na própria sessão e não muda.
--
-- Um único SELECT, check_name | result | status, sem dado pessoal. A linha
-- final, READY_TO_UPDATE_REMAINING_DEFAULT_CAPACITY, só fica OK quando a
-- manutenção pode rodar. Os fingerprints servem de linha de base para o
-- postcheck (rodar este preflight imediatamente antes da escrita).

with wanted (base_slug, experience_slug, from_capacity, to_capacity) as (
  values
    ('concha-acustica', 'rota-prainha-do-congresso', 24, 12),
    ('concha-acustica', 'remada-lua-cheia-concha-acustica', 24, 12),
    ('concha-acustica', 'remada-nascer-do-sol-concha-acustica', 24, 12),
    ('lago-norte', 'remada-lua-cheia', 28, 24)
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
others as (
  select e.*
  from public.experiences e
  where not exists (select 1 from targets t where t.id = e.id)
),
facts as (
  select
    (select count(*) from targets) as found,
    (select string_agg(format('%s/%s: id %s, %s/%s, padrão atual %s → %s; turmas abertas futuras %s', t.base_slug, t.experience_slug, t.id,
              t.kind, t.status, t.default_capacity, t.to_capacity, coalesce(f.capacities, 'nenhuma')), ' · ' order by t.base_slug, t.experience_slug)
     from targets t left join future_capacity f on f.slug = t.experience_slug) as plan,
    (select count(*) from targets where kind <> 'REGULAR') as not_regular,
    (select count(*) from targets where default_capacity = from_capacity) as to_change,
    (select count(*) from targets where default_capacity = to_capacity) as already_correct,
    (select string_agg(format('%s: %s (esperado %s ou %s)', experience_slug, default_capacity, from_capacity, to_capacity), ' · ')
     from targets where default_capacity not in (from_capacity, to_capacity)) as unexpected,
    (select string_agg(format('%s/%s: %s, padrão %s', b.slug, e.slug, e.status, e.default_capacity), ' · ' order by b.slug, e.slug)
     from public.experiences e join public.bases b on b.id = e.base_id where e.kind::text = 'EVENT') as events,
    (select string_agg(format('%s/%s: %s/%s, padrão %s', b.slug, e.slug, e.kind, e.status, e.default_capacity), ' · ' order by b.slug, e.slug)
     from others e join public.bases b on b.id = e.base_id) as other_experiences,
    (select md5(coalesce(string_agg((to_jsonb(e) - 'updated_at')::text, '|' order by e.id), '')) from others e) as other_experiences_fingerprint,
    (select md5(coalesce(string_agg((to_jsonb(e) - 'default_capacity' - 'updated_at')::text, '|' order by e.id), ''))
     from public.experiences e where exists (select 1 from targets t where t.id = e.id)) as targets_other_columns_fingerprint,
    (select string_agg(format('%s.%s', n.nspname, p.proname), ', ' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosrc ilike '%default_capacity%') as functions_citing,
    (select string_agg(t.tgname, ', ') from pg_trigger t join pg_proc p on p.oid = t.tgfoid
     where not t.tgisinternal and p.prosrc ilike '%default_capacity%') as triggers_citing,
    (select string_agg(v.table_name, ', ') from information_schema.views v
     where v.table_schema = 'public' and v.view_definition ilike '%default_capacity%') as views_citing,
    (select column_default from information_schema.columns
     where table_schema = 'public' and table_name = 'sessions' and column_name = 'capacity') as sessions_capacity_default,
    (select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.sessions s) as sessions_fingerprint,
    (select md5(coalesce(string_agg(to_jsonb(r)::text, '|' order by r.id), '')) from public.reservations r) as reservations_fingerprint,
    (select count(*) from public.sessions) as sessions_total,
    (select count(*) from public.reservations) as reservations_total
),
readiness as (
  select nullif(concat_ws('; ',
    case when facts.found <> 4 then format('%s de 4 experiências encontradas', facts.found) end,
    case when facts.not_regular > 0 then 'experiência do plano não é REGULAR' end,
    case when facts.unexpected is not null then format('valor inesperado: %s', facts.unexpected) end,
    case when facts.triggers_citing is not null then format('gatilho usa default_capacity: %s', facts.triggers_citing) end
  ), '') as problems
  from facts
)
select checks.check_name, checks.result, checks.status
from (
  select 1 as ord, 'targets_found' as check_name, format('%s de 4', facts.found) as result,
         case when facts.found = 4 then 'OK' else 'REVIEW_REQUIRED' end as status from facts
  union all select 2, 'plan', coalesce(facts.plan, '-'), 'INFO' from facts
  union all select 3, 'targets_not_regular', facts.not_regular::text, case when facts.not_regular = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 4, 'to_change', facts.to_change::text, 'INFO' from facts
  union all select 5, 'already_correct', facts.already_correct::text, 'INFO: não serão regravadas' from facts
  union all select 6, 'unexpected_values', coalesce(facts.unexpected, 'nenhum'), case when facts.unexpected is null then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 7, 'special_events_preserved', coalesce(facts.events, 'nenhum'), 'INFO: fora do plano' from facts
  union all select 8, 'other_experiences', coalesce(facts.other_experiences, 'nenhuma'), 'INFO: fora do plano' from facts
  union all select 9, 'other_experiences_fingerprint', facts.other_experiences_fingerprint, 'INFO: comparar no postcheck' from facts
  union all select 10, 'targets_other_columns_fingerprint', facts.targets_other_columns_fingerprint, 'INFO: comparar no postcheck' from facts
  union all select 11, 'functions_citing_default_capacity', coalesce(facts.functions_citing, 'nenhuma'), 'INFO: conferir se alguma cria sessão a partir dele' from facts
  union all select 12, 'triggers_citing_default_capacity', coalesce(facts.triggers_citing, 'nenhum'),
         case when facts.triggers_citing is null then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 13, 'views_citing_default_capacity', coalesce(facts.views_citing, 'nenhuma'), 'INFO' from facts
  union all select 14, 'sessions_capacity_column_default', coalesce(facts.sessions_capacity_default, 'sem default'), 'INFO: não depende da experiência' from facts
  union all select 15, 'sessions_fingerprint', facts.sessions_fingerprint, 'INFO: comparar no postcheck' from facts
  union all select 16, 'reservations_fingerprint', facts.reservations_fingerprint, 'INFO: muda com vendas do site' from facts
  union all select 17, 'sessions_total', facts.sessions_total::text, 'INFO' from facts
  union all select 18, 'reservations_total', facts.reservations_total::text, 'INFO' from facts
  union all select 19, 'READY_TO_UPDATE_REMAINING_DEFAULT_CAPACITY',
         coalesce(readiness.problems, format('pronto: %s a alterar, %s já corretas', facts.to_change, facts.already_correct)),
         case when readiness.problems is null then 'OK' else 'REVIEW_REQUIRED' end
  from facts, readiness
) checks
order by checks.ord;
