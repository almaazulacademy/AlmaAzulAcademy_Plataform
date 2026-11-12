# Cupons de desconto

[README](../README.md) · [Pagamentos](payments.md) · [Banco](database.md) · [Stand-by](reservation-standby.md) · [Eventos especiais](special-events.md)

**Estado (12/11/2026): fase 2 (banco e regras) na `main` (PR #63); fase 3 (painel) em PR draft.** Migration `202611020001_discount_coupons.sql` **não aplicada por este trabalho** — confirmar no Supabase antes de ligar o painel. `COUPONS_ADMIN_ENABLED` e `COUPONS_CHECKOUT_ENABLED` ausentes (desligadas). O checkout público não chama nenhuma função de cupom.

| Fase | Conteúdo | Estado |
| --- | --- | --- |
| 1 | Diagnóstico e arquitetura | Aprovada em 02/11/2026 |
| 2 | Banco, regras, concorrência, auditoria, diagnósticos e rollback | Na `main` desde 12/11/2026 (PR #63); migration não aplicada por este trabalho |
| 3 | Painel: Marketing → Cupons de desconto | PR draft; `COUPONS_ADMIN_ENABLED` desligada |
| 4 e 5 | Checkout (campo, prévia, aplicação, remoção) e `POST /api/reservations` com cupom → InfinitePay | Pendente |
| 5b | Relatórios (detalhe da reserva, lista, métricas) | Pendente |
| 6 | Homologação e ativação | Pendente |

## Regras da primeira versão (decisões de 02/11/2026)

- Desconto só percentual, **de 1% a 99%**. Cortesia (100%) segue pela confirmação manual que já existe.
- Um cupom por reserva; nenhum cupom criado nem aplicado automaticamente.
- Arredondamento **por participante**, meio centavo para cima: `unitário final = unitário − floor((unitário × % + 50) / 100)`. O total é sempre `quantidade × unitário final` — o mesmo valor mostrado, cobrado e comparado na confirmação.
- **1 uso = 1 reserva**, qualquer que seja o número de participantes.
- Validade pela **data da compra no horário de Brasília**, com início e término inclusivos e opcionais.
- Código com 3 a 32 caracteres (A–Z, 0–9 e hífen), guardado em maiúsculas; o cliente pode digitar em minúsculas. Duplicado é recusado sem diferença de caixa.
- Aplicabilidade: todas as experiências regulares, ou experiências selecionadas. **Evento especial só aceita cupom quando é selecionado.**
- O uso fica **reservado** enquanto a pré-reserva vale (inclusive na janela de segurança do pagamento) e **contado para sempre** depois de pago, mesmo se a reserva for cancelada. Só o ADMIN libera, com justificativa, o uso de uma reserva paga e depois cancelada.
- **ADMIN** cria, edita, ativa, desativa e libera; **OPERATOR** só consulta.
- Depois do primeiro uso (qualquer um, mesmo expirado), código, percentual e aplicabilidade ficam travados. O limite nunca é reduzido abaixo dos usos que já contam; manter ou subir um limite que um pagamento tardio já ultrapassou é permitido, para o cupom continuar editável.
- Campo no checkout: sempre nas experiências regulares; em evento especial, só quando algum cupom ativo e não vencido o seleciona.

## Onde o desconto mora

`reservations.total_cents` é `quantity × unit_price_cents` por invariante do banco (coluna gerada no repositório; CHECK + gatilho `set_reservation_total_cents` no schema legado de produção). Todo o resto lê `total_cents` como "valor pago": confirmação, reconciliação, painel, receita, Stand-by e a coluna "Valor total pago" da planilha.

Por isso a reserva com cupom nasce com `unit_price_cents` **já descontado**, e o preço de lista, o percentual e os valores ficam congelados em `coupon_redemptions`. Consequências:

- Nenhum caminho de pagamento muda. `POST /api/reservations` já envia à InfinitePay `quantidade × total/quantidade`, que passa a ser o unitário com desconto, sem sobra de centavo.
- Receita do painel, ticket médio e planilha passam a contar o valor líquido, sem mudança nelas.
- Reserva sem cupom não passa por nada novo: continua em `create_pre_reservation`, que a migration não toca.

## Banco

| Objeto | Papel |
| --- | --- |
| `coupons` | Código, percentual, validade (`date`), limite, aplicabilidade, status, descrição, autoria |
| `coupon_experiences` | Experiências de um cupom `SELECTED` |
| `coupon_redemptions` | Um uso por reserva, com código, percentual, quantidade, preço de lista, unitário final, total original, desconto e total cobrado; liberação manual |
| `coupon_settings` | `min_charge_cents`: mínimo de cobrança. **Nulo = nenhum cupom é aplicado** |

As quatro tabelas têm RLS ligada, nenhuma política e nenhum privilégio para `anon`, `authenticated` ou `service_role`: tudo passa pelas RPCs. O gatilho `coupon_redemptions_history_guard` impede alterar os valores de um uso ou apagá-lo; só a liberação pode ser gravada, uma vez.

### RPCs do servidor (só `service_role`)

| Função | Uso |
| --- | --- |
| `preview_coupon(session, quantidade, código)` | Prévia do checkout. Só leitura; devolve os valores ou `{ ok: false, reason }` |
| `coupon_field_visible(session)` | O checkout mostra o campo? |
| `create_pre_reservation_with_coupon(…, código)` | Pré-reserva com cupom (ver abaixo) |
| `admin_list_coupons(ator)` / `admin_get_coupon(ator, cupom)` | Consulta: ADMIN e OPERATOR |
| `admin_create_coupon`, `admin_update_coupon`, `admin_set_coupon_status` | Gestão: só ADMIN, com registro em `admin_audit_log` |
| `admin_release_coupon_redemption(ator, uso, motivo)` | Liberação manual: só ADMIN, só de reserva paga e cancelada |

### Pré-reserva com cupom

Uma transação só:

1. Repetição da mesma chave de idempotência → a reserva como foi gravada, com o cupom que ela tiver (ou nenhum). Nunca aplica desconto de novo.
2. `coupon_settings.min_charge_cents` nulo → `COUPON_UNAVAILABLE`.
3. Trava a linha do cupom (`FOR UPDATE`) e confere de novo a chave.
4. Status, validade, aplicabilidade e limite → recusa com o símbolo.
5. `create_pre_reservation` de sempre (trava a sessão, confere vagas).
6. Valor com desconto abaixo do mínimo → recusa.
7. Grava o unitário com desconto e o uso.

Qualquer recusa desfaz a pré-reserva inteira: nenhuma vaga nem uso fica preso, e a chave continua livre para o cliente seguir sem cupom. Ordem de travas: cupom → sessão; nenhum caminho trava sessão e depois cupom.

Recusas: `COUPON_NOT_FOUND`, `COUPON_INACTIVE`, `COUPON_EXPIRED`, `COUPON_NOT_STARTED`, `COUPON_NOT_ELIGIBLE`, `COUPON_EXHAUSTED`, `COUPON_BELOW_MIN_CHARGE`, `COUPON_UNAVAILABLE`. Mensagens em `lib/coupons/rules.ts`.

### Estados de um uso

Deduzidos da reserva, sem gatilho nos caminhos de pagamento:

| Estado | Quando | Conta no limite |
| --- | --- | --- |
| `RESERVED` | Pré-reserva ainda válida (inclui a janela de segurança) | Sim |
| `CONFIRMED` | `confirmed_at` preenchido (confirmada ou em Stand-by) | Sim |
| `CANCELLED_AFTER_PAYMENT` | Paga e depois cancelada | Sim, até a liberação |
| `RELEASED` | Liberada pelo ADMIN | Não |
| `LAPSED` | Expirou ou foi cancelada sem pagamento | Não |

Webhook repetido não muda nada. Pagamento tardio reconciliado volta a contar porque ganha `confirmed_at`.

### Pagamento tardio acima do limite

Uma pré-reserva que expira (e esgota a janela de segurança) libera o uso; se outro cliente o ocupar e o primeiro pagamento for reconciliado depois, os usos pagos passam do limite. **O pagamento não é recusado** — o dinheiro já entrou pelo valor com desconto, e recusar significaria estorno ou vaga sem dono. O caso nunca é silencioso:

- o cupom traz `overLimit = true` e `excessCount` (usos pagos além do limite) em `admin_list_coupons` / `admin_get_coupon`;
- cada uso pago além do limite, na ordem de confirmação, sai com `overLimit = true` no detalhe;
- novos usos continuam recusados pelo motivo de sempre (`COUPON_EXHAUSTED`, ou inativo, expirado, ainda não válido);
- `supabase/diagnostics/discount_coupons_report.sql` mostra `limite_excedido` e `excedentes`.

### Situação operacional e alerta de excesso

São dois dados separados, para nenhum excesso ficar escondido atrás da situação do cupom (correção da revisão de 02/11/2026):

| Campo | O que diz | Valores |
| --- | --- | --- |
| `state` | Situação operacional | `INACTIVE`, `EXPIRED`, `SCHEDULED`, `EXHAUSTED` (sem uso livre), `ACTIVE` — nessa precedência |
| `overLimit` | Há uso pago além do limite? | `true` / `false`, com qualquer `state` |
| `excessCount` | Quantos | Usos confirmados ou pagos e depois cancelados, menos `maxUses`; 0 sem limite |

`excessCount` é sempre o número de usos com `overLimit` no detalhe e a coluna `excedentes` do relatório. Uso só reservado (não pago) ocupa o limite mas não é excesso; uso liberado ou expirado sem pagamento não conta. O painel pode mostrar "EXPIRED — Limite excedido: 2 utilizações" com `couponOverLimitLabel` (`lib/coupons/rules.ts`), sem interpretar `state`. O alerta não muda a elegibilidade: quem decide novos usos continua sendo `coupon_rejection`.

### Stand-by

A régua de preço do Stand-by (modo `CUSTOMER`, usada pelo cliente e pelo painel) comparava o preço da turma com `unit_price_cents`. Numa reserva com cupom esse é o valor com desconto, e nenhuma turma de mesmo preço de lista seria aceita. `reservation_standby_target_rejection` passa a comparar com o preço de lista guardado em `coupon_redemptions` — e, sem cupom, exatamente como antes. O reagendamento não escreve em `unit_price_cents`: o desconto fica, nada é cobrado de novo, e o uso continua o mesmo.

Depois desta migration, os postchecks antigos do Stand-by (`reservation_standby_postcheck`, `reservation_standby_admin_panel_postcheck`, `reservation_standby_self_service_postcheck`) passam a apontar `reservation_standby_target_rejection` como diferente — esperado, e só ela. Os testes dessas etapas conferem o banco anterior aos cupons; o rollback desta migration devolve o corpo antigo e eles voltam a aprovar.

Pendência para a fase 5b: o diálogo de Stand-by do painel mostra `unitPriceCents` ("R$ X por participante"), que numa reserva com cupom é o valor com desconto.

## Painel (fase 3): Marketing → Cupons de desconto

Só existe com `COUPONS_ADMIN_ENABLED=true` (variável de servidor, valor exato `true`). Desligada: o grupo "Marketing" some do menu, as páginas respondem 404 e as rotas respondem 404 antes de olhar a sessão. A fase 3 **não traz migration**: usa só as RPCs da fase 2, que conferem o papel de novo em cada chamada.

| Tela | O que faz |
| --- | --- |
| `/admin/marketing/cupons` | Tabela com código, desconto, utilizações, limite, validade, situação e o alerta "Limite excedido" (ao lado de qualquer situação). Filtro por situação — inclusive "Com limite excedido" — e busca por código |
| `/admin/marketing/cupons/novo` | Código (maiúsculas automáticas), 1–99%, início e término opcionais, ilimitado ou quantidade máxima, todas as regulares ou experiências específicas (eventos especiais só quando marcados), status inicial e descrição interna. Só ADMIN |
| `/admin/marketing/cupons/[id]` | Dados, utilizações por estado, receita confirmada, descontos concedidos, valor aguardando pagamento (à parte, nunca como receita), histórico de utilizações e liberação manual com justificativa |
| `/admin/marketing/cupons/[id]/editar` | Edição. Depois do 1º uso, código, percentual e experiências aparecem bloqueados com a explicação; datas, limite e descrição seguem editáveis. Só ADMIN |

**Rotas** (todas `no-store`; ordem: origem → variável → sessão → papel ADMIN → id → corpo; o ator vem sempre da sessão):

| Rota | RPC |
| --- | --- |
| `POST /api/admin/coupons` | `admin_create_coupon` |
| `PATCH /api/admin/coupons/[couponId]` | `admin_get_coupon` (versão) → `admin_update_coupon` |
| `POST /api/admin/coupons/[couponId]/status` | `admin_set_coupon_status` (motivo opcional, vai para a auditoria) |
| `POST /api/admin/coupons/redemptions/[redemptionId]/release` | `admin_release_coupon_redemption` (justificativa de 3 a 500 caracteres e `confirmed: true`) |

As leituras (lista, detalhe, experiências) são feitas pelas páginas, no servidor, com `admin_list_coupons`, `admin_get_coupon` e `admin_list_experiences` (+ `experiences.kind`).

**Permissões.** ADMIN cria, edita, ativa, desativa e libera; OPERATOR consulta lista, detalhe e utilizações. O OPERATOR não vê os botões, é mandado de volta pelas páginas de criação e edição, recebe 403 nas rotas antes de qualquer RPC e, se a rota fosse contornada, o banco recusa (`COUPON_ADMIN_FORBIDDEN`). Instrutor não entra no painel.

**Edição concorrente.** O formulário envia a versão que abriu (`expectedUpdatedAt`). Se o cupom mudou nesse meio-tempo (edição ou ativação por outra pessoa), a rota responde 409 e nada é sobrescrito. Resta uma janela de milissegundos entre a conferência e a gravação (a RPC da fase 2 não recebe a versão); nela vale a última gravação, e as duas ficam na auditoria com antes e depois. Limite, campos bloqueados e código duplicado são decididos pelo banco com o cupom travado, então nenhuma corrida fura essas regras.

**Valores do detalhe.** Mesma definição de `discount_coupons_report.sql`: receita e desconto só de usos `CONFIRMED`. Pré-reserva aguardando pagamento aparece em "Aguardando pagamento", fora da receita; uso pago e cancelado, liberado ou expirado não soma.

## Valor mínimo da InfinitePay

O mínimo aceito pela InfinitePay **não está confirmado** e o código não presume nenhum. Enquanto `coupon_settings.min_charge_cents` for nulo, nenhum cupom é aplicado. Antes da ativação pública:

1. Confirmar o mínimo com a InfinitePay (documentação ou suporte) para links de checkout, e se ele vale por pedido ou por item.
2. Gravar o valor confirmado: `update public.coupon_settings set min_charge_cents = <centavos>, updated_at = now() where singleton;`
3. Se o mínimo for por item, revisar `coupon_price_rejection` antes de ligar o checkout.

## Aplicação em produção (não antes de 08/11/2026)

1. `supabase/diagnostics/discount_coupons_preflight.sql` → `CUPONS_PREFLIGHT_OK` precisa estar OK. Guardar `ASSINATURA_DAS_OUTRAS_FUNCOES` e `RESERVAS_POR_STATUS`.
2. `202611020001_discount_coupons.sql` envolta em `begin;` + `set local lock_timeout = '5s';` … `commit;`.
3. `supabase/diagnostics/discount_coupons_postcheck.sql` → `CUPONS_POSTCHECK_OK` OK, mesma assinatura do preflight.
4. Nada muda no site: as variáveis continuam desligadas e o mínimo continua nulo.

**Rollback.** O operacional é desligar as variáveis ou desativar o cupom. O do banco é `supabase/rollback/202611020001_discount_coupons.rollback.sql`: remove tudo o que a migration criou e devolve a régua do Stand-by byte a byte. **Recusa, sem alterar nada, se existir qualquer uso registrado, confirmado ou não** — apagar `coupon_redemptions` apagaria o preço de lista e o desconto dessas reservas. Cupons nunca usados são removidos junto.

### Rollback seguro com compras em curso

Correção da revisão de 02/11/2026. Contar os usos sem trava não bastava: o uso gravado por uma compra ainda aberta é invisível, e os `DROP` apagariam esse histórico assim que ela confirmasse. Agora a verificação e a remoção acontecem na mesma transação, depois de travar em `ACCESS EXCLUSIVE`, numa única instrução:

`reservations → experiences → coupon_settings → coupons → coupon_experiences → coupon_redemptions`

- **Por que `reservations` e `experiences`.** Apagar uma tabela com chave estrangeira trava a tabela referenciada em `ACCESS EXCLUSIVE` (medido no Postgres 17). Se o rollback as travasse só na hora do `DROP`, já segurando as de cupom, fecharia ciclo com uma compra, que lê `reservations` primeiro e os cupons depois — a ordem da lista. Por isso as chaves de autoria para `auth.users` foram retiradas das tabelas de cupom (o ator já é conferido e fica em `admin_audit_log`): o rollback não precisa travar a tabela de login.
- **Tudo ou nada, sem esperar segurando trava.** `LOCK … NOWAIT` numa subtransação, repetido a cada 50 ms por até 10 s. Uma tentativa que falha devolve o que tinha pegado; o rollback nunca espera segurando trava e não entra em ciclo de deadlock com ninguém. Esgotado o prazo: `ROLLBACK_SEM_TRAVA`, nada alterado — rodar de novo.
- **Transações já iniciadas.** `ACCESS EXCLUSIVE` só é concedido quando todas as transações que tocaram essas tabelas terminaram. A contagem vem depois, com leitura nova: vê o uso que uma compra confirmou, ou não vê o que ela desfez.
- **Compra que chega depois.** Espera as travas; quando o rollback confirma, tabelas e funções já não existem e ela falha inteira, sem pré-reserva nem uso. Reserva sem cupom segue normalmente.
- **Efeito no site.** Durante o rollback (milissegundos), leituras e escritas em `reservations` e `experiences` esperam. Rodar fora do horário de vendas.

`supabase/diagnostics/discount_coupons_report.sql` (somente leitura, sem dado pessoal) mostra, por cupom, situação, usos por estado, excedentes, receita e desconto confirmados.

## Testes

- `tests/discount-coupons-admin.test.ts` (fase 3, PGlite com todas as migrations): variável e acesso (404/401/403), OPERATOR consulta e é recusado na rota e no banco, criação, código duplicado, percentual fora de 1–99, datas inválidas, sem validade, ilimitado, aplicabilidade com evento especial, edição antes e depois do uso, edição concorrente, ativação e desativação preservando reservas e valores, histórico de utilizações, liberação manual, alerta de limite excedido em todas as situações, consistência com o relatório, rotas, páginas, menu e ausência de migration ou mudança no checkout.

- `tests/discount-coupons.test.ts` (PGlite, todas as migrations): cálculo e arredondamento (banco e TypeScript iguais), cupom válido, vários participantes, cada recusa sem deixar reserva, validade em Brasília, reserva sem cupom, 100% recusado, mínimo nulo e abaixo do mínimo, código sem diferença de caixa, evento não elegível e selecionado, confirmação e webhook repetido, manipulação de valor, expiração e cancelamento sem pagamento, janela de segurança, pagamento tardio acima do limite, idempotência, troca de turma, Stand-by com e sem cupom, cancelamento depois do pagamento e liberação, permissões, travas de edição, limite abaixo do uso, valores preservados depois de alterar ou desativar, auditoria, migration aditiva e idempotente, preflight, postcheck, relatório e rollback.
- `tests/discount-coupons.test.ts` também cobre o alerta de excesso: ativo (`EXHAUSTED`), inativo, expirado e agendado acima do limite; ausência de falso alerta no limite exato, com uso reservado, sem limite, com uso liberado e com pré-reserva expirada; e a mesma contagem no cupom, nos usos marcados e no relatório.
- `tests/discount-coupons-concurrency.test.ts` (Postgres real, obrigatório no CI): 16 compras para 5 usos, último uso disputado (com confirmação e com desistência), a mesma tentativa em paralelo, cupom e vagas disputados juntos sem deadlock, e edição do limite durante uma compra.
- `tests/discount-coupons-rollback-concurrency.test.ts` (Postgres real, obrigatório no CI, um banco por cenário): A) compra aberta com uso gravado → o rollback espera e recusa depois do commit; B) compra que desiste → o rollback segue; C) rollback com as travas → a compra espera e falha sem pré-reserva; D) uso confirmado → recusa com tudo preservado; E) transação que leu reservas e depois compra com cupom → sem deadlock.
