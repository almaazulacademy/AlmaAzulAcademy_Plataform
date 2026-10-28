-- =============================================================================
-- ROLLBACK de 202610280001_special_events_foundation.sql — SOMENTE PARA REVISÃO.
-- NÃO EXECUTAR sem decisão explícita. Não está em supabase/migrations/ de
-- propósito, para nenhuma ferramenta aplicá-lo automaticamente.
-- =============================================================================
--
-- O que faz: remove as duas triggers de tipo, as treze funções criadas pela
-- migration, a tabela `special_event_settings`, a constraint e a coluna
-- `experiences.kind`.
--
-- Recusa (e não muda nada) se existir qualquer experiência `EVENT`. Sem a
-- coluna, um evento viraria uma experiência comum em silêncio: apareceria na
-- vitrine, na agenda e como destino de reagendamento de reservas regulares.
-- Nesse caso, primeiro decida o destino de cada evento (arquivar pelo painel,
-- por exemplo) e só então trate o rollback, com outro script revisado.
--
-- O que NÃO faz: não toca reserva, sessão, pagamento, Stand-by, lista de
-- espera, auditoria nem nenhuma função existente. Reaplicar a migration depois
-- devolve tudo, com o interruptor da publicação desligado.

begin;
set local lock_timeout = '5s';

-- A leitura da coluna é dinâmica: sem a coluna (migration nunca aplicada ou
-- rollback já feito), o bloco simplesmente segue.
do $$
declare
  events integer := 0;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'experiences' and column_name = 'kind'
  ) then
    execute 'select count(*) from public.experiences where kind = ''EVENT''' into events;
  end if;
  if events > 0 then
    raise exception 'ROLLBACK_RECUSADO: existem % experiência(s) EVENT. Nada foi alterado.', events;
  end if;
end;
$$;

drop trigger if exists reservations_event_kind_guard on public.reservations;
drop trigger if exists experiences_kind_guard on public.experiences;

drop function if exists public.admin_event_report(uuid, uuid);
drop function if exists public.admin_list_events(uuid);
drop function if exists public.admin_duplicate_event(uuid, uuid, text, text, timestamptz);
drop function if exists public.admin_update_event(uuid, uuid, text, text, text, text, integer, jsonb);
drop function if exists public.admin_create_event(uuid, uuid, text, text, text, jsonb, text, timestamptz, integer, integer, integer);
drop function if exists public.list_public_regular_catalog();
drop function if exists public.list_public_regular_experiences();
drop function if exists public.list_public_event_sessions(text);
drop function if exists public.get_public_event(text);
drop function if exists public.list_public_events();
drop function if exists public.special_event_availability(uuid);
drop function if exists public.enforce_reservation_event_kind();
drop function if exists public.enforce_experience_kind_rules();

drop table if exists public.special_event_settings;

alter table public.experiences drop constraint if exists experiences_kind_check;
alter table public.experiences drop column if exists kind;

commit;
