-- LISTA DE ESPERA, FASE 3 (E-MAIL DE CONFIRMAÇÃO) — POSTCHECK (SOMENTE LEITURA)
--
-- Rodar no SQL Editor DEPOIS de `202610250002_waitlist_signup_email.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita e
-- nenhum dado pessoal retornado.
--
-- A linha final, WAITLIST_EMAIL_POSTCHECK_OK, fica OK quando nenhuma linha
-- FALHOU. ASSINATURA_DAS_FUNCOES_EXISTENTES e as contagens precisam devolver os
-- mesmos valores do preflight: a migration não substitui função nem toca linha.
-- Rodado antes da migration, falha com "column does not exist" em vez de aprovar.

with expected(fn, kind, exact, norm) as (values
    ('claim_pending_waitlist_emails', 'SERVIDOR', '3f651f5e4ed8757fd70527c75cfc9cad', 'd2e9a2b1915ffd9bd6129a199376a31a'),
    ('claim_waitlist_joined_email', 'SERVIDOR', '945bc41f583f8f798d2d4cf9e095f43e', '001362a80d2a479f0960576cf1fda135'),
    ('complete_waitlist_email', 'SERVIDOR', '7471592eb8da6e49918ef02546dd712b', '65a1593175ef74d33c51d888d13a13dd'),
    ('fail_waitlist_email', 'SERVIDOR', '3cf7275d494382311ba91de409d5fb30', 'aad45a5ac4ed4bdb93f77eac073f0dac'),
    ('freeze_waitlist_email', 'SERVIDOR', '115df869ac486f60c3ed3c283217ce89', '7057e507f8a3e6598d732db389d49430'),
    ('waitlist_notification_payload', 'INTERNA', '9857123156a3d70d4ce77778efe3d8b1', '057220b5cf66701b058c5766b15ce6bf'),
    ('waitlist_notification_rejection', 'INTERNA', 'eecd45cfa332d62f6218c2709b05846a', '7760099980c5a36c10f9cf249e4c82e8'),
    ('waitlist_notification_take', 'INTERNA', '125dfeb9c649030351d3b5819afe33a6', '188614791ec957cfa634adde65be44e1'),
    ('waitlist_cancel_token', 'FASE_1', 'c4fc03a731bc475353af6925d9314993', 'b8e0445c63e079608b992ad6927df767'),
    ('waitlist_effective_status', 'FASE_1', 'd5a07aebaeb8130337789377c0510de4', '3db793a67755fcfa5d0b792653e00a17'),
    ('waitlist_join', 'FASE_1', 'ea1804d2f2469e88aab92b72f210e804', '6f7b02560e23cc70b76b6aeac22effdb'),
    ('waitlist_skip_pending_notifications', 'FASE_1', 'c76881471c82db58e1791c14aeff9414', '62a87376506864938255dc9d17ecfcb2')
),
prod as (
  select p.oid, p.proname as fn,
         md5(p.prosrc) as exact,
         md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g')) as norm,
         p.prosecdef, p.proconfig, count(*) over (partition by p.proname) as overloads
  from pg_proc p where p.pronamespace = 'public'::regnamespace
),
functions as (
  select e.fn, e.kind, pr.oid, pr.prosecdef, pr.proconfig,
         case when pr.fn is null then 'AUSENTE'
              when pr.overloads > 1 then 'SOBRECARGA'
              when pr.exact = e.exact then 'IDENTICA'
              when pr.norm = e.norm then 'IDENTICA_SO_FORMATACAO'
              else 'DIFERENTE' end as verdict
  from expected e left join prod pr on pr.fn = e.fn
),
created as (select * from functions where kind in ('SERVIDOR', 'INTERNA')),
wrong_grants as (
  select fn from created
  where oid is null
     or has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE')
     or (kind = 'SERVIDOR' and not has_function_privilege('service_role', oid, 'EXECUTE'))
     or (kind = 'INTERNA' and has_function_privilege('service_role', oid, 'EXECUTE'))
),
closed_tables as (
  select c.relname,
         c.relrowsecurity and (select count(*) from pg_policy p where p.polrelid = c.oid) = 0
           and not exists (
             select 1 from unnest(array['anon', 'authenticated', 'service_role']) r(role),
                           unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p(priv)
             where has_table_privilege(r.role, c.oid, p.priv)
           ) as closed
  from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relname in ('waitlist_notifications', 'waitlist_notification_attempts')
),
checks as (
  select 'FUNCOES_NOVAS_COM_A_DEFINICAO_DO_REPOSITORIO' as check_name,
         (select count(*) filter (where verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO'))::text || ' de ' || count(*)::text
                 || coalesce(' | ' || string_agg(fn || '=' || verdict, ', ' order by fn) filter (where verdict not in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')), '')
          from created) as result,
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from created) then 'OK' else 'FALHOU' end as status
  union all
  select 'FUNCOES_SECURITY_DEFINER_COM_SEARCH_PATH',
         coalesce((select string_agg(fn, ', ' order by fn) from created
                   where not coalesce(prosecdef, false) or proconfig is null or not exists (select 1 from unnest(proconfig) c where c like 'search_path=%')), 'todas'),
         case when not exists (select 1 from created where not coalesce(prosecdef, false) or proconfig is null or not exists (select 1 from unnest(proconfig) c where c like 'search_path=%')) then 'OK' else 'FALHOU' end
  union all
  select 'PERMISSOES_DAS_FUNCOES',
         (select count(*) filter (where kind = 'SERVIDOR')::text || ' do servidor, ' || count(*) filter (where kind = 'INTERNA')::text || ' internas' from created)
           || coalesce(' | erradas: ' || (select string_agg(fn, ', ' order by fn) from wrong_grants), ''),
         case when exists (select 1 from wrong_grants) then 'FALHOU' else 'OK' end
  union all
  select 'FUNCOES_DA_FASE_1_INALTERADAS',
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions where kind = 'FASE_1'),
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from functions where kind = 'FASE_1') then 'OK' else 'FALHOU' end
  union all
  select 'COLUNAS_NOVAS',
         (select string_agg(table_name || '.' || column_name, ', ' order by table_name, column_name) from information_schema.columns
          where table_schema = 'public'
            and ((table_name = 'waitlist_notifications' and column_name in ('generation_uncertain', 'generation_started_at'))
              or (table_name = 'waitlist_notification_attempts' and column_name = 'claim_token'))),
         case when (select count(*) from information_schema.columns
                    where table_schema = 'public'
                      and ((table_name = 'waitlist_notifications' and column_name in ('generation_uncertain', 'generation_started_at'))
                        or (table_name = 'waitlist_notification_attempts' and column_name = 'claim_token'))) = 3 then 'OK' else 'FALHOU' end
  union all
  -- Lê a coluna nova direto: antes da migration, o postcheck falha em vez de aprovar.
  select 'GERACOES_COM_RESULTADO_INCERTO',
         (select count(*) filter (where generation_uncertain)::text from public.waitlist_notifications),
         'OK'
  union all
  select 'TABELAS_DA_FILA_CONTINUAM_FECHADAS',
         coalesce((select string_agg(relname, ', ' order by relname) from closed_tables where not closed), 'todas fechadas'),
         case when (select count(*) = 2 from closed_tables where closed) then 'OK' else 'FALHOU' end
  union all
  select 'TOKEN_DA_TENTATIVA_UNICO',
         coalesce((select 'presente' from pg_class c join pg_index i on i.indexrelid = c.oid
                   where c.relname = 'waitlist_notification_attempts_token_key' and i.indisunique), 'ausente'),
         case when exists (select 1 from pg_class c join pg_index i on i.indexrelid = c.oid
                           where c.relname = 'waitlist_notification_attempts_token_key' and i.indisunique) then 'OK' else 'FALHOU' end
  union all
  select 'NENHUM_AGENDAMENTO_DA_LISTA',
         coalesce((select string_agg(jobname, ', ' order by jobname) from cron.job where jobname ilike '%waitlist%'), 'nenhum'),
         case when exists (select 1 from cron.job where jobname ilike '%waitlist%') then 'FALHOU' else 'OK' end
  union all
  select 'ASSINATURA_DAS_FUNCOES_EXISTENTES',
         (select count(*)::text || ' funções, ' || md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), '|' order by p.oid::regprocedure::text))
          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not in (select fn from created)),
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
select 'WAITLIST_EMAIL_POSTCHECK_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
