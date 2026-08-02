# Alma Azul Academy

Plataforma oficial da Alma Azul Academy. A Imersão Paranoá é a primeira experiência de um catálogo preparado para receber novos formatos, como Remada da Lua Cheia, Sunset, aulas, Team Building e loja.

## Plataforma

- Home institucional em `/`
- Landing page da Imersão Paranoá em `/imersao-paranoa`
- Placeholders de acesso em `/login` e `/admin`
- Componentes reutilizáveis para navegação, seções, cards, galeria e FAQ
- Catálogo de experiências orientado a dados em `lib/experiences.ts`
- Sistema genérico de experiências, sessões e reservas
- Pré-reservas atômicas com validade exata de 2 horas
- Checkout InfinitePay desacoplado por `PaymentProvider`
- Confirmação de pagamento por webhook com verificação server-to-server
- Recuperação segura por CPF + código da reserva
- Expiração automática via Supabase Cron
- Acervo oficial da Alma Azul organizado em `public/images`

O painel administrativo continua fora do escopo atual.

## Stack

- Next.js 15 com App Router
- React 19 e TypeScript
- Tailwind CSS
- shadcn/ui e Radix UI
- Supabase

## Desenvolvimento

```bash
npm install
cp .env.example .env.local
npm run dev
```

Para habilitar reservas, aplique as migrations em `supabase/migrations` e defina:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
NEXT_PUBLIC_SITE_URL=https://your-domain.com
PAYMENT_PROVIDER=INFINITEPAY
INFINITEPAY_HANDLE=your-infinite-tag
```

`SUPABASE_SERVICE_ROLE_KEY` é utilizada somente em Route Handlers e nunca é enviada ao navegador. Reservas e eventos de pagamento não possuem leitura pública direta.

## Banco e disponibilidade

`create_pre_reservation` serializa criações por sessão, expira retenções vencidas e calcula disponibilidade considerando somente `CONFIRMED` e `PRE_RESERVED` ainda válidas. A função `expire_pre_reservations` é idempotente e executada automaticamente a cada minuto pelo Supabase Cron.

Para uma nova experiência, basta criar o registro em `experiences`, associar suas linhas em `sessions` e renderizar `SessionsSection` com o novo slug. O fluxo de reserva e pagamento não precisa ser alterado.

## Validação

```bash
npm test
npm run build
```
