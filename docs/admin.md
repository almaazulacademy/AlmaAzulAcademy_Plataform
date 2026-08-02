# Painel administrativo

[README](../README.md) · [Roadmap](roadmap.md) · [Arquitetura](architecture.md) · [Banco](database.md)

> **Estado:** implementado no código na Sprint 4. O ambiente validado não possuía `.env.local`, e a migration administrativa não foi aplicada por esta entrega. O uso real depende dos passos de ativação abaixo.

> **Compatibilidade pendente:** o schema remoto informado é legado. A migration de compatibilidade foi preparada localmente, mas não foi executada. A migration administrativa 002 só deve ser aplicada depois do bootstrap compatível e da 001 concluída e validada.

## Objetivo

Permitir que a equipe opere experiências, sessões e reservas sem acessar diretamente o dashboard do banco. O painel reutiliza as tabelas e as regras do motor público; não existe um segundo cálculo de capacidade.

## Rotas

| Rota | Responsabilidade |
| --- | --- |
| `/login` | Autenticação com email e senha do Supabase Auth |
| `/admin` | Indicadores operacionais e acesso a nova sessão |
| `/admin/sessoes` | Criar, editar, duplicar, abrir, fechar e excluir sessões sem histórico |
| `/admin/reservas` | Listar e filtrar reservas |
| `/admin/reservas/[reservationId]` | Ver dados, pagamento e ações de uma reserva |
| `/admin/experiencias` | Criar, editar, publicar, arquivar e ordenar experiências |
| `/admin/configuracoes` | Consultar configurações operacionais sem editar dados sensíveis |

As rotas `/admin/*` e `/api/admin/*` são protegidas pelo middleware. As páginas e APIs verificam novamente a autorização administrativa no servidor.

## Autenticação e sessão

O login usa `signInWithPassword` do Supabase Auth. Tokens ficam em cookies HttpOnly, `SameSite=Lax` e `Secure` em produção. O middleware:

1. valida o access token com o Supabase;
2. tenta renovar a sessão com o refresh token quando necessário;
3. atualiza ambos os cookies;
4. redireciona sessões ausentes ou inválidas para `/login`;
5. responde `401` ou `503` para APIs, sem devolver HTML.

Login, logout e mutações administrativas exigem uma origem compatível com o host recebido ou com `NEXT_PUBLIC_SITE_URL`. O logout remove os cookies da aplicação.

## Autorização

Ter uma conta no Supabase Auth não concede acesso. A tabela `admin_users` liga `auth.users.id` a um papel ativo:

- `ADMIN`;
- `OPERATOR`.

Uma conta inativa ou ausente é rejeitada mesmo com email e senha válidos. A service role nunca é enviada ao navegador.

## Ativação inicial

1. No banco legado, conclua a ordem documentada em [deployment.md](deployment.md): backup, inventário, bootstrap manual, validação, migrations 001, 002 e 003.
2. Confirme que as três migrations e todos os objetos administrativos foram validados.
3. Crie a conta administrativa pelo fluxo seguro do Supabase Auth. Não insira senha por SQL.
4. Autorize o UUID criado, substituindo os valores de exemplo:

```sql
insert into public.admin_users (user_id, display_name, role)
values ('00000000-0000-0000-0000-000000000000', 'Nome da pessoa', 'ADMIN');
```

5. Confirme que a conta consegue entrar e que outra conta Auth sem linha ativa recebe acesso negado.
6. Valide RLS, grants e logs de auditoria antes de usar dados reais.

O cadastro inicial exige acesso administrativo ao Supabase porque ainda não deve existir uma interface pública capaz de promover usuários.

## Dashboard

O dashboard obtém uma fotografia server-side por RPC e mostra:

- próxima sessão;
- sessões futuras;
- reservas confirmadas;
- pré-reservas ainda válidas;
- receita prevista;
- receita confirmada;
- participantes confirmados;
- última atualização.

Receita prevista soma confirmadas e pré-reservas válidas. Receita confirmada soma somente `CONFIRMED`. Os valores são calculados em centavos no banco e não substituem a conciliação financeira.

## Sessões

A tela trabalha com qualquer registro de `experiences`. Criação e edição validam experiência, data/hora de Brasília, duração, preço, capacidade, status e observações internas.

Regras protegidas no banco:

- novas sessões precisam estar no futuro;
- capacidade não pode ficar abaixo de confirmadas e pré-reservas válidas;
- experiência associada não pode mudar depois que a sessão recebe uma reserva;
- sessões com histórico de reservas não podem ser excluídas;
- abrir e fechar reservas altera o status real lido pela landing pública;
- todas as mutações geram auditoria.

Duplicar apenas preenche um novo formulário. A criação continua passando pela mesma validação e RPC.

## Experiências

O painel cadastra slug, nome, resumo, imagem oficial, ordem e status `DRAFT`, `PUBLISHED` ou `ARCHIVED`. Ativar publica a experiência; desativar a devolve para rascunho. O slug não é alterado na edição para preservar URLs e referências.

Cadastrar uma experiência no banco não cria automaticamente sua landing editorial. Conteúdo público e registro transacional continuam responsabilidades separadas.

## Reservas

Os filtros aceitam data, experiência, status, nome, telefone, CPF e sessão. A consulta é limitada a 500 registros e executada server-side.

Por segurança e coerência com a migration de reservas:

- CPF completo não é persistido nem exibido;
- a listagem e o detalhe mostram apenas os quatro últimos dígitos;
- um CPF completo informado no filtro é normalizado e comparado pelo hash SHA-256 dentro da RPC;
- até quatro dígitos podem filtrar por `cpf_last4`;
- CPF nunca aparece em URL, log, toast ou auditoria.

Copiar WhatsApp e email usa os dados já autorizados na tela. Reenviar código e enviar mensagem apenas preparam um texto/atalho para revisão humana; a Sprint 4 não afirma ter enviado comunicação.

## Ações sensíveis

Confirmação manual e cancelamento exigem motivo. As RPCs registram ator, data, entidade, motivo e metadados.

A confirmação manual:

- bloqueia reserva e sessão;
- expira outras retenções vencidas;
- recalcula a ocupação;
- impede overbooking;
- registra um evento `PAYMENT_CONFIRMED_MANUAL`;
- rejeita reservas canceladas e sessões canceladas.

Cancelar uma reserva confirmada libera a vaga, mas não executa estorno no provedor. A interface avisa isso antes da confirmação; conciliação e estorno permanecem processos operacionais separados.

## Configurações

`platform_settings` guarda nome da empresa, WhatsApp, email e chave PIX. A tela também indica o provedor selecionado, se a InfinitePay está configurada e o domínio público. Credenciais privadas não são carregadas nem exibidas, e nenhum desses campos pode ser editado no MVP.

## Estados e responsividade

- `loading.tsx` cobre navegação server-side.
- `error.tsx` oferece falha amigável e nova tentativa.
- listas possuem estados vazios com próxima ação.
- formulários exibem validação, progresso, sucesso e erro por toast.
- exclusões, cancelamentos e confirmações usam diálogo de confirmação.
- a sidebar é fixa no desktop e vira menu em tablet/celular.
- reservas e sessões usam cards responsivos em vez de depender de tabelas largas.

## Limites de validação desta entrega

Testes de TypeScript, validação, invariantes da migration, build e interface sem credenciais foram executados. Sem `.env.local` e sem aplicar SQL remoto, não foi possível autenticar uma conta real nem executar CRUD ponta a ponta contra o Supabase. Esses testes devem fazer parte da ativação em ambiente seguro.
