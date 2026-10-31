-- EVENTOS ESPECIAIS — SEGURANÇA ANTES DA ABERTURA — POSTCHECK (SOMENTE LEITURA)
--
-- Rodar no SQL Editor DEPOIS de `202610310004_event_publication_security.sql`.
-- ASSINATURA_DAS_OUTRAS_FUNCOES, LISTAGENS_REGULARES, RESERVAS_POR_STATUS e
-- INSCRICOES_DA_LISTA_POR_STATUS precisam ser iguais às do preflight. A última
-- linha, EVENTOS_SEGURANCA_POSTCHECK_OK, precisa estar OK.

with expected(fn, norm) as (values
    ('list_public_experiences', '3786f5f8ffb2339ee7d6a423f70cef6b'),
    ('list_public_catalog', 'dbcb7ad4f15292962fe6e91333e36a1c'),
    ('get_public_experience', '394f35990fa1a7332b91f01cbd6d9ed3'),
    ('list_open_sessions', '702bd33f0815fca1072ce51a214b38fa'),
    ('list_public_sessions', '3d682f2102ae2f12d8296f3b06fe90cc'),
    ('public_session_context', '671ad7abc4083013402e2ba6aabad3db'),
    ('event_publication_allows', '0778dbe136124dea5c8833c470b3eaf2'),
    ('experience_row_is_public', 'd500cd71b10a2abe7d5ca16fb50cda94'),
    ('session_experience_is_public', '337ee44055490141f7d8f58ee7385c81'),
    ('enforce_event_publication_on_insert', 'dc4f904ce3c62093f814bbf262ed91a0')
),
prod as (
  select p.proname as fn, md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g')) as norm from pg_proc p where p.pronamespace = 'public'::regnamespace
),
ess as (
  select s.id from public.sessions s join public.experiences e on e.id = s.experience_id where e.slug = 'essencia'
),
checks as (
  select 'FUNCOES_COM_A_DEFINICAO_DO_REPOSITORIO' as check_name,
         (select count(*) filter (where pr.norm = e.norm)::text || ' de ' || count(*)::text from expected e left join prod pr on pr.fn = e.fn) as result,
         case when (select bool_and(pr.norm is not distinct from e.norm) from expected e left join prod pr on pr.fn = e.fn) then 'OK' else 'FALHOU' end as status
  union all
  select 'PERMISSOES_DAS_AUXILIARES',
         (select string_agg(p.proname || ': anon=' || has_function_privilege('anon', p.oid, 'execute')::text, ', ' order by p.proname) from pg_proc p
          where p.pronamespace = 'public'::regnamespace and p.proname in ('event_publication_allows', 'experience_row_is_public', 'session_experience_is_public', 'enforce_event_publication_on_insert')),
         case when not has_function_privilege('anon', 'public.event_publication_allows(text)', 'execute')
               and not has_function_privilege('anon', 'public.enforce_event_publication_on_insert()', 'execute')
               and has_function_privilege('anon', 'public.experience_row_is_public(text, text)', 'execute')
               and has_function_privilege('anon', 'public.session_experience_is_public(uuid)', 'execute') then 'OK' else 'FALHOU' end
  union all
  select 'CREATE_RESERVATION_FECHADA',
         coalesce((select 'anon=' || has_function_privilege('anon', p.oid, 'execute')::text || ', authenticated=' || has_function_privilege('authenticated', p.oid, 'execute')::text || ', service_role=' || has_function_privilege('service_role', p.oid, 'execute')::text from pg_proc p where p.oid = to_regprocedure('public.create_reservation(uuid, text, text, text, integer, text)')), 'não existe'),
         case when to_regprocedure('public.create_reservation(uuid, text, text, text, integer, text)') is null then 'OK'
              when not has_function_privilege('anon', to_regprocedure('public.create_reservation(uuid, text, text, text, integer, text)'), 'execute')
               and not has_function_privilege('authenticated', to_regprocedure('public.create_reservation(uuid, text, text, text, integer, text)'), 'execute')
               and not has_function_privilege('service_role', to_regprocedure('public.create_reservation(uuid, text, text, text, integer, text)'), 'execute') then 'OK' else 'FALHOU' end
  union all
  select 'POLITICAS_RESTRITIVAS',
         (select count(*)::text || ' de 2' from pg_policy where not polpermissive and polcmd = 'r' and polname in ('events hidden until published', 'event sessions hidden until published')),
         case when (select count(*) from pg_policy where not polpermissive and polcmd = 'r' and polname in ('events hidden until published', 'event sessions hidden until published')) = 2 then 'OK' else 'FALHOU' end
  union all
  select 'GATILHOS_DE_INSERCAO',
         (select count(*)::text || ' de 2' from pg_trigger where tgname in ('reservations_event_publication_guard', 'waitlist_entries_event_publication_guard') and tgenabled <> 'D' and (tgtype & 4) = 4 and (tgtype & 16) <> 16),
         case when (select count(*) from pg_trigger where tgname in ('reservations_event_publication_guard', 'waitlist_entries_event_publication_guard') and tgenabled <> 'D' and (tgtype & 4) = 4 and (tgtype & 16) <> 16) = 2 then 'OK' else 'FALHOU' end
  union all
  select 'ESSENCIA_NAS_LEITURAS_PUBLICAS',
         ((select count(*) from public.list_public_experiences() x where x.slug = 'essencia')
          + (select count(*) from public.list_public_catalog() x where x.slug = 'essencia')
          + (select count(*) from public.get_public_experience('essencia'))
          + (select count(*) from public.list_open_sessions('essencia'))
          + (select count(*) from public.list_public_sessions('essencia'))
          + (select count(*) from public.get_public_event('essencia'))
          + (select count(*) from public.list_public_event_sessions('essencia'))
          + coalesce((select count(*) from ess, lateral public.public_session_context(ess.id)), 0)
          + coalesce((select count(*) from ess, lateral public.get_booking_session(ess.id)), 0))::text || ' linha(s)',
         case when ((select count(*) from public.list_public_experiences() x where x.slug = 'essencia')
          + (select count(*) from public.list_public_catalog() x where x.slug = 'essencia')
          + (select count(*) from public.get_public_experience('essencia'))
          + (select count(*) from public.list_open_sessions('essencia'))
          + (select count(*) from public.list_public_sessions('essencia'))
          + (select count(*) from public.get_public_event('essencia'))
          + (select count(*) from public.list_public_event_sessions('essencia'))
          + coalesce((select count(*) from ess, lateral public.public_session_context(ess.id)), 0)
          + coalesce((select count(*) from ess, lateral public.get_booking_session(ess.id)), 0)) = 0 then 'OK' else 'FALHOU' end
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
select 'EVENTOS_SEGURANCA_POSTCHECK_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
