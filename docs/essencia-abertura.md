# ESSÊNCIA — cadastro, abertura e operação

[Eventos especiais](special-events.md) · [Lista de espera](waitlist.md)

Roteiro para levar o ESSÊNCIA — Corpo, Mente e Natureza (07/11/2026) do repositório à venda, **um passo por vez e cada um com autorização**. **Estado em 31/10/2026: ESSÊNCIA cadastrado em produção, `EVENT/DRAFT`, `active = false`, sessão `CLOSED`, 24 vagas, sem reservas nem inscrições (postcheck do cadastro OK).** Vendas e publicação desligadas: interruptor desligado, variáveis dos eventos ausentes, nenhum agendamento da lista de espera ativo. Migrations `202610310002`, `202610310003` e `202610310004` (segurança) aplicadas em 31/10, com o teste real de permissões como `anon` aprovado.

## 1. Cadastro em estado fechado

**Incidente de 30/10/2026 — primeira tentativa falhou, sem gravar nada.** Em produção, `experiences` ainda tem sete colunas do schema legado (fora do repositório), obrigatórias e sem valor padrão: `eyebrow`, `short_description`, `location`, `cover_image`, `gallery`, `included`, `active`. `admin_create_experience` (chamada por `admin_create_event`) não as preenche, e o cadastro parou em `23502 null value in column "eyebrow"`. O `kind` aparecia como `REGULAR` porque a linha recusada era a do INSERT, antes de `admin_create_event` marcá-la como `EVENT`. Como tudo estava numa transação, nada ficou. O banco de teste é montado só pelas migrations do repositório, que não têm essas colunas — por isso os testes do roteiro passaram. A correção é a migration `202610310002_experiences_legacy_columns_on_insert.sql` (gatilho que preenche as colunas legadas só quando vêm nulas, a partir das colunas atuais da mesma linha, como a `202609150001_multi_base.sql` já fazia), com `supabase/diagnostics/experiences_legacy_columns_{preflight,postcheck}.sql` e rollback; o teste `tests/experiences-legacy-columns.test.ts` reproduz o esquema de produção (as sete colunas obrigatórias sem padrão), mostra a falha sem a migration e o cadastro completo com ela. O roteiro passou a conferir isso: o preflight do cadastro tem `COLUNAS_LEGADAS_COBERTAS`, e o cadastro recusa (`ESSENCIA_LEGADO`) se as colunas legadas existirem sem o gatilho.

A `202610310002` foi aplicada em produção em 31/10/2026, com postcheck OK.

**`active` nasce ligado (31/10/2026, antes do cadastro).** Em produção `active` é obrigatória com padrão `true`, e há a política de leitura `active = true OR is_admin()`. O gatilho só preenche coluna nula, então um rascunho nasceria com `active = true`, legível pela chave pública. A migration `202610310003_experiences_active_on_insert.sql` (corpo novo só dessa função) grava `false` quando a inserção não é publicada, com `supabase/diagnostics/experiences_active_on_insert_{preflight,postcheck}.sql` e rollback. O preflight do cadastro tem `RASCUNHO_NASCE_INATIVO`, o cadastro para com `ESSENCIA_ATIVO` e o postcheck tem `RASCUNHO_INATIVO`. O teste usa as sete colunas como o `information_schema` de produção as mostra: quatro textos sem padrão, `gallery` e `included` com padrão `'[]'`, `active` com padrão `true`.

**Ordem:** preflight da `202610310003` → migration → postcheck; só então o preflight do cadastro → cadastro → postcheck do cadastro.

**Auditoria de RLS e do campo `active` (feita em 31/10/2026).** Resultado e correção em [special-events.md](special-events.md#segurança-antes-da-abertura-migration-202610310004): sem a `202610310004`, ligar o interruptor e voltar a desligá-lo deixaria o evento legível pela chave pública. Aplicada em 31/10/2026.

Não há tela de cadastro de evento no painel: o caminho é a RPC do painel, `admin_create_event`, com as mesmas validações e a mesma auditoria (`EVENT_CREATED`), rodada no SQL Editor. Os quatro scripts são **gerados da fixture aprovada** (`lib/events/fixtures/essencia.ts`) por `pnpm events:essencia-sql` — nada é digitado à mão — e o teste `tests/special-events-essencia-cadastro.test.ts` falha se algum divergir dela.

| Script | O que faz |
| --- | --- |
| `supabase/diagnostics/essencia_cadastro_preflight.sql` | Só leitura. Exatamente um administrador ativo com o e-mail da equipe; base `concha-acustica` ativa; slug `essencia` livre; interruptor desligado; as duas migrations da 5C aplicadas; nenhum evento cadastrado. Guarda listagens regulares, reservas e inscrições. Última linha: `ESSENCIA_CADASTRO_PREFLIGHT_OK` |
| `supabase/maintenance/essencia_cadastro.sql` | Numa transação com `lock_timeout = '5s'`: confere ator, base, slug e interruptor; chama `admin_create_event`; confere que o evento nasceu em **rascunho**, a sessão **fechada** e o conteúdo passa na régua de publicação. Qualquer falha desfaz tudo |
| `supabase/diagnostics/essencia_cadastro_postcheck.sql` | Só leitura. Evento `EVENT/DRAFT` na base certa; título e resumo; conteúdo editorial **idêntico** ao aprovado; uma sessão `CLOSED 07/11/2026 05:30 210min 15000 centavos 24 vagas`; até 6 por pedido e cancelamento até `2026-11-05T12:00:00-03:00`; nada nas leituras públicas; nenhuma reserva nem inscrição; um `EVENT_CREATED`. Contagens iguais às do preflight. Última linha: `ESSENCIA_CADASTRO_POSTCHECK_OK` |
| `supabase/rollback/essencia_cadastro.rollback.sql` | Desfaz **só** enquanto o evento está em rascunho, com a sessão fechada e sem reserva nem inscrição; senão para sem mudar nada |

Dados cadastrados (todos da fixture): título "ESSÊNCIA — Corpo, Mente e Natureza"; slug `essencia`; base Cápsula Bar — Concha Acústica; sessão em `2026-11-07T08:30:00Z` (05h30 em Brasília), 210 minutos (até 09h00), R$ 150,00 por participante, 24 vagas; conteúdo com programação, parceiros, fotos do repositório, chegada com tolerância até 05h50, o que levar (tapete próprio para o Superioga e o aviso no resumo antes do pagamento), segurança, lanche, clima e cancelamento até 05/11/2026 às 12h00 (crédito ou reembolso), até 6 participantes por pedido.

Depois do cadastro o site não muda: o evento está em rascunho, o interruptor desligado e as variáveis ausentes. A API de reservas recusa a sessão (`EVENT_NOT_PUBLIC`) e a sessão continua fechada no banco.

**Pendente de conteúdo (não bloqueia o cadastro):** confirmação dos parceiros quanto ao uso dos logos; logo do Rapha Dantas, se houver (hoje aparece pelo nome).

## 2. Ordem recomendada até a venda

1. ~~Segurança: migration `202610310004`~~ — feita em 31/10/2026.
2. **Rotação do `CRON_SECRET`** (seção 3) — obrigatória antes da 5C-3; recomendável antes de abrir a venda, porque a conciliação de pagamentos é uma das rotinas que ele protege.
   ~~Cadastro fechado~~ — feito em 31/10/2026.
3. **Revisão do conteúdo**: a prévia `/eventos/demonstracao/essencia` no Preview mostra exatamente o mesmo conteúdo (é a mesma fixture); a página real só aparece depois do passo 5.
4. **Publicação no banco**: ligar o interruptor (`update public.special_event_settings set publication_enabled = true, updated_at = now();`) e publicar pela RPC do painel (`admin_update_event(..., 'PUBLISHED', ...)`). Com `EVENTS_PUBLIC_ENABLED` ausente o site continua igual.
5. **Página no ar, sem venda**: `EVENTS_PUBLIC_ENABLED=true` só em Production + redeploy. `/eventos/essencia` aparece com "Reservas abrem em breve" e botão desativado (regra abaixo); conferir no celular e no computador.
6. **Venda aberta**: abrir a sessão pelo painel de sessões (ou `admin_update_session`) e `EVENT_BOOKING_OPEN=true` só em Production + redeploy.
7. **Reserva controlada da equipe**, com autorização própria: um ingresso pago de verdade, conferindo e-mail do evento, QR, planilha e painel; depois cancelar pelo painel conforme a política.
8. **Lista de espera** (perto de esgotar): `EVENTS_WAITLIST_ENABLED=true`. Inscrição e confirmação funcionam sem a 5C-3; os avisos automáticos de vaga dependem dela.

Para tirar do ar a qualquer momento: desligar o interruptor (imediato: página, venda, inscrição e avisos saem), remover as variáveis + redeploy, ou voltar o evento a rascunho.

## Publicação sem vendas (roteiro; nada executado)

Scripts gerados por `pnpm events:essencia-publicacao-sql` e testados em `tests/special-events-essencia-publicacao.test.ts`. **Cada etapa exige autorização específica.**

1. **Pré-condições:** estado do ESSÊNCIA conferido no banco, logs das execuções automáticas sem 401 e escopo de Deployment Protection confirmado.
2. **Preflight:** `supabase/diagnostics/essencia_publicacao_preflight.sql`.
3. **Publicação:** `supabase/maintenance/essencia_publicacao.sql`. Liga o interruptor e publica numa transação; a sessão continua `CLOSED`. O site não muda, mas o conteúdo fica legível pela chave pública.
4. **Postcheck e conferência como `anon`:** `essencia_publicacao_postcheck.sql` e `essencia_publicacao_anon_check.sql`.
5. **Página no ar, em etapa separada:** `EVENTS_PUBLIC_ENABLED=true` só em Production + redeploy. `EVENT_BOOKING_OPEN` e `EVENTS_WAITLIST_ENABLED` continuam ausentes.
6. **Conferência de conteúdo e imagens** em celular e computador, antes de qualquer decisão de venda.

**Barreiras contra reserva:** sessão `CLOSED` no banco; `POST /api/reservations` recusa evento com `EVENT_BOOKING_OPEN` ausente; a chave pública não executa `create_pre_reservation`.

**Desfazer:** remover `EVENTS_PUBLIC_ENABLED` + redeploy, se estiver ligada; depois `supabase/rollback/essencia_publicacao.rollback.sql`, que volta a rascunho e desliga o interruptor. Recusa se houver sessão aberta, reserva ou inscrição.

**O que a página mostra.** O site distingue "ainda não abriu" de "encerrou" pela variável `EVENT_BOOKING_OPEN`, porque `sessions.status` não guarda o motivo do fechamento:

| `EVENT_BOOKING_OPEN` | Sessão | Selo e botão | Pode reservar? |
| --- | --- | --- | --- |
| Ausente | Fechada ou aberta com vagas | **Reservas abrem em breve** + "Estamos preparando os últimos detalhes desta experiência. Em breve, você poderá garantir sua vaga!" | Não |
| Ausente | Aberta sem vagas | Esgotado | Não |
| Ligada | Aberta com vagas | Vagas abertas, botão de reserva | Sim |
| Ligada | Fechada | **Reservas encerradas** | Não |
| Qualquer | Evento passado ou cancelado | Evento realizado ou Evento cancelado | Não |

**Para encerrar as vendas de verdade: fechar a sessão com a variável ligada.** Remover `EVENT_BOOKING_OPEN` depois que a venda já começou faz a página voltar a "Reservas abrem em breve". Se precisar parar a venda sem esse texto, feche a sessão e mantenha a variável; para tirar a página do ar, desligue o interruptor.

## 3. Rotação do `CRON_SECRET`

**Por quê:** o valor atual pode ter sido exposto numa captura de tela (27/10/2026). Ninguém deve exibir, copiar para chat, colar em arquivo ou registrar o valor antigo ou o novo.

**Quem usa hoje** (mapeado no código em 30/10):

| Consumidor | Como usa |
| --- | --- |
| Vercel Cron (`vercel.json`) | Envia `Authorization: Bearer <CRON_SECRET>` sozinho para `/api/cron/payment-reconciliation` (12:20 UTC) e `/api/cron/confirmation-emails` (12:00 UTC), lendo a variável do deploy em produção |
| `/api/cron/reschedule-emails` e `/api/cron/waitlist-notifications` | Mesma autenticação (`lib/cron/authorization.ts`); hoje ninguém as agenda — só chamada manual da equipe |
| Supabase Vault (`waitlist_cron_secret`) | **Previsto** pela 5C-3 (`waitlist_notify_schedule.sql`), **não criado** (conferir: `select count(*) from vault.secrets where name = 'waitlist_cron_secret';` → 0) |
| GitHub Actions | Não usa |

**Procedimento** (fora das janelas 12:00–12:30 UTC):

1. Gerar o valor novo no terminal, direto para a área de transferência, sem mostrar: `openssl rand -hex 32 | tr -d '\n' | pbcopy`.
2. Vercel → projeto → Settings → Environment Variables → `CRON_SECRET` (**só Production**, tipo Sensitive) → Edit → colar → Save. Não criar em Preview.
3. Limpar a área de transferência (`pbcopy < /dev/null`).
4. Redeploy de Production pelo painel da Vercel (a variável só vale no deploy novo; pede o 2FA).
5. Conferir sem revelar nada: `/api/cron/waitlist-notifications` sem cabeçalho responde **401** (segredo presente); no dia seguinte, os logs do Vercel Cron das 12:00 e 12:20 UTC com status 200.
6. Se algo falhar: gerar **outro** valor novo e repetir — nunca voltar ao antigo.

**Na 5C-3:** recomendo que o agendador do Supabase **não** use o `CRON_SECRET`, e sim um segredo próprio (`WAITLIST_NOTIFY_SECRET`), aceito só pela rota dos avisos. Assim girar um não exige mexer no outro, e o segredo que vai para o Vault só abre essa rota. Criar o segredo no Vault pelo SQL Editor deixa o valor no histórico de consultas: usar uma consulta descartável e apagá-la do histórico logo depois.

## 4. Fase 5C-3 — agendador dos avisos de vaga (plano)

Arquitetura (a já proposta em [waitlist.md](waitlist.md), com escopo dos eventos):

| Peça | Como |
| --- | --- |
| Detecção | `pg_cron` a cada minuto chama a varredura dentro do banco (sem HTTP). Interruptor `waitlist_settings.detection_enabled` |
| Envio | `pg_cron` a cada minuto chama a rota da Vercel por `pg_net` **só quando há aviso pendente**, com o segredo lido do Vault |
| Escopo | `WAITLIST_NOTIFY_SCOPE=EVENTS` na rota: reivindica só avisos de evento (`claim_pending_waitlist_spot_emails_by_kind` com `EVENT`, que já exige o interruptor e é pedido só com a venda e a lista dos eventos abertas). A detecção ganha uma versão por tipo (`waitlist_scan` só de sessões de evento) para a lista regular nunca ser tocada |
| Idempotência | A de sempre: varredura com advisory lock (`ALREADY_RUNNING`), uma abertura por sessão, um aviso por inscrição e abertura, reivindicação com `skip locked`, mensagem congelada e chave de idempotência por geração |
| Monitoramento | Diagnóstico só leitura: fila por status e tipo, tentativas e últimos erros, avisos parados há mais de 10 min, `cron.job_run_details` com falha, `net._http_response` não 2xx nas últimas 6 h |
| Desligar | Do mais rápido ao mais completo: `cron.alter_job(..., active := false)`; `detection_enabled = false`; remover `WAITLIST_NOTIFY_ENABLED` + redeploy; rollback da migration |

Divisão:

1. **5C-3a — código (PR)**: escopo do envio (`WAITLIST_NOTIFY_SCOPE`, padrão `EVENTS`), segredo próprio da rota dos avisos, diagnóstico de monitoramento, testes. Sem migration, sem agendamento.
2. **5C-3b — banco (PR + migration aditiva)**: varredura por tipo, com preflight, postcheck e rollback; scripts de agendamento atualizados para ela.
3. **5C-3c — infraestrutura (sem PR de código, cada passo com autorização)**: rotação do `CRON_SECRET` feita; `create extension pg_net`; segredo no Vault; agendar detecção e envio; `detection_enabled = true`; `WAITLIST_NOTIFY_ENABLED=true` + escopo em Production.

Riscos: `pg_net` é assíncrono (uma falha de rede só aparece no minuto seguinte; a fila não perde nem duplica); domínio fixo no job (trocar o domínio exige reagendar); segredo no Vault e no histórico do SQL Editor; limite de envio do Resend compartilhado com os e-mails de reserva (o ritmo de 1 envio/s já reserva metade); prazo curto até 07/11 — a lista funciona com aviso manual se a 5C-3 não estiver pronta (inscrição e confirmação já automáticas).
