-- CAPACIDADE PADRÃO DAS EXPERIÊNCIAS (SOMENTE LEITURA)
--
-- Um único comando SELECT, no formato check_name | result | status, para o SQL
-- Editor mostrar tudo de uma vez.
--
-- Somente leitura: nenhuma escrita, nenhum bloco anônimo, nenhuma função nova,
-- nenhuma mudança de schema. Nenhum dado pessoal é retornado.
--
-- Use antes e depois de
-- supabase/migrations/202608090002_imersao_paranoa_default_capacity.sql.
-- A linha final só fica OK quando as três experiências da agenda de setembro
-- estão com capacidade padrão 28.

with facts as (
  select
    (select default_capacity from public.experiences where slug = 'imersao-paranoa') as imersao,
    (select default_capacity from public.experiences where slug = 'remada-nascer-do-sol') as nascer,
    (select default_capacity from public.experiences where slug = 'remada-sunset') as sunset,
    (
      select string_agg(format('%s=%s', slug, coalesce(default_capacity::text, 'null')), ', ' order by slug)
      from public.experiences
      where slug not in ('imersao-paranoa', 'remada-nascer-do-sol', 'remada-sunset')
    ) as others,
    (
      -- Sessões já existentes mantêm a própria capacity: default_capacity é só
      -- o ponto de partida de sessões novas. Este número muda apenas se alguém
      -- editar as sessões, nunca por causa da migration de capacidade.
      select count(*)
      from public.sessions session
      join public.experiences experience on experience.id = session.experience_id
      where experience.slug = 'imersao-paranoa'
    ) as imersao_sessions,
    (
      select string_agg(distinct session.capacity::text, ', ' order by session.capacity::text)
      from public.sessions session
      join public.experiences experience on experience.id = session.experience_id
      where experience.slug = 'imersao-paranoa'
    ) as imersao_session_capacities
)
select checks.check_name, checks.result, checks.status
from (
  select 1 as ord,
    'imersao_paranoa_default_capacity' as check_name,
    coalesce(facts.imersao::text, 'experiência ausente') as result,
    case when facts.imersao = 28 then 'OK' else 'REVIEW_REQUIRED' end as status
  from facts

  union all
  select 2,
    'remada_nascer_do_sol_default_capacity',
    coalesce(facts.nascer::text, 'experiência ausente'),
    case when facts.nascer = 28 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 3,
    'remada_sunset_default_capacity',
    coalesce(facts.sunset::text, 'experiência ausente'),
    case when facts.sunset = 28 then 'OK' else 'REVIEW_REQUIRED' end
  from facts

  union all
  select 4,
    'outras_experiencias_default_capacity',
    coalesce(facts.others, 'nenhuma outra experiência cadastrada'),
    'INFO'
  from facts

  union all
  select 5,
    'imersao_paranoa_sessoes_existentes',
    format('%s sessões, capacidades atuais: %s', facts.imersao_sessions, coalesce(facts.imersao_session_capacities, 'nenhuma')),
    'INFO'
  from facts

  union all
  select 6,
    'DEFAULT_CAPACITY_READY',
    case
      when facts.imersao = 28 and facts.nascer = 28 and facts.sunset = 28
        then 'as três experiências da agenda estão com capacidade padrão 28'
      else concat_ws('; ',
        case when facts.imersao is distinct from 28
          then format('imersao-paranoa = %s, esperado 28', coalesce(facts.imersao::text, 'ausente')) end,
        case when facts.nascer is distinct from 28
          then format('remada-nascer-do-sol = %s, esperado 28', coalesce(facts.nascer::text, 'ausente')) end,
        case when facts.sunset is distinct from 28
          then format('remada-sunset = %s, esperado 28', coalesce(facts.sunset::text, 'ausente')) end
      )
    end,
    case
      when facts.imersao = 28 and facts.nascer = 28 and facts.sunset = 28 then 'OK'
      else 'REVIEW_REQUIRED'
    end
  from facts
) checks
order by checks.ord;
