-- LISTA DE ESPERA, FASE 1 (FUNDAÇÃO) — PREFLIGHT (SOMENTE LEITURA)
--
-- Rodar no SQL Editor ANTES de `202610250001_waitlist_foundation.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita,
-- nenhuma função nova e nenhum dado pessoal retornado.
--
-- Três estados:
--   OK       — pode seguir.
--   ATENCAO  — NÃO bloqueia a migration, mas precisa ser lido antes de seguir.
--   FALHOU   — interrompe: a migration não deve ser aplicada.
--
-- A linha final, WAITLIST_FUNDACAO_PREFLIGHT_OK, fica OK quando nenhuma linha
-- FALHOU. Guarde ASSINATURA_DAS_FUNCOES_EXISTENTES e as contagens: o postcheck
-- precisa devolver os mesmos valores (fora o que aconteceu de verdade no site
-- entre as duas execuções).
--
-- ## Como as funções são conferidas
--
-- A migration não substitui o corpo de nenhuma função. Ela **chama**
-- `available_spots` (vagas) e `is_active_admin` (painel), usa `set_updated_at`
-- nas tabelas novas, e `list_public_sessions` repete as regras de
-- `list_open_sessions`. Se `available_spots`, `list_open_sessions` ou
-- `get_booking_session` tiverem conteúdo diferente do repositório, a turma
-- "esgotada" mostrada pela lista pode não ser a mesma que a reserva recusa:
-- FALHOU. `is_active_admin` e `set_updated_at` diferentes viram ATENCAO.
--
-- Diferença **só de formatação** (LF ou CRLF, espaços, recuo) é aceita: o
-- veredito vira IDENTICA_SO_FORMATACAO e a linha continua OK.

with expected(fn, severity, exact, norm) as (values
    ('available_spots', 'FALHOU', '0fe290aa82248812c1c035354d94e2fa', 'a3050f894ad24f6262b2b80d1d3a752f'),
    ('get_booking_session', 'FALHOU', 'ef6e779340dbee37df36ffbb9f52eec6', '4b07e68e8102ca0a6fc84ee4755b3324'),
    ('list_open_sessions', 'FALHOU', '62c7497707dea5325c02c840465962a9', 'b0b535d34537c408588626ed14679c7e'),
    ('is_active_admin', 'ATENCAO', 'd4a5f6d71d3732cca38bd0a73ae12620', 'b4560566fbfc891fa821d4264ae24f69'),
    ('set_updated_at', 'ATENCAO', '9b1889f56258bf9d6554213c05019c76', '077bb7aa35a4fed76f447b242607c205')
),
prod as (
  select p.proname as fn,
         md5(p.prosrc) as exact,
         md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g')) as norm,
         count(*) over (partition by p.proname) as overloads
  from pg_proc p where p.pronamespace = 'public'::regnamespace
),
functions as (
  select e.fn, e.severity,
         case when pr.fn is null then 'AUSENTE'
              when pr.overloads > 1 then 'SOBRECARGA'
              when pr.exact = e.exact then 'IDENTICA'
              when pr.norm = e.norm then 'IDENTICA_SO_FORMATACAO'
              else 'DIFERENTE' end as verdict
  from expected e left join prod pr on pr.fn = e.fn
),
new_names(name) as (values
    ('list_public_sessions'), ('waitlist_effective_status'), ('waitlist_cancel_token'), ('waitlist_token_hash'),
    ('waitlist_skip_pending_notifications'), ('register_waitlist_attempt'), ('waitlist_join'), ('waitlist_cancel_overview'),
    ('waitlist_cancel'), ('admin_waitlist_sessions'), ('admin_list_waitlist_entries_page'), ('admin_waitlist_entry'),
    ('admin_remove_waitlist_entry'), ('waitlist_expire_entries'), ('waitlist_mark_conversions'), ('waitlist_anonymize_entries'),
    ('waitlist_wave_size'), ('waitlist_eligible_entries')
),
new_tables(name) as (values
    ('waitlist_throttle_secret'), ('waitlist_throttle'), ('waitlist_entries'), ('waitlist_openings'),
    ('waitlist_notifications'), ('waitlist_notification_attempts')
),
present as (
  select name from new_names where exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = new_names.name)
  union all
  select name from new_tables where to_regclass('public.' || name) is not null
),
required_columns(tbl, col) as (values
    ('sessions', 'id'), ('sessions', 'experience_id'), ('sessions', 'starts_at'), ('sessions', 'status'), ('sessions', 'capacity'),
    ('sessions', 'duration_minutes'), ('sessions', 'price_cents'),
    ('experiences', 'id'), ('experiences', 'slug'), ('experiences', 'title'), ('experiences', 'summary'), ('experiences', 'status'), ('experiences', 'base_id'),
    ('bases', 'id'), ('bases', 'name'),
    ('reservations', 'id'), ('reservations', 'session_id'), ('reservations', 'email'), ('reservations', 'status'),
    ('reservations', 'created_at'), ('reservations', 'confirmed_at'),
    ('admin_audit_log', 'actor_user_id'), ('admin_audit_log', 'action'), ('admin_audit_log', 'entity_type'),
    ('admin_audit_log', 'entity_id'), ('admin_audit_log', 'reason'), ('admin_audit_log', 'metadata'),
    ('admin_users', 'user_id'), ('admin_users', 'display_name')
),
missing_columns as (
  select tbl || '.' || col as name from required_columns rc
  where not exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = rc.tbl and c.column_name = rc.col
  )
),
session_labels as (
  select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
  where t.typname = 'session_status' and t.typnamespace = 'public'::regnamespace
),
checks as (
  select 'FUNCOES_QUE_A_LISTA_ESPELHA_OU_CHAMA' as check_name,
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions where severity = 'FALHOU') as result,
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from functions where severity = 'FALHOU') then 'OK' else 'FALHOU' end as status
  union all
  select 'FUNCOES_DE_APOIO',
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions where severity = 'ATENCAO'),
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from functions where severity = 'ATENCAO') then 'OK'
              when (select bool_or(verdict in ('AUSENTE', 'SOBRECARGA')) from functions where severity = 'ATENCAO') then 'FALHOU'
              else 'ATENCAO' end
  union all
  -- Ordem dos rótulos não importa: o enum de produção veio do schema legado.
  select 'STATUS_DE_SESSAO',
         (select string_agg(enumlabel, ', ' order by enumlabel) from session_labels),
         case when (select count(*) from session_labels where enumlabel in ('OPEN', 'CANCELLED', 'ARCHIVED')) = 3 then 'OK' else 'FALHOU' end
  union all
  select 'COLUNAS_USADAS',
         coalesce((select 'ausentes: ' || string_agg(name, ', ' order by name) from missing_columns), 'todas presentes'),
         case when exists (select 1 from missing_columns) then 'FALHOU' else 'OK' end
  union all
  -- HMAC do limite e do link, SHA-256 do link e o segredo gerado na migration.
  select 'PGCRYPTO_NO_SCHEMA_EXTENSIONS',
         'hmac=' || (to_regprocedure('extensions.hmac(bytea,bytea,text)') is not null)::text
           || ', digest=' || (to_regprocedure('extensions.digest(bytea,text)') is not null)::text
           || ', gen_random_bytes=' || (to_regprocedure('extensions.gen_random_bytes(integer)') is not null)::text,
         case when to_regprocedure('extensions.hmac(bytea,bytea,text)') is not null
               and to_regprocedure('extensions.digest(bytea,text)') is not null
               and to_regprocedure('extensions.gen_random_bytes(integer)') is not null
              then 'OK' else 'FALHOU' end
  union all
  -- Antes da migration, nada disto existe. Se existir, é reaplicação: a migration
  -- é idempotente e mantém o segredo, mas vale saber.
  select 'OBJETOS_NOVOS_AINDA_AUSENTES',
         coalesce((select string_agg(name, ', ' order by name) from present), 'nenhum existe'),
         case when exists (select 1 from present) then 'ATENCAO' else 'OK' end
  union all
  -- Impressão digital de todas as funções do schema public que a migration não
  -- cria. O postcheck devolve o mesmo valor: nenhuma função existente mudou.
  select 'ASSINATURA_DAS_FUNCOES_EXISTENTES',
         (select count(*)::text || ' funções, ' || md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), '|' order by p.oid::regprocedure::text))
          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not in (select name from new_names)),
         'OK'
  union all
  select 'RESERVAS_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.reservations group by 1) x),
         'OK'
  union all
  select 'SESSOES_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.sessions group by 1) x),
         'OK'
  union all
  select 'EVENTOS_DE_PAGAMENTO', (select count(*)::text from public.payment_events), 'OK'
  union all
  select 'AUDITORIA', (select count(*)::text from public.admin_audit_log), 'OK'
)
select check_name, result, status from checks
union all
select 'WAITLIST_FUNDACAO_PREFLIGHT_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
