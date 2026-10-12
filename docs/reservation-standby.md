# Stand-by de reservas e reagendamento

[README](../README.md) · [Banco de dados](database.md) · [Pagamentos](payments.md) · [Painel](admin.md)

**Estado: painel administrativo (etapa 3 de 6), desligado por padrão.** As migrations `202610130001` e `202610130002` estão aplicadas em produção. O painel desta etapa só existe com `STANDBY_ADMIN_ENABLED=true`; a migration `202610140001`, de que ele depende, ainda não foi aplicada. Mergear o PR não aplica migration nem liga o painel.

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
8. **Planilha:** as sessões históricas fora da planilha não são reinseridas, nem reescritas. Elas ficam congeladas por `session_id`, para toda sincronização; e a sincronização que parte da turma de origem de um Stand-by só atualiza o que já existe — ver [Planilha](#planilha).
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

Nenhuma destas ações envia e-mail.

### Auditoria

O detalhe da reserva ganha a seção "Stand-by": um bloco por entrada (quem colocou, motivo, data, turma de origem e de destino, como saiu e por quem) e a lista das ações registradas, inclusive geração e revogação de link. `admin_reservation_standby_history` não devolve token, hash nem os metadados da auditoria.

### Autorização

As rotas ficam em `/api/admin/reservations/[reservationId]/standby` (`GET` e `POST`), `.../standby/undo`, `.../standby/reschedule` e `.../standby/link` (`POST` e `DELETE`). Todas passam por `authorizeStandbyApi`: 404 com o painel desligado; 401 sem sessão; 403 para instrutor. As mutações conferem a origem antes de tudo. O ator vem da sessão validada, e cada RPC confere de novo `is_active_admin`.

### Ativação

`STANDBY_ADMIN_ENABLED=true`, variável de servidor. Só esse valor liga o painel; ausente ou com qualquer outro valor, não há item de menu, botão, página (`/admin/stand-by` responde 404) nem rota. Desligar a variável é o botão de emergência: as reservas já em Stand-by continuam protegidas pelas travas da etapa 2 e podem ser resolvidas depois.

## Planilha

Duas proteções, as duas no serviço central de sincronização (`runSheetSyncJob`), por onde passa todo job — o enviado na hora e o retomado da fila.

**Sessões históricas congeladas.** As sessões anteriores a 19/08/2026 mantidas fora da planilha são identificadas pelo `session_id` completo em `lib/integrations/google-sheets/frozen-sessions.ts`. Para elas nenhuma sincronização lê ou escreve nada, venha de onde vier: pagamento, reconciliação, cancelamento, Stand-by, reagendamento do Stand-by ou tradicional, botões manuais, jobs pendentes. Nas duas parcialmente presentes, as linhas existentes também não são reescritas. Estão registradas as duas sessões de 15/08/2026; as outras doze dependem do id completo — ver [Pendências](#pendências). Detalhes em [google-sheets-integration.md](google-sheets-integration.md#sessões-históricas-congeladas).

**Modo "somente atualizar".** Uma reserva em Stand-by ainda aponta para a turma original. Para ela não criar a turma na planilha, a sincronização que parte dessa turma atualiza se a turma já estiver em `Sessões` e não escreve nada se não estiver. Vale para turmas comuns; cobre a entrada em Stand-by, o reagendamento, o cancelamento de reserva em Stand-by, os dois botões manuais e jobs pendentes. A confirmação de pagamento não consulta `reservation_standby`: o banco só é lido para reserva cancelada e para reconstrução de sessão. Detalhes em [google-sheets-integration.md](google-sheets-integration.md#stand-by-modo-somente-atualizar).

## Publicação

### Etapa 3 (painel)

Cada passo depende de autorização própria. Nenhum deles liga o painel sozinho, exceto o último.

1. **Merge e deploy do código.** Sem a variável, o painel não existe. O que passa a valer na hora é a proteção da planilha: as sessões históricas registradas ficam congeladas para toda sincronização, e o modo "somente atualizar" age sobre turmas de origem de Stand-by — hoje, nenhuma.
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

`tests/reservation-standby-admin.test.ts` cobre a etapa 3 contra o mesmo Postgres em memória — funções do painel, autorização de cada operação, paginação acima de 500, régua do mesmo valor, links, auditoria — e a planilha, com snapshots lidos do banco e sincronizados contra a planilha falsa. `tests/reservation-standby-panel.test.ts` cobre ativação, validação, contratos das rotas e a regra do modo "somente atualizar".

`tests/reservation-standby.test.ts` roda contra um Postgres real em memória, com todas as migrations aplicadas; `tests/reservation-standby-payments.test.ts` roda `confirmPayment` de verdade contra o duplo de pagamentos. Cobrem entrada, desfazer, reagendamento, uso único, repetição, disputa de vaga, rollback em falha, check-in e QR, receita, links, grants, preflight, postcheck e rollback.

Limite conhecido: o banco de teste tem uma única conexão. A ordem de chegada de duas requisições e o estado que cada uma encontra são exercitados; a espera real no `FOR UPDATE` entre duas sessões do Postgres, não. A ordem dos locks é verificada como contrato do SQL.

## Pendências

- **Doze `session_id` completos.** O documento do incidente registra as 14 sessões históricas só pelo prefixo. As duas presentes na planilha estão congeladas; as outras doze precisam do id completo, que vem do Supabase com `supabase/diagnostics/google_sheets_historical_sessions.sql`. Até lá, essas doze estão protegidas apenas nas sincronizações de Stand-by — e não em pagamento repetido, cancelamento comum, "Alterar turma" ou botão manual. **Completar antes de ativar o painel.**
- **Teste de concorrência com duas conexões** antes de ativar: o banco de teste tem uma só.
- **Etapa 4 — e-mail** de reagendamento confirmado.
- **Etapa 5 — autoatendimento**, com limite de tentativas e checagem de origem. É quando a página pública passa a ler o link individual.
- **Ambiente de teste de ponta a ponta:** o Preview da Vercel usa o banco de produção e não pode ser usado para operações de escrita.
