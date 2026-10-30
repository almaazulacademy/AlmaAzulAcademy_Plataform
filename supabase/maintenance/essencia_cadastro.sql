-- ESSÊNCIA — CADASTRO EM ESTADO FECHADO (GERADO; NÃO EDITAR À MÃO)
--
-- Gerado por `pnpm events:essencia-sql` a partir de lib/events/fixtures/essencia.ts.
-- Rodar no SQL Editor SÓ COM AUTORIZAÇÃO, depois de essencia_cadastro_preflight.sql
-- (ESSENCIA_CADASTRO_PREFLIGHT_OK | OK). Depois, essencia_cadastro_postcheck.sql.
--
-- Cria, por `admin_create_event` (o caminho do painel, com as mesmas validações
-- e auditoria): a experiência essencia como EVENT em RASCUNHO e a sessão de
-- 2026-11-07T08:30:00.000Z (05h30 em Brasília), 210 min, R$ 150,00, 24 vagas,
-- FECHADA para reservas. Não publica, não liga o interruptor, não abre a sessão,
-- não toca reserva nem lista de espera. Tudo numa transação: qualquer conferência
-- que falhe desfaz o cadastro inteiro.
--
-- Ator: o administrador ativo (role ADMIN) do e-mail almaazulacademy@gmail.com, lido de
-- admin_users + auth.users — exatamente um, ou para. Base: concha-acustica, lida por slug.

begin;
set local lock_timeout = '5s';

do $cadastro$
declare
  actor uuid;
  actors integer;
  target_base uuid;
  created jsonb;
begin
  select count(*) into actors
  from public.admin_users au join auth.users u on u.id = au.user_id
  where lower(u.email) = 'almaazulacademy@gmail.com' and au.is_active and au.role = 'ADMIN';
  if actors <> 1 then
    raise exception 'ESSENCIA_ATOR: esperado 1 administrador ativo, encontrado %', actors;
  end if;
  select au.user_id into actor
  from public.admin_users au join auth.users u on u.id = au.user_id
  where lower(u.email) = 'almaazulacademy@gmail.com' and au.is_active and au.role = 'ADMIN';

  select id into target_base from public.bases where slug = 'concha-acustica' and status = 'ACTIVE';
  if target_base is null then
    raise exception 'ESSENCIA_BASE: base concha-acustica ausente ou inativa';
  end if;
  if exists (select 1 from public.experiences where slug = 'essencia') then
    raise exception 'ESSENCIA_JA_EXISTE: já existe experiência com o slug essencia';
  end if;
  if coalesce((select publication_enabled from public.special_event_settings where singleton), true) then
    raise exception 'ESSENCIA_INTERRUPTOR: o interruptor de publicação precisa estar desligado';
  end if;
  -- Banco com as colunas do schema legado (produção) precisa do gatilho que as
  -- preenche (202610310002); sem ele, admin_create_experience falha em "eyebrow".
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'experiences' and column_name = 'eyebrow')
     and not exists (select 1 from pg_trigger where tgrelid = 'public.experiences'::regclass and tgname = 'experiences_fill_legacy_columns') then
    raise exception 'ESSENCIA_LEGADO: aplique antes a migration 202610310002 (colunas legadas de experiences)';
  end if;

  created := public.admin_create_event(
    actor,
    target_base,
    'essencia',
    'ESSÊNCIA — Corpo, Mente e Natureza',
    'Canoa havaiana ao nascer do sol, meditação sensorial e Superioga no Cápsula Bar.',
    $json${"version":1,"hero":{"eyebrow":"Evento especial · 1ª edição","title":"ESSÊNCIA","subtitle":"Uma manhã para desacelerar, se reconectar e viver o que realmente importa.","image":{"src":"/images/bases/concha-acustica/concha-hero-nascer-do-sol-desktop.webp","alt":"Canoa havaiana com remadores em silhueta no Lago Paranoá ao nascer do sol"},"primaryCta":{"label":"Garantir minha vaga","href":"#reserva"},"secondaryCta":{"label":"Ver a programação","href":"#programacao"},"details":["07 de novembro de 2026","05h30 às 09h","Cápsula Bar · Brasília"]},"quickFacts":[{"label":"Data","value":"07/11/2026"},{"label":"Horário","value":"05h30 às 09h"},{"label":"Local","value":"Cápsula Bar"},{"label":"Ingresso","value":"R$ 150 por pessoa"}],"about":{"eyebrow":"Uma manhã para sentir","title":"Natureza, movimento, respiração e encontros.","paragraphs":["Entre o nascer do sol, o movimento das águas e a conexão com o presente, nasce um convite para cuidar de si."],"image":{"src":"/images/bases/concha-acustica/capsula-lago-por-do-sol-desktop.webp","alt":"Lago Paranoá visto do Cápsula Bar com o céu colorido"}},"reservations":{"eyebrow":"Ingresso único","title":"Garanta a sua vaga","description":"Canoa havaiana, meditação, Superioga e lanche saudável em um único ingresso.","image":{"src":"/images/eventos/essencia/capsula-pier-amanhecer.jpg","alt":"Píer do Cápsula Bar avançando sobre o Lago Paranoá ao amanhecer"}},"seo":{"title":"ESSÊNCIA — Corpo, Mente e Natureza","description":"Uma manhã de canoa havaiana ao nascer do sol, meditação sensorial e Superioga no Cápsula Bar, em Brasília. 07 de novembro de 2026."},"event":{"badge":"Evento especial · 1ª edição","subtitle":"Corpo, mente e natureza","tagline":"Uma manhã para desacelerar, se reconectar e viver o que realmente importa.","highlights":["Canoa havaiana","Meditação","Superioga"],"heroImageMobile":{"src":"/images/bases/concha-acustica/concha-hero-nascer-do-sol-mobile.webp","alt":"Canoa havaiana com remadores em silhueta no Lago Paranoá ao nascer do sol"},"cardImage":{"src":"/images/bases/concha-acustica/concha-hero-nascer-do-sol-desktop.webp","alt":"Canoa havaiana no Lago Paranoá ao nascer do sol"},"intro":{"eyebrow":"Uma manhã para sentir","title":"Um convite para cuidar de si.","paragraphs":["Entre o nascer do sol, o movimento das águas e a conexão com o presente, nasce um convite para cuidar de si.","Uma experiência que reúne natureza, movimento, respiração e encontros especiais em uma manhã pensada para renovar as energias."],"image":{"src":"/images/bases/concha-acustica/capsula-lago-por-do-sol-desktop.webp","alt":"Lago Paranoá visto do Cápsula Bar com o céu colorido"}},"program":{"eyebrow":"Programação","title":"Do nascer do sol ao encontro.","items":[{"time":"05:30","title":"Canoa havaiana ao nascer do sol","description":"O sol nasce, o lago desperta e cada remada convida você a estar presente.","hosts":["Alma Azul Academy"],"note":"Não é necessário ter experiência prévia.","image":{"src":"/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-galeria-02.webp","alt":"Canoa havaiana deslizando no Lago Paranoá com o céu alaranjado do amanhecer"}},{"time":"07:30","title":"Meditação sensorial","description":"Um convite para respirar, sentir e se conectar com o presente, através da aromaterapia.","hosts":["Rapha Dantas","Fernanda Garcia"],"image":{"src":"/images/eventos/essencia/capsula-deck-lago.jpg","alt":"Deck do Cápsula Bar de frente para o Lago Paranoá, com árvores e o píer ao fundo"}},{"time":"07:45","title":"Superioga","description":"Movimento, força e respiração em uma prática que integra corpo e mente.","hosts":["Rapha Dantas"]},{"time":"09:00","title":"Encerramento e conexão","description":"O bem-estar também está nos encontros. Momento de integração e lanche saudável oferecido pela Nutre.","hosts":[],"image":{"src":"/images/eventos/essencia/capsula-mesas-encontro.jpg","alt":"Mesas e cadeiras no espaço aberto do Cápsula Bar"}}]},"included":{"eyebrow":"Ingresso único","title":"Tudo o que está incluso.","description":"Um único ingresso para viver a manhã completa — não é só uma remada nem só uma aula.","items":["Canoa havaiana ao nascer do sol","Meditação sensorial com aromaterapia","Superioga","Momento de integração","Lanche saudável da Nutre"]},"partners":{"eyebrow":"Quem faz acontecer","title":"Uma manhã feita a muitas mãos.","items":[{"name":"Cure-se Bem","role":"Meditação sensorial com aromaterapia","logo":{"src":"/images/eventos/essencia/logo-cure-se-bem.png","alt":"Logo Cure-se Bem"}},{"name":"Alma Azul Academy","role":"Canoa havaiana ao nascer do sol","logo":{"src":"/images/branding/alma-azul-logo-dark.png","alt":"Logo Alma Azul Academy"}},{"name":"Cápsula Bar","role":"Local do evento","logo":{"src":"/images/bases/concha-acustica/capsula-bar-logo.webp","alt":"Logo Cápsula Bar"}},{"name":"Rapha Dantas","role":"Superioga e meditação sensorial"},{"name":"Nutre Congelados Saudáveis","role":"Parceira de alimentação · lanche saudável","logo":{"src":"/images/eventos/essencia/logo-nutre.png","alt":"Logo Nutre"}}]},"info":{"eyebrow":"Antes de ir","title":"Informações importantes","items":[{"id":"chegada","title":"Horário e chegada","body":"Nossa experiência começa às 05h30, no Cápsula Bar, às margens do Lago Paranoá.\n\nRecomendamos chegar com alguns minutos de antecedência para aproveitar cada momento. Haverá tolerância de chegada até às 05h50."},{"id":"o-que-levar","title":"O que levar","body":"Venha com roupas confortáveis, adequadas para atividades físicas. Recomendamos trazer garrafa de água, protetor solar e seus itens pessoais.\n\nPara participar da prática de Superioga, traga seu próprio tapete. A organização não disponibilizará tapetes para essa atividade."},{"id":"experiencia","title":"Preciso ter experiência anterior?","body":"Não! A experiência foi pensada para acolher também quem está começando. Nossa equipe conduzirá as atividades e fornecerá as orientações necessárias."},{"id":"seguranca","title":"Segurança durante a remada","body":"O uso de colete salva-vidas é obrigatório durante a atividade na água. Antes da saída, nossa equipe apresentará as orientações de segurança."},{"id":"alimentacao","title":"Alimentação inclusa","body":"Ao final da programação, teremos um momento especial de integração com lanche saudável oferecido pela Nutre Congelados Saudáveis."},{"id":"clima","title":"Condições climáticas","body":"A segurança e o bem-estar de todos vêm em primeiro lugar. Caso as condições climáticas impeçam a realização segura da experiência, o evento será reagendado e os participantes serão comunicados pela organização."},{"id":"cancelamento","title":"Política de cancelamento","body":"Você pode solicitar o cancelamento até 5 de novembro de 2026, às 12h00 (horário de Brasília), escolhendo entre crédito para utilizar em outras experiências da Alma Azul ou solicitação de reembolso com nossa equipe.\n\nApós esse prazo, entre em contato conosco para avaliação do seu caso."}]},"arrival":{"startTime":"05:30","toleranceUntil":"05:50"},"cancellation":{"deadline":"2026-11-05T12:00:00-03:00","timeZone":"America/Sao_Paulo","summary":"crédito para utilizar em outras experiências da Alma Azul ou solicitação de reembolso com nossa equipe"},"reservation":{"eyebrow":"Sua próxima pausa tem data marcada","title":"Garanta a sua vaga","ctaLabel":"Garantir minha vaga","maxPerOrder":6,"notice":"Traga seu próprio tapete para a prática de Superioga. A organização não disponibilizará tapetes.","image":{"src":"/images/eventos/essencia/capsula-pier-amanhecer.jpg","alt":"Píer do Cápsula Bar avançando sobre o Lago Paranoá ao amanhecer"}}}}$json$::jsonb,
    '/images/bases/concha-acustica/concha-hero-nascer-do-sol-desktop.webp',
    '2026-11-07T08:30:00.000Z'::timestamptz,
    210,
    15000,
    24
  );

  -- Conferências dentro da transação: falhou, nada fica.
  if (select status from public.experiences where id = (created ->> 'experienceId')::uuid) <> 'DRAFT'
     or (select kind from public.experiences where id = (created ->> 'experienceId')::uuid) <> 'EVENT'
     or (select status from public.sessions where id = (created ->> 'sessionId')::uuid) <> 'CLOSED' then
    raise exception 'ESSENCIA_ESTADO: o evento precisa nascer em rascunho e com a sessão fechada';
  end if;
  if not public.experience_editorial_is_publishable((select editorial_content from public.experiences where id = (created ->> 'experienceId')::uuid)) then
    raise exception 'ESSENCIA_CONTEUDO: conteúdo editorial não passa na régua de publicação';
  end if;
  -- Coluna legada `active`: com ela ligada, o rascunho ficaria legível pela chave
  -- pública (política de leitura de produção). Aplique a migration 202610310003.
  if (select to_jsonb(e) ->> 'active' from public.experiences e where e.id = (created ->> 'experienceId')::uuid) = 'true' then
    raise exception 'ESSENCIA_ATIVO: o rascunho não pode nascer com active = true (aplique a migration 202610310003)';
  end if;

  raise notice 'ESSENCIA_CRIADO experienceId=% sessionId=%', created ->> 'experienceId', created ->> 'sessionId';
end;
$cadastro$;

commit;
