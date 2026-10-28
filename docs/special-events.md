# Eventos especiais

[README](../README.md) · [Banco de dados](database.md) · [Stand-by](reservation-standby.md) · [Lista de espera](waitlist.md)

**Estado (28/10/2026): fase 2 em PR draft; migration `202610280001_special_events_foundation.sql` aplicada em produção**, com preflight e postcheck sem falhas nem pontos de atenção (assinatura das 166 funções existentes igual antes e depois, todas as experiências `REGULAR`, interruptor da publicação desligado). Nenhum evento está cadastrado nem publicado, e o site ainda não lê nada de eventos.

## O que é

Eventos especiais são experiências realizadas em datas específicas, muitas vezes em parceria com outras marcas, com programação, preço e capacidade próprios. O primeiro é o **ESSÊNCIA — Corpo, Mente e Natureza** (07/11/2026, 05h30 às 09h, Cápsula Bar / Base Concha Acústica, 12 vagas, R$ 150 por pessoa, ingresso único).

**Não existe um segundo sistema de reservas.** Um evento é uma linha de `experiences` com `kind = 'EVENT'` e uma sessão por edição. Vagas, pré-reserva, pagamento pela InfinitePay, confirmação, e-mail, planilha, check-in, Stand-by e lista de espera são os de sempre.

## Fases

| Fase | O que entrega | Estado |
| --- | --- | --- |
| 2. Banco e segurança | `experiences.kind`, interruptor de publicação, trava entre tipos, leitura pública e funções do painel | PR draft; migration aplicada em produção (28/10), interruptor desligado |
| 3. Separação no site | Home, vitrine, agenda e base passam a usar as listagens regulares; opções de troca de turma filtradas por tipo | — |
| 4. Páginas públicas | `/eventos`, `/eventos/[slug]`, destaque na home e item no menu | — |
| 5. Reserva e e-mail | Textos da página de reserva e e-mail de confirmação de evento | — |
| 6. Painel | `/admin/eventos` com formulário estruturado | — |
| 7. Relatórios | Painéis separados por tipo | — |
| 8. Lançamento do ESSÊNCIA | Cadastro, publicação e interruptor ligado | — |

## Fase 2 — banco e segurança

Migration `202610280001_special_events_foundation.sql`. É aditiva e idempotente: **não substitui o corpo de nenhuma função existente**, não toca linha de reserva, sessão, pagamento, Stand-by ou lista de espera, e não cria agendamento. O teste compara o corpo de todas as funções antes e depois.

### `experiences.kind`

`text not null default 'REGULAR'`, com check `REGULAR`/`EVENT`. O default preenche as linhas existentes sem `UPDATE`: nenhuma trigger dispara e `updated_at` não muda.

Regras (trigger `experiences_kind_guard`):

- **o tipo não muda depois que a experiência tem sessão** (`EXPERIENCE_KIND_LOCKED`), nos dois sentidos;
- **um evento só vira `PUBLISHED` com o interruptor ligado** (`EVENT_PUBLICATION_DISABLED`), por qualquer caminho: painel de eventos, painel atual de experiências ou SQL. Um evento já publicado continua editável se o interruptor for desligado depois.

### Interruptor da publicação

Tabela `special_event_settings` (uma linha, `publication_enabled = false`), com RLS ligada e nenhum acesso pela API, nem da service role. Existe porque as listagens atuais do site (`list_public_experiences`, `list_public_catalog`) não sabem de tipo: um evento publicado antes da fase 3 apareceria misturado na home, na vitrine e na agenda. Ligar é decisão da fase 8, no SQL Editor:

```sql
update public.special_event_settings set publication_enabled = true, updated_at = now();
```

### Nenhuma reserva troca de tipo

Trigger `reservations_event_kind_guard`, `before update of session_id` em `reservations`: uma reserva só troca de sessão para outra sessão do mesmo tipo. Recusa com `EVENT_KIND_MISMATCH` e desfaz a transação inteira — histórico de troca, resolução do Stand-by, e-mail de reagendamento e job da planilha nem chegam a ser gravados.

Cobre, sem reescrever nenhuma delas, todas as operações que mudam a turma de uma reserva:

| Caminho | Função |
| --- | --- |
| Troca de turma do painel | `admin_change_reservation_session` |
| Stand-by pelo painel | `admin_reschedule_standby_same_price` (e a antiga, fora do alcance da service role) |
| Autoatendimento do cliente | `customer_reschedule_reservation` |
| Desfazer Stand-by | `admin_undo_reservation_standby` (sempre o mesmo tipo: volta à turma original) |

Dentro do mesmo tipo nada muda: regular ↔ regular como antes, e evento ↔ outra sessão de evento (uma nova data da mesma edição, por exemplo) é permitido.

O painel e o autoatendimento traduzem a recusa (`lib/admin/mutation-errors.ts`, `lib/reservations/standby-self-service.ts`). **As listas de turmas de destino ainda mostram sessões do outro tipo** quando o preço coincide; escolher uma delas é recusado com a mensagem acima. O filtro dessas listas entra na fase 3, antes de qualquer evento publicado.

### Capacidade

A de sempre: `create_pre_reservation` trava a sessão (`FOR UPDATE`) e soma confirmadas e pré-reservas válidas antes de aceitar. Para o ESSÊNCIA, a sessão tem `capacity = 12` e `price_cents = 15000`: no máximo 12 participantes e R$ 1.800 de receita bruta. O teste de concorrência prova, com 16 conexões reais comprando ao mesmo tempo, que exatamente 12 entram.

### Leitura pública

Todas `security definer`, executáveis por `anon`. Nenhuma devolve capacidade, dado de reserva ou dado pessoal.

| Função | Devolve |
| --- | --- |
| `list_public_events()` | Eventos publicados, um por linha, com a base (nome, endereço, ponto de encontro, mapa) e a sessão em destaque: a próxima ativa; sem ela, a mais recente. Próximos primeiro |
| `get_public_event(slug)` | O mesmo, para um evento |
| `list_public_event_sessions(slug)` | Todas as sessões do evento, menos as arquivadas, com a situação |
| `list_public_regular_experiences()` | `list_public_experiences()` sem eventos (mesmas colunas e ordem) |
| `list_public_regular_catalog()` | `list_public_catalog()` sem eventos (mesmas colunas e ordem) |

**Situação** (`availability`): `AVAILABLE`, `SOLD_OUT`, `CLOSED` (reservas encerradas), `ENDED` (já realizado), `CANCELLED`, ou `NO_SESSION`. Vagas restantes só em `AVAILABLE`/`SOLD_OUT`. Só exibição: reservar continua passando por `get_booking_session` e `create_pre_reservation`.

As listagens antigas ficam intactas. O site troca para as novas na fase 3.

### Painel

Executáveis só pela service role, depois de `is_active_admin` (ADMIN ou OPERATOR ativo; instrutor é recusado). Reaproveitam `admin_create_experience`, `admin_update_experience` e `admin_create_session` — mesmas validações e auditoria.

| Função | Faz |
| --- | --- |
| `admin_create_event(ator, base, slug, título, resumo, editorial, imagem, início, duração, preço, capacidade)` | Cria o evento em **rascunho**, com a sessão **fechada** para reservas. Devolve `experienceId` e `sessionId` |
| `admin_update_event(ator, evento, título, resumo, status, imagem, ordem, editorial)` | Conteúdo e status (`DRAFT`, `PUBLISHED`, `ARCHIVED`). Publicar exige conteúdo completo e o interruptor ligado |
| `admin_duplicate_event(ator, origem, slug, título, início)` | Nova edição: copia conteúdo, base, preço, duração e capacidade; rascunho e sessão fechada; nenhuma reserva copiada |
| `admin_list_events(ator)` | Eventos de qualquer status, com a sessão em destaque e seus números |
| `admin_event_report(ator, evento)` | Por sessão: capacidade, vagas, confirmadas, pré-reservas válidas, Stand-by, canceladas, presentes, receita confirmada e pendente. Sem dado pessoal |

Data, preço, capacidade e abrir/fechar reservas continuam na sessão, pelas RPCs de sessão de sempre (`admin_update_session`). Participantes, pagamentos e check-in usam as telas atuais de reservas e presença.

Auditoria: `EVENT_CREATED`, `EVENT_UPDATED`, `EVENT_DUPLICATED`, além dos registros das RPCs reaproveitadas.

### Compatibilidade

- **InfinitePay, confirmação, reconciliação e e-mail**: sem mudança. O checkout usa o título do evento como descrição.
- **Google Sheets**: sem mudança. Uma reserva de evento entra na planilha como qualquer outra, com o título do evento na coluna Experiência.
- **Lista de espera**: sem mudança. Uma sessão de evento esgotada aceita inscrição como qualquer turma (testado).
- **Stand-by**: sem mudança, a não ser a trava entre tipos.
- **Check-in e área do instrutor**: sem mudança; a sessão do evento aparece no dia, como qualquer turma.

## Aplicação segura (quando autorizada)

No SQL Editor do Supabase, uma consulta por vez:

1. `supabase/diagnostics/special_events_foundation_preflight.sql` — somente leitura. A última linha, `EVENTOS_PREFLIGHT_OK`, precisa estar `OK`. Guarde `ASSINATURA_DAS_FUNCOES_EXISTENTES` e as contagens.
2. A migration, envolta à mão em `begin;` + `set local lock_timeout = '5s';` … `commit;`.
3. `supabase/diagnostics/special_events_foundation_postcheck.sql` — `EVENTOS_POSTCHECK_OK` precisa estar `OK`, com `FUNCOES_NOVAS_COM_A_DEFINICAO_DO_REPOSITORIO` = `13 de 13`, `INTERRUPTOR_DA_PUBLICACAO` = `desligado`, `LISTAGENS_REGULARES_SEM_PERDA` = `OK`, e assinatura e contagens iguais às do preflight.

Ordem de deploy: a migration pode ser aplicada antes ou depois de mergear este PR. O código desta fase só traduz mensagens de erro novas; sem a migration, elas nunca aparecem. Aplicar a migration não muda nada no site: ele continua lendo as listagens antigas e não há evento cadastrado.

## Rollback

`supabase/rollback/202610280001_special_events_foundation.rollback.sql` — fora de `supabase/migrations/`, para revisão. Remove as duas triggers, as treze funções, a tabela do interruptor e a coluna `kind`. **Recusa, sem alterar nada, se existir qualquer experiência `EVENT`**: sem a coluna, o evento viraria uma experiência comum em silêncio. Não toca reserva, sessão, pagamento, Stand-by, lista de espera nem função existente. Reaplicar a migration devolve tudo, com o interruptor desligado.

## Testes

- `tests/special-events-foundation.test.ts` (PGlite, todas as migrations): tipo e travas, criação e permissões, publicação bloqueada por todos os caminhos, listagens regulares iguais às atuais, situações públicas, capacidade de 12 com R$ 1.800, troca de turma e Stand-by (painel e cliente) bloqueados entre tipos e liberados dentro do mesmo tipo, lista de espera, duplicação, relatório sem dado pessoal, migration aditiva e idempotente, preflight, postcheck e rollback.
- `tests/special-events-concurrency.test.ts` (Postgres real, só no CI): 16 compras simultâneas de 1 vaga → exatamente 12; grupos de tamanhos diferentes nunca passam de 12; compra em curso faz a seguinte esperar e decidir com a ocupação atualizada.
