-- EXPERIÊNCIAS — COLUNAS LEGADAS NA CRIAÇÃO — POSTCHECK (SOMENTE LEITURA)
--
-- Rodar no SQL Editor DEPOIS de `202610310002_experiences_legacy_columns_on_insert.sql`.
-- ASSINATURA_DAS_FUNCOES, EXPERIENCIAS_POR_TIPO_E_STATUS e RESERVAS_POR_STATUS
-- precisam ser iguais às do preflight. A última linha,
-- EXPERIENCIAS_LEGADO_POSTCHECK_OK, precisa estar OK.

with fn as (
  select p.oid, md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g')) as norm, p.prosecdef
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'experiences_fill_legacy_columns'
),
tg as (
  select t.tgenabled, (t.tgtype & 2) = 2 as before, (t.tgtype & 4) = 4 as on_insert, (t.tgtype & 1) = 1 as for_row, (t.tgtype & 16) = 16 as on_update
  from pg_trigger t where t.tgrelid = 'public.experiences'::regclass and t.tgname = 'experiences_fill_legacy_columns'
),
checks as (
  select 'FUNCAO_COM_A_DEFINICAO_DO_REPOSITORIO' as check_name,
         coalesce((select case when norm = '3addab19a00f3797b9551476d30149a3' then 'idêntica' else 'diferente' end from fn), 'ausente') as result,
         case when (select norm = '3addab19a00f3797b9551476d30149a3' from fn) then 'OK' else 'FALHOU' end as status
  union all
  select 'FUNCAO_FECHADA_PARA_A_API',
         coalesce((select 'anon=' || has_function_privilege('anon', oid, 'execute')::text || ', authenticated=' || has_function_privilege('authenticated', oid, 'execute')::text
                          || ', service_role=' || has_function_privilege('service_role', oid, 'execute')::text from fn), 'ausente'),
         case when (select not has_function_privilege('anon', oid, 'execute') and not has_function_privilege('authenticated', oid, 'execute')
                           and not has_function_privilege('service_role', oid, 'execute') and not prosecdef from fn) then 'OK' else 'FALHOU' end
  union all
  select 'GATILHO_ANTES_DE_INSERIR',
         coalesce((select 'ativo=' || (tgenabled <> 'D')::text || ', before=' || before::text || ', insert=' || on_insert::text || ', update=' || on_update::text || ', por linha=' || for_row::text from tg), 'ausente'),
         case when (select tgenabled <> 'D' and before and on_insert and for_row and not on_update from tg) then 'OK' else 'FALHOU' end
  union all
  select 'GATILHOS_DE_EXPERIENCES',
         coalesce((select string_agg(tgname, ', ' order by tgname) from pg_trigger where tgrelid = 'public.experiences'::regclass and not tgisinternal), 'nenhum'),
         'OK'
  union all
  select 'ASSINATURA_DAS_FUNCOES',
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
select 'EXPERIENCIAS_LEGADO_POSTCHECK_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
