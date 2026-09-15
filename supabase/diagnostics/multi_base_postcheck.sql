-- MULTI-BASE — POSTCHECK RESUMIDO (SOMENTE LEITURA)
--
-- Rodar no SQL Editor depois de aplicar 202609150001_multi_base.sql.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita,
-- nenhuma função nova e nenhum dado pessoal retornado.
--
-- A linha final, MULTI_BASE_OK, só fica OK quando todas as outras estão OK.

with checks as (
  select 'BASES_VISIVEIS' as check_name,
         (select string_agg(slug || ':' || status, ', ' order by display_order) from public.bases) as result,
         (select count(*) = 2
            and bool_or(slug = 'lago-norte' and status = 'ACTIVE')
            and bool_or(slug = 'concha-acustica' and status = 'COMING_SOON')
          from public.bases) as ok
  union all
  select 'EXPERIENCIAS_SEM_BASE',
         (select count(*)::text from public.experiences where base_id is null),
         (select count(*) = 0 from public.experiences where base_id is null)
  union all
  select 'RESERVAS_FORA_DO_LAGO_NORTE',
         (select count(*)::text from public.reservations r
            join public.experiences e on e.id = r.experience_id
            join public.bases b on b.id = e.base_id
           where b.slug <> 'lago-norte'),
         (select count(*) = 0 from public.reservations r
            join public.experiences e on e.id = r.experience_id
            join public.bases b on b.id = e.base_id
           where b.slug <> 'lago-norte')
  union all
  select 'IMERSAO_EXCLUSIVA_LAGO_NORTE',
         (select b.slug || ' / exclusiva=' || e.is_exclusive from public.experiences e join public.bases b on b.id = e.base_id where e.slug = 'imersao-paranoa'),
         (select coalesce(bool_and(b.slug = 'lago-norte' and e.is_exclusive), false) from public.experiences e join public.bases b on b.id = e.base_id where e.slug = 'imersao-paranoa')
  union all
  select 'CONCHA_EXPERIENCIAS_EM_BREVE',
         (select string_agg(e.title || ':' || e.status, ', ' order by e.display_order) from public.experiences e join public.bases b on b.id = e.base_id where b.slug = 'concha-acustica'),
         (select count(*) = 4 and bool_and(e.status = 'COMING_SOON') from public.experiences e join public.bases b on b.id = e.base_id where b.slug = 'concha-acustica')
  union all
  select 'CONCHA_SEM_SESSOES',
         (select count(*)::text from public.sessions s join public.experiences e on e.id = s.experience_id join public.bases b on b.id = e.base_id where b.slug = 'concha-acustica'),
         (select count(*) = 0 from public.sessions s join public.experiences e on e.id = s.experience_id join public.bases b on b.id = e.base_id where b.slug = 'concha-acustica')
  union all
  select 'PUBLICADAS_SO_EM_BASE_ATIVA',
         (select count(*)::text from public.experiences e join public.bases b on b.id = e.base_id where e.status = 'PUBLISHED' and b.status <> 'ACTIVE'),
         (select count(*) = 0 from public.experiences e join public.bases b on b.id = e.base_id where e.status = 'PUBLISHED' and b.status <> 'ACTIVE')
  union all
  select 'RPCS_PUBLICAS',
         concat_ws(', ',
           case when to_regprocedure('public.list_public_bases()') is not null then 'list_public_bases' end,
           case when to_regprocedure('public.list_public_catalog()') is not null then 'list_public_catalog' end,
           case when to_regprocedure('public.public_session_context(uuid)') is not null then 'public_session_context' end,
           case when to_regprocedure('public.admin_base_dashboard_metrics(uuid, uuid)') is not null then 'admin_base_dashboard_metrics' end),
         to_regprocedure('public.list_public_bases()') is not null
           and to_regprocedure('public.list_public_catalog()') is not null
           and to_regprocedure('public.public_session_context(uuid)') is not null
           and to_regprocedure('public.admin_base_dashboard_metrics(uuid, uuid)') is not null
  union all
  select 'TRIGGERS_DE_BASE',
         (select string_agg(tgname, ', ' order by tgname) from pg_trigger where not tgisinternal and tgname in ('experiences_modality_default', 'experiences_base_requires_active', 'bases_status_guard', 'sessions_base_requires_active')),
         (select count(*) = 4 from pg_trigger where not tgisinternal and tgname in ('experiences_modality_default', 'experiences_base_requires_active', 'bases_status_guard', 'sessions_base_requires_active'))
)
select check_name, result, case when ok then 'OK' else 'VERIFICAR' end as status from checks
union all
select 'MULTI_BASE_OK',
       (select count(*) filter (where not ok)::text || ' verificação(ões) pendente(s)' from checks),
       case when (select bool_and(ok) from checks) then 'OK' else 'VERIFICAR' end;
