# Alma Azul Academy

Plataforma oficial da Alma Azul Academy. A Imersão Paranoá é a primeira experiência de um catálogo preparado para receber novos formatos, como Remada da Lua Cheia, Sunset, aulas, Team Building e loja.

## Sprint 1

- Home institucional em `/`
- Landing page da Imersão Paranoá em `/imersao-paranoa`
- Placeholders de acesso em `/login` e `/admin`
- Componentes reutilizáveis para navegação, seções, cards, galeria e FAQ
- Catálogo de experiências orientado a dados em `lib/experiences.ts`
- Configuração inicial do cliente Supabase, sem queries
- Acervo oficial da Alma Azul organizado em `public/images`

Reservas, pagamentos e painel administrativo funcional não fazem parte desta sprint.

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

O site funciona sem credenciais Supabase nesta sprint. Para preparar a integração futura, defina:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

## Validação

```bash
npm run build
```
