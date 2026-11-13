# Cupons — roteiro de homologação do painel (fase 3)

[Cupons de desconto](discount-coupons.md)

Roteiro para ver o painel **Marketing → Cupons de desconto** funcionando antes do merge da fase 3. Nada aqui liga o checkout público: `COUPONS_CHECKOUT_ENABLED` continua ausente o tempo todo, então nenhum cliente consegue usar cupom, nem o de teste.

## Antes de começar (tudo depende de autorização do Rudah)

1. **Migration aplicada.** A consulta de presença precisa dar `APLICADA` e o `discount_coupons_postcheck.sql` precisa dar `CUPONS_POSTCHECK_OK`. Sem a migration, as páginas mostram "Aplique a migration de cupons" e o roteiro para aqui.
2. **Preview da branch, não Production.** Na Vercel, criar só para Preview e só para a branch `claude/cupons-fase-3-painel`:
   - `COUPONS_ADMIN_ENABLED` = `true`
   - `SUPABASE_SERVICE_ROLE_KEY` (o Preview não tem; sem ela o login do painel não funciona)
   Depois, fazer redeploy do Preview da branch. **O Preview usa o banco de produção:** tudo que for gravado no passo B é real.
3. **Contas.** Uma conta ADMIN e uma OPERATOR ativas em `admin_users`. Se não houver OPERATOR, o passo D fica para quando houver.

## A. Só leitura (não grava nada)

| # | Onde | O que conferir |
| --- | --- | --- |
| A1 | Menu lateral (ADMIN) | Grupo **Marketing** com **Cupons de desconto**; o resto do menu igual ao de Production |
| A2 | `/admin/marketing/cupons` | Estado vazio "Nenhum cupom cadastrado", botão **Novo cupom**, filtro por situação (inclusive "Com limite excedido") e busca por código |
| A3 | `/admin/marketing/cupons/novo` | Campos: código, percentual, início, término, limite (ilimitado ou quantidade), aplicabilidade, status inicial e descrição |
| A4 | Experiências elegíveis | Em "Experiências específicas": todas as regulares aparecem; eventos especiais (ESSÊNCIA) aparecem separados e só entram se marcados |
| A5 | Validação sem salvar | Percentual 0 e 100, término antes do início e código vazio mostram erro no campo. **Não clicar em Criar** |
| A6 | Celular (375 px) | Lista, formulário e detalhe sem rolagem horizontal da página |

## B. Grava no banco de produção (um único cupom de teste)

Usar sempre o mesmo cupom, criado **inativo**. Cupom não se apaga (só se desativa), então ele fica no banco como registro do teste.

| # | Ação | Resultado esperado |
| --- | --- | --- |
| B1 | Criar `HOMOLOGPAINEL`, 10%, sem datas, limite 5, uma experiência regular, status **Inativo**, descrição "Teste de homologação do painel — não divulgar" | Volta para o detalhe; situação **Inativo**; validade "Sem prazo"; limite "5" |
| B2 | Criar de novo `homologpainel` (minúsculas) | Erro de código duplicado (409); nada é criado |
| B3 | Editar: limite 5 → 3 e descrição | Salva; código, percentual e experiências continuam editáveis (ainda sem uso) |
| B4 | Abrir a edição em duas abas, salvar na primeira e depois na segunda | A segunda recebe "Este cupom foi alterado por outra pessoa enquanto você editava" (409) e nada é sobrescrito |
| B5 | **Ativar cupom** e **Desativar cupom** pelo detalhe, com motivo | Situação alterna **Ativo/Inativo**; a lista acompanha. O checkout continua sem campo de cupom |
| B6 | Terminar **inativo** | Situação final **Inativo** |

## C. Indicadores, utilizações e liberação (sem uso real)

O cupom de teste não tem utilizações, porque o checkout está desligado. No detalhe dele, conferir só o desenho:

| # | O que conferir |
| --- | --- |
| C1 | Cartões de utilizações por estado, receita confirmada, descontos concedidos e "Aguardando pagamento" com zero e sem quebra de layout |
| C2 | Histórico de utilizações com o estado vazio "Nenhuma utilização ainda" |
| C3 | Nenhum alerta de "Limite excedido" e nenhum botão de liberação (só aparecem com uso pago e cancelado) |

Valores diferentes de zero, o alerta de limite excedido, o histórico com linhas e a **liberação manual auditada** só aparecem com utilizações reais. Na fase 3 eles estão cobertos pelos testes automáticos, que rodam as RPCs reais com pré-reserva, pagamento, expiração, reconciliação tardia e cancelamento (`tests/discount-coupons-admin.test.ts`). A conferência visual com valores fica para a homologação da fase 4, com a compra de teste pelo checkout. **Não criar utilizações por SQL em produção:** elas seguram vaga e não podem ser apagadas.

## D. Permissões (OPERATOR)

| # | Ação | Resultado esperado |
| --- | --- | --- |
| D1 | Entrar como OPERATOR e abrir a lista e o detalhe do `HOMOLOGPAINEL` | Consulta tudo; não aparecem **Novo cupom**, **Editar**, **Ativar cupom/Desativar cupom** nem **Liberar utilização** |
| D2 | Digitar `/admin/marketing/cupons/novo` e `/admin/marketing/cupons/<id>/editar` | Volta para a lista/detalhe |
| D3 | Instrutor | Não entra no painel |

## E. Desligar e conferir

1. Remover `COUPONS_ADMIN_ENABLED` e `SUPABASE_SERVICE_ROLE_KEY` do Preview da branch e fazer redeploy.
2. Conferir que o grupo **Marketing** sumiu e que `/admin/marketing/cupons` responde 404.
3. Conferir na Vercel que nenhuma variável `COUPONS_*` existe em Production.

## Registro

Anotar data, quem executou, o id do `HOMOLOGPAINEL` e o resultado de cada linha (OK ou o que apareceu). Qualquer resultado diferente do esperado suspende o merge da fase 3.
