# Stand-by de reservas e reagendamento

[README](../README.md) · [Banco de dados](database.md) · [Pagamentos](payments.md) · [Painel](admin.md)

**Estado: e-mail de reagendamento (etapa 4 de 6), desligado por padrão.** As migrations `202610130001`, `202610130002` e `202610140001` estão aplicadas em produção. O painel só existe com `STANDBY_ADMIN_ENABLED=true`. O e-mail desta etapa só sai com a migration `202610150001` aplicada **e** `STANDBY_RESCHEDULE_EMAIL_ENABLED=true`. Mergear o PR não aplica migration, não liga o painel e não envia e-mail.

## O que é

Stand-by é a situação de uma reserva que já foi paga, saiu da turma original por decisão da equipe e ainda não tem nova data. Não é cancelamento, expiração, estorno nem pagamento pendente.

A reserva continua sendo a mesma — mesmo id, mesmo código, mesma quantidade, mesmo valor unitário, mesmo `confirmed_at`, mesmos eventos de pagamento, mesmo QR — e passa ao status `AWAITING_RESCHEDULE` ("Aguardando reagendamento").

| | Confirmada | Aguardando reagendamento |
| --- | --- | --- |
| Pagamento | Pago | Pago |
| Ocupa vaga | Sim | Não |
| Lista de presença e check-in | Sim | Não |
| QR Code | Vale na turma da reserva | Não vale em turma nenhuma |
| Conta na receita | Sim | Sim |
| Conta em participantes e ocupação | Sim | Não |

`session_id` e `experience_id` continuam apontando para a turma original enquanto a reserva está em Stand-by: as colunas são obrigatórias e todas as leituras fazem join por elas. Nesse estado elas significam "turma anterior".

## Regras de negócio

1. **Mesmo valor.** O cliente só reagenda para sessão cujo preço por participante é exatamente o valor unitário pago. Sem diferença, cobrança ou reembolso. A quantidade não muda.
2. **Sem antecedência mínima.** Serve qualquer sessão aberta, ainda não iniciada e com vagas para o grupo inteiro.
3. **Qualquer reserva confirmada**, inclusive de sessão passada, fechada ou arquivada. Exige pagamento confirmado. Presença parcial ou completa bloqueia: o admin desfaz o check-in antes. Sem registro ou com ausência registrada, entra.
4. **Sem validade.** Nada expira o Stand-by automaticamente.
5. **Dois acessos para o cliente:** CPF + código, ou link individual gerado pelo admin.
6. **Desfazer** devolve a reserva à turma original se ela estiver aberta, no futuro e com vagas. Senão a operação é recusada e o Stand-by continua.
7. **A turma original é um destino válido** para o cliente, nas mesmas condições das demais.
8. **Planilha:** as 14 sessões históricas fora da planilha não são reinseridas, nem reescritas. Elas ficam congeladas, de forma permanente, pelo `session_id` completo, para toda sincronização; e a sincronização que parte da turma de origem de um Stand-by só atualiza o que já existe — ver [Planilha](#planilha).
9. **Reagendamento pelo painel:** mesma régua do cliente — turma futura, aberta, publicada, com vagas e mesmo valor por participante, em qualquer base.

`admin_reschedule_reservation_from_standby`, da etapa 2, não tem regra de preço. Ela continua no banco, com o mesmo corpo, mas a migration do painel retira da service role a permissão de executá-la: o servidor só alcança `admin_reschedule_standby_same_price`. O reagendamento tradicional (`admin_change_reservation_session`, só para reserva confirmada) continua sem regra de preço, por decisão de negócio.

## Modelo de dados

Migrations `202610130001_reservation_status_awaiting_reschedule.sql` e `202610130002_reservation_standby.sql`.

- **`reservation_status`** ganha `AWAITING_RESCHEDULE`. Fica em migration própria porque o Postgres não deixa usar um valor de enum na transação em que ele foi criado.
- **`reservation_standby`**: uma linha por entrada em Stand-by. Guarda o retrato da turma original (sessão, experiência, base, data), o retrato financeiro, o check-in anterior, quem colocou e por quê, o hash do link e a resolução (`RESCHEDULED`, `RESTORED` ou `CANCELLED`). Um índice único parcial garante no máximo uma linha aberta por reserva. **Essa linha é a autorização de reagendamento.**
- **`reservation_session_changes`** ganha `actor_type` (`ADMIN`/`CUSTOMER`), `origin` (`DIRECT`/`STANDBY_RESCHEDULE`/`STANDBY_RESTORE`) e `standby_id`. O histórico anterior é descrito pelos defaults (`ADMIN`, `DIRECT`). A regra "origem diferente do destino" continua valendo para a troca direta; vinda de Stand-by, voltar à mesma turma é permitido.

RLS ligado e nenhum acesso para `anon` ou `authenticated`. A service role só lê a tabela; toda escrita passa por RPC.

## Operações

Todas `security definer`, com `search_path` fixo e executáveis apenas pela service role. As administrativas conferem `is_active_admin` (ADMIN ou OPERATOR ativo).

| RPC | Faz |
| --- | --- |
| `admin_set_reservation_standby(actor, reserva, motivo)` | Coloca em Stand-by. Motivo obrigatório. |
| `admin_undo_reservation_standby(actor, reserva, motivo)` | Desfaz: volta à turma original. |
| `admin_reschedule_reservation_from_standby(actor, reserva, sessão, motivo)` | Reagenda pelo admin, sem regra de preço. Fora do alcance da service role desde `202610140001`; o painel usa `admin_reschedule_standby_same_price`. |
| `admin_list_standby_reservations(actor)` | Lista "Aguardando reagendamento". |
| `admin_generate_reservation_standby_link(actor, reserva)` | Gera (ou substitui) o link. Devolve o token uma única vez. |
| `admin_revoke_reservation_standby_link(actor, reserva)` | Revoga o link. |
| `customer_reschedule_options(cpf, código, token)` | O que o cliente vê: a reserva e as turmas elegíveis. |
| `customer_reschedule_reservation(cpf, código, token, autorização, sessão)` | Confirma a escolha do cliente. |

`admin_change_reservation_session`, o reagendamento tradicional, não foi alterada e continua atendendo só reservas confirmadas.

### O núcleo

Desfazer e reagendar (pelo admin ou pelo cliente) passam por uma única função interna, `reservation_standby_resolve`, que ninguém executa diretamente. Em uma transação ela:

1. trava a reserva, depois a autorização, depois a sessão de destino;
2. aplica a régua do destino (`reservation_standby_target_rejection`, a mesma que monta a lista do cliente);
3. expira retenções vencidas do destino e reconta a ocupação com a sessão travada;
4. encerra a autorização, devolve a reserva a `CONFIRMED` na nova turma, grava o histórico e a auditoria.

Qualquer falha desfaz tudo.

**Uso único e idempotência.** A autorização é consumida na transação que move a reserva. Repetir a mesma requisição (mesma autorização, mesmo destino, mesmo tipo de ator) devolve o resultado gravado, com `replayed = true`, sem escrever. Qualquer outra tentativa sobre autorização encerrada é `STANDBY_ALREADY_USED`. Cada nova entrada em Stand-by cria outra autorização; as anteriores não voltam a valer.

### Acesso do cliente

`reservation_standby_access` resolve as duas credenciais para a mesma coisa, a autorização. As RPCs do cliente nunca recebem id de reserva, quantidade ou valor: só a credencial e a sessão escolhida.

**Link.** Token de 32 bytes do gerador criptográfico do `pgcrypto`, em hexadecimal. O banco guarda só o SHA-256; o texto do token existe uma vez, na resposta da geração, e não vai para auditoria. Gerar de novo invalida o anterior; revogar apaga o hash; resolver o Stand-by encerra a autorização. O formato previsto para a URL é `/acompanhar-reserva#r=<token>`: o fragmento não chega ao servidor, então não aparece em logs nem em pré-visualização de link.

**Limite de tentativas e checagem de origem** ficam na rota do servidor, na etapa 5, junto com a interface pública.

## Proteção financeira

Uma reserva em Stand-by está paga. Há duas camadas independentes para garantir que nenhum caminho de pagamento a devolva à turma antiga.

**Nas funções.** `reconcile_reservation_payment` devolve `AWAITING_RESCHEDULE`; `confirm_reservation_payment` devolve `false`; `admin_confirm_reservation` recusa com `RESERVATION_AWAITING_RESCHEDULE`. Nenhuma grava evento nem altera a reserva. São as definições anteriores com uma única instrução acrescentada — o teste compara o corpo antes e depois. Em `confirmPayment` (webhook, retorno do pagamento e "Verificar pagamento"), a reserva em Stand-by sai antes de qualquer registro, consulta ao gateway ou RPC, com o resultado `AWAITING_RESCHEDULE`: definitivo, sem planilha, sem e-mail e sem revisão.

**No banco.** A trigger `reservations_standby_guard` só deixa uma reserva entrar em `AWAITING_RESCHEDULE` vindo de `CONFIRMED` com autorização aberta, e só a deixa voltar a `CONFIRMED` depois de a autorização ser encerrada — o que só as operações de Stand-by fazem. Uma função de pagamento esquecida, ou criada no futuro, aborta aqui.

`admin_payments_needing_review` e `payment_review_counters` deixam de listar reservas em Stand-by.

## Receita e métricas

Tudo que mede **dinheiro** soma `CONFIRMED` + `AWAITING_RESCHEDULE`: `expectedRevenueCents`, `confirmedRevenueCents`, `monthlyRevenueCents`, `averageTicketCents` e `revenueByMonth`. Tudo que mede **presença ou vaga** continua só `CONFIRMED`. `awaitingReschedule` é novo: reservas, participantes e valor parados em Stand-by.

Não há dupla contagem: é a mesma linha, somada uma vez. O mês da receita vem de `confirmed_at`, que nem a entrada em Stand-by nem o reagendamento alteram.

**Por base.** A receita é atribuída pela experiência da reserva. Em Stand-by ela ainda é a original, então o valor permanece na base de origem. Ao reagendar para outra base, o valor migra inteiro para a base de destino — o mesmo que o reagendamento administrativo entre bases já faz. A soma das bases continua igual ao total geral.

## Compatibilidade do código

Publicado antes das migrations, este código não muda nada: nenhuma reserva tem o status novo. Ele só garante que, quando tiver, o status será lido corretamente:

- mapeadores do painel não o convertem mais em "Expirada";
- a página pública mostra "Aguardando reagendamento", sem a data antiga e sem convite para comprar de novo;
- "Verificar pagamento" e "Confirmar pagamento" somem do painel para reservas pagas;
- planilha: rótulo próprio e vaga inativa.

## Painel administrativo

Etapa 3. Tudo abaixo só existe com o painel [ativado](#ativação).

### Colocar em Stand-by

Botão nas reservas **confirmadas e pagas**, na listagem e no detalhe. O modal mostra cliente, código, experiência, turma original, participantes e valor pago, avisa que as vagas da turma serão liberadas, exige o motivo (3 a 500 caracteres) e uma confirmação marcada à mão. A rota recusa o pedido sem `confirmed: true`.

Reserva com presença parcial ou completa é recusada pelo banco (`STANDBY_CHECKIN_REGISTERED`); no detalhe o modal já bloqueia antes. Sessão passada sem presença registrada entra normalmente.

### Lista

`/admin/stand-by`, no menu logo depois de Reservas. Mostra nome, código, data, base e experiência originais, participantes, valor pago, motivo e desde quando a reserva está em Stand-by — a mais antiga primeiro. Busca por nome, código ou telefone; filtros por base original e por link ativo.

A paginação é do banco (`admin_list_standby_reservations_page`, 25 por página, total e somas do conjunto filtrado). `admin_list_standby_reservations`, da etapa 2, devolve no máximo 500 linhas sem página seguinte e não é usada pelo painel.

### Ações

| Ação | Regra | RPC |
| --- | --- | --- |
| Reagendar | Turma futura, aberta, publicada, base em operação, vagas para o grupo e preço por participante igual ao pago. Entre bases é permitido. Quantidade e pagamento não são parâmetros. | `admin_reschedule_standby_same_price` |
| Desfazer Stand-by | Turma original aberta, ainda não iniciada e com vagas para o grupo. Senão é recusado e o Stand-by continua. | `admin_undo_reservation_standby` |
| Gerar link | Substitui o anterior, que para de valer na hora. | `admin_generate_reservation_standby_link` |
| Revogar link | Apaga o hash. | `admin_revoke_reservation_standby_link` |

`admin_reschedule_standby_same_price` trava a reserva, depois a sessão de destino — a ordem do núcleo —, confere a régua `CUSTOMER` de `reservation_standby_target_rejection` e entrega a `reservation_standby_resolve`. É a mesma régua que monta a lista de turmas do modal (`admin_standby_reschedule_options`), então a tela e a decisão não divergem.

O link é devolvido uma única vez, já como endereço `/acompanhar-reserva#r=<token>`, para o admin copiar ou abrir um rascunho no WhatsApp. Ele não vai para log, auditoria, histórico, URL do painel nem armazenamento do navegador; a resposta sai com `cache-control: no-store`. **A página pública ainda não lê o fragmento:** até a etapa 5 o link abre a página de acompanhamento comum, e o modal avisa isso.

Só **Reagendar** envia e-mail, e só com o [e-mail de reagendamento](#e-mail-de-reagendamento) ativado. Desfazer, gerar e revogar link — e colocar em Stand-by — nunca enviam.

### Auditoria

O detalhe da reserva ganha a seção "Stand-by": um bloco por entrada (quem colocou, motivo, data, turma de origem e de destino, como saiu e por quem) e a lista das ações registradas, inclusive geração e revogação de link. `admin_reservation_standby_history` não devolve token, hash nem os metadados da auditoria.

### Autorização

As rotas ficam em `/api/admin/reservations/[reservationId]/standby` (`GET` e `POST`), `.../standby/undo`, `.../standby/reschedule` e `.../standby/link` (`POST` e `DELETE`). Todas passam por `authorizeStandbyApi`: 404 com o painel desligado; 401 sem sessão; 403 para instrutor. As mutações conferem a origem antes de tudo. O ator vem da sessão validada, e cada RPC confere de novo `is_active_admin`.

### Ativação

`STANDBY_ADMIN_ENABLED=true`, variável de servidor. Só esse valor liga o painel; ausente ou com qualquer outro valor, não há item de menu, botão, página (`/admin/stand-by` responde 404) nem rota. Desligar a variável é o botão de emergência: as reservas já em Stand-by continuam protegidas pelas travas da etapa 2 e podem ser resolvidas depois.

## E-mail de reagendamento

Etapa 4. Quando uma reserva em Stand-by é reagendada — pelo painel, e pelo cliente quando o autoatendimento existir (etapa 5) — o cliente recebe um e-mail de confirmação com a turma nova.

| Ação | E-mail |
| --- | --- |
| Reagendar uma reserva em Stand-by (admin ou cliente) | **Sim**, um por reagendamento |
| Colocar em Stand-by | Não |
| Gerar ou revogar link | Não |
| Desfazer o Stand-by (volta à turma original) | Não |
| Reagendamento tradicional ("Alterar turma") | Não — continua como era |

O e-mail de confirmação de pagamento não é reenviado em nenhum caso: ele tem a fila dele (`integration_sync_jobs`), que esta etapa não lê nem escreve.

### Conteúdo

Assunto `Reagendamento confirmado — <código>`. Mesma moldura, rodapé e bloco de QR dos e-mails que já existem. Traz o nome do cliente, o código original da reserva, a experiência, a data, o horário (em Brasília), a base, o local de encontro com endereço e o botão do mapa, a quantidade de participantes, o QR Code — o mesmo de antes, que passa a valer na turma nova — e o aviso de que o pagamento continua válido e nada precisa ser pago de novo. Nenhuma reserva ou cobrança é criada.

Duas escolhas deliberadas:

- **O link do mapa só aparece quando a base tem um cadastrado** (`bases.maps_url`). O Lago Norte não tem; o endereço sai em texto, como no e-mail de pagamento.
- **A política de cancelamento fica de fora.** O que vale para uma reserva reagendada é decisão da operação, e o e-mail não a antecipa.

`pnpm email:preview` gera `.preview/reagendamento-<base>.html` e `.txt`, sem enviar nada.

### De onde vem o envio

Um reagendamento efetivo é uma linha em `reservation_session_changes` com `origin = 'STANDBY_RESCHEDULE'`, gravada por `reservation_standby_resolve` depois de a reserva voltar a `CONFIRMED` na turma nova. Existe no máximo uma por autorização.

A trigger `reservation_session_changes_reschedule_email` insere, **na mesma transação**, uma linha em `reservation_reschedule_emails`. Daí saem três garantias que não dependem da aplicação:

- **Um evento por reagendamento efetivo.** `change_id` é único. A requisição repetida, que o núcleo devolve com `replayed = true`, não escreve nada e não gera segundo evento.
- **Nenhum envio quando a transação falha.** Se algo falhar depois — auditoria, invariante — o reagendamento e a linha da fila são desfeitos juntos. O inverso também vale: se a linha da fila não puder ser gravada, o reagendamento não acontece.
- **Só o reagendamento.** Desfazer grava `STANDBY_RESTORE` e a troca tradicional grava `DIRECT`; a trigger ignora as duas.

Não há evento retroativo: reagendamento feito antes da migration não entra na fila.

**Por que uma fila própria.** `integration_sync_jobs` é uma linha por reserva, só aceita entidade `RESERVATION` ou `SESSION` e a linha nasce quando alguém reivindica o envio. Aqui a chave precisa ser o reagendamento (a mesma reserva pode ser reagendada mais de uma vez), e a linha precisa nascer na transação, antes de existir quem envie. Reaproveitar a linha do e-mail de pagamento seria reusar a chave de idempotência dele.

### A fila

| Estado | Significa |
| --- | --- |
| `QUEUED` | Nasceu com o reagendamento; ninguém tentou enviar ainda |
| `SENDING` | Reivindicado; ninguém mais envia até `locked_until` |
| `SENT` | O provedor aceitou. Definitivo |
| `FAILED` | A última tentativa falhou; `last_error_code` diz por quê |
| `SKIPPED` | Não enviado de propósito, e nunca será. Definitivo |

Só envia quem reivindica, e a reivindicação é uma única função (`reservation_reschedule_email_take`), que trava a linha antes de decidir:

- **Um envio por vez.** A reivindicação dura 15 minutos. Requisição repetida, clique duplo, a rotina agendada e o botão do painel no mesmo instante terminam em um e-mail.
- **Só se ainda descrever a reserva.** Antes de cada tentativa: a reserva continua `CONFIRMED`, na turma daquele reagendamento, sem troca posterior, e a turma ainda não começou. Senão vira `SKIPPED` com o motivo — `RESERVATION_NOT_CONFIRMED`, `SUPERSEDED` ou `SESSION_STARTED`. É o que impede um e-mail atrasado de anunciar uma data que já não vale.
- **Três tentativas automáticas.** Depois disso, espera uma pessoa.

`reservation_reschedule_email_attempts` guarda uma linha por tentativa: quando começou, por onde (`RESCHEDULE`, `RETRY` ou `ADMIN`), como terminou (`SENT`, `FAILED`, `LEASE_EXPIRED`) e o código do erro. Só símbolos curtos são gravados; nenhuma resposta do provedor, e nenhum destinatário, chega ao banco ou ao log.

RLS ligada e nenhum acesso para `anon` ou `authenticated`. A service role só lê as tabelas; toda escrita passa por RPC.

### Recuperação de falhas

Uma falha de envio nunca desfaz o reagendamento: a reserva continua confirmada na turma nova e o e-mail fica na fila.

| Caminho | Quando | Lote |
| --- | --- | --- |
| Oportunista | Depois de um envio de reagendamento bem-sucedido | 2 |
| Rotina agendada | `GET /api/cron/confirmation-emails`, a mesma do e-mail de pagamento, logo depois dele | 10 |
| Painel | **Reenviar e-mail de reagendamento**, no detalhe da reserva | 1 |

A rotina é diária (limite do plano Hobby). O botão do painel não tem teto de tentativas, é restrito a ADMIN e OPERATOR e fica registrado em `admin_audit_log` (`RESERVATION_RESCHEDULE_EMAIL_RESEND`); ele pede o e-mail do reagendamento mais recente e não reenvia o que já saiu.

Três casos de borda, e o que acontece em cada um:

- **A instância morre no meio do envio.** A linha fica `SENDING`; passado o prazo, a próxima execução registra a tentativa como `LEASE_EXPIRED` e assume.
- **O provedor aceitou, mas o registro falhou.** A linha nunca vira `FAILED` — isso mandaria o mesmo e-mail de novo. O registro é repetido três vezes; se não der, o prazo vence e a nova tentativa vai com a mesma chave de idempotência (abaixo).
- **Uma tentativa lenta responde depois do prazo.** Se deu certo, o e-mail é marcado `SENT` mesmo assim. Se falhou, a falha fica no registro e não solta o envio que está em curso.

**Chave de idempotência no provedor.** Cada envio leva o cabeçalho `Idempotency-Key` do Resend: `reschedule-confirmation/<id da linha>` mais um resumo do corpo. Por 24 horas, a mesma chave com o mesmo conteúdo devolve a resposta do primeiro envio em vez de entregar outra vez. O e-mail de pagamento continua sem o cabeçalho, exatamente como era.

### No painel

Com o e-mail ativado, o modal de reagendamento avisa antes de confirmar que o cliente será notificado, e o aviso depois da ação diz o que aconteceu — enviado, pendente, ou "avise o cliente" quando o e-mail está desligado. No detalhe da reserva, cada entrada da seção "Stand-by" mostra o estado do e-mail daquele reagendamento.

### Ativação do e-mail

`STANDBY_RESCHEDULE_EMAIL_ENABLED=true`, variável de servidor, independente da do painel. Só esse valor liga o envio; exige também o provedor de e-mail configurado (`RESEND_API_KEY`, `EMAIL_FROM`).

Desligado, o reagendamento funciona igual e a linha fica `QUEUED`. **Ao ligar, a rotina envia o que estiver na fila e ainda for válido** — reserva confirmada naquela turma, turma no futuro. Antes de ligar, rode `supabase/diagnostics/reservation_reschedule_email_report.sql` para ver o que sairia.

Desligar a variável é o botão de emergência do e-mail e não afeta o painel.

## Planilha

Duas proteções, as duas no serviço central de sincronização (`runSheetSyncJob`), por onde passa todo job — o enviado na hora e o retomado da fila.

**Sessões históricas congeladas.** As 14 sessões anteriores a 19/08/2026 mantidas fora da planilha são identificadas pelo `session_id` completo em `lib/integrations/google-sheets/frozen-sessions.ts`. A proteção é permanente e baseada só nesses ids — sem regra por data ou prefixo. Para elas nenhuma sincronização lê ou escreve nada, venha de onde vier: pagamento, webhook repetido, reconciliação, cancelamento, Stand-by, reagendamento do Stand-by ou tradicional, botões manuais, jobs pendentes. Nas duas parcialmente presentes, as linhas existentes também não são reescritas.

Colocar em Stand-by uma reserva de uma dessas sessões funciona normalmente no banco; só a planilha não é tocada. Se a reserva for reagendada para uma turma futura, o registro dela na planilha passa a ser o da turma nova, sem reconstruir a sessão histórica e sem duplicar participante. Lista dos ids e detalhes em [google-sheets-integration.md](google-sheets-integration.md#sessões-históricas-congeladas).

**Modo "somente atualizar".** Uma reserva em Stand-by ainda aponta para a turma original. Para ela não criar a turma na planilha, a sincronização que parte dessa turma atualiza se a turma já estiver em `Sessões` e não escreve nada se não estiver. Vale para turmas comuns; cobre a entrada em Stand-by, o reagendamento, o cancelamento de reserva em Stand-by, os dois botões manuais e jobs pendentes. A confirmação de pagamento não consulta `reservation_standby`: o banco só é lido para reserva cancelada e para reconstrução de sessão. Detalhes em [google-sheets-integration.md](google-sheets-integration.md#stand-by-modo-somente-atualizar).

## Publicação

### Etapa 4 (e-mail de reagendamento)

Cada passo depende de autorização própria. Nenhum deles envia e-mail sozinho, exceto o último.

1. **Merge e deploy do código.** Sem a variável, o serviço responde "desligado" antes de tocar no banco ou no provedor. Publicado antes da migration, nada muda. O e-mail de pagamento segue idêntico: a única alteração no caminho dele é um cabeçalho que só é enviado quando a mensagem traz chave de idempotência — e a dele não traz.
2. `supabase/diagnostics/reservation_reschedule_email_preflight.sql` → `STANDBY_EMAIL_PREFLIGHT_OK | OK`.
3. Migration `202610150001_reservation_reschedule_email.sql`. Cria duas tabelas, uma trigger em `reservation_session_changes` e dez funções; não substitui o corpo de nenhuma função e não toca nenhuma linha. Criar as chaves estrangeiras e a trigger pede um lock breve em `reservations`, `sessions`, `reservation_standby` e `reservation_session_changes`: aplicar com `set local lock_timeout = '5s'`, como as anteriores.
4. `supabase/diagnostics/reservation_reschedule_email_postcheck.sql` → `STANDBY_EMAIL_POSTCHECK_OK | OK`. Rodado antes da migration, ele falha com "relation does not exist" em vez de aprovar.
5. **Ativação do painel**, se ainda não estiver ligado — é ele que permite reagendar. A partir daqui cada reagendamento grava uma linha `QUEUED`.
6. **Ativação do e-mail:** `STANDBY_RESCHEDULE_EMAIL_ENABLED=true` na Vercel, só em Production, seguido de um novo deploy. Antes, conferir a fila com `reservation_reschedule_email_report.sql`.

`FUNCOES_DE_APOIO` (`reservation_confirmation_email`, `is_active_admin`, `set_updated_at`) fica `ATENCAO`, sem bloquear, quando produção e repositório divergem no conteúdo: a migration só chama essas funções. `FUNCAO_QUE_GRAVA_O_REAGENDAMENTO` (`reservation_standby_resolve`) com conteúdo diferente é `FALHOU`.

Não testar reagendamento no Preview: ele usa o banco de produção e, com as variáveis de e-mail presentes, enviaria um e-mail de verdade.

**Rollback da etapa 4.** Desligar a variável e publicar de novo já interrompe os envios. Do banco: `supabase/rollback/202610150001_reservation_reschedule_email.rollback.sql` remove a trigger e as dez funções e mantém as duas tabelas, que são o registro do que foi enviado. E-mails ainda na fila deixam de sair. Para reverter também `202610140001` ou `202610130002`, este rollback vem primeiro. Reaplicar a migration depois devolve tudo; os reagendamentos feitos nesse intervalo ficam sem e-mail, e o postcheck avisa em `REAGENDAMENTOS_SEM_LINHA_NA_FILA`.

### Etapa 3 (painel) — migration aplicada, painel ainda desligado

Os passos 1 a 4 foram concluídos: a `202610140001` está em produção e o postcheck terminou em `STANDBY_PAINEL_POSTCHECK_OK | 0 falha(s), 0 ponto(s) de atenção | OK`. Falta só o passo 5, a ativação.

Cada passo depende de autorização própria. Nenhum deles liga o painel sozinho, exceto o último.

1. **Merge e deploy do código.** Sem a variável, o painel não existe. O que passa a valer na hora é a proteção da planilha: as 14 sessões históricas ficam congeladas para toda sincronização, e o modo "somente atualizar" age sobre turmas de origem de Stand-by — hoje, nenhuma.
2. `supabase/diagnostics/reservation_standby_admin_panel_preflight.sql` → `STANDBY_PAINEL_PREFLIGHT_OK | OK`.
3. Migration `202610140001_reservation_standby_admin_panel.sql`. Cria quatro funções e retira da service role a execução de `admin_reschedule_reservation_from_standby`; não trava tabela nem toca linha.
4. `supabase/diagnostics/reservation_standby_admin_panel_postcheck.sql` → `STANDBY_PAINEL_POSTCHECK_OK | OK`.
5. **Ativação:** `STANDBY_ADMIN_ENABLED=true` na Vercel, só em Production, seguido de um novo deploy.

**Como ler o preflight e o postcheck.** Cada linha vem `OK`, `ATENCAO` ou `FALHOU`. `FALHOU` interrompe. `ATENCAO` não bloqueia a migration, mas precisa ser lida antes de seguir: aparece quando uma função que a migration **não substitui** — o reagendamento tradicional, por exemplo — tem conteúdo diferente do repositório. A linha final fica `OK` sem nenhum `FALHOU` e diz quantos pontos de atenção existem.

As funções são comparadas pelo texto exato e pelo texto com o espaço em branco normalizado. Diferença só de formatação — LF ou CRLF, espaços, recuo — vira `IDENTICA_SO_FORMATACAO` e continua `OK`; palavra, operador ou número diferente é `DIFERENTE`. `DIFERENTE` é `FALHOU` para as quatro funções criadas e para as três que elas chamam, e `ATENCAO` para as que a migration não substitui.

`SERVICE_ROLE_LE_AS_AUTORIZACOES` confere que o servidor consegue ler `reservation_standby` (privilégio de leitura e RLS ignorada pela service role). Se falhar, a proteção da planilha leria a tabela vazia: não ativar.

Não testar operações de escrita no Preview: ele usa o banco de produção.

**Rollback da etapa 3.** Desligar a variável e publicar de novo já tira o painel do ar. Do banco: `supabase/rollback/202610140001_reservation_standby_admin_panel.rollback.sql` remove as quatro funções e devolve à service role a execução de `admin_reschedule_reservation_from_standby` — ou seja, o reagendamento de Stand-by sem regra de preço volta a ser alcançável pelo servidor, como era na etapa 2. Reservas em Stand-by não impedem o rollback e não são afetadas. Para reverter também a `202610130002`, este rollback vem primeiro.

Reaplicar `202610130002` depois de `202610140001` também devolve aquele privilégio (ela o concede); o postcheck do painel acusa em `REAGENDAMENTO_SEM_REGUA_FORA_DO_ALCANCE`, e reaplicar a `202610140001` corrige.

A proteção das sessões históricas é código, não banco: sai com o deploy e volta com ele. Reverter o deploy para uma versão anterior a esta tira a proteção.

### Etapa 2 (fundação) — concluída

Ordem em que foi feita.

1. **Merge e deploy do código** desta etapa. Inofensivo com o banco atual.
2. `supabase/diagnostics/reservation_standby_preflight.sql` — precisa terminar em `STANDBY_PREFLIGHT_OK | OK`.
3. Migration `202610130001`, sozinha.
4. Migration `202610130002`, em outra execução.
5. `supabase/diagnostics/reservation_standby_postcheck.sql` — precisa terminar em `STANDBY_POSTCHECK_OK | OK`.

Depois do passo 5 o comportamento do sistema continua o mesmo: o status só pode ser gravado pelas RPCs novas, que nenhuma tela chama. A ativação vem com as etapas 3 (painel) e 5 (cliente).

**Rollback.** Do código: reverter o deploy — mas, depois que existir reserva em Stand-by, nunca para uma versão anterior a esta. Do banco: `supabase/rollback/202610130002_reservation_standby.rollback.sql`, que recusa enquanto houver Stand-by aberto, restaura as sete funções substituídas e remove as operações. O valor do enum não pode ser removido e fica inerte; a tabela e o histórico são mantidos.

## Testes

`tests/reservation-reschedule-email.test.ts` cobre a etapa 4 contra o mesmo Postgres em memória, com o fluxo de envio de produção ligado a um provedor falso: o evento (um por reagendamento, nenhum nas outras ações, nenhum quando a transação falha), a reivindicação (simultânea, vencida, esgotada), a recuperação de falhas, a régua do "ainda vale", o conteúdo, a ativação, a chave de idempotência do provedor, preflight, postcheck, relatório e rollback. Nenhum teste envia e-mail.

`tests/reservation-standby-admin.test.ts` cobre a etapa 3 contra o mesmo Postgres em memória — funções do painel, autorização de cada operação, paginação acima de 500, régua do mesmo valor, links, auditoria — e a planilha, com snapshots lidos do banco e sincronizados contra a planilha falsa. `tests/reservation-standby-panel.test.ts` cobre ativação, validação, contratos das rotas e a regra do modo "somente atualizar".

`tests/reservation-standby.test.ts` roda contra um Postgres real em memória, com todas as migrations aplicadas; `tests/reservation-standby-payments.test.ts` roda `confirmPayment` de verdade contra o duplo de pagamentos. Cobrem entrada, desfazer, reagendamento, uso único, repetição, disputa de vaga, rollback em falha, check-in e QR, receita, links, grants, preflight, postcheck e rollback.

Limite conhecido: o banco de teste tem uma única conexão. A ordem de chegada de duas requisições e o estado que cada uma encontra são exercitados; a espera real no `FOR UPDATE` entre duas sessões do Postgres, não. A ordem dos locks é verificada como contrato do SQL.

## Pendências

- **Teste de concorrência com duas conexões** antes de ativar: o banco de teste tem uma só. Vale também para a fila do e-mail — a espera real no lock da linha não é exercitada.
- **Etapa 5 — autoatendimento**, com limite de tentativas e checagem de origem. É quando a página pública passa a ler o link individual. A rota do cliente precisa chamar `sendRescheduleConfirmationEmail(changeId)` depois do reagendamento, como a do painel faz; a linha da fila já é gravada pelo banco nos dois caminhos, então sem a chamada o e-mail sai na rotina do dia seguinte, não some.
- **Política de cancelamento de reserva reagendada:** definir, e então decidir se entra no e-mail.
- **Link do mapa do Lago Norte:** preencher `bases.maps_url` faz o botão aparecer em todos os e-mails.
- **Ambiente de teste de ponta a ponta:** o Preview da Vercel usa o banco de produção e não pode ser usado para operações de escrita.
