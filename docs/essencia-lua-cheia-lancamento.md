# ESSÊNCIA — 2ª edição · Celebração da Lua Cheia — preparação e lançamento

[Eventos especiais](special-events.md#essência--2ª-edição--celebração-da-lua-cheia-pr-b) · [Abertura da 1ª edição](essencia-abertura.md)

## Estado: código pronto, edição oculta

A 2ª edição (`essencia-lua-cheia`) existe **só no código**: conteúdo em `lib/events/fixtures/essencia-lua-cheia.ts`, fotos em `public/images/eventos/essencia-lua-cheia/`, scripts de cadastro gerados e **não executados**. Nada no banco: nenhuma experiência, nenhuma sessão, nenhuma reserva.

**Por que ela não aparece no site de Production**, mesmo com `EVENTS_PUBLIC_ENABLED` e `EVENT_BOOKING_OPEN` ligadas:

| Caminho | Por quê fica oculta |
| --- | --- |
| `/eventos`, home, menu, sitemap, `/eventos/<slug>`, `/experiencias/<slug>` | Leem só o banco (`list_public_events`, `get_public_event`), que só devolve evento cadastrado, **publicado** e com o interruptor ligado. A edição não está no banco: 404 e nenhum card |
| Agenda, vitrine, bases | Leem só experiências regulares do banco |
| Prévia `/eventos/demonstracao/*` | Única rota que lê o registro de edições; só existe em desenvolvimento e no Preview da Vercel (`isEventsDemoEnabled`). Em Production, 404 |
| Reserva, pagamento, lista de espera, avisos e e-mails | Dependem de uma sessão no banco. Não há sessão |
| Código enviado ao navegador | Nenhum texto da edição: o registro só é importado pelas rotas de prévia (servidor) |

Resíduos conhecidos (não expõem o evento no site): as fotos em `/images/eventos/essencia-lua-cheia/` respondem para quem souber o endereço exato do arquivo, sem nenhum link para elas; e o repositório no GitHub é **público**, então conteúdo, fotos e scripts já são visíveis lá desde a abertura dos PRs #66 e #67.

`comingSoon: true` **não** esconde nada: só fecha a venda de uma edição publicada. Quem esconde é a edição não estar cadastrada (e, depois do cadastro, estar em rascunho).

## Ajustes antes do cadastro

Tudo da edição fica num lugar só:

| Para mudar | Onde |
| --- | --- |
| Textos, programação, horários, informações, parceiros, logos, fotos e legendas | `lib/events/fixtures/essencia-lua-cheia.ts` (`ESSENCIA_LUA_CHEIA_EDITORIAL`) |
| Data, duração, preço, vagas | `ESSENCIA_LUA_CHEIA_EDITION` no mesmo arquivo |
| Fotos | Arquivos em `public/images/eventos/essencia-lua-cheia/` (WebP, sem metadados; legenda "Registro da 1ª edição do ESSÊNCIA · 07/11/2026" nas fotos da 1ª edição) |
| Visual da página | Componentes genéricos (`components/events/`); a edição só escolhe `theme`, `spotlight` e `program.imageShape` |

Depois de qualquer ajuste, num PR:

```bash
pnpm events:edition-sql essencia-lua-cheia
```

```bash
pnpm email:preview:edicao essencia-lua-cheia
```

```bash
pnpm test
```

O teste `tests/special-events-essencia-lua-cheia.test.ts` falha se os scripts do repositório não forem os gerados do conteúdo atual — não dá para cadastrar um conteúdo e revisar outro. Regenerar é seguro **até o cadastro**; depois dele, mudar o conteúdo exige um script de atualização editorial próprio (como os `essencia_editorial_*` da 1ª edição), ainda não gerado para esta edição.

Validação automática da edição (`editionErrors`): chegada igual ao início da sessão, prazo de cancelamento antes do início, textos de chegada e cancelamento citando os mesmos horários, máximo por pedido ≤ capacidade, `comingSoon: true` para gerar o cadastro.

## Checklist do lançamento (cada etapa com autorização explícita)

### Etapa A — Revisão final

- [ ] Fotos, horários e textos confirmados na prévia do Preview: `/eventos/demonstracao/essencia-lua-cheia` (computador e celular).
- [ ] Prévia dos e-mails (`pnpm email:preview:edicao essencia-lua-cheia`): drink presente, nenhuma alimentação, chegada 15h15, prazo 22/11 12h00.
- [ ] Se algo mudou: scripts regenerados, PR com CI verde, merge e deploy de Production **Ready**.
- [ ] `main` com CI verde; o arquivo de cadastro do repositório é o que será colado.

### Etapa B — Cadastro (rascunho, sessão fechada, invisível)

No SQL Editor de produção, um script por vez:

- [ ] `supabase/diagnostics/evento_essencia_lua_cheia_cadastro_preflight.sql` → última linha `EVENTO_CADASTRO_PREFLIGHT_OK | OK`. Guardar `OUTROS_EVENTOS`, `LISTAGENS_REGULARES`, `RESERVAS_POR_STATUS`, `INSCRICOES_DA_LISTA_POR_STATUS`.
- [ ] `supabase/maintenance/evento_essencia_lua_cheia_cadastro.sql` (já tem `begin; set local lock_timeout = '5s'; … commit;`). Mensagem `EVENTO_CRIADO experienceId=… sessionId=…` — anotar os dois ids.
- [ ] `supabase/diagnostics/evento_essencia_lua_cheia_cadastro_postcheck.sql` → `EVENTO_CADASTRO_POSTCHECK_OK | OK`, `SESSAO_FECHADA = CLOSED 24/11/2026 15:00 240min 15000 centavos 24 vagas`, `EDICAO_FORA_DAS_LEITURAS_PUBLICAS = 0 na listagem, 0 na página, 0 sessão(ões) públicas`, e as quatro contagens iguais às do preflight.
- [ ] Site de Production: `/eventos` sem a 2ª edição e `/eventos/essencia-lua-cheia` em 404.
- [ ] Desfazer, se preciso (só em rascunho, sessão fechada, sem reserva): `supabase/rollback/evento_essencia_lua_cheia_cadastro.rollback.sql`.

O cadastro recusa sozinho: slug já usado, outra sessão de evento na mesma base às 15h de 24/11, migration de segurança `202610310004` ausente, conteúdo sem `comingSoon: true`, rascunho visível numa leitura pública.

### Etapa C — Publicação com reservas fechadas

- [ ] Publicar pela RPC do painel (`admin_update_event(ator, experienceId, título, resumo, 'PUBLISHED', imagem, ordem, conteúdo)`), com o mesmo conteúdo cadastrado; a sessão continua `CLOSED`. Antes, gerar um script com conferências, como o `essencia_publicacao.sql` da 1ª edição.
- [ ] Conferir em Production: `/eventos/essencia-lua-cheia` com **"Reservas abrem em breve"**, card em `/eventos` e destaque na home; `/reservar/<sessionId>` sem formulário.
- [ ] Voltar atrás: `admin_update_event(..., 'DRAFT', ...)` tira a página do ar.

### Etapa D — Abertura das vendas

`EVENT_BOOKING_OPEN` já está ligada em Production: a venda abre assim que as duas condições abaixo valerem.

- [ ] Tirar o "em breve" **desta** edição: atualização editorial com `event.reservation.comingSoon = false` (por script com conferências; nenhuma variável muda).
- [ ] Abrir a sessão pelo painel (Sessões → abrir) ou `admin_update_session(..., 'OPEN', ...)`.
- [ ] Compra real controlada de 1 ingresso: pagamento confirmado pela InfinitePay (webhook), e-mail com o drink e sem lanche, QR Code, planilha, painel, vagas de 24 para 23.
- [ ] Lista de espera continua desligada (`EVENTS_WAITLIST_ENABLED` ausente).
- [ ] Encerrar vendas: fechar a sessão no painel (a página diz "Reservas encerradas"). Não remover `EVENT_BOOKING_OPEN`.

## Pendências registradas

- Conferência de leitura (preflight) em produção não rodada em 13/11/2026: a sessão do Supabase no navegador tinha expirado. Ela é o primeiro passo da Etapa B.
- Scripts com conferências para a publicação (Etapa C), a abertura (Etapa D) e eventuais atualizações editoriais depois do cadastro: gerar quando as etapas forem autorizadas.
