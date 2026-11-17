# ESSÊNCIA — Corpo, Mente e Natureza — preparação e lançamento

[Eventos especiais](special-events.md#essência--corpo-mente-e-natureza-2ª-edição) · [Abertura da 1ª edição](essencia-abertura.md)

## Mudança de programação com reservas abertas

A programação aprovada para 23/11 vai de **17h15 a 20h30**, em Brasília. A tolerância de chegada termina às **17h30**, quando começa a remada. Às 18h30, Superioga com Rapha Dantas e dinâmica educativa opcional com o Instituto Equilibraí e Fernanda Garcia acontecem ao mesmo tempo. Crianças e adolescentes continuam sob supervisão adequada de seus responsáveis. Às 19h30 começam o lanche da Nutre - DF e os atendimentos de Cure-se Bem, conforme a disponibilidade dos profissionais. Os atendimentos vão até 20h30.

O site, o checkout, a confirmação e o painel leem a sessão vinculada pelo mesmo ID. O editorial da página e dos e-mails vem do Supabase. A rota de demonstração lê o fixture. E-mails já entregues e listas exportadas antes da mudança conservam o horário anterior.

1. No SQL Editor, execute `supabase/diagnostics/evento_essencia_lua_cheia_programacao_preflight.sql`. Exija `EVENTO_PROGRAMACAO_PREFLIGHT_OK = OK` com zero falhas e registre os agregados. A sessão deve estar `OPEN` no horário anterior (16h30, 210 minutos). O script confirma o editorial publicado esperado, a base, a ausência de sobreposição e os estados de reservas e pagamentos. Reservas existentes são esperadas.
2. Após a integração, o deploy e autorização específica, refaça a leitura e execute `supabase/maintenance/evento_essencia_lua_cheia_programacao_update.sql` uma vez. O aviso `EVENTO_PROGRAMACAO_ATUALIZADA` deve mostrar os mesmos IDs. A transação altera o editorial, o início da sessão e a duração da sessão e da experiência, com registro de auditoria.
3. Execute `supabase/diagnostics/evento_essencia_lua_cheia_programacao_postcheck.sql` e compare os indicadores. Confirme o horário e a duração no site, no checkout e no painel. As vendas em curso podem explicar mudanças nos totais entre as duas leituras. Investigue diferenças sem explicação.
4. Se necessário, use `supabase/rollback/evento_essencia_lua_cheia_programacao_update.rollback.sql` com autorização específica. O banco exige os dados revisados, a sessão aberta, o horário anterior ainda futuro e livre de conflitos e o mesmo conjunto de IDs, estados e quantidades das reservas desde a mudança. Avalie também se o novo horário já foi comunicado antes de reverter.

Com autorização para comunicar a mudança, use o canal oficial para avisar quem já confirmou a reserva e revisar os casos de pré-reserva ou pagamento em análise. Informe **23/11, chegada às 17h15, tolerância até 17h30, término às 20h30, no Cápsula Bar — Orla da Concha Acústica**. Diga que a reserva e o comprovante continuam válidos e ofereça o canal de atendimento para quem tiver conflito de horário. A mudança de programação não dispara reenvio de confirmação, cancelamento ou cobrança.

Os SQLs de diagnóstico, atualização e reversão são gerados por `pnpm events:essencia-lua-cheia-programacao-sql`. Os modelos de cadastro e lançamento servem para testes locais e referência da operação inicial.
