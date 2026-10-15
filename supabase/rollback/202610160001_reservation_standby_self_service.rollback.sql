-- =============================================================================
-- ROLLBACK de 202610160001_reservation_standby_self_service.sql — SOMENTE PARA
-- REVISÃO. NÃO EXECUTAR sem decisão explícita. Não está em supabase/migrations/
-- de propósito, para nenhuma ferramenta aplicá-lo automaticamente.
-- =============================================================================
--
-- O que faz: remove as duas funções do autoatendimento e as duas tabelas do
-- limite de tentativas. As tabelas só guardam contadores com prazo de 15
-- minutos e o segredo do HMAC — nenhum dado de cliente, reserva ou pagamento.
--
-- O que NÃO faz: não toca reserva, sessão, pagamento, autorização de Stand-by,
-- histórico de trocas, auditoria nem a fila do e-mail. Reagendamentos feitos
-- pelo cliente continuam gravados, com o e-mail na fila da etapa 4.
-- `customer_reschedule_options` e `customer_reschedule_reservation`, da etapa 2,
-- continuam no banco, só executáveis pela service role.
--
-- ORDEM IMPORTA. Antes de executar:
--   1. desligar o autoatendimento: `STANDBY_SELF_SERVICE_ENABLED` ausente ou
--      diferente de `true` no ambiente publicado, seguido de novo deploy. Com a
--      variável ligada e sem estas funções, as rotas respondem "indisponível"
--      (503) — nunca liberam o acesso sem limite.
--
-- Reaplicar a migration depois cria um segredo novo: os contadores recomeçam
-- do zero, o que não tem efeito além disso.

begin;
set local lock_timeout = '5s';

drop function if exists public.customer_reschedule_overview(text, text, text);
drop function if exists public.register_customer_access_attempt(text, text, text, text);
drop table if exists public.customer_access_throttle;
drop table if exists public.customer_access_throttle_secret;

commit;
