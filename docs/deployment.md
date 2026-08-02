# Configuração, recuperação e deploy

[README](../README.md) · [Arquitetura](architecture.md) · [Banco](database.md) · [Pagamentos](payments.md)

## Pré-requisitos

- Git.
- Node.js compatível com Next.js 15.
- npm ou pnpm. O repositório inclui `pnpm-lock.yaml` e `pnpm-workspace.yaml`; para instalações reproduzíveis, prefira pnpm.
- Projeto Supabase para ativar sessões/reservas.
- Conta InfinitePay com InfiniteTag para ativar o checkout.
- Projeto Vercel conectado ao GitHub para deploy automático.

Não são necessários Supabase, Vercel ou GitHub CLI para editar e compilar localmente. Eles podem ser úteis para operações administrativas, mas não devem ser instalados sem necessidade.

## Recuperar em outro computador

### 1. Clonar

```bash
git clone https://github.com/almaazulacademy/Imers-o-Parano-LandPage.git
cd Imers-o-Parano-LandPage
```

### 2. Confirmar origem, branch e commit

```bash
git remote -v
git branch --show-current
git log -1 --oneline
git status
```

O remoto esperado é:

```text
https://github.com/almaazulacademy/Imers-o-Parano-LandPage.git
```

A branch de publicação atual é `main`.

### 3. Instalar dependências

Com pnpm:

```bash
pnpm install --frozen-lockfile
```

Alternativa com npm:

```bash
npm install
```

Não misture gerenciadores durante uma mesma alteração de dependências. Se uma dependência mudar, revise o lockfile resultante antes do commit.

### 4. Criar o ambiente local

macOS/Linux:

```bash
cp .env.example .env.local
```

PowerShell:

```powershell
Copy-Item .env.example .env.local
```

Substitua somente no arquivo local. `.env.local` é ignorado pelo Git.

### 5. Rodar

```bash
npm run dev
```

Abra `http://localhost:3000`.

Sem configuração do Supabase, as páginas institucionais carregam, a seção de sessões usa o estado vazio e as APIs de reserva respondem que o sistema ainda não está configurado.

## Variáveis de ambiente

Nunca registre valores reais em Markdown, logs, screenshots ou commits.

### Públicas

Estas variáveis podem aparecer no bundle por usarem o prefixo `NEXT_PUBLIC_`:

| Nome | Uso |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | URL do projeto Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Chave anônima usada pelo cliente público/browser |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Alternativa aceita pelo cliente Supabase de servidor público |
| `NEXT_PUBLIC_SITE_URL` | Origem canônica para retorno e webhook do checkout |

O fluxo atual usa `NEXT_PUBLIC_SUPABASE_ANON_KEY` no helper de navegador. Se a migração para publishable key for concluída no futuro, revise também `lib/supabase/client.ts`.

### Privadas

| Nome | Uso |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | RPCs e leituras protegidas nos Route Handlers |
| `PAYMENT_PROVIDER` | Seleção do provedor; o único valor suportado atualmente é `INFINITEPAY` |
| `INFINITEPAY_HANDLE` | InfiniteTag da conta recebedora, sem `$` |

Embora `INFINITEPAY_HANDLE` não seja uma chave de API no contrato atual, ela permanece server-side no código.

### Futuras de pagamento

Não existem outros nomes consumidos pelo código. Se a InfinitePay ou outro provedor passar a exigir token, assinatura de webhook ou chave privada, adicione variáveis privadas com nomes documentados e nunca use o prefixo `NEXT_PUBLIC_`.

## Conectar e preparar o Supabase

1. Crie ou selecione o projeto correto no Supabase.
2. Faça backup e confira o schema atual antes de aplicar qualquer migration.
3. Revise [database.md](database.md), especialmente a compatibilidade com uma tabela `sessions` preexistente.
4. Aplique, pelo processo aprovado da equipe, `supabase/migrations/202608010001_reservation_platform.sql`.
5. Confirme as tabelas, funções, policies, grants, índices e o job `expire-alma-azul-pre-reservations`.
6. Configure URL, chave pública e service role nos ambientes local e Vercel.
7. Cadastre sessões futuras com `experience_id`, `starts_at`, `duration_minutes`, `price_cents`, `capacity` e status `OPEN`.
8. Valide leitura, concorrência de pré-reservas, expiração e RLS antes de abrir reservas ao público.

Esta documentação não executa a migration. Não aplique SQL em produção sem backup e revisão do ambiente real.

## Testes e build

```bash
npm test
npm run build
```

Scripts disponíveis:

| Script | Comando efetivo |
| --- | --- |
| `npm run dev` | `next dev` |
| `npm run build` | `next build` |
| `npm run start` | `next start` |
| `npm run lint` | `next lint` |
| `npm test` | runner nativo do Node com strip de tipos |

Observação: o script `lint` está presente no `package.json`, mas o Next.js 15 atual pode não oferecer o comando legado `next lint` em todas as versões. O build já executa verificação de tipos/lint integrada conforme a saída do framework.

## Commit e push

```bash
git status
git diff --check
git add <arquivos-do-escopo>
git commit -m "mensagem objetiva"
git push origin main
git status
```

Prefira caminhos explícitos no `git add` quando houver alterações de outros trabalhos. Nunca use force push em `main`.

Para testar permissão sem publicar:

```bash
git push --dry-run origin main
```

## Configurar Vercel

1. Importe no Vercel o repositório `almaazulacademy/Imers-o-Parano-LandPage`.
2. Selecione Next.js como framework e a raiz do repositório como Root Directory.
3. Use o comando de build padrão `npm run build` ou o gerenciador detectado pelo lockfile.
4. Cadastre todas as variáveis aplicáveis em Production, Preview e Development conforme a política da equipe.
5. Defina `NEXT_PUBLIC_SITE_URL` com a URL pública canônica de produção.
6. Garanta que a branch de produção seja `main`.
7. Faça um deploy e verifique logs, sessões, reserva, retorno e webhook.

### Deploy automático

Quando a integração Git da Vercel acompanha `main`, cada `git push origin main` cria um novo deployment. O push por si só não comprova que o projeto Vercel está conectado; confirme o deployment no dashboard e verifique o domínio servido.

Preview deployments de outras branches dependem da configuração do projeto Vercel.

## Checklist pós-deploy

- Build concluído sem erro.
- Home e `/imersao-paranoa` renderizam com imagens.
- Sessões futuras aparecem e exibem preço/vagas corretos.
- Pré-reserva cria código e validade de 2 horas.
- Checkout abre no domínio HTTPS da InfinitePay.
- Retorno e webhook alcançam o domínio público.
- Pagamento confirmado muda a reserva para `CONFIRMED`.
- CPF sozinho não recupera reserva.
- Expiração deixa de contar vagas e muda status via cron.
- `/admin` e `/login` continuam placeholders até a Sprint 4.

## Erros comuns

### “Sistema de reservas ainda não configurado”

Faltam `NEXT_PUBLIC_SUPABASE_URL` e/ou `SUPABASE_SERVICE_ROLE_KEY` no ambiente da função.

### A seção mostra “Novas datas serão abertas em breve”

Pode não haver credencial pública, migration aplicada ou sessões `OPEN`, futuras e com vagas. O estado vazio não diferencia essas causas; confira logs e banco.

### Erro ao ler RPC

Confirme que a migration foi aplicada e que `list_open_sessions`/`get_booking_session` têm grants para a chave utilizada.

### Checkout não é criado

Confirme `PAYMENT_PROVIDER=INFINITEPAY`, `INFINITEPAY_HANDLE` e `NEXT_PUBLIC_SITE_URL`. Por segurança, o código cancela a pré-reserva quando não consegue associar o checkout.

### Webhook retorna 400

Confira `order_nsu`, `transaction_nsu`, `invoice_slug`/`slug`, conectividade com `payment_check`, valor esperado e credenciais do Supabase.

### Build funciona localmente e falha na Vercel

Compare versão do Node, variáveis dos ambientes, comando de instalação, lockfile e Root Directory. Leia a primeira falha real do log, não apenas a mensagem final.

### Git aponta repositório incorreto

```bash
git remote set-url origin https://github.com/almaazulacademy/Imers-o-Parano-LandPage.git
git remote -v
```

Só altere o remote depois de confirmar que o checkout é realmente este projeto.

## Segurança operacional

- Nunca exponha `SUPABASE_SERVICE_ROLE_KEY` no navegador.
- Não commite `.env.local`.
- Não use dados pessoais reais em testes ou documentação.
- Não copie payloads de pagamento/participantes para issues públicas.
- Revogue e substitua imediatamente qualquer segredo que apareça em commit ou log.
- Faça backup antes de migrations e registre quem aplicou, quando e em qual projeto.
