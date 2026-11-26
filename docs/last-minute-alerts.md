# Alertas internos de reservas — preparado, desligado

Base da implementação: `db42e4519b22b9a384be53b8b17b417882baaa6a`.
Nenhum deploy, SQL, cron ou envio foi executado em produção na preparação.

## Regra aprovada

Destinatário único e fixo: `almaazulacademy@gmail.com`. A mensagem informa tipo,
experiência, base, dia e horário da sessão, confirmação original, quantidade,
identificador e link autenticado para o painel. Remarcações e mudanças de horário
também mostram a data da alteração. Horários exibidos em `America/Sao_Paulo`.

Janela móvel em horas, substituindo a regra anterior por datas locais:

* até 24h inclusive: URGENTE;
* mais de 24h até 48h inclusive: PRIORITÁRIO;
* acima de 48h: não enfileira, nem cria lembrete futuro.

Confirmação após o início é uma exceção URGENTE identificada no corpo. A tentativa
de avisá-la expira após uma hora; os alertas normais expiram no início da sessão.
Fechar vendas (`CLOSED`) não equivale a cancelar a experiência.

## Sem reservas antigas

A instalação começa com `enabled=false` e sem marco de ativação. Não há `INSERT
SELECT` de reservas históricas nem rotina de backfill. O worker processa a fila e
os eventos de horário registrados após a ativação; não busca confirmações antigas.

A primeira ativação grava `first_activated_at` pelo relógio do banco. Por segurança,
**reservas criadas antes desse marco são excluídas**, mesmo que um pagamento
pendente seja confirmado ou que sejam remarcadas depois da ativação. Esse corte
conservador atende à orientação de não avisar reservas antigas.

Ativar novamente não altera o primeiro marco, mas cria uma nova época e um novo
`active_since`: filas de épocas anteriores são descartadas, sem envio de backlog.
Repetir a ativação enquanto já está ligada não muda o marco. Pausar exige desligar
a captura no banco; a flag do backend sozinha só interrompe o processamento.

## Arquitetura e limites

Triggers locais gravam o evento na mesma transação da confirmação, do histórico de
remarcação (direta, Stand-by e restauração) ou da mudança de `sessions.starts_at`.
Eventos coletivos de horário são reavaliados até o início da sessão, com sequência
de origem preservada, para recuperar confirmações concorrentes que ainda não
estavam visíveis na primeira passagem. A expansão repetida não duplica o alerta.
Não fazem HTTP. A falha do insert pode abortar a transação; validar a migration em
homologação antes da liberação. Operações financeiras existentes não foram reescritas.

Há dois bloqueios independentes: `LAST_MINUTE_ALERTS_ENABLED=true` no backend e
ativação administrativa no banco. Reivindicação com `SKIP LOCKED`, token de
tentativa e lease de 2min; lotes de até duas mensagens no backend; seis tentativas
com espera progressiva. Alteração, cancelamento, Stand-by, época antiga ou alerta
vencido são reconferidos antes de enviar. Eventos mais recentes suprimem anteriores,
inclusive quando a reserva volta à turma original.

Uma mensagem congelada e a chave `last-minute-alert/<alert-id>` são repetidas sem
alteração. O provedor atual suporta idempotência de 24h; a fila interrompe a
recuperação após 23h, marcando UNCERTAIN, e nunca reinicia a entrega automaticamente.
Falha ao gravar um aceite mantém SENDING até recuperação; não vira recusa.

`SENT` significa aceite HTTP pelo provedor, não confirmação de chegada à caixa.
Não há novo webhook de entregabilidade nem armazenamento do ID do Resend nesta
versão (a interface compartilhada atual retorna void). Identificação e correlação
são pelo ID/chave do alerta e pelo histórico de tentativas.

Como em toda notificação externa, existe um intervalo entre a última revalidação
e o aceite do provedor. Um cancelamento nesse intervalo não recolhe uma mensagem
já aceita. Não se mantém transação/lock de reserva durante a chamada de rede.

## Homologação sem produção

Executar com dados sintéticos e sem `.env` de produção. Os testes usam PGlite e
um Resend simulado que conta entregas e reproduz timeouts após aceite. Nenhuma
chamada aos serviços de pagamento/e-mail é necessária. O build não precisa de
chaves. Não criar reservas pelo preview conectado ao banco real: o checkout
existente possui fallback de domínio oficial.

```sh
node --experimental-strip-types --import ./tests/support/alias-hooks.mjs --test tests/last-minute-alerts.test.ts
pnpm exec tsc --noEmit
pnpm lint
```

Antes da ativação, validar concorrência em Postgres isolado com conexões distintas,
incluindo confirmação simultânea à alteração de horário da sessão e operações de
remarcação. PGlite valida SQL e transições, mas não substitui esse teste de locks.
O risco da reconciliação financeira com identificador de transação vazio, apontado
na auditoria, continua separado e precisa ser resolvido/validado antes da liberação.

## Sequência de liberação futura — exige revisão e autorização

1. Aplicar somente `20261125232200_last_minute_internal_alerts.sql` em homologação.
   Produção tem histórico de migrations incompleto: não executar todas as migrations
   antigas nem `db push` cegamente.
2. Validar a matriz e revisar o diff. Publicar o backend com a flag ainda false.
3. Em produção, aplicar somente a migration nova, após conferir o esquema real.
   Ela não ativa nem gera alertas.
4. Configurar segredo dedicado `LAST_MINUTE_ALERTS_CRON_SECRET` na Vercel e no
   Vault (nome `last_minute_alert_worker_secret`), sem reutilizar service_role ou
   Resend. Configurar `last_minute_alert_worker_url` no Vault com o endpoint exato
   `https://www.almaazulacademy.com.br/api/cron/last-minute-alerts`.
5. Revisar/aplicar `supabase/maintenance/last_minute_alerts_schedule.sql`: habilita
   pg_net e cria um job separado. Só chama HTTP se captura estiver ligada e houver
   trabalho devido. A fila de negócio é permanente e independe da durabilidade do
   pg_net. O job de expiração existente fica intacto.
6. Publicar a flag `LAST_MINUTE_ALERTS_ENABLED=true`. Sem ativação no banco, inerte.
7. Por último, o administrador ativa usando seu ID real de `admin_users`:

```sql
select public.admin_configure_last_minute_alerts('<ADMIN_USER_ID>'::uuid,true);
```

Esse último comando define o início efetivo. Não se fornece data retroativa.
Não testar produção com reservas/pagamentos/notificações fictícios; observar a
primeira ocorrência legítima após a ativação e os registros sem dados pessoais.

## Monitoramento e rollback

`supabase/diagnostics/last_minute_alerts_check.sql` mostra somente configuração e
contadores. Monitorar idade da fila, FAILED/UNCERTAIN, tentativas esgotadas e tempo
entre `occurred_at` e `sent_at`. Logs não incluem destinatário, nome ou corpo.

Para pausar, usar `admin_configure_last_minute_alerts(<ADMIN_USER_ID>,false)` e
desativar a flag do backend. O lease em andamento é revalidado no freeze, mas um
envio externo já aceito pode terminar. Desativar o job separado se necessário.
Preservar tabelas e histórico e, se preciso, retornar o backend ao commit anterior.
Não remover tabelas com mensagens em curso. Reativação cria nova época e não
envia os alertas acumulados antes dela.

## Fora do escopo

Sem alteração do pagamento, dos e-mails atuais de cliente, do histórico financeiro,
da lista de espera ou dos destinatários atuais. Sem integração ChatGPT/API OAuth,
sem mudanças de plano, sem commits/branches/PRs, sem execução em produção.
