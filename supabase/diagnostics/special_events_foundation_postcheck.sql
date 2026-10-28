-- EVENTOS ESPECIAIS, FASE 2 (FUNDAÇÃO NO BANCO) — POSTCHECK (SOMENTE LEITURA)
--
-- Rodar no SQL Editor DEPOIS de `202610280001_special_events_foundation.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita e
-- nenhum dado pessoal retornado.
--
--   OK       — como esperado.
--   ATENCAO  — não é falha da migration, mas precisa ser lido (por exemplo, o
--              interruptor da publicação já ligado, ou eventos já cadastrados).
--   FALHOU   — a migration não ficou como o repositório define: não siga.
--
-- A linha final, EVENTOS_POSTCHECK_OK, fica OK quando nenhuma linha FALHOU.
-- ASSINATURA_DAS_FUNCOES_EXISTENTES e as contagens por status precisam ser
-- iguais às do preflight.

with expected(sig, kind, exact, norm) as (values
    ('public.enforce_experience_kind_rules()', 'TRIGGER', '9844b6434a06bf66e5e947ed1e62ff5c', 'd66187c700afe02368d4beb7a6466061'),
    ('public.enforce_reservation_event_kind()', 'TRIGGER', '5e2d59b4d0fb5503902cfc58160bdc5f', 'c786a32880d96bd12cf6f5b87ab47312'),
    ('public.special_event_availability(uuid)', 'INTERNA', '20c17e14aaf600538a1ac9b19f524a33', 'f0a7b45bcacdbfb1daf16dceb184aadd'),
    ('public.list_public_events()', 'PUBLICA', 'cd931ef855dd9e0a51424652341130ca', '86c05a288e248432db8ae197cdf14398'),
    ('public.get_public_event(text)', 'PUBLICA', 'cd9d2a7299f63476b1d60389824c6f0c', '28c7a2f88cfce59ae009c8b3abfd68dd'),
    ('public.list_public_event_sessions(text)', 'PUBLICA', '2c90a2d0362ceed78b113a83f84e3e62', '92b291f3584d1180a68320baf2986980'),
    ('public.list_public_regular_experiences()', 'PUBLICA', '12b8295eeeeb2aeb5e03736dedc22a28', '35e8cc58709dd1f81c5ea0a2b84d6159'),
    ('public.list_public_regular_catalog()', 'PUBLICA', '6b201d866dda84c0d2ba39e0f09497da', '60d1de9482f0908314a6efacf271541f'),
    ('public.admin_create_event(uuid,uuid,text,text,text,jsonb,text,timestamptz,integer,integer,integer)', 'PAINEL', 'c5349329da0eaa411cf732eefa7f3e6d', 'd1b23f174f8e2995f791011a2af811e2'),
    ('public.admin_update_event(uuid,uuid,text,text,text,text,integer,jsonb)', 'PAINEL', 'c000c1d6ffb3e32109fe6e7ebc3deee5', '630c11223d0ec0b9eaf0004e1df76598'),
    ('public.admin_duplicate_event(uuid,uuid,text,text,timestamptz)', 'PAINEL', '1a32918af4f7274d3c2503a3f9793fde', '04a770e726ffe6e39b6311ebae469985'),
    ('public.admin_list_events(uuid)', 'PAINEL', '69c7625df89891121641420a4b892739', '48c9fa79170b37d14357c3d24bdaedcc'),
    ('public.admin_event_report(uuid,uuid)', 'PAINEL', '26cd92287cbfcdbe681363983981d9bd', 'ebea93f837b56de73557e03644371eb9'),
    ('public.admin_create_experience(uuid,text,text,text,text,text,integer,text,integer,integer,integer,jsonb,uuid)', 'EXISTENTE', 'e644f41e093b3fa0eb56f01db0f85885', '461dab930c3c06161086352cada97b6d'),
    ('public.admin_update_experience(uuid,uuid,text,text,text,text,integer,text,integer,integer,integer,jsonb,uuid)', 'EXISTENTE', 'e2ce92345df315d7ca7b3af5981fb506', '582abc21797a6316bda1990ea4814051'),
    ('public.admin_create_session(uuid,uuid,timestamptz,integer,integer,integer,public.session_status,text)', 'EXISTENTE', '461c09e918c4a8700b1a05c640e653cd', '907f7eb284b8467c713e2c7a2daa9db8'),
    ('public.is_active_admin(uuid)', 'EXISTENTE', 'd4a5f6d71d3732cca38bd0a73ae12620', 'b4560566fbfc891fa821d4264ae24f69'),
    ('public.available_spots(uuid)', 'EXISTENTE', '0fe290aa82248812c1c035354d94e2fa', 'a3050f894ad24f6262b2b80d1d3a752f')
),
functions as (
  select e.sig, e.kind, p.oid, p.prosecdef, p.proconfig,
         regexp_replace(e.sig, '^public\.|\(.*$', '', 'g') as fn,
         case when p.oid is null then 'AUSENTE'
              when md5(p.prosrc) = e.exact then 'IDENTICA'
              when md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g')) = e.norm then 'IDENTICA_SO_FORMATACAO'
              else 'DIFERENTE' end as verdict
  from expected e left join pg_proc p on p.oid = to_regprocedure(e.sig)
),
created as (select * from functions where kind <> 'EXISTENTE'),
-- Pública: anon e authenticated executam. Painel: só a service role.
-- Trigger e interna: ninguém pela API (a interna só a service role).
wrong_privileges as (
  select fn from created
  where oid is null
     or (kind = 'PUBLICA' and not (has_function_privilege('anon', oid, 'EXECUTE') and has_function_privilege('authenticated', oid, 'EXECUTE')))
     or (kind = 'PAINEL' and (has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE')
                              or not has_function_privilege('service_role', oid, 'EXECUTE')))
     or (kind = 'INTERNA' and (has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE')))
     or (kind = 'TRIGGER' and (has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE')
                               or has_function_privilege('service_role', oid, 'EXECUTE')))
),
kind_column as (
  select c.is_nullable, c.column_default,
         exists (select 1 from pg_constraint where conrelid = 'public.experiences'::regclass and conname = 'experiences_kind_check') as checked
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'experiences' and c.column_name = 'kind'
),
settings_table as (
  select c.relrowsecurity and (select count(*) from pg_policy p where p.polrelid = c.oid) = 0
           and not exists (
             select 1 from unnest(array['anon', 'authenticated', 'service_role']) r(role),
                           unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p(priv)
             where has_table_privilege(r.role, c.oid, p.priv)
           ) as closed
  from pg_class c where c.oid = 'public.special_event_settings'::regclass
),
triggers as (
  select t.tgname, t.tgenabled
  from pg_trigger t
  where not t.tgisinternal
    and ((t.tgrelid = 'public.experiences'::regclass and t.tgname = 'experiences_kind_guard')
      or (t.tgrelid = 'public.reservations'::regclass and t.tgname = 'reservations_event_kind_guard'))
),
-- As listagens novas da agenda regular são as antigas menos os eventos.
regular_extra as (
  (select slug from public.list_public_regular_experiences() except select slug from public.list_public_experiences())
  union all
  (select slug from public.list_public_regular_catalog() except select slug from public.list_public_catalog())
),
regular_missing as (
  select slug from (
    (select slug from public.list_public_experiences() except select slug from public.list_public_regular_experiences())
    union
    (select slug from public.list_public_catalog() except select slug from public.list_public_regular_catalog())
  ) gone
  where not exists (select 1 from public.experiences e where e.slug = gone.slug and e.kind = 'EVENT')
),
checks as (
  select 'COLUNA_KIND' as check_name,
         coalesce((select case when is_nullable = 'NO' then 'not null' else 'NULLABLE' end || ', default ' || coalesce(column_default, 'nenhum')
                          || case when checked then ', check REGULAR/EVENT' else ', SEM CHECK' end from kind_column), 'ausente') as result,
         case when (select is_nullable = 'NO' and column_default like '''REGULAR''%' and checked from kind_column) then 'OK' else 'FALHOU' end as status
  union all
  select 'EXPERIENCIAS_POR_TIPO',
         (select string_agg(kind || '=' || n, ', ' order by kind) from (select kind, count(*) n from public.experiences group by 1) x),
         case when exists (select 1 from public.experiences where kind = 'EVENT') then 'ATENCAO' else 'OK' end
  union all
  select 'FUNCOES_NOVAS_COM_A_DEFINICAO_DO_REPOSITORIO',
         (select count(*) filter (where verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO'))::text || ' de ' || count(*)::text
                 || coalesce(' | ' || string_agg(fn || '=' || verdict, ', ' order by fn) filter (where verdict not in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')), '')
          from created),
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from created) then 'OK' else 'FALHOU' end
  union all
  select 'FUNCOES_SECURITY_DEFINER_COM_SEARCH_PATH',
         coalesce((select string_agg(fn, ', ' order by fn) from created
                   where not coalesce(prosecdef, false) or proconfig is null or not exists (select 1 from unnest(proconfig) c where c like 'search_path=%')), 'todas'),
         case when not exists (select 1 from created where not coalesce(prosecdef, false) or proconfig is null or not exists (select 1 from unnest(proconfig) c where c like 'search_path=%')) then 'OK' else 'FALHOU' end
  union all
  select 'PERMISSOES_DAS_FUNCOES',
         coalesce('erradas: ' || (select string_agg(fn, ', ' order by fn) from wrong_privileges), 'públicas para o site, painel só pela service role, triggers fora da API'),
         case when exists (select 1 from wrong_privileges) then 'FALHOU' else 'OK' end
  union all
  select 'FUNCOES_EXISTENTES_INALTERADAS',
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions where kind = 'EXISTENTE'),
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from functions where kind = 'EXISTENTE') then 'OK' else 'FALHOU' end
  union all
  select 'TRIGGERS_DE_TIPO',
         coalesce((select string_agg(tgname || case when tgenabled = 'D' then ' (DESABILITADA)' else '' end, ', ' order by tgname) from triggers), 'nenhuma'),
         case when (select count(*) from triggers where tgenabled <> 'D') = 2 then 'OK' else 'FALHOU' end
  union all
  select 'CONFIGURACAO_FECHADA',
         (select count(*)::text || ' linha(s)' from public.special_event_settings) || ', '
           || coalesce((select case when closed then 'sem acesso pela API' else 'EXPOSTA' end from settings_table), 'ausente'),
         case when (select count(*) = 1 from public.special_event_settings) and (select closed from settings_table) then 'OK' else 'FALHOU' end
  union all
  select 'INTERRUPTOR_DA_PUBLICACAO',
         (select case when publication_enabled then 'LIGADO' else 'desligado' end from public.special_event_settings),
         case when (select publication_enabled from public.special_event_settings) then 'ATENCAO' else 'OK' end
  union all
  select 'LISTAGENS_REGULARES_SEM_PERDA',
         (select count(*)::text from public.list_public_regular_experiences()) || ' experiências, '
           || (select count(*)::text from public.list_public_regular_catalog()) || ' no catálogo'
           || coalesce(' | a mais: ' || (select string_agg(slug, ', ') from regular_extra), '')
           || coalesce(' | faltando: ' || (select string_agg(slug, ', ') from regular_missing), ''),
         case when exists (select 1 from regular_extra) or exists (select 1 from regular_missing) then 'FALHOU' else 'OK' end
  union all
  select 'EVENTOS_PUBLICOS',
         (select count(*)::text from public.list_public_events()) || ' publicado(s)',
         case when exists (select 1 from public.list_public_events()) then 'ATENCAO' else 'OK' end
  union all
  select 'ASSINATURA_DAS_FUNCOES_EXISTENTES',
         (select count(*)::text || ' funções, ' || md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), '|' order by p.oid::regprocedure::text))
          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not in (select fn from created)),
         'OK'
  union all
  select 'EXPERIENCIAS_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status, count(*) n from public.experiences group by 1) x),
         'OK'
  union all
  select 'SESSOES_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.sessions group by 1) x),
         'OK'
  union all
  select 'RESERVAS_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.reservations group by 1) x),
         'OK'
)
select check_name, result, status from checks
union all
select 'EVENTOS_POSTCHECK_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
