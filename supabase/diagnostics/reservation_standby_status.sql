-- STAND-BY — ESTADO ATUAL (SOMENTE LEITURA)
--
-- Uma consulta, sem nada para editar, que responde "como está o Stand-by agora?":
-- reservas aguardando, autorizações e links abertos, a fila do e-mail de
-- reagendamento, o limite de tentativas do autoatendimento e a localização de
-- cada base. Só contagens e símbolos: nenhum nome, e-mail, telefone, CPF,
-- código de reserva ou token é retornado. Nada é enviado, reivindicado ou
-- alterado — pode rodar com o e-mail ligado.
--
-- Como ler:
--   INCOERENCIAS_STATUS_X_AUTORIZACAO, MENSAGEM_CONGELADA_RESIDUAL,
--   MAIS_DE_UMA_LINHA_POR_REAGENDAMENTO   precisam ser 0.
--   PENDENTES_QUE_SAIRIAM_AO_ABRIR_O_PAINEL   com o e-mail ligado, é quantos
--                         e-mails saem na próxima abertura de /admin/stand-by.
--   REAGENDAMENTOS_SEM_LINHA_NA_FILA   só reagendamentos anteriores à
--                         migration 202610150001 podem estar aqui.
--   BASES_LOCAL           ponto de encontro / endereço / link do mapa de cada
--                         base. lago-norte: false/true/false é o cadastro
--                         esperado: o Lago Norte não tem ponto de encontro nem
--                         link cadastrados, e o e-mail mostra só o endereço.

select 'RESERVAS_AGUARDANDO_REAGENDAMENTO' as check_name,
       (select count(*)::text from public.reservations where status = 'AWAITING_RESCHEDULE') as result
union all select 'AUTORIZACOES_ABERTAS',
       (select count(*)::text from public.reservation_standby where resolved_at is null)
union all select 'INCOERENCIAS_STATUS_X_AUTORIZACAO (precisa ser 0)',
       (select count(*)::text from public.reservations r
         where (r.status = 'AWAITING_RESCHEDULE') <> exists (select 1 from public.reservation_standby sb where sb.reservation_id = r.id and sb.resolved_at is null))
union all select 'LINKS_ATIVOS',
       (select count(*)::text from public.reservation_standby where resolved_at is null and link_token_hash is not null and link_revoked_at is null)
union all select 'CICLOS_POR_RESOLUCAO',
       coalesce((select string_agg(k || '=' || n, ', ' order by k) from (
         select coalesce(resolution, 'ABERTO') || coalesce('/' || resolved_by_type, '') || coalesce('/' || resolved_access, '') as k, count(*) n
         from public.reservation_standby group by 1) x), 'nenhum')
union all select 'FILA_POR_STATUS',
       coalesce((select string_agg(status || '=' || n, ', ' order by status) from (select status, count(*) n from public.reservation_reschedule_emails group by 1) x), 'vazia')
union all select 'EMAILS_PENDENTES (QUEUED/SENDING/FAILED/UNCERTAIN)',
       (select count(*)::text from public.reservation_reschedule_emails where status in ('QUEUED', 'SENDING', 'FAILED', 'UNCERTAIN'))
union all select 'PENDENTES_QUE_SAIRIAM_AO_ABRIR_O_PAINEL',
       (select count(*)::text from public.reservation_reschedule_emails q
         where q.status in ('QUEUED', 'FAILED') and public.reservation_reschedule_email_rejection(q.id) is null)
union all select 'MENSAGEM_CONGELADA_RESIDUAL (precisa ser 0)',
       (select count(*)::text from public.reservation_reschedule_emails where frozen_message is not null and status in ('SENT', 'SKIPPED', 'UNCERTAIN'))
union all select 'REAGENDAMENTOS_SEM_LINHA_NA_FILA',
       (select count(*)::text from public.reservation_session_changes c
         where c.origin = 'STANDBY_RESCHEDULE' and not exists (select 1 from public.reservation_reschedule_emails q where q.change_id = c.id))
union all select 'MAIS_DE_UMA_LINHA_POR_REAGENDAMENTO (precisa ser 0)',
       (select count(*)::text from (select change_id from public.reservation_reschedule_emails group by 1 having count(*) > 1) d)
union all select 'TENTATIVAS_POR_RESULTADO',
       coalesce((select string_agg(o || '=' || n, ', ' order by o) from (
         select coalesce(outcome, 'EM_CURSO') o, count(*) n from public.reservation_reschedule_email_attempts group by 1) x), 'nenhuma')
union all select 'ULTIMO_ENVIO',
       (select coalesce(to_char(max(sent_at) at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'), 'nenhum') from public.reservation_reschedule_emails)
union all select 'LIMITE_BLOQUEIOS_AGORA (precisa ser 0 e 0)',
       (select count(*) filter (where bucket like 'credential:%' and attempts > 10 and window_started_at > now() - interval '15 minutes') || ' credencial(is), '
            || count(*) filter (where bucket like 'client:%' and attempts > 30 and window_started_at > now() - interval '15 minutes') || ' origem(ns)'
        from public.customer_access_throttle)
union all select 'RPCS_DO_CLIENTE_SO_PELA_SERVICE_ROLE (todas true)',
       (select string_agg(p.proname || '=' || (not has_function_privilege('anon', p.oid, 'EXECUTE')
                                               and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
                                               and has_function_privilege('service_role', p.oid, 'EXECUTE'))::text, ', ' order by p.proname)
        from pg_proc p where p.pronamespace = 'public'::regnamespace
          and p.proname in ('customer_reschedule_overview', 'customer_reschedule_reservation', 'register_customer_access_attempt'))
union all select 'BASES_LOCAL (ponto de encontro / endereço / mapa)',
       (select string_agg(slug || ': ' || (coalesce(meeting_point, '') <> '')::text || '/' || (coalesce(address, '') <> '')::text
                          || '/' || (coalesce(maps_url, '') <> '')::text, ', ' order by slug) from public.bases);
