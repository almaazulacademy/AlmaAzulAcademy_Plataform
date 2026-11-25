-- BASE LAGO NORTE — ENDEREÇO COMPLETO E LINK OFICIAL DO GOOGLE MAPS — ATUALIZAÇÃO
--
-- Dados enviados pela equipe e aprovados em 25/11/2026:
--   endereço: SHIN QL 5, Conjunto 5, Casa 19 — Lago Norte, Brasília-DF
--   mapa:     https://maps.app.goo.gl/KQUaHE4LGmg8h3q17
--             (resolve para "19 - St. de Habitações Individuais Norte QL 5",
--             Brasília - DF, 70297-400)
--
-- Alvo: a linha slug = 'lago-norte' de public.bases, colunas address e
-- maps_url. É de lá que saem o e-mail de confirmação, o lembrete do QR, o
-- e-mail de reagendamento, o ingresso de check-in e a página da base: com o
-- link preenchido, o botão "Como chegar — Google Maps" aparece sozinho.
-- meeting_point continua nulo (o e-mail usa "Portão de entrada da Alma Azul
-- Academy"). Nada mais muda: status, textos, experiências, sessões, reservas
-- e pagamentos não são tocados. Vale só para o que for lido/enviado depois;
-- nenhum e-mail já enviado é reenviado.
--
-- Transação única com a linha travada (for update). O endereço precisa estar
-- com o valor de origem esperado ou já com o novo, e o link nulo ou já com o
-- novo (idempotente: rodar de novo não muda nada). Qualquer outro valor aborta
-- e desfaz tudo. Confere que as demais colunas ficaram idênticas e grava uma
-- linha BASE_UPDATED em admin_audit_log.
--
-- Ordem: preflight (supabase/diagnostics/lago_norte_localizacao_2026_11_preflight.sql),
-- este script, postcheck (..._postcheck.sql). Reversão:
-- supabase/rollback/lago_norte_localizacao_2026_11.rollback.sql.

begin;
set local lock_timeout = '5s';

do $lago_norte_localizacao$
declare
  source_name constant text := 'lago_norte_localizacao_2026_11';
  address_from constant text := 'QL 5 Conjunto 5 - Lago Norte';
  address_to constant text := 'SHIN QL 5, Conjunto 5, Casa 19 — Lago Norte, Brasília-DF';
  maps_to constant text := 'https://maps.app.goo.gl/KQUaHE4LGmg8h3q17';
  lago public.bases%rowtype;
  others_before text;
  others_after text;
begin
  select * into lago from public.bases where slug = 'lago-norte' for update;
  if not found then
    raise exception 'LAGO_NORTE_BASE_NOT_FOUND';
  end if;

  if lago.address = address_to and lago.maps_url = maps_to then
    raise notice 'Lago Norte: endereço e link já aplicados; nada mudou.';
    return;
  end if;
  if lago.address is distinct from address_from and lago.address is distinct from address_to then
    raise exception 'LAGO_NORTE_ADDRESS_UNEXPECTED'
      using detail = format('Endereço atual: %s', coalesce(lago.address, '(nulo)'));
  end if;
  if lago.maps_url is not null and lago.maps_url is distinct from maps_to then
    raise exception 'LAGO_NORTE_MAPS_URL_UNEXPECTED'
      using detail = format('Link atual: %s', lago.maps_url);
  end if;

  others_before := md5((to_jsonb(lago) - 'address' - 'maps_url' - 'updated_at')::text);

  update public.bases
     set address = address_to,
         maps_url = maps_to
   where id = lago.id;

  select md5((to_jsonb(b) - 'address' - 'maps_url' - 'updated_at')::text)
    into others_after
    from public.bases b
   where b.id = lago.id;
  if others_after is distinct from others_before then
    raise exception 'LAGO_NORTE_OTHER_COLUMNS_CHANGED';
  end if;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (null, 'BASE_UPDATED', 'base', lago.id,
          jsonb_build_object('source', source_name, 'fields', jsonb_build_array('address', 'maps_url'),
                             'addressFrom', lago.address, 'mapsUrlFrom', lago.maps_url));

  raise notice 'Lago Norte: endereço e link oficial do Google Maps gravados.';
end;
$lago_norte_localizacao$;

commit;
