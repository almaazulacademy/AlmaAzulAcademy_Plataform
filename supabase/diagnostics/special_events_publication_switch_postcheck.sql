-- EVENTOS ESPECIAIS — INTERRUPTOR DE PUBLICAÇÃO NAS LEITURAS — POSTCHECK (SOMENTE LEITURA)
--
-- Rodar no SQL Editor DEPOIS de `202610310001_special_events_publication_switch.sql`.
-- Mesmo formato do preflight. ASSINATURA_DAS_OUTRAS_FUNCOES, LISTAGENS_REGULARES,
-- EVENTOS_POR_STATUS e RESERVAS_POR_STATUS precisam ser iguais às do preflight.
-- A linha final, EVENTOS_INTERRUPTOR_POSTCHECK_OK, fica OK quando nenhuma linha FALHOU.

with expected(fn, norm) as (values
    ('list_public_events', '0d5c8f35015313a584be028f011a3ab2'),
    ('list_public_event_sessions', 'c9d622f9bdb105596da4cc7710684ac4'),
    ('get_public_event', '28c7a2f88cfce59ae009c8b3abfd68dd')
),
prod as (
  select p.proname as fn, md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g')) as norm, p.oid, p.prosecdef
  from pg_proc p where p.pronamespace = 'public'::regnamespace
),
changed(name) as (values ('list_public_events'), ('list_public_event_sessions')),
checks as (
  select 'LEITURAS_COM_A_DEFINICAO_DO_REPOSITORIO' as check_name,
         (select count(*) filter (where pr.norm = e.norm)::text || ' de ' || count(*)::text from expected e left join prod pr on pr.fn = e.fn) as result,
         case when (select bool_and(pr.norm = e.norm) from expected e left join prod pr on pr.fn = e.fn) then 'OK' else 'FALHOU' end as status
  union all
  select 'PERMISSOES_IGUAIS',
         (select string_agg(pr.fn || ': anon=' || has_function_privilege('anon', pr.oid, 'execute')::text || ', definer=' || pr.prosecdef::text, '; ' order by pr.fn) from prod pr where pr.fn in (select fn from expected)),
         case when (select bool_and(has_function_privilege('anon', pr.oid, 'execute') and has_function_privilege('authenticated', pr.oid, 'execute') and has_function_privilege('service_role', pr.oid, 'execute') and pr.prosecdef)
                    from prod pr where pr.fn in (select fn from expected)) then 'OK' else 'FALHOU' end
  union all
  select 'INTERRUPTOR_EXISTE',
         coalesce((select case when publication_enabled then 'ligado' else 'desligado' end from public.special_event_settings where singleton), 'ausente'),
         case when exists (select 1 from public.special_event_settings where singleton) then 'OK' else 'FALHOU' end
  union all
  select 'INTERRUPTOR_RESPEITADO',
         (select count(*)::text from public.list_public_events()) || ' evento(s) visível(is) com o interruptor ' || coalesce((select case when publication_enabled then 'ligado' else 'desligado' end from public.special_event_settings where singleton), 'ausente'),
         case when coalesce((select publication_enabled from public.special_event_settings where singleton), false) or not exists (select 1 from public.list_public_events()) then 'OK' else 'FALHOU' end
  union all
  select 'EVENTOS_POR_STATUS',
         coalesce((select string_agg(status::text || '=' || n, ', ' order by status::text) from (select status, count(*) n from public.experiences where kind = 'EVENT' group by 1) x), 'nenhum'),
         'OK'
  union all
  select 'LISTAGENS_REGULARES',
         (select count(*)::text from public.list_public_regular_experiences()) || ' experiências, ' || (select count(*)::text from public.list_public_regular_catalog()) || ' no catálogo',
         'OK'
  union all
  select 'ASSINATURA_DAS_OUTRAS_FUNCOES',
         (select count(*)::text || ' funções, ' || md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), '|' order by p.oid::regprocedure::text))
          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not in (select name from changed)),
         'OK'
  union all
  select 'RESERVAS_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.reservations group by 1) x),
         'OK'
)
select check_name, result, status from checks
union all
select 'EVENTOS_INTERRUPTOR_POSTCHECK_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
