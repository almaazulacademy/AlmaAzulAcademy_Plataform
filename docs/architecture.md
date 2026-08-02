# Arquitetura da Alma Azul Platform

[README](../README.md) · [Visão do produto](../PROJECT.md) · [Banco de dados](database.md) · [Pagamentos](payments.md)

## Estado deste documento

Este documento reflete o código presente na branch `main` após a Sprint 3, no commit `1874799dc6539aa5a8fca01fd88dc5b913c098b7`. A arquitetura de reservas está implementada no repositório, mas sua ativação em produção depende da migration e das variáveis externas descritas em [deployment.md](deployment.md).

## Visão geral

A plataforma é uma aplicação Next.js que combina conteúdo institucional, landings de experiências e um motor reutilizável de sessões e reservas. O navegador nunca decide sozinho sobre capacidade ou confirmação: essas regras ficam em RPCs do Postgres e em Route Handlers server-side.

```text
Cliente
  → Vercel / Next.js 15
      → Supabase (sessões, reservas, RPCs, RLS e cron)
      → PaymentProvider
          → InfinitePay (checkout hospedado e verificação de pagamento)
```

Esse fluxo representa o código atual. A conexão efetiva com Supabase, InfinitePay e Vercel não pode ser inferida apenas pelo repositório.

## Tecnologias

| Tecnologia | Uso confirmado |
| --- | --- |
| Next.js 15 | App Router, Server Components, Client Components, Route Handlers, imagens e metadata |
| React 19 | Componentes e estado das interfaces interativas |
| TypeScript | Tipagem estrita da aplicação e dos contratos de domínio |
| Tailwind CSS 3 | Layout, identidade visual e responsividade |
| shadcn/ui | Estrutura local dos componentes em `components/ui` |
| Radix UI | Accordion acessível usado pelo FAQ |
| Supabase JS | Clientes público e administrativo, consultas e RPCs |
| PostgreSQL/Supabase | Schema, locks, cálculo de vagas, RLS e expiração |
| Vercel | Destino previsto de build e deploy do Next.js |
| GitHub | Repositório e gatilho possível para deploy automático |
| InfinitePay | Provedor preferencial implementado atrás de uma interface |

## Estrutura de pastas

```text
app/                         rotas, páginas e Route Handlers
  api/                       API server-side de reservas e pagamento
  reservar/[sessionId]/      reserva genérica por sessão
  acompanhar-reserva/        recuperação por CPF + código
components/
  layout/                    Navbar e Footer
  reservation/               formulário, resumo, retenção e acompanhamento
  ui/                        Button, Card e Accordion locais
lib/
  payments/                  contrato PaymentProvider e InfinitePay
  reservations/              tipos, validação, acesso a dados e confirmação
  supabase/                  clientes browser, servidor público e service role
  experiences.ts             catálogo editorial usado na Home
public/images/               acervo oficial organizado por uso/experiência
supabase/migrations/         definição versionada do banco
tests/                       testes com o runner nativo do Node
docs/                        documentação técnica e de produto
```

## Rotas existentes

### Páginas

| Rota | Tipo | Estado e responsabilidade |
| --- | --- | --- |
| `/` | Estática | Home institucional e catálogo editorial |
| `/imersao-paranoa` | Dinâmica | Landing da primeira experiência e leitura das sessões |
| `/reservar/[sessionId]` | Dinâmica | Carrega uma sessão aberta e apresenta formulário/resumo |
| `/acompanhar-reserva` | Estática com interação cliente | Consulta por CPF + código e retoma pagamento quando possível |
| `/pagamento/retorno` | Dinâmica | Verifica os parâmetros de retorno e tenta confirmar o pagamento |
| `/login` | Estática | Placeholder; autenticação ainda não implementada |
| `/admin` | Estática | Placeholder; painel ainda não implementado |
| `/_not-found` | Estática | Tratamento visual de rota inexistente |

### APIs

| Método e rota | Responsabilidade |
| --- | --- |
| `POST /api/reservations` | Valida entrada, cria pré-reserva atômica, cria checkout e associa sua URL |
| `POST /api/reservations/lookup` | Valida CPF + código e devolve a visão limitada da reserva |
| `POST /api/payments/infinitepay/webhook` | Recebe o evento, consulta a InfinitePay e solicita confirmação protegida no banco |

Não há APIs administrativas na versão atual.

## Server Components e Client Components

### Servidor

Páginas do App Router são Server Components por padrão. Isso inclui a Home, a landing, a página por sessão e o retorno de pagamento. `SessionsSection` também é assíncrono e lê sessões pelo cliente público do Supabase.

Responsabilidades do servidor:

- buscar sessões e detalhes para a renderização inicial;
- manter a service role fora do bundle do navegador;
- criar pré-reservas por RPC;
- criar e verificar checkouts;
- consultar reservas com as duas credenciais exigidas;
- traduzir falhas do banco/provedor em respostas adequadas.

### Cliente

Componentes com `"use client"` existem somente quando precisam de estado, eventos ou APIs do navegador. Os principais são:

- `Navbar`: scroll e menu mobile;
- `Gallery`: lightbox;
- componentes Radix do Accordion/FAQ;
- `ReservationForm`: validação imediata, envio e estado pós-reserva;
- `Countdown`: contagem regressiva;
- `ReservationHold`: copiar código e continuar pagamento;
- `ReservationLookup`: busca e exibição do ciclo de vida.

## Camada Supabase

`lib/supabase/server.ts` expõe dois clientes:

- `getSupabaseServerClient`: chave anônima ou publicável, sem persistência de sessão; usado para leitura pública.
- `getSupabaseAdminClient`: service role; usado apenas em Route Handlers e confirmação server-side.

`lib/supabase/client.ts` contém um singleton de navegador com chave anônima. Ele está preparado, mas o fluxo atual de reservas não o utiliza para gravar dados.

`lib/reservations/data.ts` centraliza o mapeamento entre respostas das RPCs e os tipos `BookingSession`/`ReservationDetails`.

## Organização das experiências

Há duas fontes com papéis diferentes:

- `lib/experiences.ts`: catálogo editorial local da Home, com Imersão Paranoá disponível e formatos “em breve”.
- tabela `experiences`: identidade transacional usada por sessões e reservas.

Uma experiência futura precisa de conteúdo/landing e de um registro transacional. O componente `SessionsSection` recebe `experienceSlug`, e o restante do motor trabalha por `sessionId` e `experience_id`, sem regra específica da Imersão Paranoá.

## Componentes reutilizáveis

- `Hero`, `Section`, `ExperienceCard`, `FeatureCard`, `Gallery` e `FAQ` compõem as páginas públicas.
- `Navbar` e `Footer` são compartilhados.
- `SessionsSection` lista qualquer experiência por slug.
- `ReservationForm`, `ReservationSummary`, `ReservationHold`, `Countdown` e `ReservationLookup` isolam as etapas do fluxo.
- `Button`, `Card` e `Accordion` formam a base de UI local.

## Fluxo entre frontend, banco e pagamento

1. A landing chama `list_open_sessions(slug)` e mostra disponibilidade calculada pelo banco.
2. O visitante abre `/reservar/[sessionId]`; o servidor chama `get_booking_session`.
3. O formulário valida os dados no cliente e os envia a `POST /api/reservations`.
4. A API valida novamente e chama `create_pre_reservation` com service role.
5. A RPC bloqueia a sessão, recalcula ocupação e cria `PRE_RESERVED` por 2 horas.
6. O servidor chama `PaymentProvider.createCheckout` e associa a URL com `attach_payment_checkout`.
7. O cliente recebe código, contador e link “Pagar agora”.
8. O webhook ou `/pagamento/retorno` usa `payment_check` da InfinitePay.
9. Somente depois da verificação de valor o servidor chama `confirm_reservation_payment`.
10. A reserva pode ser recuperada por CPF + código por meio de `lookup_reservation`.

Detalhes de concorrência e status estão em [database.md](database.md); detalhes do gateway estão em [payments.md](payments.md).

## Decisões técnicas importantes

- **Capacidade no banco:** evita confiar em estados potencialmente obsoletos do frontend.
- **Lock da sessão:** `SELECT ... FOR UPDATE` serializa pré-reservas concorrentes da mesma sessão.
- **Service role somente no servidor:** RPCs críticas têm execução revogada de `anon` e `authenticated`.
- **Idempotência:** cada tentativa usa `idempotency_key` UUID único.
- **PaymentProvider:** trocar o gateway não deve exigir mudar o domínio de reservas.
- **Verificação server-to-server:** o webhook não confirma diretamente com base no payload recebido.
- **Renderização dinâmica onde necessário:** landing, sessão e retorno consultam estado atual.
- **Acessibilidade e movimento reduzido:** componentes usam atributos ARIA e o CSS respeita `prefers-reduced-motion`.

## Limites atuais

- Não há confirmação no repositório de que a migration esteja aplicada no Supabase de produção.
- Não há credenciais ou valores reais versionados, corretamente.
- InfinitePay não funciona sem `INFINITEPAY_HANDLE`, domínio público e configuração do projeto.
- Não há painel, autenticação administrativa, tabela `profiles` ou controle de papéis implementado.
- Não há envio de email/WhatsApp, check-in, CRM ou Analytics.
- Não há teste automatizado de integração com Supabase/InfinitePay; os testes atuais cobrem validação local.
- `lib/experiences.ts` e a tabela `experiences` ainda não compartilham uma única fonte editorial.
- O código registra pagamento após expiração para auditoria e não confirma uma vaga vencida; um processo operacional para esse caso ainda precisa ser definido.
