-- BASE LAGO NORTE — ENDEREÇO COMPLETO E LINK OFICIAL DO GOOGLE MAPS — REVERSÃO
--
-- Desfaz supabase/maintenance/lago_norte_localizacao_2026_11.sql: volta o
-- endereço para 'QL 5 Conjunto 5 - Lago Norte' e o link para nulo (o e-mail
-- volta a sair sem o botão "Como chegar"). Só age se a base estiver exatamente
-- com os valores gravados por aquele script, ou já revertida (idempotente).

begin;
set local lock_timeout = '5s';

do $lago_norte_localizacao_rollback$
declare
  source_name constant text := 'lago_norte_localizacao_2026_11.rollback';
  address_from constant text := 'QL 5 Conjunto 5 - Lago Norte';
  address_to constant text := 'SHIN QL 5, Conjunto 5, Casa 19 — Lago Norte, Brasília-DF';
  maps_to constant text := 'https://maps.app.goo.gl/KQUaHE4LGmg8h3q17';
  lago public.bases%rowtype;
begin
  select * into lago from public.bases where slug = 'lago-norte' for update;
  if not found then
    raise exception 'LAGO_NORTE_BASE_NOT_FOUND';
  end if;

  if lago.address = address_from and lago.maps_url is null then
    raise notice 'Lago Norte: já está com os valores anteriores; nada mudou.';
    return;
  end if;
  if lago.address is distinct from address_to or lago.maps_url is distinct from maps_to then
    raise exception 'LAGO_NORTE_ROLLBACK_UNEXPECTED_STATE'
      using detail = format('Endereço: %s; link: %s', coalesce(lago.address, '(nulo)'), coalesce(lago.maps_url, '(nulo)'));
  end if;

  update public.bases set address = address_from, maps_url = null where id = lago.id;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (null, 'BASE_UPDATED', 'base', lago.id,
          jsonb_build_object('source', source_name, 'fields', jsonb_build_array('address', 'maps_url')));

  raise notice 'Lago Norte: endereço e link revertidos.';
end;
$lago_norte_localizacao_rollback$;

commit;
