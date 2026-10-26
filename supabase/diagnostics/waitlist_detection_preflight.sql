-- LISTA DE ESPERA, FASE 5 (DETECÇÃO DE VAGAS) — PREFLIGHT (SOMENTE LEITURA)
--
-- Rodar no SQL Editor ANTES de `202610260001_waitlist_detection.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita e
-- nenhum dado pessoal retornado.
--
--   OK       — pode seguir.
--   ATENCAO  — não bloqueia, mas precisa ser lido antes de seguir.
--   FALHOU   — interrompe: a migration não deve ser aplicada.
--
-- A linha final, WAITLIST_DETECCAO_PREFLIGHT_OK, fica OK quando nenhuma linha
-- FALHOU. Guarde ASSINATURA_DAS_FUNCOES_EXISTENTES e as contagens: o postcheck
-- precisa devolver os mesmos valores.
--
-- A varredura chama `available_spots` (vagas) e, da fase 1, a régua das ondas
-- (`waitlist_eligible_entries`, `waitlist_wave_size`), a expiração e a
-- conversão. Conteúdo diferente do repositório em qualquer uma é FALHOU.
-- `set_updated_at` diferente é ATENCAO.

with expected(fn, severity, exact, norm) as (values
    ('available_spots', 'FALHOU', '0fe290aa82248812c1c035354d94e2fa', 'a3050f894ad24f6262b2b80d1d3a752f'),
    ('waitlist_eligible_entries', 'FALHOU', '34079b42518195d56fdcee936cd341de', 'fc7a55b6c2c1933aa4cbe554cf79b4f2'),
    ('waitlist_expire_entries', 'FALHOU', 'e089f98f87c3343b95564ec168f64a0a', 'e3ed7398ed28d180c50f96fd8fabb9e4'),
    ('waitlist_mark_conversions', 'FALHOU', '66d3e7e8ab76341a645ceb6cc14bca6b', '7531f851c0e56a47044ce77559d4bb6d'),
    ('waitlist_skip_pending_notifications', 'FALHOU', 'c76881471c82db58e1791c14aeff9414', '62a87376506864938255dc9d17ecfcb2'),
    ('waitlist_wave_size', 'FALHOU', 'bbc23d8db36d4689225b13e08138838b', 'b4149df44c87eb19aa56933e1325051f'),
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
new_names(name) as (values ('waitlist_detection_spots'), ('waitlist_scan_session'), ('waitlist_scan')),
present as (
  select name from new_names where exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = new_names.name)
  union all
  select 'tabela waitlist_settings' where to_regclass('public.waitlist_settings') is not null
  union all
  select 'coluna waitlist_openings.closed_reason'
  where exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'waitlist_openings' and column_name = 'closed_reason')
),
checks as (
  select 'FUNCOES_QUE_A_VARREDURA_CHAMA' as check_name,
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions where severity = 'FALHOU') as result,
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from functions where severity = 'FALHOU') then 'OK' else 'FALHOU' end as status
  union all
  select 'FUNCOES_DE_APOIO',
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions where severity = 'ATENCAO'),
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from functions where severity = 'ATENCAO') then 'OK'
              when (select bool_or(verdict in ('AUSENTE', 'SOBRECARGA')) from functions where severity = 'ATENCAO') then 'FALHOU'
              else 'ATENCAO' end
  union all
  select 'TABELAS_DA_LISTA',
         (select count(*)::text || ' de 3' from (values ('waitlist_entries'), ('waitlist_openings'), ('waitlist_notifications')) t(name) where to_regclass('public.' || name) is not null),
         case when to_regclass('public.waitlist_entries') is not null and to_regclass('public.waitlist_openings') is not null
               and to_regclass('public.waitlist_notifications') is not null then 'OK' else 'FALHOU' end
  union all
  -- A fase 3 é a que separa o JOINED do SPOT_AVAILABLE nas funções de envio.
  select 'FASE_3_APLICADA',
         coalesce((select 'presente' from information_schema.columns where table_schema = 'public' and table_name = 'waitlist_notifications' and column_name = 'generation_uncertain'), 'ausente'),
         case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'waitlist_notifications' and column_name = 'generation_uncertain') then 'OK' else 'FALHOU' end
  union all
  -- A detecção é pensada para o mesmo pg_cron que já expira as pré-reservas.
  select 'PG_CRON_EM_USO',
         coalesce((select string_agg(jobname || '=' || schedule || case when active then '' else ' (inativo)' end, ', ' order by jobname) from cron.job), 'nenhum agendamento'),
         case when exists (select 1 from cron.job where jobname = 'expire-alma-azul-pre-reservations' and active) then 'OK' else 'ATENCAO' end
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
  select 'ABERTURAS',
         (select count(*)::text || ' no total, ' || count(*) filter (where closed_at is null)::text || ' abertas' from public.waitlist_openings),
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
select 'WAITLIST_DETECCAO_PREFLIGHT_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
