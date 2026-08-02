# Painel administrativo — planejado

[README](../README.md) · [Roadmap](roadmap.md) · [Arquitetura](architecture.md) · [Banco](database.md)

> **Estado:** planejado para a Sprint 4. O código atual contém somente páginas estáticas de placeholder em `/login` e `/admin`. Não existe autenticação, sessão administrativa, tabela `profiles`, papel de administrador ou API de gestão.

## Objetivo planejado

Dar à equipe Alma Azul uma área simples e segura para acompanhar a operação, criar sessões e agir sobre reservas sem acesso direto ao dashboard do banco.

O painel deve reutilizar o mesmo domínio de `experiences`, `sessions` e `reservations`; não deve manter uma segunda regra de capacidade.

## Requisitos da Sprint 4

Todos os itens desta seção estão **planejados**:

- autenticação administrativa;
- autorização explícita de administradores;
- dashboard operacional;
- criação e edição de sessões;
- alteração controlada de status da sessão;
- listagem, busca e filtros de reservas;
- consulta dos dados pessoais estritamente necessários;
- confirmação manual, se aprovada como regra de negócio;
- cancelamento de reservas;
- receita prevista e confirmada;
- feedback de loading, vazio, sucesso e erro;
- navegação responsiva para desktop, tablet e celular;
- auditoria das ações sensíveis.

## Rotas planejadas

Os caminhos abaixo são sugestões de organização para a Sprint 4, não rotas existentes:

| Rota planejada | Responsabilidade esperada |
| --- | --- |
| `/login` | Substituir o placeholder por autenticação administrativa |
| `/admin` | Dashboard protegido |
| `/admin/sessoes` | Lista e filtros de sessões |
| `/admin/sessoes/nova` | Criação de sessão |
| `/admin/sessoes/[id]` | Edição e visão operacional |
| `/admin/reservas` | Lista e filtros de reservas |
| `/admin/reservas/[id]` | Detalhes e ações permitidas |

Os nomes definitivos devem ser validados na Sprint 4 antes da implementação.

## Autenticação esperada

**Planejado:** usar autenticação server-side compatível com Supabase Auth e o App Router. A escolha exata de cookies, middleware e claims ainda não está implementada.

Requisitos mínimos:

- sessão protegida e verificável no servidor;
- logout e expiração de sessão;
- redirecionamento de usuários não autenticados;
- proteção de páginas e Route Handlers;
- nenhuma confiança em flags enviadas pelo frontend.

## Controle de administradores

**Planejado:** um mecanismo explícito de autorização, separado do simples fato de uma pessoa possuir conta.

A migration atual não contém `profiles` ou `admin_users`. A Sprint 4 deve escolher e documentar uma destas estratégias antes de criar schema:

- tabela protegida de administradores ligada a `auth.users`;
- custom claims gerenciadas de forma segura;
- solução equivalente com auditoria e revogação.

Não conceder acesso administrativo por domínio de email, parâmetro de URL ou variável no cliente.

## Gestão de sessões

**Planejado:** criar e editar os campos reais de `sessions`:

- experiência associada;
- data/hora de início;
- duração em minutos;
- preço em centavos, com interface em reais;
- capacidade;
- status `OPEN`, `CLOSED` ou `CANCELLED`.

Regras a preservar:

- não reduzir capacidade abaixo das vagas já confirmadas/retenções válidas;
- não apagar sessões com histórico;
- tratar timezone de Brasília de forma explícita na interface;
- refletir imediatamente o status na listagem pública;
- usar validação e autorização no servidor.

## Gestão de reservas

**Planejado:** oferecer consulta por sessão, data, status, código e contato, respeitando a necessidade operacional e a LGPD.

Possíveis ações planejadas:

- ver resumo da reserva;
- confirmar manualmente, somente quando permitido e auditado;
- cancelar;
- copiar contato para comunicação operacional;
- identificar retenções vencidas;
- visualizar evento de pagamento sem expor payloads desnecessários.

O painel não deve editar diretamente o status sem uma função protegida que valide transições e capacidade.

## Confirmação manual e cancelamentos

**Planejado, sujeito a decisão de produto:** confirmação manual pode atender pagamentos externos ou exceções operacionais.

Antes de implementar:

- definir quem pode confirmar;
- exigir motivo e registrar autor/data;
- bloquear a sessão e recalcular vagas;
- impedir confirmação quando causar overbooking;
- definir se cancelamento devolve vaga e como tratar pagamento/estorno;
- diferenciar cancelamento operacional de expiração automática.

A migration atual registra apenas `cancelled_at`; não registra autor ou motivo. Alterações de schema pertencem à Sprint 4 e devem ser versionadas em nova migration.

## Receita prevista e confirmada

**Planejado:** calcular com dados existentes, sem usar valores do frontend:

- prevista: soma de `total_cents` de `PRE_RESERVED` ainda válidas e `CONFIRMED`, se essa definição for aprovada;
- confirmada: soma de `total_cents` de `CONFIRMED`;
- separar canceladas, expiradas e pagamentos após expiração.

As definições contábeis devem ser validadas com a operação antes da interface. O painel não substitui conciliação financeira do provedor.

## Estados de interface

**Planejado:** cada consulta e mutação deve ter:

- loading perceptível;
- estado vazio útil;
- sucesso com confirmação da ação;
- erro amigável e log técnico no servidor;
- prevenção de cliques duplicados;
- confirmação adicional para ações sensíveis.

## Segurança obrigatória

- Service role somente no servidor.
- RLS habilitado e revisado para qualquer tabela nova.
- Route Handlers com autenticação e autorização.
- Dados pessoais limitados ao necessário.
- Sem CPF completo em URLs, logs, Analytics ou mensagens de erro.
- Auditoria para confirmação, cancelamento e alteração de capacidade.
- Proteção contra CSRF/replay conforme o mecanismo de sessão escolhido.
- Revisão do acesso em Preview Deployments.
- Testes de usuário não autenticado, operador e administrador revogado.

## Experiência mobile planejada

A equipe pode operar em campo. As ações prioritárias devem funcionar em celular:

- consultar sessão do dia;
- localizar participante;
- visualizar status;
- executar check-in futuro;
- confirmar uma ação com segurança.

Tabelas extensas devem virar listas/cards ou permitir scroll controlado sem esconder ações importantes.

## Decisões que devem ser preservadas

- Painel reutiliza o motor existente; não duplica tabelas de sessão/reserva.
- Capacidade continua protegida no banco.
- Transições sensíveis passam por RPCs server-side.
- A Imersão Paranoá é apenas uma experiência entre várias.
- Dados e receitas usam centavos inteiros, não ponto flutuante.
- Expiração automática continua independente do painel.
- A existência de `/admin` não significa que o acesso já está protegido; o placeholder deve ser substituído antes de qualquer dado real aparecer.
