# Lista de espera

[README](../README.md) · [Banco de dados](database.md) · [Stand-by](reservation-standby.md)

**Estado (25/10/2026): fase 1 (fundação no banco) aplicada e validada em produção. Fase 2 (turmas esgotadas no site) no repositório, desligada** — só aparece com `WAITLIST_PUBLIC_ENABLED=true`. Ninguém se inscreve, nenhum e-mail sai e nada é agendado.

## O que é

Quando uma turma esgota, ela continua no site como "Esgotado" e o cliente pode entrar, de graça, na lista de espera daquela turma (experiência, base, data e horário). Se abrir vaga, quem está na lista recebe um e-mail com o link para reservar normalmente: checkout e pagamento de sempre.

**A lista não reserva nem bloqueia vaga (opção A).** A vaga reaberta continua no site para qualquer pessoa, e fica com quem concluir primeiro a reserva e o pagamento, pelos controles de sempre (`create_pre_reservation`). O e-mail de vaga vai dizer que a disponibilidade não está garantida. A lista nunca cria reserva nem pagamento.

## Regras aprovadas

| Decisão | Regra |
| --- | --- |
| D1 — agendador do envio | **Ainda não escolhido.** O envio fica desligado até a decisão |
| D2 — ondas | Por ordem de inscrição, até `max(5, 3 × vagas)` por onda |
| D3 — repetição | No máximo 3 avisos de vaga por inscrição, com pelo menos 12 horas entre eles |
| D4 — quando oferecer | Só com a turma em zero vagas |
| D5 — abuso | Limite de tentativas, checagem de origem e campo isca |
| D6 — retenção | Nome, e-mail e telefone anonimizados 90 dias depois da turma |

Também valem: uma inscrição ativa por e-mail e turma; o grupo precisa caber na turma inteira (1 a 20 pessoas e no máximo a capacidade); cancelamento pelo próprio cliente por link seguro; inscrição encerrada quando a turma começa.

## Fases

| Fase | O que entrega | Estado |
| --- | --- | --- |
| 1. Fundação no banco | Tabelas, funções, limite de tentativas, preflight, postcheck, rollback e testes | Aplicada em produção |
| 2. "Esgotado" no site | Landing e agenda passam a usar `list_public_sessions`, atrás de variável | No repositório, desligada |
| 3. Inscrição, confirmação e cancelamento | Formulário, `POST` da inscrição, e-mail `JOINED`, página do link | — |
| 4. Painel | `/admin/lista-de-espera` sobre as funções `admin_*` desta fase | — |
| 5. Detecção de vagas | Abertura e fechamento de `waitlist_openings` e enfileiramento pela régua | — |
| 6. Envio dos avisos | Fila `SPOT_AVAILABLE`, conferência da vaga antes de enviar e gatilhos (D1) | — |
| 7. Retenção e operação | Rotina de anonimização e diagnósticos | — |

## Fase 1 — fundação no banco

Migration `202610250001_waitlist_foundation.sql`. É aditiva e idempotente: **não substitui o corpo de nenhuma função existente**, não cria trigger em tabela existente e não toca nenhuma linha. `list_open_sessions`, `get_booking_session`, `available_spots`, `create_pre_reservation`, pagamento e Stand-by continuam iguais (o teste compara o corpo de todas as funções antes e depois).

### Tabelas

Todas com RLS ligada, sem policy e **sem nenhum privilégio para `anon`, `authenticated` ou mesmo `service_role`** — inclusive a sequência da ordem da fila, que o Supabase também abriria por padrão. Tudo passa por funções `security definer` com `search_path` fixo.

| Tabela | Guarda |
| --- | --- |
| `waitlist_entries` | Uma linha por inscrição: turma (`session_id`), nome, e-mail, WhatsApp, quantidade, status, ordem na fila (`queue_sequence`), hash do link de cancelamento, contadores de aviso, conversão, encerramento e anonimização |
| `waitlist_openings` | Preparada para a fase 5: cada período em que uma turma esgotada voltou a ter vaga. No máximo uma aberta por turma |
| `waitlist_notifications` | A fila dos dois e-mails (`JOINED` e `SPOT_AVAILABLE`), no desenho da fila de reagendamento: reivindicação com prazo, espera entre tentativas, geração da chave de idempotência e mensagem congelada. Um `JOINED` por inscrição e um `SPOT_AVAILABLE` por inscrição e abertura |
| `waitlist_notification_attempts` | Preparada: uma linha por tentativa de envio, só com símbolos curtos |
| `waitlist_throttle`, `waitlist_throttle_secret` | Limite de tentativas próprio, com baldes em HMAC e segredo de 32 bytes gerado na migration |

**Status da inscrição:** `ACTIVE` (esperando), `CONVERTED` (o mesmo e-mail reservou e pagou aquela turma depois de se inscrever), `CANCELLED` (o cliente cancelou), `REMOVED` (a equipe removeu, com motivo) e `EXPIRED` (a turma começou, foi cancelada ou foi arquivada). Uma inscrição `ACTIVE` de turma que já começou é lida como `EXPIRED` por todas as funções, antes mesmo de alguém gravar.

**Por que `on delete cascade` em `session_id`.** Só se entra em turma esgotada, e uma turma esgotada sempre tem reservas: o banco já proíbe excluí-la (ela é arquivada) e trocar a experiência dela. O cascade existe só para que uma exclusão de sessão nunca falhe por causa da lista.

### Funções

| Função | Quem executa | Faz |
| --- | --- | --- |
| `list_public_sessions(slug)` | Pública, como `list_open_sessions` | As turmas de `list_open_sessions` **mais as esgotadas**, com as mesmas colunas e `sold_out`. Só exibição: reservar continua passando por `get_booking_session` e `create_pre_reservation` |
| `waitlist_join(sessão, nome, e-mail, telefone, quantidade, origem, isca)` | Service role | Inscrição. Devolve um status, nunca lança por entrada do cliente |
| `waitlist_cancel_overview(token, origem)` | Service role | O que a página do link mostra: estado, turma, quantidade e primeiro nome |
| `waitlist_cancel(token, origem)` | Service role | Cancela. Idempotente |
| `admin_waitlist_sessions(ator, incluir_passadas)` | Service role + admin | Turmas com inscrições, com totais |
| `admin_list_waitlist_entries_page(ator, sessão, base, status, busca, limite, deslocamento)` | Service role + admin | Lista paginada no banco, na ordem da fila, com a posição de cada inscrição ativa |
| `admin_waitlist_entry(ator, inscrição)` | Service role + admin | Detalhe, avisos com tentativas e ações da equipe |
| `admin_remove_waitlist_entry(ator, inscrição, motivo)` | Service role + admin | Remove, com motivo na auditoria. Idempotente |
| `waitlist_expire_entries`, `waitlist_mark_conversions`, `waitlist_anonymize_entries` | Ninguém (só o dono) | Manutenção. Prontas, testadas, **sem agendamento** |
| `waitlist_eligible_entries(sessão, vagas)`, `waitlist_wave_size(vagas)` | Ninguém | A régua de D2 e D3, para a fase 5 |
| `waitlist_cancel_token`, `waitlist_token_hash`, `waitlist_effective_status`, `waitlist_skip_pending_notifications`, `register_waitlist_attempt` | Ninguém | Apoio interno |

As funções do painel exigem ADMIN ou OPERATOR ativo (`is_active_admin`), como as de Stand-by. O ator vem da sessão validada no servidor, nunca do navegador.

### Inscrição

`waitlist_join` responde com um destes status:

| Status | Quando |
| --- | --- |
| `ACCEPTED` | Inscrito. **Também** quando o e-mail já está na lista daquela turma (nada é gravado e nenhuma confirmação nova nasce) e quando o campo isca veio preenchido (nada é gravado). A resposta é idêntica nos três casos e não revela quem está inscrito |
| `RATE_LIMITED` | Passou do limite; traz `retryAfterSeconds` |
| `INVALID` | Campo inválido; traz `field` (`fullName`, `email`, `phone` ou `quantity`) |
| `SESSION_UNAVAILABLE` | Turma inexistente, fechada, cancelada, arquivada, já iniciada ou de experiência não publicada |
| `NOT_SOLD_OUT` | A turma tem vaga: o caminho é reservar (D4). Traz `remainingSpots`, que o site já mostra |
| `LIMIT_REACHED` | O e-mail já tem 10 inscrições ativas em turmas que ainda não começaram (turma passada, cancelada ou arquivada não conta, mesmo antes da rotina de expiração) |
| `WAITLIST_FULL` | A turma já tem 100 inscrições ativas |

A confirmação por e-mail nasce **na mesma transação** da inscrição (`JOINED`, `QUEUED`). Nesta fase ninguém a envia. Quando o envio vier (fase 3), ele precisa conferir a inscrição de novo antes de cada tentativa: uma inscrição já encerrada tem a confirmação descartada (`SKIPPED`, `ENTRY_CLOSED`) no momento em que é encerrada.

**Concorrência.** A inscrição **não pede lock na turma**: a lista não disputa vaga com a reserva, e uma inscrição ao mesmo tempo que uma mudança de disponibilidade não tem consequência (opção A). A única espera possível vem da chave estrangeira para `sessions`: gravar a inscrição pega `FOR KEY SHARE` na sessão — o mesmo que gravar uma reserva —, o que espera o `FOR UPDATE` de uma pré-reserva em curso naquela turma, e vice-versa, pelo tempo de uma chamada. Não há ciclo possível, porque a pré-reserva não toca nada da lista; o teste de concorrência confere que as duas terminam. O mesmo e-mail é serializado por um advisory lock da transação, e o índice único parcial `(session_id, email) where status = 'ACTIVE'` é a barreira final.

### Limite de tentativas

No banco, compartilhado entre as instâncias, em janelas fixas. Toda tentativa conta, inclusive a barrada e a inválida.

| Ação | Balde | Limite |
| --- | --- | --- |
| Inscrição | Origem, só quando há endereço confiável | 30 por hora |
| Inscrição | E-mail | 6 por hora |
| Ver ou cancelar pelo link | Origem, só quando há endereço confiável | 30 a cada 15 minutos |

A origem é folgada de propósito: operadora móvel (CGNAT) e Wi-Fi compartilhado põem muitos clientes atrás do mesmo endereço. O balde do e-mail limita quantas confirmações alguém consegue disparar para a caixa de outra pessoa. Junto com o teto de 10 inscrições ativas por e-mail, e sem o link de cancelamento (que só o dono da caixa recebe), não há como fazer um ciclo inscreve-cancela-inscreve na caixa alheia. Sem endereço confiável não existe balde de origem, como no limite da consulta de reservas. O endereço vem de `trustedClientAddress` (`lib/http/client-address.ts`), que a rota da fase 3 vai usar.

É um limite **separado** do `register_customer_access_attempt`: aquele protege CPF + código, com outros números, e tem rollback próprio.

### Link de cancelamento

O token tem 64 caracteres hexadecimais: um HMAC-SHA256 do id da inscrição com o segredo da lista. **Ele não é guardado em lugar nenhum.** A inscrição guarda só o SHA-256 dele, para ser encontrada, e quem montar o e-mail recalcula o token (`waitlist_cancel_token`, sem permissão para a API). O formato previsto para a URL é `/lista-de-espera#t=<token>`: o fragmento não chega ao servidor, então não aparece em log nem em pré-visualização de link.

Ver e cancelar são **dois passos**, os dois por POST: um leitor de e-mail que abre os links sozinho nunca cancela nada. A leitura não traz e-mail, telefone, sobrenome nem id interno. Trocar o segredo invalida todos os links.

### Retenção

`waitlist_anonymize_entries` apaga nome, e-mail e telefone das inscrições de turmas que começaram há mais de 90 dias e as mensagens congeladas da fila. A linha fica, sem dado pessoal, para as contagens e o histórico de avisos. Os baldes do limite são HMAC e são apagados depois de um dia parados. A auditoria das remoções não leva dado pessoal nos metadados; o motivo é texto livre da equipe.

## Fase 2 — turmas esgotadas no site

Só código de aplicação, sem migration. Atrás de `WAITLIST_PUBLIC_ENABLED`, variável de servidor desligada por padrão: só o valor exato `true` liga.

### Com a variável desligada (padrão)

O site é o de antes. Agenda, grade de datas e destaque de horários leem `list_open_sessions`, que só devolve turma com vaga; a página de reserva de uma turma esgotada diz "Sessão indisponível". As duas únicas diferenças valem para qualquer valor da variável e não mudam o que o cliente vê:

- a página de reserva confere `remainingSpots >= 1` antes de mostrar o formulário (`get_booking_session` já garantia isso; é a segunda barreira);
- a recusa por falta de vaga em `POST /api/reservations` (409) ganha os campos `code` e, para `INSUFFICIENT_SPOTS`, `remainingSpots` — lidos por `get_booking_session`, só leitura, antes de qualquer checkout. A mensagem é a mesma, e o formulário só usa os campos novos com a variável ligada.

### Com a variável ligada

| Onde | O que muda |
| --- | --- |
| Página da experiência (grade de datas) | Turmas esgotadas aparecem no dia delas, com o horário em destaque, o selo **Esgotado** e "Todas as vagas desta turma já foram reservadas." O cartão **não é link**: nada leva a `/reservar`. As turmas com vaga são exatamente as de antes |
| Destaque "Turmas disponíveis" | Os horários das esgotadas continuam listados: é a agenda da experiência |
| Filtro por data | Conta e mostra as esgotadas do dia escolhido |
| Agenda geral | Cartão da esgotada com **Esgotado** no lugar das vagas e o aviso no lugar do botão |
| `/reservar/[id]` de turma esgotada | "Turma esgotada", com o horário, e links para outras turmas e para a agenda. Nunca o formulário |
| Formulário, se esgotar enquanto o cliente preenche | O envio é recusado pelo banco (`create_pre_reservation`, como sempre) e o formulário dá lugar ao aviso de esgotado: nenhuma vaga foi bloqueada e nada foi cobrado. Se sobrou menos vaga do que o pedido, a quantidade é reduzida ao que sobrou e o cliente envia de novo |

Fonte das turmas: `list_public_sessions`, da fase 1, com as mesmas regras de `list_open_sessions` (experiência publicada, turma aberta e futura). Se a função não existir no banco — migration revertida —, o site volta sozinho para `list_open_sessions` e registra só o símbolo `LIST_PUBLIC_SESSIONS_MISSING`.

**O lugar do botão "Entrar na lista de espera"** é o `action` do aviso (`components/waitlist/sold-out-notice.tsx`). Nesta fase nenhuma tela o preenche: não há botão, formulário, rota de inscrição nem e-mail.

### O que não muda

`list_open_sessions`, `get_booking_session`, `available_spots` e `create_pre_reservation` não foram tocadas, e a fase não traz migration. Checkout, pagamento, cancelamento, Stand-by, e-mails, planilha e painel continuam iguais. A disputa pela última vaga continua sendo decidida pelo banco, com a sessão travada.

### Ativação

1. Merge e deploy: com a variável ausente, nada muda para o cliente.
2. `WAITLIST_PUBLIC_ENABLED=true` na Vercel, **só em Production**, seguido de novo deploy.
3. Conferir uma turma esgotada na agenda e na página da experiência, e abrir `/reservar/<id>` dela.

Desligar a variável e publicar de novo é o botão de emergência. A fase só lê o banco: mesmo no Preview, que usa o banco de produção, ligar a variável não escreve nada.

## Publicação da fase 1

Cada passo depende de autorização própria. **Nenhum deles liga nada no site.**

1. **Merge e deploy do código.** Não há código de aplicação nesta fase: só a migration, os diagnósticos, o rollback, os testes e a documentação. O deploy não muda nada.
2. `supabase/diagnostics/waitlist_foundation_preflight.sql` → `WAITLIST_FUNDACAO_PREFLIGHT_OK | OK`. Guarde `ASSINATURA_DAS_FUNCOES_EXISTENTES` e as contagens.
3. Migration `202610250001_waitlist_foundation.sql`, com `begin;` + `set local lock_timeout = '5s';` no topo e `commit;` no fim. Cria seis tabelas e dezoito funções. As chaves estrangeiras pedem um lock breve em `sessions` e `reservations`.
4. `supabase/diagnostics/waitlist_foundation_postcheck.sql` → `WAITLIST_FUNDACAO_POSTCHECK_OK | OK`, com a mesma assinatura e as mesmas contagens do preflight. Rodado antes da migration, ele falha com "relation does not exist" em vez de aprovar.

Depois do passo 4 o sistema se comporta igual: nenhuma rota chama as funções novas, e nada é agendado.

**Como ler os diagnósticos.** Cada linha vem `OK`, `ATENCAO` ou `FALHOU`. No preflight, `available_spots`, `list_open_sessions` ou `get_booking_session` diferentes do repositório são `FALHOU`: a turma "esgotada" mostrada pela lista poderia não ser a mesma que a reserva recusa. `is_active_admin` ou `set_updated_at` diferentes são `ATENCAO`. Diferença só de formatação é aceita. O postcheck confere ainda que as listagens com vaga de `list_public_sessions` e de `list_open_sessions` são idênticas para toda experiência publicada (`LISTA_PUBLICA_COERENTE_COM_A_RESERVA`), e que nenhum agendamento com o nome da lista existe.

Não testar escrita no Preview: ele usa o banco de produção.

**Rollback.** `supabase/rollback/202610250001_waitlist_foundation.rollback.sql` remove as dezoito funções e as seis tabelas, e mais nada. **Recusa enquanto houver inscrição ativa** (`WAITLIST_ROLLBACK_REFUSED`): apagar a lista com clientes esperando é decisão de produto. Linhas de auditoria das remoções ficam. Reaplicar a migration cria um segredo novo: links antigos param de valer.

## Testes

- `tests/waitlist-foundation.test.ts`: Postgres em memória com todas as migrations, 46 testes. Migration aditiva e idempotente; tabelas e sequência fechadas inclusive para a service role, também com os privilégios padrão do Supabase ligados; permissões de cada função; `list_public_sessions` igual a `list_open_sessions` mais as esgotadas, com as mesmas regras e colunas; esgotamento por pré-reserva válida, vaga devolvida por expiração e por Stand-by; inscrição (D4, turma indisponível, validação, normalização, duplicidade com resposta idêntica, reinscrição, campo isca, tetos por e-mail e por turma contando só quem ainda espera); a lista não escreve em reservas nem trava sessões; limites (origem, e-mail, cancelamento, HMAC, janela); cancelamento (dois passos, sem dado pessoal, idempotente, token não guardado, turma iniciada); painel (autorização, ordem da fila, posição, filtros, busca literal, paginação, totais, remoção com auditoria sem dado pessoal, detalhe); expiração, conversão e anonimização; régua das ondas (D2) e dos limites de aviso (D3); constraints; exclusão de sessão; preflight, postcheck e rollback.
- `tests/waitlist-foundation-concurrency.test.ts`: **sessões independentes do Postgres**, só no CI (contêiner efêmero do job). O mesmo e-mail em duas abas (com a primeira confirmando ou desistindo), a inscrição ao lado de uma pré-reserva que trava a turma (nas duas ordens: a espera é curta e as duas terminam), rajada de 36 tentativas da mesma origem (exatamente 30 aceitas) e cancelamentos simultâneos, do cliente com o cliente e do cliente com a equipe.

- `tests/waitlist-public-sessions.test.ts` (fase 2): variável; regras de exibição (reservável só com vaga, quantidades, corrida entre página e envio); leitura contra o Postgres em memória — desligada é exatamente `list_open_sessions`, ligada acrescenta só as esgotadas, vaga devolvida tira a marca, função ausente cai para a leitura de sempre; e, no código-fonte, que nenhum caminho de turma esgotada leva a `/reservar`, que o formulário nunca aparece sem vaga e que nada de inscrição, e-mail ou agendamento entrou.

## Pendências

- **D1, o agendador do envio**, antes da fase 6. As opções estão em [reservation-standby.md](reservation-standby.md#recuperação-de-falhas).
- **Fase 3:** a rota de inscrição precisa checar a origem, ler o endereço só de `trustedClientAddress` e responder sem cache.
- **Fase 3/6:** as funções que operam a fila (reivindicar, congelar, concluir, falhar) e a montagem do e-mail com o link de cancelamento.
- **Fase 7:** agendar `waitlist_expire_entries`, `waitlist_mark_conversions` e `waitlist_anonymize_entries`.
