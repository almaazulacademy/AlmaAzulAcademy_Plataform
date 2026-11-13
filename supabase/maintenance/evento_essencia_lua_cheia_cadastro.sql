-- ESSÊNCIA — 2ª edição · Celebração da Lua Cheia — CADASTRO EM ESTADO FECHADO (GERADO; NÃO EDITAR À MÃO)
--
-- Gerado por `pnpm events:edition-sql essencia-lua-cheia` a partir de lib/events/editions.ts.
-- Rodar no SQL Editor SÓ COM AUTORIZAÇÃO, depois de supabase/diagnostics/evento_essencia_lua_cheia_cadastro_preflight.sql
-- (EVENTO_CADASTRO_PREFLIGHT_OK | OK). Depois, supabase/diagnostics/evento_essencia_lua_cheia_cadastro_postcheck.sql.
--
-- Cria, por `admin_create_event` (o caminho do painel, com as mesmas validações
-- e auditoria): a experiência essencia-lua-cheia como EVENT em RASCUNHO e a sessão de
-- 2026-11-24T18:00:00.000Z, 240 min, 15000 centavos, 24 vagas,
-- FECHADA para reservas, com o conteúdo em "Reservas abrem em breve". Não publica,
-- não mexe no interruptor, não abre a sessão, não toca reserva, lista de espera
-- nem as outras edições. Tudo numa transação: qualquer conferência que falhe
-- desfaz o cadastro inteiro.
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
    raise exception 'EVENTO_ATOR: esperado 1 administrador ativo, encontrado %', actors;
  end if;
  select au.user_id into actor
  from public.admin_users au join auth.users u on u.id = au.user_id
  where lower(u.email) = 'almaazulacademy@gmail.com' and au.is_active and au.role = 'ADMIN';

  select id into target_base from public.bases where slug = 'concha-acustica' and status = 'ACTIVE';
  if target_base is null then
    raise exception 'EVENTO_BASE: base concha-acustica ausente ou inativa';
  end if;
  if exists (select 1 from public.experiences where slug = 'essencia-lua-cheia') then
    raise exception 'EVENTO_JA_EXISTE: já existe experiência com o slug essencia-lua-cheia';
  end if;
  if (select count(*) from public.sessions s join public.experiences e on e.id = s.experience_id join public.bases b on b.id = e.base_id
          where e.kind = 'EVENT' and e.slug <> 'essencia-lua-cheia' and b.slug = 'concha-acustica'
            and s.starts_at = '2026-11-24T18:00:00.000Z'::timestamptz and s.status <> 'ARCHIVED') > 0 then
    raise exception 'EVENTO_SESSAO_DUPLICADA: já existe sessão de evento nesta base com o mesmo início';
  end if;
  -- Com o interruptor ligado (a 1ª edição no ar), quem esconde o rascunho são as
  -- políticas e as leituras da 202610310004. Sem ela, não cadastra.
  if not (exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'experiences' and policyname = 'events hidden until published')
     and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sessions' and policyname = 'event sessions hidden until published')
     and exists (select 1 from pg_trigger where tgrelid = 'public.reservations'::regclass and tgname = 'reservations_event_publication_guard')
     and exists (select 1 from pg_trigger where tgrelid = 'public.waitlist_entries'::regclass and tgname = 'waitlist_entries_event_publication_guard')
     and exists (select 1 from pg_proc where proname = 'event_publication_allows' and pronamespace = 'public'::regnamespace)) then
    raise exception 'EVENTO_SEGURANCA: aplique antes a migration 202610310004 (segurança dos eventos)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'experiences' and column_name = 'eyebrow')
     and not exists (select 1 from pg_trigger where tgrelid = 'public.experiences'::regclass and tgname = 'experiences_fill_legacy_columns') then
    raise exception 'EVENTO_LEGADO: aplique antes a migration 202610310002 (colunas legadas de experiences)';
  end if;

  created := public.admin_create_event(
    actor,
    target_base,
    'essencia-lua-cheia',
    'ESSÊNCIA — 2ª edição · Celebração da Lua Cheia',
    'Superioga, bem-estar com o Cure-se Bem, remada ao despertar da Lua Cheia e confraternização com música no Cápsula Bar.',
    $json${"version":1,"hero":{"eyebrow":"Evento especial · 2ª edição","title":"ESSÊNCIA","subtitle":"Um encontro para celebrar a vida e os novos ciclos.","image":{"src":"/images/eventos/essencia-lua-cheia/hero-lua-desktop.webp","alt":"Lua cheia nascendo no céu rosado do entardecer sobre o Lago Paranoá, com remadores de colete preparando a canoa havaiana","credit":"Remada da Lua Cheia · Alma Azul Academy"},"primaryCta":{"label":"Garantir minha vaga","href":"#reserva"},"secondaryCta":{"label":"Ver a programação","href":"#programacao"},"details":["24 de novembro de 2026","A partir das 15h","Cápsula Bar · Brasília"]},"quickFacts":[{"label":"Data","value":"24/11/2026"},{"label":"Horário","value":"A partir das 15h"},{"label":"Local","value":"Cápsula Bar"},{"label":"Ingresso","value":"R$ 150 por pessoa"}],"about":{"eyebrow":"Especial de confraternização de fim de ano","title":"Um encontro para celebrar a vida e os novos ciclos.","paragraphs":["Que tal celebrar a vida, brindar às conquistas e encerrar o ano com boas energias?"],"image":{"src":"/images/eventos/essencia-lua-cheia/apresentacao-capsula-entardecer.webp","alt":"Varal de luzes acesas no gramado do Cápsula Bar, com palmeiras e o pôr do sol sobre o Lago Paranoá"}},"reservations":{"eyebrow":"Ingresso único","title":"Garanta a sua vaga","description":"Superioga, momento de bem-estar, remada ao despertar da Lua Cheia e confraternização com um drink de cortesia, em um único ingresso.","image":{"src":"/images/experiences/remada-lua-cheia/remada-lua-cheia-hero.webp","alt":"Lua cheia nascendo sobre o Lago Paranoá, vista de dentro de uma canoa havaiana à noite"}},"seo":{"title":"ESSÊNCIA — 2ª edição · Celebração da Lua Cheia","description":"Superioga, bem-estar com o Cure-se Bem, remada ao despertar da Lua Cheia e confraternização com música no Cápsula Bar, em Brasília. 24 de novembro de 2026, a partir das 15h."},"event":{"theme":"dusk","badge":"Evento especial · 2ª edição","subtitle":"Celebração da Lua Cheia","tagline":"Um encontro para celebrar a vida e os novos ciclos.","highlights":["Superioga","Bem-estar","Remada ao despertar da Lua Cheia","Música e brinde"],"scheduleLabel":"A partir das 15h","heroImageMobile":{"src":"/images/eventos/essencia-lua-cheia/hero-lua-mobile.webp","alt":"Lua cheia nascendo no céu rosado do entardecer sobre o Lago Paranoá, com remadores de colete preparando a canoa havaiana","credit":"Remada da Lua Cheia · Alma Azul Academy"},"cardImage":{"src":"/images/eventos/essencia-lua-cheia/hero-lua-desktop.webp","alt":"Lua cheia nascendo no céu rosado do entardecer sobre o Lago Paranoá, com remadores de colete preparando a canoa havaiana"},"intro":{"eyebrow":"Especial de confraternização de fim de ano","title":"Um encontro para celebrar a vida e os novos ciclos.","paragraphs":["Que tal celebrar a vida, brindar às conquistas e encerrar o ano com boas energias?","A segunda edição do ESSÊNCIA chega em uma celebração especial da Lua Cheia, reunindo natureza, movimento, relaxamento, música e alegria.","Uma oportunidade de desacelerar, cuidar de si, reencontrar pessoas queridas e celebrar tudo o que vivemos ao longo deste ano.","Do movimento do corpo à tranquilidade das terapias, da remada contemplativa ao encontro entre amigos: cada momento foi pensado para criar memórias especiais.","Venha viver essa celebração conosco."],"image":{"src":"/images/eventos/essencia-lua-cheia/apresentacao-capsula-entardecer.webp","alt":"Varal de luzes acesas no gramado do Cápsula Bar, com palmeiras e o pôr do sol sobre o Lago Paranoá"}},"program":{"eyebrow":"Programação","title":"Do pôr do sol ao despertar da Lua Cheia.","imageShape":"portrait","items":[{"time":"15:00","title":"Recepção e boas-vindas","description":"Um momento de acolhimento para iniciar nossa experiência em um ambiente de conexão e boas energias.","hosts":[],"image":{"src":"/images/eventos/essencia-lua-cheia/recepcao-deck-lago.webp","alt":"Deck do Cápsula Bar de frente para o Lago Paranoá em uma tarde de céu claro"}},{"time":"15:15","title":"Superioga","description":"Movimento, energia e conexão com o corpo em uma prática especial para começar nossa jornada de bem-estar.","hosts":["Rapha Dantas"],"note":"Traga seu próprio tapete.","image":{"src":"/images/eventos/essencia-lua-cheia/superioga-1a-edicao.webp","alt":"Participantes em prática de Superioga sobre tapetes no deck do Cápsula Bar, sob o sol da manhã","credit":"Registro da 1ª edição do ESSÊNCIA · 07/11/2026"}},{"time":"16:30","title":"Momento de Bem-Estar","description":"Uma experiência de relaxamento e autocuidado com massagem relaxante ou reflexologia podal, associada aos benefícios dos óleos essenciais. Os atendimentos serão organizados pela equipe do Cure-se Bem, conforme a disponibilidade, sem escolha antecipada de modalidade.","hosts":["Cure-se Bem"],"image":{"src":"/images/eventos/essencia-lua-cheia/bem-estar-1a-edicao.webp","alt":"Participante sentada sobre o tapete aplicando óleo essencial nas mãos, durante a aromaterapia","credit":"Registro da 1ª edição do ESSÊNCIA · 07/11/2026"}},{"time":"17:30","title":"Remada Alma Azul · O Despertar da Lua Cheia","description":"Uma remada contemplativa pelas águas do Lago Paranoá, acompanhando as cores do pôr do sol e o despertar da Lua Cheia. Um momento de conexão com a natureza, tranquilidade e celebração dos novos ciclos.","hosts":["Alma Azul Academy"],"note":"Canoa havaiana com colete salva-vidas obrigatório.","image":{"src":"/images/eventos/essencia-lua-cheia/remada-entardecer.webp","alt":"Canoa havaiana com remadores em silhueta sobre o Lago Paranoá, sob nuvens escuras e o céu alaranjado do pôr do sol","credit":"Remada Sunset · Alma Azul Academy"}},{"time":"19:00","title":"Música no Cápsula Bar","description":"Para encerrar a experiência, um momento de confraternização com música ambiente, boas conversas e um brinde especial à vida, às conquistas e aos novos ciclos.","hosts":[],"note":"Sem cobrança de entrada ou couvert para os participantes.","image":{"src":"/images/eventos/essencia-lua-cheia/musica-capsula-noite.webp","alt":"Pátio do Cápsula Bar à noite, com árvores iluminadas, mesas e pessoas conversando"}}]},"spotlight":{"eyebrow":"Um drink para brindar","title":"Um brinde aos novos ciclos.","paragraphs":["Cada participante recebe 1 drink de cortesia, oferecido pelo Cápsula Bar, para celebrar a vida, as amizades, as conquistas e os novos ciclos.","O drink está incluído no ingresso."],"note":"Com ou sem álcool, à sua escolha.","image":{"src":"/images/eventos/essencia-lua-cheia/drink-capsula-neon.webp","alt":"Letreiro luminoso do Cápsula Bar em uma parede de madeira, à noite"}},"included":{"eyebrow":"Ingresso único","title":"Tudo o que está incluso.","description":"Um único ingresso para viver a tarde completa, do pôr do sol ao despertar da Lua Cheia.","items":["Recepção e boas-vindas","Superioga com Rapha Dantas","Momento de Bem-Estar com o Cure-se Bem","Remada contemplativa em canoa havaiana","Confraternização com música ambiente","1 drink de cortesia, com ou sem álcool"]},"partners":{"eyebrow":"Quem faz acontecer","title":"Uma celebração feita a muitas mãos.","items":[{"name":"Alma Azul Academy","role":"Realização · Remada em canoa havaiana","logo":{"src":"/images/branding/alma-azul-logo-dark.png","alt":"Logo Alma Azul Academy"}},{"name":"Cure-se Bem","role":"Realização · Momento de Bem-Estar","logo":{"src":"/images/eventos/essencia/logo-cure-se-bem.png","alt":"Logo Cure-se Bem"}},{"name":"Cápsula Bar","role":"Realização · Local, música e drink de cortesia","logo":{"src":"/images/bases/concha-acustica/capsula-bar-logo.webp","alt":"Logo Cápsula Bar"}},{"name":"Rapha Dantas","role":"Superioga","logo":{"src":"/images/eventos/essencia/logo-superioga-rapha-dantas.jpg","alt":"Logo Superioga — Rapha Dantas"}}]},"info":{"eyebrow":"Antes de ir","title":"Informações importantes","items":[{"id":"chegada","title":"Horário e chegada","body":"Recomendamos chegar às 14h50, dez minutos antes do início das atividades.\n\nA recepção começa às 15h00, e a tolerância máxima de chegada será até 15h15."},{"id":"o-que-levar","title":"O que levar","body":"Tapete próprio para a prática de Superioga, roupas leves e confortáveis, garrafa de água e uma muda de roupa para depois da remada."},{"id":"seguranca","title":"Segurança na remada","body":"A remada será realizada em canoas havaianas, com acompanhamento da equipe Alma Azul Academy e uso obrigatório de colete salva-vidas.\n\nA realização da atividade na água depende de condições seguras de navegação."},{"id":"drink","title":"Um drink para brindar","body":"Cada participante recebe 1 drink de cortesia, com ou sem álcool, oferecido pelo Cápsula Bar. O benefício está incluído no ingresso.\n\nA confraternização com música ambiente, a partir das 19h, não tem cobrança adicional de entrada ou couvert para os participantes.","email":true},{"id":"clima","title":"Condições climáticas","body":"Se as condições climáticas impedirem a realização segura das atividades, o evento inteiro será reagendado, e a nova data será comunicada aos participantes.\n\nO evento não é realizado em versão parcial nessas condições."},{"id":"cancelamento","title":"Política de cancelamento","body":"Você pode solicitar o cancelamento até 22 de novembro de 2026, às 12h00 (horário de Brasília), escolhendo entre crédito para outra experiência da Alma Azul ou reembolso, conforme a política aplicável e os direitos do consumidor.\n\nAs solicitações são atendidas pela nossa equipe, pelos canais oficiais de atendimento."}]},"arrival":{"startTime":"15:00","toleranceUntil":"15:15"},"cancellation":{"deadline":"2026-11-22T12:00:00-03:00","timeZone":"America/Sao_Paulo","summary":"crédito para outra experiência da Alma Azul ou reembolso, pelo atendimento da nossa equipe"},"reservation":{"eyebrow":"Celebre os novos ciclos com a gente","title":"Garanta a sua vaga","ctaLabel":"Garantir minha vaga","maxPerOrder":6,"notice":"Traga seu próprio tapete para a prática de Superioga.","comingSoon":true,"image":{"src":"/images/experiences/remada-lua-cheia/remada-lua-cheia-hero.webp","alt":"Lua cheia nascendo sobre o Lago Paranoá, vista de dentro de uma canoa havaiana à noite"}}}}$json$::jsonb,
    '/images/eventos/essencia-lua-cheia/hero-lua-desktop.webp',
    '2026-11-24T18:00:00.000Z'::timestamptz,
    240,
    15000,
    24
  );

  -- Conferências dentro da transação: falhou, nada fica.
  if (select status from public.experiences where id = (created ->> 'experienceId')::uuid) <> 'DRAFT'
     or (select kind from public.experiences where id = (created ->> 'experienceId')::uuid) <> 'EVENT'
     or (select status from public.sessions where id = (created ->> 'sessionId')::uuid) <> 'CLOSED' then
    raise exception 'EVENTO_ESTADO: a edição precisa nascer em rascunho e com a sessão fechada';
  end if;
  if not public.experience_editorial_is_publishable((select editorial_content from public.experiences where id = (created ->> 'experienceId')::uuid)) then
    raise exception 'EVENTO_CONTEUDO: conteúdo editorial não passa na régua de publicação';
  end if;
  if (select editorial_content #>> '{event,reservation,comingSoon}' from public.experiences where id = (created ->> 'experienceId')::uuid) is distinct from 'true' then
    raise exception 'EVENTO_EM_BREVE: o conteúdo precisa nascer com event.reservation.comingSoon = true';
  end if;
  if (select to_jsonb(e) ->> 'active' from public.experiences e where e.id = (created ->> 'experienceId')::uuid) = 'true' then
    raise exception 'EVENTO_ATIVO: o rascunho não pode nascer com active = true (aplique a migration 202610310003)';
  end if;
  if exists (select 1 from public.list_public_events() where slug = 'essencia-lua-cheia')
     or exists (select 1 from public.get_public_event('essencia-lua-cheia'))
     or exists (select 1 from public.list_public_event_sessions('essencia-lua-cheia')) then
    raise exception 'EVENTO_PUBLICO: o rascunho apareceu numa leitura pública';
  end if;

  raise notice 'EVENTO_CRIADO experienceId=% sessionId=%', created ->> 'experienceId', created ->> 'sessionId';
end;
$cadastro$;

commit;
