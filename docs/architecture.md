# Arquitetura da Alma Azul Platform

[README](../README.md) · [Visão do produto](../PROJECT.md) · [Banco de dados](database.md) · [Pagamentos](payments.md)

## Estado deste documento

Este documento reflete o código da Sprint 4. Reservas e painel administrativo estão implementados no repositório, mas a ativação em produção depende das migrations e das variáveis externas descritas em [deployment.md](deployment.md).

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
  admin/                     dashboard e operação protegida
  reservar/[sessionId]/      reserva genérica por sessão
  acompanhar-reserva/        recuperação por CPF + código
components/
  admin/                     shell, formulários, listas e feedback operacional
  layout/                    Navbar e Footer
  reservation/               formulário, resumo, retenção e acompanhamento
  ui/                        Button, Card e Accordion locais
lib/
  admin/                     auth, tipos, validação, formatação e acesso a dados
  payments/                  contrato PaymentProvider e InfinitePay
  reservations/              tipos, validação, acesso a dados e confirmação
  sessions/                  fuso das sessões e tradução de sessão para turma exibida
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
| `/agenda` | Dinâmica | Agenda geral com as sessões abertas de todas as experiências publicadas |
| `/imersao-paranoa` | Redirect | 308 permanente para `/experiencias/imersao-paranoa`, definido em `next.config.ts` |
| `/reservar/[sessionId]` | Dinâmica | Carrega uma sessão aberta e apresenta formulário/resumo |
| `/acompanhar-reserva` | Estática com interação cliente | Consulta por CPF + código e retoma pagamento quando possível |
| `/pagamento/retorno` | Dinâmica | Verifica os parâmetros de retorno e tenta confirmar o pagamento |
| `/login` | Interativa | Login real pelo Supabase Auth |
| `/admin` | Dinâmica e protegida | Dashboard operacional |
| `/admin/sessoes` | Dinâmica e protegida | Gestão de sessões |
| `/admin/reservas` | Dinâmica e protegida | Lista e filtros de reservas |
| `/admin/reservas/[reservationId]` | Dinâmica e protegida | Detalhe e ações da reserva |
| `/admin/experiencias` | Dinâmica e protegida | Gestão de experiências |
| `/admin/configuracoes` | Dinâmica e protegida | Configurações somente leitura |
| `/_not-found` | Estática | Tratamento visual de rota inexistente |

### APIs

| Método e rota | Responsabilidade |
| --- | --- |
| `POST /api/reservations` | Valida entrada, cria pré-reserva atômica, cria checkout e associa sua URL |
| `POST /api/reservations/lookup` | Valida CPF + código e devolve a visão limitada da reserva |
| `POST /api/payments/infinitepay/webhook` | Recebe o evento, consulta a InfinitePay e solicita confirmação protegida no banco |
| `POST /api/auth/login` | Autentica, autoriza o papel administrativo e cria cookies HttpOnly |
| `POST /api/auth/logout` | Encerra a sessão local e remove cookies |
| `POST /api/admin/sessions` | Cria sessão por RPC protegida |
| `PATCH/DELETE /api/admin/sessions/[sessionId]` | Atualiza ou exclui sessão conforme invariantes do banco |
| `POST /api/admin/experiences` | Cria experiência |
| `PATCH /api/admin/experiences/[experienceId]` | Atualiza conteúdo, ordem e status |
| `POST /api/admin/reservations/[reservationId]/actions` | Confirma manualmente ou cancela com motivo e auditoria |

Todas as mutações administrativas validam sessão, autorização, origem e payload no servidor antes de chamar RPCs exclusivas da service role.

## Server Components e Client Components

### Servidor

Páginas do App Router são Server Components por padrão. Isso inclui a Home, a landing, a página por sessão e o retorno de pagamento. `SessionsSection` e `SessionTimes` também são assíncronos e leem sessões pelo cliente público do Supabase, compartilhando uma única leitura por requisição em `readOpenSessions`.

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

`lib/supabase/server.ts` expõe três clientes:

- `getSupabaseServerClient`: chave anônima ou publicável, sem persistência de sessão; usado para leitura pública.
- `getSupabaseAdminClient`: service role; usado apenas em Route Handlers e confirmação server-side.
- `getSupabaseUserClient`: chave pública com bearer token explícito; valida a identidade do usuário administrativo sem persistir sessão no navegador.

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

## Camada administrativa

`middleware.ts` protege páginas e APIs administrativas, valida access tokens e renova sessões. O layout de `/admin` exige novamente uma linha ativa em `admin_users`; Route Handlers repetem essa autorização antes de usar a service role.

As consultas iniciais são Server Components. Interações como formulários, confirmações, toast, filtros e menu mobile ficam em Client Components. Capacidade, transição de reserva e auditoria permanecem em RPCs Postgres.

## Limites atuais

- Não há confirmação no repositório de que a migration esteja aplicada no Supabase de produção.
- Não há credenciais ou valores reais versionados, corretamente.
- InfinitePay não funciona sem `INFINITEPAY_HANDLE`, domínio público e configuração do projeto.
- A migration administrativa, a configuração do Supabase Auth e o primeiro `admin_users` não estão confirmados no ambiente de produção.
- Não há edição de configurações sensíveis nem promoção de administradores pela interface.
- Não há envio de email/WhatsApp, check-in, CRM ou Analytics.
- Não há teste automatizado de integração com Supabase/InfinitePay; os testes atuais cobrem validação local.
- `lib/experiences.ts` e a tabela `experiences` ainda não compartilham uma única fonte editorial.
- O código registra pagamento após expiração para auditoria e não confirma uma vaga vencida; um processo operacional para esse caso ainda precisa ser definido.
