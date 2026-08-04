# Limpeza manual das reservas de teste antes do lançamento

Este procedimento é deliberadamente separado das migrations de produto. Nenhum SQL deste pacote foi executado remotamente durante sua preparação. Ele não chama InfinitePay, não dispara webhook, reembolso, cancelamento, e-mail, WhatsApp ou notificação.

## Schema inventariado

As migrations versionadas definem três conjuntos de dados operacionais ligados a reservas:

| Objeto | Relação | Tratamento |
| --- | --- | --- |
| `public.reservations` | Reserva, quantidade de participantes, hold (`PRE_RESERVED` + `expires_at`), dados pessoais e referências de checkout | Excluir somente após aprovação |
| `public.payment_events` | FK `reservation_id` → `reservations.id`, `ON DELETE RESTRICT`; guarda eventos e payloads financeiros | Revisar e excluir antes das reservas |
| `public.admin_audit_log` | Sem FK; linhas com `entity_type = RESERVATION` ou ação `RESERVATION_%` guardam operação ligada à reserva | Excluir somente essas linhas |

Não existem tabelas versionadas separadas para participantes, holds, checkout sessions, confirmações, cancelamentos ou tracking tokens. Participantes são `sum(reservations.quantity)`; holds são reservas `PRE_RESERVED`; checkout e IDs do provedor ficam em `reservations`; confirmações/webhooks ficam em `payment_events`; cancelamentos e histórico operacional ficam na reserva e no audit log.

Devem ser preservados integralmente: `public.experiences`, `public.sessions`, `public.admin_users`, `auth.users`, `public.platform_settings`, conteúdo editorial, migrations e todas as RPCs. A ordem de exclusão é `admin_audit_log` de reserva → `payment_events` → `reservations`. O preflight lista FKs reais e o script aborta se encontrar qualquer dependência inesperada.

## Contagens e aprovação

As contagens reais não estão registradas neste repositório porque a tarefa proíbe SQL remoto. Elas devem ser obtidas executando manualmente [prelaunch_test_reservations_preflight.sql](../supabase/diagnostics/prelaunch_test_reservations_preflight.sql) no projeto correto. O resultado de aprovação deve conter:

1. total de reservas e contagem por status;
2. total de participantes (`sum(quantity)`);
3. holds ativos e expirados;
4. eventos e valores agregados por provedor/tipo;
5. contagens por experiência e sessão;
6. linhas de auditoria ligadas a reservas;
7. fingerprints de experiências, sessões e administradores;
8. data oficial de início da operação configurada no último bloco do preflight;
9. evidência de que nenhuma reserva posterior a essa data é real;
10. conclusão da revisão financeira.

Qualquer valor diferente de zero nos indicadores de pagamento exige conciliação humana. O script mostra apenas agregados e não revela telefone, e-mail, CPF, token, URL de checkout, referência do provedor ou payload. A ausência de execução remota significa que, neste commit, a contagem e a confirmação de “nenhum pagamento real” permanecem pendentes por desenho.

## Backup local obrigatório

Use uma pasta local protegida fora do repositório, por exemplo `C:\SecureBackups\alma-azul\prelaunch-AAAA-MM-DD`. A URL do banco deve ficar somente em variável de ambiente. Um backup completo em formato custom é a opção mais segura:

```powershell
pg_dump --dbname="$env:ALMA_AZUL_DATABASE_URL" --format=custom --file="C:\SecureBackups\alma-azul\prelaunch-AAAA-MM-DD\alma-azul-full.prelaunch-backup.dump"
pg_restore --list "C:\SecureBackups\alma-azul\prelaunch-AAAA-MM-DD\alma-azul-full.prelaunch-backup.dump"
```

Também é possível gerar um backup de dados das tabelas afetadas:

```powershell
pg_dump --dbname="$env:ALMA_AZUL_DATABASE_URL" --data-only --format=custom --table=public.reservations --table=public.payment_events --table=public.admin_audit_log --file="C:\SecureBackups\alma-azul\prelaunch-AAAA-MM-DD\reservations.prelaunch-backup.dump"
pg_restore --list "C:\SecureBackups\alma-azul\prelaunch-AAAA-MM-DD\reservations.prelaunch-backup.dump"
```

Esses arquivos contêm dados pessoais e payloads de pagamento: não mover para `public/`, Drive compartilhado ou GitHub. `.gitignore` bloqueia os padrões usuais como defesa adicional, mas não substitui criptografia e controle de acesso.

## Ordem exata de execução manual

1. Abra uma janela de manutenção e impeça novas tentativas de reserva na aplicação.
2. Execute o preflight sem alterações e salve o resultado em local protegido.
3. Preencha no preflight a data oficial de início da operação; execute novamente e revise possíveis linhas posteriores.
4. Compare qualquer evidência de InfinitePay/`CONFIRMED` com a conciliação disponível, sem chamar APIs a partir destes scripts. Pare se houver pagamento real ou dúvida.
5. Faça os backups e valide-os com `pg_restore --list`.
6. Copie [clear_test_reservations_before_launch.sql](../supabase/maintenance/clear_test_reservations_before_launch.sql) para a pasta local protegida; nunca ative as travas no arquivo versionado.
7. Na cópia local, altere `confirm_delete_test_reservations` para `true`, informe em `approved_test_data_cutoff` o maior `reservations.created_at` aprovado no preflight e, somente se houver evidência financeira comprovadamente de teste, altere `confirm_all_payment_evidence_is_test` para `true`.
8. Para ensaio, troque o `COMMIT` final por `ROLLBACK`, execute o arquivo inteiro e confira as contagens. Restaure `COMMIT` apenas após aprovação.
9. Execute a cópia aprovada com parada no primeiro erro: `psql "$env:ALMA_AZUL_DATABASE_URL" -v ON_ERROR_STOP=1 -f "C:\SecureBackups\alma-azul\prelaunch-AAAA-MM-DD\clear_test_reservations_approved.sql"`.
10. Execute [prelaunch_test_reservations_postcheck.sql](../supabase/diagnostics/prelaunch_test_reservations_postcheck.sql), compare os fingerprints e arquive o resultado.
11. Reabra a aplicação e valide Home, páginas de experiências, início do formulário, acompanhamento e painel sem concluir checkout.

## Cache e estado derivado

Não há cache persistente de reservas no código: Home, experiências, reserva, retorno de pagamento e painel usam rotas dinâmicas; os contadores e vagas são calculados no banco. Não há `localStorage` ou `sessionStorage` do fluxo. Cookies guardam somente a sessão administrativa e não devem ser limpos. Após o commit da limpeza, um refresh normal das páginas dinâmicas deve exibir zero reservas e `available_spots = sessions.capacity`; o postcheck verifica essa igualdade para cada sessão.

## Rollback

Antes do `COMMIT`, qualquer erro aborta a transação. No ensaio, use `ROLLBACK`. Depois do commit, restaure o backup em uma janela controlada para um banco vazio ou ambiente de recuperação e valide antes de qualquer troca de produção. Nunca tente reconstruir os dados a partir de logs públicos ou do Git.
