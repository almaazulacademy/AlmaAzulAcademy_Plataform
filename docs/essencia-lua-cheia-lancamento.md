# ESSÊNCIA — Corpo, Mente e Natureza — preparação e lançamento

[Eventos especiais](special-events.md#essência--corpo-mente-e-natureza-2ª-edição) · [Abertura da 1ª edição](essencia-abertura.md)

## Estado em produção

A segunda edição `essencia-lua-cheia` está `PUBLISHED`, com uma sessão `CLOSED` e `comingSoon: true`. A página pública lê o título e o editorial do Supabase. A prévia de desenvolvimento e da Vercel lê o fixture do repositório. A nova foto precisa estar disponível no deploy antes da atualização editorial no banco.

O nome oficial é **ESSÊNCIA — Corpo, Mente e Natureza**, com subtítulo **Celebração da Lua Cheia** e chamada **Especial de Confraternização de Fim de Ano!**. Os ajustes de apresentação, programação, parceiros e foto precisam passar pelo roteiro abaixo antes do preflight de abertura.

A edição é definida em `lib/events/fixtures/essencia-lua-cheia.ts`. Para regenerar os modelos locais de cadastro, use `pnpm events:edition-sql essencia-lua-cheia --modelo-local`. Para os scripts de publicação e abertura, use `pnpm events:edition-launch-sql essencia-lua-cheia`. Para os quatro arquivos da correção, use `pnpm events:essencia-lua-cheia-editorial-sql`. Gere a prévia de e-mail com `pnpm email:preview:edicao essencia-lua-cheia`.

## Checklist do lançamento (cada etapa com autorização explícita)

### Etapa A — Revisão final

- [ ] Fotos, horários e textos confirmados na prévia do Preview: `/eventos/demonstracao/essencia-lua-cheia` (computador e celular).
- [ ] Prévia dos e-mails (`pnpm email:preview:edicao essencia-lua-cheia`): lanche da Nutre - DF presente, nenhum drink nem música, crianças, tolerância até 16h50, as duas atividades simultâneas na mesma linha, prazo 21/11 12h00.
- [ ] Se algo mudou: scripts regenerados, PR com CI verde, merge e deploy de Production **Ready**.
- [ ] `main` com CI verde; o arquivo de cadastro do repositório é o que será colado.

### Atualização editorial da página publicada

Depois do deploy com a nova foto, execute um arquivo por consulta no SQL Editor de produção.

1. Rode `supabase/diagnostics/evento_essencia_lua_cheia_editorial_publicado_preflight.sql`. Exija `EVENTO_EDITORIAL_PUBLICADO_PREFLIGHT_OK` com zero falhas. Registre os IDs, a sessão e os indicadores de outros eventos, catálogo, reservas e lista de espera. O conteúdo deve corresponder à versão publicada após o PR #70.
2. Com autorização específica, execute `supabase/maintenance/evento_essencia_lua_cheia_editorial_publicado_update.sql` uma vez. Compare os IDs do aviso `EVENTO_EDITORIAL_ATUALIZADO` com os do preflight.
3. Execute `supabase/diagnostics/evento_essencia_lua_cheia_editorial_publicado_postcheck.sql`. Exija `EVENTO_EDITORIAL_PUBLICADO_POSTCHECK_OK` com zero falhas e compare os indicadores. Confira os textos, a foto e “Reservas abrem em breve” na página pública. Confirme que o endereço de reserva da sessão não exibe formulário. Interrompa em qualquer divergência.
4. Rode o preflight de abertura quando a revisão terminar. A abertura exige autorização própria.

A atualização usa a RPC auditada do painel. A transação trava a experiência e a sessão, exige o título e o editorial exatos de origem, página pública, sessão fechada e zero reservas e inscrições. As conferências pós-escrita na mesma transação protegem a sessão, o catálogo e as outras edições.

Para reverter, use `supabase/rollback/evento_essencia_lua_cheia_editorial_publicado_update.rollback.sql` com autorização específica. A reversão exige a página publicada com a sessão fechada, o editorial revisado e zero reservas ou inscrições. Após o aviso `EVENTO_EDITORIAL_REVERTIDO`, execute novamente o preflight editorial publicado e confira a página e o bloqueio do checkout.

### Etapa D — Abertura das vendas (autorização própria, sensível)

`EVENT_BOOKING_OPEN` e `EVENTS_PUBLIC_ENABLED` já estão ligadas em Production e **não mudam**: assim que a abertura terminar, o checkout desta edição passa a funcionar. A abertura tira `comingSoon` **só desta edição** (o resto do conteúdo fica idêntico) e abre **só a sessão dela** pela RPC do painel (`admin_update_session`), mantendo início, duração, preço e vagas.

- [ ] `supabase/diagnostics/evento_essencia_lua_cheia_abertura_preflight.sql` → `EVENTO_ABERTURA_PREFLIGHT_OK | OK`. Esperado: `EVENTO_PUBLICADO`, `SESSAO_FECHADA_COM_OS_DADOS`, `VAGAS_LIVRES = 24 de 24`, `SESSAO_NO_FUTURO = 23/11/2026 16:30`, `PRAZO_DE_CANCELAMENTO` OK (antes de 21/11 12h; depois, ATENÇÃO: a política anunciada já não vale), nenhuma reserva.
- [ ] `supabase/maintenance/evento_essencia_lua_cheia_abertura.sql` → aviso `EVENTO_VENDAS_ABERTAS sessionId=…` (confere com o id do cadastro).
- [ ] `supabase/diagnostics/evento_essencia_lua_cheia_abertura_postcheck.sql` → `EVENTO_ABERTURA_POSTCHECK_OK | OK`, `SESSAO_ABERTA = OPEN 23/11/2026 16:30 210min 16000 centavos 24 vagas`, `VAGAS = 24 livre(s) de 24`, `RESERVAVEL = 1`, impressões iguais às do preflight.
- [ ] Compra real controlada de 1 ingresso: pagamento confirmado pela InfinitePay (webhook), e-mail com o lanche da Nutre - DF e sem drink, QR Code, planilha, painel, vagas de 24 para 23.
- [ ] Lista de espera continua desligada (`EVENTS_WAITLIST_ENABLED` ausente).

**Interromper** se: o preflight der `FALHOU`; o script recusar; o postcheck não mostrar 24 vagas e a sessão reservável; o checkout recusar a compra controlada; a 1ª edição ou outra impressão mudar.

**Desfazer**: `supabase/rollback/evento_essencia_lua_cheia_abertura.rollback.sql` fecha a sessão e devolve o "em breve" — **só enquanto não existe nenhuma reserva** (de qualquer situação) nem inscrição. Com reserva, recusa sem mudar nada: o procedimento é fechar a sessão pelo painel ("Reservas encerradas") e tratar reservas, pagamentos e reembolsos caso a caso. Nunca apaga dados. Encerrar vendas normalmente: fechar a sessão no painel; não remover `EVENT_BOOKING_OPEN`.

## Garantias dos scripts de lançamento

- Só a edição `essencia-lua-cheia` (por slug e `kind = 'EVENT'`); a impressão das outras edições e o catálogo regular são comparados dentro da própria transação.
- Cada script exige o estado anterior exato e trava as linhas (`for update`, `lock_timeout = 5s`): duplicado ou fora de ordem, recusa e nada muda.
- Tudo pelas RPCs do painel, com auditoria (`EVENT_UPDATED`, `SESSION_UPDATED`); nenhum `update` direto, `delete`, `truncate` ou `drop`.
- Nunca tocam o interruptor de publicação, variáveis da Vercel, reservas, pagamentos, lista de espera, turmas regulares nem a 1ª edição.
- Testados (`tests/special-events-edition-launch.test.ts`) num banco PGlite montado como produção: sequência completa, idempotência, ordem, recusas com reserva, mudança de preço, vagas ou conteúdo fora do roteiro.
