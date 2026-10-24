-- Remada da Lua Cheia · Base Cápsula Bar — Concha Acústica: landing.
--
-- O cadastro `remada-lua-cheia-concha-acustica` já existe (multi-base) com preço,
-- duração e capacidade da base (capsula_bar_launch). Falta só a landing: esta
-- migration preenche o conteúdo editorial, adaptado da Remada da Lua Cheia do
-- Lago Norte. Diferença: no Cápsula Bar não há fogueira.
--
-- Aditiva e idempotente. Só age enquanto o conteúdo editorial ainda está vazio,
-- então edições feitas pelo painel nunca são sobrescritas. Nenhuma sessão,
-- reserva ou RPC é tocada; status, preço, duração e capacidade não mudam. A
-- experiência continua "em breve": a publicação e as datas são do painel.
-- A experiência do Lago Norte (`remada-lua-cheia`) não é tocada.

do $$
begin
  if to_regclass('public.bases') is null
     or not exists (select 1 from public.bases where slug = 'concha-acustica') then
    raise exception 'CONCHA_ACUSTICA_BASE_REQUIRED';
  end if;
  if not exists (
    select 1 from public.experiences e join public.bases b on b.id = e.base_id
    where e.slug = 'remada-lua-cheia-concha-acustica' and b.slug = 'concha-acustica'
  ) then
    raise exception 'REMADA_LUA_CHEIA_CONCHA_REQUIRED';
  end if;
end;
$$;

do $migration$
declare
  capsula_id uuid;
  experience_editorial jsonb;
begin
  select id into capsula_id from public.bases where slug = 'concha-acustica';

  experience_editorial := $editorial$
  {
    "version": 1,
    "hero": {
      "eyebrow": "NOITE DE LUA CHEIA · CÁPSULA BAR — CONCHA ACÚSTICA",
      "title": "Reme sob a luz da lua cheia.",
      "subtitle": "Uma experiência contemplativa em canoa havaiana, saindo do Cápsula Bar, ao lado da Concha Acústica, para acompanhar a lua nascendo no horizonte e mergulhar no Lago Paranoá.",
      "image": {
        "src": "/images/bases/concha-acustica/experiencia-remada-da-lua-cheia.webp",
        "alt": "Canoas havaianas no Lago Paranoá com a lua cheia nascendo no horizonte"
      },
      "primaryCta": { "label": "Ver próximas datas", "href": "#reservas" },
      "secondaryCta": { "label": "Conhecer a experiência", "href": "#sobre" },
      "details": ["Duração: 1h30", "Local: Cápsula Bar — Concha Acústica", "Nível: iniciantes ao avançado"]
    },
    "cardImage": {
      "src": "/images/bases/concha-acustica/experiencia-remada-da-lua-cheia.webp",
      "alt": "Canoas havaianas no Lago Paranoá com a lua cheia nascendo no horizonte"
    },
    "quickFacts": [
      { "label": "Duração da remada", "value": "1h30" },
      { "label": "Frequência", "value": "programação mensal" },
      { "label": "Local de saída", "value": "Cápsula Bar — Concha Acústica" },
      { "label": "Ponto de encontro", "value": "Em frente ao Cápsula Bar" },
      { "label": "Nível", "value": "iniciantes ao avançado" },
      { "label": "Datas e horários", "value": "Confira as próximas datas disponíveis" }
    ],
    "about": {
      "eyebrow": "Sobre a experiência",
      "title": "Remada da Lua Cheia",
      "paragraphs": [
        "A Remada da Lua Cheia é um convite para contemplar o Lago Paranoá sob uma nova luz. Saindo do Cápsula Bar, ao lado da Concha Acústica, acompanhamos de dentro da canoa havaiana a lua surgindo no horizonte e refletindo sobre as águas.",
        "Nos primeiros dias da programação, a experiência pode começar ainda com a luz do entardecer, permitindo acompanhar o pôr do sol e, logo depois, o nascimento da lua — algumas vezes, os dois no mesmo horizonte.",
        "Durante a remada, fazemos pausas para contemplação e banho. Para quem busca mais aventura, há a possibilidade de mergulhar no meio do lago.",
        "O retorno ao Cápsula Bar acontece já no escuro, com a lua iluminando o caminho de volta sobre as águas."
      ],
      "image": {
        "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-sobre.webp",
        "alt": "Participantes em uma canoa havaiana à noite com a lua refletida no lago"
      }
    },
    "gallery": {
      "eyebrow": "Galeria",
      "title": "Remada da Lua Cheia",
      "description": "Uma remada sob a lua cheia, com banho no lago e contemplação no horizonte.",
      "images": [
        { "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-02.webp", "alt": "Grupo remando em uma canoa havaiana durante o pôr do sol" },
        { "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-03.webp", "alt": "Lua cheia próxima ao horizonte sobre o Lago Paranoá" },
        { "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-04.webp", "alt": "Participantes remando com a lua cheia no horizonte" },
        { "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-05.webp", "alt": "Remada noturna sob a lua cheia e seu reflexo no lago" },
        { "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-07.webp", "alt": "Participantes em uma canoa havaiana nas águas do Lago Paranoá" }
      ]
    },
    "steps": {
      "eyebrow": "Como funciona",
      "title": "Como funciona",
      "description": "",
      "items": [
        { "title": "Recepção e preparação", "description": "O encontro acontece em frente ao Cápsula Bar, ao lado da Concha Acústica. A equipe recebe o grupo, entrega os equipamentos e apresenta as orientações de segurança e remada." },
        { "title": "Pôr do sol e nascimento da lua", "description": "Dependendo da data, iniciamos a experiência ainda com a luz do entardecer. Remamos pelo Lago Paranoá acompanhando o pôr do sol e a lua cheia surgindo no horizonte." },
        { "title": "Banho e contemplação", "description": "Durante o percurso, fazemos uma pausa no meio do lago para quem busca mais aventura e um momento de contemplação sob a lua." },
        { "title": "Retorno sob a lua", "description": "Voltamos ao Cápsula Bar já no escuro, com a lua cheia iluminando o lago, e encerramos a experiência na chegada." }
      ]
    },
    "included": {
      "eyebrow": "O que está incluído",
      "title": "O que está incluído",
      "description": "",
      "items": [
        { "icon": "Compass", "title": "Canoa havaiana", "description": "" },
        { "icon": "Sparkles", "title": "Remo", "description": "" },
        { "icon": "LifeBuoy", "title": "Colete salva-vidas", "description": "" },
        { "icon": "Compass", "title": "Instrutores em cada canoa", "description": "" },
        { "icon": "ShieldCheck", "title": "Instrução completa para iniciantes", "description": "" },
        { "icon": "Droplets", "title": "Pausa para banho", "description": "" },
        { "icon": "Sparkles", "title": "Momento de contemplação no lago", "description": "" },
        { "icon": "Sparkles", "title": "Fotos registradas pelos instrutores", "description": "" }
      ]
    },
    "whatToBring": {
      "eyebrow": "O que levar",
      "title": "O que levar",
      "items": [
        "Roupa confortável para atividade física",
        "Roupa de banho",
        "Chinelo",
        "Repelente",
        "Garrafa de água",
        "Agasalho para o retorno noturno"
      ]
    },
    "faq": {
      "eyebrow": "Dúvidas frequentes",
      "title": "Antes de entrar na água.",
      "locationLabel": "Cápsula Bar — Concha Acústica · SHTN Trecho 1, Lote 8",
      "items": [
        { "question": "Onde é o ponto de encontro?", "answer": "Em frente ao Cápsula Bar, ao lado da Concha Acústica: SHTN Trecho 1, Lote 8 — Brasília/DF. O link do Google Maps está nesta página e no e-mail de confirmação da reserva." },
        { "question": "A experiência termina no escuro?", "answer": "Sim. O retorno ao Cápsula Bar normalmente acontece já à noite, depois do nascimento da lua. Toda a atividade é acompanhada pelos instrutores." },
        { "question": "Pode fazer frio durante a remada?", "answer": "Sim. A temperatura pode diminuir depois do pôr do sol e durante o retorno. Recomendamos levar um agasalho." },
        { "question": "O que acontece se a lua estiver encoberta?", "answer": "Se a previsão indicar céu muito nublado e nenhuma possibilidade de avistar a lua, a experiência poderá ser cancelada. Nesse caso, o participante poderá escolher entre o reembolso integral ou deixar o valor como crédito para uma nova data." },
        { "question": "Existe estacionamento?", "answer": "As orientações de chegada e de estacionamento no Cápsula Bar são enviadas pela nossa equipe no grupo da experiência, criado até um dia antes." },
        { "question": "Crianças podem participar?", "answer": "Sim. Crianças são bem-vindas quando acompanhadas pelos pais ou responsáveis e habituadas a participar de experiências na natureza." }
      ]
    },
    "reservations": {
      "eyebrow": "Remada da Lua Cheia · Cápsula Bar",
      "title": "Ver próximas datas",
      "description": "Uma experiência noturna em canoa havaiana, saindo do Cápsula Bar, para acompanhar a lua cheia nascendo no horizonte e mergulhar no Lago Paranoá.",
      "image": {
        "src": "/images/experiences/remada-lua-cheia/remada-lua-cheia-reservas.webp",
        "alt": "Lua cheia refletida no Lago Paranoá ao lado de uma canoa havaiana"
      }
    },
    "seo": {
      "title": "Remada da Lua Cheia no Cápsula Bar — Concha Acústica | Alma Azul Academy",
      "description": "Reme sob a lua cheia no Lago Paranoá, saindo do Cápsula Bar, ao lado da Concha Acústica. Experiência de canoa havaiana com banho, contemplação e fotos."
    }
  }
  $editorial$::jsonb;

  update public.experiences
  set editorial_content = experience_editorial,
      summary = 'Uma remada sob a lua cheia, saindo do Cápsula Bar, com banho no lago e contemplação no horizonte.',
      description = 'Uma experiência noturna em canoa havaiana, saindo do Cápsula Bar, ao lado da Concha Acústica, para acompanhar a lua cheia nascendo no horizonte e mergulhar no Lago Paranoá.',
      updated_at = now()
  where slug = 'remada-lua-cheia-concha-acustica'
    and base_id = capsula_id
    and (editorial_content is null or editorial_content = '{}'::jsonb);
end;
$migration$;
