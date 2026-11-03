-- CUPONS DE DESCONTO, FASE 2 (BANCO E REGRAS) — PREFLIGHT (SOMENTE LEITURA)
--
-- Rodar no SQL Editor ANTES de `202611020001_discount_coupons.sql` — e não
-- antes de 08/11/2026. Um único SELECT no formato check_name | result | status.
-- Nenhuma escrita e nenhum dado pessoal retornado.
--
--   OK       — como esperado.
--   ATENCAO  — não impede, mas precisa ser lido (por exemplo, objetos de
--              cupom já existentes de uma tentativa anterior).
--   FALHOU   — não aplique a migration.
--
-- A linha final, CUPONS_PREFLIGHT_OK, fica OK quando nenhuma linha FALHOU.
-- Guarde ASSINATURA_DAS_OUTRAS_FUNCOES e RESERVAS_POR_STATUS: o postcheck
-- repete as duas.

with expected(fn, sig, base_norm, new_norm) as (values
    -- Envolvida pela pré-reserva com cupom; não muda.
    ('create_pre_reservation', 'public.create_pre_reservation(uuid,text,text,text,text,integer,text,uuid)', '6a16330cf94c085cea3ff6c57628fec2', null),
    -- A única reescrita pela migration (régua de preço do Stand-by).
    ('reservation_standby_target_rejection', 'public.reservation_standby_target_rejection(uuid,uuid,text)', '2ba6e8597a398c70dfde960adc0f78d8', 'd4703a1a9e00ef9bd54b6fcdc4066cf9'),
    ('is_active_admin', 'public.is_active_admin(uuid)', 'b4560566fbfc891fa821d4264ae24f69', null),
    ('is_active_owner_admin', 'public.is_active_owner_admin(uuid)', '883d57ae9ce51081b910fd49e1ab5838', null),
    -- A contagem de usos depende de como estas mexem em status, confirmed_at e expires_at.
    ('confirm_reservation_payment', 'public.confirm_reservation_payment(uuid,text,text,integer,text,jsonb)', '79bcc19a28e3e1c78005a7825e9781b2', null),
    ('reconcile_reservation_payment', 'public.reconcile_reservation_payment(uuid,text,text,integer,text,jsonb)', '31a70e76e11d442141a183c0a7526c0a', null),
    ('expire_pre_reservations', 'public.expire_pre_reservations()', '3521d8de9efd48a52305682fac2fab09', null)
),
functions as (
  select e.fn,
         case when p.oid is null then 'AUSENTE'
              when (select count(*) from pg_proc o where o.pronamespace = 'public'::regnamespace and o.proname = e.fn) > 1 then 'SOBRECARGA'
              when md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g')) = e.base_norm then 'CORPO_ATUAL'
              when md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g')) = e.new_norm then 'JA_COM_A_MUDANCA'
              else 'DIFERENTE' end as verdict
  from expected e left join pg_proc p on p.oid = to_regprocedure(e.sig)
),
new_tables(name) as (values ('coupons'), ('coupon_experiences'), ('coupon_redemptions'), ('coupon_settings')),
new_functions(name) as (values
  ('enforce_coupon_redemption_history'), ('coupon_normalize_code'), ('coupon_today'), ('coupon_discounted_unit_cents'),
  ('coupon_redemption_state'), ('coupon_uses'), ('coupon_rejection'), ('coupon_price_rejection'), ('coupon_reservation_summary'),
  ('preview_coupon'), ('coupon_field_visible'), ('create_pre_reservation_with_coupon'), ('coupon_admin_input_error'),
  ('admin_coupon_json'), ('admin_list_coupons'), ('admin_get_coupon'), ('admin_create_coupon'), ('admin_update_coupon'),
  ('admin_set_coupon_status'), ('admin_release_coupon_redemption')
),
existing_new as (
  select name from new_tables where to_regclass('public.' || name) is not null
  union all
  select name from new_functions where exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = name)
),
-- `total_cents` precisa acompanhar `unit_price_cents`: coluna gerada (repositório)
-- ou gatilho + CHECK (schema legado). Sem isso, o desconto não chegaria ao total.
total_cents as (
  select a.attgenerated <> '' as generated,
         exists (select 1 from pg_trigger t where t.tgrelid = 'public.reservations'::regclass and not t.tgisinternal
                 and t.tgfoid = to_regprocedure('public.set_reservation_total_cents()')) as triggered
  from pg_attribute a
  where a.attrelid = 'public.reservations'::regclass and a.attname = 'total_cents' and not a.attisdropped
),
reservation_columns as (
  select string_agg(column_name, ',' order by column_name) as present
  from information_schema.columns
  where table_schema = 'public' and table_name = 'reservations'
    and column_name in ('unit_price_cents', 'total_cents', 'quantity', 'confirmed_at', 'expires_at', 'idempotency_key', 'status')
),
checks as (
  select 'FUNCOES_QUE_A_MIGRATION_USA' as check_name,
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions) as result,
         case when exists (select 1 from functions where verdict in ('AUSENTE', 'SOBRECARGA', 'DIFERENTE')) then 'FALHOU'
              when exists (select 1 from functions where verdict = 'JA_COM_A_MUDANCA') then 'ATENCAO'
              else 'OK' end as status
  union all
  select 'OBJETOS_NOVOS_AINDA_AUSENTES',
         coalesce((select string_agg(name, ', ' order by name) from existing_new), 'nenhum existe'),
         case when exists (select 1 from existing_new) then 'ATENCAO' else 'OK' end
  union all
  select 'TOTAL_ACOMPANHA_O_UNITARIO',
         coalesce((select case when generated then 'coluna gerada' when triggered then 'gatilho set_reservation_total_cents' else 'nenhum mecanismo' end from total_cents), 'sem coluna total_cents'),
         case when (select generated or triggered from total_cents) then 'OK' else 'FALHOU' end
  union all
  select 'COLUNAS_DA_RESERVA',
         coalesce((select present from reservation_columns), 'nenhuma'),
         case when (select present from reservation_columns) = 'confirmed_at,expires_at,idempotency_key,quantity,status,total_cents,unit_price_cents' then 'OK' else 'FALHOU' end
  union all
  select 'DEPENDENCIAS',
         'kind=' || exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'experiences' and column_name = 'kind')::text
           || ', admin_audit_log=' || (to_regclass('public.admin_audit_log') is not null)::text
           || ', admin_users=' || (to_regclass('public.admin_users') is not null)::text
           || ', auth.users=' || (to_regclass('auth.users') is not null)::text,
         case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'experiences' and column_name = 'kind')
               and to_regclass('public.admin_audit_log') is not null and to_regclass('public.admin_users') is not null
               and to_regclass('auth.users') is not null then 'OK' else 'FALHOU' end
  union all
  select 'ASSINATURA_DAS_OUTRAS_FUNCOES',
         (select count(*)::text || ' funções, ' || md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), '|' order by p.oid::regprocedure::text))
          from pg_proc p where p.pronamespace = 'public'::regnamespace
            and p.proname <> 'reservation_standby_target_rejection'
            and p.proname not in (select name from new_functions)),
         'OK'
  union all
  select 'RESERVAS_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.reservations group by 1) x),
         'OK'
  union all
  select 'RESERVAS_EM_STANDBY',
         (select count(*)::text from public.reservations where status::text = 'AWAITING_RESCHEDULE'),
         'OK'
)
select check_name, result, status from checks
union all
select 'CUPONS_PREFLIGHT_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
