-- BASE LAGO NORTE — ENDEREÇO COMPLETO E LINK OFICIAL DO GOOGLE MAPS — PREFLIGHT (SOMENTE LEITURA)
--
-- Antes de supabase/maintenance/lago_norte_localizacao_2026_11.sql. Um único
-- SELECT, sem escrita. LAGO_NORTE_LOCALIZACAO_PRONTO fica OK quando a base
-- existe uma única vez, está ACTIVE, com o endereço de origem (ou já o novo),
-- link nulo (ou já o novo), sem ponto de encontro, e a regra de HTTPS de
-- maps_url existe. other_columns_fingerprint deve se repetir no postcheck.

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
    exists (
      select 1 from pg_constraint
      where conrelid = 'public.bases'::regclass and conname = 'bases_maps_url_https'
    ) as https_rule,
    (select count(*) from public.bases) as total_bases
), verdict as (
  select facts.*,
    facts.address in ('QL 5 Conjunto 5 - Lago Norte', 'SHIN QL 5, Conjunto 5, Casa 19 — Lago Norte, Brasília-DF') as address_ok,
    (facts.maps_url is null or facts.maps_url = 'https://maps.app.goo.gl/KQUaHE4LGmg8h3q17') as maps_ok
  from facts
)
select checks.check_name, checks.value, checks.status
from (
  select 1 as ord, 'base_rows' as check_name, verdict.base_rows::text as value,
         case when verdict.base_rows = 1 then 'OK' else 'BLOCKED' end as status from verdict
  union all select 2, 'status', coalesce(verdict.status, '(nulo)'),
         case when verdict.status = 'ACTIVE' then 'OK' else 'BLOCKED' end from verdict
  union all select 3, 'address', coalesce(verdict.address, '(nulo)'),
         case when verdict.address_ok then 'OK' else 'BLOCKED' end from verdict
  union all select 4, 'maps_url', coalesce(verdict.maps_url, '(nulo)'),
         case when verdict.maps_ok then 'OK' else 'BLOCKED' end from verdict
  union all select 5, 'meeting_point', coalesce(verdict.meeting_point, '(nulo)'),
         case when verdict.meeting_point is null then 'OK' else 'REVIEW_REQUIRED' end from verdict
  union all select 6, 'bases_maps_url_https', verdict.https_rule::text,
         case when verdict.https_rule then 'OK' else 'BLOCKED' end from verdict
  union all select 7, 'total_bases', verdict.total_bases::text, 'INFO' from verdict
  union all select 8, 'other_columns_fingerprint', coalesce(verdict.other_columns_fingerprint, '(sem base)'), 'COMPARE_WITH_POSTCHECK' from verdict
  union all select 9, 'LAGO_NORTE_LOCALIZACAO_PRONTO',
         case when verdict.base_rows = 1 and verdict.status = 'ACTIVE' and verdict.address_ok and verdict.maps_ok and verdict.https_rule
              then 'pode aplicar' else 'conferir as linhas acima' end,
         case when verdict.base_rows = 1 and verdict.status = 'ACTIVE' and verdict.address_ok and verdict.maps_ok and verdict.https_rule
              then 'OK' else 'BLOCKED' end
  from verdict
) checks
order by checks.ord;
