-- ESSÊNCIA — DESFAZER A PUBLICAÇÃO (GERADO; NÃO EDITAR À MÃO)
--
-- Rodar SÓ COM AUTORIZAÇÃO. Se EVENTS_PUBLIC_ENABLED estiver ligada, remover a
-- variável e fazer o redeploy primeiro: sem isso, o site mostra a seção vazia até o
-- próximo deploy. Volta o evento a rascunho pelo caminho do painel e desliga o
-- interruptor. Recusa, sem mudar nada, se houver sessão fora de CLOSED, reserva ou
-- inscrição: nesse caso, para tirar do ar, basta desligar o interruptor e decidir à parte.

begin;
set local lock_timeout = '5s';

do $desfazer$
declare
  actor uuid;
  actors integer;
  target public.experiences%rowtype;
begin
  select count(*), min(au.user_id::text)::uuid into actors, actor from public.admin_users au join auth.users u on u.id = au.user_id
  where lower(u.email) = 'almaazulacademy@gmail.com' and au.is_active and au.role = 'ADMIN';
  if actors <> 1 then
    raise exception 'ESSENCIA_ATOR: esperado 1 administrador ativo, encontrado %', actors;
  end if;
  select * into target from public.experiences where slug = 'essencia' and kind = 'EVENT' for update;
  if not found then
    raise exception 'ESSENCIA_DESFAZER_RECUSADO: evento ausente';
  end if;
  if exists (select 1 from public.sessions s where s.experience_id = target.id and s.status <> 'CLOSED')
     or exists (select 1 from public.reservations r join public.sessions s on s.id = r.session_id where s.experience_id = target.id)
     or exists (select 1 from public.waitlist_entries w join public.sessions s on s.id = w.session_id where s.experience_id = target.id) then
    raise exception 'ESSENCIA_DESFAZER_RECUSADO: sessão aberta, reserva ou inscrição existente';
  end if;
  if target.status = 'PUBLISHED' then
    perform public.admin_update_event(actor, target.id, target.title, target.summary, 'DRAFT', target.image_url, target.display_order, target.editorial_content);
  end if;
  update public.special_event_settings set publication_enabled = false, updated_at = now() where singleton;
  raise notice 'ESSENCIA_PUBLICACAO_DESFEITA';
end;
$desfazer$;

commit;
