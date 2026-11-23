-- CAPACIDADE PADRÃO — QUATRO EXPERIÊNCIAS REGULARES RESTANTES — POSTCHECK (SOMENTE LEITURA)
--
-- Rodar logo depois de supabase/maintenance/experiences_default_capacity_restantes_2026.sql.
-- Um único SELECT. REMAINING_DEFAULT_CAPACITY_OK fica OK quando as quatro estão
-- com o novo padrão (Cápsula Bar 12, Lago Norte 24), cada experiência que mudou
-- tem uma linha de auditoria e nenhuma auditoria saiu do plano.
--
-- Comparar com o preflight rodado IMEDIATAMENTE antes da escrita:
--   * sessions_fingerprint                igual (nenhuma sessão mudou);
--   * other_experiences_fingerprint       igual (todas as outras experiências,
--                                          inclusive ESSÊNCIA e ESSÊNCIA Lua Cheia,
--                                          linha inteira);
--   * targets_other_columns_fingerprint   igual (nas quatro, só default_capacity mudou).
-- reservations_* podem mudar com vendas do site entre o preflight e o
-- postcheck; a manutenção conferiu reservas e pagamentos dentro da transação.

with wanted (base_slug, experience_slug, from_capacity, to_capacity) as (
  values
    ('concha-acustica', 'rota-prainha-do-congresso', 24, 12),
    ('concha-acustica', 'remada-lua-cheia-concha-acustica', 24, 12),
    ('concha-acustica', 'remada-nascer-do-sol-concha-acustica', 24, 12),
    ('lago-norte', 'remada-lua-cheia', 28, 24)
),
targets as (
  select w.*, e.id, e.default_capacity
  from wanted w
  join public.bases b on b.slug = w.base_slug
  join public.experiences e on e.slug = w.experience_slug and e.base_id = b.id
),
others as (
  select e.* from public.experiences e where not exists (select 1 from targets t where t.id = e.id)
),
facts as (
  select
    (select count(*) from targets) as found,
    (select count(*) from targets where default_capacity = to_capacity) as updated,
    (select string_agg(format('%s/%s: %s', t.base_slug, t.experience_slug, t.default_capacity), ' · ' order by t.base_slug, t.experience_slug)
     from targets t) as targets_now,
    (select string_agg(format('%s/%s: %s, padrão %s', b.slug, e.slug, e.status, e.default_capacity), ' · ' order by b.slug, e.slug)
     from public.experiences e join public.bases b on b.id = e.base_id where e.kind::text = 'EVENT') as events,
    (select count(*) from public.admin_audit_log a join targets t on t.id = a.entity_id
     where a.action = 'EXPERIENCE_UPDATED' and a.metadata ->> 'source' = 'experiences_default_capacity_restantes_2026') as audit_rows,
    (select count(distinct a.entity_id) from public.admin_audit_log a join targets t on t.id = a.entity_id
     where a.action = 'EXPERIENCE_UPDATED' and a.metadata ->> 'source' = 'experiences_default_capacity_restantes_2026') as audited_targets,
    (select count(*) from public.admin_audit_log a
     where a.action = 'EXPERIENCE_UPDATED' and a.metadata ->> 'source' = 'experiences_default_capacity_restantes_2026'
       and not exists (select 1 from targets t where t.id = a.entity_id)) as audit_outside_plan,
    (select md5(coalesce(string_agg((to_jsonb(e) - 'updated_at')::text, '|' order by e.id), '')) from others e) as other_experiences_fingerprint,
    (select md5(coalesce(string_agg((to_jsonb(e) - 'default_capacity' - 'updated_at')::text, '|' order by e.id), ''))
     from public.experiences e where exists (select 1 from targets t where t.id = e.id)) as targets_other_columns_fingerprint,
    (select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.sessions s) as sessions_fingerprint,
    (select count(*) from public.sessions) as sessions_total,
    (select count(*) from public.reservations) as reservations_total
),
ok as (
  select facts.found = 4 and facts.updated = 4 and facts.audit_rows = facts.audited_targets and facts.audit_outside_plan = 0 as value from facts
)
select checks.check_name, checks.result, checks.status
from (
  select 1 as ord, 'targets_updated' as check_name, format('%s de %s', facts.updated, facts.found) as result,
         case when facts.found = 4 and facts.updated = 4 then 'OK' else 'REVIEW_REQUIRED' end as status from facts
  union all select 2, 'targets_now', coalesce(facts.targets_now, '-'), 'INFO' from facts
  union all select 3, 'audit_rows', format('%s linha(s), %s experiência(s)', facts.audit_rows, facts.audited_targets),
         case when facts.audit_rows = facts.audited_targets then 'OK: uma por experiência alterada' else 'REVIEW_REQUIRED' end from facts
  union all select 4, 'audit_outside_plan', facts.audit_outside_plan::text, case when facts.audit_outside_plan = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 5, 'special_events_preserved', coalesce(facts.events, 'nenhum'), 'COMPARE_WITH_PREFLIGHT' from facts
  union all select 6, 'other_experiences_fingerprint', facts.other_experiences_fingerprint, 'COMPARE_WITH_PREFLIGHT' from facts
  union all select 7, 'targets_other_columns_fingerprint', facts.targets_other_columns_fingerprint, 'COMPARE_WITH_PREFLIGHT' from facts
  union all select 8, 'sessions_fingerprint', facts.sessions_fingerprint, 'COMPARE_WITH_PREFLIGHT' from facts
  union all select 9, 'sessions_total', facts.sessions_total::text, 'COMPARE_WITH_PREFLIGHT' from facts
  union all select 10, 'reservations_total', facts.reservations_total::text, 'INFO' from facts
  union all select 11, 'REMAINING_DEFAULT_CAPACITY_OK',
         case when ok.value then 'quatro padrões corretos (Cápsula Bar 12, Lago Norte 24), auditoria por experiência alterada' else 'conferir as linhas acima' end,
         case when ok.value then 'OK' else 'REVIEW_REQUIRED' end
  from facts, ok
) checks
order by checks.ord;
