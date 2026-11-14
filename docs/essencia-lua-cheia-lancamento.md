# ESSÊNCIA — Experiência Relax | Celebração da Lua Cheia — preparação e lançamento

[Eventos especiais](special-events.md#essência--experiência-relax--celebração-da-lua-cheia-2ª-edição) · [Abertura da 1ª edição](essencia-abertura.md)

## Estado: código pronto, edição oculta

A 2ª edição (`essencia-lua-cheia`, segunda 23/11/2026, 16h30 às 20h, R$ 160, versão definitiva do PR C) existe **só no código**: conteúdo em `lib/events/fixtures/essencia-lua-cheia.ts`, fotos em `public/images/eventos/essencia-lua-cheia/`, scripts de cadastro, publicação e abertura gerados e **não executados**. Nada no banco: nenhuma experiência, nenhuma sessão, nenhuma reserva.

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
- [ ] Prévia dos e-mails (`pnpm email:preview:edicao essencia-lua-cheia`): lanche da NutreDF presente, nenhum drink nem música, crianças, tolerância até 16h50, as duas atividades simultâneas na mesma linha, prazo 21/11 12h00.
- [ ] Se algo mudou: scripts regenerados, PR com CI verde, merge e deploy de Production **Ready**.
- [ ] `main` com CI verde; o arquivo de cadastro do repositório é o que será colado.

### Etapa B — Cadastro (rascunho, sessão fechada, invisível)

No SQL Editor de produção, um script por vez:

- [ ] `supabase/diagnostics/evento_essencia_lua_cheia_cadastro_preflight.sql` → última linha `EVENTO_CADASTRO_PREFLIGHT_OK | OK`. `TURMAS_REGULARES_SOBREPOSTAS` deve dizer "nenhuma…"; se vier **ATENÇÃO**, decidir no painel o que fazer com a turma listada antes de seguir (o script não mexe em nada). Guardar `OUTROS_EVENTOS`, `LISTAGENS_REGULARES`, `RESERVAS_POR_STATUS`, `INSCRICOES_DA_LISTA_POR_STATUS`.
- [ ] `supabase/maintenance/evento_essencia_lua_cheia_cadastro.sql` (já tem `begin; set local lock_timeout = '5s'; … commit;`). Mensagem `EVENTO_CRIADO experienceId=… sessionId=…` — anotar os dois ids.
- [ ] `supabase/diagnostics/evento_essencia_lua_cheia_cadastro_postcheck.sql` → `EVENTO_CADASTRO_POSTCHECK_OK | OK`, `SESSAO_FECHADA = CLOSED 23/11/2026 16:30 210min 16000 centavos 24 vagas`, `EDICAO_FORA_DAS_LEITURAS_PUBLICAS = 0 na listagem, 0 na página, 0 sessão(ões) públicas`, e as quatro contagens iguais às do preflight.
- [ ] Site de Production: `/eventos` sem a 2ª edição e `/eventos/essencia-lua-cheia` em 404.
- [ ] Desfazer, se preciso (só em rascunho, sessão fechada, sem reserva): `supabase/rollback/evento_essencia_lua_cheia_cadastro.rollback.sql`.

O cadastro recusa sozinho: slug já usado, outra sessão de evento na mesma base às 16h30 de 23/11, migration de segurança `202610310004` ausente, conteúdo sem `comingSoon: true`, rascunho visível numa leitura pública.

### Etapa C — Publicação com reservas fechadas (autorização própria)

Scripts gerados por `pnpm events:edition-launch-sql essencia-lua-cheia` (PR D). Publicam **só** `essencia-lua-cheia`, pela RPC do painel (`admin_update_event`, com auditoria). A sessão continua `CLOSED` e "Reservas abrem em breve" continua ativo. O interruptor de publicação já está ligado e **não** é tocado: desligá-lo esconderia a 1ª edição.

- [ ] `supabase/diagnostics/evento_essencia_lua_cheia_publicacao_preflight.sql` → `EVENTO_PUBLICACAO_PREFLIGHT_OK | OK`. Esperado: `EVENTO_EM_RASCUNHO`, `CONTEUDO_APROVADO_EM_BREVE = idêntico ao aprovado`, `SESSAO_FECHADA = CLOSED 23/11/2026 16:30 210min 16000 centavos 24 vagas`, `RESERVAS_E_INSCRICOES_DA_EDICAO = nenhuma reserva; 0 inscrição(ões) na lista; 24 vaga(s) livre(s)`. Guardar `OUTROS_EVENTOS`, `LISTAGENS_REGULARES`, `RESERVAS_POR_STATUS`, `INSCRICOES_DA_LISTA_POR_STATUS`.
- [ ] `supabase/maintenance/evento_essencia_lua_cheia_publicacao.sql` → aviso `EVENTO_PUBLICADO_COM_VENDAS_BLOQUEADAS`.
- [ ] `supabase/diagnostics/evento_essencia_lua_cheia_publicacao_postcheck.sql` → `EVENTO_PUBLICACAO_POSTCHECK_OK | OK`, `SEM_CAMINHO_DE_RESERVA = 0`, e as quatro impressões iguais às do preflight.
- [ ] `supabase/diagnostics/evento_essencia_lua_cheia_publicacao_anon_check.sql` → `evento_visivel = 1`, `sessao_aberta_visivel = 0`, `sessao_reservavel = 0`, `pode_pre_reservar = false`.
- [ ] Production: `/eventos/essencia-lua-cheia` com **"Reservas abrem em breve"**, card em `/eventos` e destaque na home; `/reservar/<sessionId>` sem formulário; a 1ª edição igual.

**Interromper** (não seguir e avisar) se: o preflight der qualquer `FALHOU`; `TURMAS_REGULARES_SOBREPOSTAS` vier ATENÇÃO sem decisão; o script recusar (`EVENTO_*`); o postcheck mostrar diferença em `OUTROS_EVENTOS` ou `LISTAGENS_REGULARES`; a página aparecer com botão de reserva.

**Desfazer**: `supabase/rollback/evento_essencia_lua_cheia_publicacao.rollback.sql` volta a rascunho (a página sai do ar). Recusa sem mudar nada se a sessão estiver aberta ou houver reserva/inscrição. Já em rascunho, não faz nada.

### Etapa D — Abertura das vendas (autorização própria, sensível)

`EVENT_BOOKING_OPEN` e `EVENTS_PUBLIC_ENABLED` já estão ligadas em Production e **não mudam**: assim que a abertura terminar, o checkout desta edição passa a funcionar. A abertura tira `comingSoon` **só desta edição** (o resto do conteúdo fica idêntico) e abre **só a sessão dela** pela RPC do painel (`admin_update_session`), mantendo início, duração, preço e vagas.

- [ ] `supabase/diagnostics/evento_essencia_lua_cheia_abertura_preflight.sql` → `EVENTO_ABERTURA_PREFLIGHT_OK | OK`. Esperado: `EVENTO_PUBLICADO`, `SESSAO_FECHADA_COM_OS_DADOS`, `VAGAS_LIVRES = 24 de 24`, `SESSAO_NO_FUTURO = 23/11/2026 16:30`, `PRAZO_DE_CANCELAMENTO` OK (antes de 21/11 12h; depois, ATENÇÃO: a política anunciada já não vale), nenhuma reserva.
- [ ] `supabase/maintenance/evento_essencia_lua_cheia_abertura.sql` → aviso `EVENTO_VENDAS_ABERTAS sessionId=…` (confere com o id do cadastro).
- [ ] `supabase/diagnostics/evento_essencia_lua_cheia_abertura_postcheck.sql` → `EVENTO_ABERTURA_POSTCHECK_OK | OK`, `SESSAO_ABERTA = OPEN 23/11/2026 16:30 210min 16000 centavos 24 vagas`, `VAGAS = 24 livre(s) de 24`, `RESERVAVEL = 1`, impressões iguais às do preflight.
- [ ] Compra real controlada de 1 ingresso: pagamento confirmado pela InfinitePay (webhook), e-mail com o lanche da NutreDF e sem drink, QR Code, planilha, painel, vagas de 24 para 23.
- [ ] Lista de espera continua desligada (`EVENTS_WAITLIST_ENABLED` ausente).

**Interromper** se: o preflight der `FALHOU`; o script recusar; o postcheck não mostrar 24 vagas e a sessão reservável; o checkout recusar a compra controlada; a 1ª edição ou outra impressão mudar.

**Desfazer**: `supabase/rollback/evento_essencia_lua_cheia_abertura.rollback.sql` fecha a sessão e devolve o "em breve" — **só enquanto não existe nenhuma reserva** (de qualquer situação) nem inscrição. Com reserva, recusa sem mudar nada: o procedimento é fechar a sessão pelo painel ("Reservas encerradas") e tratar reservas, pagamentos e reembolsos caso a caso. Nunca apaga dados. Encerrar vendas normalmente: fechar a sessão no painel; não remover `EVENT_BOOKING_OPEN`.

## Garantias dos scripts de lançamento

- Só a edição `essencia-lua-cheia` (por slug e `kind = 'EVENT'`); a impressão das outras edições e o catálogo regular são comparados dentro da própria transação.
- Cada script exige o estado anterior exato e trava as linhas (`for update`, `lock_timeout = 5s`): duplicado ou fora de ordem, recusa e nada muda.
- Tudo pelas RPCs do painel, com auditoria (`EVENT_UPDATED`, `SESSION_UPDATED`); nenhum `update` direto, `delete`, `truncate` ou `drop`.
- Nunca tocam o interruptor de publicação, variáveis da Vercel, reservas, pagamentos, lista de espera, turmas regulares nem a 1ª edição.
- Testados (`tests/special-events-edition-launch.test.ts`) num banco PGlite montado como produção: sequência completa, idempotência, ordem, recusas com reserva, mudança de preço, vagas ou conteúdo fora do roteiro.

## Pendências registradas

- Conferência de leitura (preflight) do cadastro em produção ainda não rodada: é o primeiro passo da Etapa B.
- Atualização editorial depois do cadastro (se o conteúdo mudar): exige script próprio, ainda não gerado para esta edição.
