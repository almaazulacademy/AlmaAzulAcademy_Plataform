-- BASE LAGO NORTE — ENDEREÇO COMPLETO E LINK OFICIAL DO GOOGLE MAPS — POSTCHECK (SOMENTE LEITURA)
--
-- Depois de supabase/maintenance/lago_norte_localizacao_2026_11.sql. Um único
-- SELECT. LAGO_NORTE_LOCALIZACAO_OK fica OK quando endereço e link estão com
-- os valores novos, o status continua ACTIVE, o ponto de encontro continua
-- nulo, a auditoria foi gravada e o Cápsula Bar não mudou.
-- other_columns_fingerprint deve ser igual ao do preflight.

with lago as (
  select b.* from public.bases b where b.slug = 'lago-norte'
), facts as (
  select
    (select count(*) from lago) as base_rows,
    (select status from lago) as status,
    (select address from lago) as address,
    (select meeting_point from lago) as meeting_point,
    (select maps_url from lago) as maps_url,
    (select md5((to_jsonb(l) - 'address' - 'maps_url' - 'updated_at')::text) from lago l) as other_columns_fingerprint,
    (select count(*) from public.admin_audit_log a
      where a.action = 'BASE_UPDATED' and a.entity_type = 'base'
        and a.entity_id = (select id from lago)
        and a.metadata ->> 'source' = 'lago_norte_localizacao_2026_11') as audit_rows,
    (select address = 'SHTN Trecho 1, Lote 8 — Brasília/DF'
            and meeting_point = 'Em frente ao Cápsula Bar — Concha Acústica'
            and maps_url = 'https://maps.app.goo.gl/ueSCiLvHAggrzuAX7'
       from public.bases where slug = 'concha-acustica') as capsula_unchanged
), verdict as (
  select facts.*,
    facts.address = 'SHIN QL 5, Conjunto 5, Casa 19 — Lago Norte, Brasília-DF' as address_ok,
    facts.maps_url = 'https://maps.app.goo.gl/KQUaHE4LGmg8h3q17' as maps_ok
  from facts
)
select checks.check_name, checks.value, checks.status
from (
  select 1 as ord, 'base_rows' as check_name, verdict.base_rows::text as value,
         case when verdict.base_rows = 1 then 'OK' else 'REVIEW_REQUIRED' end as status from verdict
  union all select 2, 'address', coalesce(verdict.address, '(nulo)'),
         case when verdict.address_ok then 'OK' else 'REVIEW_REQUIRED' end from verdict
  union all select 3, 'maps_url', coalesce(verdict.maps_url, '(nulo)'),
         case when verdict.maps_ok then 'OK' else 'REVIEW_REQUIRED' end from verdict
  union all select 4, 'status', coalesce(verdict.status, '(nulo)'),
         case when verdict.status = 'ACTIVE' then 'OK' else 'REVIEW_REQUIRED' end from verdict
  union all select 5, 'meeting_point', coalesce(verdict.meeting_point, '(nulo)'),
         case when verdict.meeting_point is null then 'OK' else 'REVIEW_REQUIRED' end from verdict
  union all select 6, 'audit_rows', verdict.audit_rows::text,
         case when verdict.audit_rows >= 1 then 'OK' else 'REVIEW_REQUIRED' end from verdict
  union all select 7, 'capsula_bar_unchanged', coalesce(verdict.capsula_unchanged::text, '(sem base)'),
         case when verdict.capsula_unchanged then 'OK' else 'REVIEW_REQUIRED' end from verdict
  union all select 8, 'other_columns_fingerprint', coalesce(verdict.other_columns_fingerprint, '(sem base)'), 'COMPARE_WITH_PREFLIGHT' from verdict
  union all select 9, 'LAGO_NORTE_LOCALIZACAO_OK',
         case when verdict.base_rows = 1 and verdict.address_ok and verdict.maps_ok and verdict.status = 'ACTIVE'
                   and verdict.meeting_point is null and verdict.audit_rows >= 1 and verdict.capsula_unchanged
              then 'endereço e link oficial aplicados' else 'conferir as linhas acima' end,
         case when verdict.base_rows = 1 and verdict.address_ok and verdict.maps_ok and verdict.status = 'ACTIVE'
                   and verdict.meeting_point is null and verdict.audit_rows >= 1 and verdict.capsula_unchanged
              then 'OK' else 'REVIEW_REQUIRED' end
  from verdict
) checks
order by checks.ord;
