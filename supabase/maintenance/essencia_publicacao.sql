-- ESSÊNCIA — PUBLICAÇÃO SEM VENDAS (GERADO; NÃO EDITAR À MÃO)
--
-- Rodar no SQL Editor SÓ COM AUTORIZAÇÃO ESPECÍFICA, depois de
-- essencia_publicacao_preflight.sql (ESSENCIA_PUBLICACAO_PREFLIGHT_OK | OK).
--
-- Numa transação: liga o interruptor e publica por admin_update_event (o caminho
-- do painel, com auditoria), mantendo título, resumo, imagem, ordem e conteúdo.
-- NÃO abre a sessão, NÃO toca reserva nem lista de espera, NÃO toca variável de
-- ambiente. Com EVENTS_PUBLIC_ENABLED ausente, o site continua igual. Qualquer
-- conferência que falhe desfaz tudo.

begin;
set local lock_timeout = '5s';

do $publicacao$
declare
  actor uuid;
  actors integer;
  target public.experiences%rowtype;
  regulars_before text;
  regulars_after text;
begin
  select count(*), min(au.user_id::text)::uuid into actors, actor from public.admin_users au join auth.users u on u.id = au.user_id
  where lower(u.email) = 'almaazulacademy@gmail.com' and au.is_active and au.role = 'ADMIN';
  if actors <> 1 then
    raise exception 'ESSENCIA_ATOR: esperado 1 administrador ativo, encontrado %', actors;
  end if;

  select * into target from public.experiences where slug = 'essencia' and kind = 'EVENT' for update;
  if not found or target.status <> 'DRAFT' then
    raise exception 'ESSENCIA_ESTADO: evento ausente ou fora do rascunho';
  end if;
  if target.editorial_content <> $json${"version":1,"hero":{"eyebrow":"Evento especial · 1ª edição","title":"ESSÊNCIA","subtitle":"Uma manhã para desacelerar, se reconectar e viver o que realmente importa.","image":{"src":"/images/bases/concha-acustica/concha-hero-nascer-do-sol-desktop.webp","alt":"Canoa havaiana com remadores em silhueta no Lago Paranoá ao nascer do sol"},"primaryCta":{"label":"Garantir minha vaga","href":"#reserva"},"secondaryCta":{"label":"Ver a programação","href":"#programacao"},"details":["07 de novembro de 2026","05h30 às 09h","Cápsula Bar · Brasília"]},"quickFacts":[{"label":"Data","value":"07/11/2026"},{"label":"Horário","value":"05h30 às 09h"},{"label":"Local","value":"Cápsula Bar"},{"label":"Ingresso","value":"R$ 150 por pessoa"}],"about":{"eyebrow":"Uma manhã para sentir","title":"Natureza, movimento, respiração e encontros.","paragraphs":["Entre o nascer do sol, o movimento das águas e a conexão com o presente, nasce um convite para cuidar de si."],"image":{"src":"/images/bases/concha-acustica/capsula-lago-por-do-sol-desktop.webp","alt":"Lago Paranoá visto do Cápsula Bar com o céu colorido"}},"reservations":{"eyebrow":"Ingresso único","title":"Garanta a sua vaga","description":"Canoa havaiana, meditação, Superioga e lanche saudável em um único ingresso.","image":{"src":"/images/eventos/essencia/capsula-pier-amanhecer.jpg","alt":"Píer do Cápsula Bar avançando sobre o Lago Paranoá ao amanhecer"}},"seo":{"title":"ESSÊNCIA — Corpo, Mente e Natureza","description":"Uma manhã de canoa havaiana ao nascer do sol, meditação sensorial e Superioga no Cápsula Bar, em Brasília. 07 de novembro de 2026."},"event":{"badge":"Evento especial · 1ª edição","subtitle":"Corpo, mente e natureza","tagline":"Uma manhã para desacelerar, se reconectar e viver o que realmente importa.","highlights":["Canoa havaiana","Meditação","Superioga"],"heroImageMobile":{"src":"/images/bases/concha-acustica/concha-hero-nascer-do-sol-mobile.webp","alt":"Canoa havaiana com remadores em silhueta no Lago Paranoá ao nascer do sol"},"cardImage":{"src":"/images/bases/concha-acustica/concha-hero-nascer-do-sol-desktop.webp","alt":"Canoa havaiana no Lago Paranoá ao nascer do sol"},"intro":{"eyebrow":"Uma manhã para sentir","title":"Um convite para cuidar de si.","paragraphs":["Entre o nascer do sol, o movimento das águas e a conexão com o presente, nasce um convite para cuidar de si.","Uma experiência que reúne natureza, movimento, respiração e encontros especiais em uma manhã pensada para renovar as energias."],"image":{"src":"/images/bases/concha-acustica/capsula-lago-por-do-sol-desktop.webp","alt":"Lago Paranoá visto do Cápsula Bar com o céu colorido"}},"program":{"eyebrow":"Programação","title":"Do nascer do sol ao encontro.","items":[{"time":"05:30","title":"Canoa havaiana ao nascer do sol","description":"O sol nasce, o lago desperta e cada remada convida você a estar presente.","hosts":["Alma Azul Academy"],"note":"Não é necessário ter experiência prévia.","image":{"src":"/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-galeria-02.webp","alt":"Canoa havaiana deslizando no Lago Paranoá com o céu alaranjado do amanhecer"}},{"time":"07:30","title":"Meditação sensorial","description":"Um convite para respirar, sentir e se conectar com o presente, através da aromaterapia.","hosts":["Rapha Dantas","Fernanda Garcia"],"image":{"src":"/images/eventos/essencia/capsula-deck-lago.jpg","alt":"Deck do Cápsula Bar de frente para o Lago Paranoá, com árvores e o píer ao fundo"}},{"time":"07:45","title":"Superioga","description":"Movimento, força e respiração em uma prática que integra corpo e mente.","hosts":["Rapha Dantas"]},{"time":"09:00","title":"Encerramento e conexão","description":"O bem-estar também está nos encontros. Momento de integração e lanche saudável oferecido pela Nutre.","hosts":[],"image":{"src":"/images/eventos/essencia/capsula-mesas-encontro.jpg","alt":"Mesas e cadeiras no espaço aberto do Cápsula Bar"}}]},"included":{"eyebrow":"Ingresso único","title":"Tudo o que está incluso.","description":"Um único ingresso para viver a manhã completa — não é só uma remada nem só uma aula.","items":["Canoa havaiana ao nascer do sol","Meditação sensorial com aromaterapia","Superioga","Momento de integração","Lanche saudável da Nutre"]},"partners":{"eyebrow":"Quem faz acontecer","title":"Uma manhã feita a muitas mãos.","items":[{"name":"Cure-se Bem","role":"Meditação sensorial com aromaterapia","logo":{"src":"/images/eventos/essencia/logo-cure-se-bem.png","alt":"Logo Cure-se Bem"}},{"name":"Alma Azul Academy","role":"Canoa havaiana ao nascer do sol","logo":{"src":"/images/branding/alma-azul-logo-dark.png","alt":"Logo Alma Azul Academy"}},{"name":"Cápsula Bar","role":"Local do evento","logo":{"src":"/images/bases/concha-acustica/capsula-bar-logo.webp","alt":"Logo Cápsula Bar"}},{"name":"Rapha Dantas","role":"Superioga e meditação sensorial"},{"name":"Nutre Congelados Saudáveis","role":"Parceira de alimentação · lanche saudável","logo":{"src":"/images/eventos/essencia/logo-nutre.png","alt":"Logo Nutre"}}]},"info":{"eyebrow":"Antes de ir","title":"Informações importantes","items":[{"id":"chegada","title":"Horário e chegada","body":"Nossa experiência começa às 05h30, no Cápsula Bar, às margens do Lago Paranoá.\n\nRecomendamos chegar com alguns minutos de antecedência para aproveitar cada momento. Haverá tolerância de chegada até às 05h50."},{"id":"o-que-levar","title":"O que levar","body":"Venha com roupas confortáveis, adequadas para atividades físicas. Recomendamos trazer garrafa de água, protetor solar e seus itens pessoais.\n\nPara participar da prática de Superioga, traga seu próprio tapete. A organização não disponibilizará tapetes para essa atividade."},{"id":"experiencia","title":"Preciso ter experiência anterior?","body":"Não! A experiência foi pensada para acolher também quem está começando. Nossa equipe conduzirá as atividades e fornecerá as orientações necessárias."},{"id":"seguranca","title":"Segurança durante a remada","body":"O uso de colete salva-vidas é obrigatório durante a atividade na água. Antes da saída, nossa equipe apresentará as orientações de segurança."},{"id":"alimentacao","title":"Alimentação inclusa","body":"Ao final da programação, teremos um momento especial de integração com lanche saudável oferecido pela Nutre Congelados Saudáveis."},{"id":"clima","title":"Condições climáticas","body":"A segurança e o bem-estar de todos vêm em primeiro lugar. Caso as condições climáticas impeçam a realização segura da experiência, o evento será reagendado e os participantes serão comunicados pela organização."},{"id":"cancelamento","title":"Política de cancelamento","body":"Você pode solicitar o cancelamento até 5 de novembro de 2026, às 12h00 (horário de Brasília), escolhendo entre crédito para utilizar em outras experiências da Alma Azul ou solicitação de reembolso com nossa equipe.\n\nApós esse prazo, entre em contato conosco para avaliação do seu caso."}]},"arrival":{"startTime":"05:30","toleranceUntil":"05:50"},"cancellation":{"deadline":"2026-11-05T12:00:00-03:00","timeZone":"America/Sao_Paulo","summary":"crédito para utilizar em outras experiências da Alma Azul ou solicitação de reembolso com nossa equipe"},"reservation":{"eyebrow":"Sua próxima pausa tem data marcada","title":"Garanta a sua vaga","ctaLabel":"Garantir minha vaga","maxPerOrder":6,"notice":"Traga seu próprio tapete para a prática de Superioga. A organização não disponibilizará tapetes.","image":{"src":"/images/eventos/essencia/capsula-pier-amanhecer.jpg","alt":"Píer do Cápsula Bar avançando sobre o Lago Paranoá ao amanhecer"}}}}$json$::jsonb
     or not public.experience_editorial_is_publishable(target.editorial_content) then
    raise exception 'ESSENCIA_CONTEUDO: conteúdo diferente do aprovado';
  end if;
  if (select publication_enabled from public.special_event_settings where singleton) is distinct from false then
    raise exception 'ESSENCIA_INTERRUPTOR: esperado desligado';
  end if;
  if (select count(*) from public.sessions s where s.experience_id = target.id) <> 1
     or (select count(*) from public.sessions s where s.experience_id = target.id and s.status = 'CLOSED' and to_char(s.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') = '2026-11-07T08:30' and s.duration_minutes = 210 and s.price_cents = 15000 and s.capacity = 24) <> 1 then
    raise exception 'ESSENCIA_SESSAO: esperada uma sessão CLOSED com os dados aprovados';
  end if;
  if exists (select 1 from public.reservations r join public.sessions s on s.id = r.session_id where s.experience_id = target.id)
     or exists (select 1 from public.waitlist_entries w join public.sessions s on s.id = w.session_id where s.experience_id = target.id) then
    raise exception 'ESSENCIA_RESERVAS: o evento já tem reserva ou inscrição';
  end if;

  select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) into regulars_before from public.list_public_regular_catalog() x;

  update public.special_event_settings set publication_enabled = true, updated_at = now() where singleton;
  perform public.admin_update_event(actor, target.id, target.title, target.summary, 'PUBLISHED', target.image_url, target.display_order, target.editorial_content);

  if (select status from public.experiences where id = target.id) <> 'PUBLISHED' then
    raise exception 'ESSENCIA_PUBLICACAO: status não mudou';
  end if;
  if (select count(*) from public.sessions s where s.experience_id = target.id and s.status = 'CLOSED') <> 1 then
    raise exception 'ESSENCIA_SESSAO_ALTERADA: a sessão precisa continuar CLOSED';
  end if;
  select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) into regulars_after from public.list_public_regular_catalog() x;
  if regulars_before <> regulars_after then
    raise exception 'ESSENCIA_REGULARES: o catálogo regular mudou';
  end if;
  raise notice 'ESSENCIA_PUBLICADO_SEM_VENDAS';
end;
$publicacao$;

commit;
