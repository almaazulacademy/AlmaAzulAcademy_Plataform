-- CAPACIDADE PADRÃO — QUATRO EXPERIÊNCIAS REGULARES RESTANTES — ATUALIZAÇÃO
--
-- NÃO EXECUTAR sem autorização. Rodar imediatamente depois do preflight
-- (supabase/diagnostics/experiences_default_capacity_restantes_2026_preflight.sql)
-- com READY_TO_UPDATE_REMAINING_DEFAULT_CAPACITY em OK, e conferir com o
-- postcheck (supabase/diagnostics/experiences_default_capacity_restantes_2026_postcheck.sql).
--
-- Só a coluna experiences.default_capacity destas quatro experiências REGULARES:
--   concha-acustica/rota-prainha-do-congresso: 24 → 12
--   concha-acustica/remada-lua-cheia-concha-acustica: 24 → 12
--   concha-acustica/remada-nascer-do-sol-concha-acustica: 24 → 12
--   lago-norte/remada-lua-cheia: 28 → 24
-- Eventos especiais (ESSÊNCIA e ESSÊNCIA Lua Cheia) nunca entram.
--
-- Proteções (qualquer uma falha → nada é gravado):
--   * as quatro existem na base esperada (slug é único) e são REGULAR;
--   * cada uma está com o valor de origem ou já com o de destino — esta não
--     é regravada (idempotente); qualquer outro valor aborta;
--   * na mesma fotografia REPEATABLE READ, ficam idênticas (md5): todas as
--     sessões, todas as reservas, todos os eventos de pagamento, todas as
--     outras experiências (linha inteira) e as demais colunas das quatro.
-- Uma linha EXPERIENCE_UPDATED em admin_audit_log por experiência alterada.

begin isolation level repeatable read;
set local lock_timeout = '5s';

do $remaining_capacity$
declare
  target record;
  changed integer := 0;
  found_total integer;
  sessions_before text;
  sessions_after text;
  reservations_before text;
  reservations_after text;
  payments_before text;
  payments_after text;
  others_before text;
  others_after text;
  targets_before text;
  targets_after text;
begin
  create temporary table remaining_capacity_plan on commit drop as
  select w.experience_slug, w.from_capacity, w.to_capacity, e.id, e.kind::text as kind
  from (values
    ('concha-acustica', 'rota-prainha-do-congresso', 24, 12),
    ('concha-acustica', 'remada-lua-cheia-concha-acustica', 24, 12),
    ('concha-acustica', 'remada-nascer-do-sol-concha-acustica', 24, 12),
    ('lago-norte', 'remada-lua-cheia', 28, 24)
  ) as w(base_slug, experience_slug, from_capacity, to_capacity)
  join public.bases b on b.slug = w.base_slug
  join public.experiences e on e.slug = w.experience_slug and e.base_id = b.id;

  select count(*) into found_total from remaining_capacity_plan;
  if found_total <> 4 then
    raise exception using message = 'REMAINING_CAPACITY_EXPERIENCE_NOT_FOUND', detail = format('%s de 4 encontradas.', found_total);
  end if;
  if exists (select 1 from remaining_capacity_plan where kind <> 'REGULAR') then
    raise exception 'REMAINING_CAPACITY_NOT_REGULAR';
  end if;

  perform 1 from public.experiences e join remaining_capacity_plan p on p.id = e.id for update of e;

  select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) into sessions_before from public.sessions s;
  select md5(coalesce(string_agg(to_jsonb(r)::text, '|' order by r.id), '')) into reservations_before from public.reservations r;
  if to_regclass('public.payment_events') is not null then
    execute $q$select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) from public.payment_events p$q$ into payments_before;
  end if;
  select md5(coalesce(string_agg(to_jsonb(e)::text, '|' order by e.id), '')) into others_before
  from public.experiences e where not exists (select 1 from remaining_capacity_plan p where p.id = e.id);
  select md5(coalesce(string_agg((to_jsonb(e) - 'default_capacity' - 'updated_at')::text, '|' order by e.id), '')) into targets_before
  from public.experiences e where exists (select 1 from remaining_capacity_plan p where p.id = e.id);

  for target in
    select p.*, e.default_capacity from remaining_capacity_plan p join public.experiences e on e.id = p.id order by p.experience_slug
  loop
    if target.default_capacity = target.to_capacity then
      continue;
    end if;
    if target.default_capacity <> target.from_capacity then
      raise exception using message = 'REMAINING_CAPACITY_UNEXPECTED',
        detail = format('%s está com %s (esperado %s ou %s).', target.experience_slug, target.default_capacity, target.from_capacity, target.to_capacity);
    end if;
    update public.experiences set default_capacity = target.to_capacity where id = target.id;
    insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
    values (null, 'EXPERIENCE_UPDATED', 'experience', target.id, jsonb_build_object(
      'source', 'experiences_default_capacity_restantes_2026', 'field', 'default_capacity', 'before', target.from_capacity, 'after', target.to_capacity));
    changed := changed + 1;
  end loop;

  select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) into sessions_after from public.sessions s;
  select md5(coalesce(string_agg(to_jsonb(r)::text, '|' order by r.id), '')) into reservations_after from public.reservations r;
  if to_regclass('public.payment_events') is not null then
    execute $q$select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) from public.payment_events p$q$ into payments_after;
  end if;
  select md5(coalesce(string_agg(to_jsonb(e)::text, '|' order by e.id), '')) into others_after
  from public.experiences e where not exists (select 1 from remaining_capacity_plan p where p.id = e.id);
  select md5(coalesce(string_agg((to_jsonb(e) - 'default_capacity' - 'updated_at')::text, '|' order by e.id), '')) into targets_after
  from public.experiences e where exists (select 1 from remaining_capacity_plan p where p.id = e.id);

  if sessions_after is distinct from sessions_before then raise exception 'REMAINING_CAPACITY_SESSIONS_CHANGED'; end if;
  if reservations_after is distinct from reservations_before or payments_after is distinct from payments_before then
    raise exception 'REMAINING_CAPACITY_RESERVATIONS_OR_PAYMENTS_CHANGED';
  end if;
  if others_after is distinct from others_before then raise exception 'REMAINING_CAPACITY_OTHER_EXPERIENCES_CHANGED'; end if;
  if targets_after is distinct from targets_before then raise exception 'REMAINING_CAPACITY_OTHER_COLUMNS_CHANGED'; end if;

  raise notice 'Capacidade padrão (restantes): % experiência(s) alterada(s).', changed;
end;
$remaining_capacity$;

commit;
