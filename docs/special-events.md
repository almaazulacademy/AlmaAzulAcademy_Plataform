# Eventos especiais

[README](../README.md) · [Banco de dados](database.md) · [Stand-by](reservation-standby.md) · [Lista de espera](waitlist.md)

**Estado (29/10/2026): fases 2, 3 e 4 concluídas, na `main` e em produção, com a publicação desativada.** PR #42 (squash `8aa7677`), PR #43 (squash `34dec78`) e PR #44 (squash `56dbc47`, 29/10). Migration `202610280001_special_events_foundation.sql` aplicada, com preflight e postcheck sem falhas. A interface pública (`/eventos`, `/eventos/[slug]`) e o conteúdo operacional do ESSÊNCIA estão aprovados, mas **desligados**: `EVENTS_PUBLIC_ENABLED` ausente (as rotas respondem 404) e `special_event_settings.publication_enabled` desligado. Nenhum evento cadastrado nem publicado, nenhuma reserva de evento. **Próxima etapa: fase 5**, que depende de autorização.

## O que é

Eventos especiais são experiências realizadas em datas específicas, muitas vezes em parceria com outras marcas, com programação, preço e capacidade próprios. O primeiro é o **ESSÊNCIA — Corpo, Mente e Natureza** (07/11/2026, 05h30 às 09h, Cápsula Bar / Base Concha Acústica, 24 vagas, R$ 150 por pessoa, até 6 por pedido, ingresso único).

**Não existe um segundo sistema de reservas.** Um evento é uma linha de `experiences` com `kind = 'EVENT'` e uma sessão por edição. Vagas, pré-reserva, pagamento pela InfinitePay, confirmação, e-mail, planilha, check-in, Stand-by e lista de espera são os de sempre.

## Fases

| Fase | O que entrega | Estado |
| --- | --- | --- |
| 2. Banco e segurança | `experiences.kind`, interruptor de publicação, trava entre tipos, leitura pública e funções do painel | Na `main` (#42); migration aplicada em produção (28/10), interruptor desligado |
| 3. Separação no site | Home, vitrine, agenda e base passam a usar as listagens regulares; opções de troca de turma filtradas por tipo | Na `main` e em produção (#43, 28/10); sem migration |
| 4. Páginas públicas | `/eventos`, `/eventos/[slug]`, destaque na home e item no menu, atrás de `EVENTS_PUBLIC_ENABLED`; conteúdo operacional do ESSÊNCIA | Concluída: na `main` e em produção (#44, 29/10); desligada; sem migration |
| 5. Reserva, e-mail, cancelamento e crédito | 5A reservas e pagamentos; 5B e-mail de evento; 5C lista de espera; 5D reembolso pelo WhatsApp; 5E crédito | 5A (#46), 5B (#47) e o ajuste de 24 vagas (#48) na `main`, desligados; 5C-1 em PR draft; demais aguardam autorização |
| 6. Painel | `/admin/eventos` com formulário estruturado | — |
| 7. Relatórios | Painéis separados por tipo | — |
| 8. Lançamento do ESSÊNCIA | Cadastro, publicação e interruptor ligado | — |

## Fase 2 — banco e segurança

Migration `202610280001_special_events_foundation.sql`. É aditiva e idempotente: **não substitui o corpo de nenhuma função existente**, não toca linha de reserva, sessão, pagamento, Stand-by ou lista de espera, e não cria agendamento. O teste compara o corpo de todas as funções antes e depois.

### `experiences.kind`

`text not null default 'REGULAR'`, com check `REGULAR`/`EVENT`. O default preenche as linhas existentes sem `UPDATE`: nenhuma trigger dispara e `updated_at` não muda.

Regras (trigger `experiences_kind_guard`):

- **o tipo não muda depois que a experiência tem sessão** (`EXPERIENCE_KIND_LOCKED`), nos dois sentidos;
- **um evento só vira `PUBLISHED` com o interruptor ligado** (`EVENT_PUBLICATION_DISABLED`), por qualquer caminho: painel de eventos, painel atual de experiências ou SQL. Um evento já publicado continua editável se o interruptor for desligado depois.

### Interruptor da publicação

Tabela `special_event_settings` (uma linha, `publication_enabled = false`), com RLS ligada e nenhum acesso pela API, nem da service role. Existe porque as listagens atuais do site (`list_public_experiences`, `list_public_catalog`) não sabem de tipo: um evento publicado antes da fase 3 apareceria misturado na home, na vitrine e na agenda. Ligar é decisão da fase 8, no SQL Editor:

```sql
update public.special_event_settings set publication_enabled = true, updated_at = now();
```

**Com a migration `202610310001`, o interruptor também esconde o evento já publicado.** Antes dela ele só travava o ato de publicar: `list_public_events`, `get_public_event` e `list_public_event_sessions` filtravam por `kind = 'EVENT'` e `status = 'PUBLISHED'`, sem olhar `publication_enabled` (achado de 29/10/2026).

| Interruptor desligado | O que acontece |
| --- | --- |
| Leituras públicas | `list_public_events` e `list_public_event_sessions` (corpo novo) e `get_public_event` (lê da primeira) não devolvem evento: página em 404, menu, home, sitemap e redirecionamento somem |
| Reserva (`POST /api/reservations`) | Recusa com `409 EVENT_NOT_PUBLIC` antes de qualquer pré-reserva, mesmo com `EVENT_BOOKING_OPEN` e o id da sessão: `loadSessionBookingRules` confere a sessão em `list_public_event_sessions` (`visible`) |
| Página `/reservar/[id]` | Lê o tipo real da sessão no banco; sessão de evento escondido mostra "Reservas indisponíveis" — nunca a tela regular |
| Inscrição na lista de espera | Recusada (`SESSION_UNAVAILABLE`): o escopo confere o evento em `get_public_event` |
| Aviso de vaga | Não é reivindicado (`claim_pending_waitlist_spot_emails_by_kind` exige o interruptor para `EVENT`): sem tentativa, sem envio contado, segue na fila. Segunda barreira no envio (`eventPublic`) |
| Experiências regulares | Nada muda: leituras próprias, mesmas listagens (teste compara ligado × desligado) |

Religado, volta só o que continua elegível: evento em rascunho continua fora, sessão fechada continua fechada, e a venda e a lista seguem dependendo das variáveis.

**Ordem das migrations (ainda não aplicadas).** `202610300001_waitlist_event_scope.sql` (lista de espera por tipo, já com o filtro do interruptor na reivindicação dos avisos — editada antes de ser aplicada, para nenhuma migration posterior recriar função que ainda não existe em produção) e `202610310001_special_events_publication_switch.sql` (leituras públicas) são **independentes**: cada uma depende só da fundação `202610280001`, já aplicada, e as duas podem ser aplicadas em qualquer ordem (teste aplica nas duas). Ordem recomendada:

1. `special_events_publication_switch_preflight.sql` → `EVENTOS_INTERRUPTOR_PREFLIGHT_OK | OK`; `202610310001` (com `begin;` + `set local lock_timeout = '5s';` … `commit;`); `..._postcheck.sql` → `EVENTOS_INTERRUPTOR_POSTCHECK_OK | OK`, mesmas assinatura e contagens.
2. `waitlist_event_scope_preflight.sql` → `202610300001` → `waitlist_event_scope_postcheck.sql`.

Rollback na ordem inversa da aplicação: `supabase/rollback/202610300001_waitlist_event_scope.rollback.sql` (remove as duas funções da lista) e `supabase/rollback/202610310001_special_events_publication_switch.rollback.sql` (devolve às duas leituras o corpo da fundação). Depois do rollback da `202610310001`, o postcheck da fundação volta a aprovar; antes dele, ele aponta as duas leituras como diferentes — esperado.

Sem a `202610310001` aplicada, para tirar um evento do ar: remover `EVENTS_PUBLIC_ENABLED` (ou `EVENT_BOOKING_OPEN` / `EVENTS_WAITLIST_ENABLED`) e publicar de novo, ou voltar o evento a rascunho pelo painel. **Aplicar antes de ligar `EVENTS_PUBLIC_ENABLED` em produção.**

Testes: `tests/special-events-publication-switch.test.ts` e, com sessões reais do Postgres (CI), `tests/waitlist-spot-concurrency.test.ts`.

### Nenhuma reserva troca de tipo

Trigger `reservations_event_kind_guard`, `before update of session_id` em `reservations`: uma reserva só troca de sessão para outra sessão do mesmo tipo. Recusa com `EVENT_KIND_MISMATCH` e desfaz a transação inteira — histórico de troca, resolução do Stand-by, e-mail de reagendamento e job da planilha nem chegam a ser gravados.

Cobre, sem reescrever nenhuma delas, todas as operações que mudam a turma de uma reserva:

| Caminho | Função |
| --- | --- |
| Troca de turma do painel | `admin_change_reservation_session` |
| Stand-by pelo painel | `admin_reschedule_standby_same_price` (e a antiga, fora do alcance da service role) |
| Autoatendimento do cliente | `customer_reschedule_reservation` |
| Desfazer Stand-by | `admin_undo_reservation_standby` (sempre o mesmo tipo: volta à turma original) |

Dentro do mesmo tipo nada muda: regular ↔ regular como antes, e evento ↔ outra sessão de evento (uma nova data da mesma edição, por exemplo) é permitido.

O painel e o autoatendimento traduzem a recusa (`lib/admin/mutation-errors.ts`, `lib/reservations/standby-self-service.ts`). Desde a fase 3, as listas de turmas de destino nem oferecem sessões do outro tipo (ver abaixo).

### Capacidade

A de sempre: `create_pre_reservation` trava a sessão (`FOR UPDATE`) e soma confirmadas e pré-reservas válidas antes de aceitar. Para o ESSÊNCIA, a sessão será cadastrada com `capacity = 24` e `price_cents = 15000`: no máximo 24 participantes e R$ 3.600 de receita bruta. As vagas exibidas vêm sempre de `sessions.capacity`, nunca de número fixo no site; `ESSENCIA_CAPACITY` (24) existe só para a prévia e os testes. O teste de concorrência prova, com 16 conexões reais comprando ao mesmo tempo, que exatamente 12 entram numa sessão genérica de 12 vagas e 24 na do ESSÊNCIA. (Capacidade decidida em 29/10/2026, antes 12; o banco aceita de 1 a 500.)

### Leitura pública

Todas `security definer`, executáveis por `anon`. Nenhuma devolve capacidade, dado de reserva ou dado pessoal.

| Função | Devolve |
| --- | --- |
| `list_public_events()` | Eventos publicados, um por linha, com a base (nome, endereço, ponto de encontro, mapa) e a sessão em destaque: a próxima ativa; sem ela, a mais recente. Próximos primeiro |
| `get_public_event(slug)` | O mesmo, para um evento |
| `list_public_event_sessions(slug)` | Todas as sessões do evento, menos as arquivadas, com a situação |
| `list_public_regular_experiences()` | `list_public_experiences()` sem eventos (mesmas colunas e ordem) |
| `list_public_regular_catalog()` | `list_public_catalog()` sem eventos (mesmas colunas e ordem) |

**Situação** (`availability`): `AVAILABLE`, `SOLD_OUT`, `CLOSED` (reservas encerradas), `ENDED` (já realizado), `CANCELLED`, ou `NO_SESSION`. Vagas restantes só em `AVAILABLE`/`SOLD_OUT`. Só exibição: reservar continua passando por `get_booking_session` e `create_pre_reservation`.

As listagens antigas ficam intactas. O site troca para as novas na fase 3.

### Painel

Executáveis só pela service role, depois de `is_active_admin` (ADMIN ou OPERATOR ativo; instrutor é recusado). Reaproveitam `admin_create_experience`, `admin_update_experience` e `admin_create_session` — mesmas validações e auditoria.

| Função | Faz |
| --- | --- |
| `admin_create_event(ator, base, slug, título, resumo, editorial, imagem, início, duração, preço, capacidade)` | Cria o evento em **rascunho**, com a sessão **fechada** para reservas. Devolve `experienceId` e `sessionId` |
| `admin_update_event(ator, evento, título, resumo, status, imagem, ordem, editorial)` | Conteúdo e status (`DRAFT`, `PUBLISHED`, `ARCHIVED`). Publicar exige conteúdo completo e o interruptor ligado |
| `admin_duplicate_event(ator, origem, slug, título, início)` | Nova edição: copia conteúdo, base, preço, duração e capacidade; rascunho e sessão fechada; nenhuma reserva copiada |
| `admin_list_events(ator)` | Eventos de qualquer status, com a sessão em destaque e seus números |
| `admin_event_report(ator, evento)` | Por sessão: capacidade, vagas, confirmadas, pré-reservas válidas, Stand-by, canceladas, presentes, receita confirmada e pendente. Sem dado pessoal |

Data, preço, capacidade e abrir/fechar reservas continuam na sessão, pelas RPCs de sessão de sempre (`admin_update_session`). Participantes, pagamentos e check-in usam as telas atuais de reservas e presença.

Auditoria: `EVENT_CREATED`, `EVENT_UPDATED`, `EVENT_DUPLICATED`, além dos registros das RPCs reaproveitadas.

### Compatibilidade

- **InfinitePay, confirmação, reconciliação e e-mail**: sem mudança. O checkout usa o título do evento como descrição.
- **Google Sheets**: sem mudança. Uma reserva de evento entra na planilha como qualquer outra, com o título do evento na coluna Experiência.
- **Lista de espera**: sem mudança. Uma sessão de evento esgotada aceita inscrição como qualquer turma (testado).
- **Stand-by**: sem mudança, a não ser a trava entre tipos.
- **Check-in e área do instrutor**: sem mudança; a sessão do evento aparece no dia, como qualquer turma.

## Fase 3 — separação no site

Só código; nenhuma migration. Usa as funções e a trava da fase 2.

### Listagens públicas

| Área | Leitura |
| --- | --- |
| Home, vitrine `/experiencias`, `/bases`, `/bases/[slug]` | `listCatalogExperiences` (`lib/bases/data.ts`) → `list_public_regular_catalog` |
| Home (cards), agenda `/agenda`, sitemap | `listPublishedExperiences` (`lib/editorial/data.ts`) → `list_public_regular_experiences` |
| Landing `/experiencias/[slug]` | `get_public_experience`, e devolve "não encontrada" quando `get_public_event` reconhece o slug como evento publicado |

As funções regulares devolvem exatamente o que as antigas devolviam, menos os eventos. Se a função nova não existir no banco (`PGRST202`/`42883` — banco de teste antigo ou rollback da migration, que só roda sem nenhum evento), o site volta para a antiga, que nesse caso dá o mesmo resultado (`lib/supabase/rpc-fallback.ts`). Qualquer outra falha segue o tratamento de sempre, sem cair na antiga.

Páginas por sessão (`/reservar/[sessionId]`, `/lista-de-espera/[sessionId]`) e a grade de datas de cada landing continuam iguais: dependem da sessão ou do slug, não de uma listagem geral.

### Turmas de destino

As três listas passam, no servidor, pelo filtro de tipo de `lib/events/kind.ts` (`sessions.experience_id` → `experiences.kind`, com a service role):

| Lista | Onde |
| --- | --- |
| Troca de turma do painel | `getAdminReservationSessionOptions` (`lib/admin/data.ts`), origem = turma atual |
| Stand-by do painel | `getStandbyOptions` (`lib/admin/standby-data.ts`), origem = turma original |
| Autoatendimento do cliente | `handleSelfServiceOverview` (`lib/reservations/standby-self-service.ts`), origem = turma original |

Reserva regular vê só turmas regulares; reserva de evento vê só sessões de evento (outra edição do mesmo evento ou outro evento). Preço, vagas, status, base e autorização continuam decididos pelas RPCs de opções, sem mudança. Sem saber o tipo, o painel mostra erro e o autoatendimento responde "indisponível" — nunca uma lista sem filtro. A trava `EVENT_KIND_MISMATCH` continua no banco para qualquer escolha forjada.

A leitura dos tipos vai em lotes de 100 sessões: a troca de turma do painel lista a agenda inteira, e um filtro `in` único passaria de 8 KB de URL.

O contador "turmas sem vagas para o grupo" vem da RPC e ainda conta sessões do outro tipo sem vaga; só a explicação ao lado da lista é afetada. No Stand-by e no autoatendimento ele só conta turmas do mesmo valor pago por pessoa, então um evento a R$ 150 só entra na conta de uma reserva regular paga a R$ 150 por pessoa; na troca de turma do painel, um evento esgotado soma 1.

Testes: `tests/special-events-separation.test.ts`.

## Fase 4 — páginas públicas

Só código; nenhuma migration e nenhum dado gravado. Tudo atrás de `EVENTS_PUBLIC_ENABLED` (ausente = desligada).

### Interruptores

| Interruptor | Efeito |
| --- | --- |
| `EVENTS_PUBLIC_ENABLED=true` | Expõe `/eventos`, `/eventos/[slug]`, o item "Eventos" no menu e o destaque na home. Ausente: as rotas respondem **404** e nada de evento aparece; a home e o menu nem consultam o banco |
| `special_event_settings.publication_enabled` (banco) | Sem ele nenhum evento é publicado; mesmo com a variável ligada, a seção mostra o estado vazio e o menu não ganha o item |
| `EVENT_BOOKING_OPEN` (`lib/events/flags.ts`) | `false` nesta fase: o botão "Garantir minha vaga" aparece, desativado, com "As reservas pelo site abrem em breve". Na fase 5 vira link para `/reservar/[sessionId]` |

O item do menu e o destaque da home só aparecem com a variável ligada **e** pelo menos um evento publicado.

### Rotas

| Rota | O que mostra |
| --- | --- |
| `/eventos` | Hero da seção, próximos eventos (o primeiro em destaque), edições anteriores quando existirem e estado vazio elegante |
| `/eventos/[slug]` | A página do evento, montada só com os dados cadastrados. Inexistente ou não publicado: 404 |
| `/experiencias/[slug]` | Slug de um evento publicado redireciona (307) para `/eventos/[slug]` com a seção ligada |
| `/eventos/demonstracao` e `/eventos/demonstracao/essencia` | **Prévia com dados de demonstração** (fixture, sem banco), só no desenvolvimento local e no Preview da Vercel; em Production, 404. Aviso visível de que não é um evento publicado, `noindex`, fora do sitemap. `?estado=SOLD_OUT\|CLOSED\|ENDED`, `?vagas=3` e `?vazio=1` mostram as outras situações |

Não há `loading.tsx` na seção de propósito: com ele, o Next começa a enviar a resposta antes do `notFound()` e o 404 da seção desligada sairia com status 200. `error.tsx` cobre falhas inesperadas.

### Página do evento

Oito blocos, todos vindos de `experiences.editorial_content`: Hero (selo, título, subtítulo em âmbar, descrição, destaques, data, horário e local), apresentação, programação em linha do tempo com fotos, o que está incluso (ingresso único), quem faz acontecer (logos quando existem), local (o `BaseLocationCard` da base, com endereço, ponto de encontro e mapa), informações importantes e reserva (resumo e botão). No celular, um CTA fixo embaixo, com espaço reservado para não cobrir o rodapé, e sem o botão flutuante do WhatsApp para não sobrepor.

Visual: fundo noturno, títulos em Montserrat 800 caixa alta (carregada com `next/font` só nas páginas de evento), destaques em âmbar (`ember`), fotografias reais.

### Conteúdo editorial do evento

O documento é o mesmo das experiências (versão 1, que o banco exige para publicar) com um bloco a mais, `event` (`lib/events/editorial.ts`):

| Campo | Conteúdo |
| --- | --- |
| `badge`, `subtitle`, `tagline`, `highlights` | Selo, subtítulo, descrição e destaques do Hero |
| `heroImageMobile`, `cardImage` | Foto do Hero para celular e do card (opcionais) |
| `intro` | Título, parágrafos e foto da apresentação |
| `program.items[]` | `time` (HH:MM, em ordem), `title`, `description`, `hosts[]`, `note`, `image` |
| `included.items[]` | O que o ingresso inclui |
| `partners.items[]` | `name`, `role` (nas palavras da organização), `logo` opcional |
| `info.items[]` | `id` (âncora `#info-<id>`), `title`, `body` (parágrafos separados por linha em branco); sem texto confirmado ficam `pending` e **só aparecem na prévia** |
| `arrival` | `startTime` e `toleranceUntil` (HH:MM, Brasília). O texto `chegada` precisa citar os dois horários |
| `cancellation` | `deadline` (ISO 8601 **com deslocamento**), `timeZone` (`America/Sao_Paulo`) e `summary`. O texto `cancelamento` precisa citar o mesmo dia e hora |
| `reservation` | Título, texto do botão e foto de fundo |

Evento publicado sem o bloco completo não aparece no site. O conteúdo do ESSÊNCIA está em `lib/events/fixtures/essencia.ts`, no formato exato do banco, para ser cadastrado na fase de lançamento.

### Mídias

| Arquivo | Origem | Uso |
| --- | --- | --- |
| `bases/concha-acustica/concha-hero-nascer-do-sol-{desktop,mobile}.webp` | Repositório (mesma foto do slide 1 do carrossel) | Hero e card |
| `bases/concha-acustica/capsula-lago-por-do-sol-desktop.webp` | Repositório | Apresentação e Hero de `/eventos` |
| `experiences/remada-nascer-do-sol/remada-nascer-do-sol-galeria-02.webp` | Repositório | 05h30 — canoa havaiana |
| `eventos/essencia/capsula-deck-lago.jpg` | Pasta do Cápsula Bar (`DSC00153`, fundo do slide 3) | 07h30 — meditação |
| `eventos/essencia/capsula-mesas-encontro.jpg` | Pasta do Cápsula Bar (`DSC07470`, fundo do slide 4) | 09h — encerramento |
| `eventos/essencia/capsula-pier-amanhecer.jpg` | Pasta do Cápsula Bar (`DSC00386`, fundo do slide 5) | Reserva |
| `eventos/essencia/logo-cure-se-bem.png` | `CURE-SE LOGO VETOR.pdf` | Parceiros |
| `eventos/essencia/logo-nutre.png` | Logo enviado pela organização | Parceiros |
| `branding/alma-azul-logo-dark.png`, `bases/concha-acustica/capsula-bar-logo.webp` | Repositório | Parceiros |

Rapha Dantas não tem logo fornecido: aparece pelo nome. Os slides não foram usados como imagem (têm texto embutido).

### Regras operacionais do ESSÊNCIA

Textos definitivos aprovados em 29/10/2026, em `info.items` da fixture: horário e chegada, o que levar, experiência anterior, segurança durante a remada, alimentação inclusa, condições climáticas e política de cancelamento. Nenhum fica pendente; não há referência a chegada às 05h15 em lugar nenhum do repositório.

| Regra | Valor guardado | Onde aparece |
| --- | --- | --- |
| Início e tolerância | `arrival: { startTime: "05:30", toleranceUntil: "05:50" }` | Texto "Horário e chegada" e a linha "Chegada · tolerância até 05H50" no bloco de reserva |
| Tapete do Superioga | Texto "o-que-levar": cada participante leva o próprio tapete; a organização não disponibiliza (ajuste de 29/10/2026, antes "materiais fornecidos pela equipe") | Página do evento, e-mail de confirmação (seção "O que levar") e prévia |
| Aviso no resumo da reserva | `reservation.notice`: "Traga seu próprio tapete para a prática de Superioga. A organização não disponibilizará tapetes." (opcional, até 200 caracteres) | Resumo do ingresso, antes do pagamento, depois de "Importante:". Evento sem `notice` não mostra aviso; o resumo das experiências regulares não muda |
| Prazo de cancelamento | `cancellation.deadline = "2026-11-05T12:00:00-03:00"` (`= 2026-11-05T15:00:00Z`), `timeZone: "America/Sao_Paulo"` | Texto "Política de cancelamento" e, junto ao botão de reserva, "Cancelamento até 05/11/2026 às 12h00 (horário de Brasília): crédito para utilizar em outras experiências da Alma Azul ou solicitação de reembolso com nossa equipe.", com link para a política completa |

O validador recusa prazo sem deslocamento, fuso diferente de `America/Sao_Paulo` e texto que diga outro dia ou hora que a regra — mudar uma sem a outra não passa. `arrivalMatchesSession` confere a chegada com a sessão cadastrada (início igual, tolerância entre o início e o fim).

**Prazo inclusivo** (`cancellationWindow`, `lib/events/policy.ts`): pedido até `2026-11-05T12:00:00.000-03:00`, inclusive, é `WITHIN_DEADLINE`; um milissegundo depois, `AFTER_DEADLINE` — análise da equipe, sem promessa automática.

**Nada é automático nesta fase.** A política definitiva (decisão de 29/10/2026) dá duas escolhas dentro do prazo, e a parte financeira e operacional fica para a **fase 5**:

- **Crédito para outras experiências da Alma Azul**: o valor elegível da reserva vira crédito para usar em outras experiências, nas condições de uso que a fase 5 vai implementar. Hoje a plataforma não tem crédito: nada é gerado nem prometido como automático.
- **Reembolso**: pedido pelo atendimento oficial da Alma Azul no WhatsApp; a devolução é feita manualmente pela equipe, como hoje. Nenhum reembolso é disparado pelo site.
- **Depois do prazo**: avaliação caso a caso pela equipe, sem promessa automática.
- **Clima**: reagendar o evento é mudar a data da sessão pelo painel; o aviso aos participantes é feito pela organização (não há e-mail automático de mudança de data).
- **Antes da confirmação**: a política fica visível na página do evento, ao lado do botão. Na fase 5, a página de reserva e o e-mail de confirmação do evento devem repetir o prazo a partir do mesmo `cancellation`.

Stand-by, reservas, cancelamento pelo painel e reembolsos **não mudam** nesta fase. O texto deixou de falar em "vaga na próxima edição"; o Stand-by continua existindo para a equipe, sem ser parte da política comunicada.

### Pendente antes de publicar

- Confirmação dos parceiros quanto ao uso dos logos; logo do Rapha Dantas, se houver.
- Fase 5: botão de reserva (`EVENT_BOOKING_OPEN`), política na página de reserva, e-mail de evento e o **crédito para outras experiências** (regras de uso, saldo e registro) — com o reembolso seguindo manual pelo WhatsApp.
- **Fase 5, obrigatório antes de vender**: o e-mail de confirmação atual (`lib/reservations/confirmation-email.ts`) vale para qualquer base e traria a uma reserva do ESSÊNCIA textos de remada que contradizem o evento — "cancelamento até 1 dia antes" (`CANCELLATION_NOTE`) e "roupa de banho"/"chinelo" (`PREPARATION_ITEMS`). A tolerância de 20 minutos (`MEETING_TOLERANCE_NOTE`) coincide com 05h50. O e-mail de evento deve usar `event.cancellation`, `event.arrival` e os textos de `info.items`. Hoje nada disso chega a cliente: a reserva do evento não está aberta.
- O slug `demonstracao` fica reservado para a prévia: um evento com esse slug não teria página.

### Como revisar no Preview

O Preview usa o banco de produção. A prévia **não lê nem grava nada**: abra `/eventos/demonstracao` e `/eventos/demonstracao/essencia` (com `?estado=SOLD_OUT`, `CLOSED`, `ENDED` ou `?vazio=1`). Não ligue `EVENTS_PUBLIC_ENABLED` nem o interruptor do banco para revisar.

Capturas em `docs/screenshots/eventos-especiais/`. Testes: `tests/special-events-public.test.ts`.

## Fase 5A — reservas e pagamentos do evento

Só código; nenhuma migration. O evento usa o fluxo de sempre — `/reservar/[sessionId]`, `POST /api/reservations`, `create_pre_reservation`, InfinitePay, webhook, reconciliação, confirmação, planilha e check-in —, sem segundo fluxo e sem mexer no motor financeiro.

**Venda fechada no servidor.** `EVENT_BOOKING_OPEN=true` (junto com `EVENTS_PUBLIC_ENABLED`) abre a venda. Desligada — o padrão —, `POST /api/reservations` recusa qualquer sessão de evento com `409 EVENT_BOOKING_CLOSED` **antes** de bloquear vaga, mesmo com o id da sessão em mãos, e a página `/reservar/[sessionId]` mostra "Reservas ainda não abertas" sem formulário. A decisão é de `lib/events/booking.ts` (`loadSessionBookingRules` + `eventBookingRejection`), que lê `sessions.experience_id` → `experiences.kind` com a service role; sem conseguir ler, a rota responde 503 e não abre reserva. Experiência regular passa direto, como antes. **Não ligar antes do e-mail de evento (5B) validado.**

**Máximo por pedido.** `event.reservation.maxPerOrder` (1 a 20, no conteúdo do evento): o ESSÊNCIA aceita até **6** participantes por pedido. O servidor recusa acima disso (`400 EVENT_ORDER_LIMIT`) e o formulário só oferece até `min(vagas restantes, máximo)`. O limite geral de 20 e a capacidade (12) continuam no banco, que também decide o preço (R$ 150 da sessão) — o navegador não manda valor nenhum.

**Textos de ingresso.** Para sessão de evento publicado:

| Onde | Agora |
| --- | --- |
| `/reservar/[sessionId]` | "Seu ingresso", local da base do evento, "Voltar para o evento" (`/eventos/[slug]`); evento esgotado ou venda fechada com explicação e volta para o evento |
| Formulário | "Garantir meu ingresso", "Participantes" ("Até 6 por pedido."), política de cancelamento **antes do botão de pagamento** |
| Resumo | "Resumo do ingresso": ingresso único com a programação completa, data, horário, tolerância de chegada, programação, o que está incluso, preço por participante e o prazo de cancelamento |
| Pré-reserva | "Seus ingressos estão reservados por 2 horas"; vencida, "Voltar ao evento" |
| Retorno do pagamento | "Ingresso confirmado" e link para a página do evento |
| Página do evento | O botão "Garantir minha vaga" leva a `/reservar/[sessionId]` com a venda aberta; a prévia nunca |

Experiência regular: textos, quantidade e links de sempre.

**Ainda não cobre (próximas etapas):** a consulta por CPF + código (`/acompanhar-reserva`) ainda mostra "turma" numa pré-reserva de evento retomada (fica para a 5D, que mexe nessa tela); lista de espera do evento (5C).

Testes: `tests/special-events-booking.test.ts`.

## Fase 5B — e-mail do evento

Só código; nenhuma migration, nenhum e-mail novo na fila. A reserva de evento usa a mesma fila, reivindicação (idempotência), tentativas e reconciliação de sempre; só o **conteúdo** muda.

**Como o envio sabe que é evento.** Antes de montar a mensagem, os quatro envios — confirmação, lembrete do QR (individual e em lote) e reagendamento — passam o payload por `withEventEmailContext` (`lib/reservations/event-email-context.ts`), que lê `reservations.experience_id` → `experiences.kind` e `editorial_content` com a service role. As RPCs de payload não mudaram. Sem conseguir ler, lança `EVENT_CONTEXT_UNAVAILABLE` e o e-mail fica pendente para nova tentativa — nunca sai o genérico. Banco sem a coluna `kind`: regular, como antes.

**Conteúdo vindo do evento** (`lib/reservations/event-email.ts`): assunto "Ingresso confirmado — {evento} · {código}", nome completo, data, início, tolerância de chegada (só quando `event.arrival` combina com o horário da sessão), encerramento previsto (início + duração), participantes, ingresso único, QR Code de check-in, local e Google Maps, programação, o que levar (roupas confortáveis, água, protetor solar, tapete próprio para o Superioga), segurança (colete obrigatório), lanche, clima e a política de cancelamento do evento com o prazo (`event.cancellation`) — crédito ou reembolso. Nunca a política genérica "até 1 dia antes", a tolerância de 20 minutos nem a lista de remada. Horários sempre em `America/Sao_Paulo`.

| E-mail | Evento | Regular |
| --- | --- | --- |
| Confirmação | "Ingresso confirmado", conteúdo completo | igual |
| Lembrete do QR | "Seu ingresso está pronto", início/tolerância e QR | igual |
| Reagendamento | "Nova data confirmada", pagamento válido, programação; sem antecipar a política | igual |

**Conteúdo incompleto não vende e não envia.** `lib/events/email-readiness.ts` exige programação, `event.arrival`, `event.cancellation` e os textos confirmados `o-que-levar`, `seguranca`, `alimentacao` e `cancelamento`. Faltando algo: `POST /api/reservations` recusa a reserva do evento (`409 EVENT_EMAIL_NOT_READY`) mesmo com a venda aberta; um envio já na fila fica pendente (`EVENT_EMAIL_NOT_READY`), o lembrete é pulado e o reagendamento falha para nova tentativa.

**Prévia e demonstração** (`scripts/email/event-preview.ts`, só fixture, sem Supabase):

```bash
pnpm email:preview:evento
```

gera `.preview/evento-essencia-{confirmacao,lembrete-qr,reagendamento}.{html,txt}` e não envia nada. **Somente com autorização**, `pnpm email:preview:evento --enviar --confirmo` (com `RESEND_API_KEY` e `EMAIL_FROM` no ambiente) envia os três modelos **apenas** para o e-mail oficial da equipe, com "[DEMONSTRAÇÃO]" no assunto e chave de idempotência fixa.

**Antes de abrir a venda:** gerar a prévia e revisar; enviar a demonstração autorizada e conferir no Gmail (celular e computador); cadastrar o ESSÊNCIA com o `editorial_content` revisado; só então, com autorização, ligar as variáveis.

Testes: `tests/special-events-email.test.ts`.

## Fase 5C — lista de espera do evento

Não há segunda lista. O evento usa as tabelas, funções, fila, limites, auditoria e painel da lista de espera de sempre ([docs/waitlist.md](waitlist.md)), que já funcionam por sessão: `waitlist_join` aceita sessão `OPEN`, futura, de experiência `PUBLISHED` e com zero vagas; a varredura (`waitlist_scan`) lê `available_spots`; o aviso confere vaga e limites de novo antes de sair. Nada disso olha `experiences.kind`, e nenhuma migration é necessária para o evento caber nelas.

| Etapa | O que entrega | Estado |
| --- | --- | --- |
| 5C-1 | Interface pública, `EVENTS_WAITLIST_ENABLED` e escopo no servidor | Na `main` (#49), desligada |
| 5C-2 | Confirmação e aviso de vaga com textos de evento; link para a página do evento; aviso só com venda aberta; página de saída; trava da 5C-1 retirada | PR draft; migration `202610300001` não aplicada |
| 5C-3 | Agendador (detecção + envio), monitoramento, ativação e rollback | Aguarda autorização |

### 5C-1 — inscrição com escopo próprio

**Variável própria.** `EVENTS_WAITLIST_ENABLED=true` abre a lista **só dos eventos**, e só com a venda do evento aberta (`EVENT_BOOKING_OPEN` + `EVENTS_PUBLIC_ENABLED`). As variáveis da lista regular (`WAITLIST_PUBLIC_ENABLED`, `WAITLIST_SIGNUP_ENABLED`) continuam valendo só para as experiências regulares: uma não liga a outra. **Trava da 5C-1, retirada na 5C-2**: `EVENT_WAITLIST_EMAILS_READY` (`lib/events/flags.ts`) manteve a inscrição do evento fechada no código enquanto a confirmação e o aviso só existiam com o texto de "turma". Com os modelos do evento prontos (5C-2), ela passou a `true`; quem decide são as variáveis, todas ausentes em produção. Voltar a `false` fecha a inscrição do evento de novo.

**No servidor, antes do banco** (`lib/events/waitlist.ts`, chamado por `POST /api/waitlist`):

| Pedido | Resposta |
| --- | --- |
| Nenhuma das duas variáveis ligada | 404, sem tocar no banco (como antes) |
| Sessão regular com a lista regular desligada | 404, mesmo com a dos eventos ligada |
| Sessão de evento com a dos eventos desligada | 404, mesmo com a regular ligada e o id em mãos |
| Evento fora do site (despublicado, conteúdo inválido, ou sessão que não é a edição mostrada) | 409 `SESSION_UNAVAILABLE` |
| Tipo da sessão ilegível | 503, nunca inscrição às cegas |
| Mais participantes que `event.reservation.maxPerOrder` (6 no ESSÊNCIA) | 400 no campo quantidade |
| O resto | `waitlist_join` de sempre: limite de tentativas, isca, duplicidade, tetos, zero vagas (`NOT_SOLD_OUT` com vaga), grupo que caiba na capacidade (24) |

O tipo vem de `experiences.kind`, lido com a service role; a visibilidade, de `get_public_event` (a mesma leitura da página). Respostas com texto de evento ("evento", "ingresso"), nunca "turma".

**No site** (só com a variável ligada):

| Onde | O que muda |
| --- | --- |
| `/eventos/[slug]` esgotado | Na seção de reserva, botão **Entrar na lista de espera** e, ao lado, **Evento esgotado** — "Todas as vagas desta edição foram preenchidas. Entre para a lista de espera e seja avisado caso surja uma oportunidade." Hero e barra do celular dizem "Evento esgotado" e levam à seção. Sem a variável, o esgotado de sempre |
| `/reservar/[id]` do evento esgotado | O mesmo convite e o botão |
| `/lista-de-espera/[id]` do evento | Formulário de sempre com "Participantes" (até 6), textos de evento, cartão do evento e local; "Voltar para o evento". Com vaga, manda para o evento; fora do site, "lista de espera indisponível". Sessão regular nunca cai aqui, nem sessão de evento na tela regular |
| Prévia `/eventos/demonstracao/essencia?estado=SOLD_OUT&lista=1` | O botão, sem destino |

Saída da lista: o link de sempre (`/lista-de-espera#t=…`), com textos de evento a partir da 5C-2.

### 5C-2 — e-mails e saída da lista do evento

Mesma fila, mesma reivindicação exclusiva, mesma mensagem congelada antes do envio, mesma chave de idempotência por geração, mesmas 6 tentativas, mesmo ritmo (1 envio/s, lotes de 5), mesmas ondas e limites (3 avisos, 12 h). O que muda é **qual modelo** sai e **quando o aviso do evento pode ser reivindicado**.

**Tipo pelo banco, antes de montar.** Os dois serviços (`joined-email-service.ts`, `spot-email-service.ts`) passam o payload por `withWaitlistEventContext` (`lib/events/waitlist-email.ts`): `sessions.experience_id` → `experiences.kind`, conteúdo e base. Sessão de evento recebe o modelo do evento; regular, o de sempre (sem mudança de texto). Sem conseguir ler o tipo: `EVENT_CONTEXT_UNAVAILABLE`; conteúdo do evento inválido: `EVENT_EMAIL_NOT_READY` — nos dois casos o e-mail fica pendente para nova tentativa, **nunca** sai o modelo regular para inscrição de evento.

| E-mail | Assunto | Conteúdo |
| --- | --- | --- |
| Confirmação | "Você está na lista de espera — {evento}" | Evento, data, horário (05h30 às 09h00), local, participantes; **"Isto não é um ingresso"** (nem reserva garantida, sem cobrança); como funciona o aviso; link para sair |
| Aviso de vaga | "Surgiu uma vaga: {evento}" | Surgiu disponibilidade; evento, data, horário, local, participantes, ingresso por participante; **"A vaga não está garantida"** (a disponibilidade pode mudar até a conclusão da compra); botão **GARANTIR MEU INGRESSO** → `/eventos/<slug>#reserva`; como garantir; link para sair |

**O aviso do evento só é reivindicado com a venda aberta.** A rota de envio pede `claim_pending_waitlist_spot_emails_by_kind` com `REGULAR` e, só com `isEventsWaitlistEnabled()` (lista dos eventos + venda aberta + seção pública), também `EVENT`. Fechada a venda, o aviso do evento **não é tocado**: sem tentativa gasta, sem envio contado, continua `QUEUED`. Quando a venda abrir, a reivindicação confere de novo, como sempre: inscrição ativa, sessão aberta e futura, experiência publicada, abertura ainda aberta, vagas para o grupo inteiro (`waitlist_detection_spots`), 3 avisos e 12 h. Evento despublicado antes do envio: `SKIPPED` (`SESSION_UNAVAILABLE`), sem contar envio. As inscrições e avisos regulares seguem exatamente como antes (`REGULAR` é sempre pedido; a variável `WAITLIST_NOTIFY_ENABLED` continua sendo a da rota).

**Página de saída** (`/lista-de-espera#t=…`): a visão do link passa a vir de `waitlist_cancel_overview_with_kind`; para evento, "lista de espera deste evento", "participantes", "Nenhum ingresso ou pagamento é afetado" e "Voltar para o evento". Regular, os textos de sempre.

**Migration `202610300001_waitlist_event_scope.sql` (não aplicada).** Aditiva: duas funções novas, só para a service role; nenhuma função existente muda (teste compara o corpo de todas antes e depois), nada escreve em tabela, nenhum agendamento.

| Função | Faz |
| --- | --- |
| `waitlist_cancel_overview_with_kind(token, origem)` | Chama `waitlist_cancel_overview` (o limite de tentativas conta uma vez) e acrescenta `experienceKind` e, para evento, `experienceSlug` |
| `claim_pending_waitlist_spot_emails_by_kind(tipos, …)` | A reivindicação de sempre, filtrada pelos tipos pedidos; mesmo núcleo (`waitlist_spot_take`), mesma ordem da fila, mesmo `skip locked` |

Sem a migration o site continua funcionando: a página de saída volta à visão de sempre (fala "turma") e o envio volta à reivindicação de sempre — e aí um aviso de evento com a venda fechada é barrado no envio (`EVENT_SALES_CLOSED`, gasta uma tentativa). Por isso **a migration vem antes de ligar `EVENTS_WAITLIST_ENABLED`**.

Scripts: `supabase/diagnostics/waitlist_event_scope_preflight.sql` (`WAITLIST_EVENTOS_PREFLIGHT_OK`), `..._postcheck.sql` (`WAITLIST_EVENTOS_POSTCHECK_OK`, mesma assinatura e contagens), `supabase/rollback/202610300001_waitlist_event_scope.rollback.sql` (remove só as duas funções).

**Prévias** (só arquivos, sem envio): `pnpm email:preview:evento-lista` → `.preview/evento-essencia-lista-{confirmacao,aviso-de-vaga}.{html,txt}`.

### Ativação da lista do evento (cada passo com autorização)

1. Merge e deploy da 5C-2: nada muda (variáveis ausentes).
2. Correção do interruptor de publicação (PR próprio, ver "Interruptor da publicação") — obrigatória antes de abrir o ESSÊNCIA.
3. Preflight → migration `202610300001` (com `begin;` + `set local lock_timeout = '5s';` … `commit;`) → postcheck.
4. Cadastro do ESSÊNCIA e abertura da venda (`EVENTS_PUBLIC_ENABLED`, `EVENT_BOOKING_OPEN`), já autorizados à parte.
5. `EVENTS_WAITLIST_ENABLED=true` só em Production + deploy: botão e inscrição no evento esgotado, confirmação por e-mail.
6. Avisos de vaga automáticos: agendador e escopo do envio, na 5C-3.

Para desligar: remover `EVENTS_WAITLIST_ENABLED` e publicar (inscrição em 404, avisos do evento deixam de ser reivindicados e ficam na fila); ou voltar `EVENT_WAITLIST_EMAILS_READY` a `false` no código.

Testes: `tests/special-events-waitlist-email.test.ts` e, com sessões reais do Postgres (CI), a reivindicação por tipo em `tests/waitlist-spot-concurrency.test.ts`.

### Diagnóstico (29/10/2026)

Conferido no código da `main` (`2e57673`) e em produção, só leitura: inscrição pública desligada (`POST /api/waitlist` e `/lista-de-espera/<id>` respondem 404), rota de envio protegida (`/api/cron/waitlist-notifications` sem segredo responde 401: `CRON_SECRET` existe), painel atrás de login. Migrations da lista `202610250001`, `202610250002`, `202610260001` e `202610260002` aplicadas (registro da operação de 26–28/10); `detection_enabled` desligado e sem agendamento da lista naquela data — **reconferir no SQL Editor antes da 5C-3**:

```sql
select 'deteccao' as item, detection_enabled::text as valor from public.waitlist_settings
union all select 'agendamentos', coalesce(string_agg(jobname || '=' || active::text, ', '), 'nenhum') from cron.job where jobname ilike '%waitlist%'
union all select 'pg_net', coalesce((select extversion from pg_extension where extname = 'pg_net'), 'ausente')
union all select 'segredo_no_vault', count(*)::text from vault.secrets where name = 'waitlist_cron_secret'
union all select 'inscricoes_ativas', count(*)::text from public.waitlist_entries where status = 'ACTIVE';
```

Painel (`/admin/lista-de-espera`): já filtra por sessão, mostra experiência (o nome do evento), inscritos, quantidade, posição, avisos com tentativas e falhas, e remove com motivo. Funciona para o evento sem mudança; um selo "Evento" na lista de turmas fica como adaptação mínima opcional da 5C-2.

### Agendador (5C-3): recomendação

| Opção | Frequência real | Custo | Duplicidade | Desligar sem código | Veredito |
| --- | --- | --- | --- | --- | --- |
| **pg_cron (varredura) + pg_cron → pg_net → rota (envio), segredo no Vault** | 1 min | Incluso no Supabase; função Vercel só quando há aviso na fila | Varredura com advisory lock; fila com reivindicação `skip locked` e chave de idempotência | `cron.alter_job(active := false)` ou `detection_enabled = false` | **Recomendado** |
| Vercel Cron (`vercel.json`) | Diária no plano atual (os dois crons do projeto são diários) | Grátis; por minuto só no Pro | Rota já idempotente | Remover a entrada exige deploy | Impreciso demais para vaga que some em minutos |
| GitHub Actions agendado | 5–15 min, com atrasos | Grátis | Idem | Desativar o workflow | Pausa após 60 dias sem atividade; segredo fora da infraestrutura |
| Carona (`after()` em cancelamentos e no painel) | Só com tráfego | Só código | Idem | — | Não cobre pré-reserva vencida sem ninguém no site; só complemento |

O pg_cron já roda a expiração das pré-reservas a cada minuto em produção, e os scripts estão prontos e não aplicados (`supabase/maintenance/waitlist_scan_schedule.sql`, `waitlist_notify_schedule.sql`). Ponto de atenção para a 5C-3: **ligar a varredura é global** — ela olha toda sessão com inscrição ativa. Hoje só eventos poderiam ter inscrição (a lista regular segue desligada), mas, para a ativação dos eventos não depender disso, a 5C-3 deve acrescentar um escopo ao envio (por exemplo `WAITLIST_NOTIFY_SCOPE=EVENTS`), que a rota confere antes de enviar. Nenhum agendamento é criado sem autorização.

Testes: `tests/special-events-waitlist.test.ts`.

## Aplicação segura (quando autorizada)

No SQL Editor do Supabase, uma consulta por vez:

1. `supabase/diagnostics/special_events_foundation_preflight.sql` — somente leitura. A última linha, `EVENTOS_PREFLIGHT_OK`, precisa estar `OK`. Guarde `ASSINATURA_DAS_FUNCOES_EXISTENTES` e as contagens.
2. A migration, envolta à mão em `begin;` + `set local lock_timeout = '5s';` … `commit;`.
3. `supabase/diagnostics/special_events_foundation_postcheck.sql` — `EVENTOS_POSTCHECK_OK` precisa estar `OK`, com `FUNCOES_NOVAS_COM_A_DEFINICAO_DO_REPOSITORIO` = `13 de 13`, `INTERRUPTOR_DA_PUBLICACAO` = `desligado`, `LISTAGENS_REGULARES_SEM_PERDA` = `OK`, e assinatura e contagens iguais às do preflight.

Ordem de deploy: a migration pode ser aplicada antes ou depois de mergear este PR. O código desta fase só traduz mensagens de erro novas; sem a migration, elas nunca aparecem. Aplicar a migration não muda nada no site: ele continua lendo as listagens antigas e não há evento cadastrado.

## Rollback

`supabase/rollback/202610280001_special_events_foundation.rollback.sql` — fora de `supabase/migrations/`, para revisão. Remove as duas triggers, as treze funções, a tabela do interruptor e a coluna `kind`. **Recusa, sem alterar nada, se existir qualquer experiência `EVENT`**: sem a coluna, o evento viraria uma experiência comum em silêncio. Não toca reserva, sessão, pagamento, Stand-by, lista de espera nem função existente. Reaplicar a migration devolve tudo, com o interruptor desligado.

## Testes

- `tests/special-events-foundation.test.ts` (PGlite, todas as migrations): tipo e travas, criação e permissões, publicação bloqueada por todos os caminhos, listagens regulares iguais às atuais, situações públicas, capacidade de 12 com R$ 1.800, troca de turma e Stand-by (painel e cliente) bloqueados entre tipos e liberados dentro do mesmo tipo, lista de espera, duplicação, relatório sem dado pessoal, migration aditiva e idempotente, preflight, postcheck e rollback.
- `tests/special-events-concurrency.test.ts` (Postgres real, só no CI): 16 compras simultâneas de 1 vaga → exatamente 12; grupos de tamanhos diferentes nunca passam de 12; compra em curso faz a seguinte esperar e decidir com a ocupação atualizada.
