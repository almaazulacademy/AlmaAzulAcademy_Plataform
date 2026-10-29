-- EVENTOS ESPECIAIS, ETAPA 5C-2 (LISTA DE ESPERA POR TIPO) — PREFLIGHT (SOMENTE LEITURA)
--
-- Rodar no SQL Editor ANTES de `202610300001_waitlist_event_scope.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita e
-- nenhum dado pessoal retornado.
--
--   OK       — pode seguir.
--   ATENCAO  — não bloqueia, mas precisa ser lido antes de seguir.
--   FALHOU   — interrompe: a migration não deve ser aplicada.
--
-- A linha final, WAITLIST_EVENTOS_PREFLIGHT_OK, fica OK quando nenhuma linha
-- FALHOU. Guarde ASSINATURA_DAS_FUNCOES_EXISTENTES e as contagens.
--
-- As duas funções novas chamam, sem mudar, `waitlist_cancel_overview`,
-- `waitlist_token_hash` e `waitlist_spot_take`. Conteúdo diferente do
-- repositório em qualquer uma delas é FALHOU.

with expected(fn, exact, norm) as (values
    ('waitlist_cancel_overview', 'a8e4b1147a92e887184766580646ebb2', '81da55b0720abfbf238f04a82d77fddf'),
    ('waitlist_spot_take', '7a5a1d4cc7a3986f8f1e2bcac54f8977', 'e684e4896c0f89f78fe8435cf0fea8a2'),
    ('waitlist_token_hash', 'b15727ae29d8a05a98e0965ac46b8ce2', 'b444586b18a43fe6dbad25288978eb98')
),
prod as (
  select p.proname as fn,
         md5(p.prosrc) as exact,
         md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g')) as norm,
         count(*) over (partition by p.proname) as overloads
  from pg_proc p where p.pronamespace = 'public'::regnamespace
),
functions as (
  select e.fn,
         case when pr.fn is null then 'AUSENTE'
              when pr.overloads > 1 then 'SOBRECARGA'
              when pr.exact = e.exact then 'IDENTICA'
              when pr.norm = e.norm then 'IDENTICA_SO_FORMATACAO'
              else 'DIFERENTE' end as verdict
  from expected e left join prod pr on pr.fn = e.fn
),
new_names(name) as (values ('waitlist_cancel_overview_with_kind'), ('claim_pending_waitlist_spot_emails_by_kind')),
present as (
  select name from new_names where exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = new_names.name)
),
checks as (
  select 'FUNCOES_REAPROVEITADAS' as check_name,
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions) as result,
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from functions) then 'OK' else 'FALHOU' end as status
  union all
  select 'TIPO_DA_EXPERIENCIA_EXISTE',
         'experiences.kind=' || exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'experiences' and column_name = 'kind')::text,
         case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'experiences' and column_name = 'kind') then 'OK' else 'FALHOU' end
  union all
  select 'OBJETOS_NOVOS_AINDA_AUSENTES',
         coalesce((select string_agg(name, ', ' order by name) from present), 'nenhum existe'),
         case when exists (select 1 from present) then 'ATENCAO' else 'OK' end
  union all
  select 'ASSINATURA_DAS_FUNCOES_EXISTENTES',
         (select count(*)::text || ' funções, ' || md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), '|' order by p.oid::regprocedure::text))
          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not in (select name from new_names)),
         'OK'
  union all
  select 'INSCRICOES_POR_TIPO_E_STATUS',
         coalesce((select string_agg(kind || '/' || status || '=' || n, ', ' order by kind, status) from (
           select e.kind, we.status, count(*) n from public.waitlist_entries we join public.sessions s on s.id = we.session_id join public.experiences e on e.id = s.experience_id group by 1, 2) x), 'nenhuma'),
         'OK'
  union all
  select 'FILA_DA_LISTA_POR_STATUS',
         coalesce((select string_agg(kind || '/' || status || '=' || n, ', ' order by kind, status) from (select kind, status, count(*) n from public.waitlist_notifications group by 1, 2) x), 'vazia'),
         'OK'
  union all
  select 'RESERVAS_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.reservations group by 1) x),
         'OK'
)
select check_name, result, status from checks
union all
select 'WAITLIST_EVENTOS_PREFLIGHT_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
