-- =============================================================================
-- ROLLBACK de 202610250001_waitlist_foundation.sql — SOMENTE PARA REVISÃO.
-- NÃO EXECUTAR sem decisão explícita. Não está em supabase/migrations/ de
-- propósito, para nenhuma ferramenta aplicá-lo automaticamente.
-- =============================================================================
--
-- O que faz: remove as dezoito funções e as seis tabelas da lista de espera —
-- inscrições, aberturas, fila de avisos, tentativas, contadores do limite e o
-- segredo do link de cancelamento.
--
-- O que NÃO faz: não toca reserva, sessão, experiência, pagamento, Stand-by,
-- fila de e-mail de reagendamento nem nenhuma função existente.
-- `list_open_sessions` e `get_booking_session` continuam como sempre foram.
-- Linhas de `admin_audit_log` com `entity_type = 'waitlist_entry'` (remoções
-- feitas pelo painel) ficam: são o registro do que a equipe fez, e não trazem
-- dado pessoal nos metadados.
--
-- **Recusa** enquanto houver inscrição ativa: apagar a lista com clientes
-- esperando vaga é decisão de produto, não de banco. Nesta fase nenhuma rota
-- inscreve ninguém, então a lista está vazia. Se um dia houver inscrições e a
-- decisão for apagar mesmo assim, encerre-as antes pelo painel.
--
-- ORDEM IMPORTA. Antes de executar, desligar no ambiente publicado tudo o que as
-- fases seguintes tiverem ligado (inscrição pública, painel, avisos) e publicar
-- de novo. Nesta fase não há nada ligado.
--
-- Reaplicar a migration depois cria um segredo novo: links de cancelamento
-- antigos param de valer, e os contadores do limite recomeçam do zero.

begin;
set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.waitlist_entries') is not null
     and exists (select 1 from public.waitlist_entries where status = 'ACTIVE') then
    raise exception 'WAITLIST_ROLLBACK_REFUSED: há inscrições ativas na lista de espera'
      using errcode = '55000';
  end if;
end $$;

drop function if exists public.admin_remove_waitlist_entry(uuid, uuid, text);
drop function if exists public.admin_waitlist_entry(uuid, uuid);
drop function if exists public.admin_list_waitlist_entries_page(uuid, uuid, uuid, text, text, integer, integer);
drop function if exists public.admin_waitlist_sessions(uuid, boolean);
drop function if exists public.waitlist_cancel(text, text);
drop function if exists public.waitlist_cancel_overview(text, text);
drop function if exists public.waitlist_join(uuid, text, text, text, integer, text, text);
drop function if exists public.waitlist_eligible_entries(uuid, integer);
drop function if exists public.waitlist_wave_size(integer);
drop function if exists public.waitlist_anonymize_entries(integer);
drop function if exists public.waitlist_mark_conversions(integer);
drop function if exists public.waitlist_expire_entries(integer);
drop function if exists public.register_waitlist_attempt(text, text, text);
drop function if exists public.waitlist_skip_pending_notifications(uuid, text);
drop function if exists public.waitlist_token_hash(text);
drop function if exists public.waitlist_cancel_token(uuid);
drop function if exists public.waitlist_effective_status(text, timestamptz, public.session_status);
drop function if exists public.list_public_sessions(text);

drop table if exists public.waitlist_notification_attempts;
drop table if exists public.waitlist_notifications;
drop table if exists public.waitlist_openings;
drop table if exists public.waitlist_entries;
drop table if exists public.waitlist_throttle;
drop table if exists public.waitlist_throttle_secret;

commit;
