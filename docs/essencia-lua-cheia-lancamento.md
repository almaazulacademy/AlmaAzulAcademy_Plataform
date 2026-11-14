# ESSÊNCIA — Corpo, Mente e Natureza — preparação e lançamento

[Eventos especiais](special-events.md#essência--corpo-mente-e-natureza-2ª-edição) · [Abertura da 1ª edição](essencia-abertura.md)

## Estado em produção

A segunda edição `essencia-lua-cheia` foi cadastrada como `DRAFT`, com uma sessão `CLOSED` e `comingSoon: true`. O site público lê somente eventos publicados. A prévia em desenvolvimento e no Preview da Vercel lê o editorial do repositório.

O nome oficial é **ESSÊNCIA — Corpo, Mente e Natureza**, com subtítulo **Celebração da Lua Cheia** e chamada **Especial de Confraternização de Fim de Ano!**. O título e o editorial do rascunho precisam receber a correção antes do preflight de publicação.

A edição é definida em `lib/events/fixtures/essencia-lua-cheia.ts`. Para regenerar os modelos locais de cadastro, use `pnpm events:edition-sql essencia-lua-cheia --modelo-local`. Para os scripts de publicação e abertura, use `pnpm events:edition-launch-sql essencia-lua-cheia`. Para os quatro arquivos da correção, use `pnpm events:essencia-lua-cheia-editorial-sql`. Gere a prévia de e-mail com `pnpm email:preview:edicao essencia-lua-cheia`.

## Checklist do lançamento (cada etapa com autorização explícita)

### Etapa A — Revisão final

- [ ] Fotos, horários e textos confirmados na prévia do Preview: `/eventos/demonstracao/essencia-lua-cheia` (computador e celular).
- [ ] Prévia dos e-mails (`pnpm email:preview:edicao essencia-lua-cheia`): lanche da NutreDF presente, nenhum drink nem música, crianças, tolerância até 16h50, as duas atividades simultâneas na mesma linha, prazo 21/11 12h00.
- [ ] Se algo mudou: scripts regenerados, PR com CI verde, merge e deploy de Production **Ready**.
- [ ] `main` com CI verde; o arquivo de cadastro do repositório é o que será colado.

### Etapa B — Corrigir a identidade do rascunho existente

Após o merge e o deploy, use o SQL Editor de produção, um arquivo por consulta.

1. Execute `supabase/diagnostics/evento_essencia_lua_cheia_editorial_preflight.sql`. Exija `EVENTO_EDITORIAL_PREFLIGHT_OK` com zero falhas. Guarde os IDs, a sessão e as linhas `OUTROS_EVENTOS`, `LISTAGENS_REGULARES`, `RESERVAS_POR_STATUS` e `INSCRICOES_DA_LISTA_POR_STATUS`.
2. Com autorização específica e preflight válido, execute `supabase/maintenance/evento_essencia_lua_cheia_editorial_update.sql` uma vez. O aviso `EVENTO_EDITORIAL_ATUALIZADO` deve trazer os IDs já cadastrados.
3. Execute `supabase/diagnostics/evento_essencia_lua_cheia_editorial_postcheck.sql`. Exija `EVENTO_EDITORIAL_POSTCHECK_OK` com zero falhas e compare os IDs e indicadores com o preflight. Confira o 404 da página pública e a ausência de formulário de reserva para o ID da sessão.
4. Repita o preflight da Etapa C com o novo conteúdo. Interrompa em qualquer divergência.

O SQL usa a RPC auditada do painel, trava a experiência e a sessão e valida o título e o JSON de origem. O registro deve estar em rascunho, com a sessão fechada e sem reservas ou inscrições. O mesmo controle protege `supabase/rollback/evento_essencia_lua_cheia_editorial_update.rollback.sql`. Use a reversão somente com autorização específica e postcheck editorial aprovado, enquanto ainda for rascunho. Depois de reverter, execute novamente o preflight editorial para comprovar o retorno ao conteúdo original.

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
