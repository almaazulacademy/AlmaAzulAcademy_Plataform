# E-mail de confirmação de reserva

[README](../README.md) · [Arquitetura](architecture.md) · [Banco](database.md) · [Pagamentos](payments.md) · [Planilha](google-sheets-integration.md)

Envia automaticamente um e-mail ao cliente quando a reserva passa a `CONFIRMED`.

## Estado atual

| Parte | Estado |
| --- | --- |
| Abstração de provedor e cliente Resend | Implementados |
| Template HTML responsivo e texto puro | Implementados |
| Reivindicação exatamente-uma-vez | Implementada na migration `202608190001` |
| Recuperação de pendências | Implementada: oportunista, rotina agendada e botão no painel |
| Migration aplicada no Supabase | **Pendente — aplicação manual** |
| Domínio verificado no Resend | **Pendente** |
| Variáveis configuradas na Vercel | **Pendente** |

Sem `RESEND_API_KEY` e `EMAIL_FROM` a funcionalidade fica **desligada e inerte**: as reservas continuam confirmando normalmente e nenhum e-mail é disparado.

## Fluxo

Existem exatamente **dois** pontos de chamada, os mesmos da sincronização com a planilha. Nenhum endpoint reimplementa nada.

| Origem | Caminho no código |
| --- | --- |
| Webhook da InfinitePay | `confirmPayment()` |
| Retorno do pagamento (`/pagamento/retorno`) | `confirmPayment()` |
| Botão "Verificar pagamento" | `confirmPayment()` |
| Confirmação manual do admin | `confirmAdminReservation()` |

Cancelamento **não** dispara nada.

```text
Supabase confirma a reserva          ← decidido aqui, e só aqui
  → claim_reservation_confirmation_email
      · reserva não está CONFIRMED?  → null, nada acontece
      · e-mail já enviado?           → null, nada acontece
      · envio em curso?              → null, nada acontece
      · nunca enviado ou falhou?     → devolve o id do job
  → monta a mensagem
  → envia pelo provedor
  → complete_integration_sync_job
```

**A ordem é o que garante a idempotência: reivindica primeiro, envia depois.** Quem não conseguir a reivindicação não envia.

### Quando o envio falha

A reserva continua `CONFIRMED`, o pagamento continua confirmado, a vaga continua ocupada e o webhook continua respondendo `200`. O job fica `FAILED` com um código de erro sanitizado e é retentado depois.

## Idempotência

Reaproveita `integration_sync_jobs`, a fila durável que o projeto já usa para o Google Sheets, com `integration = 'RESERVATION_CONFIRMATION_EMAIL'`. A unicidade `(integration, entity_type, entity_id)` já existente é o que trava o envio duplicado.

A reivindicação é um `INSERT ... ON CONFLICT DO UPDATE ... WHERE`:

```sql
on conflict (integration, entity_type, entity_id) do update
  set status = 'PENDING', updated_at = now()
  where integration_sync_jobs.status = 'FAILED'
    and integration_sync_jobs.attempts < max_attempts
returning id
```

Quando a cláusula `WHERE` não é satisfeita — job `SYNCED` ou `PENDING` — nada é devolvido e o envio não acontece. Um webhook reprocessado vinte vezes gera **um** e-mail.

## Retry

Três caminhos, para que um envio que falhou não fique refém de uma nova confirmação aparecer.

| Caminho | Quando | Lote |
| --- | --- | --- |
| Oportunista | Após um envio bem-sucedido | 2 |
| Rotina agendada | `POST /api/cron/confirmation-emails` | 25 |
| Painel | Botão **Reenviar e-mail** na reserva | 1 |

Regras comuns a todos:

- job `FAILED` é retentado na hora; job `PENDING` só depois de 15 minutos (`STALE_EMAIL_MINUTES`), para a rotina agendada não disputar um envio em andamento e mandar duas vezes;
- **confere de novo se a reserva ainda está `CONFIRMED`** — uma reserva cancelada depois da confirmação não recebe o e-mail numa tentativa posterior;
- desiste após 3 tentativas (`MAX_EMAIL_ATTEMPTS`);
- job `SYNCED` nunca volta para a fila, então nenhum dos três caminhos consegue duplicar.

### Rotina agendada

`vercel.json` declara o cron diário às 12:00 UTC (09:00 em Brasília):

```json
{ "crons": [{ "path": "/api/cron/confirmation-emails", "schedule": "0 12 * * *" }] }
```

Uma vez por dia é o limite do plano Hobby da Vercel. No plano Pro dá para subir para de hora em hora (`0 * * * *`) trocando só essa linha.

A rota exige `Authorization: Bearer $CRON_SECRET`, com comparação de tempo constante, e responde 503 enquanto `CRON_SECRET` não existir. Funciona com qualquer agendador que envie esse cabeçalho — não é preciso ficar preso ao Vercel Cron.

### Botão no painel

Em `/admin/reservas/<id>`, **Reenviar e-mail**. A decisão de enviar continua sendo do banco: se o e-mail já foi enviado, a resposta diz exatamente isso e nada sai. Clicar dez vezes não gera dez e-mails.

A mesma tela mostra o estado: **Enviado** (com a data), **Pendente**, **Erro** (com o código e o número de tentativas) ou **Não enviado**.

## Conteúdo

**Assunto:** `Reserva confirmada — AZ7K2M9QX1`

O corpo traz código da reserva, experiência, data, horário de encontro, local (Lago Norte) e, quando a reserva é para mais de uma pessoa, a quantidade.

**Data e horário saem sempre no fuso de Brasília** (`America/Sao_Paulo`), pelos mesmos helpers de `lib/sessions/date-time.ts` que o site usa na escolha da sessão. Uma sessão às `12:00Z` aparece como `09:00`.

Duas versões, sempre: HTML e texto puro. O HTML é deliberadamente antiquado — tabelas, largura máxima de 560px, estilo inline, nada de flexbox, grid, CSS externo ou script. Cliente de e-mail não é navegador.

O nome do cliente é escapado antes de entrar no HTML.

### O que o e-mail não carrega

CPF, telefone, endereço, dados de cartão, `checkout_url`, referência do provedor, payload de pagamento. O tipo `ReservationConfirmationData` nem conhece esses campos, e a RPC `reservation_confirmation_email` não os devolve.

## Provedor

`Resend` é a recomendação e a implementação padrão: API REST simples, bom domínio de entregabilidade transacional e plano gratuito suficiente para o volume atual. Sem dependência nova — uma chamada `fetch`, como já é feito com InfinitePay e Google Sheets.

Trocar de provedor toca só em `lib/email/`: implemente `EmailProvider` e registre em `getEmailProvider()`.

## Variáveis de ambiente

| Variável | Obrigatória | Valor |
| --- | --- | --- |
| `RESEND_API_KEY` | sim | chave da API do Resend |
| `EMAIL_FROM` | sim | `Alma Azul Academy <reservas@almaazulacademy.com.br>` |
| `EMAIL_REPLY_TO` | não | para onde vão as respostas |
| `EMAIL_PROVIDER` | não | `RESEND` (padrão) ou `NONE` para desligar |
| `CRON_SECRET` | para a rotina | string longa e aleatória; sem ela o cron responde 503 |

**Nenhuma pode usar o prefixo `NEXT_PUBLIC_`.** O código recusa subir se detectar uma versão pública e registra `PUBLIC_ENV_FORBIDDEN`.

O `EMAIL_FROM` precisa ser de um domínio verificado no Resend (Domains → Add Domain → registros DNS). Sem isso a API devolve `HTTP_422`.

## Setup

1. Aplique `supabase/migrations/202608190001_reservation_confirmation_email.sql` no SQL Editor do Supabase. Aditiva, idempotente, **não cria tabela nova**.
2. Crie a conta no Resend, verifique o domínio e gere uma API key.
3. Configure as variáveis na Vercel (Production e Preview).

## Testar em desenvolvimento

**Sem enviar nada** — prévia do layout:

```bash
pnpm email:preview
```

Escreve `.preview/confirmacao.html` e `.preview/confirmacao.txt`. Abra o HTML no navegador e reduza a janela para conferir o comportamento no celular. `.preview/` é ignorado pelo git. Passe a quantidade como argumento para ver a linha "Pessoas": `pnpm email:preview 3`.

**Enviando de verdade**, sem domínio verificado: o Resend aceita `onboarding@resend.dev` como remetente, desde que o destinatário seja o e-mail da própria conta.

```bash
EMAIL_FROM="Alma Azul <onboarding@resend.dev>" RESEND_API_KEY=... pnpm dev
```

Crie uma reserva de teste com o seu e-mail e confirme pelo painel administrativo. Para repetir o envio da mesma reserva, limpe o job antes:

```sql
delete from public.integration_sync_jobs
where integration = 'RESERVATION_CONFIRMATION_EMAIL' and entity_id = '<reservation_id>';
```

## Logs

Escopo `notifications.email`:

```json
{"scope":"notifications.email","stage":"confirmation","outcome":"sent",
 "reservationId":"11110000…0001","provider":"RESEND","attempt":1,"durationMs":412}
```

**O endereço do destinatário nunca é logado**, nem mascarado — o id da reserva já basta para correlacionar e não é dado pessoal. Também ficam de fora nome, assunto, corpo da mensagem e a chave do provedor. O erro do Resend é reduzido a um código curto (`HTTP_422`, `TIMEOUT`, `NETWORK_ERROR`) antes de virar log ou linha na fila.

## Troubleshooting

| Sintoma | Código | Causa provável | O que fazer |
| --- | --- | --- | --- |
| Nenhum e-mail, sem erro | — | Provedor não configurado | Confira `RESEND_API_KEY` e `EMAIL_FROM` |
| Log `PUBLIC_ENV_FORBIDDEN` | — | Variável criada com `NEXT_PUBLIC_` | Remova a versão pública |
| Job `FAILED` | `HTTP_422` | Remetente de domínio não verificado | Verifique o domínio no Resend |
| Job `FAILED` | `HTTP_401` / `HTTP_403` | Chave inválida ou revogada | Gere nova API key |
| Job `FAILED` | `TIMEOUT` / `HTTP_429` | Resend lento ou limite de taxa | Retenta sozinho na próxima confirmação |
| Job `SKIPPED` com `PAYLOAD_EMPTY` | — | Reserva sem e-mail válido | Corrija o cadastro e limpe o job |
| E-mail não chega, job `SYNCED` | — | Entregue mas em spam, ou caixa recusou | Consulte os logs do Resend |
| Rotina agendada devolve 503 | — | `CRON_SECRET` ausente | Configure a variável na Vercel |
| Rotina agendada devolve 401 | — | Segredo diferente do configurado | Confira o cabeçalho `Authorization` |

Para inspecionar a fila:

```sql
select entity_id, status, attempts, last_error_code, synced_at
from public.integration_sync_jobs
where integration = 'RESERVATION_CONFIRMATION_EMAIL'
order by updated_at desc;
```

## Desativar

Remova `RESEND_API_KEY` (ou defina `EMAIL_PROVIDER=NONE`) e faça um novo deploy. Nenhuma reserva é afetada, nenhum job novo é criado. Não é preciso reverter a migration.
