-- =============================================================================
-- ROLLBACK de 202610300001_waitlist_event_scope.sql — SOMENTE PARA REVISÃO.
-- NÃO EXECUTAR sem decisão explícita. Não está em supabase/migrations/ de
-- propósito, para nenhuma ferramenta aplicá-lo automaticamente.
-- =============================================================================
--
-- Remove as duas funções novas e mais nada. Inscrições, avisos na fila,
-- tentativas e histórico ficam como estão. Depois dele, o site volta sozinho
-- para as funções de sempre (`waitlist_cancel_overview` e
-- `claim_pending_waitlist_spot_emails`): a página do link volta a falar de
-- "turma", e o envio volta a reivindicar avisos de qualquer tipo — por isso,
-- antes do rollback, desligue `EVENTS_WAITLIST_ENABLED` (ou a venda do evento).

begin;
set local lock_timeout = '5s';

drop function if exists public.waitlist_cancel_overview_with_kind(text, text);
drop function if exists public.claim_pending_waitlist_spot_emails_by_kind(text[], integer, integer, integer, integer);

commit;
