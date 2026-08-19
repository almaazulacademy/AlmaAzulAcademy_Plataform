# Alma Azul Academy

Plataforma oficial de experiências da Alma Azul Academy. A Imersão Paranoá é a primeira experiência publicada de uma arquitetura preparada para novos formatos na água.

## Status atual

| Área | Estado |
| --- | --- |
| Home e landing da Imersão Paranoá | Implementadas |
| Galeria, FAQ e identidade responsiva | Implementadas |
| Leitura de sessões e vagas | Implementada no código; exige Supabase configurado |
| Pré-reserva por 2 horas | Implementada no código/migration |
| Acompanhamento por CPF + código | Implementado no código/migration |
| InfinitePay | Integração preparada; configuração e teste em produção não confirmados |
| Painel administrativo | Implementado no código; exige migration, Supabase Auth e administrador ativo |

Não presuma que reservas ou pagamentos estejam ativos em produção sem confirmar migration, credenciais, sessões, cron e configuração da InfinitePay.

## Tecnologias

- Next.js 15 com App Router
- React 19 e TypeScript estrito
- Tailwind CSS
- shadcn/ui e Radix UI
- Supabase/PostgreSQL
- InfinitePay atrás de `PaymentProvider`
- Vercel e GitHub

## Rotas principais

| Rota | Finalidade |
| --- | --- |
| `/` | Home institucional |
| `/agenda` | Agenda geral com as próximas sessões de todas as experiências |
| `/experiencias/[slug]` | Landing pública da experiência e próximas sessões |
| `/imersao-paranoa` | Redirect permanente (308) para `/experiencias/imersao-paranoa` |
| `/reservar/[sessionId]` | Formulário e resumo da sessão |
| `/acompanhar-reserva` | Recuperação segura por CPF + código |
| `/pagamento/retorno` | Retorno e verificação do checkout |
| `/login` | Login administrativo com Supabase Auth |
| `/admin` | Dashboard operacional protegido |
| `/admin/sessoes` | Criação e gestão de sessões |
| `/admin/reservas` | Filtros, detalhes e ações sobre reservas |
| `/admin/experiencias` | Cadastro e publicação de experiências |
| `/admin/configuracoes` | Configuração operacional somente leitura |

APIs server-side:

- `POST /api/reservations`
- `POST /api/reservations/lookup`
- `POST /api/payments/infinitepay/webhook`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `/api/admin/*` para mutações administrativas autenticadas

## Instalação local

```bash
git clone https://github.com/almaazulacademy/Imers-o-Parano-LandPage.git
cd Imers-o-Parano-LandPage
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

No PowerShell, use `Copy-Item .env.example .env.local`.

Também é possível usar os scripts com npm:

```bash
npm install
npm run dev
```

Sem credenciais, as páginas públicas continuam disponíveis, mas sessões/reservas usam estados de configuração ausente.

## Variáveis de ambiente

Use `.env.example` como referência. Nunca registre valores reais no Git.

### Públicas

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
NEXT_PUBLIC_SITE_URL
```

### Privadas

```text
SUPABASE_SERVICE_ROLE_KEY
PAYMENT_PROVIDER
INFINITEPAY_HANDLE
```

`SUPABASE_SERVICE_ROLE_KEY` deve existir somente em ambiente server-side. Consulte [docs/deployment.md](docs/deployment.md) para finalidade, ambientes e recuperação completa.

## Banco e reservas

As migrations versionadas são:

```text
supabase/migrations/202608010001_reservation_platform.sql
supabase/migrations/202608010002_admin_dashboard_mvp.sql
```

A primeira define reservas, pagamentos, RPCs, RLS, índices e expiração. A segunda adiciona autorização administrativa, auditoria, configurações e RPCs operacionais. Aplique-as em ordem, com backup e revisão do schema real.

O cálculo de vagas é protegido no banco:

```text
capacidade - CONFIRMED - PRE_RESERVED ainda válida
```

`create_pre_reservation` bloqueia a sessão durante o cálculo para impedir overbooking. A retenção termina em 2 horas; a disponibilidade ignora retenções vencidas e o cron as marca como `EXPIRED`.

## Scripts

| Comando | Uso |
| --- | --- |
| `npm run dev` | Desenvolvimento local |
| `npm run build` | Build de produção e validação do Next.js |
| `npm run start` | Servidor sobre build existente |
| `npm run lint` | Script legado de lint configurado no projeto |
| `npm test` | Testes de validação com o runner do Node |

Validação mínima antes de publicar:

```bash
npm test
npm run build
git diff --check
```

## Deploy

O destino previsto é a Vercel. Quando o projeto Vercel está conectado a este repositório e acompanha `main`, um push pode iniciar deploy automático:

```bash
git push origin main
```

O push não comprova sozinho que o deployment terminou. Verifique o dashboard, logs, variáveis e domínio. O guia completo está em [docs/deployment.md](docs/deployment.md).

## Documentação

- [PROJECT.md](PROJECT.md) — visão e princípios do produto
- [CHANGELOG.md](CHANGELOG.md) — histórico confirmado por sprint
- [docs/architecture.md](docs/architecture.md) — arquitetura, rotas e componentes
- [docs/database.md](docs/database.md) — schema, RPCs, RLS, capacidade e migrations
- [docs/editorial-experiences.md](docs/editorial-experiences.md) — contrato editorial, rotas dinâmicas, preview e ativação
- [docs/deployment.md](docs/deployment.md) — recuperação, ambientes e Vercel
- [docs/roadmap.md](docs/roadmap.md) — entregas concluídas e planejadas
- [docs/admin.md](docs/admin.md) — autenticação, operação e ativação do painel
- [docs/payments.md](docs/payments.md) — pré-reserva, InfinitePay e pendências
- [docs/google-sheets-integration.md](docs/google-sheets-integration.md) — sincronização das reservas confirmadas com a planilha operacional

## Contribuição

1. Atualize a branch e confirme o remote.
2. Mantenha cada alteração dentro do escopo aprovado.
3. Não crie regras específicas da Imersão Paranoá quando o domínio puder atender qualquer experiência.
4. Preserve regras críticas no banco/servidor.
5. Evite dependências desnecessárias e duplicação.
6. Atualize documentação e testes quando contratos mudarem.
7. Execute testes e build.
8. Revise `git status` e `git diff` antes do commit.
9. Nunca use force push em `main`.

## Segurança

- Não commite `.env.local`, chaves, tokens, senhas, CPFs ou payloads reais.
- Não exponha service role no navegador.
- Não permita recuperação apenas por CPF.
- Não calcule disponibilidade somente no frontend.
- Não confirme pagamento sem consulta server-to-server e validação do valor.
- Não crie acesso administrativo antes de implementar autenticação e autorização reais.
- Faça backup e revise RLS/grants antes de migrations.

## Roadmap imediato

A Sprint 4 entrega o painel administrativo MVP no código. A ativação exige aplicar as migrations em ordem, configurar o Supabase e autorizar o primeiro administrador. Consulte [docs/roadmap.md](docs/roadmap.md) e [docs/admin.md](docs/admin.md).
