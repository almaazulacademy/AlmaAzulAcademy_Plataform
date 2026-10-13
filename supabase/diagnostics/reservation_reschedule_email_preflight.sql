-- E-MAIL DE REAGENDAMENTO — PREFLIGHT (SOMENTE LEITURA)
--
-- Rodar no SQL Editor ANTES de `202610150001_reservation_reschedule_email.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita,
-- nenhuma função nova e nenhum dado pessoal retornado.
--
-- Três estados:
--   OK       — pode seguir.
--   ATENCAO  — NÃO bloqueia a migration, mas precisa ser lido antes de seguir.
--   FALHOU   — interrompe: a migration não deve ser aplicada.
--
-- A linha final, STANDBY_EMAIL_PREFLIGHT_OK, fica OK quando nenhuma linha
-- FALHOU; o texto dela diz quantos pontos de atenção existem. Guarde
-- RESERVAS_POR_STATUS, EVENTOS_DE_PAGAMENTO, HISTORICO_DE_TROCAS,
-- AUTORIZACOES_DE_STANDBY e FILAS_EXISTENTES: o postcheck precisa devolver os
-- mesmos números.
--
-- ## Como as funções são conferidas
--
-- A migration não substitui o corpo de nenhuma função existente. O que ela faz
-- com cada uma decide o rigor da conferência:
--
--   * FUNCAO_QUE_GRAVA_O_REAGENDAMENTO — `reservation_standby_resolve`. É ela
--     que insere a linha de histórico com `origin = 'STANDBY_RESCHEDULE'`, que a
--     trigger nova observa. Diferença de conteúdo muda quando o e-mail é
--     enfileirado: FALHOU.
--   * FUNCOES_DE_APOIO — `reservation_confirmation_email` (o conteúdo do
--     e-mail), `is_active_admin` e `set_updated_at`. A migration só as chama.
--     Ausentes, FALHOU. Com conteúdo diferente do repositório não impedem a
--     migration, mas dizem que produção e repositório divergem: ATENCAO.
--
-- Diferença **só de formatação** — LF ou CRLF, espaços, tabulação, recuo — é
-- aceita em todos os casos: o veredito vira IDENTICA_SO_FORMATACAO e a linha
-- continua OK.

with expected(fn, kind, exact, norm) as (values
    ('reservation_standby_resolve', 'ORIGEM', 'ee2c16b8a8e2960656a6eb45c8021924', 'd8a5f75fdaf19ae2926cac272fac224b'),
    ('is_active_admin', 'APOIO', 'd4a5f6d71d3732cca38bd0a73ae12620', 'b4560566fbfc891fa821d4264ae24f69'),
    ('reservation_confirmation_email', 'APOIO', '6b53ea280f7cfcc91d4d756bd6348ecf', '27c37a1249bb3baebe60366e0dd9402e'),
    ('set_updated_at', 'APOIO', '9b1889f56258bf9d6554213c05019c76', '077bb7aa35a4fed76f447b242607c205')
),
prod as (
  select p.proname as fn,
         md5(p.prosrc) as exact,
         md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g')) as norm,
         count(*) over (partition by p.proname) as overloads
  from pg_proc p where p.pronamespace = 'public'::regnamespace
),
functions as (
  select e.fn, e.kind,
         case when pr.fn is null then 'AUSENTE'
              when pr.overloads > 1 then 'SOBRECARGA'
              when pr.exact = e.exact then 'IDENTICA'
              when pr.norm = e.norm then 'IDENTICA_SO_FORMATACAO'
              else 'DIFERENTE' end as verdict
  from expected e left join prod pr on pr.fn = e.fn
),
new_functions(fn) as (values
    ('admin_claim_reservation_reschedule_email'),
    ('admin_list_undelivered_reschedule_emails'),
    ('admin_reservation_reschedule_emails'),
    ('claim_pending_reservation_reschedule_emails'),
    ('claim_reservation_reschedule_email'),
    ('complete_reservation_reschedule_email'),
    ('enqueue_reservation_reschedule_email'),
    ('fail_reservation_reschedule_email'),
    ('freeze_reservation_reschedule_email'),
    ('reservation_reschedule_email_fingerprint'),
    ('reservation_reschedule_email_payload'),
    ('reservation_reschedule_email_rejection'),
    ('reservation_reschedule_email_take')
),
existing_objects as (
  select 'função ' || p.proname as name from pg_proc p join new_functions n on n.fn = p.proname where p.pronamespace = 'public'::regnamespace
  union all
  select 'tabela ' || c.relname from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relname in ('reservation_reschedule_emails', 'reservation_reschedule_email_attempts')
  union all
  select 'trigger ' || t.tgname from pg_trigger t
  where t.tgrelid = 'public.reservation_session_changes'::regclass and t.tgname = 'reservation_session_changes_reschedule_email'
),
checks as (
  -- Etapas 2 e 3: a tabela das autorizações, as três colunas do histórico que
  -- a trigger lê, a unicidade "uma troca por autorização" e o reagendamento do
  -- painel.
  select 'ETAPAS_ANTERIORES_APLICADAS' as check_name,
         'autorizações=' || coalesce(to_regclass('public.reservation_standby')::text, 'ausente')
           || ', colunas do histórico=' || (select count(*)::text from information_schema.columns
                                           where table_schema = 'public' and table_name = 'reservation_session_changes'
                                             and column_name in ('origin', 'standby_id', 'actor_type')) || '/3'
           || ', uma troca por autorização=' || coalesce(to_regclass('public.reservation_session_changes_standby_key')::text, 'ausente')
           || ', reagendamento do painel=' || coalesce(to_regprocedure('public.admin_reschedule_standby_same_price(uuid,uuid,uuid,text)')::text, 'ausente') as result,
         case when to_regclass('public.reservation_standby') is not null
                   and (select count(*) from information_schema.columns
                        where table_schema = 'public' and table_name = 'reservation_session_changes'
                          and column_name in ('origin', 'standby_id', 'actor_type')) = 3
                   and to_regclass('public.reservation_session_changes_standby_key') is not null
                   and to_regprocedure('public.admin_reschedule_standby_same_price(uuid,uuid,uuid,text)') is not null
              then 'OK' else 'FALHOU' end as status
  union all
  select 'FUNCAO_QUE_GRAVA_O_REAGENDAMENTO',
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions where kind = 'ORIGEM'),
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from functions where kind = 'ORIGEM') then 'OK' else 'FALHOU' end
  union all
  select 'FUNCOES_DE_APOIO',
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions where kind = 'APOIO'),
         case when exists (select 1 from functions where kind = 'APOIO' and verdict in ('AUSENTE', 'SOBRECARGA')) then 'FALHOU'
              when exists (select 1 from functions where kind = 'APOIO' and verdict = 'DIFERENTE') then 'ATENCAO'
              else 'OK' end
  union all
  select 'OBJETOS_DA_FILA_AINDA_NAO_EXISTEM',
         coalesce((select string_agg(name, ', ' order by name) from existing_objects), 'nenhum'),
         case when not exists (select 1 from existing_objects) then 'OK' else 'FALHOU' end
  union all
  -- A trigger nova passa a ser a única desta tabela no repositório. Outra já
  -- existente não impede a migration, mas precisa ser conhecida.
  select 'TRIGGERS_NO_HISTORICO_DE_TROCAS',
         coalesce((select string_agg(t.tgname, ', ' order by t.tgname) from pg_trigger t
                   where t.tgrelid = 'public.reservation_session_changes'::regclass and not t.tgisinternal), 'nenhuma'),
         case when exists (select 1 from pg_trigger t where t.tgrelid = 'public.reservation_session_changes'::regclass and not t.tgisinternal)
              then 'ATENCAO' else 'OK' end
  union all
  -- A migration não cria evento retroativo: reagendamento feito antes dela não
  -- entra na fila e não recebe e-mail.
  select 'REAGENDAMENTOS_DE_STANDBY_JA_FEITOS',
         (select count(*)::text from public.reservation_session_changes where origin = 'STANDBY_RESCHEDULE'),
         case when exists (select 1 from public.reservation_session_changes where origin = 'STANDBY_RESCHEDULE') then 'ATENCAO' else 'OK' end
  union all
  select 'RESERVAS_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.reservations group by 1) x),
         'OK'
  union all
  select 'EVENTOS_DE_PAGAMENTO', (select count(*)::text from public.payment_events), 'OK'
  union all
  select 'HISTORICO_DE_TROCAS', (select count(*)::text from public.reservation_session_changes), 'OK'
  union all
  select 'AUTORIZACOES_DE_STANDBY',
         (select count(*)::text || ' no total, ' || count(*) filter (where resolved_at is null)::text || ' aberta(s)' from public.reservation_standby),
         'OK'
  union all
  -- O e-mail de pagamento e a planilha: a migration não toca nesta fila.
  select 'FILAS_EXISTENTES',
         coalesce((select string_agg(integration || ':' || status || '=' || n, ', ' order by integration, status)
                   from (select integration, status, count(*) n from public.integration_sync_jobs group by 1, 2) x), 'vazias'),
         'OK'
)
select check_name, result, status from checks
union all
select 'STANDBY_EMAIL_PREFLIGHT_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
