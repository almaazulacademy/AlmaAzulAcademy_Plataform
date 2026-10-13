-- E-MAIL DE REAGENDAMENTO — POSTCHECK (SOMENTE LEITURA)
--
-- Rodar no SQL Editor DEPOIS de `202610150001_reservation_reschedule_email.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita e
-- nenhum dado pessoal retornado.
--
-- Três estados: OK, ATENCAO (não é falha da migration, mas precisa ser lido) e
-- FALHOU. A linha final, STANDBY_EMAIL_POSTCHECK_OK, fica OK quando nenhuma
-- linha FALHOU; o texto dela diz quantos pontos de atenção existem. As cinco
-- contagens precisam devolver os mesmos números do preflight (fora o que
-- aconteceu de verdade no site entre as duas execuções): a migration cria
-- tabelas, uma trigger e funções, e não toca nenhuma linha existente.
--
-- As funções são conferidas como no preflight: pelo texto exato e pelo texto com
-- o espaço em branco normalizado. Diferença só de formatação vira
-- IDENTICA_SO_FORMATACAO e continua OK; diferença de conteúdo é DIFERENTE. Para
-- as treze funções criadas e para `reservation_standby_resolve`, DIFERENTE é
-- FALHOU. Para as três de apoio, é ATENCAO.

with expected(fn, kind, exact, norm) as (values
    ('admin_claim_reservation_reschedule_email', 'OPERACAO', 'd48ef8b29ee9d0d94541f1e7388c96ed', '1dd9fb0a7a7aacfdf19a216b1c2a7b2c'),
    ('admin_list_undelivered_reschedule_emails', 'OPERACAO', '0cc7dd18a8bcaaeea7881e0c7f6df3f2', 'a5afe16db6c262d782a69da920a78089'),
    ('admin_reservation_reschedule_emails', 'OPERACAO', '8d0c4e4775da0fb3a6ccc7ca5a96a9c1', '6c8de5ad7586fb72fdd0425a6017c048'),
    ('claim_pending_reservation_reschedule_emails', 'OPERACAO', 'bf2e671a470da132a2a17e2eb263dd38', '80cb49c28c71f8d541f01ae5db1135e6'),
    ('claim_reservation_reschedule_email', 'OPERACAO', '4d78bc97bf50f34716daf034d9743c4a', 'cea930a805b1307ae321ae1778cf4364'),
    ('complete_reservation_reschedule_email', 'OPERACAO', 'f6fe4e6011cd3488a89b0da9bbbf658c', '55dbff363263d4dcffeacc6387217795'),
    ('fail_reservation_reschedule_email', 'OPERACAO', 'c498ba5ea42e8cda6d0df266e89d6964', 'b03c9aa3569380877a883b31a11f562c'),
    ('freeze_reservation_reschedule_email', 'OPERACAO', '47dda81cc620092c8a586956312d36be', 'f59f31d3dfa80a209af8fe37e7eb4259'),
    ('enqueue_reservation_reschedule_email', 'INTERNA', '725e61168020dd101290e9fc3112cd18', '66f6e6734a32211d07b15cac1bd0aa1a'),
    ('reservation_reschedule_email_fingerprint', 'INTERNA', 'd00cd9347802a1dfe1a8833c9b98b490', '1afa3b09ea103af7921060ca3cc956ca'),
    ('reservation_reschedule_email_payload', 'INTERNA', '507c881d4cafd8d7b1333d08fddc2aaf', 'df46dbde232095b8987033dcf00a8777'),
    ('reservation_reschedule_email_rejection', 'INTERNA', 'b6ebf8700224ca45a30feb7f2e063df4', 'c0f470ab07ffbd5564c3e46a06d883a7'),
    ('reservation_reschedule_email_take', 'INTERNA', '60396b777957aca393dd059fcd831adc', '92c46cc79cfa983420a6db5127950df8'),
    ('reservation_standby_resolve', 'ORIGEM', 'ee2c16b8a8e2960656a6eb45c8021924', 'd8a5f75fdaf19ae2926cac272fac224b'),
    ('is_active_admin', 'APOIO', 'd4a5f6d71d3732cca38bd0a73ae12620', 'b4560566fbfc891fa821d4264ae24f69'),
    ('reservation_confirmation_email', 'APOIO', '6b53ea280f7cfcc91d4d756bd6348ecf', '27c37a1249bb3baebe60366e0dd9402e'),
    ('set_updated_at', 'APOIO', '9b1889f56258bf9d6554213c05019c76', '077bb7aa35a4fed76f447b242607c205')
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
created as (select * from functions where kind in ('OPERACAO', 'INTERNA')),
queue_tables as (
  select c.oid, c.relname, c.relrowsecurity,
         (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
  from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relname in ('reservation_reschedule_emails', 'reservation_reschedule_email_attempts')
),
event_trigger as (
  select t.tgenabled, t.tgfoid, pg_get_triggerdef(t.oid) as definition
  from pg_trigger t
  where t.tgrelid = 'public.reservation_session_changes'::regclass and t.tgname = 'reservation_session_changes_reschedule_email'
),
checks as (
  select 'FUNCOES_DA_FILA_COM_A_DEFINICAO_DO_REPOSITORIO' as check_name,
         coalesce((select string_agg(fn || '=' || verdict, ', ' order by fn) from created where verdict <> 'IDENTICA'), 'todas as ' || (select count(*) from created) || ' idênticas') as result,
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from created) then 'OK' else 'FALHOU' end as status
  union all
  select 'FUNCOES_SECURITY_DEFINER_COM_SEARCH_PATH',
         coalesce((select string_agg(fn, ', ' order by fn) from created
                   where not coalesce(prosecdef, false) or proconfig is null or not exists (select 1 from unnest(proconfig) c where c like 'search_path=%')), 'todas'),
         case when not exists (select 1 from created where not coalesce(prosecdef, false) or proconfig is null or not exists (select 1 from unnest(proconfig) c where c like 'search_path=%')) then 'OK' else 'FALHOU' end
  union all
  select 'NENHUMA_FUNCAO_EXECUTAVEL_PELA_API_PUBLICA',
         coalesce((select string_agg(fn, ', ' order by fn) from created
                   where oid is not null and (has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE'))), 'nenhuma'),
         case when not exists (select 1 from created where oid is not null and (has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE'))) then 'OK' else 'FALHOU' end
  union all
  select 'OPERACOES_EXECUTAVEIS_PELA_SERVICE_ROLE',
         (select count(*)::text from created where kind = 'OPERACAO' and oid is not null and has_function_privilege('service_role', oid, 'EXECUTE')) || ' de 8',
         case when (select count(*) = 8 from created where kind = 'OPERACAO' and oid is not null and has_function_privilege('service_role', oid, 'EXECUTE')) then 'OK' else 'FALHOU' end
  union all
  -- A trigger, a régua do "ainda vale", o conteúdo, o resumo da entrega e o
  -- núcleo da fila: nem o servidor as chama diretamente.
  select 'PECAS_INTERNAS_FORA_DO_ALCANCE',
         coalesce((select string_agg(fn, ', ' order by fn) from created
                   where kind = 'INTERNA' and oid is not null and has_function_privilege('service_role', oid, 'EXECUTE')), 'nenhuma executável pela service_role'),
         case when (select count(*) = 5 from created where kind = 'INTERNA' and oid is not null and not has_function_privilege('service_role', oid, 'EXECUTE')) then 'OK' else 'FALHOU' end
  union all
  -- RLS ligada, nenhuma policy, service role só lê; a API pública não lê nem escreve.
  select 'TABELAS_DA_FILA_PROTEGIDAS',
         coalesce((select string_agg(relname || ': rls=' || relrowsecurity::text || ', policies=' || policies::text
                                      || ', service_role lê=' || has_table_privilege('service_role', oid, 'SELECT')::text
                                      || ', service_role escreve=' || (has_table_privilege('service_role', oid, 'INSERT') or has_table_privilege('service_role', oid, 'UPDATE') or has_table_privilege('service_role', oid, 'DELETE'))::text
                                      || ', api pública=' || (has_table_privilege('anon', oid, 'SELECT') or has_table_privilege('authenticated', oid, 'SELECT')
                                                              or has_table_privilege('anon', oid, 'INSERT') or has_table_privilege('authenticated', oid, 'INSERT'))::text,
                                      ' | ' order by relname) from queue_tables), 'ausentes'),
         case when (select count(*) = 2 from queue_tables
                    where relrowsecurity and policies = 0
                      and has_table_privilege('service_role', oid, 'SELECT')
                      and not (has_table_privilege('service_role', oid, 'INSERT') or has_table_privilege('service_role', oid, 'UPDATE') or has_table_privilege('service_role', oid, 'DELETE'))
                      and not (has_table_privilege('anon', oid, 'SELECT') or has_table_privilege('authenticated', oid, 'SELECT')
                               or has_table_privilege('anon', oid, 'INSERT') or has_table_privilege('authenticated', oid, 'INSERT')))
              then 'OK' else 'FALHOU' end
  union all
  -- Depois de inserir, por linha, só para reagendamento vindo de Stand-by.
  select 'TRIGGER_DO_EVENTO_ATIVA',
         coalesce((select 'estado=' || tgenabled::text
                          || ', depois de inserir=' || (definition like '%AFTER INSERT%' and definition like '%FOR EACH ROW%')::text
                          || ', só reagendamento de Stand-by=' || (definition like '%STANDBY_RESCHEDULE%')::text
                   from event_trigger), 'ausente'),
         case when exists (select 1 from event_trigger e
                           where e.tgenabled = 'O'
                             and e.definition like '%AFTER INSERT%' and e.definition like '%FOR EACH ROW%'
                             and e.definition like '%STANDBY_RESCHEDULE%'
                             and e.tgfoid = to_regprocedure('public.enqueue_reservation_reschedule_email()'))
              then 'OK' else 'FALHOU' end
  union all
  -- A reivindicação espera pela reserva com limite: sem ele, uma transação presa
  -- seguraria a fila inteira.
  select 'REIVINDICACAO_COM_ESPERA_LIMITADA',
         coalesce((select string_agg(c, ', ') from created f, unnest(f.proconfig) c where f.fn = 'reservation_reschedule_email_take' and c like 'lock_timeout=%'), 'sem lock_timeout'),
         case when exists (select 1 from created f, unnest(f.proconfig) c where f.fn = 'reservation_reschedule_email_take' and c = 'lock_timeout=3s') then 'OK' else 'FALHOU' end
  union all
  select 'UM_EMAIL_POR_REAGENDAMENTO',
         (select count(*)::text from pg_index i join pg_class c on c.oid = i.indexrelid
          where c.relnamespace = 'public'::regnamespace and i.indisunique and i.indisvalid
            and c.relname in ('reservation_reschedule_emails_change_key', 'reservation_reschedule_emails_standby_key')) || ' de 2 índices únicos',
         case when (select count(*) = 2 from pg_index i join pg_class c on c.oid = i.indexrelid
                    where c.relnamespace = 'public'::regnamespace and i.indisunique and i.indisvalid
                      and c.relname in ('reservation_reschedule_emails_change_key', 'reservation_reschedule_emails_standby_key'))
              then 'OK' else 'FALHOU' end
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
  select 'TRIGGER_DA_INVARIANTE_ATIVA',
         coalesce((select tgenabled::text from pg_trigger where tgrelid = 'public.reservations'::regclass and tgname = 'reservations_standby_guard'), 'ausente'),
         case when exists (select 1 from pg_trigger where tgrelid = 'public.reservations'::regclass and tgname = 'reservations_standby_guard' and tgenabled = 'O') then 'OK' else 'FALHOU' end
  union all
  -- Toda linha da fila vem de um reagendamento de Stand-by, e de nenhuma outra troca.
  select 'FILA_SO_TEM_REAGENDAMENTO_DE_STANDBY',
         (select count(*)::text from public.reservation_reschedule_emails q
          join public.reservation_session_changes c on c.id = q.change_id
          where c.origin <> 'STANDBY_RESCHEDULE' or c.standby_id is distinct from q.standby_id) || ' linha(s) fora da regra',
         case when not exists (select 1 from public.reservation_reschedule_emails q
                               join public.reservation_session_changes c on c.id = q.change_id
                               where c.origin <> 'STANDBY_RESCHEDULE' or c.standby_id is distinct from q.standby_id)
              then 'OK' else 'FALHOU' end
  union all
  -- A mensagem guardada para repetição tem o nome e o e-mail do cliente: só pode
  -- existir enquanto o envio não terminou.
  select 'MENSAGEM_GUARDADA_SO_ENQUANTO_PRECISA',
         (select count(*)::text from public.reservation_reschedule_emails where frozen_message is not null and status in ('SENT', 'SKIPPED', 'UNCERTAIN')) || ' fora da regra, '
           || (select count(*)::text from public.reservation_reschedule_emails where frozen_message is not null) || ' em uso',
         case when not exists (select 1 from public.reservation_reschedule_emails where frozen_message is not null and status in ('SENT', 'SKIPPED', 'UNCERTAIN'))
              then 'OK' else 'FALHOU' end
  union all
  -- Reagendamento anterior à migration: não entrou na fila e não recebe e-mail.
  select 'REAGENDAMENTOS_SEM_LINHA_NA_FILA',
         (select count(*)::text from public.reservation_session_changes c
          where c.origin = 'STANDBY_RESCHEDULE'
            and not exists (select 1 from public.reservation_reschedule_emails q where q.change_id = c.id)),
         case when exists (select 1 from public.reservation_session_changes c
                           where c.origin = 'STANDBY_RESCHEDULE'
                             and not exists (select 1 from public.reservation_reschedule_emails q where q.change_id = c.id))
              then 'ATENCAO' else 'OK' end
  union all
  select 'FILA_DE_REAGENDAMENTO_POR_STATUS',
         coalesce((select string_agg(status || '=' || n, ', ' order by status) from (select status, count(*) n from public.reservation_reschedule_emails group by 1) x), 'vazia'),
         'OK'
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
  select 'FILAS_EXISTENTES',
         coalesce((select string_agg(integration || ':' || status || '=' || n, ', ' order by integration, status)
                   from (select integration, status, count(*) n from public.integration_sync_jobs group by 1, 2) x), 'vazias'),
         'OK'
)
select check_name, result, status from checks
union all
select 'STANDBY_EMAIL_POSTCHECK_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
