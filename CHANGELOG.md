# Changelog

## Eventos especiais — reservas e pagamentos (etapa 5A, desligada)

- **Nada muda em produção ao publicar este código**: a venda de eventos só abre com `EVENT_BOOKING_OPEN=true` e `EVENTS_PUBLIC_ENABLED=true`, ambas ausentes. Sem migration. Detalhes em [docs/special-events.md](docs/special-events.md#fase-5a--reservas-e-pagamentos-do-evento).
- **Bloqueio no servidor**: com a venda fechada, `POST /api/reservations` recusa sessão de evento antes de bloquear vaga (`EVENT_BOOKING_CLOSED`), mesmo com o id da sessão. Experiência regular segue igual.
- **Até 6 participantes por pedido** no ESSÊNCIA (`event.reservation.maxPerOrder`), no servidor e no formulário; capacidade de 12 e preço de R$ 150 continuam decididos pelo banco.
- **Textos de ingresso** em `/reservar`, resumo, pré-reserva e retorno do pagamento; política de cancelamento antes do pagamento; volta para `/eventos/[slug]`.
- InfinitePay, webhook, reconciliação, confirmação, planilha e check-in não foram alterados.

## Eventos especiais — páginas públicas e ESSÊNCIA (fase 4, concluída e desligada)

- **Concluída em 29/10/2026** (PR #44, `56dbc47`): na `main` e em produção com `EVENTS_PUBLIC_ENABLED` ausente e a publicação desligada no banco. Próxima etapa: fase 5, sob autorização.

- **Nada muda em produção ao publicar este código**: tudo atrás de `EVENTS_PUBLIC_ENABLED`, ausente. Desligada, `/eventos` e `/eventos/[slug]` respondem 404 e o menu e a home ficam como estão. Sem migration. Detalhes em [docs/special-events.md](docs/special-events.md#fase-4--páginas-públicas).
- **`/eventos`**: Hero da seção, próximos eventos, edições anteriores e estado vazio. **`/eventos/[slug]`**: modelo reutilizável com Hero, apresentação, programação em linha do tempo, incluso, parceiros, local, informações importantes e reserva, tudo vindo de `editorial_content` validado (`lib/events/editorial.ts`). CTA fixo no celular.
- **Item "Eventos" no menu e destaque na home** só com a seção ligada e evento publicado. `/experiencias/[slug]` de um evento leva à página do evento.
- **Botão "Garantir minha vaga" sem checkout** nesta fase (`EVENT_BOOKING_OPEN = false`), respeitando vagas, esgotado, encerrado e realizado.
- **Prévia com o ESSÊNCIA de demonstração** em `/eventos/demonstracao`, só no desenvolvimento e no Preview, sem banco, `noindex`. Fotos reais do repositório e do Cápsula Bar; logos fornecidos; informações operacionais pendentes só na prévia.
- **Informações operacionais definitivas do ESSÊNCIA**: chegada às 05h30 com tolerância até 05h50, o que levar (materiais de Superioga fornecidos pela equipe), experiência, segurança, alimentação, clima e cancelamento até 05/11/2026 às 12h00 de Brasília (`2026-11-05T12:00:00-03:00`, inclusivo) com escolha entre crédito para outras experiências da Alma Azul (implementado na fase 5) ou reembolso pedido pelo WhatsApp e devolvido manualmente, configuráveis em `editorial_content` e conferidos contra os textos. Nada automático nesta fase.
- Reservas, pagamentos, e-mails, planilha, Stand-by, lista de espera e check-in não foram alterados.

## Eventos especiais — separação no site (fase 3)

- **Sem migration e sem mudança visível hoje**: não há evento publicado e o interruptor da publicação segue desligado. Detalhes em [docs/special-events.md](docs/special-events.md#fase-3--separação-no-site).
- **Áreas regulares só com a agenda regular**: home, vitrine, agenda, bases e sitemap leem `list_public_regular_experiences` e `list_public_regular_catalog`; a landing `/experiencias/[slug]` não mostra um evento publicado. As funções antigas do banco não mudaram.
- **Turmas de destino do mesmo tipo**: troca de turma do painel, Stand-by do painel e autoatendimento do cliente só oferecem sessões do mesmo tipo da reserva. Preço, vagas e autorização seguem nas RPCs; a trava `EVENT_KIND_MISMATCH` continua no banco.
- Reservas, InfinitePay, e-mails, lista de espera, check-in, planilha e relatórios não foram alterados.

## Eventos especiais — banco e segurança (fase 2)

- **Nada muda em produção ao publicar este código.** A migration `202610280001` (aplicada em 28/10, postcheck OK) só cria estrutura; nenhum evento é cadastrado e o site ainda não lê nada de eventos. O código só traduz três mensagens de erro novas. Detalhes em [docs/special-events.md](docs/special-events.md).
- **Evento = experiência `kind = 'EVENT'`** com uma sessão por edição, sobre o motor de reservas de sempre (vagas, pré-reserva, InfinitePay, confirmação, planilha, check-in, Stand-by e lista de espera). Toda experiência existente fica `REGULAR` pelo default da coluna, sem reescrever linha.
- **Publicação travada**: interruptor `special_event_settings.publication_enabled`, desligado. Nenhum caminho publica um evento antes de o site separar as listagens (fase 3).
- **Nenhuma reserva troca de tipo**: uma trigger em `reservations.session_id` recusa troca de turma, Stand-by pelo painel e autoatendimento entre evento e agenda regular (`EVENT_KIND_MISMATCH`), sem reescrever essas funções.
- **Leitura pública nova** (`list_public_events`, `get_public_event`, `list_public_event_sessions`) com a situação de cada sessão, e versões da vitrine e do catálogo só com a agenda regular. As listagens atuais ficam intactas.
- **Painel**: criar (rascunho, sessão fechada), editar, duplicar, listar e relatório por evento, só para ADMIN e OPERATOR, reaproveitando as RPCs de experiência e de sessão.
- Testes em PGlite e de concorrência com Postgres real (16 compras simultâneas → exatamente 12 vagas). Preflight, postcheck e rollback em `supabase/diagnostics/` e `supabase/rollback/`.

## Lista de espera — envio automático dos avisos de vaga (fase 6 de 7, desligado e sem agendamento)

- **Nada muda em produção ao publicar este código.** O envio só existe com a migration `202610260002`, **não aplicada**, e `WAITLIST_NOTIFY_ENABLED=true`; só há aviso a enviar com a detecção da fase 5 ligada; e nenhum agendamento chama a rota. Detalhes em [docs/waitlist.md](docs/waitlist.md#fase-6--envio-automático-dos-avisos-de-vaga).
- **O aviso**: "Abriu vaga", com a turma, quantas pessoas a inscrição pediu, o valor e o botão **Reservar esta turma** (`/reservar/<turma>`, o fluxo normal). Em destaque, **a vaga não está garantida**: a lista não reserva nem bloqueia (opção A), e a reserva só é confirmada com o pagamento aprovado. Link para sair da lista.
- **Conferido de novo antes de cada envio**: inscrição ativa; turma aberta, publicada e futura; abertura aberta; vagas (`available_spots`, descontadas as pré-reservas a caminho do pagamento) para o grupo inteiro; 3 avisos no máximo e 12 h entre eles. Falhou, o aviso é descartado com o motivo. O envio é que conta para os limites, uma vez por aviso.
- **Mesma fila da confirmação**: reivindicação exclusiva, mensagem congelada, chave de idempotência por geração, resultado desconhecido nunca tratado como "não enviado", `UNCERTAIN` em conflito ou janela vencida, seis tentativas. Duas execuções ao mesmo tempo nunca enviam o mesmo aviso.
- **Rota `/api/cron/waitlist-notifications`**, protegida pelo `CRON_SECRET` (503 sem ele, 401 errado), só contadores na resposta. `vercel.json` não mudou.
- **Agendamento proposto (D1), não aplicado**: pg_cron + `pg_net` + Vault, a cada minuto, chamando a rota só com aviso pendente. Custos, riscos e alternativas no documento; script em `supabase/maintenance/waitlist_notify_schedule.sql`.
- Migration: cinco funções, nada para `anon` ou `authenticated`; não cria tabela nem trigger, não muda função existente. Preflight, postcheck e rollback em `supabase/diagnostics/` e `supabase/rollback/`. Reservas, pagamento, cancelamento e Stand-by **não foram alterados**.

## Lista de espera — detecção automática de vagas (fase 5 de 7, desligada e sem agendamento)

- **Nada muda em produção ao publicar este código**: a fase não tem código de aplicação. A migration `202610260001`, **não aplicada**, nasce com a detecção desligada (`waitlist_settings.detection_enabled = false`), e o agendamento no pg_cron é um script à parte, também não aplicado. Detalhes em [docs/waitlist.md](docs/waitlist.md#fase-5--detecção-automática-de-vagas).
- **`waitlist_scan()`**: uma execução por vez; encerra inscrições de turmas passadas e marca as que viraram reserva; turma a turma, abre uma abertura quando aparece vaga (`available_spots`, a fonte oficial), fecha quando some (descartando os avisos parados) e enfileira ondas pela régua aprovada — `greatest(5, 3 × vagas)`, ordem da fila, só quem cabe, 12 h e 3 avisos no máximo, um aviso por inscrição e abertura.
- **Sem vaga falsa**: a pré-reserva com checkout que venceu mas ainda não entrou na janela de pagamento é descontada, só na leitura; a primeira onda espera 2 min de carência; ondas seguintes, 30 min.
- **Nada é enviado**: os avisos (`SPOT_AVAILABLE`) ficam na fila; o envio da fase 3 só pega a confirmação da inscrição. A fase 6 decide o envio — alternativas e recomendação (pg_cron + pg_net) no documento.
- **Não interfere em reservas**: só lê `sessions` e `reservations`; turma presa em outra transação é pulada em 2 s. Testado com sessões reais do Postgres no CI.
- Migration: uma tabela, uma coluna, três funções, nada pela API; não substitui função nem cria trigger em tabela existente. Preflight, postcheck, rollback, relatório só leitura e scripts de agendamento em `supabase/diagnostics/`, `supabase/rollback/` e `supabase/maintenance/`.

## Lista de espera — painel administrativo (fase 4 de 7, desligado por padrão)

- **Nada muda em produção ao publicar este código.** O painel só existe com `WAITLIST_ADMIN_ENABLED=true`; sem a variável não há menu, e `/admin/lista-de-espera` e a rota de remoção respondem 404. **Sem migration**: usa as RPCs administrativas da fase 1, já aplicadas. Detalhes em [docs/waitlist.md](docs/waitlist.md#fase-4--painel-administrativo).
- **Turmas com lista de espera**: experiência, base, data e horário, capacidade, vagas agora e interessados (inscrições e pessoas), com filtros por experiência, base, data e turmas passadas.
- **Inscrições**: nome, e-mail, WhatsApp, pessoas, posição na fila, data e status, com filtros por turma, base, status e busca, e **paginação no banco**.
- **Histórico** de cada inscrição: e-mails com cada tentativa e motivo de não envio, e as ações da equipe da auditoria.
- **Remover** inscrição ativa, com motivo obrigatório e confirmação; o banco descarta o e-mail pendente e audita, sem dado pessoal nos metadados.
- Só ADMIN e OPERATOR (`requireAdmin`, `authorizeWaitlistAdminApi`, `is_active_admin` nas RPCs); instrutor recebe 403; origem conferida na remoção; nenhum log com dado pessoal. Reservas, pagamento, cancelamento e Stand-by **não foram alterados**.

## Lista de espera — inscrição gratuita e confirmação por e-mail (fase 3 de 7, desligada por padrão)

- **Nada muda em produção ao publicar este código.** A inscrição só existe com a migration `202610250002` aplicada **e** `WAITLIST_SIGNUP_ENABLED=true` junto com `WAITLIST_PUBLIC_ENABLED=true`. Sem elas, não há botão, `/lista-de-espera/<turma>` e `POST /api/waitlist` respondem 404. Detalhes em [docs/waitlist.md](docs/waitlist.md#fase-3--inscrição-gratuita-confirmação-e-saída-pelo-link).
- **Botão "Entrar na lista de espera"** no aviso de turma esgotada (grade, agenda, `/reservar` e formulário que esgotou). **Formulário** com nome, WhatsApp, e-mail e quantidade, avisando antes do envio que não há pagamento nem reserva. Mesma resposta para quem já estava inscrito.
- **E-mail de confirmação** pela infraestrutura existente (Resend), com o destaque "Isto não é uma reserva — nenhuma vaga reservada, nenhuma cobrança", a regra da opção A e o link **Sair da lista de espera** (`/lista-de-espera#t=<token>`, token no fragmento, saída em dois passos).
- **Fila com o protocolo do e-mail de reagendamento**: reivindicação exclusiva, mensagem congelada antes do envio, chave de idempotência por geração, resultado desconhecido nunca tratado como "não enviado", `UNCERTAIN` em conflito ou janela vencida, descarte de inscrição encerrada ou turma iniciada, seis tentativas com espera crescente. Envio depois da resposta, com duas novas tentativas em segundo plano, e recuperação na rotina diária que já existe. `vercel.json` não mudou.
- **Contra abuso**: recurso ligado, origem do site, formato e o limite do banco (por origem e por e-mail), campo isca, tetos e duplicidade da fase 1; só POST, sem cache e sem dado pessoal nas respostas.
- Migration `202610250002_waitlist_signup_email.sql`, **não aplicada**: três colunas e oito funções; não substitui função, não cria trigger, não toca linha. Preflight, postcheck e rollback em `supabase/diagnostics/waitlist_signup_email_*.sql` e `supabase/rollback/`.
- Os e-mails de pagamento e de reagendamento são os mesmos: `confirmation-email.ts` só passou a exportar a moldura que já usava. Reservas, checkout, pagamento, cancelamento e Stand-by **não foram alterados**.

## Lista de espera — turmas esgotadas no site (fase 2 de 7, desligada por padrão)

- **Nada muda para o cliente ao publicar este código.** Com `WAITLIST_PUBLIC_ENABLED` ausente, agenda, grade e destaque de horários continuam lendo `list_open_sessions`. Detalhes em [docs/waitlist.md](docs/waitlist.md#fase-2--turmas-esgotadas-no-site).
- **Com a variável ligada**, turmas publicadas e esgotadas aparecem na página da experiência, no filtro por data, no destaque de horários e na agenda geral, com o selo **Esgotado** e sem link de reserva. `/reservar/<id>` de turma esgotada mostra "Turma esgotada" em vez do formulário. A fonte é `list_public_sessions` (fase 1); sem ela no banco, o site volta para as turmas com vaga.
- **Formulário nunca sem vaga**: a página confere as vagas antes de mostrá-lo e as opções de quantidade vão de 1 às vagas restantes. Se a turma esgotar enquanto o cliente preenche, a recusa do banco troca o formulário pelo aviso (variável ligada); se sobrar menos vaga, a quantidade é reduzida.
- `POST /api/reservations`: a recusa 409 ganha `code` e, por falta de vaga, `remainingSpots` (lidos por `get_booking_session`, antes de qualquer checkout). A mensagem não muda.
- Lugar do futuro botão "Entrar na lista de espera" preparado e vazio: nenhuma inscrição, e-mail ou agendamento.
- Sem migration. `list_open_sessions`, `get_booking_session`, `available_spots`, `create_pre_reservation`, pagamento, cancelamento e Stand-by **não foram alterados**.

## Lista de espera — fundação no banco (fase 1 de 7, nada ligado)

- **Nada muda em produção ao publicar este código**, nem ao aplicar a migration: nenhuma rota, tela, rotina ou e-mail usa a lista ainda. Detalhes, regras aprovadas (D1 a D6) e fases em [docs/waitlist.md](docs/waitlist.md).
- **`list_public_sessions(slug)`**: as mesmas turmas de `list_open_sessions` mais as esgotadas, com `sold_out`, para a fase 2 mostrar "Esgotado". Só exibição: `list_open_sessions`, `get_booking_session` e `create_pre_reservation` não mudam, e uma turma esgotada continua sem poder ser reservada.
- **Inscrição** (`waitlist_join`) só em turma com zero vagas, uma ativa por e-mail e turma, grupo de 1 a 20 que caiba na turma, teto de 10 inscrições ativas por e-mail (só turmas que ainda não começaram) e 100 por turma, campo isca e resposta idêntica para quem já estava inscrito. A confirmação nasce na fila na mesma transação e **não é enviada**. A lista não reserva, não bloqueia vaga e não escreve em reservas (opção A).
- **Cancelamento pelo link** em dois passos (ver e cancelar), idempotente, sem dado pessoal na resposta. O token é um HMAC recalculável; o banco guarda só o hash.
- **Limite de tentativas próprio no banco**: inscrição 30 por origem e 6 por e-mail a cada hora; link 30 por origem a cada 15 minutos. Baldes em HMAC.
- **Painel (funções, sem tela ainda)**: turmas com inscrições, lista paginada na ordem da fila com posição, detalhe com avisos e auditoria, remoção com motivo. Só ADMIN e OPERATOR.
- **Preparado, sem uso**: aberturas de vaga, fila de avisos e tentativas, régua das ondas (`max(5, 3 × vagas)`, no máximo 3 avisos e 12 horas entre eles), expiração, conversão e anonimização em 90 dias. Nada é agendado.
- Migration `202610250001_waitlist_foundation.sql`, **não aplicada**: seis tabelas (RLS ligada e nenhum acesso pela API, nem da service role) e dezoito funções. Não substitui o corpo de nenhuma função, não cria trigger em tabela existente e não toca nenhuma linha. Preflight, postcheck e rollback em `supabase/diagnostics/waitlist_foundation_*.sql` e `supabase/rollback/`; o rollback recusa enquanto houver inscrição ativa.
- Reservas, checkout, pagamento, cancelamento, Stand-by, e-mails, planilha e painel **não foram alterados**.

## Stand-by de reservas — autoatendimento do cliente (etapa 5 de 6, desligado por padrão)

- **Nada muda em produção ao publicar este código.** Ao aplicar a migration `202610160001`, uma coisa muda, de propósito: a consulta pública da reserva passa a ter limite de tentativas. O autoatendimento só existe com a migration aplicada **e** `STANDBY_SELF_SERVICE_ENABLED=true`. Sem a variável, as rotas respondem 404 e `/acompanhar-reserva` continua mandando o cliente em Stand-by para a equipe. Detalhes em [docs/reservation-standby.md](docs/reservation-standby.md#autoatendimento-do-cliente).
- **O cliente escolhe a nova data pelo site**, com CPF + código (botão **Escolher nova data** na consulta) ou pelo link individual (`/acompanhar-reserva#r=<token>`), entre turmas futuras, abertas e publicadas de qualquer base, com vagas para o grupo inteiro e o **mesmo valor por participante** pago. Sem prazo e sem antecedência mínima além de a turma não ter começado. Código, QR, quantidade e pagamento continuam os mesmos.
- **A decisão é do banco**, pelas RPCs da etapa 2 (`customer_reschedule_options` e `customer_reschedule_reservation`, inalteradas): a reserva, a autorização e a turma são travadas, a última vaga não é ocupada duas vezes, a autorização vale uma vez, o histórico e a auditoria registram o cliente e a forma de acesso, e a trigger da etapa 4 enfileira o e-mail na mesma transação. A rota chama o mesmo envio e a mesma sincronização da planilha da rota do painel.
- **Mensagens próprias** para nenhuma turma disponível, vagas que acabaram durante a escolha, turma indisponível, reserva já reagendada (com a turma atual), cancelada e link substituído. Credencial errada recebe uma mensagem genérica, sem confirmar que a reserva existe.
- **Limite de tentativas no banco**, compartilhado entre as instâncias e entre as três rotas que aceitam CPF + código ou o link — **inclusive a consulta pública da reserva**: 30 por origem e 10 por código de reserva (ou token) a cada 15 minutos, contando toda tentativa, sem revelar se o código existe. Baldes guardados como HMAC com segredo próprio, em tabelas sem acesso nem da service role. Sem o limite funcionando, o autoatendimento responde "indisponível"; a consulta pública segue como era.
- **Origem só de fonte confiável:** o endereço do cliente é lido apenas na Vercel, de `x-vercel-forwarded-for`/`x-real-ip` (reescritos pela plataforma), só como IP literal e com IPv6 agrupado por /64. Fora da Vercel nenhum cabeçalho é lido, e sem endereço confiável vale só o limite da credencial — nunca um balde comum a todos.
- **Rotas** `POST /api/reservations/standby` e `POST /api/reservations/standby/reschedule`: recurso ligado, origem do próprio site, formato e limite antes de qualquer consulta; credencial só no corpo; respostas sem cache e sem CPF, telefone, e-mail, sobrenome, token ou id da reserva.
- Migration `202610160001_reservation_standby_self_service.sql`, **não aplicada**: duas tabelas novas (limite e segredo) e duas funções (`register_customer_access_attempt`, `customer_reschedule_overview`). Ao ser aplicada, liga o limite na consulta pública. Não substitui o corpo de nenhuma função, não trava tabela existente e não toca nenhuma linha. Preflight, postcheck e rollback em `supabase/diagnostics/reservation_standby_self_service_*.sql` e `supabase/rollback/`.
- Painel: o modal do link e a mensagem preparada para o WhatsApp dizem "escolher a nova data" quando o autoatendimento está ligado.
- **Consulta pública** (`/api/reservations/lookup`): com a migration aplicada, responde 429 com `Retry-After` a quem passar do limite; o resto do contrato não muda. O log de falha passa a registrar só um símbolo, nunca a mensagem do banco. Antes da migration, funciona exatamente como hoje.
- Pagamento, checkout, check-in, QR, reagendamento tradicional, planilha e métricas **não foram alterados**.

## Stand-by de reservas — e-mail de confirmação do reagendamento (etapa 4 de 6, desligado por padrão)

- **Nada muda em produção ao publicar este código.** O e-mail só sai com a migration `202610150001` aplicada **e** `STANDBY_RESCHEDULE_EMAIL_ENABLED=true`. Sem a variável, o serviço responde "desligado" antes de tocar no banco ou no provedor. Detalhes em [docs/reservation-standby.md](docs/reservation-standby.md#e-mail-de-reagendamento).
- **Quando uma reserva em Stand-by é reagendada, o cliente recebe um e-mail de confirmação** com a turma nova: nome, código original, experiência, data e horário, base, endereço e link do mapa, participantes, o mesmo QR Code e o aviso de que o pagamento continua válido. Vale para o reagendamento pelo painel e, na etapa 5, pelo cliente.
- **Não enviam e-mail:** colocar em Stand-by, gerar ou revogar link, desfazer o Stand-by e o reagendamento tradicional ("Alterar turma"). O e-mail de confirmação de pagamento não é reenviado em nenhum caso.
- **O envio nasce no banco.** Uma trigger grava a linha da fila na mesma transação que reagenda a reserva: um evento por reagendamento efetivo, nenhum quando a transação falha, nenhum na requisição repetida.
- **Fila própria** (`reservation_reschedule_emails`), separada da do e-mail de pagamento: reivindicação exclusiva com prazo, seis tentativas automáticas com espera crescente, registro de cada tentativa com o código do erro, e descarte do e-mail que já não descreve a reserva (cancelada, de volta ao Stand-by, em outra turma, ou turma já iniciada).
- **Idempotência no Resend, sem tratar o desconhecido como "não enviado":** cada falha é classificada como recusa comprovada, resultado desconhecido ou chave recusada. Enquanto há resultado desconhecido, toda nova tentativa repete a mesma chave e a mesma mensagem — gravada no banco antes do envio — e o provedor não entrega de novo, mesmo que o template ou o cadastro tenham mudado. Chave nova só com recusa comprovada, destinatário ou dados da turma alterados, ou decisão de uma pessoa. Passada a janela da chave, a fila para em "entrega não confirmada" em vez de reenviar às cegas. O e-mail de pagamento continua sendo enviado sem o cabeçalho, e o cliente do Resend continua lendo só o status da resposta de erro.
- **Recuperação de falhas, sem esperar o dia seguinte:** mais duas tentativas na própria requisição, em segundo plano (3 s e 15 s); a fila é acionada sempre que o painel de Stand-by é aberto; carona no próximo envio bem-sucedido; a rotina diária que já existe; e o botão **Reenviar e-mail de reagendamento**. Uma falha de envio nunca desfaz o reagendamento. `vercel.json` não mudou: a rota `/api/cron/reschedule-emails` existe para um agendamento mais frequente, que depende de aprovação.
- **Concorrência:** a reivindicação trava a reserva antes da linha da fila — cancelamento, volta ao Stand-by e troca de turma em andamento são esperados, não atropelados — e uma transação presa não segura a fila. Testado com sessões independentes do Postgres, em um contêiner efêmero do CI.
- **Painel:** o modal de reagendamento diz se o cliente será notificado; se o e-mail não sair, o aviso vira alerta. O detalhe da reserva mostra, no topo, quando o cliente ainda não recebeu a confirmação, e `/admin/stand-by` lista quem está nessa situação, a turma mais próxima primeiro.
- Migration `202610150001_reservation_reschedule_email.sql`, **não aplicada**: duas tabelas, uma trigger em `reservation_session_changes` e treze funções. Não substitui o corpo de nenhuma função existente, não toca nenhuma linha e não mexe em `integration_sync_jobs`. Preflight, postcheck, relatório da fila e rollback em `supabase/diagnostics/reservation_reschedule_email_*.sql` e `supabase/rollback/`.
- Fluxo de reservas, pagamento, QR, check-in, histórico de reagendamento, planilha e métricas **não foram alterados**.

## Stand-by de reservas — painel administrativo (etapa 3 de 6, desligado por padrão)

- **Nada muda em produção ao publicar este código.** O painel de Stand-by só existe com `STANDBY_ADMIN_ENABLED=true` no ambiente; sem a variável não há menu, botão, página nem rota. Detalhes em [docs/reservation-standby.md](docs/reservation-standby.md#painel-administrativo).
- **Colocar em Stand-by** nas reservas confirmadas e pagas, na listagem e no detalhe: confirmação com cliente, código, experiência, turma original, participantes e valor pago, motivo obrigatório, aviso de que as vagas são liberadas e confirmação explícita. Reserva com presença parcial ou completa é bloqueada; sessão passada sem presença entra.
- **Nova área `/admin/stand-by`**: lista "aguardando reagendamento" com busca (nome, código, telefone), filtros por base original e por link, totais e paginação feita no banco — sem o teto de 500 da função anterior.
- **Reagendar** para turma futura, aberta, publicada, com vagas para o grupo e **preço por participante exatamente igual ao pago**, em qualquer base. A régua é do banco (`admin_reschedule_standby_same_price`), com reserva e sessão travadas. **Desfazer Stand-by** só com a turma original aberta, futura e com vagas. **Gerar** e **revogar link** individual: o link aparece uma única vez, para o admin copiar e compartilhar, e não é registrado em log, auditoria ou histórico.
- **Auditoria** no detalhe da reserva: quem colocou, motivo, data, reagendamento, desfazimento e geração/revogação de link — sem token nem hash.
- **Planilha — proteção permanente das 14 sessões históricas:** as sessões anteriores a 19/08/2026 mantidas fora da planilha passam a ser identificadas pelo `session_id` completo, e nenhuma sincronização lê ou escreve nada por causa delas — pagamento, webhook repetido, reconciliação, cancelamento, Stand-by, reagendamento do Stand-by ou tradicional, botões manuais ou job pendente. Nenhuma pode ser reconstruída nem receber linha nova; nas duas parcialmente presentes, as linhas existentes também não são reescritas. A proteção fica no serviço central, não nas rotas, sem regra por data ou prefixo. Os 14 ids vieram do Supabase de produção e estão em [docs/incident-2026-10-google-sheets-grid-limit.md](docs/incident-2026-10-google-sheets-grid-limit.md).
- **Planilha — modo "somente atualizar":** uma sincronização que parte da turma de origem de um Stand-by atualiza a turma se ela já estiver na planilha e não escreve nada se não estiver. Cobre entrada em Stand-by, reagendamento, cancelamento de reserva em Stand-by, os dois botões manuais e jobs pendentes retomados depois. A confirmação de pagamento não consulta `reservation_standby`. A estrutura das abas não mudou.
- Migration `202610140001_reservation_standby_admin_panel.sql`, **não aplicada**: cria quatro funções e retira da service role a execução de `admin_reschedule_reservation_from_standby` (o reagendamento de Stand-by sem regra de preço), para o servidor só alcançar o que exige o mesmo valor. Não toca tabela, linha nem o corpo de nenhuma função existente. Preflight, postcheck e rollback em `supabase/diagnostics/reservation_standby_admin_panel_*.sql` e `supabase/rollback/`; os diagnósticos têm três estados (`OK`, `ATENCAO`, `FALHOU`) e não reprovam diferença só de formatação.
- O reagendamento tradicional ("Alterar turma"), o fluxo de pagamento, a ocupação, o QR, o histórico e as métricas **não foram alterados**. Nenhum e-mail é enviado pelas ações de Stand-by (etapa 4). O autoatendimento do cliente continua para a etapa 5.

## Stand-by de reservas — fundação (etapa 2 de 6, ainda inativa)

- Novo status `AWAITING_RESCHEDULE` ("Aguardando reagendamento"): reserva paga que saiu da turma original e ainda não tem nova data. Não ocupa vaga e não é cancelamento, expiração nem pagamento pendente. Detalhes em [docs/reservation-standby.md](docs/reservation-standby.md).
- **Nada muda em produção com este código.** Nenhuma tela coloca reserva em Stand-by, e as migrations não foram aplicadas. Mergear não aplica migration; aplicar a migration não ativa o Stand-by.
- Migrations `202610130001_reservation_status_awaiting_reschedule.sql` (só o valor do enum) e `202610130002_reservation_standby.sql` (tabela `reservation_standby`, travas e RPCs), aditivas e idempotentes. Preflight, postcheck e rollback em `supabase/diagnostics/reservation_standby_*.sql` e `supabase/rollback/`.
- **Proteção financeira:** webhook repetido, retorno do pagamento, "Verificar pagamento", reconciliação e confirmação manual não reconfirmam uma reserva em Stand-by nem gravam evento. Segunda camada no banco: a trigger `reservations_standby_guard` só deixa a reserva voltar a confirmada pelas operações de Stand-by.
- Operações transacionais para colocar em Stand-by, desfazer e reagendar (pelo admin ou pelo cliente), com autorização de uso único, repetição idempotente e link individual guardado só como hash. Regra do cliente: mesma quantidade e mesmo valor por participante.
- Receita: reservas em Stand-by continuam somadas no faturamento e saem de participantes e ocupação. Novo indicador `awaitingReschedule` nos dois dashboards.
- Leitura do status no painel, na página pública e na planilha, para ele nunca aparecer como expirada ou cancelada.
- `admin_change_reservation_session` (reagendamento tradicional), `available_spots`, check-in, QR e e-mail **não foram alterados**.

## Correção: texto do percurso da Rota Ermida Ponte JK

- A remada não chega à Ponte JK: o grupo rema até a prainha da Ermida Dom Bosco, para para um banho, e vê a ponte durante quase todo o trajeto e na parada. Card, resumo e landing diziam "pela Ponte JK".
- Migration `202610120002_rota_ermida_texto.sql`: só texto, só nesta rota, e só onde o texto ainda é o anterior (edições do painel são mantidas).

## Rotas da Base Cápsula Bar: Rota Ermida Ponte JK e Rota Prainha do Congresso

- O agrupamento "Caminhos do Paranoá" deixa de existir no site. As duas rotas passam a ser experiências independentes, com nome, card, página e sessões próprios: **Rota Ermida Ponte JK** e **Rota Prainha do Congresso**.
- Página da base: um card por rota, com link individual e selo vindo do status de cada experiência ("Em breve" some sozinho quando a rota é ativada). A seção "Caminhos do Paranoá", com selos fixos, foi removida.
- Migration `202610120001_rotas_capsula_bar.sql` (aditiva e idempotente): troca slug, modality e título nos **mesmos registros** e preenche a landing das duas rotas onde ela ainda está vazia. Não muda status, preço, duração nem capacidade, não cria sessão e não toca nenhuma RPC, reserva ou outra experiência. Preflight e postcheck em `supabase/diagnostics/rotas_capsula_bar_*.sql`.
- URLs: `/experiencias/rota-ermida-ponte-jk` e `/experiencias/rota-prainha-do-congresso`. As antigas redirecionam (308) quando o slug antigo já não existe, então deploy e migration podem acontecer em qualquer ordem.
- Landing das duas rotas: 1h30 de duração, adequadas para iniciantes, com os itens incluídos e as orientações de segurança padrão. A Rota Ermida Ponte JK informa a parada na prainha da Ermida Dom Bosco.
- As rotas continuam "em breve": a publicação e as sessões (data, horário, preço, vagas) são feitas pelo painel. Não há horário fixo em código nem em conteúdo.
- A constraint `experiences_retired_slugs` aposenta os dois slugs antigos. Sem ela, reaplicar `202610080001_capsula_bar_launch.sql` depois da troca recriaria a Rota Prainha do Congresso pelo slug antigo; agora a reaplicação é recusada por inteiro. A migration de lançamento não foi editada.
- Fluxo de reserva, InfinitePay, e-mail, QR, check-in e planilha **não foram alterados**. Detalhes em [docs/multi-base.md](docs/multi-base.md#rotas-da-base).

## Correção: sincronização com a planilha parada pela grade cheia

- **Causa:** a aba oculta `Vagas Confirmadas` chegou à última linha da grade (2009) em 07/10/2026. A sincronização escreve em intervalos explícitos, que — ao contrário do `append` — não aumentam a grade; o Google passou a recusar o lote inteiro com 400 ("exceeds grid limits"), e toda reserva que precisava de linha nova ficava pendente. Não tem relação com o lançamento do Cápsula Bar: só coincidiu na data.
- **Correção:** antes de gravar, o motor calcula a última linha que vai ocupar em cada aba e o cliente acrescenta linhas vazias no fim (`appendDimension`, com folga de 500) quando falta. Nenhuma linha existente muda de posição; quem só reescreve linhas existentes não faz chamada extra.
- **Observabilidade:** `SNAPSHOT_UNAVAILABLE` e `HEADER_ROW_WRITE_BLOCKED` deixam de virar `UNEXPECTED_ERROR`, e o aviso "Sincronização pendente" do painel passa a mostrar o código sanitizado (ex.: `HTTP_400`).
- Sem migration, sem mudança em reserva, pagamento, QR ou check-in. Recuperação em [docs/google-sheets-integration.md](docs/google-sheets-integration.md#grade-cheia).

## Lançamento da Base Cápsula Bar — Concha Acústica (11/10/2026)

- A segunda base abre para reservas como **Cápsula Bar — Concha Acústica**: SHTN Trecho 1, Lote 8 — Brasília/DF, ponto de encontro em frente ao Cápsula Bar e link oficial do Google Maps. Detalhes em [docs/multi-base.md](docs/multi-base.md).
- **Remada Sunset** publicada na nova base com a sessão de inauguração: domingo, 11/10/2026, 17h, 90 minutos, R$ 70 por pessoa, 24 vagas. Nenhuma recorrência criada.
- Demais experiências cadastradas e prontas para receber horários, todas "em breve": Remada do Nascer do Sol, Remada da Lua Cheia e os dois roteiros de Caminhos do Paranoá (Rota Ermida x Ponte JK e Rota Prainha do Congresso). O cadastro único de Caminhos do Paranoá virou o primeiro roteiro — nada foi duplicado.
- **Localização centralizada:** `bases` ganha `meeting_point` e `maps_url`. Site, e-mail de confirmação, lembrete do QR, ingresso de check-in e consulta da reserva leem a base da reserva (reserva → sessão → experiência → base) por `lib/bases/location.ts`. Botão "Como chegar — Google Maps" onde a base tem link oficial.
- **E-mail por base:** o do Lago Norte continua idêntico, byte a byte (coberto por teste). As demais bases usam o modelo novo, com assunto "Sua reserva está confirmada! 🌊 | Alma Azul Academy", duração da sessão, participantes, ponto de encontro, endereço e mapa — mantendo código da reserva, QR de check-in, tolerância, o que levar, cancelamento e aviso do grupo.
- A landing da base é preservada e passa a ter dois estados: com a base ativa, as experiências publicadas ganham "Ver datas e reservar".
- Planilha: turmas fora do Lago Norte levam a base no título (`Remada Sunset · Cápsula Bar — Concha Acústica`). Nenhuma coluna ou linha existente muda.
- Painel: a base aparece no detalhe da reserva. Sessões, experiências, preços e capacidades da nova base usam as mesmas telas do Lago Norte, com o filtro de base que já existia.
- Fluxo de reserva, InfinitePay, webhook e reconciliação **não foram alterados**: nenhuma RPC de reserva ou pagamento é tocada.
- Migration `202610080001_capsula_bar_launch.sql` aditiva e idempotente (não sobrescreve edições do painel), com preflight e postcheck em `supabase/diagnostics/capsula_bar_launch_*.sql` e relatório de evidência de envio de e-mails em `confirmation_email_delivery_report.sql`.
- Testes em Postgres real (PGlite) com **todas** as migrations do repositório: sessão de inauguração, R$ 70 × participantes, limite de 24 vagas, pré-reserva vencida, webhook duplicado, valor divergente, e-mail único mesmo com falha do provedor, Lago Norte intocado, separação entre bases, operações do painel e schema legado de produção.
- Segunda etapa proposta: criação de sessões recorrentes pelo painel e edição da localização da base pelo painel.

## Acesso de instrutores à Lista de Presença

- Novo perfil **INSTRUCTOR** em `admin_users` (a tabela de perfis que já existia), sem tabela paralela. O admin atual segue identificado pela mesma linha, sem lógica por e-mail.
- `is_active_admin` passa a exigir role ADMIN ou OPERATOR. Antes ela olhava só `is_active`; como todas as RPCs administrativas se autorizam por ela, essa mudança fecha todo o painel para instrutores no banco. As quatro RPCs da Lista de Presença passam a usar `is_active_checkin_staff`. Para instrutor, o lookup do QR não devolve o e-mail do cliente.
- Envio e reenvio de QR por e-mail (individual e em lote) continuam só para ADMIN.
- Convites em `instructor_invites`, guardando só o SHA-256 do token (256 bits), com validade de 7 dias, uso único e cancelamento. O consumo é atômico (`instructor_invite_claim`, com `for update`) e cria o perfil INSTRUCTOR na mesma transação. O cadastro desfaz o usuário do Auth se o consumo falhar.
- `/admin/equipe` (só ADMIN): gerar convite, copiar ou enviar pelo WhatsApp, listar instrutores com status, data de criação e último acesso, desativar ou reativar, e cancelar convites.
- `/instrutor/cadastro?invite=…` para o cadastro, e a área `/instrutor` com layout próprio e somente as turmas do dia, o quadro de check-in e o scanner de QR. O instrutor que tenta abrir `/admin/*` é levado para `/instrutor`, e as rotas `/api/admin/*` respondem 403.
- Auditoria em `admin_audit_log`: INSTRUCTOR_INVITE_CREATED, INSTRUCTOR_INVITE_USED, INSTRUCTOR_INVITE_REVOKED, INSTRUCTOR_REGISTERED, INSTRUCTOR_DEACTIVATED e INSTRUCTOR_REACTIVATED. O check-in continua registrando `checked_in_by`.
- Migration `202609200001_instructor_access.sql` aditiva e idempotente, com rollback só para revisão e postcheck em `supabase/diagnostics/instructor_access_postcheck.sql`.
- Novos testes em Postgres real (PGlite) cobrindo autorização das RPCs, convites, concorrência e rollback do cadastro, além de uma varredura de guards em todas as rotas.

## Sprint 7.0 — Arquitetura multi-base e Base Concha Acústica (em breve)

- Auditoria de experiências, sessões, reservas, pagamentos, admin, banco, páginas públicas, componentes e navegação antes de qualquer alteração. Detalhes e decisões em [docs/multi-base.md](docs/multi-base.md).
- Nova hierarquia **Alma Azul → Base → Experiência → Sessão → Reserva**. Tabela `bases` com status `ACTIVE`, `COMING_SOON` e `INACTIVE`; `experiences.base_id`, `is_exclusive` e `modality`.
- A base de sessões e reservas é derivada da experiência — sem coluna redundante. Todo o histórico passou a ser **Base Lago Norte** pelo preenchimento de `experiences.base_id`; nenhuma reserva, sessão ou pagamento foi reescrito.
- **Base Concha Acústica** (parceria com o Cápsula Bar) criada como `COMING_SOON`, com Caminhos do Paranoá, Remada Nascer do Sol, Remada Sunset e Remada Lua Cheia, todas em breve. Nenhuma sessão, preço ou capacidade foi criado.
- Bloqueio de reserva no banco sem tocar nas RPCs de reserva e pagamento: experiência só pode ser publicada em base ativa (`BASE_NOT_ACTIVE`), sessão só pode existir em base ativa (`SESSION_BASE_NOT_ACTIVE`), e a pré-reserva já exigia experiência publicada.
- Base obrigatória: backfill explícito para Lago Norte só do que já existia, sem valor padrão no banco. O painel exige a base ao criar e editar experiências; a base trava depois da primeira sessão (`EXPERIENCE_BASE_LOCKED`).
- `modality` é só apresentação: sessões, vagas, reservas, receita, dashboard e status continuam por experiência e base (validado em Postgres).
- Mídia separada entre base (espaço) e experiência; `/bases/concha-acustica` pronta para receber fotos e vídeos locais do espaço; fotos temporárias do Lago Norte marcadas como "Imagem ilustrativa" e listadas em `TEMPORARY_BASE_MEDIA`.
- Bloqueadores para ativar a Concha registrados no código e em `docs/multi-base.md`: local de encontro por base nas comunicações e base no Google Sheets.
- Imersão Paranoá marcada como **exclusiva da Base Lago Norte**, com selo no site.
- Site: seção "Escolha onde viver a Alma Azul" na Home, novas páginas `/bases`, `/bases/lago-norte`, `/bases/concha-acustica` e `/experiencias` (filtro por base, uma linha por base em cada modalidade), selo reutilizável "Em breve", faixa da base na landing da experiência e páginas explicativas para URL manual de experiência ou sessão em breve.
- Navegação: Experiências · Bases · Sobre · Acompanhar reserva · Reservar (agenda geral). A Imersão saiu do menu principal. Nenhuma URL existente mudou.
- Admin: Dashboard separado em Visão geral, Lago Norte e Concha Acústica, com comparação entre bases, estados vazios e filtro de base em Sessões e Reservas. Nova RPC `admin_base_dashboard_metrics`; `admin_dashboard_metrics` segue intacta.
- Migration `202609150001_multi_base.sql` aditiva e idempotente, validada em Postgres sobre toda a cadeia de migrations (instalação limpa e schema legado), incluindo o fluxo de pré-reserva e confirmação do Lago Norte após a migration. Postcheck em `supabase/diagnostics/multi_base_postcheck.sql`.
- Acrescenta 26 testes (migration, base obrigatória, catálogo, agrupamento, bloqueio de reserva, mídia, filtros e navegação).

## Sprint 6.7 — E-mail de confirmação mais completo

- Auditoria do fluxo de e-mail antes de qualquer alteração: o template vive em `lib/reservations/confirmation-email.ts` (funções puras), o envio em `lib/reservations/confirmation-email-service.ts`, e os dados vêm da RPC `reservation_confirmation_email` — nome, código, experiência, `starts_at` da sessão e quantidade.
- Reescreve **apenas o conteúdo e a apresentação** do e-mail de confirmação, para que ele responda sozinho as perguntas que hoje chegam por WhatsApp.
- Acrescenta um bloco de **localização** com o endereço do ponto de encontro (`QL 5 Conjunto 5 - Lago Norte`). Texto, sem link de mapa: o projeto não tem link nem coordenada oficial em lugar nenhum, e inventar um seria criar informação que ninguém conferiu.
- Acrescenta um bloco de **horário de encontro** em destaque, com o horário real da sessão reservada e a tolerância de até 20 minutos. O horário continua saindo de `formatSessionTime(starts_at)` em `America/Sao_Paulo` — um teste recusa qualquer horário literal no arquivo do template.
- Acrescenta as seções **Antes de vir** (não precisa ter experiência com esportes ou canoa; roupa de banho, repelente e roupa confortável; vir de chinelo), **Duração** (em torno de 1h30, com parada para banho), **Imprevistos acontecem** (cancelamento com reembolso ou crédito até 1 dia antes) e **Criaremos um grupo** (grupo de comunicação até 1 dia antes da experiência).
- A duração fica como texto fixo, e não como `duration_minutes`: a RPC não devolve esse campo, todas as experiências atuais duram 90 minutos e a frase fala também da parada para banho, que nenhuma coluna carrega. Buscar o valor dinamicamente exigiria mexer na RPC, fora do escopo desta mudança.
- Cada bloco de texto fixo virou **constante exportada**, e é a própria constante que os testes comparam com o HTML e com o texto puro — a frase não pode divergir entre as duas versões nem ser alterada em silêncio.
- Reorganiza o layout em cartões: resumo da reserva, dois blocos de destaque (local e horário) e seções separadas por filete, com títulos curtos. O HTML continua deliberadamente antiquado — tabelas, largura máxima de 560px, estilo inline, sem `<ul>`, sem media query, sem imagem, sem `<style>` e sem CSS que Gmail ou Outlook ignorem.
- A versão em texto puro recebeu as mesmas seções: ela continua sendo a mensagem inteira, nunca um resumo.
- Acrescenta 11 testes de conteúdo, fuso, responsividade e preservação do que já existia, mais a verificação de que o e-mail continua servindo às quatro experiências com um único template.
- **Nada da mecânica foi tocado:** reivindicação exatamente-uma-vez, prevenção de envio duplicado, retry, rotina agendada, botão de reenvio do painel, webhook da InfinitePay, confirmação de pagamento, `payment_status`, `payment_events`, checkout, schema do Supabase, `public.sessions`, `public.reservations`, disponibilidade, Google Sheets e reagendamento seguem exatamente como estavam. Nenhuma migration foi criada.

## Sprint 6.6 — Filtro de data na agenda pública

- Auditoria do fluxo público de escolha de data antes de qualquer alteração: `/agenda` monta a lista com `listAgendaSessions`, e cada página de experiência usa `SessionsSection`/`SessionsGrid` sobre `readOpenSessions`. As duas já recebiam a lista inteira de sessões abertas em uma única resposta, agrupada por dia local pelo `groupSessionsByDay`.
- Acrescenta um filtro por data no topo das duas listagens públicas: agenda geral (todas as experiências misturadas) e a grade de datas de cada experiência, incluindo Imersão Paranoá, Remada Sunset, Remada do Nascer do Sol e Remada da Lua Cheia, que reutilizam o mesmo componente.
- O recorte é **client-side** sobre as sessões que a página já carregou: nenhuma consulta, RPC ou rota nova foi criada, e trocar de data não repinta a página. O volume de sessões abertas cabe em uma resposta, então uma ida ao servidor por clique seria custo sem ganho.
- A data escolhida vai para a URL (`?date=2026-10-17`) pela History API nativa: o link filtrado pode ser compartilhado, o refresh mantém o filtro e voltar/avançar do navegador ficam previsíveis. O servidor lê o parâmetro e já entrega o primeiro HTML filtrado, sem piscar a lista completa.
- Um `?date=` fora do formato, com dia inexistente (`2026-02-30`), repetido ou com conteúdo arbitrário é ignorado como "sem filtro" — a página mostra todas as datas em vez de quebrar. O componente revalida o valor mesmo já vindo validado da página.
- A comparação usa sempre o dia local em `America/Sao_Paulo`, derivado de `toSessionDateTimeLocal`: uma remada de 05:30 fica no próprio dia e uma turma de 22:00 não escorrega para o dia seguinte por causa do UTC.
- Estado vazio explicado em cada contexto — "Não encontramos experiências disponíveis nesta data." na agenda geral, "Não encontramos horários desta experiência nesta data." na página da experiência — sempre com a ação "Ver todas as datas".
- Filtro horizontal e integrado ao cabeçalho no desktop, empilhado e com alvo confortável no mobile, sem estourar largura e sem caminho de código próprio por tamanho de tela.
- Na página de uma experiência o filtro atua apenas sobre as sessões daquela experiência; o destaque "Turmas disponíveis" continua listando todos os horários e não é filtrado.
- Acrescenta 26 testes de fuso, validação do parâmetro, recorte por dia, estado vazio, limpeza do filtro e coerência com o agrupamento por dia.
- Trabalho somente de interface e navegação: não altera `public.sessions`, migrations, `available_spots`, capacidade, reservas, checkout, InfinitePay, pagamentos, status de sessão, Google Sheets, reagendamento nem o admin. Nenhuma migration foi criada.

## Sprint 6.5 — Reagendamento administrativo entre experiências

- Auditoria do fluxo `reserva confirmada → sessão → experiência → vagas → pagamento → planilha → e-mail → histórico` antes de qualquer alteração de código.
- **Causa da limitação anterior:** `reservations` guarda `experience_id` como coluna própria, e a troca de turma alterava apenas `session_id`. Mover para outra experiência deixaria a reserva com a data nova e o produto antigo — `lookup_reservation`, `admin_get_reservation`, `admin_list_reservations` e o e-mail de confirmação resolvem a experiência por `r.experience_id`. A recusa `SESSION_EXPERIENCE_MISMATCH` protegia justamente essa divergência.
- Permite reagendar uma reserva `CONFIRMED` para **qualquer** sessão futura elegível da agenda, inclusive de outra experiência, mantendo a mesma reserva: mesmo `id`, mesmo `public_code`, mesmo status, mesmo `confirmed_at` e mesmo pagamento.
- Escreve `session_id` e `experience_id` juntos, na mesma transação, e relê a linha para conferir a coerência antes de gravar histórico e auditoria.
- Substitui a restrição antiga por uma invariante do banco: a trigger `reservations_experience_consistency` impõe que `reservations.experience_id` seja sempre a experiência de `reservations.session_id`, validando apenas quando esse par é escrito.
- Recusa destino em experiência não publicada (`EXPERIENCE_NOT_AVAILABLE`); a própria experiência da reserva continua aceita mesmo despublicada, para quem já comprou poder trocar de horário.
- Mantém intactos os locks, a ordem determinística por id, a recontagem de ocupação com as sessões travadas e a recusa de mover parte do grupo — a proteção contra overbooking não foi tocada.
- Oferece no seletor toda a agenda futura e aberta, com nome da experiência, data, horário, vagas restantes e capacidade; esconde canceladas, arquivadas, encerradas e sem vaga para o grupo inteiro, informando quantas ficaram de fora.
- Acrescenta filtro por experiência no modal, etiqueta *outra experiência* nos destinos que atravessam a fronteira e aviso explícito na confirmação quando a experiência muda.
- Registra no histórico a experiência anterior e a nova, além da sessão anterior e da nova, do ator e da data/hora, com backfill das trocas já gravadas; `admin_audit_log` recebe as duas experiências e o sinal `experienceChanged`.
- Preserva o valor pago mesmo entre experiências de preços diferentes: a diferença é exibida antes de confirmar e registrada no histórico, nunca cobrada nem estornada, e nenhum `payment_status`, evento de pagamento ou checkout é criado.
- Atualiza a mesma linha da planilha operacional, com a experiência, a data e o horário novos, sem duplicar a reserva; a turma antiga é reconstruída para corrigir seus totais.
- Não envia e-mail: não existe comunicação automática de troca de turma, e o e-mail de confirmação continua sendo uma-vez-por-reserva — o que também garante que nenhuma mensagem duplicada saia daqui. Avisar o cliente segue sendo decisão do admin.
- Mantém a autorização inalterada: só admin ativo executa, `SECURITY DEFINER` com `search_path` fixo, execução revogada de `public`, `anon` e `authenticated`, e o ator derivado da sessão validada no servidor.
- Acrescenta 38 testes — inclusive A → B, B → A, destino sem vagas, sessão cancelada, sessão passada, quantidade maior que a capacidade, sincronização real com planilha falsa em memória e regressão completa do fluxo de mesma experiência — e um diagnóstico transacional para Postgres real.
- Não altera preços, capacidades, reservas existentes, criação de pré-reserva, expiração, pagamento, InfinitePay, autenticação, RLS nem nenhuma migration histórica.

## Sprint 6.4 — Confiabilidade da confirmação de pagamento (P0)

- Auditoria completa do fluxo `PRE_RESERVED → checkout → webhook → payment_events → confirmPayment → RPC → CONFIRMED → available_spots → expiração` antes de qualquer alteração de código.
- **Causa raiz:** a expiração assumia que ausência de confirmação é ausência de pagamento. `expire_pre_reservations()` liberava a vaga pelo relógio, e `available_spots()` parava de contar a pré-reserva no instante em que `expires_at` passava — sem nunca perguntar à InfinitePay se o cliente havia pago.
- **Causa contribuinte:** o webhook era o único caminho automático de confirmação. O retorno do checkout depende do cliente voltar ao site e a verificação administrativa depende de alguém clicar, então qualquer webhook perdido, atrasado ou rejeitado virava vaga revendida.
- Introduz janela de segurança na expiração: uma pré-reserva vencida que chegou a gerar checkout entra em retenção em vez de liberar a vaga, e registra `EXPIRATION_HELD_FOR_PAYMENT_CHECK`.
- Implementa a retenção empurrando o próprio `expires_at`, o que faz `available_spots`, `create_pre_reservation`, `admin_confirm_reservation`, `admin_change_reservation_session` e `confirm_reservation_payment` respeitarem a janela sem serem reescritas. O prazo original do cliente fica preservado em `original_expires_at`.
- Adiciona reconciliação automática que consulta a InfinitePay sem depender de webhook nem de navegador, com reivindicação `for update skip locked` e três desfechos: pago confirma, comprovadamente não pago libera, e **estado incerto retém**.
- Garante que erro de rede, timeout e resposta ilegível do gateway nunca sejam tratados como "não pagou": só um veredito positivo de não pagamento devolve a vaga ao mercado.
- Limita a retenção por um teto absoluto contado do prazo original, e grava `PAYMENT_HOLD_EXHAUSTED` antes de liberar quando a janela termina sem resposta definitiva. Nenhuma vaga volta ao mercado em silêncio.
- Corrige a rejeição de cartão parcelado com juros pagos pelo cliente: a igualdade exata de valor virava `PAYMENT_AMOUNT_MISMATCH` terminal, respondido com HTTP 200. Passa a exigir que o maior valor observado cubra o total; cobrança a menor continua sendo divergência.
- Reconhece aprovação sinalizada por `status` textual, que antes virava `NOT_PAID` definitivo e silencioso.
- Torna o webhook tolerante a `application/x-www-form-urlencoded` e a JSON com `Content-Type` errado, formatos que antes viravam HTTP 400 sem deixar rastro.
- Tira planilha e e-mail do caminho crítico do webhook (`after()`): somavam até dezesseis segundos de rede a uma resposta que o gateway espera curta.
- Cria `payment_webhook_log`, a primeira trilha que aceita webhook sem reserva correspondente — o caso que `payment_events` não consegue guardar e que era impossível diagnosticar.
- Registra etapas nomeadas (`WEBHOOK_RECEIVED`, `PAYMENT_APPROVED`, `CONFIRM_SUCCESS`, `RECONCILIATION_FAILED`, `EXPIRATION_HELD_FOR_PAYMENT_CHECK`…) sem PII e sem segredo, com formato garantido por CHECK no banco.
- Adiciona **Pagamentos para revisar** no painel administrativo, com contador no dashboard: pagamento aprovado sem vaga, pago e não confirmado, valor divergente, janela esgotada, reconciliação falhando, expirada com sinal de pagamento e webhook órfão.
- Corrige o status de pagamento do painel, que exibia `NOT_PAID` para reservas recuperadas pela reconciliação porque o `CASE` não conhecia `PAYMENT_CONFIRMED_RECONCILED`.
- Define o comportamento de pagamento tardio: confirma quando ainda cabe, e gera incidente explícito e permanente quando não cabe. Um pagamento aprovado nunca é tratado como inexistente.
- Acrescenta 54 testes de falha — webhook duplicado, atrasado, pós-expiração, gateway fora do ar, Supabase indisponível, confirmações simultâneas, pagamento tardio com e sem capacidade — rodando contra o código de produção com portas injetadas, mais um self-test transacional contra Postgres real.
- Acrescenta script forense somente leitura para produção, com identificadores mascarados e sem CPF, nome, telefone, e-mail, token ou payload integral.
- Não altera preços, capacidades, reservas existentes, regras de criação de pré-reserva, autenticação, planilha nem e-mail de confirmação.

## Sprint 6.3 — Alterar turma de uma reserva confirmada

- Auditoria do fluxo `reserva confirmada → sessão → vagas → pagamento → cancelamento → planilha` antes de qualquer alteração de código.
- Adiciona a ação administrativa **Alterar turma** na listagem e no detalhe de uma reserva `CONFIRMED`, com escolha em duas etapas e confirmação explícita de para onde a reserva vai.
- Move a reserva por `admin_change_reservation_session`, uma operação transacional que trava a reserva e as duas sessões — sempre na ordem dos ids — e recalcula a ocupação real do destino antes de decidir.
- Recusa turma inexistente, fechada, passada, de outra experiência, a própria turma da reserva e qualquer destino sem vagas para o grupo inteiro; não existe mover parte dos participantes.
- Preserva `public_code`, cliente, CPF, quantidade, status `CONFIRMED`, `confirmed_at` e o valor pago: a operação altera exatamente `session_id`.
- Não gera cobrança, estorno, evento de pagamento, reserva nova nem mensagem automática ao cliente.
- Preserva o valor quando as duas turmas têm preços diferentes, registra os dois preços no histórico e avisa no detalhe da reserva; ajuste financeiro continua sendo processo operacional separado.
- Cria `reservation_session_changes` com reserva, sessão anterior, sessão nova, ator, quantidade, valor preservado, preços e motivo opcional, e mantém a linha correspondente em `admin_audit_log`.
- Reflete a mudança na planilha operacional: a reserva passa a ocupar a turma nova e a turma antiga é reconstruída, mantendo `Sessões`, `Reservas do Site`, `Vagas Confirmadas` e `Lista da Sessão` coerentes e idempotentes.
- Mantém a garantia da integração: uma falha do Google Sheets não desfaz a troca já confirmada no Supabase; os jobs ficam pendentes para retry.
- Restringe esta versão a sessões da mesma experiência, com recusa no banco (`SESSION_EXPERIENCE_MISMATCH`).
- Extrai `adminMutationError` para um módulo sem dependência do Next, permitindo cobrir cada recusa do banco com o runner nativo de testes.
- Acrescenta diagnóstico transacional (`ROLLBACK` ao fim) para validar a operação e a concorrência contra um Postgres real.
- Não altera regras de disponibilidade, capacidade, pré-reserva, expiração, pagamento, InfinitePay, e-mail de confirmação, autenticação nem nenhuma migration histórica.

## Sprint 6.2 — Clareza das turmas da Imersão Paranoá

- Auditoria do fluxo de reserva (sessão exibida → escolha → `session_id` → resumo → criação → pagamento → confirmação): nenhum defeito técnico encontrado. Horário e `session_id` já saíam da mesma linha de `public.sessions`, sem horário fixo, sem associação por posição e sem erro de fuso.
- Concentra em `lib/sessions/choice.ts` a única tradução de `sessions.id` + `sessions.starts_at` para o que o cliente vê, e cobre as três turmas com testes de regressão.
- Anuncia as turmas na página da experiência, com os horários lidos das sessões abertas de verdade — nunca de texto editorial.
- Reconstrói a escolha da sessão: turmas agrupadas por dia, horário como maior elemento do cartão e cartão inteiro clicável.
- Mantém o horário escolhido visível e destacado do formulário até a confirmação, incluindo a espera do pagamento, a consulta por CPF + código e o retorno do checkout, que antes não mostravam horário nenhum.
- Reaproveita uma única leitura de `list_open_sessions` por render entre o destaque das turmas e a grade de datas.
- Acrescenta diagnóstico somente leitura para conferir horários, turmas duplicadas e coerência reserva/sessão no banco.
- Não altera reservas antigas, regras de capacidade, pré-reserva, pagamento, InfinitePay, e-mail de confirmação, planilha nem autenticação.

## Sprint 6.1 — Planilha operacional das turmas

- Sincroniza reservas confirmadas com uma Planilha Google nativa para montagem dos grupos de WhatsApp.
- Concentra a sincronização em um ponto único, alcançado por webhook, retorno do pagamento, verificação e ações administrativas.
- Cria fila durável `integration_sync_jobs` com idempotência por entidade, tentativas contadas e código de erro sanitizado.
- Garante que uma falha do Google não desfaz pagamento, reserva, vaga nem resposta do webhook.
- Expande uma reserva de N pessoas em N vagas, com o valor total gravado uma única vez.
- Preserva histórico no cancelamento: a reserva permanece com status Cancelada e as vagas saem da lista por exclusão lógica.
- Impõe o recorte de privacidade no banco: as RPCs de snapshot não devolvem CPF, e-mail, endereço nem payload de pagamento.
- Acrescenta ações administrativas de sincronizar reserva e reconstruir a lista da sessão, além do script idempotente de preparação da planilha.
- Não altera regras de disponibilidade, capacidade, pré-reserva, pagamento, InfinitePay, CPF, autenticação ou cancelamento.
- Não adiciona nenhuma dependência: usa a Sheets API v4 por REST com JWT de conta de serviço assinado por `node:crypto`.

## Sprint 5.2 — Experiências dinâmicas

- Adiciona contrato editorial JSONB versionado e validado no servidor.
- Cria `/experiencias/[slug]`, metadata dinâmica e 404 para conteúdo não publicado.
- Migra fielmente a Imersão Paranoá para o renderer compartilhado, preservando `/imersao-paranoa`.
- Faz a Home consumir somente experiências publicadas e ordenadas pelo Supabase.
- Amplia o painel com edição editorial completa, validação de publicação e preview protegido.
- Mantém imagens em `public/images` ou HTTPS, sem Supabase Storage.
- Preserva motor de reservas, pagamentos, autenticação, schema legado e migrations históricas.

Registro das mudanças confirmadas no histórico Git. O formato segue os princípios do [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/), organizado por sprint em vez de versões publicadas.

## Não publicado — compatibilidade do schema legado

### Adicionado

- Migration idempotente e não destrutiva para compatibilizar tabelas e enums legados com as Sprints 3 e 4.
- Cópia operacional em `supabase/bootstrap` para o bootstrap manual anterior às migrations 001 e 002 neste banco específico.
- Preservação explícita dos campos editoriais, IDs, relacionamentos e do snapshot legado `spots_available`.
- Documentação da ordem especial de bootstrap, backup, validação e recuperação.

### Estado

- Alterações somente locais; nenhuma migration foi executada e nenhum ambiente Supabase foi alterado.
- Aplicação depende de inventário remoto atualizado, backup e autorização explícita.

## Sprint 4 — painel administrativo MVP

**Estado:** concluída no código; ativação externa ainda depende da migration, do Supabase Auth e do cadastro do primeiro administrador.

### Adicionado

- Login real com Supabase Auth, cookies HttpOnly, renovação de sessão e proteção de rotas.
- Autorização explícita por `admin_users`, com papéis `ADMIN` e `OPERATOR`.
- Dashboard operacional em `/admin` e navegação responsiva.
- Gestão de sessões, experiências e reservas, incluindo filtros e detalhes.
- Confirmação manual e cancelamento de reservas com motivo, proteção de capacidade e auditoria.
- Configurações operacionais somente leitura e estados de loading, vazio, sucesso e erro.
- Migration administrativa com RPCs, RLS, grants, auditoria e configurações da plataforma.
- Testes de validação e garantias estáticas da migration.

### Limites confirmados

- A migration administrativa não foi aplicada ao Supabase por esta entrega.
- Nenhuma credencial real foi adicionada ao repositório; não havia `.env.local` no ambiente de validação.
- O primeiro usuário precisa ser criado no Supabase Auth e autorizado em `admin_users` pelo processo operacional documentado.
- O CPF completo continua sem persistência em texto simples; o painel exibe somente os quatro últimos dígitos e aceita CPF completo apenas como filtro server-side por hash.
- Reenvio de código e mensagem apenas preparam o contato; não existe integração de envio nesta sprint.

## Sprint 3 — ciclo de reservas

**Estado:** concluída no código; integrações externas ainda dependem de configuração.

**Commit:** [`1874799dc6539aa5a8fca01fd88dc5b913c098b7`](https://github.com/almaazulacademy/Imers-o-Parano-LandPage/commit/1874799dc6539aa5a8fca01fd88dc5b913c098b7) — 1º de agosto de 2026.

### Adicionado

- Página genérica de reserva por sessão em `/reservar/[sessionId]`.
- Formulário validado de participante, quantidade e observações.
- Tela de retenção com contador de 2 horas e código da reserva.
- Recuperação segura em `/acompanhar-reserva` com CPF + código.
- Rotas server-side para criação e consulta de reservas.
- Webhook e retorno de pagamento da InfinitePay.
- Interface `PaymentProvider` e implementação `InfinitePayProvider`.
- Migration com experiências, sessões, reservas, eventos de pagamento, RPCs, RLS, índices e cron de expiração.
- Testes da validação de CPF, telefone e dados de reserva.

### Alterado

- Cards de sessões passaram a usar as RPCs genéricas e direcionar para o fluxo de reserva.
- Navegação e rodapé receberam acesso à página de acompanhamento.
- README passou a registrar a configuração inicial do fluxo de reservas.

### Limites confirmados

- O commit não comprova que a migration foi aplicada no Supabase de produção.
- A InfinitePay requer `INFINITEPAY_HANDLE`, URLs públicas e configuração externa para operar.
- O painel administrativo permanece como placeholder.

## Sprint 2 — refinamento e leitura de sessões

**Estado:** concluída.

**Commit:** [`b677c99eb99dce2ebcd4834137e68f9dd77fda75`](https://github.com/almaazulacademy/Imers-o-Parano-LandPage/commit/b677c99eb99dce2ebcd4834137e68f9dd77fda75) — 1º de agosto de 2026.

### Adicionado

- Seção de próximas datas com estados de carregamento, vazio e erro.
- Cliente Supabase para Server Components.
- Microanimação de entrada respeitando `prefers-reduced-motion`.

### Alterado

- Hero, textos e chamadas para ação da Home.
- Navbar fixa com fundo translúcido, blur e sombra após o Hero.
- Conteúdo, espaçamento e hierarquia visual da Imersão Paranoá.
- Inclusos, duração, FAQ e âncoras da experiência.

### Limites confirmados

- A Sprint 2 fazia somente leitura e não criava reservas.
- Sem credenciais, a seção apresentava o estado vazio.

## Sprint 1 — fundação da plataforma

**Estado:** concluída.

**Commit:** [`9688e113850484cfccb602640c837e7a1b6b18ae`](https://github.com/almaazulacademy/Imers-o-Parano-LandPage/commit/9688e113850484cfccb602640c837e7a1b6b18ae) — 31 de julho de 2026.

### Adicionado

- Aplicação Next.js 15 com App Router, TypeScript e Tailwind CSS.
- Home institucional e landing da Imersão Paranoá.
- Navbar, rodapé, Hero, seções, cards, galeria e FAQ reutilizáveis.
- Placeholders de `/login` e `/admin`.
- Catálogo local em `lib/experiences.ts`.
- Cliente Supabase inicial, sem consultas na Sprint 1.
- Acervo oficial organizado em `public/images`.
- Configuração de build e dependências da aplicação.

[Voltar ao README](README.md)
