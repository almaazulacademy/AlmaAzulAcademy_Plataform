-- ESSÊNCIA — Corpo, Mente e Natureza — CADASTRO EM ESTADO FECHADO (GERADO; NÃO EDITAR À MÃO)
--
-- Gerado por `pnpm events:edition-sql essencia-lua-cheia` a partir de lib/events/editions.ts.
-- Rodar no SQL Editor SÓ COM AUTORIZAÇÃO, depois de supabase/diagnostics/evento_essencia_lua_cheia_cadastro_preflight.sql
-- (EVENTO_CADASTRO_PREFLIGHT_OK | OK). Depois, supabase/diagnostics/evento_essencia_lua_cheia_cadastro_postcheck.sql.
--
-- Cria, por `admin_create_event` (o caminho do painel, com as mesmas validações
-- e auditoria): a experiência essencia-lua-cheia como EVENT em RASCUNHO e a sessão de
-- 2026-11-23T19:30:00.000Z, 210 min, 16000 centavos, 24 vagas,
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
            and s.starts_at = '2026-11-23T19:30:00.000Z'::timestamptz and s.status <> 'ARCHIVED') > 0 then
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
    'ESSÊNCIA — Corpo, Mente e Natureza',
    'Especial de Confraternização de Fim de Ano: remada no Lago Paranoá, Superioga, lanche saudável, massagem ou reflexologia e educação ambiental sobre o Cerrado, no Cápsula Bar.',
    $json${"version":1,"hero":{"eyebrow":"Especial de Confraternização de Fim de Ano!","title":"ESSÊNCIA — Corpo, Mente e Natureza","subtitle":"Que tal celebrar a vida, compartilhar boas energias e receber os novos ciclos?","image":{"src":"/images/eventos/essencia-lua-cheia/hero-lua-desktop.webp","alt":"Lua cheia nascendo no céu rosado do entardecer sobre o Lago Paranoá, com remadores de colete preparando a canoa havaiana","credit":"Remada da Lua Cheia · Alma Azul Academy"},"primaryCta":{"label":"Garantir minha vaga","href":"#reserva"},"secondaryCta":{"label":"Ver a programação","href":"#programacao"},"details":["23 de novembro de 2026","16h30 às 20h","Cápsula Bar · Brasília"]},"quickFacts":[{"label":"Data","value":"23/11/2026"},{"label":"Horário","value":"16h30 às 20h"},{"label":"Local","value":"Cápsula Bar"},{"label":"Ingresso","value":"R$ 160 por pessoa"}],"about":{"eyebrow":"Corpo, mente e natureza","title":"Natureza, movimento, autocuidado e celebração!","paragraphs":["Um encontro especial de bem-estar, natureza, movimento, autocuidado, educação ambiental e conexão!"],"image":{"src":"/images/eventos/essencia-lua-cheia/apresentacao-capsula-entardecer.webp","alt":"Varal de luzes acesas no gramado do Cápsula Bar, com palmeiras e o pôr do sol sobre o Lago Paranoá"}},"reservations":{"eyebrow":"Ingresso único","title":"Garanta a sua vaga","description":"Remada, Superioga, lanche saudável, massagem ou reflexologia e educação ambiental em um único ingresso.","image":{"src":"/images/eventos/essencia-lua-cheia/reserva-capsula-noite.webp","alt":"Cápsula Bar iluminado à noite, visto do Lago Paranoá, com as luzes refletidas na água e canoas no píer"}},"seo":{"title":"ESSÊNCIA — Corpo, Mente e Natureza","description":"Especial de Confraternização de Fim de Ano no Cápsula Bar, em Brasília: remada no Lago Paranoá, Superioga, lanche saudável, massagem ou reflexologia e educação ambiental sobre o Cerrado. 23 de novembro de 2026, das 16h30 às 20h."},"event":{"theme":"dusk","badge":"Especial de Confraternização de Fim de Ano!","subtitle":"Celebração da Lua Cheia","tagline":"Que tal celebrar a vida, compartilhar boas energias e receber os novos ciclos?","highlights":["Remada no Lago Paranoá","Superioga","Lanche saudável","Bem-estar e Cerrado"],"heroImageMobile":{"src":"/images/eventos/essencia-lua-cheia/hero-lua-mobile.webp","alt":"Lua cheia nascendo no céu rosado do entardecer sobre o Lago Paranoá, com remadores de colete preparando a canoa havaiana","credit":"Remada da Lua Cheia · Alma Azul Academy"},"cardImage":{"src":"/images/eventos/essencia-lua-cheia/hero-lua-desktop.webp","alt":"Lua cheia nascendo no céu rosado do entardecer sobre o Lago Paranoá, com remadores de colete preparando a canoa havaiana"},"intro":{"eyebrow":"Corpo, mente e natureza","title":"Natureza, movimento, autocuidado e celebração!","paragraphs":["Um encontro especial de bem-estar, natureza, movimento, autocuidado, educação ambiental e conexão!","Nesta edição especial do ESSÊNCIA, vamos celebrar nossas amizades, conquistas e experiências vividas ao longo do ano, compartilhando bons momentos e agradecendo por tudo que vivemos.","Uma jornada pelas águas do Lago Paranoá, pelo movimento do corpo e pelos momentos de cuidado e conexão com a natureza."],"image":{"src":"/images/eventos/essencia-lua-cheia/apresentacao-capsula-entardecer.webp","alt":"Varal de luzes acesas no gramado do Cápsula Bar, com palmeiras e o pôr do sol sobre o Lago Paranoá"}},"program":{"eyebrow":"Programação","title":"Do fim da tarde ao despertar da Lua.","imageShape":"portrait","items":[{"time":"16:30","title":"Recepção e boas-vindas","description":"Um momento de acolhimento para iniciar nossa experiência em um ambiente de conexão e boas energias.","hosts":[],"image":{"src":"/images/eventos/essencia-lua-cheia/recepcao-deck-lago.webp","alt":"Deck do Cápsula Bar de frente para o Lago Paranoá em uma tarde de céu claro"}},{"time":"17:00","title":"Remada Alma Azul","description":"Um convite para contemplar o despertar da Lua, movimentar o corpo e viver a magia do contato com a natureza. A remada é realizada em canoas havaianas, com acompanhamento da equipe Alma Azul Academy e uso obrigatório de colete salva-vidas.","hosts":["Alma Azul Academy"],"note":"Colete salva-vidas obrigatório, inclusive para crianças.","image":{"src":"/images/eventos/essencia-lua-cheia/remada-entardecer.webp","alt":"Canoa havaiana com remadores em silhueta sobre o Lago Paranoá, sob nuvens escuras e o céu alaranjado do pôr do sol","credit":"Remada Sunset · Alma Azul Academy"}},{"time":"17:45","title":"Superioga","description":"Movimento, energia e conexão com o corpo em uma prática especial de bem-estar.","hosts":["Rapha Dantas"],"note":"Traga seu próprio tapete.","image":{"src":"/images/eventos/essencia-lua-cheia/superioga-1a-edicao.webp","alt":"Participantes em prática de Superioga sobre tapetes no deck do Cápsula Bar","credit":"Registro da 1ª edição do ESSÊNCIA · 07/11/2026"}},{"time":"18:45","title":"Lanche saudável","description":"Momento de alimentação saudável e convivência, com o lanche da NutreDF.","hosts":["NutreDF"],"note":"Incluído no ingresso, sem cobrança adicional.","image":{"src":"/images/eventos/essencia-lua-cheia/lanche-capsula-hora-azul.webp","alt":"Cápsula Bar iluminado ao anoitecer, com pessoas reunidas nas mesas sob o céu azul profundo"}},{"time":"19:00","timeLabel":"19h às 20h","title":"Momento de Bem-Estar e Conexão com a Natureza","description":"Duas experiências acontecem ao mesmo tempo: massagem ou reflexologia com o Cure-se Bem e Educação Ambiental com Fernanda Garcia. Aproveite a Educação Ambiental enquanto aguarda o seu atendimento.","hosts":["Cure-se Bem","Fernanda Garcia"],"parallel":[{"title":"Massagem e Reflexologia","description":"Escolha no local entre massagem relaxante ou reflexologia podal, conforme a disponibilidade dos terapeutas, com a utilização de óleos essenciais.","hosts":["Cure-se Bem"],"image":{"src":"/images/eventos/essencia-lua-cheia/bem-estar-1a-edicao.webp","alt":"Participante sentada sobre o tapete aplicando óleo essencial nas mãos, durante a aromaterapia","credit":"Registro da 1ª edição do ESSÊNCIA · 07/11/2026"}},{"title":"Educação Ambiental: Fauna e Flora do Cerrado","description":"Uma vivência educativa para crianças e adultos, com experiências de conexão com a natureza e descobertas sobre a riqueza da biodiversidade do Cerrado, seus animais, suas plantas e a importância da preservação ambiental.","hosts":["Fernanda Garcia"],"image":{"src":"/images/eventos/essencia-lua-cheia/educacao-ambiental-cerrado.webp","alt":"Mata de galeria do Cerrado acompanhando um córrego, vista do alto, com a paisagem do Distrito Federal ao fundo","credit":"Córrego do Torto · Cerrado do Distrito Federal"}}]}]},"included":{"eyebrow":"Ingresso único","title":"Tudo o que está incluso.","description":"Um único ingresso para viver a experiência completa, do fim da tarde ao despertar da Lua.","items":["Recepção e boas-vindas","Remada em canoa havaiana, com colete salva-vidas","Superioga com Rapha Dantas","Lanche saudável da NutreDF","Massagem relaxante ou reflexologia podal com o Cure-se Bem, conforme a disponibilidade dos terapeutas","Educação Ambiental: fauna e flora do Cerrado, com Fernanda Garcia"]},"partners":{"eyebrow":"Quem faz acontecer","title":"Uma celebração feita a muitas mãos.","items":[{"name":"Alma Azul Academy","role":"Realização · Remada em canoa havaiana","logo":{"src":"/images/branding/alma-azul-logo-dark.png","alt":"Logo Alma Azul Academy"}},{"name":"Cure-se Bem","role":"Realização · Massagem e reflexologia","logo":{"src":"/images/eventos/essencia/logo-cure-se-bem.png","alt":"Logo Cure-se Bem"}},{"name":"Cápsula Bar","role":"Realização · Local do evento","logo":{"src":"/images/bases/concha-acustica/capsula-bar-logo.webp","alt":"Logo Cápsula Bar"}},{"name":"Rapha Dantas","role":"Superioga","logo":{"src":"/images/eventos/essencia/logo-superioga-rapha-dantas.jpg","alt":"Logo Superioga — Rapha Dantas"}},{"name":"NutreDF","role":"Lanche saudável","logo":{"src":"/images/eventos/essencia/logo-nutre.png","alt":"Logo Nutre"}},{"name":"Fernanda Garcia","role":"Educação Ambiental · fauna e flora do Cerrado"}]},"info":{"eyebrow":"Antes de ir","title":"Informações importantes","items":[{"id":"chegada","title":"Horário e chegada","body":"A chegada e a recepção começam às 16h30, no Cápsula Bar, às margens do Lago Paranoá.\n\nA tolerância máxima de chegada é até 16h50: às 17h00 começa a remada.\n\nA programação vai até as 20h00."},{"id":"o-que-levar","title":"O que levar","body":"Roupas confortáveis que possam molhar, muda de roupa, toalha, tapete próprio para a Superioga, garrafa de água, repelente e um agasalho leve para a noite."},{"id":"criancas","title":"Participação de crianças","body":"Crianças são bem-vindas e participam somente acompanhadas por um responsável.\n\nCada criança paga o mesmo ingresso (R$ 160) e conta na capacidade total de 24 participantes. Durante a remada, o uso de colete salva-vidas adequado é obrigatório.","email":true},{"id":"seguranca","title":"Segurança na remada","body":"A remada é realizada em canoas havaianas, com acompanhamento da equipe Alma Azul Academy e uso obrigatório de colete salva-vidas para todos os participantes, inclusive crianças, com colete adequado.\n\nA realização da atividade na água depende de condições seguras de navegação."},{"id":"alimentacao","title":"Lanche saudável","body":"O ingresso inclui o lanche saudável da NutreDF, servido às 18h45, sem cobrança adicional."},{"id":"clima","title":"Condições climáticas","body":"Se as condições climáticas impedirem a realização segura das atividades, o evento inteiro será reagendado — remada, Superioga, lanche saudável, massagem e reflexologia e Educação Ambiental — e a nova data será comunicada aos participantes.\n\nO evento não é realizado em versão parcial nessas condições."},{"id":"cancelamento","title":"Política de cancelamento","body":"Você pode solicitar o cancelamento até 21 de novembro de 2026, às 12h00 (horário de Brasília), escolhendo entre crédito para outra experiência da Alma Azul Academy ou reembolso, conforme a política aplicável e os direitos do consumidor.\n\nAs solicitações são atendidas pela nossa equipe, pelos canais oficiais de atendimento."}]},"arrival":{"startTime":"16:30","toleranceUntil":"16:50"},"cancellation":{"deadline":"2026-11-21T12:00:00-03:00","timeZone":"America/Sao_Paulo","summary":"crédito para outra experiência da Alma Azul Academy ou reembolso, pelo atendimento da nossa equipe"},"reservation":{"eyebrow":"Celebre os novos ciclos com a gente","title":"Garanta a sua vaga","ctaLabel":"Garantir minha vaga","maxPerOrder":6,"notice":"Traga seu próprio tapete para a Superioga. Crianças participam somente acompanhadas por um responsável.","comingSoon":true,"image":{"src":"/images/eventos/essencia-lua-cheia/reserva-capsula-noite.webp","alt":"Cápsula Bar iluminado à noite, visto do Lago Paranoá, com as luzes refletidas na água e canoas no píer"}}}}$json$::jsonb,
    '/images/eventos/essencia-lua-cheia/hero-lua-desktop.webp',
    '2026-11-23T19:30:00.000Z'::timestamptz,
    210,
    16000,
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
