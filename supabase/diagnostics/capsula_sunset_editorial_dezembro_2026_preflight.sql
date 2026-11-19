-- REMADA SUNSET DO CÁPSULA BAR — TEXTO DA PÁGINA (DEZEMBRO/2026) — PREFLIGHT (SOMENTE LEITURA)
--
-- A partir de dezembro a Remada Sunset do Cápsula Bar tem dois formatos por
-- sessão: segunda a sexta 17:30, 60 min, R$ 60; sábado e domingo 17:00, 90
-- min, R$ 70 (supabase/maintenance/december_2026_schedule.sql). A página da
-- experiência dizia "1h30" e "R$ 70 por pessoa" em texto fixo. O texto novo
-- é neutro ("1h ou 1h30, conforme a turma"), verdadeiro tanto para o resto de
-- novembro (todas as turmas de 90 min e R$ 70) quanto para dezembro; o valor
-- exato de cada turma continua vindo da sessão (agenda, reserva, checkout).
--
-- Alvos (experiência remada-sunset-concha-acustica, base concha-acustica):
-- 8 textos em experiences.editorial_content e a coluna experiences.description.
-- Nada mais muda: preço, duração e capacidade padrão, status, sessões,
-- reservas e pagamentos não são tocados.
--
-- Um único SELECT, check_name | result | status. Linha final
-- READY_TO_UPDATE_CAPSULA_SUNSET_EDITORIAL só fica OK quando todos os alvos
-- estão com o texto antigo esperado (ou já com o novo, se o script já rodou).
-- editorial_rest_fingerprint (tudo menos os 8 alvos) e other_columns_fingerprint
-- servem de linha de base para o postcheck.

with targets (ord, path, from_text, to_text) as (
    values
      (1, '{hero,subtitle}'::text[],
       'Uma remada de 1h30 em canoa havaiana, saindo do Cápsula Bar, ao lado da Concha Acústica, para acompanhar as últimas luzes do dia no Lago Paranoá.',
       'Uma remada em canoa havaiana, saindo do Cápsula Bar, ao lado da Concha Acústica, para acompanhar as últimas luzes do dia no Lago Paranoá.'),
      (2, '{hero,details,0}'::text[],
       'Duração: 1h30',
       'Duração: 1h ou 1h30, conforme a turma'),
      (3, '{quickFacts,0,value}'::text[],
       '1h30',
       '1h ou 1h30, conforme a turma'),
      (4, '{quickFacts,4,value}'::text[],
       'R$ 70 por pessoa',
       'R$ 60 ou R$ 70 por pessoa, conforme a turma'),
      (5, '{about,paragraphs,1}'::text[],
       'Durante 1h30, navegamos em um ritmo tranquilo, com tempo para remar, conversar e contemplar o pôr do sol com Brasília vista a partir da água.',
       'Em um ritmo tranquilo, navegamos com tempo para remar, conversar e contemplar o pôr do sol com Brasília vista a partir da água.'),
      (6, '{steps,description}'::text[],
       'Uma experiência de 1h30 em ritmo tranquilo, conduzida pela equipe Alma Azul.',
       'Uma experiência em ritmo tranquilo, conduzida pela equipe Alma Azul.'),
      (7, '{reservations,description}'::text[],
       'Uma experiência de 1h30 em canoa havaiana para contemplar o pôr do sol no Lago Paranoá, saindo do Cápsula Bar, ao lado da Concha Acústica.',
       'Uma experiência em canoa havaiana para contemplar o pôr do sol no Lago Paranoá, saindo do Cápsula Bar, ao lado da Concha Acústica. A duração e o valor de cada turma aparecem na agenda.'),
      (8, '{seo,description}'::text[],
       'Contemple o pôr do sol de Brasília em uma canoa havaiana, saindo do Cápsula Bar, ao lado da Concha Acústica. Experiência de 1h30 com instrução e acompanhamento completo.',
       'Contemple o pôr do sol de Brasília em uma canoa havaiana, saindo do Cápsula Bar, ao lado da Concha Acústica. Turmas de 1h ou 1h30, com instrução e acompanhamento completo.')
  ),
experience as (
  select e.*
  from public.experiences e
  join public.bases b on b.id = e.base_id
  where e.slug = 'remada-sunset-concha-acustica' and b.slug = 'concha-acustica'
),
state as (
  select t.ord, t.path, e.editorial_content #>> t.path as current_text,
         case
           when e.editorial_content #>> t.path = t.to_text then 'NOVO'
           when e.editorial_content #>> t.path = t.from_text then 'ANTIGO'
           else 'DIVERGENTE'
         end as state
  from targets t cross join experience e
),
facts as (
  select
    (select count(*) from experience) as experience_rows,
    (select format('id %s, %s/%s, preço padrão %s, duração padrão %s, capacidade padrão %s', id, kind, status, price_cents, duration_minutes, default_capacity) from experience) as experience_info,
    (select (editorial_content #>> '{quickFacts,0,label}') = 'Duração' and (editorial_content #>> '{quickFacts,4,label}') = 'Valor' from experience) as labels_ok,
    (select count(*) from state where state = 'ANTIGO') as old_count,
    (select count(*) from state where state = 'NOVO') as new_count,
    (select count(*) from state where state = 'DIVERGENTE') as divergent_count,
    (select string_agg(format('%s %s: %s', s.ord, s.path::text, left(coalesce(s.current_text, '(ausente)'), 90)), ' · ' order by s.ord)
     from state s where s.state = 'DIVERGENTE') as divergent_list,
    (select case when description = 'Uma experiência em canoa havaiana para contemplar o pôr do sol no Lago Paranoá, saindo do Cápsula Bar, ao lado da Concha Acústica.' then 'NOVO' when description = 'Uma experiência de 1h30 em canoa havaiana para contemplar o pôr do sol no Lago Paranoá, saindo do Cápsula Bar, ao lado da Concha Acústica.' then 'ANTIGO' else 'DIVERGENTE' end from experience) as description_state,
    (select md5(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(editorial_content, '{hero,subtitle}'::text[], '"__ALVO__"'::jsonb, false), '{hero,details,0}'::text[], '"__ALVO__"'::jsonb, false), '{quickFacts,0,value}'::text[], '"__ALVO__"'::jsonb, false), '{quickFacts,4,value}'::text[], '"__ALVO__"'::jsonb, false), '{about,paragraphs,1}'::text[], '"__ALVO__"'::jsonb, false), '{steps,description}'::text[], '"__ALVO__"'::jsonb, false), '{reservations,description}'::text[], '"__ALVO__"'::jsonb, false), '{seo,description}'::text[], '"__ALVO__"'::jsonb, false)::text) from experience) as editorial_rest_fingerprint,
    (select md5(concat_ws('|', title, summary, status, kind, price_cents, duration_minutes, default_capacity, image_url, base_id, display_order)) from experience) as other_columns_fingerprint,
    (select md5(editorial_content::text) from experience) as editorial_fingerprint,
    (select case when to_regprocedure('public.experience_editorial_is_publishable(jsonb)') is null then null
                 else public.experience_editorial_is_publishable(editorial_content) end from experience) as publishable
)
select checks.check_name, checks.result, checks.status
from (
  select 1 as ord, 'experience' as check_name, coalesce(facts.experience_info, 'não encontrada') as result,
         case when facts.experience_rows = 1 then 'OK' else 'REVIEW_REQUIRED' end as status from facts
  union all select 2, 'quick_facts_labels', case when facts.labels_ok then 'Duração na posição 0, Valor na posição 4' else 'ordem diferente' end,
         case when facts.labels_ok then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 3, 'targets_old_text', facts.old_count::text, 'INFO' from facts
  union all select 4, 'targets_new_text', facts.new_count::text, 'INFO' from facts
  union all select 5, 'targets_divergent', facts.divergent_count::text,
         case when facts.divergent_count = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 6, 'targets_divergent_list', coalesce(facts.divergent_list, 'nenhum'), 'INFO' from facts
  union all select 7, 'description_column', facts.description_state,
         case when facts.description_state <> 'DIVERGENTE' then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 8, 'editorial_publishable', coalesce(facts.publishable::text, 'função ausente'), 'INFO' from facts
  union all select 9, 'editorial_fingerprint', facts.editorial_fingerprint, 'INFO: para a reversão' from facts
  union all select 10, 'editorial_rest_fingerprint', facts.editorial_rest_fingerprint, 'INFO: comparar no postcheck' from facts
  union all select 11, 'other_columns_fingerprint', facts.other_columns_fingerprint, 'INFO: comparar no postcheck' from facts
  union all select 12, 'READY_TO_UPDATE_CAPSULA_SUNSET_EDITORIAL',
         case
           when facts.experience_rows <> 1 then 'experiência não encontrada ou duplicada'
           when not facts.labels_ok then 'quickFacts fora da ordem esperada'
           when facts.divergent_count > 0 or facts.description_state = 'DIVERGENTE' then 'texto atual diferente do esperado: nada será alterado'
           when facts.new_count = 8 and facts.description_state = 'NOVO' then 'já aplicado: o script não muda nada'
           else format('pronto: %s texto(s) da página e a descrição serão atualizados', facts.old_count)
         end,
         case when facts.experience_rows = 1 and facts.labels_ok and facts.divergent_count = 0 and facts.description_state <> 'DIVERGENTE'
              then 'OK' else 'REVIEW_REQUIRED' end
  from facts
) checks
order by checks.ord;
