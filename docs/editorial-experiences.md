# Experiências dinâmicas

## Fonte canônica

`experiences.editorial_content` é o documento editorial público, versionado com `version: 1`. As colunas `slug`, `title`, `summary`, `status`, `image_url` e `display_order` continuam consultáveis e ordenáveis. Campos legados permanecem intactos.

O contrato TypeScript e sua validação server-side ficam em `lib/editorial/experience.ts`. Uma experiência só pode ser publicada quando Hero, informações rápidas, Sobre, reservas, SEO e imagens obrigatórias estiverem completos. Galeria, etapas, itens inclusos, o que levar, restrições e FAQ são opcionais; quando presentes, não podem estar vazios.

## Imagens

Esta Sprint não usa Supabase Storage. Cada imagem contém `src`, `alt` e `credit` opcional. `src` aceita somente caminhos `/images/...` versionados no repositório ou URLs HTTPS.

## Leitura pública

- `get_public_experience(slug)` retorna uma projeção pública de uma experiência `PUBLISHED`.
- `list_public_experiences()` retorna somente experiências `PUBLISHED`, ordenadas por `display_order` e título.
- Ambas as RPCs omitem duração, preço e capacidade padrão, timestamps e outros campos administrativos.
- Escritas continuam restritas às RPCs administrativas chamadas com service role após autenticação e autorização.

## Rotas

- `/experiencias/[slug]`: landing pública dinâmica; retorna 404 para slug inexistente, rascunho ou arquivado.
- `/imersao-paranoa`: alias compatível que usa o mesmo renderer e o mesmo conteúdo editorial.
- `/preview/experiencias/[experienceId]`: preview protegido por autenticação administrativa, inclusive para rascunhos.

## Painel

O painel edita o documento JSON completo e preserva a ordem dos arrays. O preview aponta campos obrigatórios ausentes. A criação gera o slug a partir do título; unicidade é garantida pelo banco e palavras reservadas são bloqueadas no servidor e na RPC.

## Compatibilidade e ativação

A migration `202608030002_dynamic_experiences.sql` é aditiva. Ela inclui o conteúdo da Imersão Paranoá sem alterar textos, cria as RPCs públicas e atualiza as RPCs administrativas para transportar `editorial_content`.

Antes de aplicar em produção, faça inventário e backup conforme `deployment.md`. Depois da aplicação, valide Home, as duas URLs da Imersão, sessões e reserva. O fallback local da Imersão existe apenas quando Supabase/RPC ainda não está disponível; uma resposta válida do banco respeita integralmente o status publicado.
