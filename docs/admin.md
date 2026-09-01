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
| `/admin/sessoes` | Criar, editar, duplicar, abrir, fechar, excluir sessões sem histórico e arquivar/restaurar sessões com histórico |
| `/admin/reservas` | Listar e filtrar reservas |
| `/admin/reservas/[reservationId]` | Ver dados, pagamento, histórico de turma e ações de uma reserva |
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
- sessões sem nenhuma reserva vinculada são excluídas definitivamente;
- sessões com histórico de reservas são arquivadas em vez de excluídas — nenhuma reserva, pagamento ou participante é apagado;
- abrir e fechar reservas altera o status real lido pela landing pública;
- todas as mutações geram auditoria.

Duplicar apenas preenche um novo formulário. A criação continua passando pela mesma validação e RPC.

### Busca e filtros

A tela usa o mesmo cartão de filtros de `/admin/reservas`, com estado preservado na URL (a seleção sobrevive ao recarregar e ao salvar uma sessão):

- busca (`busca`) por nome da experiência, data e horário, sem acento e sem caixa; identificadores técnicos não entram na busca;
- status (`filtro`): `ativas`, `abertas`, `fechadas`, `canceladas`, `arquivadas`, `todas`;
- experiência (`experiencia`), preenchida com o que estiver cadastrado em `experiences`;
- data (`periodo`): `todas`, `proximas`, `passadas`, `hoje`, mais o intervalo personalizado `de` e `ate`;
- ordenação (`ordem`): `proximas` (padrão), `recentes`, `antigas`.

`admin_list_sessions` não muda: a RPC é chamada uma única vez com o recorte de arquivamento (`ACTIVE`, `ARCHIVED` ou `ALL`) e os demais filtros são aplicados em `lib/admin/session-filters.ts`, no servidor, sem consulta adicional.

### Agenda de setembro de 2026

`supabase/migrations/202608090001_september_2026_schedule.sql` cria as 44 sessões do mês (Imersão Paranoá 28, Remada do Nascer do Sol 8, Remada Sunset 8) sem cadastro manual:

- sextas 05:30 Nascer do Sol, 09:00 Imersão, 17:00 Sunset; sábados 06:00 Nascer do Sol e 09:00/12:00/15:00 Imersão; domingos 09:00/12:00/15:00 Imersão e 17:00 Sunset;
- 90 minutos, R$ 70,00 (`price_cents` 7000), status `OPEN` e capacidade lida de `experiences.default_capacity`;
- as datas saem do calendário (`generate_series` + `isodow`) e os horários viram `timestamptz` via `make_timestamptz(..., 'America/Sao_Paulo')`, sem soma manual de fuso;
- experiências resolvidas por slug — `imersao-paranoa`, `remada-nascer-do-sol`, `remada-sunset` —, nunca por UUID fixo;
- tudo dentro de um único bloco `do`: qualquer pré-requisito ausente aborta antes de inserir, sem inserção parcial;
- idempotente por `experience_id` + `starts_at`: uma sessão já cadastrada é preservada como está, sem `UPDATE` e sem `DELETE`;
- a coluna legada `spots_available` (NOT NULL e sem default no banco de produção, ausente em instalação limpa) é detectada em tempo de execução e preenchida com a capacidade da sessão — o mesmo valor que `available_spots(id)` devolve enquanto a sessão não tem reserva. Qualquer outra coluna obrigatória sem default continua abortando a migration, porque o valor correto dela não pode ser adivinhado.

A capacidade padrão da Imersão Paranoá ficou em 15 até `202608090002_imersao_paranoa_default_capacity.sql`: a experiência é anterior à coluna `default_capacity` e foi preenchida pelo backfill genérico `coalesce(default_capacity, 15)` da migration da Sprint 5, enquanto Sunset, Nascer do Sol e Lua Cheia já nasceram com 28. A correção mexe só nessa linha e só nessa coluna; `supabase/diagnostics/experiences_default_capacity_check.sql` confirma as três em 28.

Ordem de aplicação manual no Supabase: `supabase/diagnostics/september_2026_schedule_preflight.sql` (somente leitura, mostra conflitos e a impressão digital das sessões de outros meses), depois a migration, depois `supabase/diagnostics/september_2026_schedule_postcheck.sql`, que confirma a agenda final, as contagens por experiência e por dia da semana, a ausência de duplicatas e que agosto e outubro continuam intactos.

### Arquivamento de sessões

Ao clicar em excluir uma sessão que já tem reservas, o painel arquiva a sessão (status `ARCHIVED`) em vez de bloquear a ação:

- a sessão some da agenda pública, do site (landing e link direto de reserva) e não aceita novas reservas — as mesmas regras que hoje só liberam sessões com status `OPEN` já cobrem isso automaticamente;
- reservas, pagamentos e relatórios continuam intactos e acessíveis normalmente em `/admin/reservas` e no dashboard;
- a lista de sessões continua com o recorte **Ativas** / **Arquivadas** / **Todas** (`/admin/sessoes?filtro=`), agora dentro do cartão de filtros;
- uma sessão arquivada pode ser restaurada, o que falha se a data já passou ou se colide com outra sessão ativa da mesma experiência no mesmo horário.

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

## Alterar turma

Uma reserva `CONFIRMED` pode trocar de dia, de horário **ou de experiência** sem cancelamento, sem nova cobrança e sem nova reserva. A ação existe **apenas** no painel: nenhuma rota pública, nenhuma tela de cliente e nenhuma RPC acessível por `anon` ou `authenticated` permite trocar de turma.

A ação aparece no cartão da reserva em `/admin/reservas` e no detalhe, como **Alterar turma**. O modal tem duas etapas:

1. **Escolher.** Mostra a turma atual (experiência, data, horário, participantes e valor pago) e as turmas de destino da agenda inteira, agrupadas por dia, cada uma nomeando sua experiência, com horário em destaque, vagas restantes, capacidade e status. Uma etiqueta *outra experiência* marca os destinos que atravessam a fronteira, e um filtro por experiência aparece quando há mais de uma. Um campo opcional de motivo fica no fim.
2. **Confirmar.** Repete de onde para onde a reserva vai, quantos participantes e as três garantias: a reserva continua confirmada, o pagamento não muda e o código é preservado. Quando a experiência muda, a tela diz isso com todas as letras e lembra que nenhuma mensagem automática é enviada ao cliente.

A lista de destinos é lida quando o modal abre, e não junto com a listagem: as vagas restantes mudam a cada confirmação, e o número que importa é o do instante da decisão. Turmas sem vagas para o grupo inteiro não são oferecidas — elas são contadas e a tela informa quantas ficaram de fora.

`admin_change_reservation_session` executa a mudança inteira em uma transação:

- trava a reserva e **as duas** sessões, sempre na ordem dos ids — o que impede deadlock quando duas trocas cruzam origem e destino;
- exige `CONFIRMED`, sessão de destino existente, aberta, futura e diferente da atual;
- aceita destino de qualquer experiência **publicada**; a própria experiência da reserva é sempre aceita, mesmo despublicada;
- expira as retenções vencidas do destino e recalcula a ocupação real antes de decidir;
- recusa a mudança inteira quando a reserva não cabe: não existe mover parte dos participantes;
- altera `session_id` e `experience_id`, juntos, e relê a linha para conferir que ficaram coerentes; status, `confirmed_at`, `public_code`, cliente, CPF, quantidade, `unit_price_cents` e `total_cents` permanecem como estavam;
- grava o histórico e a linha de auditoria dentro da mesma transação.

Qualquer recusa aborta tudo: nem o vínculo, nem o histórico, nem a auditoria sobrevivem parcialmente.

### Preço diferente entre as turmas e entre as experiências

O valor pago é preservado. `unit_price_cents` é coluna da própria reserva e `total_cents` é gerada a partir dela, então nenhuma diferença de preço — entre duas turmas da mesma experiência ou entre experiências de preços completamente diferentes — é recalculada, cobrada ou estornada. Os dois preços ficam registrados no histórico; o modal mostra a diferença antes de confirmar e o detalhe da reserva a mantém visível depois. Ajuste financeiro continua sendo processo operacional separado, decidido por uma pessoa.

### Histórico

`reservation_session_changes` guarda reserva, sessão anterior, sessão nova, **experiência anterior e experiência nova**, data e hora, administrador responsável, quantidade de participantes, valor preservado, os preços das duas turmas e o motivo opcional. O histórico aparece no detalhe da reserva, é interno e nunca é exposto em página pública. A trilha única `admin_audit_log` também recebe uma linha `RESERVATION_SESSION_CHANGED`, com as duas experiências e o sinal `experienceChanged`.

### O que a troca de experiência não faz

- **Não cobra e não estorna.** A diferença de preço é informação, nunca lançamento.
- **Não avisa o cliente sozinha.** Não existe e-mail automático de troca de turma; o único e-mail automático da plataforma é o de confirmação, uma vez por reserva. Avisar o cliente é uma decisão do admin, pelas ações de mensagem do painel — o que também garante que nenhum e-mail duplicado saia daqui.
- **Não move para dentro de um produto fora do ar.** Uma experiência `DRAFT` ou `ARCHIVED` não recebe reserva vinda de outra experiência: o banco recusa com `EXPERIENCE_NOT_AVAILABLE`.

### A invariante que substituiu a antiga restrição

A versão anterior recusava qualquer destino de outra experiência (`SESSION_EXPERIENCE_MISMATCH`), porque mover só o `session_id` deixaria `reservations.experience_id` apontando para o produto antigo — e `lookup_reservation`, `admin_get_reservation`, `admin_list_reservations` e o e-mail de confirmação resolvem a experiência por essa coluna.

A restrição não foi afrouxada: ela foi trocada por uma garantia mais forte. A trigger `reservations_experience_consistency` impõe que `reservations.experience_id` seja **sempre** a experiência de `reservations.session_id`, validando toda vez que esse par é escrito. A RPC escreve as duas colunas juntas e relê a linha para conferir; qualquer divergência levanta `RESERVATION_EXPERIENCE_DESYNC` e aborta a transação inteira.

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
