-- CAPACIDADE PADRÃO DAS EXPERIÊNCIAS REGULARES (LAGO NORTE 24, CÁPSULA BAR 12) — POSTCHECK (SOMENTE LEITURA)
--
-- Rodar logo depois de supabase/maintenance/experiences_default_capacity_2026.sql.
-- Um único SELECT. DEFAULT_CAPACITY_2026_OK fica OK quando as cinco
-- experiências do plano estão com o novo padrão e há uma linha de auditoria
-- por alteração. Comparar com o preflight rodado imediatamente antes:
--   * sessions_fingerprint igual ao do preflight (nenhuma sessão mudou);
--   * other_experiences igual a other_experiences_unchanged (ESSÊNCIA, Lua
--     Cheia e demais experiências fora do plano intactas).
--
-- Lembrete: default_capacity é só o campo "Capacidade padrão" do formulário de
-- experiência no painel; a capacidade de cada sessão é gravada na sessão.

with wanted (base_slug, experience_slug, new_capacity) as (
  values
    ('lago-norte', 'imersao-paranoa', 24),
    ('lago-norte', 'remada-nascer-do-sol', 24),
    ('lago-norte', 'remada-sunset', 24),
    ('concha-acustica', 'remada-sunset-concha-acustica', 12),
    ('concha-acustica', 'rota-ermida-ponte-jk', 12)
),
targets as (
  select w.*, e.id, e.kind::text as kind, e.default_capacity
  from wanted w
  join public.bases b on b.slug = w.base_slug
  join public.experiences e on e.slug = w.experience_slug and e.base_id = b.id
),
facts as (
  select
    (select count(*) from targets) as found,
    (select count(*) from targets where default_capacity = new_capacity) as updated,
    (select string_agg(format('%s/%s: %s', t.base_slug, t.experience_slug, t.default_capacity), ' · ' order by t.base_slug, t.experience_slug)
     from targets t) as targets_now,
    (select string_agg(format('%s/%s: %s/%s, padrão %s', b.slug, e.slug, e.kind, e.status, e.default_capacity), ' · ' order by b.slug, e.slug)
     from public.experiences e join public.bases b on b.id = e.base_id
     where not exists (select 1 from wanted w where w.experience_slug = e.slug and w.base_slug = b.slug)) as other_experiences,
    (select count(*) from public.admin_audit_log a join targets t on t.id = a.entity_id
     where a.action = 'EXPERIENCE_UPDATED' and a.metadata ->> 'source' = 'experiences_default_capacity_2026') as audit_rows,
    (select count(*) from public.admin_audit_log a
     where a.action = 'EXPERIENCE_UPDATED' and a.metadata ->> 'source' = 'experiences_default_capacity_2026'
       and not exists (select 1 from targets t where t.id = a.entity_id)) as audit_outside_plan,
    (select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.sessions s) as sessions_fingerprint,
    (select count(*) from public.sessions) as sessions_total,
    (select count(*) from public.reservations) as reservations_total
)
select checks.check_name, checks.result, checks.status
from (
  select 1 as ord, 'targets_updated' as check_name, format('%s de %s', facts.updated, facts.found) as result,
         case when facts.found = 5 and facts.updated = 5 then 'OK' else 'REVIEW_REQUIRED' end as status from facts
  union all select 2, 'targets_now', coalesce(facts.targets_now, '-'), 'INFO' from facts
  union all select 3, 'other_experiences', coalesce(facts.other_experiences, 'nenhuma'), 'COMPARE_WITH_PREFLIGHT (other_experiences_unchanged)' from facts
  union all select 4, 'audit_rows', facts.audit_rows::text, case when facts.audit_rows = 5 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 5, 'audit_outside_plan', facts.audit_outside_plan::text, case when facts.audit_outside_plan = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 6, 'sessions_fingerprint', facts.sessions_fingerprint, 'COMPARE_WITH_PREFLIGHT' from facts
  union all select 7, 'sessions_total', facts.sessions_total::text, 'INFO' from facts
  union all select 8, 'reservations_total', facts.reservations_total::text, 'INFO' from facts
  union all select 9, 'DEFAULT_CAPACITY_2026_OK',
         case when facts.found = 5 and facts.updated = 5 and facts.audit_rows = 5 and facts.audit_outside_plan = 0
              then 'cinco padrões atualizados (Lago Norte 24, Cápsula Bar 12) com auditoria' else 'conferir as linhas acima' end,
         case when facts.found = 5 and facts.updated = 5 and facts.audit_rows = 5 and facts.audit_outside_plan = 0
              then 'OK' else 'REVIEW_REQUIRED' end
  from facts
) checks
order by checks.ord;
