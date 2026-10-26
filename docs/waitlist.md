# Lista de espera

[README](../README.md) · [Banco de dados](database.md) · [Stand-by](reservation-standby.md)

**Estado (26/10/2026): migrations `202610250001` e `202610250002` aplicadas em produção, com postcheck OK. Fases 2, 3 e 4 publicadas e desligadas** (`WAITLIST_PUBLIC_ENABLED`, `WAITLIST_SIGNUP_ENABLED` e `WAITLIST_ADMIN_ENABLED` ausentes). **Fase 5 (detecção de vagas) no repositório**, com a migration `202610260001` **não aplicada**, o interruptor desligado e nenhum agendamento. Nenhum aviso de vaga sai.

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
| 2. "Esgotado" no site | Landing e agenda passam a usar `list_public_sessions`, atrás de variável | Publicada, desligada |
| 3. Inscrição, confirmação e cancelamento | Formulário, `POST` da inscrição, e-mail `JOINED`, página do link | Publicada, desligada; migration aplicada |
| 4. Painel | `/admin/lista-de-espera` sobre as funções `admin_*` da fase 1 | Publicado, desligado; sem migration |
| 5. Detecção de vagas | `waitlist_scan()`: aberturas, ondas pela régua e avisos na fila, sem envio | Publicada; migration aplicada, desligada, sem agendamento |
| 6. Envio dos avisos | Fila `SPOT_AVAILABLE`, conferência da vaga antes de enviar, rota e agendamento proposto (D1) | No repositório; migration não aplicada, desligado, sem agendamento |
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

## Fase 3 — inscrição gratuita, confirmação e saída pelo link

Atrás de `WAITLIST_SIGNUP_ENABLED`, que só vale com `WAITLIST_PUBLIC_ENABLED` também ligada (sem turma esgotada na tela, não há onde se inscrever). Variáveis de servidor, só o valor exato `true`.

### O que o cliente vê

- **Turma esgotada** (grade da experiência, agenda, `/reservar/<id>` e o formulário que esgotou durante o preenchimento): o aviso "Esgotado" ganha o botão **Entrar na lista de espera**.
- **`/lista-de-espera/<turma>`**: nome completo, WhatsApp, e-mail e quantidade de pessoas. O texto diz, antes do envio, que não há pagamento nem reserva e que a vaga fica com quem concluir a reserva primeiro. Turma com vaga manda reservar; qualquer outra coisa, "turma indisponível". Fora da busca (`noindex`).
- **Depois de enviar**: "Inscrição recebida. Se este e-mail ainda não estava na lista desta turma, a confirmação chega em instantes…" — a mesma resposta para quem já estava inscrito, sem revelar quem está na lista.
- **E-mail de confirmação**: turma, data, horário, base e participantes; um destaque "Isto não é uma reserva — nenhuma vaga reservada, nenhuma cobrança"; como funciona o aviso (opção A); e o botão **Sair da lista de espera**.
- **`/lista-de-espera#t=<token>`**: mostra a inscrição (turma, quantidade, primeiro nome) e pede um clique para sair. O token sai da barra de endereço assim que a página o lê.

### Segurança e abuso

| Barreira | Onde |
| --- | --- |
| Recurso ligado (senão 404), origem do próprio site (senão 403), banco configurado (senão 503) | Rota de inscrição |
| Formato (nome, e-mail, WhatsApp, quantidade) antes de tocar no banco | Servidor e navegador |
| Limite de tentativas por origem e por e-mail, campo isca, uma inscrição ativa por e-mail e turma, tetos de 10 por e-mail e 100 por turma, grupo que caiba na turma | Banco (`waitlist_join`, fase 1) |
| Só POST, sem cache, endereço só do cabeçalho da Vercel, nada de dado pessoal nas respostas ou nos logs | Rotas |

**O cancelamento não depende da variável**: um link já enviado continua valendo mesmo com a inscrição desligada. Sem um token válido — que só existe nesses e-mails — a página só diz "link indisponível", e o formato errado nem chega ao banco.

### O e-mail: a fila

Migration `202610250002_waitlist_signup_email.sql` (**não aplicada**). Opera a linha `JOINED` que `waitlist_join` já grava na mesma transação da inscrição, com o protocolo da fila do e-mail de reagendamento:

- reivindicação exclusiva com prazo de 2 minutos; duas instâncias nunca enviam o mesmo e-mail;
- a mensagem é congelada no banco **antes** do envio; resultado desconhecido (timeout, 5xx) faz a próxima tentativa repetir a mesma chave de idempotência e a mesma mensagem, e o Resend não entrega de novo;
- recusa comprovada (4xx) começa geração nova; duas recusas da chave na mesma geração, ou a janela de 23 horas vencida com resultado desconhecido, param em `UNCERTAIN` — nada sai sozinho;
- antes de cada tentativa: inscrição ativa, turma não iniciada, não cancelada, não arquivada — senão `SKIPPED`;
- seis tentativas automáticas (3 s, 15 s, 5 min, 30 min, 2 h).

Caminhos de envio: logo depois da resposta da inscrição, com duas novas tentativas em segundo plano se a falha for passageira; de carona no envio seguinte; e na rotina diária que já existe (`/api/cron/confirmation-emails`, depois dos e-mails de pagamento e de reagendamento). `vercel.json` não mudou. O token do link é recalculado pelo banco ao montar o e-mail; a mensagem congelada some quando o e-mail sai, é descartado ou fica incerto.

A migration acrescenta `generation_uncertain` e `generation_started_at` a `waitlist_notifications`, `claim_token` a `waitlist_notification_attempts`, e oito funções: cinco para a service role (`claim_waitlist_joined_email`, `claim_pending_waitlist_emails`, `freeze_waitlist_email`, `complete_waitlist_email`, `fail_waitlist_email`) e três internas. Não substitui função, não cria trigger e não toca linha.

### Publicação da fase 3

Cada passo com autorização própria.

1. **Merge e deploy.** Sem a variável, nada muda: o botão não aparece, `/lista-de-espera/<turma>` responde 404, a rota de inscrição também. A página do link só diz "link indisponível".
2. `supabase/diagnostics/waitlist_signup_email_preflight.sql` → `WAITLIST_EMAIL_PREFLIGHT_OK | OK`.
3. Migration `202610250002_waitlist_signup_email.sql`, com `begin;` + `set local lock_timeout = '5s';` … `commit;`.
4. `supabase/diagnostics/waitlist_signup_email_postcheck.sql` → `WAITLIST_EMAIL_POSTCHECK_OK | OK`, com a mesma assinatura e as mesmas contagens.
5. **Ativação**, só em Production e com novo deploy: `WAITLIST_PUBLIC_ENABLED=true` (se ainda não estiver) e `WAITLIST_SIGNUP_ENABLED=true`. Teste com uma inscrição da equipe numa turma esgotada: e-mail recebido uma vez, link de saída funcionando.

**Não testar a inscrição no Preview**: ele usa o banco de produção e, com o provedor configurado, enviaria e-mail de verdade.

**Rollback.** Desligar `WAITLIST_SIGNUP_ENABLED` e publicar de novo tira o botão e a inscrição do ar; inscrições feitas continuam e os links continuam valendo. Do banco: `supabase/rollback/202610250002_waitlist_signup_email.rollback.sql` remove as oito funções e as três colunas; confirmações ainda na fila ficam `QUEUED`.

## Fase 4 — painel administrativo

Só código de aplicação, **sem migration**: usa as quatro RPCs administrativas da fase 1 (`admin_waitlist_sessions`, `admin_list_waitlist_entries_page`, `admin_waitlist_entry`, `admin_remove_waitlist_entry`), que conferem `is_active_admin` (ADMIN ou OPERATOR ativo) a cada chamada. Atrás de `WAITLIST_ADMIN_ENABLED`, variável de servidor desligada por padrão e independente das do site: a equipe pode acompanhar a lista antes de abrir a inscrição, ou depois de fechá-la.

### O que a equipe vê

- **Menu**: "Lista de espera", logo depois de Reservas e do Stand-by, só com a variável ligada.
- **`/admin/lista-de-espera` — Turmas com lista de espera**: experiência, base, data e horário, capacidade, vagas agora ("Esgotada" ou o número livre), quantas inscrições aguardam e quantas pessoas, total de inscrições e a última. Filtros por **experiência, base e data** (no fuso de Brasília) e "incluir turmas que já aconteceram". "Ver inscritos" leva às inscrições da turma.
- **Inscrições**: nome, e-mail, WhatsApp, pessoas, posição na fila, data da inscrição, avisos de vaga enviados e status ("Aguardando vaga", "Reservou", "Saiu da lista", "Removida pela equipe", "Encerrada"). Filtros por **turma, base, status** (padrão: aguardando) e busca por nome, e-mail ou WhatsApp. **Paginação no banco**, 25 por página. Inscrição anonimizada aparece como "Dados anonimizados".
- **`/admin/lista-de-espera/<inscrição>` — histórico**: contato, turma e situação; cada e-mail (confirmação e, na fase 6, aviso de vaga) com status, motivo de não envio e cada tentativa; e as ações da equipe da auditoria, com quem fez e o motivo. Nunca mostra o link de cancelamento nem a mensagem guardada da fila.
- **Remover**: só em inscrição ativa. Diálogo com motivo obrigatório (3 a 500 caracteres) e confirmação. O banco trava a inscrição, descarta o e-mail pendente e grava `WAITLIST_ENTRY_REMOVED` na auditoria com o motivo — sem dado pessoal nos metadados. Repetir não muda nada nem audita de novo.

Os filtros de experiência e data valem para a lista de turmas; as inscrições filtram por turma escolhida, base, status e busca. Um filtro de experiência ou data direto nas inscrições pediria uma RPC nova — e uma migration —, e o caminho "escolher a turma" cobre o uso do dia a dia.

### Segurança

| Camada | O que garante |
| --- | --- |
| `requireAdmin` nas páginas e `authorizeWaitlistAdminApi` na rota | Só ADMIN e OPERATOR; instrutor é redirecionado (página) ou recebe 403 (rota); variável desligada é 404 antes de tudo |
| Rota de remoção | Origem do próprio site, id válido, motivo e confirmação; ator da sessão, nunca do corpo; sem cache |
| RPCs da fase 1 | Conferem `is_active_admin` de novo; a remoção trava a inscrição e audita |
| Logs | Nenhum `console.*` nas páginas, na rota ou no acesso a dados; erros do banco viram mensagens fixas |

Nada desta fase lê ou escreve reserva, pagamento, cancelamento ou Stand-by.

### Publicação da fase 4

1. Merge e deploy: sem a variável, nada muda (sem menu; página e rota em 404).
2. `WAITLIST_ADMIN_ENABLED=true` só em Production, com novo deploy.
3. Conferir o menu e a página com um admin; a lista pode estar vazia enquanto a inscrição pública estiver desligada.

Desligar a variável e publicar de novo tira o painel do ar sem afetar inscrições nem e-mails.

## Fase 5 — detecção automática de vagas

Migration `202610260001_waitlist_detection.sql` (**não aplicada**). Aditiva: uma tabela de configuração (`waitlist_settings`), a coluna `waitlist_openings.closed_reason` e três funções — `waitlist_detection_spots`, `waitlist_scan_session` e `waitlist_scan`. Não substitui o corpo de nenhuma função (nem de reserva, nem da lista), não cria trigger em tabela existente e só **lê** `sessions` e `reservations`. Nenhuma das três é executável pela API, nem pela service role: quem as chama é o pg_cron, como dono.

### Por que uma varredura, e não triggers

As vagas aparecem por cancelamento, Stand-by, troca de turma, expiração de pré-reserva, fim da janela de pagamento, aumento de capacidade e reabertura de turma. Nem todas gravam alguma coisa: uma pré-reserva vence no instante em que `expires_at` passa, e `available_spots` passa a devolver a vaga sem nenhuma escrita. Uma varredura periódica sobre `available_spots` — a fonte oficial — cobre todos os casos sem depender de nenhum fluxo de reserva avisar nada, e sem tocar neles.

### O que a varredura faz

`waitlist_scan()`, pensada para o pg_cron a cada minuto:

1. **Interruptor.** Com `waitlist_settings.detection_enabled = false` (o padrão), responde `{enabled: false}` e não lê nem grava nada.
2. **Uma por vez.** Advisory lock da transação; uma segunda execução simultânea volta na hora com `ALREADY_RUNNING`.
3. **Manutenção.** Grava `EXPIRED` nas inscrições de turmas passadas, canceladas ou arquivadas, e `CONVERTED` nas que viraram reserva paga com o mesmo e-mail (funções da fase 1).
4. **Turma a turma**, nas que têm inscrição ativa ou abertura aberta (até 200 por execução, a mais próxima primeiro):
   - turma que não aceita reserva (fechada, cancelada, arquivada, iniciada ou de experiência despublicada) conta como zero vaga;
   - **sem vaga**: fecha a abertura, se houver (`NO_SPOTS` ou `SESSION_UNAVAILABLE`), e descarta os avisos dela ainda na fila (`SKIPPED`, `OPENING_CLOSED`);
   - **vaga nova**: abre uma abertura (uma por turma; índice único da fase 1);
   - **abertura aberta**, passada a carência (2 min) e, a partir da segunda onda, o intervalo (30 min): enfileira a onda pela régua da fase 1 — até `greatest(5, 3 × vagas)` inscrições, na ordem da fila, só quem cabe nas vagas, menos de 3 avisos enviados, o último há 12 h ou mais, nenhum outro aviso pendente. Um aviso por inscrição e abertura.
   - uma turma presa em outra transação por mais de 2 s é pulada e fica para a próxima execução.
5. Devolve um relatório só com contagens: inscrições encerradas e convertidas, turmas avaliadas e puladas, aberturas abertas e fechadas, avisos enfileirados e descartados.

Os avisos (`SPOT_AVAILABLE`) ficam `QUEUED`: as funções de envio da fase 3 só operam `JOINED`. **Nada é enviado nesta fase.**

### Oscilação

| Situação | Tratamento |
| --- | --- |
| Pré-reserva com checkout vencida, antes de o cron abrir a janela de pagamento (até 1 min) | `waitlist_detection_spots` desconta essas pré-reservas de `available_spots`, só na leitura: a vaga falsa não abre nada |
| Vaga que some em segundos (alguém reservou na hora) | Carência de 2 min antes da primeira onda: a abertura fecha sem aviso |
| Vaga que some depois da onda | A abertura fecha e os avisos ainda na fila são descartados |
| Vaga que volta | Abertura nova; quem já foi avisado espera 12 h e no máximo 3 avisos (D3), e quem tem aviso pendente não recebe outro |
| Varredura repetida | Nenhuma abertura ou aviso duplicado |

### Concorrência

A varredura não pede lock em sessão nem em reserva. A única espera possível é a da chave estrangeira ao gravar uma abertura (`FOR KEY SHARE` na sessão), que espera uma pré-reserva em curso naquela turma — por no máximo 2 s, depois a turma é pulada — e é esperada por ela até a varredura terminar. Não há ciclo. Testado com sessões reais do Postgres no CI.

### Configuração

| Coluna de `waitlist_settings` | Padrão | Faz |
| --- | --- | --- |
| `detection_enabled` | `false` | O interruptor |
| `opening_grace_seconds` | 120 | Carência antes da primeira onda |
| `wave_interval_minutes` | 30 | Intervalo entre ondas da mesma abertura |
| `max_sessions_per_scan` | 200 | Turmas por execução |

Sem acesso pela API (RLS, nenhum privilégio). Mudança só por SQL, no SQL Editor.

### Scripts

| Arquivo | Para quê |
| --- | --- |
| `supabase/diagnostics/waitlist_detection_preflight.sql` | Antes da migration: funções que a varredura chama iguais ao repositório, fase 3 aplicada, pg_cron em uso, assinatura e contagens |
| `supabase/diagnostics/waitlist_detection_postcheck.sql` | Depois: funções novas, nada pela API, configuração fechada e desligada, nenhum agendamento, funções existentes iguais, mesma assinatura e contagens |
| `supabase/rollback/202610260001_waitlist_detection.rollback.sql` | Tira o agendamento, as funções, a configuração e a coluna; aberturas e avisos ficam |
| `supabase/maintenance/waitlist_scan_schedule.sql` / `..._unschedule.sql` | Agendar ou tirar a varredura do pg_cron. **Não aplicados.** Agendar não liga a detecção |
| `supabase/diagnostics/waitlist_detection_report.sql` | Só leitura: por turma com inscrição, vagas oficiais, vagas detectadas, quem cabe e o tamanho da próxima onda |

### Publicação da fase 5 (cada passo com autorização)

1. Merge (nada muda no site: não há código de aplicação nesta fase).
2. Preflight → `WAITLIST_DETECCAO_PREFLIGHT_OK | OK`.
3. Migration, com `begin;` + `set local lock_timeout = '5s';` … `commit;`.
4. Postcheck → `WAITLIST_DETECCAO_POSTCHECK_OK | OK`, com o interruptor desligado e nenhum agendamento.
5. Opcional, para observar sem enviar: `waitlist_scan_schedule.sql` e depois `update public.waitlist_settings set detection_enabled = true;`. Os avisos se acumulam na fila e aparecem no histórico do painel como "Aviso de vaga — Na fila". Para parar: `detection_enabled = false` (imediato) ou `waitlist_scan_unschedule.sql`.

## Fase 6 — envio automático dos avisos de vaga

**Nada muda em produção ao publicar o código.** O envio só existe com a migration `202610260002` aplicada, `WAITLIST_NOTIFY_ENABLED=true` e alguém chamando `/api/cron/waitlist-notifications`; e só há o que enviar com a detecção da fase 5 ligada. Hoje nenhuma das três condições existe.

### O que o cliente recebe

Assunto `Abriu vaga: <experiência>, <data> às <hora> | Alma Azul Academy`. O e-mail traz a turma, a base, quantas pessoas a inscrição pediu e o valor por pessoa, e, em destaque, **"A vaga não está garantida"**: a lista não reserva nem bloqueia vagas, o aviso foi para outras pessoas também e a vaga fica com quem concluir primeiro a reserva e o pagamento (opção A). O botão **Reservar esta turma** leva a `/reservar/<turma>`, o fluxo normal, sem atalho nem preço especial; "a reserva só é confirmada depois de o pagamento ser aprovado". No fim, o mesmo link **Sair da lista de espera** da confirmação.

### Conferência antes de cada envio

A reivindicação (`waitlist_spot_take`) confere de novo, no momento em que o aviso sai da fila, o que a varredura conferiu ao enfileirar. Na ordem, o primeiro motivo que valer marca o aviso `SKIPPED` com esse motivo, e nada é enviado:

| Motivo | Quando |
| --- | --- |
| `ENTRY_CLOSED` | Inscrição cancelada, removida, convertida, expirada ou anonimizada |
| `SESSION_STARTED` | A turma já começou |
| `SESSION_UNAVAILABLE` | Turma não está `OPEN` ou a experiência não está `PUBLISHED` |
| `OPENING_CLOSED` | A abertura que gerou o aviso foi fechada (a vaga sumiu e a varredura viu) |
| `NO_SPOTS` | `waitlist_detection_spots` (`available_spots` menos as pré-reservas vencidas a caminho do pagamento) menor que a quantidade pedida |
| `LIMIT_REACHED` | A inscrição já recebeu 3 avisos |
| `TOO_SOON` | O último aviso foi há menos de 12 horas |

**O envio é que conta** (D3): `notifications_sent` e `last_notified_at` mudam só quando o aviso vira `SENT` (`complete_waitlist_spot_email`), uma vez por aviso, mesmo com conclusão repetida. Aviso descartado, falho ou incerto não conta.

### Fila e Resend

O mesmo protocolo da confirmação (fase 3) e do e-mail de reagendamento: reivindicação exclusiva com prazo de 2 min (`for update skip locked`: duas execuções ao mesmo tempo nunca pegam o mesmo aviso), mensagem congelada antes do envio, chave de idempotência `waitlist-spot/<aviso>/<geração>`. Resultado desconhecido (timeout, 5xx) repete chave e mensagem — o Resend não entrega de novo; recusa comprovada abre geração nova; chave recusada duas vezes ou janela de 23 h vencida param em `UNCERTAIN`, sem reenvio às cegas. Seis tentativas, com espera de 3 s, 15 s, 5 min, 30 min e 2 h. Cada execução da rota drena até 3 lotes de 20.

As filas não se misturam: as funções da fase 3 só pegam `JOINED`, as desta fase só `SPOT_AVAILABLE`. Congelar e falhar reaproveitam `freeze_waitlist_email` e `fail_waitlist_email`, sem mudança.

### Concorrência

A reivindicação trava a inscrição em `FOR SHARE` e o aviso em `FOR UPDATE SKIP LOCKED`, com `lock_timeout` de 3 s: inscrição presa em outra transação (um cancelamento em curso) é pulada e fica para a próxima execução. Não trava `sessions` nem `reservations`: uma reserva durante o envio não espera. Testado com sessões reais do Postgres no CI.

### Segurança

- Rota `/api/cron/waitlist-notifications` (GET e POST): sem `CRON_SECRET`, 503; segredo errado, 401; desligada, `DISABLED` sem tocar no banco. A resposta tem só contadores, sem e-mail, nome ou turma, e `no-store`.
- No banco: reivindicar e concluir só pela service role; conferência, payload e núcleo internos. Nada para `anon` ou `authenticated`.
- `vercel.json` não mudou.

### Agendamento (D1): proposta

**Recomendação: pg_cron + pg_net + Vault, a cada minuto, chamando a rota só quando há aviso pendente.** Script pronto em `supabase/maintenance/waitlist_notify_schedule.sql`, **não aplicado**.

| | |
| --- | --- |
| Frequência | `* * * * *`, o mesmo ritmo da expiração das pré-reservas que já roda no pg_cron. Um aviso sai no máximo ~1 min depois de enfileirado; com a varredura também a cada minuto e a carência de 2 min, ~3–4 min depois de a vaga abrir |
| Quando chama | Só se o segredo existe no Vault **e** há `SPOT_AVAILABLE` pendente (na fila, com nova tentativa vencida ou com prazo vencido). Sem aviso, o job só faz um `select` e nenhuma chamada sai |
| Custo no Supabase | `pg_net` e Vault são extensões incluídas em todos os planos, sem cobrança à parte. Um `select` por minuto é desprezível. `pg_net` guarda as respostas em `net._http_response` por 6 horas |
| Custo na Vercel | Uma execução de função por minuto **só com fila**, com poucos segundos cada. Mesmo no pior caso (fila o mês inteiro), ~43 mil execuções/mês, dentro do 1 milhão incluído no Hobby. Não precisa do Pro |
| Custo no Resend | Um e-mail por aviso enviado; limitado pela régua (no máximo `greatest(5, 3 × vagas)` por onda, 3 por inscrição) |
| Dependências novas | Extensão `pg_net` (não instalada hoje) e um segredo no Vault |

Riscos e como ficam cobertos:

- **O `CRON_SECRET` passa a existir também no banco**, no Vault (criptografado em repouso; legível só por quem já é dono do banco). Quem lê o Vault já tem acesso total aos dados; o segredo nunca entra no repositório nem no texto do job. Para girar: novo valor na Vercel, deploy, `vault.update_secret`.
- **`pg_net` é assíncrono**: a chamada sai depois do commit do job, e uma falha de rede só é percebida no minuto seguinte. A fila é idempotente; nada se perde nem duplica.
- **Domínio fixo no script**: se o domínio mudar, o job precisa ser reagendado.
- **Chamada sem fim**: a rota tem `maxDuration` de 60 s e o `pg_net`, timeout de 10 s; o job não espera a resposta.

Alternativas, se `pg_net`/Vault não forem aceitos:

| Opção | Frequência | Custo | Por que não é a primeira |
| --- | --- | --- | --- |
| GitHub Actions agendado | 5–15 min, com atrasos | Grátis; `CRON_SECRET` nos segredos do GitHub | Atrasa sob carga e é pausado depois de 60 dias sem atividade no repositório |
| Entradas no `vercel.json` | Diária no Hobby, ±59 min | Grátis | Impreciso demais para aviso de vaga |
| Vercel Pro | A cada minuto | Mensalidade | Custo recorrente só para isto |
| Carona (`after()` nos cancelamentos e no painel) | Quando há tráfego | Só código | Não cobre a pré-reserva que vence sem ninguém no site; serve só como complemento |

### Scripts

| Arquivo | Para quê |
| --- | --- |
| `supabase/diagnostics/waitlist_spot_email_preflight.sql` | Antes da migration: fases 3 e 5 aplicadas, as quatro funções reaproveitadas iguais ao repositório, objetos novos ainda ausentes, assinatura e contagens |
| `supabase/diagnostics/waitlist_spot_email_postcheck.sql` | Depois: cinco funções com a definição do repositório, permissões, a regra respondendo, existentes iguais, interruptor da detecção e agendamentos (`ATENCAO` se ligados), assinatura e contagens iguais ao preflight |
| `supabase/rollback/202610260002_waitlist_spot_email.rollback.sql` | Tira o agendamento `waitlist-notify`, se houver, e as cinco funções. Fila, contagens e histórico ficam |
| `supabase/maintenance/waitlist_notify_schedule.sql` / `..._unschedule.sql` | Agendar ou tirar o envio do pg_cron. **Não aplicados.** O passo do `pg_net` e do Vault vem comentado e o segredo é digitado por você |

### Publicação da fase 6 (cada passo com autorização)

1. **Merge e deploy.** Nada muda: a variável não existe e nada chama a rota.
2. Preflight → `WAITLIST_AVISO_PREFLIGHT_OK | OK`. Guarde a assinatura e as contagens.
3. Migration, com `begin;` + `set local lock_timeout = '5s';` … `commit;`. Só cria cinco funções.
4. Postcheck → `WAITLIST_AVISO_POSTCHECK_OK | OK`, mesmas assinatura e contagens do preflight.
5. **Teste controlado, sem cliente** (opcional; escreve no banco de produção): numa turma esgotada por uma reserva da equipe, inscreva um e-mail da equipe, libere a vaga pelo painel e rode `select public.waitlist_scan_session('<id da turma>', 0, 30);` — só essa turma, **sem ligar a detecção** (`waitlist_scan()` varreria todas as turmas e enfileiraria avisos para clientes reais). Depois do passo 6, chame a rota uma vez com o `CRON_SECRET` e confira o e-mail.
6. `WAITLIST_NOTIFY_ENABLED=true` em Production e deploy. A rota passa a enviar o que estiver na fila quando chamada.
7. Detecção: `waitlist_scan_schedule.sql` (fase 5) e `update public.waitlist_settings set detection_enabled = true;`.
8. Envio: passo A de `waitlist_notify_schedule.sql` (`pg_net` e o segredo no Vault), depois o passo B (agendamento).
9. Acompanhar: o histórico de cada inscrição no painel e `net._http_response`.

### Para desligar (do mais rápido ao mais completo)

1. `update public.waitlist_settings set detection_enabled = false;` — imediato: nada novo entra na fila.
2. `waitlist_notify_unschedule.sql` — o banco para de chamar a rota.
3. Remover `WAITLIST_NOTIFY_ENABLED` e fazer deploy — a rota responde `DISABLED` mesmo se chamada.
4. Rollback da migration — tira as cinco funções e o agendamento; avisos na fila ficam, sem ninguém para enviá-los.

Opcional, depois do 2: `drop extension pg_net;` e `delete from vault.secrets where name = 'waitlist_cron_secret';`.

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

- `tests/waitlist-detection.test.ts` (fase 5), 22 testes: interruptor (nasce desligado; desligado não lê nem grava); cada origem de vaga pelo caminho real — cancelamento, Stand-by, troca de turma, pré-reserva vencida, janela de pagamento (sem vaga falsa entre o vencimento e o hold), aumento de capacidade e reabertura; a régua (quantidade, ordem da fila, tamanho da onda); idempotência; ondas com intervalo; oscilação (fecha, descarta, reabre); D3 (12 h e 3 avisos); carência; turma fechada, cancelada, iniciada ou despublicada; expiração e conversão; os avisos ficam na fila e o envio da fase 3 não os pega; nenhuma reserva, pagamento, sessão ou Stand-by alterado; migration, preflight, postcheck, rollback e o script de agendamento.
- `tests/waitlist-detection-concurrency.test.ts` (fase 5), **sessões reais do Postgres, só no CI**: duas varreduras ao mesmo tempo (a segunda volta na hora), turma travada por uma pré-reserva (pulada em 2 s, aberta na próxima), pré-reserva durante a varredura (espera só até ela terminar e conclui), inscrição e cancelamento durante a varredura (não esperam).
- `tests/waitlist-spot.test.ts` (fase 6), 23 testes: variável; conteúdo do e-mail (vaga não garantida, pagamento, link da turma e de saída, nome escapado); de ponta a ponta na ordem da fila e por cada origem de vaga; conferência antes do envio (vaga perdida, grupo maior que a sobra, turma fechada ou iniciada, inscrição cancelada, removida, convertida ou expirada, abertura fechada); 12 h e 3 avisos conferidos no envio e contados só no envio; ondas; Resend (resultado desconhecido, recusa, chave recusada duas vezes, janela vencida); sem duplicidade (prazo vencido com outra execução, conclusão repetida); filas separadas; nenhuma reserva, pagamento, sessão ou Stand-by alterado; rota, script de agendamento, migration, preflight, postcheck e rollback.
- `tests/waitlist-spot-concurrency.test.ts` (fase 6), **sessões reais do Postgres, só no CI**: dois envios ao mesmo tempo (o segundo não espera nem pega o mesmo aviso), cancelamento antes e durante a reivindicação, reserva durante a reivindicação (não espera).
- `tests/waitlist-admin.test.ts` (fase 4), 20 testes: variável; filtros vindos da URL (inválido vira "sem filtro"); endereço com filtros; recorte das turmas por experiência, base e data no fuso de Brasília; leitura das respostas; validação da remoção; tradução dos erros sem repassar texto do banco; contra o Postgres em memória — permissões (instrutor e desconhecido recusados em leitura e remoção, nada auditado), turmas com capacidade, vagas e interessados, passadas só quando pedidas, inscrições na ordem da fila com contato e status, filtros por base, status e busca, paginação acima de 25 sem repetição, histórico sem token nem mensagem guardada, remoção com auditoria sem dado pessoal, repetição sem efeito, pedido inválido sem tocar no banco, e nenhuma reserva, pagamento, sessão ou Stand-by alterado; e, no código-fonte, a ordem das barreiras da rota, as páginas atrás de `requireAdmin` e da variável, sem logs, e o item do menu.
- `tests/waitlist-signup.test.ts` (fase 3), 30 testes: variáveis e formato; a migration (aditiva, permissões, preflight, postcheck, rollback); a inscrição pelo fluxo do servidor (grava, responde sem dado pessoal, envia uma confirmação depois da resposta; repetida não envia de novo; campo isca não grava; recusas sem e-mail; banco fora do ar é 503); a fila (resultado desconhecido repete chave e mensagem e o cliente recebe uma vez, recusa comprovada gera chave nova, chave recusada duas vezes e janela vencida param em `UNCERTAIN`, prazo vencido com outra instância assumindo, congelamento só para o e-mail da inscrição, descarte de inscrição encerrada e de turma iniciada ou arquivada, tentativas esgotadas, recuperação sem duplicar, aviso de vaga intocado); o conteúdo do e-mail e o link que tira o cliente da lista; e, no código-fonte, as barreiras das rotas, o botão só com a variável e nenhum caminho de pagamento ou reserva.
- `tests/waitlist-foundation-concurrency.test.ts` ganhou, para a fase 3: duas instâncias pedindo a mesma confirmação (só uma envia) e cancelamento durante a reivindicação (espera e descarta).
- `tests/waitlist-public-sessions.test.ts` (fase 2): variável; regras de exibição (reservável só com vaga, quantidades, corrida entre página e envio); leitura contra o Postgres em memória — desligada é exatamente `list_open_sessions`, ligada acrescenta só as esgotadas, vaga devolvida tira a marca, função ausente cai para a leitura de sempre; e, no código-fonte, que nenhum caminho de turma esgotada leva a `/reservar`, que o formulário nunca aparece sem vaga e que nada de inscrição, e-mail ou agendamento entrou.

## Pendências

- **D1, o agendador do envio**: proposta (pg_cron + pg_net + Vault) em [Fase 6](#agendamento-d1-proposta), aguardando decisão.
- **Painel:** reenvio manual de uma confirmação ou aviso com entrega não confirmada (`UNCERTAIN`) ou com tentativas esgotadas — precisa de RPC nova.
- **Fase 7:** agendar `waitlist_anonymize_entries` (90 dias). A expiração e a conversão já rodam dentro da varredura da fase 5.
