# Changelog

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
