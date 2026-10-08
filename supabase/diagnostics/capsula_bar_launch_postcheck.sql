-- CÁPSULA BAR — POSTCHECK (SOMENTE LEITURA)
--
-- Rodar no SQL Editor DEPOIS de 202610080001_capsula_bar_launch.sql.
-- Um único SELECT no formato check_name | result | status. Nenhuma escrita,
-- nenhuma função nova e nenhum dado pessoal retornado.
--
-- A linha final, CAPSULA_BAR_LAUNCH_OK, só fica OK quando todas as outras estão OK.

with capsula as (
  select * from public.bases where slug = 'concha-acustica'
),
capsula_experiences as (
  select e.* from public.experiences e join capsula c on c.id = e.base_id
),
inauguration as (
  select s.*, public.available_spots(s.id) as spots
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  where e.slug = 'remada-sunset-concha-acustica'
    and s.starts_at = make_timestamptz(2026, 10, 11, 17, 0, 0, 'America/Sao_Paulo')
),
checks as (
  select 'BASE_ATIVA_E_NOMEADA' as check_name,
         (select name || ' · ' || status from capsula) as result,
         (select name = 'Cápsula Bar — Concha Acústica' and status = 'ACTIVE' from capsula) as ok
  union all
  select 'ENDERECO_E_PONTO_DE_ENCONTRO',
         (select meeting_point || ' | ' || address from capsula),
         (select meeting_point = 'Em frente ao Cápsula Bar — Concha Acústica' and address = 'SHTN Trecho 1, Lote 8 — Brasília/DF' from capsula)
  union all
  select 'LINK_DO_GOOGLE_MAPS',
         (select maps_url from capsula),
         (select maps_url = 'https://maps.app.goo.gl/ueSCiLvHAggrzuAX7' from capsula)
  union all
  select 'CINCO_EXPERIENCIAS_CADASTRADAS',
         (select string_agg(title || ':' || status, ', ' order by title) from capsula_experiences),
         (select count(*) = 5 from capsula_experiences
           where slug in ('remada-sunset-concha-acustica', 'remada-nascer-do-sol-concha-acustica', 'remada-lua-cheia-concha-acustica',
                          'caminhos-do-paranoa-rota-ermida-ponte-jk', 'caminhos-do-paranoa-rota-prainha-do-congresso'))
  union all
  select 'VALOR_DURACAO_E_CAPACIDADE_PADRAO',
         (select string_agg(distinct price_cents || ' centavos / ' || duration_minutes || ' min / ' || default_capacity || ' vagas', ', ') from capsula_experiences),
         (select bool_and(price_cents = 7000 and duration_minutes = 90 and default_capacity = 24) from capsula_experiences)
  union all
  select 'SO_A_REMADA_SUNSET_PUBLICADA',
         (select string_agg(slug, ', ') from capsula_experiences where status = 'PUBLISHED'),
         (select count(*) = 1 and bool_and(slug = 'remada-sunset-concha-acustica') from capsula_experiences where status = 'PUBLISHED')
  union all
  select 'LANDING_DA_REMADA_SUNSET_PUBLICAVEL',
         (select public.experience_editorial_is_publishable(editorial_content)::text from capsula_experiences where slug = 'remada-sunset-concha-acustica'),
         (select public.experience_editorial_is_publishable(editorial_content) from capsula_experiences where slug = 'remada-sunset-concha-acustica')
  union all
  select 'SESSAO_DE_INAUGURACAO',
         (select to_char(starts_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') || ' · ' || duration_minutes || ' min · '
                 || price_cents || ' centavos · ' || capacity || ' vagas · ' || status from inauguration),
         (select count(*) = 1 and bool_and(duration_minutes = 90 and price_cents = 7000 and capacity = 24 and status = 'OPEN') from inauguration)
  union all
  select 'VAGAS_DISPONIVEIS_NA_INAUGURACAO',
         (select spots::text from inauguration),
         (select bool_and(spots between 0 and 24) from inauguration)
  union all
  select 'UNICA_SESSAO_DA_BASE',
         (select count(*)::text from public.sessions s join capsula_experiences e on e.id = s.experience_id),
         (select count(*) = 1 from public.sessions s join capsula_experiences e on e.id = s.experience_id)
  union all
  select 'SESSAO_VISIVEL_NA_AGENDA_PUBLICA',
         (select count(*)::text from public.list_open_sessions('remada-sunset-concha-acustica')),
         (select count(*) = 1 from public.list_open_sessions('remada-sunset-concha-acustica'))
  union all
  select 'LAGO_NORTE_SEM_ALTERACAO_DE_LOCAL',
         (select address || ' | ponto=' || coalesce(meeting_point, 'nulo') || ' | mapa=' || coalesce(maps_url, 'nulo') from public.bases where slug = 'lago-norte'),
         (select address = 'QL 5 Conjunto 5 - Lago Norte' and meeting_point is null and maps_url is null and status = 'ACTIVE' from public.bases where slug = 'lago-norte')
  union all
  select 'LAGO_NORTE_EXPERIENCIAS_PUBLICADAS',
         (select string_agg(e.slug, ', ' order by e.display_order) from public.experiences e join public.bases b on b.id = e.base_id where b.slug = 'lago-norte' and e.status = 'PUBLISHED'),
         (select count(*) >= 4 from public.experiences e join public.bases b on b.id = e.base_id where b.slug = 'lago-norte' and e.status = 'PUBLISHED')
  union all
  select 'LEITURA_PUBLICA_DAS_BASES_COM_LOCAL',
         (select count(*)::text from public.list_public_bases() where maps_url is not null),
         (select count(*) = 1 from public.list_public_bases() where slug = 'concha-acustica' and maps_url is not null and meeting_point is not null)
  union all
  select 'FUNCOES_RESTRITAS_A_SERVICE_ROLE',
         'reservation_confirmation_email, public_checkin_ticket, google_sheets_session_block',
         not has_function_privilege('anon', 'public.reservation_confirmation_email(uuid)', 'execute')
         and not has_function_privilege('anon', 'public.public_checkin_ticket(uuid)', 'execute')
         and not has_function_privilege('anon', 'public.google_sheets_session_block(uuid)', 'execute')
         and has_function_privilege('service_role', 'public.reservation_confirmation_email(uuid)', 'execute')
         and has_function_privilege('anon', 'public.list_public_bases()', 'execute')
)
select check_name, result, case when ok then 'OK' else 'REVISAR' end as status from checks
union all
select 'CAPSULA_BAR_LAUNCH_OK', '', case when (select bool_and(coalesce(ok, false)) from checks) then 'OK' else 'REVISAR' end;
