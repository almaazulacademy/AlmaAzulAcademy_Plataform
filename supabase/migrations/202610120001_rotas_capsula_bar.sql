-- Rotas da Base Cápsula Bar — Concha Acústica: nomes próprios e landing.
--
-- O agrupamento "Caminhos do Paranoá" deixa de existir. As duas rotas passam a
-- ser experiências independentes, com nome, URL e página próprios:
--
--   caminhos-do-paranoa-rota-ermida-ponte-jk      → rota-ermida-ponte-jk
--   caminhos-do-paranoa-rota-prainha-do-congresso → rota-prainha-do-congresso
--
-- Aditiva e idempotente. Os registros são os mesmos: nenhum id muda, nenhuma
-- experiência, sessão ou reserva é criada, apagada ou movida, e nenhuma RPC é
-- alterada. Sessões e reservas apontam para `experiences.id`, então continuam
-- ligadas às rotas depois da troca de slug.
--
-- O que muda, só nas duas rotas:
--   1. slug e modality (a modality só agrupa cards na vitrine);
--   2. título comercial;
--   3. foto do card da Rota Prainha do Congresso, para as duas não repetirem a
--      mesma imagem;
--   4. conteúdo editorial da landing, preenchido apenas onde ainda está vazio.
--
-- O que NÃO muda: status (as rotas continuam COMING_SOON — a publicação é feita
-- pelo painel), preço, duração, capacidade e qualquer outra experiência.
-- Nenhuma sessão é criada: datas, horários, valores e vagas são do painel.
--
-- Reaplicar é seguro: cada bloco só age sobre o valor semeado pelas migrations
-- anteriores, então edições feitas depois pelo painel nunca são sobrescritas.
--
-- O site redireciona as URLs antigas para as novas (308) em
-- `app/experiencias/[slug]/page.tsx`, só quando o slug antigo já não existe.

do $$
begin
  if to_regclass('public.bases') is null
     or not exists (select 1 from public.bases where slug = 'concha-acustica') then
    raise exception 'CONCHA_ACUSTICA_BASE_REQUIRED';
  end if;
  if not exists (
    select 1 from public.experiences
    where slug in ('caminhos-do-paranoa-rota-ermida-ponte-jk', 'rota-ermida-ponte-jk')
  ) or not exists (
    select 1 from public.experiences
    where slug in ('caminhos-do-paranoa-rota-prainha-do-congresso', 'rota-prainha-do-congresso')
  ) then
    raise exception 'CAPSULA_BAR_LAUNCH_MIGRATION_REQUIRED';
  end if;
end;
$$;

do $migration$
declare
  capsula_id uuid;
  route record;
begin
  select id into capsula_id from public.bases where slug = 'concha-acustica';

  for route in
    select *
    from (values
      (
        'caminhos-do-paranoa-rota-ermida-ponte-jk',
        'rota-ermida-ponte-jk',
        'Caminhos do Paranoá — Rota Ermida x Ponte JK',
        'Rota Ermida Ponte JK',
        '/images/bases/concha-acustica/experiencia-caminhos-do-paranoa.webp',
        '/images/bases/concha-acustica/experiencia-caminhos-do-paranoa.webp',
        $editorial$
        {
          "version": 1,
          "hero": {
            "eyebrow": "REMADA DE DIA · CÁPSULA BAR — CONCHA ACÚSTICA",
            "title": "A Ponte JK vista de dentro de uma canoa havaiana.",
            "subtitle": "Uma remada contemplativa pelo Lago Paranoá, saindo do Cápsula Bar, ao lado da Concha Acústica. Confira as próximas datas e horários disponíveis.",
            "image": {
              "src": "/images/bases/concha-acustica/experiencia-caminhos-do-paranoa.webp",
              "alt": "Canoa havaiana da Alma Azul no Lago Paranoá com a Ponte JK ao fundo",
              "credit": "Registros de experiências Alma Azul no Lago Paranoá"
            },
            "primaryCta": { "label": "Reservar minha vaga", "href": "#reservas" },
            "secondaryCta": { "label": "Conhecer a experiência", "href": "#sobre" },
            "details": ["Local: Cápsula Bar — Concha Acústica", "Período: durante o dia"]
          },
          "cardImage": {
            "src": "/images/bases/concha-acustica/experiencia-caminhos-do-paranoa.webp",
            "alt": "Canoa havaiana da Alma Azul no Lago Paranoá com a Ponte JK ao fundo"
          },
          "quickFacts": [
            { "label": "Local de saída", "value": "Cápsula Bar — Concha Acústica" },
            { "label": "Ponto de encontro", "value": "Em frente ao Cápsula Bar" },
            { "label": "Embarcação", "value": "Canoa havaiana" },
            { "label": "Percurso", "value": "Ponte JK, com parada na prainha da Ermida Dom Bosco" },
            { "label": "Datas e horários", "value": "Confira as próximas datas disponíveis" }
          ],
          "about": {
            "eyebrow": "Sobre a experiência",
            "title": "Rota Ermida Ponte JK",
            "paragraphs": [
              "A Rota Ermida Ponte JK é uma remada de dia em canoa havaiana pelo Lago Paranoá, saindo da base da Alma Azul no Cápsula Bar, ao lado da Concha Acústica.",
              "É um percurso contemplativo: remamos pela Ponte JK, um dos cartões-postais de Brasília, com parada na prainha da Ermida Dom Bosco.",
              "É o jeito da Alma Azul de conectar pessoas à natureza por meio da canoa havaiana — e de mostrar Brasília a partir da água.",
              "Esta rota não tem horário fixo: as saídas acontecem durante o dia, conforme a programação da Alma Azul. Confira as próximas datas e horários disponíveis."
            ],
            "image": {
              "src": "/images/bases/concha-acustica/caminhos-do-paranoa-ambiente-01.webp",
              "alt": "Canoa havaiana da Alma Azul navegando em um dia de céu azul no Lago Paranoá",
              "credit": "Registros de experiências Alma Azul no Lago Paranoá"
            }
          },
          "faq": {
            "eyebrow": "Dúvidas frequentes",
            "title": "Antes de entrar na água.",
            "locationLabel": "Cápsula Bar — Concha Acústica · SHTN Trecho 1, Lote 8",
            "items": [
              { "question": "Onde é o ponto de encontro?", "answer": "Em frente ao Cápsula Bar, ao lado da Concha Acústica: SHTN Trecho 1, Lote 8 — Brasília/DF. O link do Google Maps está nesta página e no e-mail de confirmação da reserva." },
              { "question": "Qual é o horário da experiência?", "answer": "Não há horário fixo. As saídas acontecem durante o dia, conforme a programação da Alma Azul. Confira as próximas datas e horários disponíveis nesta página." },
              { "question": "Existe estacionamento?", "answer": "As orientações de chegada e de estacionamento no Cápsula Bar são enviadas pela nossa equipe no grupo da experiência, criado até um dia antes." },
              { "question": "Há banheiro no local?", "answer": "O ponto de encontro fica no Cápsula Bar. As orientações sobre a estrutura disponível no dia são enviadas pela nossa equipe no grupo da experiência." }
            ]
          },
          "reservations": {
            "eyebrow": "Rota Ermida Ponte JK · Cápsula Bar",
            "title": "Reservar minha vaga",
            "description": "Confira as próximas datas e horários disponíveis e escolha a sua turma.",
            "image": {
              "src": "/images/bases/concha-acustica/caminhos-do-paranoa-ambiente-02.webp",
              "alt": "Grupo remando em canoa havaiana sob céu azul no Lago Paranoá",
              "credit": "Registros de experiências Alma Azul no Lago Paranoá"
            }
          },
          "seo": {
            "title": "Rota Ermida Ponte JK — Canoa havaiana no Lago Paranoá | Alma Azul Academy",
            "description": "Remada de dia em canoa havaiana pela Ponte JK, com parada na prainha da Ermida Dom Bosco, saindo do Cápsula Bar, ao lado da Concha Acústica. Confira as próximas datas e horários."
          }
        }
        $editorial$::jsonb
      ),
      (
        'caminhos-do-paranoa-rota-prainha-do-congresso',
        'rota-prainha-do-congresso',
        'Caminhos do Paranoá — Rota Prainha do Congresso',
        'Rota Prainha do Congresso',
        '/images/bases/concha-acustica/experiencia-caminhos-do-paranoa.webp',
        '/images/bases/concha-acustica/caminhos-do-paranoa-ambiente-02.webp',
        $editorial$
        {
          "version": 1,
          "hero": {
            "eyebrow": "REMADA DE DIA · CÁPSULA BAR — CONCHA ACÚSTICA",
            "title": "Uma remada de dia rumo à Prainha do Congresso.",
            "subtitle": "Canoa havaiana pelo Lago Paranoá, saindo do Cápsula Bar, ao lado da Concha Acústica. Confira as próximas datas e horários disponíveis.",
            "image": {
              "src": "/images/bases/concha-acustica/caminhos-do-paranoa-ambiente-02.webp",
              "alt": "Grupo remando em canoa havaiana sob céu azul no Lago Paranoá",
              "credit": "Registros de experiências Alma Azul no Lago Paranoá"
            },
            "primaryCta": { "label": "Reservar minha vaga", "href": "#reservas" },
            "secondaryCta": { "label": "Conhecer a experiência", "href": "#sobre" },
            "details": ["Local: Cápsula Bar — Concha Acústica", "Período: durante o dia"]
          },
          "cardImage": {
            "src": "/images/bases/concha-acustica/caminhos-do-paranoa-ambiente-02.webp",
            "alt": "Grupo remando em canoa havaiana sob céu azul no Lago Paranoá"
          },
          "quickFacts": [
            { "label": "Local de saída", "value": "Cápsula Bar — Concha Acústica" },
            { "label": "Ponto de encontro", "value": "Em frente ao Cápsula Bar" },
            { "label": "Embarcação", "value": "Canoa havaiana" },
            { "label": "Percurso", "value": "Em direção à prainha do Clube do Congresso" },
            { "label": "Datas e horários", "value": "Confira as próximas datas disponíveis" }
          ],
          "about": {
            "eyebrow": "Sobre a experiência",
            "title": "Rota Prainha do Congresso",
            "paragraphs": [
              "A Rota Prainha do Congresso é uma remada de dia em canoa havaiana pelo Lago Paranoá, saindo da base da Alma Azul no Cápsula Bar, ao lado da Concha Acústica.",
              "O percurso segue em direção à prainha do Clube do Congresso, com Brasília vista a partir da água.",
              "É o jeito da Alma Azul de conectar pessoas à natureza por meio da canoa havaiana — e de viver o Lago Paranoá por outro ponto de vista.",
              "Esta rota não tem horário fixo: as saídas acontecem durante o dia, conforme a programação da Alma Azul. Confira as próximas datas e horários disponíveis."
            ],
            "image": {
              "src": "/images/bases/concha-acustica/caminhos-do-paranoa-ambiente-01.webp",
              "alt": "Canoa havaiana da Alma Azul navegando em um dia de céu azul no Lago Paranoá",
              "credit": "Registros de experiências Alma Azul no Lago Paranoá"
            }
          },
          "faq": {
            "eyebrow": "Dúvidas frequentes",
            "title": "Antes de entrar na água.",
            "locationLabel": "Cápsula Bar — Concha Acústica · SHTN Trecho 1, Lote 8",
            "items": [
              { "question": "Onde é o ponto de encontro?", "answer": "Em frente ao Cápsula Bar, ao lado da Concha Acústica: SHTN Trecho 1, Lote 8 — Brasília/DF. O link do Google Maps está nesta página e no e-mail de confirmação da reserva." },
              { "question": "Qual é o horário da experiência?", "answer": "Não há horário fixo. As saídas acontecem durante o dia, conforme a programação da Alma Azul. Confira as próximas datas e horários disponíveis nesta página." },
              { "question": "Existe estacionamento?", "answer": "As orientações de chegada e de estacionamento no Cápsula Bar são enviadas pela nossa equipe no grupo da experiência, criado até um dia antes." },
              { "question": "Há banheiro no local?", "answer": "O ponto de encontro fica no Cápsula Bar. As orientações sobre a estrutura disponível no dia são enviadas pela nossa equipe no grupo da experiência." }
            ]
          },
          "reservations": {
            "eyebrow": "Rota Prainha do Congresso · Cápsula Bar",
            "title": "Reservar minha vaga",
            "description": "Confira as próximas datas e horários disponíveis e escolha a sua turma.",
            "image": {
              "src": "/images/bases/concha-acustica/caminhos-do-paranoa-ambiente-01.webp",
              "alt": "Canoa havaiana da Alma Azul navegando em um dia de céu azul no Lago Paranoá",
              "credit": "Registros de experiências Alma Azul no Lago Paranoá"
            }
          },
          "seo": {
            "title": "Rota Prainha do Congresso — Canoa havaiana no Lago Paranoá | Alma Azul Academy",
            "description": "Remada de dia em canoa havaiana em direção à prainha do Clube do Congresso, saindo do Cápsula Bar, ao lado da Concha Acústica. Confira as próximas datas e horários."
          }
        }
        $editorial$::jsonb
      )
    ) as seed(old_slug, new_slug, old_title, new_title, seeded_image, card_image, editorial)
  loop
    -- 1. Slug: o mesmo registro ganha a URL curta. Só age se o slug antigo
    --    ainda existe na base e o novo está livre.
    update public.experiences e
    set slug = route.new_slug
    where e.slug = route.old_slug
      and e.base_id = capsula_id
      and not exists (select 1 from public.experiences other where other.slug = route.new_slug);

    -- A modality acompanhava o slug antigo; só é trocada nesse caso.
    update public.experiences
    set modality = route.new_slug
    where slug = route.new_slug and base_id = capsula_id and modality = route.old_slug;

    -- 2. Nome comercial: só troca o título semeado.
    update public.experiences
    set title = route.new_title
    where slug = route.new_slug and base_id = capsula_id and title = route.old_title;

    -- 3. Foto do card: só troca a imagem semeada.
    update public.experiences
    set image_url = route.card_image
    where slug = route.new_slug and base_id = capsula_id
      and image_url = route.seeded_image and route.card_image <> route.seeded_image;

    -- 4. Landing: só preenche onde ainda não existe conteúdo editorial.
    update public.experiences
    set editorial_content = route.editorial
    where slug = route.new_slug and base_id = capsula_id
      and (editorial_content is null or editorial_content = '{}'::jsonb);
  end loop;
end;
$migration$;
