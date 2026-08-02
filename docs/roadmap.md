# Roadmap do produto

[README](../README.md) · [Visão do produto](../PROJECT.md) · [Admin planejado](admin.md) · [Changelog](../CHANGELOG.md)

O roadmap não define datas de entrega. “Concluída no código” não significa automaticamente configurada ou validada em produção.

## Legenda

- **Concluída:** entrega confirmada no histórico e utilizável sem integração pendente essencial para o escopo daquela sprint.
- **Concluída no código:** implementação versionada, ainda dependente de ambiente externo para operação completa.
- **Planejada:** intenção de produto; não deve ser apresentada como funcionalidade existente.

## Sprint 1 — concluída

Commit: `9688e113850484cfccb602640c837e7a1b6b18ae`.

- Arquitetura inicial Next.js 15/App Router.
- Home institucional.
- Landing da Imersão Paranoá.
- Componentes reutilizáveis de navegação, conteúdo, galeria e FAQ.
- Placeholders de login e admin.
- Cliente Supabase inicial, ainda sem consultas.
- Acervo oficial organizado.
- Build e deploy inicial registrados no processo da sprint.

## Sprint 2 — concluída

Commit: `b677c99eb99dce2ebcd4834137e68f9dd77fda75`.

- Refinamento visual e responsivo.
- Revisão de textos e hierarquia.
- Navbar sticky com translucidez, blur e sombra.
- Microanimações discretas e respeito a movimento reduzido.
- Leitura de sessões do Supabase por Server Component.
- Exibição de data, horário, preço e vagas.
- Estados de loading, vazio e erro.

## Sprint 3 — concluída no código

Commit: `1874799dc6539aa5a8fca01fd88dc5b913c098b7`.

- Fluxo genérico de pré-reserva por sessão.
- Ciclo `PRE_RESERVED`, `CONFIRMED`, `EXPIRED`, `CANCELLED`.
- Retenção de vagas por 2 horas.
- Proteção contra overbooking com lock e cálculo no banco.
- Formulário validado e resumo da experiência.
- Contador e continuidade de pagamento.
- Página de acompanhamento por CPF + código.
- Migration com tabelas, funções, RLS, índices e Supabase Cron.
- Interface `PaymentProvider` e implementação InfinitePay.
- Webhook/retorno com verificação server-to-server.
- Testes automatizados de validação.

### Dependências ainda não confirmadas em produção

- Aplicação da migration no projeto Supabase correto.
- Existência e funcionamento do job `pg_cron` no ambiente real.
- Cadastro de sessões compatíveis com o novo schema.
- Variáveis públicas e privadas no Vercel.
- InfiniteTag e configuração de retorno/webhook na InfinitePay.
- Teste com pagamento real e procedimento para pagamento após expiração.

## Sprint 4 — concluída no código

Objetivo entregue: painel administrativo MVP.

- Login administrativo.
- Controle de administradores.
- Dashboard inicial.
- Criação e edição de sessões.
- Abertura, fechamento e cancelamento de sessões.
- Lista e filtros de reservas.
- Visualização segura dos dados necessários à operação.
- Confirmação manual protegida, caso a regra seja aprovada.
- Cancelamentos com auditoria.
- Receita prevista e confirmada.
- Estados de loading, sucesso, vazio e erro.
- Uso responsivo em celular e tablet pela equipe.

Consulte [admin.md](admin.md). A operação real ainda depende da aplicação da migration administrativa, das variáveis do Supabase e do cadastro de um usuário autorizado.

## Compatibilidade do banco — preparada no código, não aplicada

- conflito entre enums legados e os labels das Sprints 3/4 diagnosticado;
- migration idempotente e não destrutiva preparada;
- registro e seis sessões existentes preservados por desenho;
- `completed` mapeado para `CLOSED` e `spots_available` mantido apenas como legado;
- backup, inventário remoto, bootstrap transacional e validação ponta a ponta ainda pendentes de autorização.
- ordem operacional registrada: backup, inventário, bootstrap, validação, migrations 001/002/003, primeiro administrador e testes.

## Sprints futuras — planejadas

Os itens abaixo são direções, sem prazo ou sequência garantida:

- pagamentos em produção e observabilidade da InfinitePay;
- dashboard operacional mais completo;
- check-in de participantes;
- automações de comunicação;
- CRM;
- Analytics;
- novas experiências, incluindo Remada da Lua Cheia, Sunset, Sunrise, SUP Race, Team Building e aulas;
- domínio oficial e configuração definitiva de URLs;
- melhorias visuais com mídias oficiais de drone;
- conciliação, estorno e tratamento operacional de exceções de pagamento;
- testes de integração e ponta a ponta em ambiente seguro.

## Critérios para iniciar uma nova sprint

- Working tree limpo e `main` atualizada.
- Build e testes passando.
- Escopo e estado de produção da sprint anterior registrados.
- Sem prometer como ativo o que ainda depende de credenciais, migrations ou configuração externa.
- Novas experiências reutilizando o motor comum, sem atalhos específicos.
