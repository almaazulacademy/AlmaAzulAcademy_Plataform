-- =============================================================================
-- ROLLBACK de 202610140001_reservation_standby_admin_panel.sql — SOMENTE PARA
-- REVISÃO. NÃO EXECUTAR sem decisão explícita. Não está em supabase/migrations/
-- de propósito, para nenhuma ferramenta aplicá-lo automaticamente.
-- =============================================================================
--
-- O que faz: remove as quatro funções do painel de Stand-by e devolve à service
-- role a permissão de executar `admin_reschedule_reservation_from_standby`, que
-- a migration havia retirado. Nada mais — não há tabela, coluna, trigger,
-- constraint nem linha a desfazer.
--
-- Atenção ao segundo efeito: depois deste rollback, o reagendamento de Stand-by
-- **sem** régua de preço volta a ser executável pelo servidor, como era na etapa
-- anterior. Nenhum código o chama, mas a proteção deixa de existir no banco.
--
-- ORDEM IMPORTA. Antes de executar:
--   1. desligar o painel: `STANDBY_ADMIN_ENABLED` ausente ou diferente de `true`
--      no ambiente publicado. Com o painel ligado e sem estas funções, a lista e
--      os modais passam a responder com erro.
--
-- Reservas em Stand-by NÃO impedem este rollback e não são afetadas por ele:
-- status, autorizações, travas financeiras e a trigger da invariante pertencem a
-- `202610130002_reservation_standby.sql` e continuam ativas. O que se perde é só
-- a tela — as reservas continuam podendo ser resolvidas pelas RPCs da etapa
-- anterior.
--
-- Se o objetivo for reverter também `202610130002`, este arquivo vem PRIMEIRO:
-- as funções abaixo chamam peças daquela migration.

begin;

drop function if exists public.admin_reservation_standby_history(uuid, uuid);
drop function if exists public.admin_reschedule_standby_same_price(uuid, uuid, uuid, text);
drop function if exists public.admin_standby_reschedule_options(uuid, uuid);
drop function if exists public.admin_list_standby_reservations_page(uuid, text, uuid, text, integer, integer);

-- Estado anterior à migration: só a service role executa.
grant execute on function public.admin_reschedule_reservation_from_standby(uuid, uuid, uuid, text) to service_role;

commit;
