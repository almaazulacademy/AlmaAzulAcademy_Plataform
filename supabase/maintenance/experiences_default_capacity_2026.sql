-- CAPACIDADE PADRÃO DAS EXPERIÊNCIAS REGULARES — ATUALIZAÇÃO
--
-- NÃO EXECUTAR sem autorização. Rodar depois do preflight
-- (supabase/diagnostics/experiences_default_capacity_2026_preflight.sql) com
-- READY_TO_UPDATE_DEFAULT_CAPACITY em OK.
--
-- Só a coluna experiences.default_capacity de cinco experiências REGULARES:
--   lago-norte/imersao-paranoa: 28 → 24
--   lago-norte/remada-nascer-do-sol: 28 → 24
--   lago-norte/remada-sunset: 28 → 24
--   concha-acustica/remada-sunset-concha-acustica: 24 → 12
--   concha-acustica/rota-ermida-ponte-jk: 24 → 12
-- Cada uma precisa estar com o valor de origem ou já com o de destino
-- (idempotente). Aborta se qualquer outra coluna dessas experiências, qualquer
-- outra experiência ou qualquer sessão mudar dentro da transação. Uma linha
-- EXPERIENCE_UPDATED em admin_audit_log por experiência alterada.

begin isolation level repeatable read;
set local lock_timeout = '5s';

do $default_capacity$
declare
  target record;
  changed integer := 0;
  sessions_before text;
  sessions_after text;
  others_before text;
  others_after text;
begin
  select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) into sessions_before from public.sessions s;
  select md5(coalesce(string_agg((to_jsonb(e) - 'default_capacity' - 'updated_at')::text, '|' order by e.id), '')) into others_before from public.experiences e;

  if (select count(*) from public.experiences e join public.bases b on b.id = e.base_id
      where (b.slug, e.slug) in (('lago-norte', 'imersao-paranoa'), ('lago-norte', 'remada-nascer-do-sol'), ('lago-norte', 'remada-sunset'),
                                 ('concha-acustica', 'remada-sunset-concha-acustica'), ('concha-acustica', 'rota-ermida-ponte-jk'))) <> 5 then
    raise exception 'DEFAULT_CAPACITY_EXPERIENCE_NOT_FOUND';
  end if;

  for target in
    select w.experience_slug, w.from_capacity, w.to_capacity, e.id, e.kind::text as kind, e.default_capacity
    from (values
      ('lago-norte', 'imersao-paranoa', 28, 24),
      ('lago-norte', 'remada-nascer-do-sol', 28, 24),
      ('lago-norte', 'remada-sunset', 28, 24),
      ('concha-acustica', 'remada-sunset-concha-acustica', 24, 12),
      ('concha-acustica', 'rota-ermida-ponte-jk', 24, 12)
    ) as w(base_slug, experience_slug, from_capacity, to_capacity)
    join public.bases b on b.slug = w.base_slug
    join public.experiences e on e.slug = w.experience_slug and e.base_id = b.id
    order by w.experience_slug
    for update of e
  loop
    if target.kind <> 'REGULAR' then
      raise exception using message = 'DEFAULT_CAPACITY_NOT_REGULAR', detail = target.experience_slug;
    end if;
    if target.default_capacity = target.to_capacity then
      continue;
    end if;
    if target.default_capacity <> target.from_capacity then
      raise exception using message = 'DEFAULT_CAPACITY_UNEXPECTED',
        detail = format('%s está com %s (esperado %s ou %s).', target.experience_slug, target.default_capacity, target.from_capacity, target.to_capacity);
    end if;
    update public.experiences set default_capacity = target.to_capacity where id = target.id;
    insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
    values (null, 'EXPERIENCE_UPDATED', 'experience', target.id, jsonb_build_object(
      'source', 'experiences_default_capacity_2026', 'field', 'default_capacity', 'before', target.from_capacity, 'after', target.to_capacity));
    changed := changed + 1;
  end loop;

  select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) into sessions_after from public.sessions s;
  select md5(coalesce(string_agg((to_jsonb(e) - 'default_capacity' - 'updated_at')::text, '|' order by e.id), '')) into others_after from public.experiences e;
  if sessions_after is distinct from sessions_before then raise exception 'DEFAULT_CAPACITY_SESSIONS_CHANGED'; end if;
  if others_after is distinct from others_before then raise exception 'DEFAULT_CAPACITY_OTHER_COLUMNS_CHANGED'; end if;

  raise notice 'Capacidade padrão: % experiência(s) alterada(s).', changed;
end;
$default_capacity$;

commit;
