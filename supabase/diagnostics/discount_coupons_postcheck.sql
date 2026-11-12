-- CUPONS DE DESCONTO, FASE 2 (BANCO E REGRAS) — POSTCHECK (SOMENTE LEITURA)
--
-- Rodar no SQL Editor DEPOIS de `202611020001_discount_coupons.sql`. Um único
-- SELECT no formato check_name | result | status. Nenhuma escrita e nenhum dado
-- pessoal retornado.
--
--   OK       — como esperado.
--   ATENCAO  — não é falha da migration, mas precisa ser lido (cupons já
--              cadastrados, valor mínimo já gravado).
--   FALHOU   — a migration não ficou como o repositório define: não siga.
--
-- A linha final, CUPONS_POSTCHECK_OK, fica OK quando nenhuma linha FALHOU.
-- ASSINATURA_DAS_OUTRAS_FUNCOES e RESERVAS_POR_STATUS precisam ser iguais às
-- do preflight (as reservas podem mudar com vendas entre um e outro).

with expected(sig, kind, exact, norm) as (values
    ('public.enforce_coupon_redemption_history()', 'TRIGGER', 'e0b12fc802bcc54436ecdd103ef1d21a', '5de54e45ce1dec585199716a30c551fc'),
    ('public.coupon_normalize_code(text)', 'INTERNA', 'b2b118cb78ad38faf374f3abdaa5d7b6', 'dbc4f6c794fd94bea46bfcea980551ea'),
    ('public.coupon_today()', 'INTERNA', '5e07a408e84061be4d746e1a64430c7e', '2c3c7435049c13600f35facbe409a805'),
    ('public.coupon_discounted_unit_cents(integer,integer)', 'INTERNA', 'a56191b7148c676bc376f6f16665a47b', 'ddf5e88553317f59f4ba65d7b495fedd'),
    ('public.coupon_redemption_state(timestamptz,text,timestamptz,timestamptz)', 'INTERNA', '5e6b783fec065f7807d7c06948cf2d29', '78eb39a461e5c19c71c79ed349c6a18a'),
    ('public.coupon_uses(uuid)', 'INTERNA', '50bab3d5c19e2cc51c2b709b1bae17e8', '4627ec26cd8cb4fecbcef42433b79c58'),
    ('public.coupon_rejection(uuid,uuid)', 'INTERNA', 'd1986cbc99076dfd304de809e227fd05', '4344a9f37014539e67789dd94564f3cf'),
    ('public.coupon_price_rejection(integer,integer,integer)', 'INTERNA', '74c426b994f3a016f2cf93e72a8c31c1', '90b82453a268f2a2d734f67bc38a8866'),
    ('public.coupon_reservation_summary(uuid)', 'INTERNA', 'efac6355aeb584ec691d0f70bb36fd2b', 'ac68e62851d58634cc6e3cc22399b694'),
    ('public.coupon_admin_input_error(text,integer,date,date,integer,text,uuid[],text)', 'INTERNA', '3948dc287dcf92ac3ba44f150dfb784a', '08a980dc72fe1016e04d07db77093e6d'),
    ('public.admin_coupon_json(uuid)', 'INTERNA', '3f708ca3db96a001bd5e8df3fcefc0a8', 'a9bc3857377d4075a2f385f930389d5a'),
    ('public.preview_coupon(uuid,integer,text)', 'SERVIDOR', '5af1ffe03b279939c2b30db183c954db', '78c048231ed1201b82e83ef6b461ca00'),
    ('public.coupon_field_visible(uuid)', 'SERVIDOR', 'c904e65fc2a29bcb12d8bd0385ce604f', '2851dfdfc60a235d791dd51e40ec4f29'),
    ('public.create_pre_reservation_with_coupon(uuid,text,text,text,text,integer,text,uuid,text)', 'SERVIDOR', '9be31c3bded8f23fe0b9ddb75f57d1fc', '82505ff330792e60d43906052f596ee6'),
    ('public.admin_list_coupons(uuid)', 'SERVIDOR', '0f12af5b4f39689eb9dee449aa4b98a2', '887ba3d247a869269b92ff5ec4ef1933'),
    ('public.admin_get_coupon(uuid,uuid)', 'SERVIDOR', '55714e8a27841edf0959414de832c588', '0723ecf67a97fef7205962071f8140fb'),
    ('public.admin_create_coupon(uuid,text,integer,date,date,integer,text,uuid[],text,text)', 'SERVIDOR', '78911030ded61b5ba9f11720d9f16ad2', 'ea14873c04b5313450e54e3cc3ef6d86'),
    ('public.admin_update_coupon(uuid,uuid,text,integer,date,date,integer,text,uuid[],text)', 'SERVIDOR', '549461676a5dfffaa9ec0442c11c450f', '4c41c392a742782ecdf25031f9be0619'),
    ('public.admin_set_coupon_status(uuid,uuid,text,text)', 'SERVIDOR', 'fae83b110fca127d8a987b6e27aca68b', '8cb62037ac860dd28aac493014f42f1c'),
    ('public.admin_release_coupon_redemption(uuid,uuid,text)', 'SERVIDOR', '90f45ac3aa49c911ee3a683f75a5cd09', '124e502f423ef8f0b66f0ba5abde3a71'),
    ('public.reservation_standby_target_rejection(uuid,uuid,text)', 'ALTERADA', '64f05ef00bb7b440789d33f5028b7457', 'd4703a1a9e00ef9bd54b6fcdc4066cf9')
),
functions as (
  select e.sig, e.kind, p.oid,
         case when p.oid is null then 'AUSENTE'
              when md5(p.prosrc) = e.exact then 'IDENTICA'
              when md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g')) = e.norm then 'IDENTICA_SO_FORMATACAO'
              else 'DIFERENTE' end as verdict
  from expected e left join pg_proc p on p.oid = to_regprocedure(e.sig)
),
-- Servidor: só a service role executa. Interna, alterada e gatilho: ninguém pela API.
wrong_privileges as (
  select regexp_replace(sig, '^public\.|\(.*$', '', 'g') as fn from functions
  where oid is null
     or has_function_privilege('anon', oid, 'EXECUTE')
     or has_function_privilege('authenticated', oid, 'EXECUTE')
     or (kind = 'SERVIDOR' and not has_function_privilege('service_role', oid, 'EXECUTE'))
     or (kind <> 'SERVIDOR' and has_function_privilege('service_role', oid, 'EXECUTE'))
),
tables(name) as (values ('coupons'), ('coupon_experiences'), ('coupon_redemptions'), ('coupon_settings')),
open_tables as (
  select t.name from tables t left join pg_class c on c.oid = to_regclass('public.' || t.name)
  where c.oid is null
     or not c.relrowsecurity
     or exists (select 1 from pg_policy pol where pol.polrelid = c.oid)
     or has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('anon', c.oid, 'INSERT')
     or has_table_privilege('authenticated', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'INSERT')
     or has_table_privilege('authenticated', c.oid, 'UPDATE') or has_table_privilege('authenticated', c.oid, 'DELETE')
     or has_table_privilege('service_role', c.oid, 'SELECT') or has_table_privilege('service_role', c.oid, 'UPDATE')
),
checks as (
  select 'FUNCOES_NOVAS_COM_A_DEFINICAO_DO_REPOSITORIO' as check_name,
         (select count(*) filter (where verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO'))::text || ' de ' || count(*)::text from functions where kind <> 'ALTERADA')
           || coalesce(' — ' || (select string_agg(regexp_replace(sig, '^public\.|\(.*$', '', 'g') || '=' || verdict, ', ') from functions where kind <> 'ALTERADA' and verdict in ('AUSENTE', 'DIFERENTE')), '') as result,
         case when exists (select 1 from functions where kind <> 'ALTERADA' and verdict in ('AUSENTE', 'DIFERENTE')) then 'FALHOU' else 'OK' end as status
  union all
  select 'REGUA_DE_PRECO_DO_STANDBY',
         (select verdict from functions where kind = 'ALTERADA'),
         case when (select verdict from functions where kind = 'ALTERADA') in ('IDENTICA', 'IDENTICA_SO_FORMATACAO') then 'OK' else 'FALHOU' end
  union all
  select 'PERMISSOES_DAS_FUNCOES',
         coalesce((select string_agg(fn, ', ' order by fn) from wrong_privileges), 'só a service role executa as RPCs do servidor'),
         case when exists (select 1 from wrong_privileges) then 'FALHOU' else 'OK' end
  union all
  select 'TABELAS_FECHADAS',
         coalesce((select string_agg(name, ', ' order by name) from open_tables), '4 tabelas com RLS, sem política e sem acesso direto'),
         case when exists (select 1 from open_tables) then 'FALHOU' else 'OK' end
  union all
  -- O rollback trava só reservations e experiences além das tabelas de cupom:
  -- nenhuma chave estrangeira pode apontar para outra tabela.
  select 'CHAVES_ESTRANGEIRAS_DOS_CUPONS',
         coalesce((select string_agg(distinct con.confrelid::regclass::text, ', ' order by con.confrelid::regclass::text)
                   from pg_constraint con
                   where con.contype = 'f'
                     and con.conrelid in (select to_regclass('public.' || name) from tables)
                     and con.confrelid not in (select to_regclass('public.' || name) from tables)), 'nenhuma'),
         case when exists (select 1 from pg_constraint con
                           where con.contype = 'f'
                             and con.conrelid in (select to_regclass('public.' || name) from tables)
                             and con.confrelid not in ('public.reservations'::regclass, 'public.experiences'::regclass)
                             and con.confrelid not in (select to_regclass('public.' || name) from tables)) then 'FALHOU' else 'OK' end
  union all
  select 'GATILHO_DO_HISTORICO',
         (select count(*)::text from pg_trigger where tgname = 'coupon_redemptions_history_guard' and tgrelid = to_regclass('public.coupon_redemptions')),
         case when exists (select 1 from pg_trigger where tgname = 'coupon_redemptions_history_guard' and tgrelid = to_regclass('public.coupon_redemptions')) then 'OK' else 'FALHOU' end
  union all
  select 'CUPONS_CADASTRADOS',
         (select count(*)::text || ' cupom(ns), ' || (select count(*) from public.coupon_redemptions)::text || ' uso(s)' from public.coupons),
         case when exists (select 1 from public.coupons) then 'ATENCAO' else 'OK' end
  union all
  select 'VALOR_MINIMO',
         coalesce((select case when min_charge_cents is null then 'não definido (nenhum cupom é aplicado)' else min_charge_cents::text || ' centavos' end from public.coupon_settings where singleton), 'linha ausente'),
         case when not exists (select 1 from public.coupon_settings where singleton) then 'FALHOU'
              when (select min_charge_cents from public.coupon_settings where singleton) is null then 'OK'
              else 'ATENCAO' end
  union all
  select 'ASSINATURA_DAS_OUTRAS_FUNCOES',
         (select count(*)::text || ' funções, ' || md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), '|' order by p.oid::regprocedure::text))
          from pg_proc p where p.pronamespace = 'public'::regnamespace
            and p.oid not in (select oid from functions where oid is not null)),
         'OK'
  union all
  select 'RESERVAS_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.reservations group by 1) x),
         'OK'
)
select check_name, result, status from checks
union all
select 'CUPONS_POSTCHECK_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
