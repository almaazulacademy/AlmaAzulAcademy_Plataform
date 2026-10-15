-- AUTOATENDIMENTO DO STAND-BY — PREFLIGHT (SOMENTE LEITURA)
--
-- Rodar no SQL Editor ANTES de `202610160001_reservation_standby_self_service.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita,
-- nenhuma função nova e nenhum dado pessoal retornado.
--
-- Três estados:
--   OK       — pode seguir.
--   ATENCAO  — NÃO bloqueia a migration, mas precisa ser lido antes de seguir.
--   FALHOU   — interrompe: a migration não deve ser aplicada.
--
-- A linha final, STANDBY_AUTOATENDIMENTO_PREFLIGHT_OK, fica OK quando nenhuma
-- linha FALHOU. Guarde RESERVAS_POR_STATUS, EVENTOS_DE_PAGAMENTO,
-- HISTORICO_DE_TROCAS, AUTORIZACOES_DE_STANDBY e FILA_DE_REAGENDAMENTO: o
-- postcheck precisa devolver os mesmos números (fora o que aconteceu de verdade
-- no site entre as duas execuções).
--
-- ## Como as funções são conferidas
--
-- A migration não substitui o corpo de nenhuma função. Ela **chama** três da
-- etapa 2 (`customer_reschedule_options`, `reservation_standby_access` e
-- `reservation_latest_standby`) e as rotas novas chamam
-- `customer_reschedule_reservation`, que entrega a escolha a
-- `reservation_standby_resolve` com a régua de
-- `reservation_standby_target_rejection`. Conteúdo diferente do repositório em
-- qualquer uma delas muda o que o cliente vê ou o que a escolha grava: FALHOU.
--
-- Diferença **só de formatação** — LF ou CRLF, espaços, tabulação, recuo — é
-- aceita: o veredito vira IDENTICA_SO_FORMATACAO e a linha continua OK.

with expected(fn, exact, norm) as (values
    ('customer_reschedule_options', '9cb629730d6b1aa3da298647d1d4774a', '73845f5f1bdec1737703903b7fd8c2eb'),
    ('customer_reschedule_reservation', '527e7caf2007bf809cf0a0f9070e293a', '2de122ee7dee9b72d0ce9e223f5a2ee9'),
    ('reservation_latest_standby', '769baa3c30a33be6bce7f708e0bb0841', 'ba75c6375310e323ed450a34bf93a530'),
    ('reservation_standby_access', '18f750997161dcb9c104ac19623baab1', '72e74fd4e58b390fc82820b8ae817892'),
    ('reservation_standby_resolve', 'ee2c16b8a8e2960656a6eb45c8021924', 'd8a5f75fdaf19ae2926cac272fac224b'),
    ('reservation_standby_target_rejection', '202b1b5e84a5e0b387bfd94b1e4ed6e4', '2ba6e8597a398c70dfde960adc0f78d8')
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
new_objects as (
  select 'customer_reschedule_throttle' as name, exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'customer_reschedule_throttle') as present
  union all
  select 'customer_reschedule_overview', exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'customer_reschedule_overview')
  union all
  select 'customer_access_throttle', to_regclass('public.customer_access_throttle') is not null
  union all
  select 'customer_access_throttle_secret', to_regclass('public.customer_access_throttle_secret') is not null
),
checks as (
  select 'FUNCOES_DO_AUTOATENDIMENTO' as check_name,
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions) as result,
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from functions) then 'OK' else 'FALHOU' end as status
  union all
  -- O reagendamento do cliente enfileira o e-mail pela trigger da etapa 4.
  select 'ETAPA_4_APLICADA',
         coalesce((select 'trigger ' || tgenabled::text from pg_trigger
                   where tgrelid = 'public.reservation_session_changes'::regclass and tgname = 'reservation_session_changes_reschedule_email'), 'ausente'),
         case when exists (select 1 from pg_trigger
                           where tgrelid = 'public.reservation_session_changes'::regclass
                             and tgname = 'reservation_session_changes_reschedule_email' and tgenabled = 'O')
              then 'OK' else 'FALHOU' end
  union all
  -- O limite usa HMAC e gera o segredo com o gerador criptográfico do pgcrypto.
  select 'PGCRYPTO_NO_SCHEMA_EXTENSIONS',
         'hmac=' || (to_regprocedure('extensions.hmac(bytea,bytea,text)') is not null)::text
           || ', gen_random_bytes=' || (to_regprocedure('extensions.gen_random_bytes(integer)') is not null)::text,
         case when to_regprocedure('extensions.hmac(bytea,bytea,text)') is not null
               and to_regprocedure('extensions.gen_random_bytes(integer)') is not null
              then 'OK' else 'FALHOU' end
  union all
  -- Antes da migration, nada disto existe. Se existir, é reaplicação: a migration
  -- é idempotente e mantém o segredo, mas vale saber.
  select 'OBJETOS_NOVOS_AINDA_AUSENTES',
         coalesce((select string_agg(name, ', ' order by name) from new_objects where present), 'nenhum existe'),
         case when exists (select 1 from new_objects where present) then 'ATENCAO' else 'OK' end
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
         (select count(*)::text || ' no total, ' || count(*) filter (where resolved_at is null)::text || ' aberta(s), '
                 || count(*) filter (where link_token_hash is not null and resolved_at is null)::text || ' com link ativo'
          from public.reservation_standby),
         'OK'
  union all
  select 'FILA_DE_REAGENDAMENTO',
         coalesce((select string_agg(status || '=' || n, ', ' order by status) from (select status, count(*) n from public.reservation_reschedule_emails group by 1) x), 'vazia'),
         'OK'
)
select check_name, result, status from checks
union all
select 'STANDBY_AUTOATENDIMENTO_PREFLIGHT_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
