# Reservas e pagamentos

[README](../README.md) · [Arquitetura](architecture.md) · [Banco](database.md) · [Deploy](deployment.md)

## Estado atual

| Parte | Estado |
| --- | --- |
| Pré-reserva por 2 horas | Implementada no código/migration |
| Bloqueio e cálculo de vagas | Implementados no banco versionado |
| Tela com contador e código | Implementada |
| Retomada por CPF + código | Implementada |
| Interface `PaymentProvider` | Implementada |
| Cliente InfinitePay | Implementado |
| Webhook e retorno | Implementados |
| Credenciais/configuração InfinitePay | Não confirmadas em produção |
| Migration aplicada e cron ativo | Não confirmados em produção |
| Pagamento real ponta a ponta | Não comprovado pelo repositório |

Portanto, não se deve afirmar que a InfinitePay já está funcional em produção apenas porque a integração existe no código.

## Fluxo implementado

```text
Sessão aberta
  → validação do formulário
  → create_pre_reservation
  → PRE_RESERVED por 2 horas
  → criação do checkout InfinitePay
  → participante paga no checkout hospedado
  → webhook, retorno ou reconciliação
  → payment_check server-to-server
  → confirm_reservation_payment
  → CONFIRMED
```

## As quatro camadas da confirmação

Nenhum mecanismo isolado é responsável por confirmar um pagamento. Essa era a
causa do incidente de confirmação: o webhook era o único caminho automático, e
qualquer webhook perdido virava vaga revendida com o dinheiro do cliente na
conta.

| Camada | Mecanismo | Depende de |
| --- | --- | --- |
| 1 | Webhook da InfinitePay | O gateway alcançar `/api/payments/infinitepay/webhook` |
| 2 | Retorno do checkout | O cliente voltar ao site — **redundância, nunca dependência** |
| 3 | Reconciliação automática | Nada além do nosso servidor falar com a InfinitePay |
| 4 | Janela de segurança na expiração | Nada além do pg_cron do Supabase |

### Camada 1 — webhook

`POST /api/payments/infinitepay/webhook`. Idempotente, tolerante a evento
duplicado e independente do navegador do cliente.

- Aceita JSON, `application/x-www-form-urlencoded` e JSON enviado com
  `Content-Type` errado. A versão anterior chamava `request.json()` e devolvia
  400 para qualquer outra forma, perdendo a notificação em silêncio.
- Registra a chegada em `payment_webhook_log` **antes** de qualquer decisão —
  inclusive quando o corpo é ilegível ou o `order_nsu` não casa com reserva
  nenhuma, que é o único jeito de diagnosticar esses casos depois.
- Planilha e e-mail rodam em `after()`, depois da resposta. Antes estavam no
  caminho crítico e somavam até dezesseis segundos de rede: um pagamento já
  confirmado no banco podia virar timeout no painel da InfinitePay.
- `GET` no mesmo caminho é uma sonda de alcance sem efeito colateral, para provar
  que a URL configurada chega neste deployment.

### Camada 2 — retorno do checkout

`/pagamento/retorno` roda a mesma confirmação. Serve para encurtar a espera de
quem voltou ao site, e só. Se o cliente fechar o navegador, as camadas 1, 3 e 4
confirmam sem ele.

### Camada 3 — reconciliação automática

`/api/cron/payment-reconciliation` consulta a InfinitePay sobre as reservas em
risco: prestes a vencer, em janela de segurança, recém-expiradas, ou com sinal de
pagamento sem confirmação. Não depende de webhook nem de navegador.

Três respostas possíveis, e a terceira é a que corrige o incidente:

| Resposta do gateway | O que acontece com a vaga |
| --- | --- |
| Pago | Confirma. Sem capacidade, gera incidente — nunca silencia. |
| Comprovadamente não pago | Libera a retenção e deixa expirar. |
| Incerta (rede, timeout, resposta ilegível) | **Estende a retenção.** A vaga não sai. |

**Cadência.** O plano Hobby da Vercel executa cron uma vez por dia, o que é
inútil para uma janela de trinta minutos. Por isso a cadência curta não vem do
agendador da Vercel:

- **pg_cron do Supabase, a cada minuto** — aplica e encerra a retenção. Não faz
  chamada externa, então funciona em qualquer plano. É a garantia de que nenhuma
  vaga é liberada às cegas.
- **Reconciliação oportunista** — todo webhook e toda criação de pré-reserva
  puxam até três pendências junto, depois de já terem respondido. Quando existe
  pagamento acontecendo é exatamente quando existem reservas em risco.
- **Vercel Cron diário** — varredura de fundo do que a carona não pegou.
- **Opcional:** um agendador externo (GitHub Actions, cron-job.org) chamando
  `GET /api/cron/payment-reconciliation` com `Authorization: Bearer $CRON_SECRET`
  a cada cinco minutos. É a forma mais direta de encurtar a janela sem sair do
  plano Hobby. Com o plano Pro, basta trocar o `schedule` em `vercel.json` para
  `*/5 * * * *`.

### Camada 4 — janela de segurança na expiração

Uma pré-reserva que chega ao fim do prazo **e que chegou a gerar checkout** não
libera a vaga na hora: entra em retenção por `payment_hold_minutes()` (30 min).

A retenção é implementada empurrando o próprio `expires_at`, de propósito.
`available_spots`, `create_pre_reservation`, `admin_confirm_reservation`,
`admin_change_reservation_session` e `confirm_reservation_payment` já respeitam
`expires_at > now()`, então todas passam a respeitar a retenção sem serem
reescritas — menos superfície alterada, mesma garantia. O prazo original do
cliente fica preservado em `reservations.original_expires_at`.

```text
PRE_RESERVED vencida com checkout
  → retenção até expires_at + 30 min (EXPIRATION_HELD_FOR_PAYMENT_CHECK)
  → reconciliação pergunta à InfinitePay
      pago      → CONFIRMED
      não pago  → retenção liberada, expira normalmente
      incerto   → retenção estendida, teto de 180 min do prazo original
  → retenção encerrada sem resposta definitiva
      → PAYMENT_HOLD_EXHAUSTED + entra em "Pagamentos para revisar"
      → só então a vaga volta ao mercado
```

Uma pré-reserva **sem** checkout vinculado nunca pode ter sido paga e expira
direto, como antes.

## Pré-reserva

O formulário envia nome, CPF, WhatsApp, email, quantidade, observações e uma `idempotencyKey`. O Route Handler valida novamente e chama `create_pre_reservation` com service role.

A RPC:

- bloqueia a sessão;
- verifica se está aberta e futura;
- recalcula ocupação;
- rejeita quantidade superior às vagas;
- guarda preço unitário da sessão;
- define expiração em `now() + interval '2 hours'`;
- gera código público de 10 caracteres.

O contador do navegador melhora a UX, mas não é fonte de verdade. O banco usa `expires_at`.

## Vaga temporariamente bloqueada

Uma reserva `PRE_RESERVED` conta somente enquanto `expires_at > now()`. A
disponibilidade não espera o cron para liberar a vaga no cálculo — o cron existe
para materializar `EXPIRED` e para **aplicar a janela de segurança** a cada
minuto.

Enquanto a retenção está ativa, `expires_at` está no futuro e a vaga continua
ocupada. É por isso que a janela de segurança protege toda a superfície de
capacidade sem exigir uma mudança em cada consulta de ocupação.

## Pagamento e confirmação

`POST /api/reservations` chama o provedor após a criação da pré-reserva. Se não conseguir criar/associar o checkout, chama `cancel_pre_reservation`, evitando manter uma vaga bloqueada por uma falha do gateway.

A reserva só muda para `CONFIRMED` depois que:

1. existe uma reserva com o `order_nsu` recebido;
2. `InfinitePayProvider.verifyPayment` consulta `/payment_check`;
3. a resposta reconhece o pagamento como aprovado;
4. o maior valor observado cobre `reservations.total_cents`;
5. `confirm_reservation_payment` (ou `reconcile_reservation_payment`) confirma.

O payload do webhook sozinho não confirma a reserva.

### Sobre o passo 3

A regra era `success === true && paid === true`, e qualquer outra forma de o
gateway dizer a mesma coisa virava `NOT_PAID` — um veredito **definitivo** de
"não pagou", respondido com HTTP 200, sem nada que retentasse. Hoje um `status`
textual de aprovação (`approved`, `captured`, `paid`, `succeeded`) vale tanto
quanto o booleano, e `success` ausente não é tratado como negação.

### Sobre o passo 4

A regra era igualdade exata contra `amount ?? paid_amount`, e qualquer diferença
virava `PAYMENT_AMOUNT_MISMATCH` — outro resultado terminal com HTTP 200. Cartão
parcelado com juros pagos pelo cliente cobra **acima** do total da reserva e caía
exatamente aí: o cliente pagava, a reserva não confirmava e a vaga era revendida.

Hoje o critério é: o maior valor observado precisa cobrir o total da reserva.
Cobrança a menor continua sendo divergência e nunca confirma sozinha. O valor
realmente cobrado fica em `payment_events.payload.charged_amount_cents`, e a
igualdade exata com `total_cents` continua sendo invariante da RPC.

## InfinitePay

A implementação usa checkout hospedado:

- criação: `POST https://api.checkout.infinitepay.io/links`;
- verificação: `POST https://api.checkout.infinitepay.io/payment_check`;
- `order_nsu`: UUID interno da reserva;
- `redirect_url`: `/pagamento/retorno` no domínio configurado;
- `webhook_url`: `/api/payments/infinitepay/webhook`;
- cliente: nome, email e telefone;
- item: experiência, quantidade e preço unitário em centavos.

Pix e cartão são capacidades do checkout hospedado conforme a conta/configuração da InfinitePay. A aplicação não coleta dados de cartão e não força uma modalidade específica.

## Arquitetura desacoplada

`PaymentProvider` define:

```ts
interface PaymentProvider {
  readonly name: string;
  createCheckout(request: CreateCheckoutRequest): Promise<CheckoutResult>;
  verifyPayment(request: VerifyPaymentRequest): Promise<VerifiedPayment>;
}
```

`getPaymentProvider` seleciona o provedor. Hoje somente `INFINITEPAY` é suportado. Um novo gateway deve implementar o contrato e preservar os invariantes de valor, idempotência e confirmação no banco.

## Webhook e retorno

### Webhook

`POST /api/payments/infinitepay/webhook` exige apenas `order_nsu` —
`transaction_nsu` e `slug` são opcionais, porque o `payment_check` aceita a
consulta pelo `order_nsu` e a referência do checkout já está guardada em
`reservations.provider_reference`.

HTTP por resultado:

| Status | Quando | Retry do gateway |
| --- | --- | --- |
| 200 | Confirmado, já confirmado, ou legitimamente ainda não pago | Desnecessário |
| 400 | Corpo sem `order_nsu` | Inútil com o mesmo corpo — mas fica em `payment_webhook_log` |
| 404 | `order_nsu` sem reserva correspondente | Inútil — fica registrado como webhook órfão |
| 503 | Falha temporária nossa ou da InfinitePay | Desejável |

### Retorno do navegador

`/pagamento/retorno` lê os parâmetros enviados após o checkout e executa a mesma
verificação. A página apresenta "Pagamento confirmado" quando a confirmação
termina, ou "Estamos validando" quando ainda não pode comprovar.

Webhook, retorno, verificação administrativa e reconciliação são quatro caminhos
idempotentes para o mesmo serviço de confirmação.

## Retomada por CPF + código

Em `/acompanhar-reserva`, o participante precisa informar os dois campos. O backend chama `lookup_reservation` com service role.

- CPF sozinho não é aceito.
- Código sozinho não é aceito.
- O CPF é normalizado e comparado por hash.
- `checkout_url` só é devolvida para `PRE_RESERVED` ainda válida.
- Confirmadas, expiradas e canceladas recebem visual próprio.

## Idempotência e duplicidade

### Criação

- O cliente gera uma UUID por montagem do formulário.
- `reservations.idempotency_key` é único.
- Repetir a mesma chave com o mesmo CPF devolve a reserva existente.
- Reutilizar a chave com outro CPF gera conflito.

### Pagamento

- `provider + provider_event_id` é único em `payment_events`.
- Inserções de eventos usam `ON CONFLICT DO NOTHING`.
- Uma reserva já `CONFIRMED` retorna sucesso sem confirmar novamente.
- O valor é comparado em centavos antes da transição.

Não existe enum/tabela separada de status de pagamento. O código usa o status da reserva e os eventos `PAYMENT_CONFIRMED`/`PAYMENT_AFTER_EXPIRATION`.

## Pagamento após expiração

Ordem de tratamento, do mais recuperável ao que exige decisão humana:

1. **Dentro da janela de segurança.** `expires_at` ainda está no futuro por causa
   da retenção: `confirm_reservation_payment` confirma normalmente. É o caminho
   feliz do webhook atrasado.
2. **Fora da janela, com vaga.** `confirm_reservation_payment` recusa e
   `reconcile_reservation_payment` recupera: recontabiliza a ocupação com a
   sessão travada, grava `PAYMENT_CONFIRMED_RECONCILED` e confirma.
3. **Fora da janela, sem vaga.** Grava
   `PAYMENT_AFTER_EXPIRATION_NO_CAPACITY`, carimba
   `last_reconciliation_code = 'NO_CAPACITY'`, solta a retenção e retorna
   `NO_CAPACITY`. **Nunca confirma por cima da capacidade e nunca apaga o
   pagamento.** A reserva passa a aparecer em "Pagamentos para revisar" até
   alguém decidir entre realocação e estorno.

Um pagamento aprovado jamais é tratado como inexistente em nenhum desses
caminhos.

## Variáveis necessárias

| Variável | Visibilidade | Finalidade |
| --- | --- | --- |
| `PAYMENT_PROVIDER` | Privada | Seleciona `INFINITEPAY` |
| `INFINITEPAY_HANDLE` | Privada no código | InfiniteTag recebedora |
| `INFINITEPAY_TIMEOUT_MS` | Privada, opcional | Timeout por chamada ao gateway (padrão 8000, faixa 1000–20000) |
| `CRON_SECRET` | **Privada** | Autentica `/api/cron/*`, inclusive a reconciliação |
| `NEXT_PUBLIC_SITE_URL` | Pública | Constrói retorno e webhook |
| `NEXT_PUBLIC_SUPABASE_URL` | Pública | Projeto do banco |
| `SUPABASE_SERVICE_ROLE_KEY` | **Privada** | RPCs e confirmação |

Consulte a lista completa em [deployment.md](deployment.md).

## Pendências para produção

- Aplicar `202608280001_payment_confirmation_reliability.sql` no Supabase correto.
- Verificar o cron e os grants.
- Configurar `CRON_SECRET` no Vercel — sem ele a reconciliação fica desligada.
- Fazer as conferências manuais da seção anterior (URL do webhook, `www` vs raiz).
- Testar Pix e cartão reais com valores controlados, inclusive **parcelado com
  juros**, que é o caso que a regra antiga de valor rejeitava.
- Confirmar o formato real de resposta de criação do link para a conta usada.
- Definir processo operacional para `APPROVED_NO_CAPACITY` (realocação/estorno).
- Definir política de privacidade/retenção de `payment_webhook_log`.

## Runbook: pagamento aprovado que não confirmou

### 1. Onde olhar

| Fonte | O quê |
| --- | --- |
| Vercel → Logs → Functions | Filtrar por `[payments]`. Cada linha traz `requestId`, `stage`, `outcome`, `orderId` mascarado e `errorCode`. |
| Supabase → SQL Editor | Rodar `supabase/diagnostics/payment_confirmation_report.sql` (somente leitura). |
| Painel da InfinitePay | Confirmar que a transação existe, está aprovada e anotar o `transaction_nsu`. |

Etapas registradas em `stage`: `webhook_received`, `webhook_rejected`, `payment_check`,
`confirmation`, `reconciliation`, `return_page`, `admin_verification`.

### 2. Eventos gravados em `payment_events`

| `event_type` | Significado |
| --- | --- |
| `PAYMENT_WEBHOOK_RECEIVED` | Chegou notificação. Gravado **antes** de qualquer verificação. |
| `PAYMENT_CONFIRMED` | Caminho feliz: pré-reserva válida e paga. |
| `PAYMENT_CONFIRMED_RECONCILED` | Pago fora do prazo e recuperado porque ainda havia vaga. |
| `PAYMENT_NOT_CONFIRMED` | `payment_check` respondeu que ainda não está pago. |
| `PAYMENT_AMOUNT_MISMATCH` | Valor cobrado diferente de `total_cents`. |
| `PAYMENT_AFTER_EXPIRATION` | Pago fora do prazo, sem recuperação imediata. |
| `PAYMENT_AFTER_EXPIRATION_NO_CAPACITY` | Pago fora do prazo e a sessão lotou. Exige decisão humana. |
| `PAYMENT_CONFIRMED_MANUAL` | Confirmação manual pelo painel, sem consultar o gateway. |
| `EXPIRATION_HELD_FOR_PAYMENT_CHECK` | A vaga entrou em janela de segurança em vez de ser liberada. |
| `PAYMENT_HOLD_EXHAUSTED` | A janela terminou sem resposta definitiva do gateway. Vaga liberada **com** registro. |

### 2b. Etapas em `payment_webhook_log`

Tabela nova, e a única que aceita webhook sem reserva correspondente. Responde
"por que essa reserva não confirmou?" sem abrir dez lugares.

`WEBHOOK_RECEIVED` · `WEBHOOK_REJECTED` · `WEBHOOK_VALIDATED` ·
`PAYMENT_CHECK_ATTEMPT` · `PAYMENT_APPROVED` · `PAYMENT_NOT_APPROVED` ·
`PAYMENT_CHECK_FAILED` · `CONFIRM_ATTEMPT` · `CONFIRM_SUCCESS` ·
`CONFIRM_FAILED` · `RECONCILIATION_ATTEMPT` · `RECONCILIATION_SUCCESS` ·
`RECONCILIATION_FAILED` · `EXPIRATION_HELD_FOR_PAYMENT_CHECK` ·
`EXPIRATION_HOLD_RELEASED` · `PAYMENT_APPROVED_WITHOUT_CAPACITY`

Cada linha traz `request_id`, `source`, `step`, `outcome`, `http_status`,
`duration_ms`, `error_code` e o `reservation_id` quando o `order_nsu` casou. Sem
PII e sem segredo: os códigos são símbolos curtos, garantidos por CHECK.

### 3. Como corrigir

0. Abra **Pagamentos para revisar** no dashboard administrativo. A conferência
   manual do extrato da InfinitePay deixou de ser necessária: toda situação em
   que dinheiro e vaga podem estar desencontrados aparece ali, e nenhuma some
   sozinha.
1. No painel administrativo, abra a reserva pendente e use **Verificar pagamento**.
   A ação consulta o `payment_check` da InfinitePay e só confirma se o gateway
   responder pago. O resultado aparece na notificação.
2. Se retornar `NO_CAPACITY`, a sessão lotou: decida entre realocar para outra data
   ou estornar. Nada é confirmado automaticamente para não gerar overbooking.
3. **Confirmar pagamento** (manual) continua existindo, mas confia no julgamento do
   operador e não consulta o gateway. Use só quando a verificação automática não
   for possível, e sempre com justificativa.

Nenhum `payment_event` é apagado em qualquer um desses caminhos.

## Conferências manuais de configuração

O repositório não tem como validar o painel da InfinitePay, o DNS nem a
configuração de domínio da Vercel. Estas verificações precisam ser feitas à mão
e são as únicas peças do diagnóstico que o código não fecha sozinho.

### 1. A URL do webhook

**Fato do código:** `webhook_url` é enviado **por checkout**, no `POST /links`
de cada pré-reserva. A InfinitePay não usa uma URL global de painel para esta
integração. Isso significa que:

- links criados por deploys antigos carregam a URL daquele deploy — se
  `NEXT_PUBLIC_SITE_URL` já esteve errada, os links gerados naquele período
  continuam apontando para o lugar errado até vencerem;
- se a conta **também** tiver um webhook global configurado no painel, ele
  coexiste com o por-checkout e precisa apontar para o mesmo caminho.

**Conferir no painel da InfinitePay:** existe webhook global configurado? Para
qual URL? Há histórico de entregas com erro?

### 2. `www` versus domínio raiz

`NEXT_PUBLIC_SITE_URL` decide a origem de `redirect_url` e `webhook_url`; sem ela
(ou com valor inadequado) o código cai em `https://almaazulacademy.com.br`, sem
`www`.

**O risco concreto:** se a Vercel estiver configurada com `www` como domínio
principal, o domínio raiz responde **308** para `www`. Um POST seguindo 308
preserva método e corpo *quando o cliente segue redirecionamento* — e muitos
gateways não seguem, ou tratam 3xx como falha de entrega. O resultado é
exatamente o sintoma relatado: pagamento feito, webhook "entregue" com erro,
reserva nunca confirmada.

**Conferir:** no projeto da Vercel, qual domínio é o principal e qual redireciona.
E o valor exato de `NEXT_PUBLIC_SITE_URL` em Production.

**Como provar em trinta segundos**, agora que existe uma sonda de alcance:

```bash
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://almaazulacademy.com.br/api/payments/infinitepay/webhook
```

```bash
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://www.almaazulacademy.com.br/api/payments/infinitepay/webhook
```

`200` em uma URL e `308` na outra identifica qual delas a InfinitePay precisa
receber. E o POST real:

```bash
curl -sS -i -X POST -H 'content-type: application/json' -d '{}' https://almaazulacademy.com.br/api/payments/infinitepay/webhook
```

`400 MISSING_ORDER_NSU` prova que a rota está viva e processando POST. Qualquer
3xx aqui é o problema.

### 3. Variáveis em Production

`PAYMENT_PROVIDER`, `INFINITEPAY_HANDLE`, `NEXT_PUBLIC_SITE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` e `CRON_SECRET`. Sem `CRON_SECRET`, as duas rotinas
agendadas respondem 503 e não executam nada — a reconciliação fica desligada.

### 4. pg_cron do Supabase

```sql
select jobid, schedule, command, active from cron.job where command ilike '%expire_pre_reservations%';
```

Se o job não existir, não estiver ativo ou estiver falhando, a camada 4 não está
rodando. O bloco 7 de `supabase/diagnostics/payment_incident_forensics.sql`
inclui essa consulta e o histórico de execuções.

### 5. Histórico de deploys

Se o caminho `/api/payments/infinitepay/webhook` mudou em algum deploy, links
criados antes apontam para o caminho antigo. O repositório mostra o caminho atual;
o histórico de deploys da Vercel mostra desde quando ele existe.

## Cuidados de segurança

- Nunca expor `SUPABASE_SERVICE_ROLE_KEY` no frontend.
- Nunca coletar cartão dentro da aplicação sem um novo escopo de conformidade.
- Nunca confirmar usando somente o payload recebido no webhook.
- Nunca confiar no total enviado pelo navegador.
- Não registrar CPF completo ou dados pessoais em logs.
- Validar URLs retornadas pelo gateway; a implementação aceita apenas HTTPS.
- Manter timeouts nas chamadas externas.
- Preservar RLS e grants restritos de reservas/eventos.
