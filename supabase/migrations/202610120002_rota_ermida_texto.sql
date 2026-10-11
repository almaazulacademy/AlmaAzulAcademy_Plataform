-- Rota Ermida Ponte JK: correção do texto do percurso.
--
-- A remada não chega à Ponte JK. O grupo rema até a prainha da Ermida Dom
-- Bosco, onde para para um banho; a ponte é vista durante quase todo o trajeto
-- e também na parada. Os textos semeados por 202610120001 diziam "pela Ponte JK".
--
-- Só texto, só nesta rota. Idempotente: cada trecho só é trocado enquanto ainda
-- é exatamente o texto anterior, então edições feitas pelo painel são mantidas.
-- Não muda status, slug, preço, duração, capacidade, sessões nem reservas.

do $migration$
declare
  route_slug constant text := 'rota-ermida-ponte-jk';
  old_summary constant text := 'Uma remada contemplativa pela Ponte JK, com parada na prainha da Ermida Dom Bosco.';
  new_summary constant text := 'Uma remada contemplativa até a prainha da Ermida Dom Bosco, com parada para banho e a Ponte JK à vista.';
  fix record;
begin
  update public.experiences set summary = new_summary where slug = route_slug and summary = old_summary;
  update public.experiences set description = new_summary where slug = route_slug and description = old_summary;

  for fix in
    select *
    from (values
      (
        '{hero,title}'::text[],
        'A Ponte JK vista de dentro de uma canoa havaiana.',
        'Remar até a Ermida Dom Bosco, com a Ponte JK no horizonte.'
      ),
      (
        '{hero,subtitle}'::text[],
        'Uma remada contemplativa de 1h30 em canoa havaiana pelo Lago Paranoá, saindo do Cápsula Bar, ao lado da Concha Acústica. Confira as próximas datas e horários disponíveis.',
        'Uma remada contemplativa de 1h30 em canoa havaiana pelo Lago Paranoá, saindo do Cápsula Bar, ao lado da Concha Acústica, com parada para banho na prainha da Ermida Dom Bosco. Confira as próximas datas e horários disponíveis.'
      ),
      (
        '{quickFacts,5,value}'::text[],
        'Ponte JK, com parada na prainha da Ermida Dom Bosco',
        'Até a prainha da Ermida Dom Bosco, com parada para banho'
      ),
      (
        '{about,paragraphs,1}'::text[],
        'É um percurso contemplativo: remamos pela Ponte JK, um dos cartões-postais de Brasília, com parada na prainha da Ermida Dom Bosco.',
        'É um percurso contemplativo: remamos até a prainha da Ermida Dom Bosco, onde paramos para um banho no lago. A Ponte JK, um dos cartões-postais de Brasília, acompanha a vista durante quase todo o trajeto — e também na parada.'
      ),
      (
        '{seo,description}'::text[],
        'Remada de 1h30 em canoa havaiana pela Ponte JK, com parada na prainha da Ermida Dom Bosco, saindo do Cápsula Bar. Iniciantes são bem-vindos. Confira as próximas datas e horários.',
        'Remada de 1h30 em canoa havaiana até a prainha da Ermida Dom Bosco, com parada para banho e vista da Ponte JK, saindo do Cápsula Bar. Iniciantes são bem-vindos. Confira as próximas datas e horários.'
      )
    ) as seed(path, old_text, new_text)
  loop
    update public.experiences
    set editorial_content = jsonb_set(editorial_content, fix.path, to_jsonb(fix.new_text))
    where slug = route_slug and editorial_content #>> fix.path = fix.old_text;
  end loop;
end;
$migration$;
