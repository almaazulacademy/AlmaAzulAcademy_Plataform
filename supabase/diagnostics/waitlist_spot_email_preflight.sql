-- LISTA DE ESPERA, FASE 6 (AVISO DE VAGA) — PREFLIGHT (SOMENTE LEITURA)
--
-- Rodar no SQL Editor ANTES de `202610260002_waitlist_spot_email.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita e
-- nenhum dado pessoal retornado.
--
--   OK       — pode seguir.
--   ATENCAO  — não bloqueia, mas precisa ser lido antes de seguir.
--   FALHOU   — interrompe: a migration não deve ser aplicada.
--
-- A linha final, WAITLIST_AVISO_PREFLIGHT_OK, fica OK quando nenhuma linha
-- FALHOU. Guarde ASSINATURA_DAS_FUNCOES_EXISTENTES e as contagens.
--
-- A migration reaproveita, sem mudar, o congelamento e a falha da fila da fase
-- 3, a régua de vagas da fase 5 e o token do link da fase 1. Conteúdo diferente
-- do repositório em qualquer uma delas é FALHOU.

with expected(fn, exact, norm) as (values
    ('fail_waitlist_email', '3cf7275d494382311ba91de409d5fb30', 'aad45a5ac4ed4bdb93f77eac073f0dac'),
    ('freeze_waitlist_email', '115df869ac486f60c3ed3c283217ce89', '7057e507f8a3e6598d732db389d49430'),
    ('waitlist_cancel_token', 'c4fc03a731bc475353af6925d9314993', 'b8e0445c63e079608b992ad6927df767'),
    ('waitlist_detection_spots', '9e9c15c211c779943886bc1e86e5c156', '43df8923e16003b51bfeebea2bf817c6')
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
    ('waitlist_spot_rejection'), ('waitlist_spot_payload'), ('waitlist_spot_take'),
    ('claim_pending_waitlist_spot_emails'), ('complete_waitlist_spot_email')
),
present as (
  select name from new_names where exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = new_names.name)
),
checks as (
  select 'FUNCOES_REAPROVEITADAS' as check_name,
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions) as result,
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from functions) then 'OK' else 'FALHOU' end as status
  union all
  select 'FASES_3_E_5_APLICADAS',
         'geração da fila=' || exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'waitlist_notifications' and column_name = 'generation_uncertain')::text
           || ', interruptor da detecção=' || (to_regclass('public.waitlist_settings') is not null)::text,
         case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'waitlist_notifications' and column_name = 'generation_uncertain')
               and to_regclass('public.waitlist_settings') is not null then 'OK' else 'FALHOU' end
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
select 'WAITLIST_AVISO_PREFLIGHT_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
