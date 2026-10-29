# Eventos especiais

[README](../README.md) · [Banco de dados](database.md) · [Stand-by](reservation-standby.md) · [Lista de espera](waitlist.md)

**Estado (29/10/2026): fases 2 e 3 na `main` e em produção** — PR #42 (squash `8aa7677`) e PR #43 (squash `34dec78`, deploy de produção às 23:17:55 UTC de 28/10). Migration `202610280001_special_events_foundation.sql` aplicada, com preflight e postcheck sem falhas nem pontos de atenção. **Fase 4 (páginas públicas) em PR draft, desligada** (`EVENTS_PUBLIC_ENABLED` ausente). Nenhum evento cadastrado nem publicado; o interruptor da publicação segue desligado.

## O que é

Eventos especiais são experiências realizadas em datas específicas, muitas vezes em parceria com outras marcas, com programação, preço e capacidade próprios. O primeiro é o **ESSÊNCIA — Corpo, Mente e Natureza** (07/11/2026, 05h30 às 09h, Cápsula Bar / Base Concha Acústica, 12 vagas, R$ 150 por pessoa, ingresso único).

**Não existe um segundo sistema de reservas.** Um evento é uma linha de `experiences` com `kind = 'EVENT'` e uma sessão por edição. Vagas, pré-reserva, pagamento pela InfinitePay, confirmação, e-mail, planilha, check-in, Stand-by e lista de espera são os de sempre.

## Fases

| Fase | O que entrega | Estado |
| --- | --- | --- |
| 2. Banco e segurança | `experiences.kind`, interruptor de publicação, trava entre tipos, leitura pública e funções do painel | Na `main` (#42); migration aplicada em produção (28/10), interruptor desligado |
| 3. Separação no site | Home, vitrine, agenda e base passam a usar as listagens regulares; opções de troca de turma filtradas por tipo | Na `main` e em produção (#43, 28/10); sem migration |
| 4. Páginas públicas | `/eventos`, `/eventos/[slug]`, destaque na home e item no menu, atrás de `EVENTS_PUBLIC_ENABLED` | PR draft; desligada; sem migration |
| 5. Reserva e e-mail | Textos da página de reserva e e-mail de confirmação de evento | — |
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

A de sempre: `create_pre_reservation` trava a sessão (`FOR UPDATE`) e soma confirmadas e pré-reservas válidas antes de aceitar. Para o ESSÊNCIA, a sessão tem `capacity = 12` e `price_cents = 15000`: no máximo 12 participantes e R$ 1.800 de receita bruta. O teste de concorrência prova, com 16 conexões reais comprando ao mesmo tempo, que exatamente 12 entram.

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
| Prazo de cancelamento | `cancellation.deadline = "2026-11-05T12:00:00-03:00"` (`= 2026-11-05T15:00:00Z`), `timeZone: "America/Sao_Paulo"` | Texto "Política de cancelamento" e, junto ao botão de reserva, "Cancelamento até 05/11/2026 às 12h00 (horário de Brasília): reembolso ou vaga na próxima edição", com link para a política completa |

O validador recusa prazo sem deslocamento, fuso diferente de `America/Sao_Paulo` e texto que diga outro dia ou hora que a regra — mudar uma sem a outra não passa. `arrivalMatchesSession` confere a chegada com a sessão cadastrada (início igual, tolerância entre o início e o fim).

**Prazo inclusivo** (`cancellationWindow`, `lib/events/policy.ts`): pedido até `2026-11-05T12:00:00.000-03:00`, inclusive, é `WITHIN_DEADLINE`; um milissegundo depois, `AFTER_DEADLINE` — análise da equipe, sem promessa automática.

**Nada é automático nesta fase**, e os fluxos existentes cobrem a política sem mudança:

- **Reembolso**: a equipe cancela pelo painel (`admin_cancel_reservation`, com motivo e auditoria) e devolve o valor fora da plataforma, como hoje. Nenhum reembolso é disparado pelo site.
- **Vaga na próxima edição**: o direito fica registrado com o **Stand-by** — a reserva paga sai da turma, mantém pagamento, valor e código, não ocupa vaga e não expira. Quando a próxima edição existir (`admin_duplicate_event`), a equipe ou o cliente escolhem a nova sessão; a trava de tipo permite evento → evento, e a régua de mesmo valor por pessoa vale como sempre (edição com outro preço exige tratamento manual). Nenhuma reserva nova é criada sozinha.
- **Clima**: reagendar o evento é mudar a data da sessão pelo painel; o aviso aos participantes é feito pela organização (não há e-mail automático de mudança de data).
- **Antes da confirmação**: a política fica visível na página do evento, ao lado do botão. Na fase 5, a página de reserva e o e-mail de confirmação do evento devem repetir o prazo a partir do mesmo `cancellation`.

### Pendente antes de publicar

- Confirmação dos parceiros quanto ao uso dos logos; logo do Rapha Dantas, se houver.
- Fase 5: botão de reserva (`EVENT_BOOKING_OPEN`), política na página de reserva e e-mail de evento.
- **Fase 5, obrigatório antes de vender**: o e-mail de confirmação atual (`lib/reservations/confirmation-email.ts`) vale para qualquer base e traria a uma reserva do ESSÊNCIA textos de remada que contradizem o evento — "cancelamento até 1 dia antes" (`CANCELLATION_NOTE`) e "roupa de banho"/"chinelo" (`PREPARATION_ITEMS`). A tolerância de 20 minutos (`MEETING_TOLERANCE_NOTE`) coincide com 05h50. O e-mail de evento deve usar `event.cancellation`, `event.arrival` e os textos de `info.items`. Hoje nada disso chega a cliente: a reserva do evento não está aberta.
- O slug `demonstracao` fica reservado para a prévia: um evento com esse slug não teria página.

### Como revisar no Preview

O Preview usa o banco de produção. A prévia **não lê nem grava nada**: abra `/eventos/demonstracao` e `/eventos/demonstracao/essencia` (com `?estado=SOLD_OUT`, `CLOSED`, `ENDED` ou `?vazio=1`). Não ligue `EVENTS_PUBLIC_ENABLED` nem o interruptor do banco para revisar.

Capturas em `docs/screenshots/eventos-especiais/`. Testes: `tests/special-events-public.test.ts`.

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
