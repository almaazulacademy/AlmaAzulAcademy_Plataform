-- PAINEL DE STAND-BY — PREFLIGHT (SOMENTE LEITURA)
--
-- Rodar no SQL Editor ANTES de `202610140001_reservation_standby_admin_panel.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita,
-- nenhuma função nova e nenhum dado pessoal retornado.
--
-- Três estados:
--   OK       — pode seguir.
--   ATENCAO  — NÃO bloqueia a migration, mas precisa ser lido antes de seguir.
--   FALHOU   — interrompe: a migration não deve ser aplicada.
--
-- A linha final, STANDBY_PAINEL_PREFLIGHT_OK, fica OK quando nenhuma linha
-- FALHOU; o texto dela diz quantos pontos de atenção existem. Guarde
-- RESERVAS_POR_STATUS, EVENTOS_DE_PAGAMENTO, HISTORICO_DE_TROCAS e
-- AUTORIZACOES_DE_STANDBY: o postcheck precisa devolver os mesmos números.
--
-- ## Como as funções são conferidas
--
-- A migration não substitui o corpo de nenhuma função existente. O que ela faz
-- com cada uma decide o rigor da conferência:
--
--   * FUNCOES_QUE_O_PAINEL_CHAMA — as três peças da etapa anterior que as
--     funções novas chamam. Diferença de conteúdo aqui muda o comportamento do
--     painel: FALHOU.
--   * FUNCOES_NAO_SUBSTITUIDAS — `admin_change_reservation_session`, que a
--     migration não toca, e `admin_reschedule_reservation_from_standby`, da qual
--     ela só retira um privilégio. Diferença de conteúdo não impede a migration,
--     mas diz que produção e repositório divergem: ATENCAO.
--
-- Em todos os casos, diferença **só de formatação** — quebra de linha LF ou
-- CRLF, espaços, tabulação, recuo — é aceita: o veredito vira
-- IDENTICA_SO_FORMATACAO e a linha continua OK. A comparação é feita duas vezes:
-- pelo texto exato e pelo texto com todo espaço em branco reduzido a um espaço.
-- Uma palavra trocada, um operador ou um número diferente continuam aparecendo
-- como DIFERENTE.

with expected(fn, kind, exact, norm) as (values
    ('reservation_latest_standby', 'CHAMADA', '769baa3c30a33be6bce7f708e0bb0841', 'ba75c6375310e323ed450a34bf93a530'),
    ('reservation_standby_resolve', 'CHAMADA', 'ee2c16b8a8e2960656a6eb45c8021924', 'd8a5f75fdaf19ae2926cac272fac224b'),
    ('reservation_standby_target_rejection', 'CHAMADA', '202b1b5e84a5e0b387bfd94b1e4ed6e4', '2ba6e8597a398c70dfde960adc0f78d8'),
    ('admin_change_reservation_session', 'NAO_SUBSTITUIDA', '02510c8110db73848ed0e8d0046533b2', '3913fee3b625ce4364e332be01a1772d'),
    ('admin_reschedule_reservation_from_standby', 'NAO_SUBSTITUIDA', '42bbaea1abbad4dc11e258ce4aa67762', 'a183eaaf2359d286e004af5dfb7d8fba')
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
    ('admin_list_standby_reservations_page'),
    ('admin_standby_reschedule_options'),
    ('admin_reschedule_standby_same_price'),
    ('admin_reservation_standby_history')
),
checks as (
  select 'ETAPA_ANTERIOR_APLICADA' as check_name,
         coalesce(to_regclass('public.reservation_standby')::text, 'ausente') as result,
         case when to_regclass('public.reservation_standby') is not null
                   and exists (select 1 from pg_trigger where tgrelid = 'public.reservations'::regclass and tgname = 'reservations_standby_guard' and tgenabled = 'O')
              then 'OK' else 'FALHOU' end as status
  union all
  -- A proteção da planilha lê `reservation_standby` como service role. A tabela
  -- tem RLS ligada e nenhuma policy: sem o privilégio de leitura **e** sem
  -- ignorar RLS, a leitura voltaria vazia em silêncio e a proteção não agiria.
  select 'SERVICE_ROLE_LE_AS_AUTORIZACOES',
         'select=' || has_table_privilege('service_role', 'public.reservation_standby', 'SELECT')::text
           || ', ignora_rls=' || coalesce((select rolbypassrls::text from pg_roles where rolname = 'service_role'), 'papel ausente'),
         case when has_table_privilege('service_role', 'public.reservation_standby', 'SELECT')
                   and coalesce((select rolbypassrls from pg_roles where rolname = 'service_role'), false)
              then 'OK' else 'FALHOU' end
  union all
  select 'FUNCOES_QUE_O_PAINEL_CHAMA',
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions where kind = 'CHAMADA'),
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from functions where kind = 'CHAMADA') then 'OK' else 'FALHOU' end
  union all
  select 'FUNCOES_NAO_SUBSTITUIDAS',
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions where kind = 'NAO_SUBSTITUIDA'),
         case when exists (select 1 from functions where kind = 'NAO_SUBSTITUIDA' and verdict in ('AUSENTE', 'SOBRECARGA')) then 'FALHOU'
              when exists (select 1 from functions where kind = 'NAO_SUBSTITUIDA' and verdict = 'DIFERENTE') then 'ATENCAO'
              else 'OK' end
  union all
  -- A migration retira o privilégio pela assinatura exata: ela precisa existir.
  select 'REAGENDAMENTO_SEM_REGUA_COM_A_ASSINATURA_ESPERADA',
         case when to_regprocedure('public.admin_reschedule_reservation_from_standby(uuid,uuid,uuid,text)') is null then 'ausente'
              when has_function_privilege('service_role', to_regprocedure('public.admin_reschedule_reservation_from_standby(uuid,uuid,uuid,text)'), 'EXECUTE') then 'presente, ainda executável pela service_role'
              else 'presente, já sem execução para a service_role' end,
         case when to_regprocedure('public.admin_reschedule_reservation_from_standby(uuid,uuid,uuid,text)') is not null then 'OK' else 'FALHOU' end
  union all
  select 'FUNCOES_DO_PAINEL_AINDA_NAO_EXISTEM',
         coalesce((select string_agg(p.proname, ', ' order by p.proname) from pg_proc p join new_functions n on n.fn = p.proname where p.pronamespace = 'public'::regnamespace), 'nenhuma'),
         case when not exists (select 1 from pg_proc p join new_functions n on n.fn = p.proname where p.pronamespace = 'public'::regnamespace) then 'OK' else 'FALHOU' end
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
)
select check_name, result, status from checks
union all
select 'STANDBY_PAINEL_PREFLIGHT_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
