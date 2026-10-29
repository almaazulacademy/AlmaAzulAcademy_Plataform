-- ESSÊNCIA — PREFLIGHT DO CADASTRO (SOMENTE LEITURA; GERADO, NÃO EDITAR À MÃO)
--
-- Rodar no SQL Editor ANTES de supabase/maintenance/essencia_cadastro.sql.
-- A última linha, ESSENCIA_CADASTRO_PREFLIGHT_OK, precisa estar OK. Guarde
-- LISTAGENS_REGULARES, RESERVAS_POR_STATUS e INSCRICOES_DA_LISTA_POR_STATUS.

with checks as (
  select 'ATOR_ADMINISTRADOR' as check_name,
         (select count(*)::text from public.admin_users au join auth.users u on u.id = au.user_id
          where lower(u.email) = 'almaazulacademy@gmail.com' and au.is_active and au.role = 'ADMIN') || ' administrador(es) ativo(s) com o e-mail da equipe' as result,
         case when (select count(*) from public.admin_users au join auth.users u on u.id = au.user_id
                    where lower(u.email) = 'almaazulacademy@gmail.com' and au.is_active and au.role = 'ADMIN') = 1 then 'OK' else 'FALHOU' end as status
  union all
  select 'BASE_ATIVA',
         coalesce((select slug || '=' || status from public.bases where slug = 'concha-acustica'), 'ausente'),
         case when exists (select 1 from public.bases where slug = 'concha-acustica' and status = 'ACTIVE') then 'OK' else 'FALHOU' end
  union all
  select 'SLUG_LIVRE',
         case when exists (select 1 from public.experiences where slug = 'essencia') then 'já existe' else 'livre' end,
         case when exists (select 1 from public.experiences where slug = 'essencia') then 'FALHOU' else 'OK' end
  union all
  select 'INTERRUPTOR_DESLIGADO',
         coalesce((select case when publication_enabled then 'ligado' else 'desligado' end from public.special_event_settings where singleton), 'ausente'),
         case when (select publication_enabled from public.special_event_settings where singleton) is false then 'OK' else 'FALHOU' end
  union all
  select 'MIGRATIONS_DOS_EVENTOS',
         'leituras com interruptor=' || (select prosrc like '%publication_enabled%' from pg_proc where proname = 'list_public_events' and pronamespace = 'public'::regnamespace)::text
           || ', lista por tipo=' || exists (select 1 from pg_proc where proname = 'claim_pending_waitlist_spot_emails_by_kind' and pronamespace = 'public'::regnamespace)::text,
         case when (select prosrc like '%publication_enabled%' from pg_proc where proname = 'list_public_events' and pronamespace = 'public'::regnamespace)
               and exists (select 1 from pg_proc where proname = 'claim_pending_waitlist_spot_emails_by_kind' and pronamespace = 'public'::regnamespace) then 'OK' else 'FALHOU' end
  union all
  select 'EVENTOS_CADASTRADOS',
         coalesce((select string_agg(slug || '=' || status, ', ' order by slug) from public.experiences where kind = 'EVENT'), 'nenhum'),
         case when exists (select 1 from public.experiences where kind = 'EVENT') then 'ATENCAO' else 'OK' end
  union all
  select 'LISTAGENS_REGULARES',
         (select count(*)::text from public.list_public_regular_experiences()) || ' experiências, ' || (select count(*)::text from public.list_public_regular_catalog()) || ' no catálogo',
         'OK'
  union all
  select 'RESERVAS_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.reservations group by 1) x),
         'OK'
  union all
  select 'INSCRICOES_DA_LISTA_POR_STATUS',
         coalesce((select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.waitlist_entries group by 1) x), 'nenhuma'),
         'OK'
)
select check_name, result, status from checks
union all
select 'ESSENCIA_CADASTRO_PREFLIGHT_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
