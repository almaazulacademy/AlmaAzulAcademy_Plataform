# Integração com o Google Sheets

[README](../README.md) · [Arquitetura](architecture.md) · [Banco](database.md) · [Pagamentos](payments.md) · [Admin](admin.md)

Sincroniza automaticamente as reservas confirmadas do site com uma Planilha Google operacional, usada para montar os grupos de WhatsApp de cada turma.

## Estado atual

| Parte | Estado |
| --- | --- |
| Fila durável e RPCs de snapshot | Implementadas na migration `202608180001` |
| Motor de sincronização e cliente Sheets | Implementados no código |
| Ações administrativas de sincronização | Implementadas |
| Script de preparação da planilha | Implementado, com dry-run |
| Migration aplicada no Supabase | **Pendente — aplicação manual** |
| Planilha Google criada e compartilhada | **Pendente — passo manual no Drive** |
| Variáveis configuradas na Vercel | **Pendente** |

Enquanto as três variáveis do Google não existirem no ambiente, a integração fica **desligada e inerte**: as reservas continuam confirmando normalmente, nenhum job é enfileirado e nada é enviado à planilha.

## 1. Arquitetura

O Supabase é, e continua sendo, a fonte de verdade das reservas, das vagas, da capacidade e dos pagamentos. A planilha é um espelho operacional somente-leitura do ponto de vista do sistema: ela nunca controla disponibilidade, nunca confirma pagamento e nunca altera capacidade.

```text
Supabase decide  →  fila durável  →  Google Sheets espelha
   (verdade)         (recuperação)        (operação)
```

Camadas:

| Arquivo | Papel |
| --- | --- |
| `lib/integrations/google-sheets/config.ts` | Lê as variáveis; decide se a integração está ligada |
| `lib/integrations/google-sheets/auth.ts` | JWT da conta de serviço → access token (RFC 7523) |
| `lib/integrations/google-sheets/client.ts` | Cliente REST da Sheets API v4 |
| `lib/integrations/google-sheets/schema.ts` | Abas, cabeçalhos e posições de coluna |
| `lib/integrations/google-sheets/formulas.ts` | Fórmulas derivadas da `Lista da Sessão` |
| `lib/integrations/google-sheets/mapping.ts` | Snapshot → linhas (funções puras) |
| `lib/integrations/google-sheets/sync.ts` | Convergência da planilha (sem rede, sem Supabase); calcula a posição de cada linha |
| `lib/integrations/google-sheets/service.ts` | **Ponto central**: enfileira, sincroniza, drena, nunca lança |
| `lib/integrations/google-sheets/observability.ts` | Logs sanitizados |
| `lib/integrations/google-sheets/errors.ts` | Erros reduzidos a códigos curtos |

### Nenhuma dependência nova

A integração usa a API oficial do Google Sheets v4 por REST e o fluxo oficial de *JWT bearer* da conta de serviço, assinado com `node:crypto`. `googleapis` traria uma árvore de dependências enorme para quatro chamadas HTTP; o projeto já resolve InfinitePay e Supabase Auth do mesmo jeito.

### Posição das linhas

Toda escrita vai para um intervalo calculado por `sync.ts` a partir da leitura da coluna-chave. Não se usa `values.append`: ele decide sozinho onde fica a "tabela" dentro do intervalo informado e, no primeiro uso em produção, inseriu linhas **acima** do cabeçalho em duas das três abas. `assertDataRow` recusa qualquer destino anterior à linha 2, então a linha do cabeçalho é inalcançável por construção.

O preço é que dois syncs simultâneos da mesma aba podem calcular a mesma linha livre. O volume aqui é de poucas reservas por sessão e a drenagem da fila é serial, então a corrida é remota; quando acontecer, **Sincronizar lista** reconstrói a turma a partir do Supabase.

### Idempotência

A convergência é sempre por chave técnica, nunca por nome ou telefone:

| Aba | Chave |
| --- | --- |
| `Reservas do Site` | `reservation_id` |
| `Sessões` | `session_id` |
| `Vagas Confirmadas` | `reservation_id:índice` (ex.: `UUID:1`, `UUID:2`, `UUID:3`) |

Sincronizar a mesma reserva 1, 2 ou 20 vezes termina com exatamente um registro de cada. Se uma chave duplicada aparecer na planilha (linha colada à mão, ou dois `append` concorrentes), a primeira linha recebe o dado e as demais são marcadas como inativas — a planilha se conserta sozinha na sincronização seguinte.

A fila também é idempotente: `integration_sync_jobs` tem uma linha por `(integração, entidade)`, não por evento. Vinte webhooks duplicados convergem para um único job.

### Retry

**Automático.** Toda confirmação e todo cancelamento tentam sincronizar na hora. Se falhar, o job fica `FAILED` com `attempts + 1` e um código de erro sanitizado. Depois de uma sincronização bem-sucedida, a mesma execução aproveita para drenar até 3 jobs pendentes (`OPPORTUNISTIC_DRAIN_LIMIT`) — o próximo pagamento confirmado limpa a fila que o anterior deixou para trás. Não há cron, não há polling.

Depois de `MAX_SYNC_ATTEMPTS` (5) falhas, o job para de ser retentado sozinho e espera ação administrativa.

**Manual.** Duas ações no painel, descritas em [Recuperação de erro](#11-recuperação-de-erro).

## 2. Fluxo de sincronização

Existem exatamente **três** pontos de chamada, todos em `lib/`. Nenhum endpoint reimplementa sincronização.

| Origem | Caminho no código | Operação |
| --- | --- | --- |
| Webhook da InfinitePay | `confirmPayment()` | `CONFIRMED` |
| Retorno do pagamento (`/pagamento/retorno`) | `confirmPayment()` | `CONFIRMED` |
| Botão "Verificar pagamento" | `confirmPayment()` | `CONFIRMED` |
| Confirmação manual do admin | `confirmAdminReservation()` | `ADMIN` |
| Cancelamento do admin | `cancelAdminReservation()` | `CANCELLED` |

`confirmPayment()` já era o ponto único dos três primeiros caminhos, então basta uma chamada lá para cobrir todos.

```text
InfinitePay confirma
  → payment_check server-to-server
  → confirm_reservation_payment / reconcile_reservation_payment
  → reserva CONFIRMED no Supabase          ← decidido aqui, e só aqui
  → enqueue_integration_sync_job            ← pendente já durável
  → escrita na planilha
  → complete_integration_sync_job
```

A sincronização acontece **depois** de o Supabase decidir, e o resultado devolvido a quem chamou é exatamente o que veio do banco. `syncReservationAfterChange` tem `try/catch` próprio e nunca lança.

### Quando o Google está fora do ar

```text
InfinitePay confirma → Supabase confirma → Google indisponível
```

Resultado correto, e é o que o código faz:

- a reserva continua `CONFIRMED`;
- o pagamento continua confirmado;
- a vaga continua ocupada;
- o webhook continua respondendo `200`;
- o job fica pendente e é retentado depois.

Também sincroniza em `ALREADY_CONFIRMED`: um webhook repetido vira, de graça, uma nova tentativa do que ficou pendente antes.

## 3. Estrutura das abas

Quatro abas. Duas visíveis para operação, uma visível para conferência e uma técnica oculta.

### `Reservas do Site` — uma linha por reserva

| # | Coluna | Observação |
| --- | --- | --- |
| A | `reservation_id` | técnica, oculta |
| B | Código da reserva | |
| C | `session_id` | técnica, oculta |
| D | Experiência | |
| E | Data | `dd/mm/aaaa`, fuso de Brasília |
| F | Horário | `HH:MM` |
| G | Responsável | |
| H | WhatsApp | `(61) 99999-8888` |
| I | Pessoas | quantidade da reserva |
| J | Valor total pago | número, formatado como R$ |
| K | Status da reserva | Confirmada / Cancelada / Pré-reserva / Expirada |
| L | Status do pagamento | Pago / Pago após expiração / Pendente / Não pago |
| M | Forma de pagamento | PIX / Cartão de crédito / Boleto / Confirmação manual |
| N | Origem | sempre `Site` |
| O | Última sincronização | |

O histórico nunca é apagado: uma reserva cancelada permanece nesta aba com status `Cancelada`.

### `Sessões` — uma linha por sessão

`session_id` (oculta) · Experiência · Data · Horário · Capacidade · Confirmados · Vagas restantes · Status da sessão · Última sincronização · Rótulo (oculta).

Capacidade, confirmados e vagas restantes **vêm do sistema** (`available_spots` e a soma das confirmadas no Supabase). A planilha não recalcula disponibilidade.

O `Rótulo` (`06/09/2026 · Imersão Paranoá · 09:00`) alimenta o dropdown da `Lista da Sessão`.

### `Vagas Confirmadas` — uma linha por vaga ocupada (oculta)

`spot_key` · `reservation_id` · `session_id` · Vaga da reserva · Código da reserva · Nome · WhatsApp · Valor pago · Forma de pagamento · Status da reserva · Observações · **Ativo** · Ordem · Última sincronização.

É o insumo da lista operacional. Ninguém precisa abri-la à mão.

**Reservas com mais de uma pessoa.** A quantidade da reserva define quantas vagas ela ocupa. O nome do responsável se repete enquanto não coletamos o nome de cada participante, e o valor total aparece **uma única vez**, na primeira vaga:

| Vaga | Nome | Valor pago |
| --- | --- | --- |
| 1 | João Silva | R$ 210,00 |
| 2 | João Silva | |
| 3 | João Silva | |

É isso que impede R$ 210 de virar R$ 630 na arrecadação da turma. Na aba `Reservas do Site` essa mesma reserva continua sendo **uma** linha.

**Exclusão lógica.** Cancelar não apaga linha: as vagas passam a `Ativo = NÃO` e somem da lista operacional, preservando a rastreabilidade.

### `Lista da Sessão` — a tela operacional

```text
A1  LISTA DA SESSÃO — ALMA AZUL ACADEMY
A2  Sessão        B2  [dropdown]                          J1  (session_id, oculto)
A3  Experiência   C3  Data      E3  Horário   G3  Status
A4  Capacidade    C4  Confirmados  E4  Vagas restantes  G4  Total arrecadado
A5  Vaga | Nome | WhatsApp | Código da reserva | Status | Forma de pagamento | Valor pago | Observações
A6..A45  1..40
```

Escolher a sessão no dropdown `B2` monta a turma inteira automaticamente. Nada é gravado nesta aba pela sincronização — ela é 100% derivada, por fórmulas:

```text
J1  =IFERROR(INDEX('Sessões'!$A:$A,MATCH($B$2,'Sessões'!$J:$J,0)),"")
H4  =SUMIFS('Vagas Confirmadas'!$H:$H,'Vagas Confirmadas'!$C:$C,$J$1,'Vagas Confirmadas'!$L:$L,"SIM")
B6  =IFERROR(ARRAY_CONSTRAIN(SORT(FILTER(CHOOSECOLS('Vagas Confirmadas'!$A:$N,6,7,5,10,9,8,11,13,4),
     ('Vagas Confirmadas'!$C:$C=$J$1)*('Vagas Confirmadas'!$L:$L="SIM")),8,TRUE,9,TRUE),40,7),"")
```

A lista comporta 40 vagas (`LIST_MAX_SPOTS`), com folga sobre as 28 da Imersão Paranoá.

### Relação com a planilha antiga

A `Controle de Experiências` (`.xlsm`, com macros) continua existindo no Drive e **não é tocada por nada aqui**. Ela serviu de referência visual: colunas `Vaga · Nome · Valor Pago · Status · Forma de Pagamento · Observações · Origem`, 28 vagas por bloco e o resumo de inscritos/vagas/arrecadação. A diferença é a escala: em vez de dezenas de blocos fixos por mês, a nova planilha tem uma lista única com seletor de sessão.

## 4. Campos sincronizados

Somente o mínimo operacional necessário para montar o grupo de WhatsApp:

nome do responsável · WhatsApp · quantidade · experiência · sessão (data, horário, capacidade, vagas) · status da reserva · status e forma de pagamento · valor pago · código da reserva · origem.

O telefone é permitido porque tem finalidade operacional direta e imediata: é o número que entra no grupo.

## 5. Campos deliberadamente excluídos

**Nunca** sincronizados:

- CPF, `cpf_hash`, últimos dígitos de CPF;
- e-mail (não é necessário nesta primeira versão);
- endereço, dados de cartão;
- `checkout_url`, `provider_reference`, payload de pagamento da InfinitePay;
- tokens, chaves, qualquer credencial;
- **o campo `notes` digitado pelo cliente.**

A última exclusão é uma decisão de projeto, não um esquecimento: `notes` é texto livre não validado e pode conter qualquer coisa, inclusive dado pessoal. A coluna `Observações` carrega, no lugar, nota operacional gerada pelo sistema — `Reserva de 3 pessoas`, `Pagamento reconciliado após expiração`, `Confirmação manual`, `Cancelada em 18/08/2026`.

**A privacidade é imposta no banco, não no TypeScript.** As RPCs `google_sheets_reservation_snapshot` e `google_sheets_session_snapshot` devolvem apenas os campos permitidos. A aplicação nunca recebe CPF nesta rota, então não tem como enviá-lo.

## 6. Conta de serviço

Uma conta de serviço do Google Cloud, com um único escopo: `https://www.googleapis.com/auth/spreadsheets`. Ela não precisa de acesso ao Drive inteiro — só à planilha que você compartilhar com ela.

O fluxo é server-to-server. **Nunca** se chama a API do Google do navegador com credenciais.

## 7. Criar a Planilha Google

O arquivo atual é `.xlsm` (Excel com macros). A Sheets API **não** opera sobre ele — ela precisa de uma Planilha Google nativa. O `.xlsm` não deve ser sobrescrito nem excluído.

1. Abra o Google Drive → **Novo** → **Planilhas Google** → **Planilha em branco**.
2. Nomeie, por exemplo, `Alma Azul — Operação (site)`.
3. Copie o `spreadsheetId` da URL:
   ```text
   https://docs.google.com/spreadsheets/d/ESTE_TRECHO_É_O_ID/edit
   ```

Opcionalmente, para partir do conteúdo antigo: abra o `.xlsm` no Drive → **Abrir com → Planilhas Google** → **Arquivo → Salvar como Planilhas Google**. Isso cria uma **cópia** nativa; o `.xlsm` original permanece intacto. As macros não são convertidas — e não precisam ser.

## 8. Compartilhar com a conta de serviço

1. No Google Cloud Console, crie (ou reaproveite) um projeto.
2. **APIs e serviços → Biblioteca → Google Sheets API → Ativar**.
3. **IAM e administrador → Contas de serviço → Criar conta de serviço**. Nome sugerido: `alma-azul-sheets`.
4. Na conta criada → **Chaves → Adicionar chave → Criar nova chave → JSON**. Baixe o arquivo e **não o commite**.
5. Copie o `client_email` do JSON (algo como `alma-azul-sheets@projeto.iam.gserviceaccount.com`).
6. Na Planilha Google → **Compartilhar** → cole o `client_email` → permissão **Editor** → **Enviar**.

Sem o passo 6 a integração falha com `HTTP_403`, mesmo com tudo o mais correto.

## 9. Variáveis na Vercel

Em **Settings → Environment Variables**, para Production (e Preview, se quiser testar lá):

| Variável | Valor |
| --- | --- |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | o id da URL da planilha |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | o `client_email` do JSON |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | o `private_key` do JSON, inteiro, com `\n` |
| `GOOGLE_SHEETS_TIMEOUT_MS` | opcional, padrão `8000` |

**Nenhuma delas pode usar o prefixo `NEXT_PUBLIC_`.** Variável pública vai para o bundle do navegador. O código recusa subir a integração se detectar uma versão `NEXT_PUBLIC_` dessas chaves, e registra `PUBLIC_ENV_FORBIDDEN`.

A `private_key` do JSON já vem com `\n` escapado. Cole exatamente como está, incluindo `-----BEGIN PRIVATE KEY-----` e `-----END PRIVATE KEY-----`.

## 10. Setup inicial

### Aplicar a migration

`supabase/migrations/202608180001_google_sheets_sync.sql` — aditiva e idempotente. Rode-a no **SQL Editor do Supabase**, colando o arquivo inteiro. Ela não é aplicada remotamente por este repositório nem pela CI.

Cria: `integration_sync_jobs`, as funções de fila (`enqueue`/`claim`/`complete`/`fail`/`state`) e as funções de snapshot. Não altera nenhuma tabela existente e não toca em nenhuma linha de `reservations`, `sessions`, `experiences` ou `payment_events`.

### Preparar a planilha

Com as três variáveis no `.env.local`:

```bash
pnpm sheets:setup
```

Dry-run: imprime o plano e não escreve nada. Para executar:

```bash
pnpm sheets:setup --apply
```

O script cria as abas que faltam, escreve cabeçalhos, define idioma `pt_BR` e fuso de Brasília, formata moeda, esconde colunas e a aba técnica, e monta o dropdown de sessão. É idempotente: rodar duas vezes produz o mesmo resultado.

**Ele nunca apaga nada.** Não há uma única requisição de exclusão no arquivo — nem de aba, nem de linha, nem de coluna. Só a `Lista da Sessão` é reescrita por inteiro, porque é derivada e não tem dado próprio a preservar.

O setup também se recusa a rodar se encontrar cabeçalho fora da linha 1 em alguma aba de dados: escrever o cabeçalho nessa situação apagaria o registro que estiver ali. Nesse caso ele manda rodar o reparo primeiro.

### Reparar uma planilha já em uso

```bash
pnpm sheets:repair
```

Dry-run por padrão; `--apply` executa. O reparo recoloca cabeçalhos na linha 1 preservando todas as linhas de dados na ordem em que estavam, reescreve as fórmulas com o separador correto e reconfigura o dropdown. Linhas com chave repetida são preservadas — quem as neutraliza é a sincronização seguinte.

### Verificar

```bash
pnpm sheets:verify
```

Somente leitura, sai com código 1 se algo estiver errado. Confere cabeçalho na linha 1 nas três abas de dados, ausência de `errorValue` em toda célula com fórmula, e o dropdown apontando para `Sessões!J2:J1000`. Use depois de todo setup ou reparo.

### Preencher com o que já existe

Para cada sessão ativa, use **Sincronizar lista da sessão** no painel (`/admin/sessoes`). Isso reconstrói a turma inteira a partir do Supabase.

## 11. Reconciliação e recuperação de erro

No painel:

| Onde | Ação | O que faz |
| --- | --- | --- |
| `/admin/reservas/<id>` | **Sincronizar planilha** | Reenvia uma reserva |
| `/admin/sessoes` | **Sincronizar lista** | Reconstrói a turma inteira a partir do Supabase |

O detalhe da reserva mostra o estado: `Planilha: Sincronizado` / `Pendente` / `Erro` / `Não sincronizado`, com a data da última sincronização ou o código do erro.

A reconstrução da sessão também **reconcilia**: qualquer vaga que exista na planilha para aquela sessão mas não exista mais no Supabase é desativada (`Ativo = NÃO`), sem ser apagada. É o fallback operacional quando a planilha ficou para trás.

Para inspecionar a fila diretamente:

```sql
select entity_type, entity_id, operation, status, attempts, last_error_code, updated_at
from public.integration_sync_jobs
where status <> 'SYNCED'
order by updated_at;
```

Para reabilitar um job que estourou as 5 tentativas:

```sql
update public.integration_sync_jobs
set status = 'PENDING', attempts = 0, last_error_code = null
where id = '<job_id>';
```

## 12. Trocar a planilha no futuro

1. Crie a nova Planilha Google e compartilhe com a mesma conta de serviço.
2. Troque `GOOGLE_SHEETS_SPREADSHEET_ID` na Vercel e faça um novo deploy.
3. Rode `pnpm sheets:setup --apply` apontando para o novo id.
4. Use **Sincronizar lista** em cada sessão ativa para repovoar.

A planilha antiga não é alterada nem apagada — ela simplesmente deixa de receber escritas.

## 13. Desativar a integração

Remova as três variáveis do Google na Vercel e faça um novo deploy.

A integração passa a ser inerte: nenhuma reserva deixa de confirmar, nenhum pagamento é afetado, nenhum job novo é enfileirado, os botões de sincronização somem do painel e nenhum log de erro é emitido. Os jobs já existentes ficam parados na tabela, disponíveis se a integração voltar.

Não é preciso reverter a migration.

## 14. Logs

Escopo `integrations.google_sheets`, no mesmo padrão dos logs de pagamento:

```json
{"scope":"integrations.google_sheets","stage":"sync","outcome":"synced",
 "entityType":"RESERVATION","entityId":"11110000…0001","operation":"CONFIRMED",
 "attempt":1,"durationMs":412,"rowsUpdated":4,"rowsAppended":0}
```

O que **não** aparece em log: telefone, nome, CPF, credencial do Google, conteúdo de célula, corpo da resposta do Google. Identificadores são mascarados por `maskIdentifier`, e o erro do Google é reduzido a um código curto (`HTTP_403`, `TIMEOUT`, `AUTH_FAILED`, `NETWORK_ERROR`, `INVALID_PRIVATE_KEY`) antes de virar log ou linha na fila. A constraint da tabela recusa qualquer `last_error_code` fora de `^[A-Z0-9_]{1,64}$`.

## 15. Troubleshooting

| Sintoma | Código | Causa provável | O que fazer |
| --- | --- | --- | --- |
| Nada chega à planilha, sem erro | — | Integração desligada | Confira as três variáveis na Vercel |
| Log `PUBLIC_ENV_FORBIDDEN` | — | Alguma variável foi criada com `NEXT_PUBLIC_` | Remova a versão pública |
| Job `FAILED` | `HTTP_403` | Planilha não compartilhada com a conta de serviço | Compartilhe como **Editor** (passo 8.6) |
| Job `FAILED` | `HTTP_404` | `spreadsheetId` errado, ou aponta para o `.xlsm` | Use o id de uma Planilha Google nativa |
| Job `FAILED` | `AUTH_FAILED` | Chave revogada, ou relógio do servidor fora de hora | Gere nova chave JSON |
| Job `FAILED` | `INVALID_PRIVATE_KEY` | PEM truncado ou `\n` não colado corretamente | Recole a `private_key` inteira |
| Job `FAILED` | `TIMEOUT` / `HTTP_429` | Google lento ou limite de taxa | Retenta sozinho; ou use **Sincronizar planilha** |
| Job `FAILED` | `SNAPSHOT_UNAVAILABLE` | Migration não aplicada | Aplique `202608180001` |
| `#ERROR!` nas células da `Lista da Sessão` | — | Fórmula gravada com separador de outro idioma | `pnpm sheets:repair --apply`, depois `pnpm sheets:verify` |
| Cabeçalho na linha 2 e dado na linha 1 | — | Planilha escrita por uma versão anterior, que usava `values.append` | `pnpm sheets:repair --apply` — preserva todas as linhas |
| Lista vazia com sessão escolhida | — | `J1` não resolveu o rótulo | Confira se a aba `Sessões` tem a linha daquela sessão; use **Sincronizar lista** |
| Pessoa duplicada na lista | — | Linha colada à mão | Rode **Sincronizar lista**: a duplicata é desativada sozinha |

### Sobre o separador das fórmulas

`valueInputOption=USER_ENTERED` faz a API interpretar a fórmula como se alguém a tivesse digitado na interface — e na interface o separador de argumentos segue o idioma. Em `pt_BR`, onde a vírgula é o separador decimal, argumentos são separados por **ponto e vírgula**.

A primeira versão gravou tudo com vírgula. A API aceitou (as células viraram fórmulas de verdade), mas nenhuma avaliava: `effectiveValue` voltava `errorValue: ERROR` e a planilha exibia `#ERROR!` nas dez células. O separador agora vem de `argumentSeparatorFor(locale)`, alimentado pelo idioma real da planilha.

**Ler com `valueRenderOption=FORMULA` não é verificação suficiente.** Ele só prova que a célula guarda uma fórmula, não que ela calcula — foi exatamente assim que dez fórmulas quebradas passaram por aprovadas. A verificação válida lê `effectiveValue` e exige ausência de `errorValue`, e é isso que `pnpm sheets:verify` faz.

Nenhuma fórmula usa literal de matriz (`{a,b}`), porque o separador de colunas dentro de chaves também depende do idioma. `CHOOSECOLS` faz o mesmo recorte sem esse risco. Nomes de função não são traduzidos pelo Google Sheets em nenhum idioma, então só o separador precisa de tratamento.

Todas as fórmulas vivem em `lib/integrations/google-sheets/formulas.ts`.

## 16. Testes

`tests/google-sheets-sync.test.ts` (33 testes) roda contra uma planilha falsa em memória que implementa o mesmo contrato de três operações do cliente real. **A CI nunca fala com o Google** — não há variável do Google no workflow, e o motor de sincronização não conhece `fetch`.

Cobertura: reserva de 1 e de 3 pessoas · expansão em vagas · valor total uma única vez · webhook duplicado · idempotência em 20 execuções · cancelamento sem apagar histórico · cancelado fora da lista válida · falha do Google sem desfazer pagamento nem reserva · job pendente após falha · retry bem-sucedido · sincronização administrativa · reconstrução de sessão · ausência de CPF/e-mail/endereço · ausência de credencial em log · quantidade nunca alterando capacidade · concorrência de duas reservas · acentos e cedilha · telefone brasileiro.

`tests/google-sheets-migration.test.ts` (8 testes) cobre o contrato da migration: unicidade da fila, sanitização do código de erro, contagem de tentativas, ausência de campo sensível nos snapshots, natureza somente-leitura e restrição ao `service_role`.
