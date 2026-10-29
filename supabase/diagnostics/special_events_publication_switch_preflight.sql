-- EVENTOS ESPECIAIS — INTERRUPTOR DE PUBLICAÇÃO NAS LEITURAS — PREFLIGHT (SOMENTE LEITURA)
--
-- Rodar no SQL Editor ANTES de `202610310001_special_events_publication_switch.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita e
-- nenhum dado pessoal retornado.
--
--   OK       — pode seguir.
--   ATENCAO  — não bloqueia, mas precisa ser lido antes de seguir.
--   FALHOU   — interrompe: a migration não deve ser aplicada.
--
-- A linha final, EVENTOS_INTERRUPTOR_PREFLIGHT_OK, fica OK quando nenhuma linha
-- FALHOU. Guarde ASSINATURA_DAS_OUTRAS_FUNCOES e as contagens.
--
-- As duas leituras que a migration substitui precisam estar com o corpo da
-- fundação (`202610280001`); diferente é FALHOU (alguém mudou à mão). Já com o
-- corpo novo é ATENCAO (a migration já foi aplicada; reaplicar não muda nada).

with expected(fn, base_norm, new_norm) as (values
    ('list_public_events', '86c05a288e248432db8ae197cdf14398', '0d5c8f35015313a584be028f011a3ab2'),
    ('list_public_event_sessions', '92b291f3584d1180a68320baf2986980', 'c9d622f9bdb105596da4cc7710684ac4'),
    ('get_public_event', '28c7a2f88cfce59ae009c8b3abfd68dd', '28c7a2f88cfce59ae009c8b3abfd68dd')
),
prod as (
  select p.proname as fn, md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g')) as norm, count(*) over (partition by p.proname) as overloads
  from pg_proc p where p.pronamespace = 'public'::regnamespace
),
functions as (
  select e.fn,
         case when pr.fn is null then 'AUSENTE'
              when pr.overloads > 1 then 'SOBRECARGA'
              when pr.norm = e.base_norm and e.base_norm = e.new_norm then 'IGUAL (NAO MUDA)'
              when pr.norm = e.base_norm then 'CORPO_DA_FUNDACAO'
              when pr.norm = e.new_norm then 'JA_COM_O_INTERRUPTOR'
              else 'DIFERENTE' end as verdict
  from expected e left join prod pr on pr.fn = e.fn
),
changed(name) as (values ('list_public_events'), ('list_public_event_sessions')),
checks as (
  select 'LEITURAS_DE_EVENTOS' as check_name,
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions) as result,
         case when exists (select 1 from functions where verdict in ('AUSENTE', 'SOBRECARGA', 'DIFERENTE')) then 'FALHOU'
              when exists (select 1 from functions where verdict = 'JA_COM_O_INTERRUPTOR') then 'ATENCAO'
              else 'OK' end as status
  union all
  select 'INTERRUPTOR_EXISTE',
         coalesce((select case when publication_enabled then 'ligado' else 'desligado' end from public.special_event_settings where singleton), 'ausente'),
         case when exists (select 1 from public.special_event_settings where singleton) then 'OK' else 'FALHOU' end
  union all
  select 'EVENTOS_POR_STATUS',
         coalesce((select string_agg(status::text || '=' || n, ', ' order by status::text) from (select status, count(*) n from public.experiences where kind = 'EVENT' group by 1) x), 'nenhum'),
         'OK'
  union all
  select 'EVENTOS_NAS_LEITURAS_PUBLICAS',
         (select count(*)::text from public.list_public_events()),
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
select 'EVENTOS_INTERRUPTOR_PREFLIGHT_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
