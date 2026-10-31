-- EVENTOS ESPECIAIS — SEGURANÇA ANTES DA ABERTURA — PREFLIGHT (SOMENTE LEITURA)
--
-- Rodar no SQL Editor ANTES de `202610310004_event_publication_security.sql`.
-- A última linha, EVENTOS_SEGURANCA_PREFLIGHT_OK, precisa estar OK. Guarde
-- ASSINATURA_DAS_OUTRAS_FUNCOES, LISTAGENS_REGULARES e as contagens.

with expected(fn, base_norm, new_norm) as (values
    ('list_public_experiences', 'd2b3705ca88ba207819c7b9bcb8a9dc3', '3786f5f8ffb2339ee7d6a423f70cef6b'),
    ('list_public_catalog', 'cf113f18eb4858716f4750965848666d', 'dbcb7ad4f15292962fe6e91333e36a1c'),
    ('get_public_experience', 'f65516fde0ea447d07e09dde5157b546', '394f35990fa1a7332b91f01cbd6d9ed3'),
    ('list_open_sessions', 'b0b535d34537c408588626ed14679c7e', '702bd33f0815fca1072ce51a214b38fa'),
    ('list_public_sessions', '400cad0c90e1fc8befb98048a604fbbe', '3d682f2102ae2f12d8296f3b06fe90cc'),
    ('public_session_context', '5dd4dc1dc5d1a5e6a7d1960cdf2d4739', '671ad7abc4083013402e2ba6aabad3db')
),
prod as (
  select p.proname as fn, md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g')) as norm, count(*) over (partition by p.proname) as overloads
  from pg_proc p where p.pronamespace = 'public'::regnamespace
),
functions as (
  select e.fn,
         case when pr.fn is null then 'AUSENTE'
              when pr.overloads > 1 then 'SOBRECARGA'
              when pr.norm = e.base_norm then 'CORPO_ATUAL'
              when pr.norm = e.new_norm then 'JA_COM_A_CONDICAO'
              else 'DIFERENTE' end as verdict
  from expected e left join prod pr on pr.fn = e.fn
),
new_names(name) as (values ('event_publication_allows'), ('experience_row_is_public'), ('session_experience_is_public'), ('enforce_event_publication_on_insert')),
checks as (
  select 'LEITURAS_ANTIGAS' as check_name,
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions) as result,
         case when exists (select 1 from functions where verdict in ('AUSENTE', 'SOBRECARGA', 'DIFERENTE')) then 'FALHOU'
              when exists (select 1 from functions where verdict = 'JA_COM_A_CONDICAO') then 'ATENCAO'
              else 'OK' end as status
  union all
  select 'OBJETOS_NOVOS_AINDA_AUSENTES',
         coalesce((select string_agg(name, ', ' order by name) from new_names where exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = name)), 'nenhum existe'),
         case when exists (select 1 from new_names where exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = name)) then 'ATENCAO' else 'OK' end
  union all
  select 'DEPENDENCIAS',
         'kind=' || exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'experiences' and column_name = 'kind')::text
           || ', is_active_admin=' || (to_regprocedure('public.is_active_admin(uuid)') is not null)::text
           || ', auth.uid=' || (to_regprocedure('auth.uid()') is not null)::text,
         case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'experiences' and column_name = 'kind')
               and to_regprocedure('public.is_active_admin(uuid)') is not null and to_regprocedure('auth.uid()') is not null then 'OK' else 'FALHOU' end
  union all
  select 'CREATE_RESERVATION',
         coalesce((select 'existe; anon=' || has_function_privilege('anon', p.oid, 'execute')::text || ', authenticated=' || has_function_privilege('authenticated', p.oid, 'execute')::text from pg_proc p where p.oid = to_regprocedure('public.create_reservation(uuid, text, text, text, integer, text)')), 'não existe'),
         'OK'
  union all
  select 'POLITICAS_DE_LEITURA',
         (select count(*)::text || ' em experiences e sessions' from pg_policy where polrelid in ('public.experiences'::regclass, 'public.sessions'::regclass)),
         'OK'
  union all
  select 'ASSINATURA_DAS_OUTRAS_FUNCOES',
         (select count(*)::text || ' funções, ' || md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), '|' order by p.oid::regprocedure::text))
          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not in ('list_public_experiences', 'list_public_catalog', 'get_public_experience', 'list_open_sessions', 'list_public_sessions', 'public_session_context', 'event_publication_allows', 'experience_row_is_public', 'session_experience_is_public', 'enforce_event_publication_on_insert')),
         'OK'
  union all
  select 'LISTAGENS_REGULARES',
         (select count(*)::text from public.list_public_regular_experiences()) || ' experiências, ' || (select count(*)::text from public.list_public_regular_catalog()) || ' no catálogo',
         'OK'
  union all
  select 'ESSENCIA_FECHADO',
         coalesce((select e.kind || '/' || e.status || ', active=' || coalesce(to_jsonb(e) ->> 'active', 'sem coluna') || ', sessão ' || coalesce((select string_agg(s.status::text, ',') from public.sessions s where s.experience_id = e.id), 'nenhuma') from public.experiences e where e.slug = 'essencia'), 'ausente'),
         case when (select e.status <> 'PUBLISHED' from public.experiences e where e.slug = 'essencia') is false then 'FALHOU'
              when exists (select 1 from public.sessions s join public.experiences e on e.id = s.experience_id where e.slug = 'essencia' and s.status = 'OPEN') then 'FALHOU'
              else 'OK' end
  union all
  select 'INTERRUPTOR_DESLIGADO',
         coalesce((select case when publication_enabled then 'ligado' else 'desligado' end from public.special_event_settings where singleton), 'ausente'),
         case when (select publication_enabled from public.special_event_settings where singleton) is false then 'OK' else 'FALHOU' end
  union all
  select 'RESERVAS_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.reservations group by 1) x),
         'OK'
  union all
  select 'INSCRICOES_DA_LISTA_POR_STATUS',
         coalesce((select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.waitlist_entries group by 1) x), 'nenhuma'),
         'OK'
)
select check_name, result, status from checks
union all
select 'EVENTOS_SEGURANCA_PREFLIGHT_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
