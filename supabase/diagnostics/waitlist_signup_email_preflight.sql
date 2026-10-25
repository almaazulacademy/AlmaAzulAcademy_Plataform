-- LISTA DE ESPERA, FASE 3 (E-MAIL DE CONFIRMAÇÃO) — PREFLIGHT (SOMENTE LEITURA)
--
-- Rodar no SQL Editor ANTES de `202610250002_waitlist_signup_email.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita e
-- nenhum dado pessoal retornado.
--
--   OK       — pode seguir.
--   ATENCAO  — não bloqueia, mas precisa ser lido antes de seguir.
--   FALHOU   — interrompe: a migration não deve ser aplicada.
--
-- A linha final, WAITLIST_EMAIL_PREFLIGHT_OK, fica OK quando nenhuma linha
-- FALHOU. Guarde ASSINATURA_DAS_FUNCOES_EXISTENTES e as contagens: o postcheck
-- precisa devolver os mesmos valores.
--
-- A migration chama funções da fase 1 (o token do link, o status efetivo da
-- inscrição) e opera a linha JOINED que `waitlist_join` grava. Conteúdo
-- diferente do repositório em qualquer uma delas é FALHOU. Diferença só de
-- formatação é aceita (IDENTICA_SO_FORMATACAO).

with expected(fn, exact, norm) as (values
    ('waitlist_cancel_token', 'c4fc03a731bc475353af6925d9314993', 'b8e0445c63e079608b992ad6927df767'),
    ('waitlist_effective_status', 'd5a07aebaeb8130337789377c0510de4', '3db793a67755fcfa5d0b792653e00a17'),
    ('waitlist_join', 'ea1804d2f2469e88aab92b72f210e804', '6f7b02560e23cc70b76b6aeac22effdb'),
    ('waitlist_skip_pending_notifications', 'c76881471c82db58e1791c14aeff9414', '62a87376506864938255dc9d17ecfcb2')
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
new_names(name) as (values
    ('waitlist_notification_rejection'), ('waitlist_notification_payload'), ('waitlist_notification_take'),
    ('claim_waitlist_joined_email'), ('claim_pending_waitlist_emails'), ('freeze_waitlist_email'),
    ('complete_waitlist_email'), ('fail_waitlist_email')
),
present as (
  select name from new_names where exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = new_names.name)
  union all
  select 'coluna ' || c.table_name || '.' || c.column_name
  from information_schema.columns c
  where c.table_schema = 'public'
    and ((c.table_name = 'waitlist_notifications' and c.column_name in ('generation_uncertain', 'generation_started_at'))
      or (c.table_name = 'waitlist_notification_attempts' and c.column_name = 'claim_token'))
),
checks as (
  select 'FUNCOES_DA_FASE_1_USADAS' as check_name,
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions) as result,
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from functions) then 'OK' else 'FALHOU' end as status
  union all
  select 'TABELAS_DA_FASE_1',
         (select count(*)::text || ' de 3' from (values ('waitlist_entries'), ('waitlist_notifications'), ('waitlist_notification_attempts')) t(name) where to_regclass('public.' || name) is not null),
         case when to_regclass('public.waitlist_entries') is not null and to_regclass('public.waitlist_notifications') is not null
               and to_regclass('public.waitlist_notification_attempts') is not null then 'OK' else 'FALHOU' end
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
  select 'INSCRICOES_POR_STATUS',
         coalesce((select string_agg(status || '=' || n, ', ' order by status) from (select status, count(*) n from public.waitlist_entries group by 1) x), 'nenhuma'),
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
select 'WAITLIST_EMAIL_PREFLIGHT_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
