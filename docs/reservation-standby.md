# Stand-by de reservas e reagendamento

[README](../README.md) · [Banco de dados](database.md) · [Pagamentos](payments.md) · [Painel](admin.md)

**Estado: fundação (etapa 2 de 6).** O banco e as travas existem no repositório; **nenhuma tela coloca uma reserva em Stand-by** e nenhuma migration desta entrega foi aplicada em produção. Mergear o PR não aplica migration; aplicar a migration não ativa o Stand-by.

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
8. **Planilha:** as 14 sessões históricas fora da planilha não são reinseridas (proteção a concluir na etapa 3 — ver [Pendências](#pendências)).

O admin, ao reagendar uma reserva em Stand-by, segue as regras do reagendamento tradicional: sem regra de preço.

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
| `admin_reschedule_reservation_from_standby(actor, reserva, sessão, motivo)` | Reagenda pelo admin. |
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

## Publicação

Ordem segura. Cada passo depende de autorização própria.

1. **Merge e deploy do código** desta etapa. Inofensivo com o banco atual.
2. `supabase/diagnostics/reservation_standby_preflight.sql` — precisa terminar em `STANDBY_PREFLIGHT_OK | OK`.
3. Migration `202610130001`, sozinha.
4. Migration `202610130002`, em outra execução.
5. `supabase/diagnostics/reservation_standby_postcheck.sql` — precisa terminar em `STANDBY_POSTCHECK_OK | OK`.

Depois do passo 5 o comportamento do sistema continua o mesmo: o status só pode ser gravado pelas RPCs novas, que nenhuma tela chama. A ativação vem com as etapas 3 (painel) e 5 (cliente).

**Rollback.** Do código: reverter o deploy — mas, depois que existir reserva em Stand-by, nunca para uma versão anterior a esta. Do banco: `supabase/rollback/202610130002_reservation_standby.rollback.sql`, que recusa enquanto houver Stand-by aberto, restaura as sete funções substituídas e remove as operações. O valor do enum não pode ser removido e fica inerte; a tabela e o histórico são mantidos.

## Testes

`tests/reservation-standby.test.ts` roda contra um Postgres real em memória, com todas as migrations aplicadas; `tests/reservation-standby-payments.test.ts` roda `confirmPayment` de verdade contra o duplo de pagamentos. Cobrem entrada, desfazer, reagendamento, uso único, repetição, disputa de vaga, rollback em falha, check-in e QR, receita, links, grants, preflight, postcheck e rollback.

Limite conhecido: o banco de teste tem uma única conexão. A ordem de chegada de duas requisições e o estado que cada uma encontra são exercitados; a espera real no `FOR UPDATE` entre duas sessões do Postgres, não. A ordem dos locks é verificada como contrato do SQL.

## Pendências

- **Etapa 3 — painel.** Botões, lista, geração de link e o modo "somente atualizar" da planilha para a turma de origem. Sem essa proteção, sincronizar uma reserva de uma das 14 sessões históricas criaria as linhas dela na planilha; por isso nenhuma operação de Stand-by é chamada pelo código ainda.
- **Etapa 4 — e-mail** de reagendamento confirmado.
- **Etapa 5 — autoatendimento**, com limite de tentativas e checagem de origem.
- **Ambiente de teste de ponta a ponta:** o Preview da Vercel usa o banco de produção e não pode ser usado para operações de escrita.
