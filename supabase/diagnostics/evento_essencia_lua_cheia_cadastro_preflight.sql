-- ESSÊNCIA — 2ª edição · Celebração da Lua Cheia — PREFLIGHT DO CADASTRO (SOMENTE LEITURA; GERADO, NÃO EDITAR À MÃO)
--
-- Rodar no SQL Editor ANTES de supabase/maintenance/evento_essencia_lua_cheia_cadastro.sql.
-- A última linha, EVENTO_CADASTRO_PREFLIGHT_OK, precisa estar OK. Guarde
-- OUTROS_EVENTOS, LISTAGENS_REGULARES, RESERVAS_POR_STATUS e INSCRICOES_DA_LISTA_POR_STATUS.

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
         case when exists (select 1 from public.experiences where slug = 'essencia-lua-cheia') then 'já existe' else 'livre' end,
         case when exists (select 1 from public.experiences where slug = 'essencia-lua-cheia') then 'FALHOU' else 'OK' end
  union all
  select 'SESSAO_SEM_DUPLICIDADE',
         (select count(*) from public.sessions s join public.experiences e on e.id = s.experience_id join public.bases b on b.id = e.base_id
          where e.kind = 'EVENT' and e.slug <> 'essencia-lua-cheia' and b.slug = 'concha-acustica'
            and s.starts_at = '2026-11-24T18:00:00.000Z'::timestamptz and s.status <> 'ARCHIVED')::text || ' sessão(ões) de evento na base concha-acustica com início 2026-11-24T18:00:00.000Z',
         case when (select count(*) from public.sessions s join public.experiences e on e.id = s.experience_id join public.bases b on b.id = e.base_id
          where e.kind = 'EVENT' and e.slug <> 'essencia-lua-cheia' and b.slug = 'concha-acustica'
            and s.starts_at = '2026-11-24T18:00:00.000Z'::timestamptz and s.status <> 'ARCHIVED') = 0 then 'OK' else 'FALHOU' end
  union all
  select 'SEGURANCA_DOS_EVENTOS',
         case when exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'experiences' and policyname = 'events hidden until published')
     and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sessions' and policyname = 'event sessions hidden until published')
     and exists (select 1 from pg_trigger where tgrelid = 'public.reservations'::regclass and tgname = 'reservations_event_publication_guard')
     and exists (select 1 from pg_trigger where tgrelid = 'public.waitlist_entries'::regclass and tgname = 'waitlist_entries_event_publication_guard')
     and exists (select 1 from pg_proc where proname = 'event_publication_allows' and pronamespace = 'public'::regnamespace) then 'migration 202610310004 aplicada' else 'migration 202610310004 AUSENTE' end,
         case when exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'experiences' and policyname = 'events hidden until published')
     and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sessions' and policyname = 'event sessions hidden until published')
     and exists (select 1 from pg_trigger where tgrelid = 'public.reservations'::regclass and tgname = 'reservations_event_publication_guard')
     and exists (select 1 from pg_trigger where tgrelid = 'public.waitlist_entries'::regclass and tgname = 'waitlist_entries_event_publication_guard')
     and exists (select 1 from pg_proc where proname = 'event_publication_allows' and pronamespace = 'public'::regnamespace) then 'OK' else 'FALHOU' end
  union all
  select 'INTERRUPTOR',
         coalesce((select case when publication_enabled then 'ligado (rascunho escondido pelas políticas da 202610310004)' else 'desligado' end from public.special_event_settings where singleton), 'ausente'),
         case when exists (select 1 from public.special_event_settings where singleton) then 'OK' else 'FALHOU' end
  union all
  select 'MIGRATIONS_DOS_EVENTOS',
         'leituras com interruptor=' || (select prosrc like '%publication_enabled%' from pg_proc where proname = 'list_public_events' and pronamespace = 'public'::regnamespace)::text
           || ', lista por tipo=' || exists (select 1 from pg_proc where proname = 'claim_pending_waitlist_spot_emails_by_kind' and pronamespace = 'public'::regnamespace)::text,
         case when (select prosrc like '%publication_enabled%' from pg_proc where proname = 'list_public_events' and pronamespace = 'public'::regnamespace)
               and exists (select 1 from pg_proc where proname = 'claim_pending_waitlist_spot_emails_by_kind' and pronamespace = 'public'::regnamespace) then 'OK' else 'FALHOU' end
  union all
  select 'COLUNAS_LEGADAS_COBERTAS',
         case when not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'experiences' and column_name = 'eyebrow') then 'sem colunas legadas'
              when exists (select 1 from pg_trigger where tgrelid = 'public.experiences'::regclass and tgname = 'experiences_fill_legacy_columns') then 'colunas legadas preenchidas pelo gatilho'
              else 'colunas legadas SEM o gatilho (aplicar 202610310002)' end,
         case when not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'experiences' and column_name = 'eyebrow')
               or exists (select 1 from pg_trigger where tgrelid = 'public.experiences'::regclass and tgname = 'experiences_fill_legacy_columns') then 'OK' else 'FALHOU' end
  union all
  select 'RASCUNHO_NASCE_INATIVO',
         case when not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'experiences' and column_name = 'active') then 'sem a coluna active'
              when (select md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g')) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'experiences_fill_legacy_columns') = '4ee78d0a6fcbc88ca58c7c22875152f5' then 'gatilho com a regra do active'
              else 'gatilho SEM a regra do active (aplicar 202610310003)' end,
         case when not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'experiences' and column_name = 'active')
               or (select md5(regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g')) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'experiences_fill_legacy_columns') = '4ee78d0a6fcbc88ca58c7c22875152f5' then 'OK' else 'FALHOU' end
  union all
  select 'OUTROS_EVENTOS',
         (select coalesce(count(*)::text || ' evento(s) [' || string_agg(e.slug || '=' || e.status, ', ' order by e.slug) || '] ' || md5(string_agg(e.id::text || e.status || e.editorial_content::text || coalesce((
            select string_agg(s.id::text || s.status::text || s.starts_at::text || s.capacity || s.price_cents || s.duration_minutes, ',' order by s.id)
            from public.sessions s where s.experience_id = e.id), ''), '|' order by e.id)), 'nenhum outro evento')
          from public.experiences e where e.kind = 'EVENT' and e.slug <> 'essencia-lua-cheia'),
         'OK'
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
select 'EVENTO_CADASTRO_PREFLIGHT_OK',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
