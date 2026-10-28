-- EVENTOS ESPECIAIS, FASE 2 (FUNDAÇÃO NO BANCO) — PREFLIGHT (SOMENTE LEITURA)
--
-- Rodar no SQL Editor ANTES de `202610280001_special_events_foundation.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita e
-- nenhum dado pessoal retornado.
--
--   OK       — pode seguir.
--   ATENCAO  — não bloqueia, mas precisa ser lido antes de seguir.
--   FALHOU   — interrompe: a migration não deve ser aplicada.
--
-- A linha final, EVENTOS_PREFLIGHT_OK, fica OK quando nenhuma linha FALHOU.
-- Guarde ASSINATURA_DAS_FUNCOES_EXISTENTES e as contagens: o postcheck precisa
-- devolver os mesmos valores.
--
-- A migration chama, sem alterar, as RPCs de experiência e de sessão do painel,
-- `is_active_admin` e `available_spots`. Conteúdo diferente do repositório em
-- qualquer uma é FALHOU. A comparação aceita diferença só de quebra de linha
-- (SQL colado no editor grava CRLF).

with expected(sig, exact, norm) as (values
    ('public.admin_create_experience(uuid,text,text,text,text,text,integer,text,integer,integer,integer,jsonb,uuid)', 'e644f41e093b3fa0eb56f01db0f85885', '461dab930c3c06161086352cada97b6d'),
    ('public.admin_update_experience(uuid,uuid,text,text,text,text,integer,text,integer,integer,integer,jsonb,uuid)', 'e2ce92345df315d7ca7b3af5981fb506', '582abc21797a6316bda1990ea4814051'),
    ('public.admin_create_session(uuid,uuid,timestamptz,integer,integer,integer,public.session_status,text)', '461c09e918c4a8700b1a05c640e653cd', '907f7eb284b8467c713e2c7a2daa9db8'),
    ('public.is_active_admin(uuid)', 'd4a5f6d71d3732cca38bd0a73ae12620', 'b4560566fbfc891fa821d4264ae24f69'),
    ('public.available_spots(uuid)', '0fe290aa82248812c1c035354d94e2fa', 'a3050f894ad24f6262b2b80d1d3a752f')
),
functions as (
  select e.sig,
         case when to_regprocedure(e.sig) is null then 'AUSENTE'
              when md5(p.prosrc) = e.exact then 'IDENTICA'
              when md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g')) = e.norm then 'IDENTICA_SO_FORMATACAO'
              else 'DIFERENTE' end as verdict
  from expected e left join pg_proc p on p.oid = to_regprocedure(e.sig)
),
new_names(name) as (values
    ('enforce_experience_kind_rules'), ('enforce_reservation_event_kind'), ('special_event_availability'),
    ('list_public_events'), ('get_public_event'), ('list_public_event_sessions'),
    ('list_public_regular_experiences'), ('list_public_regular_catalog'),
    ('admin_create_event'), ('admin_update_event'), ('admin_duplicate_event'), ('admin_list_events'), ('admin_event_report')
),
present as (
  select name from new_names where exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = new_names.name)
  union all
  select 'coluna experiences.kind'
  where exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'experiences' and column_name = 'kind')
  union all
  select 'tabela special_event_settings' where to_regclass('public.special_event_settings') is not null
  union all
  select 'trigger ' || tgname from pg_trigger where tgname in ('experiences_kind_guard', 'reservations_event_kind_guard') and not tgisinternal
),
checks as (
  select 'FUNCOES_QUE_A_MIGRATION_CHAMA' as check_name,
         (select string_agg(regexp_replace(sig, '^public\.|\(.*$', '', 'g') || '=' || verdict, ', ' order by sig) from functions) as result,
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from functions) then 'OK' else 'FALHOU' end as status
  union all
  -- As operações que trocam reserva de turma. A trava nova é uma trigger em
  -- reservations.session_id; elas precisam existir para a cobertura valer.
  select 'TROCAS_DE_TURMA_EXISTENTES',
         (select count(*)::text || ' de 4' from (values
            ('public.admin_change_reservation_session(uuid,uuid,uuid,text)'),
            ('public.admin_reschedule_standby_same_price(uuid,uuid,uuid,text)'),
            ('public.admin_undo_reservation_standby(uuid,uuid,text)'),
            ('public.customer_reschedule_reservation(text,text,text,uuid,uuid)')) t(sig)
          where to_regprocedure(sig) is not null),
         case when to_regprocedure('public.admin_change_reservation_session(uuid,uuid,uuid,text)') is not null
               and to_regprocedure('public.admin_reschedule_standby_same_price(uuid,uuid,uuid,text)') is not null
               and to_regprocedure('public.admin_undo_reservation_standby(uuid,uuid,text)') is not null
               and to_regprocedure('public.customer_reschedule_reservation(text,text,text,uuid,uuid)') is not null then 'OK' else 'FALHOU' end
  union all
  select 'BASE_CONCHA_ACUSTICA',
         coalesce((select status from public.bases where slug = 'concha-acustica'), 'ausente'),
         case when exists (select 1 from public.bases where slug = 'concha-acustica' and status = 'ACTIVE') then 'OK' else 'ATENCAO' end
  union all
  select 'SLUG_ESSENCIA_LIVRE',
         case when exists (select 1 from public.experiences where slug = 'essencia') then 'já existe' else 'livre' end,
         case when exists (select 1 from public.experiences where slug = 'essencia') then 'ATENCAO' else 'OK' end
  union all
  select 'TRIGGERS_EM_EXPERIENCES_E_RESERVATIONS',
         (select string_agg(c.relname || '.' || t.tgname, ', ' order by c.relname, t.tgname)
          from pg_trigger t join pg_class c on c.oid = t.tgrelid
          where not t.tgisinternal and c.oid in ('public.experiences'::regclass, 'public.reservations'::regclass)),
         'OK'
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
  union all
  select 'LISTAGENS_PUBLICAS',
         (select count(*)::text from public.list_public_experiences()) || ' experiências, '
           || (select count(*)::text from public.list_public_catalog()) || ' no catálogo',
         'OK'
)
select check_name, result, status from checks
union all
select 'EVENTOS_PREFLIGHT_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
