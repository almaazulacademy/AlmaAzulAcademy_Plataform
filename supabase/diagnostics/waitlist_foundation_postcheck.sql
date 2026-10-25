-- LISTA DE ESPERA, FASE 1 (FUNDAÇÃO) — POSTCHECK (SOMENTE LEITURA)
--
-- Rodar no SQL Editor DEPOIS de `202610250001_waitlist_foundation.sql`.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita e
-- nenhum dado pessoal retornado — nem o segredo da lista, só o tamanho dele.
--
-- A linha final, WAITLIST_FUNDACAO_POSTCHECK_OK, fica OK quando nenhuma linha
-- FALHOU. ASSINATURA_DAS_FUNCOES_EXISTENTES e as contagens precisam devolver os
-- mesmos valores do preflight: a migration cria tabelas e funções novas e não
-- toca nenhuma função nem linha existente.
--
-- Rodado antes da migration, ele falha com "relation does not exist" em vez de
-- aprovar.

with expected(fn, kind, exact, norm) as (values
    ('admin_list_waitlist_entries_page', 'SERVIDOR', 'c86fb0d1f41027f030782e270a874366', '19b15013e3d3b2f3b9ee314b6990ca37'),
    ('admin_remove_waitlist_entry', 'SERVIDOR', '923ff2430610e5fdf2ea2b247cde81f8', '0a8cc9c763e433d9c9a1f653eb63adfa'),
    ('admin_waitlist_entry', 'SERVIDOR', '408744f7dc7c4f325fe8334883eb321e', '89f5a893917bccca856b8f1a4533b524'),
    ('admin_waitlist_sessions', 'SERVIDOR', 'fc04b3d2448bd5a2d337f8b769e5b687', '49f98c05c0a31cd59897ae613a358b66'),
    ('list_public_sessions', 'PUBLICA', 'f0ffb28f94410b419ba570e0eb6da9ca', '400cad0c90e1fc8befb98048a604fbbe'),
    ('register_waitlist_attempt', 'INTERNA', '16df819013f35720f2b5ac0b5a472ebf', 'f7b39150e769c8f383453958dd90aa7d'),
    ('waitlist_anonymize_entries', 'INTERNA', 'd3ce0c6a732d284f3b06a10e8a69f3cf', '28f2c85f8318a5c7c1a430e0e02a30bc'),
    ('waitlist_cancel', 'SERVIDOR', '0f02aadbeb3f99673cfdb0c858678cef', 'e70e2aef14801c9fff633cab6a5f5698'),
    ('waitlist_cancel_overview', 'SERVIDOR', 'a8e4b1147a92e887184766580646ebb2', '81da55b0720abfbf238f04a82d77fddf'),
    ('waitlist_cancel_token', 'INTERNA', 'c4fc03a731bc475353af6925d9314993', 'b8e0445c63e079608b992ad6927df767'),
    ('waitlist_effective_status', 'INTERNA', 'd5a07aebaeb8130337789377c0510de4', '3db793a67755fcfa5d0b792653e00a17'),
    ('waitlist_eligible_entries', 'INTERNA', '34079b42518195d56fdcee936cd341de', 'fc7a55b6c2c1933aa4cbe554cf79b4f2'),
    ('waitlist_expire_entries', 'INTERNA', 'e089f98f87c3343b95564ec168f64a0a', 'e3ed7398ed28d180c50f96fd8fabb9e4'),
    ('waitlist_join', 'SERVIDOR', 'ea1804d2f2469e88aab92b72f210e804', '6f7b02560e23cc70b76b6aeac22effdb'),
    ('waitlist_mark_conversions', 'INTERNA', '66d3e7e8ab76341a645ceb6cc14bca6b', '7531f851c0e56a47044ce77559d4bb6d'),
    ('waitlist_skip_pending_notifications', 'INTERNA', 'c76881471c82db58e1791c14aeff9414', '62a87376506864938255dc9d17ecfcb2'),
    ('waitlist_token_hash', 'INTERNA', 'b15727ae29d8a05a98e0965ac46b8ce2', 'b444586b18a43fe6dbad25288978eb98'),
    ('waitlist_wave_size', 'INTERNA', 'bbc23d8db36d4689225b13e08138838b', 'b4149df44c87eb19aa56933e1325051f'),
    ('available_spots', 'EXISTENTE', '0fe290aa82248812c1c035354d94e2fa', 'a3050f894ad24f6262b2b80d1d3a752f'),
    ('get_booking_session', 'EXISTENTE', 'ef6e779340dbee37df36ffbb9f52eec6', '4b07e68e8102ca0a6fc84ee4755b3324'),
    ('list_open_sessions', 'EXISTENTE', '62c7497707dea5325c02c840465962a9', 'b0b535d34537c408588626ed14679c7e')
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
created as (select * from functions where kind <> 'EXISTENTE'),
-- Quem executa o quê: PUBLICA (anon e service role), SERVIDOR (só a service
-- role) e INTERNA (ninguém além do dono).
grants as (
  select fn, kind,
         oid is not null and has_function_privilege('anon', oid, 'EXECUTE') as anon,
         oid is not null and has_function_privilege('authenticated', oid, 'EXECUTE') as authenticated,
         oid is not null and has_function_privilege('service_role', oid, 'EXECUTE') as service
  from created
),
wrong_grants as (
  select fn from grants
  where (kind = 'PUBLICA' and not (anon and authenticated and service))
     or (kind = 'SERVIDOR' and (anon or authenticated or not service))
     or (kind = 'INTERNA' and (anon or authenticated or service))
),
new_tables as (
  select c.oid, c.relname, c.relrowsecurity,
         (select count(*) from pg_policy p where p.polrelid = c.oid) as policies,
         exists (
           select 1 from unnest(array['anon', 'authenticated', 'service_role']) r(role),
                         unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p(priv)
           where has_table_privilege(r.role, c.oid, p.priv)
         ) as api_access
  from pg_class c
  where c.relnamespace = 'public'::regnamespace
    and c.relname in ('waitlist_throttle_secret', 'waitlist_throttle', 'waitlist_entries', 'waitlist_openings',
                      'waitlist_notifications', 'waitlist_notification_attempts')
),
queue_sequence as (
  select c.oid, c.relname,
         exists (
           select 1 from unnest(array['anon', 'authenticated', 'service_role']) r(role),
                         unnest(array['USAGE', 'SELECT', 'UPDATE']) p(priv)
           where has_sequence_privilege(r.role, c.oid, p.priv)
         ) as api_access
  from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' and c.relname = 'waitlist_entries_queue_sequence_seq'
),
unique_indexes(name) as (values
    ('waitlist_entries_active_email_key'), ('waitlist_entries_cancel_token_key'), ('waitlist_notifications_joined_key'),
    ('waitlist_notifications_opening_key'), ('waitlist_openings_open_session_key'), ('waitlist_notification_attempts_number_key')
),
missing_indexes as (
  select u.name from unique_indexes u
  where not exists (select 1 from pg_class c join pg_index i on i.indexrelid = c.oid
                    where c.relname = u.name and c.relnamespace = 'public'::regnamespace and i.indisunique)
),
-- Triggers fora das tabelas novas que citam a lista: tem que ser nenhuma.
foreign_triggers as (
  select t.tgrelid::regclass::text || '.' || t.tgname as name
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
  where not t.tgisinternal and c.relnamespace = 'public'::regnamespace
    and c.relname not like 'waitlist\_%'
    and (t.tgname ilike '%waitlist%' or t.tgfoid::regproc::text ilike '%waitlist%')
),
published as (select e.slug from public.experiences e where e.status = 'PUBLISHED'),
-- As turmas com vaga de list_public_sessions são exatamente as de list_open_sessions.
listing_drift as (
  select p.slug
  from published p
  where exists (
    (select s.id, s.remaining_spots from public.list_public_sessions(p.slug) s where not s.sold_out
     except
     select o.id, o.remaining_spots from public.list_open_sessions(p.slug) o)
    union all
    (select o.id, o.remaining_spots from public.list_open_sessions(p.slug) o
     except
     select s.id, s.remaining_spots from public.list_public_sessions(p.slug) s where not s.sold_out)
  )
),
new_names as (select fn from created),
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
         (select count(*) filter (where kind = 'PUBLICA')::text || ' pública, '
                 || count(*) filter (where kind = 'SERVIDOR')::text || ' do servidor, '
                 || count(*) filter (where kind = 'INTERNA')::text || ' internas' from created)
           || coalesce(' | erradas: ' || (select string_agg(fn, ', ' order by fn) from wrong_grants), ''),
         case when exists (select 1 from wrong_grants) then 'FALHOU' else 'OK' end
  union all
  select 'TABELAS_FECHADAS',
         coalesce((select string_agg(relname, ', ' order by relname) from new_tables
                   where not relrowsecurity or policies > 0 or api_access), 'todas: rls ligada, nenhuma policy, nenhum acesso pela API')
           || ' (' || (select count(*)::text from new_tables) || ' de 6)',
         case when (select count(*) = 6 from new_tables where relrowsecurity and policies = 0 and not api_access) then 'OK' else 'FALHOU' end
  union all
  select 'SEQUENCIA_DA_FILA_FECHADA',
         coalesce((select relname || ': api=' || api_access::text from queue_sequence), 'ausente'),
         case when exists (select 1 from queue_sequence where not api_access) then 'OK' else 'FALHOU' end
  union all
  select 'INDICES_UNICOS',
         coalesce('ausentes: ' || (select string_agg(name, ', ' order by name) from missing_indexes), 'todos presentes'),
         case when exists (select 1 from missing_indexes) then 'FALHOU' else 'OK' end
  union all
  select 'NENHUMA_TRIGGER_EM_TABELA_EXISTENTE',
         coalesce((select string_agg(name, ', ' order by name) from foreign_triggers), 'nenhuma'),
         case when exists (select 1 from foreign_triggers) then 'FALHOU' else 'OK' end
  union all
  -- Nenhum agendamento nesta fase.
  select 'NENHUM_AGENDAMENTO_DA_LISTA',
         coalesce((select string_agg(jobname, ', ' order by jobname) from cron.job where jobname ilike '%waitlist%'), 'nenhum'),
         case when exists (select 1 from cron.job where jobname ilike '%waitlist%') then 'FALHOU' else 'OK' end
  union all
  select 'SEGREDO_DA_LISTA',
         (select count(*)::text || ' linha(s), ' || coalesce(max(octet_length(secret)), 0)::text || ' bytes' from public.waitlist_throttle_secret),
         case when (select count(*) = 1 and min(octet_length(secret)) = 32 from public.waitlist_throttle_secret) then 'OK' else 'FALHOU' end
  union all
  select 'LISTA_PUBLICA_COERENTE_COM_A_RESERVA',
         coalesce('divergem: ' || (select string_agg(slug, ', ' order by slug) from listing_drift),
                  (select count(*)::text from published) || ' experiência(s) publicada(s), nenhuma divergência'),
         case when exists (select 1 from listing_drift) then 'FALHOU' else 'OK' end
  union all
  select 'TURMAS_ESGOTADAS_VISIVEIS',
         (select count(*)::text from published p cross join lateral public.list_public_sessions(p.slug) s where s.sold_out),
         'OK'
  union all
  select 'FUNCOES_QUE_A_LISTA_ESPELHA_OU_CHAMA',
         (select string_agg(fn || '=' || verdict, ', ' order by fn) from functions where kind = 'EXISTENTE'),
         case when (select bool_and(verdict in ('IDENTICA', 'IDENTICA_SO_FORMATACAO')) from functions where kind = 'EXISTENTE') then 'OK' else 'FALHOU' end
  union all
  select 'ASSINATURA_DAS_FUNCOES_EXISTENTES',
         (select count(*)::text || ' funções, ' || md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), '|' order by p.oid::regprocedure::text))
          from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not in (select fn from new_names)),
         'OK'
  union all
  select 'LISTA_DE_ESPERA',
         (select count(*)::text || ' inscrição(ões), ' from public.waitlist_entries)
           || (select count(*)::text || ' aviso(s), ' from public.waitlist_notifications)
           || (select count(*)::text || ' abertura(s)' from public.waitlist_openings),
         'OK'
  union all
  select 'RESERVAS_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.reservations group by 1) x),
         'OK'
  union all
  select 'SESSOES_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.sessions group by 1) x),
         'OK'
  union all
  select 'EVENTOS_DE_PAGAMENTO', (select count(*)::text from public.payment_events), 'OK'
  union all
  select 'AUDITORIA', (select count(*)::text from public.admin_audit_log), 'OK'
)
select check_name, result, status from checks
union all
select 'WAITLIST_FUNDACAO_POSTCHECK_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
