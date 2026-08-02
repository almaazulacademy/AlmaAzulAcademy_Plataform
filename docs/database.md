# Banco de dados

[README](../README.md) · [Arquitetura](architecture.md) · [Pagamentos](payments.md) · [Deploy](deployment.md)

## Fonte de verdade documentada

O schema vem de `202608010001_reservation_platform.sql` e `202608010002_admin_dashboard_mvp.sql`. Não foi executada nenhuma consulta ou migration remota para produzir este documento, e a aplicação desses arquivos no ambiente de produção não está confirmada.

Não existe tabela `profiles`. A autorização administrativa usa `admin_users`, ligada diretamente a `auth.users`.

## Compatibilidade com o schema legado

O projeto Supabase existente contém versões legadas de `experiences`, `sessions`, `reservations`, `reservation_status` e `session_status`. A tentativa da migration `202608010001_reservation_platform.sql` falhou porque `CREATE TYPE` ignorou o tipo já existente, mas o restante do arquivo passou a usar labels novos.

`202608020001_legacy_schema_compatibility.sql` prepara esse schema sem apagar tabelas, colunas, dados ou tipos. Os labels são renomeados no próprio enum: `pending` → `PRE_RESERVED`, `confirmed` → `CONFIRMED`, `expired` → `EXPIRED`, `cancelled` → `CANCELLED`; e `scheduled` → `OPEN`, `completed` → `CLOSED`, `cancelled` → `CANCELLED`. `completed` vira `CLOSED` porque representa uma sessão encerrada e não deve reabrir vendas.

Campos editoriais legados são preservados. `summary`, `image_url` e `status` recebem projeções de `short_description`, `cover_image` e `active`. `spots_available` também permanece, mas é somente um snapshot legado: a fonte canônica é `available_spots`, calculada por capacidade menos confirmadas e pré-reservas ainda válidas.

A migration é idempotente e também tolera uma instalação limpa. Se encontrar reservas legadas sem `cpf_hash`, interrompe a transação em vez de inventar dados pessoais. O inventário informado registra zero reservas; essa precondição deve ser reconfirmada imediatamente antes da aplicação.

Para o banco legado específico, a cópia operacional está em `supabase/bootstrap/legacy_schema_compatibility.sql`. Seu corpo SQL é idêntico ao da migration 003, precedido apenas por instruções operacionais. A ordem obrigatória é: backup; inventário; bootstrap manual; validação; migration 001; migration 002; migration 003/reaplicação idempotente; primeiro administrador; testes completos.

## Extensões e tipos

### Extensões

- `pgcrypto`, no schema `extensions`: hash do CPF.
- `pg_cron`: execução automática da expiração.

### Enums

`reservation_status`:

- `PRE_RESERVED`
- `CONFIRMED`
- `EXPIRED`
- `CANCELLED`

`session_status`:

- `OPEN`
- `CLOSED`
- `CANCELLED`

O status de `experiences` é `text` com check para `DRAFT`, `PUBLISHED` ou `ARCHIVED`.

## Relacionamentos

```text
experiences 1 ─── N sessions
experiences 1 ─── N reservations
sessions    1 ─── N reservations
reservations 1 ── N payment_events
```

Exclusões de experiências, sessões e reservas relacionadas usam `ON DELETE RESTRICT` nos vínculos definidos pela migration.

## Tabelas

### Tabelas administrativas da Sprint 4

- `admin_users`: autoriza o UUID do Supabase Auth, nome de exibição, papel `ADMIN`/`OPERATOR` e estado ativo.
- `admin_audit_log`: registra ator, ação, entidade, motivo e metadados das mutações.
- `platform_settings`: singleton com nome da empresa, WhatsApp, email e PIX, consultado como somente leitura pelo MVP.

A migration também adiciona `sessions.internal_notes`, `experiences.image_url` e `experiences.display_order` com limites e índices apropriados.

### `experiences`

Cadastro transacional de experiências.

| Campo | Tipo/restrição | Finalidade |
| --- | --- | --- |
| `id` | `uuid`, PK | Identificador |
| `slug` | `text`, único, obrigatório | Chave usada pela landing e RPC de listagem |
| `title` | `text`, obrigatório | Nome público |
| `summary` | `text`, obrigatório | Resumo usado no fluxo de reserva |
| `status` | `text`, default `PUBLISHED` | `DRAFT`, `PUBLISHED` ou `ARCHIVED` |
| `created_at`, `updated_at` | `timestamptz` | Auditoria básica |

A migration inclui um `upsert` da Imersão Paranoá. Isso cadastra a primeira experiência, sem limitar a tabela a ela.

### `sessions`

Agenda, preço e capacidade de cada edição.

| Campo | Tipo/restrição | Finalidade |
| --- | --- | --- |
| `id` | `uuid`, PK | Identificador da sessão |
| `experience_id` | `uuid`, FK | Experiência proprietária |
| `starts_at` | `timestamptz` | Data e hora de início |
| `duration_minutes` | inteiro positivo | Duração |
| `price_cents` | inteiro não negativo | Preço unitário em centavos |
| `capacity` | inteiro positivo | Limite total de pessoas |
| `status` | `session_status`, default `OPEN` | Disponibilidade operacional |
| `created_at`, `updated_at` | `timestamptz` | Auditoria básica |

A migration também adiciona essas colunas com `ADD COLUMN IF NOT EXISTS` para compatibilidade e associa sessões sem `experience_id` à Imersão Paranoá. A adequação de dados preexistentes ainda deve ser conferida antes da aplicação em produção.

### `reservations`

Dados pessoais, quantidade, ciclo de vida e referência de checkout.

| Campo | Tipo/restrição | Finalidade |
| --- | --- | --- |
| `id` | `uuid`, PK | Identificador interno e `order_nsu` do gateway |
| `public_code` | `text`, único | Código entregue ao participante |
| `idempotency_key` | `uuid`, único | Identifica uma tentativa lógica de criação |
| `experience_id`, `session_id` | FKs obrigatórias | Contexto reservado |
| `status` | `reservation_status` | Ciclo de vida |
| `full_name` | `text` | Nome do participante responsável |
| `cpf_hash` | `text` | SHA-256 do CPF normalizado |
| `cpf_last4` | `char(4)` | Referência limitada para operação futura |
| `phone`, `email` | `text` | Contato informado |
| `quantity` | inteiro de 1 a 20 | Pessoas bloqueadas/confirmadas |
| `unit_price_cents` | inteiro não negativo | Preço capturado no momento da reserva |
| `total_cents` | coluna gerada | `quantity * unit_price_cents` |
| `notes` | `text`, até 500 caracteres | Observações opcionais |
| `expires_at` | `timestamptz` | Fim da retenção de 2 horas |
| `payment_provider` | `text`, opcional | Provedor associado |
| `provider_reference` | `text`, opcional | Referência externa |
| `checkout_url` | `text`, opcional | URL hospedada de pagamento |
| `confirmed_at`, `cancelled_at` | `timestamptz`, opcionais | Marcos de estado |
| `created_at`, `updated_at` | `timestamptz` | Auditoria básica |

O CPF em texto simples é usado somente durante a requisição e a execução da RPC; a migration persiste hash e últimos quatro dígitos.

### `payment_events`

Trilha idempotente dos resultados de pagamento processados.

| Campo | Tipo/restrição | Finalidade |
| --- | --- | --- |
| `id` | `uuid`, PK | Identificador |
| `reservation_id` | FK obrigatória | Reserva relacionada |
| `provider` | `text` | Nome do gateway |
| `provider_event_id` | `text` | ID da transação/evento |
| `event_type` | `text` | `PAYMENT_CONFIRMED` ou `PAYMENT_AFTER_EXPIRATION` no código atual |
| `amount_cents` | inteiro não negativo | Valor retornado e validado |
| `payload` | `jsonb` | Payload e resultado de `payment_check` |
| `processed_at` | `timestamptz` | Momento do processamento |

`provider + provider_event_id` é único, evitando registrar duas vezes o mesmo evento.

## Capacidade e vagas restantes

A função `available_spots(session_id)` implementa:

```text
vagas restantes = capacidade
                 - soma(CONFIRMED)
                 - soma(PRE_RESERVED com expires_at > now())
```

O resultado nunca fica abaixo de zero por causa de `greatest(0, ...)`.

Pré-reservas vencidas deixam de contar na mesma consulta, mesmo antes da próxima execução do cron. Sessões só são listadas quando a experiência está `PUBLISHED`, a sessão está `OPEN`, `starts_at > now()` e existem vagas.

## Criação da pré-reserva e proteção contra overbooking

`create_pre_reservation`:

1. valida quantidade, nome e formato básico do CPF;
2. devolve a criação existente quando a mesma `idempotency_key` é repetida pelo mesmo CPF;
3. seleciona a sessão com `FOR UPDATE`;
4. rejeita sessão inexistente, fechada ou passada;
5. marca retenções vencidas daquela sessão como `EXPIRED`;
6. soma `CONFIRMED` e `PRE_RESERVED` ainda válidas;
7. rejeita a operação com `INSUFFICIENT_SPOTS` se ultrapassar a capacidade;
8. cria a reserva com `expires_at = now() + interval '2 hours'`.

O lock serializa transações concorrentes para a mesma sessão. O frontend mostra disponibilidade, mas a decisão final pertence à RPC.

## Expiração, confirmação e cancelamento

- `expire_pre_reservations` muda retenções vencidas para `EXPIRED` e retorna a quantidade afetada.
- `pg_cron` agenda essa função a cada minuto com o nome `expire-alma-azul-pre-reservations`.
- `cancel_pre_reservation` muda uma retenção ativa para `CANCELLED`.
- `confirm_reservation_payment` bloqueia a reserva, confere status, validade e valor total antes de `CONFIRMED`.
- Pagamento recebido após expiração gera `PAYMENT_AFTER_EXPIRATION`, mantém/libera a vaga e retorna `false`.

O agendamento está definido na migration, mas sua existência no Supabase de produção precisa ser verificada após a aplicação.

## Funções e RPCs

| Função | Finalidade | Acesso definido |
| --- | --- | --- |
| `set_updated_at()` | Trigger de atualização | Execução direta revogada |
| `expire_pre_reservations()` | Expira retenções | `service_role`; cron executa como proprietário/agendador |
| `available_spots(uuid)` | Calcula vagas | `anon`, `authenticated`, `service_role` |
| `list_open_sessions(text)` | Lista sessões futuras por slug | `anon`, `authenticated`, `service_role` |
| `get_booking_session(uuid)` | Obtém sessão reservável | `anon`, `authenticated`, `service_role` |
| `create_pre_reservation(...)` | Criação atômica | somente `service_role` |
| `attach_payment_checkout(...)` | Associa checkout válido | somente `service_role` |
| `cancel_pre_reservation(uuid)` | Cancela retenção | somente `service_role` |
| `lookup_reservation(text, text)` | Busca por CPF + código | somente `service_role` |
| `confirm_reservation_payment(...)` | Confirma pagamento validado | somente `service_role` |

Todas são `SECURITY DEFINER` quando acessam regras protegidas e definem `search_path` explicitamente.

## Triggers

`set_updated_at` é executado antes de updates em:

- `experiences`;
- `sessions`;
- `reservations`.

## RLS e privilégios

RLS é habilitado nas quatro tabelas.

Policies públicas existentes:

- `published experiences are readable`: leitura de experiências `PUBLISHED` para `anon` e `authenticated`.
- `open future sessions are readable`: leitura de sessões `OPEN` e futuras para `anon` e `authenticated`.

Não há policy pública de leitura para `reservations` ou `payment_events`; privilégios dessas tabelas são revogados de `anon` e `authenticated`. RPCs críticas também têm execução pública revogada e são concedidas à `service_role`.

## Índices

- `sessions_experience_starts_at_idx`: experiência + início, somente sessões abertas.
- `reservations_session_occupancy_idx`: sessão + status + expiração para ocupação.
- `reservations_lookup_idx`: código público + hash do CPF.
- `reservations_expiration_idx`: expiração, somente `PRE_RESERVED`.
- Uniques de `slug`, `public_code`, `idempotency_key` e `(provider, provider_event_id)` também criam suporte de índice.

## Migration existente

| Arquivo | Conteúdo |
| --- | --- |
| `202608010001_reservation_platform.sql` | Schema completo de reservas, funções, RLS, seed da primeira experiência e cron |
| `202608010002_admin_dashboard_mvp.sql` | Autorização administrativa, auditoria, configurações e RPCs operacionais |
| `202608020001_legacy_schema_compatibility.sql` | Bootstrap idempotente e não destrutivo para o schema legado |

## RPCs administrativas

As funções `admin_dashboard_metrics`, `admin_list_experiences`, `admin_list_sessions`, `admin_list_reservations` e `admin_get_reservation` fornecem leituras operacionais. As funções de criação/atualização de sessões e experiências, exclusão de sessão, confirmação manual e cancelamento protegem as mutações.

Todas exigem um ator ativo, usam `SECURITY DEFINER` com `search_path` explícito e têm execução revogada de `public`, `anon` e `authenticated`. Somente `service_role` recebe `EXECUTE`; o servidor deriva `p_actor_id` da sessão validada, nunca do payload do cliente.

Confirmação manual e alteração de capacidade bloqueiam os registros necessários e recalculam a ocupação. Trocar a experiência de uma sessão com histórico e excluir uma sessão com reservas são proibidos.

Antes de aplicar em um banco com tabelas anteriores, faça backup e revise colunas/dados existentes. Este repositório não contém uma migration anterior nem um dump de produção que permita comprovar compatibilidade de dados.
