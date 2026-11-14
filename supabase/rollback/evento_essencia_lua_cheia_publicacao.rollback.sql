-- ESSÊNCIA — Experiência Relax | Celebração da Lua Cheia — DESFAZER A PUBLICAÇÃO (SOMENTE COM DECISÃO EXPLÍCITA) (GERADO por `pnpm events:edition-launch-sql essencia-lua-cheia`; NÃO EDITAR À MÃO)
--
-- Volta essencia-lua-cheia a rascunho pelo caminho do painel: a página sai do ar. NÃO mexe
-- no interruptor (as outras edições continuam no ar), não apaga nada. Recusa, sem
-- mudar nada, se a sessão não estiver CLOSED ou se houver reserva ou inscrição —
-- aí o procedimento é outro (fechar a sessão pelo painel e decidir caso a caso).
-- Já em rascunho: avisa e não faz nada.

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
    raise exception 'EVENTO_ATOR: esperado 1 administrador ativo, encontrado %', actors;
  end if;
  select * into target from public.experiences where slug = 'essencia-lua-cheia' and kind = 'EVENT' for update;
  if not found then
    raise exception 'EVENTO_DESFAZER_RECUSADO: edição ausente';
  end if;
  if target.status = 'DRAFT' then
    raise notice 'EVENTO_DESFAZER: a edição já está em rascunho; nada a fazer';
    return;
  end if;
  if exists (select 1 from public.sessions s where s.experience_id = target.id and s.status <> 'CLOSED')
     or exists (select 1 from public.reservations r join public.sessions s on s.id = r.session_id where s.experience_id = target.id)
     or exists (select 1 from public.waitlist_entries w join public.sessions s on s.id = w.session_id where s.experience_id = target.id) then
    raise exception 'EVENTO_DESFAZER_RECUSADO: sessão aberta, reserva ou inscrição existente — fechar a sessão pelo painel e tratar caso a caso';
  end if;
  perform public.admin_update_event(actor, target.id, target.title, target.summary, 'DRAFT', target.image_url, target.display_order, target.editorial_content);
  raise notice 'EVENTO_PUBLICACAO_DESFEITA';
end;
$desfazer$;

commit;
