-- REMADA SUNSET DO CÁPSULA BAR — TEXTO DA PÁGINA (DEZEMBRO/2026) — REVERSÃO (volta ao texto de 1h30 / R$ 70)
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
-- Transação única com a linha da experiência travada (for update). Cada alvo
-- precisa estar com o texto de origem esperado ou já com o de destino
-- (idempotente: rodar de novo não muda nada). Qualquer outro texto aborta e
-- desfaz tudo. Confere que o resto do conteúdo editorial e as demais colunas
-- ficaram idênticos e grava uma linha EXPERIENCE_UPDATED em admin_audit_log.

begin;
set local lock_timeout = '5s';

do $capsula_sunset_editorial_rollback$
declare
  source_name constant text := 'capsula_sunset_editorial_dezembro_2026_rollback';
  desc_from constant text := 'Uma experiência em canoa havaiana para contemplar o pôr do sol no Lago Paranoá, saindo do Cápsula Bar, ao lado da Concha Acústica.';
  desc_to constant text := 'Uma experiência de 1h30 em canoa havaiana para contemplar o pôr do sol no Lago Paranoá, saindo do Cápsula Bar, ao lado da Concha Acústica.';
  target record;
  exp record;
  current_text text;
  new_editorial jsonb;
  changed integer := 0;
  already integer := 0;
  rest_before text;
  rest_after text;
  others_before text;
  others_after text;
begin
  select e.* into exp
  from public.experiences e
  join public.bases b on b.id = e.base_id
  where e.slug = 'remada-sunset-concha-acustica' and b.slug = 'concha-acustica'
  for update of e;
  if not found then
    raise exception 'CAPSULA_SUNSET_EXPERIENCE_NOT_FOUND';
  end if;
  if exp.kind::text <> 'REGULAR' then
    raise exception 'CAPSULA_SUNSET_EXPERIENCE_NOT_REGULAR';
  end if;
  if (exp.editorial_content #>> '{quickFacts,0,label}') is distinct from 'Duração'
     or (exp.editorial_content #>> '{quickFacts,4,label}') is distinct from 'Valor' then
    raise exception 'CAPSULA_SUNSET_QUICK_FACTS_ORDER_CHANGED';
  end if;

  new_editorial := exp.editorial_content;
  for target in
    select * from (values
      (1, '{hero,subtitle}'::text[],
       'Uma remada em canoa havaiana, saindo do Cápsula Bar, ao lado da Concha Acústica, para acompanhar as últimas luzes do dia no Lago Paranoá.',
       'Uma remada de 1h30 em canoa havaiana, saindo do Cápsula Bar, ao lado da Concha Acústica, para acompanhar as últimas luzes do dia no Lago Paranoá.'),
      (2, '{hero,details,0}'::text[],
       'Duração: 1h ou 1h30, conforme a turma',
       'Duração: 1h30'),
      (3, '{quickFacts,0,value}'::text[],
       '1h ou 1h30, conforme a turma',
       '1h30'),
      (4, '{quickFacts,4,value}'::text[],
       'R$ 60 ou R$ 70 por pessoa, conforme a turma',
       'R$ 70 por pessoa'),
      (5, '{about,paragraphs,1}'::text[],
       'Em um ritmo tranquilo, navegamos com tempo para remar, conversar e contemplar o pôr do sol com Brasília vista a partir da água.',
       'Durante 1h30, navegamos em um ritmo tranquilo, com tempo para remar, conversar e contemplar o pôr do sol com Brasília vista a partir da água.'),
      (6, '{steps,description}'::text[],
       'Uma experiência em ritmo tranquilo, conduzida pela equipe Alma Azul.',
       'Uma experiência de 1h30 em ritmo tranquilo, conduzida pela equipe Alma Azul.'),
      (7, '{reservations,description}'::text[],
       'Uma experiência em canoa havaiana para contemplar o pôr do sol no Lago Paranoá, saindo do Cápsula Bar, ao lado da Concha Acústica. A duração e o valor de cada turma aparecem na agenda.',
       'Uma experiência de 1h30 em canoa havaiana para contemplar o pôr do sol no Lago Paranoá, saindo do Cápsula Bar, ao lado da Concha Acústica.'),
      (8, '{seo,description}'::text[],
       'Contemple o pôr do sol de Brasília em uma canoa havaiana, saindo do Cápsula Bar, ao lado da Concha Acústica. Turmas de 1h ou 1h30, com instrução e acompanhamento completo.',
       'Contemple o pôr do sol de Brasília em uma canoa havaiana, saindo do Cápsula Bar, ao lado da Concha Acústica. Experiência de 1h30 com instrução e acompanhamento completo.')
    ) as t(ord, path, from_text, to_text)
    order by ord
  loop
    current_text := exp.editorial_content #>> target.path;
    if current_text = target.to_text then
      already := already + 1;
    elsif current_text = target.from_text then
      new_editorial := jsonb_set(new_editorial, target.path, to_jsonb(target.to_text), false);
      changed := changed + 1;
    else
      raise exception using message = 'CAPSULA_SUNSET_TEXT_UNEXPECTED',
        detail = format('Alvo %s (%s) está com: %s', target.ord, target.path::text, coalesce(current_text, '(ausente)'));
    end if;
  end loop;

  if exp.description is distinct from desc_from and exp.description is distinct from desc_to then
    raise exception using message = 'CAPSULA_SUNSET_DESCRIPTION_UNEXPECTED',
      detail = format('description está com: %s', coalesce(exp.description, '(nula)'));
  end if;

  if changed = 0 and exp.description = desc_to then
    raise notice 'Nada a fazer: os 8 textos e a descrição já estão aplicados.';
    return;
  end if;

  rest_before := md5(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(exp.editorial_content, '{hero,subtitle}'::text[], '"__ALVO__"'::jsonb, false), '{hero,details,0}'::text[], '"__ALVO__"'::jsonb, false), '{quickFacts,0,value}'::text[], '"__ALVO__"'::jsonb, false), '{quickFacts,4,value}'::text[], '"__ALVO__"'::jsonb, false), '{about,paragraphs,1}'::text[], '"__ALVO__"'::jsonb, false), '{steps,description}'::text[], '"__ALVO__"'::jsonb, false), '{reservations,description}'::text[], '"__ALVO__"'::jsonb, false), '{seo,description}'::text[], '"__ALVO__"'::jsonb, false)::text);
  rest_after := md5(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(new_editorial, '{hero,subtitle}'::text[], '"__ALVO__"'::jsonb, false), '{hero,details,0}'::text[], '"__ALVO__"'::jsonb, false), '{quickFacts,0,value}'::text[], '"__ALVO__"'::jsonb, false), '{quickFacts,4,value}'::text[], '"__ALVO__"'::jsonb, false), '{about,paragraphs,1}'::text[], '"__ALVO__"'::jsonb, false), '{steps,description}'::text[], '"__ALVO__"'::jsonb, false), '{reservations,description}'::text[], '"__ALVO__"'::jsonb, false), '{seo,description}'::text[], '"__ALVO__"'::jsonb, false)::text);
  if rest_after is distinct from rest_before then
    raise exception 'CAPSULA_SUNSET_EDITORIAL_REST_CHANGED';
  end if;

  if to_regprocedure('public.experience_editorial_is_publishable(jsonb)') is not null
     and exp.status = 'PUBLISHED'
     and not public.experience_editorial_is_publishable(new_editorial) then
    raise exception 'CAPSULA_SUNSET_EDITORIAL_NOT_PUBLISHABLE';
  end if;

  others_before := md5(concat_ws('|', exp.title, exp.summary, exp.status, exp.kind, exp.price_cents, exp.duration_minutes,
    exp.default_capacity, exp.image_url, exp.base_id, exp.display_order));

  update public.experiences
  set editorial_content = new_editorial,
      description = desc_to,
      updated_at = now()
  where id = exp.id;

  select md5(concat_ws('|', e.title, e.summary, e.status, e.kind, e.price_cents, e.duration_minutes,
           e.default_capacity, e.image_url, e.base_id, e.display_order))
  into others_after
  from public.experiences e where e.id = exp.id;
  if others_after is distinct from others_before then
    raise exception 'CAPSULA_SUNSET_OTHER_COLUMNS_CHANGED';
  end if;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (null, 'EXPERIENCE_UPDATED', 'experience', exp.id,
          jsonb_build_object('source', source_name, 'editorialTextsChanged', changed,
                             'descriptionChanged', exp.description is distinct from desc_to));

  raise notice 'Remada Sunset do Cápsula: % texto(s) alterado(s), % já estavam aplicados; descrição %.',
    changed, already, case when exp.description is distinct from desc_to then 'alterada' else 'já aplicada' end;
end;
$capsula_sunset_editorial_rollback$;

commit;
