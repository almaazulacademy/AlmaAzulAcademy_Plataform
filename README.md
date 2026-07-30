# Imersão Paranoá — Alma Azul

Projeto Next.js + Supabase preparado para Vercel.

## 1. Supabase
Abra SQL Editor e execute `supabase/schema.sql`.
Crie seu usuário em Authentication > Users.
Depois execute o trecho final do SQL com seu e-mail para torná-lo administrador.

## 2. Variáveis locais
Copie `.env.example` para `.env.local` e preencha Pix e WhatsApp.

## 3. Rodar localmente
```bash
npm install
npm run dev
```

## 4. GitHub
Envie todos os arquivos para a raiz do repositório.

## 5. Vercel
Importe o repositório e adicione as quatro variáveis do `.env.example` em Settings > Environment Variables.
