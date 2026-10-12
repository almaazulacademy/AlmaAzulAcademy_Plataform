-- PAINEL DE STAND-BY — PREFLIGHT (SOMENTE LEITURA)
--
-- Rodar no SQL Editor ANTES de `202610140001_reservation_standby_admin_panel.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita,
-- nenhuma função nova e nenhum dado pessoal retornado.
--
-- A linha final, STANDBY_PAINEL_PREFLIGHT_OK, só fica OK quando todas as outras
-- estão. Guarde RESERVAS_POR_STATUS, EVENTOS_DE_PAGAMENTO, HISTORICO_DE_TROCAS e
-- AUTORIZACOES_DE_STANDBY: o postcheck precisa devolver os mesmos números.
--
-- FUNCOES_DE_QUE_O_PAINEL_DEPENDE confere que as peças da etapa anterior estão
-- em produção com a definição do repositório. A migration não altera nenhuma
-- delas: só as chama.

with expected(fn, lf, crlf) as (values
    ('admin_change_reservation_session', '02510c8110db73848ed0e8d0046533b2', ''),
    ('reservation_latest_standby', '769baa3c30a33be6bce7f708e0bb0841', '51d73805e9495a5f1de6a016644c8af4'),
    ('reservation_standby_resolve', 'ee2c16b8a8e2960656a6eb45c8021924', '0d0eef68e34f06f31639971e8c4e9fdb'),
    ('reservation_standby_target_rejection', '202b1b5e84a5e0b387bfd94b1e4ed6e4', '958d5d630c0d8d5af66278a9ff571721')
),
prod as (
  select p.proname as fn, md5(p.prosrc) as h, md5(replace(replace(p.prosrc, E'\r\n', E'\n'), E'\r', '')) as h_lf,
         count(*) over (partition by p.proname) as overloads
  from pg_proc p where p.pronamespace = 'public'::regnamespace
),
functions as (
  select e.fn,
         case when pr.fn is null then 'AUSENTE'
              when pr.overloads > 1 then 'SOBRECARGA'
              when pr.h = e.lf then 'IDENTICA'
              when pr.h = e.crlf or pr.h_lf = e.lf then 'IDENTICA_CRLF'
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
         to_regclass('public.reservation_standby') is not null
           and exists (select 1 from pg_trigger where tgrelid = 'public.reservations'::regclass and tgname = 'reservations_standby_guard' and tgenabled = 'O') as ok
  union all
  select 'FUNCOES_DE_QUE_O_PAINEL_DEPENDE',
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions),
         (select bool_and(verdict in ('IDENTICA', 'IDENTICA_CRLF')) from functions)
  union all
  select 'FUNCOES_DO_PAINEL_AINDA_NAO_EXISTEM',
         coalesce((select string_agg(p.proname, ', ' order by p.proname) from pg_proc p join new_functions n on n.fn = p.proname where p.pronamespace = 'public'::regnamespace), 'nenhuma'),
         not exists (select 1 from pg_proc p join new_functions n on n.fn = p.proname where p.pronamespace = 'public'::regnamespace)
  union all
  select 'RESERVAS_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.reservations group by 1) x),
         true
  union all
  select 'EVENTOS_DE_PAGAMENTO', (select count(*)::text from public.payment_events), true
  union all
  select 'HISTORICO_DE_TROCAS', (select count(*)::text from public.reservation_session_changes), true
  union all
  select 'AUTORIZACOES_DE_STANDBY',
         (select count(*)::text || ' no total, ' || count(*) filter (where resolved_at is null)::text || ' aberta(s)' from public.reservation_standby),
         true
)
select check_name, result, case when ok then 'OK' else 'FALHOU' end as status from checks
union all
select 'STANDBY_PAINEL_PREFLIGHT_OK', (select count(*) filter (where not ok)::text || ' falha(s)' from checks),
       case when (select bool_and(ok) from checks) then 'OK' else 'FALHOU' end;
