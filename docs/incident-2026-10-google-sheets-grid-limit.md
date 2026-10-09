# Incidente: sincronização com a planilha parada pela grade cheia (outubro/2026)

[README](../README.md) · [Integração com o Google Sheets](google-sheets-integration.md)

**Estado:** encerrado em 09/10/2026. Nenhuma reserva, pagamento, QR Code ou check-in foi afetado; só o espelho na planilha ficou para trás.

## Resumo

Entre 07/10 e 09/10/2026 as reservas novas deixaram de chegar à planilha operacional "CONTROLE DE EXPERIENCIAS". No painel, **Sincronizar lista** respondia:

> Sincronização pendente — Não foi possível reconstruir a lista na planilha agora. A sincronização ficou pendente e será tentada de novo.

A aba oculta `Vagas Confirmadas` tinha chegado à última linha da grade. O Supabase continuou correto o tempo todo.

## Linha do tempo (horário de Brasília)

| Quando | O que aconteceu |
| --- | --- |
| 07/10 10:22 | Última vaga nova gravada na planilha, na linha 2009 — a última da grade. |
| 07/10 em diante | Toda sincronização que precisava de linha nova falha com `HTTP_400`. Reescritas de linhas existentes continuam funcionando. |
| 08/10 17:08 | Deploy do lançamento da Base Cápsula Bar (PR #22). Coincidência de data, sem relação causal. |
| 09/10 | Diagnóstico. Grade ampliada manualmente em 1000 linhas (2009 → 3009). |
| 09/10 10:05 | Correção definitiva em produção (PR #23, commit `f8d3c86`). |
| 09/10 10:31–10:33 | Recuperação: reconstrução das 10 sessões afetadas. |
| 09/10 | Comparação final Supabase × planilha e encerramento. |

## Causa raiz

A sincronização escreve em intervalos explícitos com `values.batchUpdate` — decisão tomada depois que `values.append` inseriu linhas acima do cabeçalho. Diferente do `append`, a escrita em intervalo explícito **não aumenta a grade** da aba.

As abas de dados nascem com 2000 linhas. A `Vagas Confirmadas` cresce uma linha por participante, então enche primeiro. Ao tentar gravar na linha 2010, o Google recusa o lote inteiro:

```text
Range ('Vagas Confirmadas'!…2010) exceeds grid limits. Max rows: 2009
```

Como o lote é atômico, nem a linha da reserva nem a da sessão eram gravadas. O job ficava `FAILED` com `HTTP_400`.

Por que demorou a aparecer: o código de erro era só `HTTP_400`, o aviso do painel não mostrava código nenhum, e sincronizações que apenas reescreviam linhas existentes seguiam funcionando.

## Correção

PR #23 (`fix: sincronização com a planilha parada pela grade cheia`), sem migration:

- `syncSnapshot` calcula a última linha que vai ocupar em cada aba e chama `ensureRows` antes de gravar. O cliente lê `gridProperties.rowCount` e, quando falta, acrescenta linhas vazias no fim com `appendDimension` (o que falta + 500 de folga). Nenhuma linha existente muda de posição.
- `SNAPSHOT_UNAVAILABLE` e `HEADER_ROW_WRITE_BLOCKED` deixam de virar `UNEXPECTED_ERROR`.
- O aviso "Sincronização pendente" passa a mostrar o código sanitizado da falha.

Detalhes em [Grade cheia](google-sheets-integration.md#grade-cheia).

## Impacto medido

Fila em 09/10, antes da recuperação:

| Indicador | Valor |
| --- | --- |
| Jobs de reserva `FAILED` (`HTTP_400`) | 31 |
| Jobs de sessão `FAILED` (`HTTP_400`) | 3 |
| Jobs com as 5 tentativas esgotadas | 0 |
| Jobs de entidades inexistentes ou de reservas canceladas | 0 |
| Sessões afetadas | 10 (todas do Lago Norte, turmas de 03/10 a 17/10) |

## Recuperação

1. **Conferência de registros manuais.** Antes de reconstruir, as abas `Vagas Confirmadas` e `Reservas do Site` foram auditadas: nenhuma chave fora do padrão do sistema, nenhuma vaga sem reserva correspondente, nenhuma observação escrita à mão, nenhuma chave duplicada. Não havia linha manual que a reconstrução fosse desativar.
2. **Uma passada única** nas 10 sessões, pelo endpoint do botão **Sincronizar lista** (`POST /api/admin/sessions/<id>/sync-sheet`), uma sessão por vez, com 6 segundos de intervalo e parada na primeira falha. As 10 responderam `SYNCED`.
3. **Efeito na planilha:** 941 → 997 reservas e 2012 → 2138 vagas. Nenhuma linha existente sumiu, mudou de posição, mudou de status ou foi desativada.
4. **Fila depois:** nenhum job do Google Sheets pendente. A drenagem de carona (até 3 jobs por sincronização bem-sucedida) concluiu os jobs de reserva; não foi necessária segunda passada nem alteração direta no banco.

## Validação final

Comparação por sessão entre o Supabase e a planilha, usando contagem de reservas confirmadas, vagas e o md5 do conjunto de ids confirmados (`supabase/diagnostics/google_sheets_consistency.sql`):

| Verificação | Resultado |
| --- | --- |
| Sessões com reservas no Supabase | 114 |
| Sessões idênticas na planilha | 100 |
| As 10 sessões recuperadas | idênticas |
| Reservas duplicadas na planilha | 0 |
| Canceladas ou expiradas com vaga ativa na planilha | 0 |

### As 14 sessões históricas fora da planilha

Catorze sessões têm, juntas, 97 reservas confirmadas (200 vagas) no Supabase que não estão na planilha. Doze não aparecem em nenhuma aba; duas são turmas de 15/08/2026 com parte das reservas. São anteriores ao início da integração (a planilha foi criada em 19/08/2026) e não fazem parte deste incidente.

**Decisão administrativa (Rudah, 09/10/2026): essas 14 sessões ficam fora da sincronização e o histórico da planilha é mantido como está.** Não é falha pendente. Uma comparação futura vai voltar a apontá-las; isso é esperado.

Prefixos dos `session_id`: `0a98cf4c`, `0ca42ebe`, `49a818bf`, `4d77bf1d`, `5589d4c6`, `6547901a`, `86480dee`, `87077465`, `8796cfff`, `8d78dd76`, `9b40060d`, `c3969f2c`, `c42e5181`, `d47907c1`.

## Se acontecer algo parecido

1. Abrir o detalhe da falha: o aviso do painel mostra o código. `HTTP_400` em sincronizações que criam linha nova aponta para a estrutura da planilha (grade, aba renomeada, intervalo).
2. Ver a fila com `supabase/diagnostics/google_sheets_sync_open_jobs.sql` (todos os jobs não concluídos) e `google_sheets_sync_backlog.sql` (por sessão). São somente leitura.
3. Conferir a grade: na planilha, a última linha usada de cada aba contra o total de linhas.
4. Recuperar com **Sincronizar lista** nas sessões afetadas, uma por vez. É idempotente e só lê o Supabase.
5. Validar com `google_sheets_consistency.sql` e comparar com a planilha.

## Fora do escopo

Um job de `RESERVATION_CONFIRMATION_EMAIL` com `HTTP_422`, de 06/09/2026, apareceu na conferência da fila. É independente deste incidente e será investigado à parte.
