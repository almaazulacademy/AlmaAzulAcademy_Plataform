-- =============================================================================
-- ESSÊNCIA — DESFAZER O CADASTRO (GERADO; SOMENTE COM DECISÃO EXPLÍCITA)
-- =============================================================================
--
-- Remove o evento essencia e a sessão dele **só** se ele ainda estiver em
-- rascunho, com a sessão fechada e sem nenhuma reserva, inscrição na lista de
-- espera ou registro de presença. Senão, para sem mudar nada. O registro
-- EVENT_CREATED da auditoria fica (histórico).

begin;
set local lock_timeout = '5s';

do $desfazer$
declare
  target uuid;
begin
  select id into target from public.experiences where slug = 'essencia' and kind = 'EVENT';
  if target is null then
    raise notice 'ESSENCIA_DESFAZER: nada a desfazer';
    return;
  end if;
  if (select status from public.experiences where id = target) <> 'DRAFT'
     or exists (select 1 from public.sessions where experience_id = target and status <> 'CLOSED')
     or exists (select 1 from public.reservations r join public.sessions s on s.id = r.session_id where s.experience_id = target)
     or exists (select 1 from public.waitlist_entries we join public.sessions s on s.id = we.session_id where s.experience_id = target) then
    raise exception 'ESSENCIA_DESFAZER_RECUSADO: o evento já saiu do rascunho ou tem reserva/inscrição — decidir caso a caso';
  end if;
  delete from public.sessions where experience_id = target;
  delete from public.experiences where id = target;
  raise notice 'ESSENCIA_DESFEITO';
end;
$desfazer$;

commit;
