# Changelog

## Sprint 5.2 — Experiências dinâmicas

- Adiciona contrato editorial JSONB versionado e validado no servidor.
- Cria `/experiencias/[slug]`, metadata dinâmica e 404 para conteúdo não publicado.
- Migra fielmente a Imersão Paranoá para o renderer compartilhado, preservando `/imersao-paranoa`.
- Faz a Home consumir somente experiências publicadas e ordenadas pelo Supabase.
- Amplia o painel com edição editorial completa, validação de publicação e preview protegido.
- Mantém imagens em `public/images` ou HTTPS, sem Supabase Storage.
- Preserva motor de reservas, pagamentos, autenticação, schema legado e migrations históricas.

Registro das mudanças confirmadas no histórico Git. O formato segue os princípios do [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/), organizado por sprint em vez de versões publicadas.

## Não publicado — compatibilidade do schema legado

### Adicionado

- Migration idempotente e não destrutiva para compatibilizar tabelas e enums legados com as Sprints 3 e 4.
- Cópia operacional em `supabase/bootstrap` para o bootstrap manual anterior às migrations 001 e 002 neste banco específico.
- Preservação explícita dos campos editoriais, IDs, relacionamentos e do snapshot legado `spots_available`.
- Documentação da ordem especial de bootstrap, backup, validação e recuperação.

### Estado

- Alterações somente locais; nenhuma migration foi executada e nenhum ambiente Supabase foi alterado.
- Aplicação depende de inventário remoto atualizado, backup e autorização explícita.

## Sprint 4 — painel administrativo MVP

**Estado:** concluída no código; ativação externa ainda depende da migration, do Supabase Auth e do cadastro do primeiro administrador.

### Adicionado

- Login real com Supabase Auth, cookies HttpOnly, renovação de sessão e proteção de rotas.
- Autorização explícita por `admin_users`, com papéis `ADMIN` e `OPERATOR`.
- Dashboard operacional em `/admin` e navegação responsiva.
- Gestão de sessões, experiências e reservas, incluindo filtros e detalhes.
- Confirmação manual e cancelamento de reservas com motivo, proteção de capacidade e auditoria.
- Configurações operacionais somente leitura e estados de loading, vazio, sucesso e erro.
- Migration administrativa com RPCs, RLS, grants, auditoria e configurações da plataforma.
- Testes de validação e garantias estáticas da migration.

### Limites confirmados

- A migration administrativa não foi aplicada ao Supabase por esta entrega.
- Nenhuma credencial real foi adicionada ao repositório; não havia `.env.local` no ambiente de validação.
- O primeiro usuário precisa ser criado no Supabase Auth e autorizado em `admin_users` pelo processo operacional documentado.
- O CPF completo continua sem persistência em texto simples; o painel exibe somente os quatro últimos dígitos e aceita CPF completo apenas como filtro server-side por hash.
- Reenvio de código e mensagem apenas preparam o contato; não existe integração de envio nesta sprint.

## Sprint 3 — ciclo de reservas

**Estado:** concluída no código; integrações externas ainda dependem de configuração.

**Commit:** [`1874799dc6539aa5a8fca01fd88dc5b913c098b7`](https://github.com/almaazulacademy/Imers-o-Parano-LandPage/commit/1874799dc6539aa5a8fca01fd88dc5b913c098b7) — 1º de agosto de 2026.

### Adicionado

- Página genérica de reserva por sessão em `/reservar/[sessionId]`.
- Formulário validado de participante, quantidade e observações.
- Tela de retenção com contador de 2 horas e código da reserva.
- Recuperação segura em `/acompanhar-reserva` com CPF + código.
- Rotas server-side para criação e consulta de reservas.
- Webhook e retorno de pagamento da InfinitePay.
- Interface `PaymentProvider` e implementação `InfinitePayProvider`.
- Migration com experiências, sessões, reservas, eventos de pagamento, RPCs, RLS, índices e cron de expiração.
- Testes da validação de CPF, telefone e dados de reserva.

### Alterado

- Cards de sessões passaram a usar as RPCs genéricas e direcionar para o fluxo de reserva.
- Navegação e rodapé receberam acesso à página de acompanhamento.
- README passou a registrar a configuração inicial do fluxo de reservas.

### Limites confirmados

- O commit não comprova que a migration foi aplicada no Supabase de produção.
- A InfinitePay requer `INFINITEPAY_HANDLE`, URLs públicas e configuração externa para operar.
- O painel administrativo permanece como placeholder.

## Sprint 2 — refinamento e leitura de sessões

**Estado:** concluída.

**Commit:** [`b677c99eb99dce2ebcd4834137e68f9dd77fda75`](https://github.com/almaazulacademy/Imers-o-Parano-LandPage/commit/b677c99eb99dce2ebcd4834137e68f9dd77fda75) — 1º de agosto de 2026.

### Adicionado

- Seção de próximas datas com estados de carregamento, vazio e erro.
- Cliente Supabase para Server Components.
- Microanimação de entrada respeitando `prefers-reduced-motion`.

### Alterado

- Hero, textos e chamadas para ação da Home.
- Navbar fixa com fundo translúcido, blur e sombra após o Hero.
- Conteúdo, espaçamento e hierarquia visual da Imersão Paranoá.
- Inclusos, duração, FAQ e âncoras da experiência.

### Limites confirmados

- A Sprint 2 fazia somente leitura e não criava reservas.
- Sem credenciais, a seção apresentava o estado vazio.

## Sprint 1 — fundação da plataforma

**Estado:** concluída.

**Commit:** [`9688e113850484cfccb602640c837e7a1b6b18ae`](https://github.com/almaazulacademy/Imers-o-Parano-LandPage/commit/9688e113850484cfccb602640c837e7a1b6b18ae) — 31 de julho de 2026.

### Adicionado

- Aplicação Next.js 15 com App Router, TypeScript e Tailwind CSS.
- Home institucional e landing da Imersão Paranoá.
- Navbar, rodapé, Hero, seções, cards, galeria e FAQ reutilizáveis.
- Placeholders de `/login` e `/admin`.
- Catálogo local em `lib/experiences.ts`.
- Cliente Supabase inicial, sem consultas na Sprint 1.
- Acervo oficial organizado em `public/images`.
- Configuração de build e dependências da aplicação.

[Voltar ao README](README.md)
