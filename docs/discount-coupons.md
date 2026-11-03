# Cupons de desconto

[README](../README.md) · [Pagamentos](payments.md) · [Banco](database.md) · [Stand-by](reservation-standby.md) · [Eventos especiais](special-events.md)

**Estado (02/11/2026): fase 2 (banco e regras) em PR draft.** Migration `202611020001_discount_coupons.sql` **não aplicada** — e não deve ser aplicada antes de 08/11/2026, depois do ESSÊNCIA. `COUPONS_ADMIN_ENABLED` e `COUPONS_CHECKOUT_ENABLED` ausentes (desligadas). Nada no site chama as funções novas.

| Fase | Conteúdo | Estado |
| --- | --- | --- |
| 1 | Diagnóstico e arquitetura | Aprovada em 02/11/2026 |
| 2 | Banco, regras, concorrência, auditoria, diagnósticos e rollback | PR draft, migration não aplicada |
| 3 | Painel: Marketing → Cupons de desconto | Pendente |
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
- Depois do primeiro uso (qualquer um, mesmo expirado), código, percentual e aplicabilidade ficam travados. O limite nunca desce abaixo dos usos que já contam.
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

- o cupom aparece como `OVER_LIMIT` em `admin_list_coupons` / `admin_get_coupon` (e no painel da fase 3);
- cada uso pago além do limite, na ordem de confirmação, sai com `overLimit = true`;
- novos usos continuam recusados (`COUPON_EXHAUSTED`);
- `supabase/diagnostics/discount_coupons_report.sql` mostra a coluna `excedentes`.

### Stand-by

A régua de preço do Stand-by (modo `CUSTOMER`, usada pelo cliente e pelo painel) comparava o preço da turma com `unit_price_cents`. Numa reserva com cupom esse é o valor com desconto, e nenhuma turma de mesmo preço de lista seria aceita. `reservation_standby_target_rejection` passa a comparar com o preço de lista guardado em `coupon_redemptions` — e, sem cupom, exatamente como antes. O reagendamento não escreve em `unit_price_cents`: o desconto fica, nada é cobrado de novo, e o uso continua o mesmo.

Depois desta migration, os postchecks antigos do Stand-by (`reservation_standby_postcheck`, `reservation_standby_admin_panel_postcheck`, `reservation_standby_self_service_postcheck`) passam a apontar `reservation_standby_target_rejection` como diferente — esperado, e só ela. Os testes dessas etapas conferem o banco anterior aos cupons; o rollback desta migration devolve o corpo antigo e eles voltam a aprovar.

Pendência para a fase 5b: o diálogo de Stand-by do painel mostra `unitPriceCents` ("R$ X por participante"), que numa reserva com cupom é o valor com desconto.

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

**Rollback.** O operacional é desligar as variáveis ou desativar o cupom. O do banco é `supabase/rollback/202611020001_discount_coupons.rollback.sql`: remove tudo o que a migration criou e devolve a régua do Stand-by byte a byte. **Recusa, sem alterar nada, se existir qualquer uso registrado** — apagar `coupon_redemptions` apagaria o preço de lista e o desconto dessas reservas. Cupons nunca usados são removidos junto.

`supabase/diagnostics/discount_coupons_report.sql` (somente leitura, sem dado pessoal) mostra, por cupom, situação, usos por estado, excedentes, receita e desconto confirmados.

## Testes

- `tests/discount-coupons.test.ts` (PGlite, todas as migrations): cálculo e arredondamento (banco e TypeScript iguais), cupom válido, vários participantes, cada recusa sem deixar reserva, validade em Brasília, reserva sem cupom, 100% recusado, mínimo nulo e abaixo do mínimo, código sem diferença de caixa, evento não elegível e selecionado, confirmação e webhook repetido, manipulação de valor, expiração e cancelamento sem pagamento, janela de segurança, pagamento tardio acima do limite, idempotência, troca de turma, Stand-by com e sem cupom, cancelamento depois do pagamento e liberação, permissões, travas de edição, limite abaixo do uso, valores preservados depois de alterar ou desativar, auditoria, migration aditiva e idempotente, preflight, postcheck, relatório e rollback.
- `tests/discount-coupons-concurrency.test.ts` (Postgres real, obrigatório no CI): 16 compras para 5 usos, último uso disputado (com confirmação e com desistência), a mesma tentativa em paralelo, cupom e vagas disputados juntos sem deadlock, e edição do limite durante uma compra.
