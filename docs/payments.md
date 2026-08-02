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
  → webhook ou retorno
  → payment_check server-to-server
  → confirm_reservation_payment
  → CONFIRMED
```

Se o pagamento não for confirmado dentro da retenção:

```text
PRE_RESERVED vencida
  → deixa de contar na disponibilidade imediatamente
  → Supabase Cron marca EXPIRED
  → vagas voltam a aparecer
```

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

Uma reserva `PRE_RESERVED` conta somente enquanto `expires_at > now()`. A disponibilidade não espera o cron para liberar a vaga no cálculo. O cron existe para materializar `EXPIRED` a cada minuto.

## Pagamento e confirmação

`POST /api/reservations` chama o provedor após a criação da pré-reserva. Se não conseguir criar/associar o checkout, chama `cancel_pre_reservation`, evitando manter uma vaga bloqueada por uma falha do gateway.

A reserva só muda para `CONFIRMED` depois que:

1. existe uma reserva com o `order_nsu` recebido;
2. `InfinitePayProvider.verifyPayment` consulta `/payment_check`;
3. a resposta informa `success: true` e `paid: true`;
4. o valor em centavos é exatamente `reservations.total_cents`;
5. `confirm_reservation_payment` confirma que a pré-reserva ainda é válida.

O payload do webhook sozinho não confirma a reserva.

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

`POST /api/payments/infinitepay/webhook` exige:

- `order_nsu`;
- `transaction_nsu`;
- `invoice_slug` ou `slug`.

O handler consulta o provedor antes de confirmar. Falhas retornam HTTP 400 para permitir nova tentativa do provedor.

### Retorno do navegador

`/pagamento/retorno` lê os parâmetros enviados após o checkout e executa a mesma verificação. A página apresenta “Pagamento confirmado” quando a confirmação termina, ou “Estamos validando” quando ainda não pode comprovar.

Webhook e retorno são caminhos idempotentes para o mesmo serviço de confirmação.

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

Se o provedor informar pagamento depois de `expires_at`, a RPC:

- registra `PAYMENT_AFTER_EXPIRATION`;
- muda uma pré-reserva ainda marcada para `EXPIRED`;
- não confirma a vaga;
- retorna `false`.

Isso preserva a proteção contra overbooking. Ainda está pendente uma decisão operacional sobre comunicação, conciliação e eventual estorno desse caso.

## Variáveis necessárias

| Variável | Visibilidade | Finalidade |
| --- | --- | --- |
| `PAYMENT_PROVIDER` | Privada | Seleciona `INFINITEPAY` |
| `INFINITEPAY_HANDLE` | Privada no código | InfiniteTag recebedora |
| `NEXT_PUBLIC_SITE_URL` | Pública | Constrói retorno e webhook |
| `NEXT_PUBLIC_SUPABASE_URL` | Pública | Projeto do banco |
| `SUPABASE_SERVICE_ROLE_KEY` | **Privada** | RPCs e confirmação |

Consulte a lista completa em [deployment.md](deployment.md).

## Pendências para produção

- Confirmar/aplicar a migration no Supabase correto.
- Verificar o cron e os grants.
- Configurar todas as variáveis no Vercel.
- Configurar InfiniteTag, URLs HTTPS e ambiente da InfinitePay.
- Testar Pix e cartão reais com valores controlados.
- Confirmar o formato real de resposta de criação do link para a conta usada.
- Observar retries do webhook e logs de `payment_check`.
- Definir processo para pagamento após expiração e estorno.
- Definir política de privacidade/retenção de payloads e dados pessoais.

## Cuidados de segurança

- Nunca expor `SUPABASE_SERVICE_ROLE_KEY` no frontend.
- Nunca coletar cartão dentro da aplicação sem um novo escopo de conformidade.
- Nunca confirmar usando somente o payload recebido no webhook.
- Nunca confiar no total enviado pelo navegador.
- Não registrar CPF completo ou dados pessoais em logs.
- Validar URLs retornadas pelo gateway; a implementação aceita apenas HTTPS.
- Manter timeouts nas chamadas externas.
- Preservar RLS e grants restritos de reservas/eventos.
