-- EXPERIÊNCIAS — ACTIVE NA CRIAÇÃO — POSTCHECK (SOMENTE LEITURA)
--
-- Rodar no SQL Editor DEPOIS de `202610310003_experiences_active_on_insert.sql`.
-- ASSINATURA_DAS_OUTRAS_FUNCOES, LINHAS_ATIVAS_FORA_DE_PUBLICADO,
-- EXPERIENCIAS_POR_TIPO_E_STATUS e RESERVAS_POR_STATUS precisam ser iguais às do
-- preflight. A última linha, EXPERIENCIAS_ACTIVE_POSTCHECK_OK, precisa estar OK.

with checks as (
  select 'FUNCAO_COM_A_REGRA_DO_ACTIVE' as check_name,
         case (select md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g')) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'experiences_fill_legacy_columns') when '4ee78d0a6fcbc88ca58c7c22875152f5' then 'idêntica ao repositório' else 'diferente ou ausente' end as result,
         case (select md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g')) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'experiences_fill_legacy_columns') when '4ee78d0a6fcbc88ca58c7c22875152f5' then 'OK' else 'FALHOU' end as status
  union all
  select 'FUNCAO_FECHADA_PARA_A_API',
         coalesce((select 'anon=' || has_function_privilege('anon', p.oid, 'execute')::text || ', authenticated=' || has_function_privilege('authenticated', p.oid, 'execute')::text
                          || ', service_role=' || has_function_privilege('service_role', p.oid, 'execute')::text
                   from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'experiences_fill_legacy_columns'), 'ausente'),
         case when (select not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')
                           and not has_function_privilege('service_role', p.oid, 'execute') and not p.prosecdef
                    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'experiences_fill_legacy_columns') then 'OK' else 'FALHOU' end
  union all
  select 'GATILHO_SO_EM_INSERT',
         coalesce((select 'ativo=' || (t.tgenabled <> 'D')::text || ', before=' || ((t.tgtype & 2) = 2)::text || ', insert=' || ((t.tgtype & 4) = 4)::text || ', update=' || ((t.tgtype & 16) = 16)::text
                   from pg_trigger t where t.tgrelid = 'public.experiences'::regclass and t.tgname = 'experiences_fill_legacy_columns'), 'ausente'),
         case when (select t.tgenabled <> 'D' and (t.tgtype & 2) = 2 and (t.tgtype & 4) = 4 and (t.tgtype & 16) <> 16
                    from pg_trigger t where t.tgrelid = 'public.experiences'::regclass and t.tgname = 'experiences_fill_legacy_columns') then 'OK' else 'FALHOU' end
  union all
  select 'COLUNA_ACTIVE',
         coalesce((select data_type || ', nula=' || is_nullable || ', padrão=' || coalesce(column_default, '(sem padrão)') from information_schema.columns
                   where table_schema = 'public' and table_name = 'experiences' and column_name = 'active'), 'ausente'),
         'OK'
  union all
  select 'LINHAS_ATIVAS_FORA_DE_PUBLICADO',
         (select count(*)::text from public.experiences e where to_jsonb(e) ->> 'active' = 'true' and e.status <> 'PUBLISHED'),
         'OK'
  union all
  select 'ASSINATURA_DAS_OUTRAS_FUNCOES',
         (select count(*)::text || ' funções, ' || md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), '|' order by p.oid::regprocedure::text))
          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname <> 'experiences_fill_legacy_columns'),
         'OK'
  union all
  select 'EXPERIENCIAS_POR_TIPO_E_STATUS',
         (select string_agg(kind || '/' || status || '=' || n, ', ' order by kind, status) from (select kind, status, count(*) n from public.experiences group by 1, 2) x),
         'OK'
  union all
  select 'ESSENCIA_AUSENTE',
         case when exists (select 1 from public.experiences where slug = 'essencia') then 'existe' else 'ausente' end,
         case when exists (select 1 from public.experiences where slug = 'essencia') then 'FALHOU' else 'OK' end
  union all
  select 'RESERVAS_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.reservations group by 1) x),
         'OK'
)
select check_name, result, status from checks
union all
select 'EXPERIENCIAS_ACTIVE_POSTCHECK_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
