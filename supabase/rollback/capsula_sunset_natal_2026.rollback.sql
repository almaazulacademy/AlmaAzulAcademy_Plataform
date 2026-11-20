-- REMADA SUNSET DO CÁPSULA BAR EM 25/12/2026 (NATAL) — REVERSÃO
--
-- NÃO EXECUTAR sem autorização. Rodar só depois do diagnóstico
-- (supabase/diagnostics/capsula_sunset_natal_2026_preflight.sql) com
-- READY_FOR_HOLIDAY_FORMAT em OK e a decisão de operar no Natal.
--
-- Volta a sessão de 17:00, 90 min, R$ 70 para 17:30, 60 min, R$ 60 (como a agenda
-- de dezembro a criou).
-- Só UPDATE de starts_at, duration_minutes e price_cents dessa única sessão,
-- mais uma linha SESSION_UPDATED em admin_audit_log. Capacidade (12), status,
-- notas e qualquer outra sessão ficam como estão.
--
-- Proteções (qualquer uma falha → nada é gravado):
--   * exatamente uma Sunset do Cápsula em 25/12, travada (for update);
--   * ela está no formato de origem (17:00, 90 min, R$ 70) ou já no de destino
--     (17:30, 60 min, R$ 60) — neste caso nada é feito;
--   * nenhuma linha em tabela alguma aponta para a sessão (reservas de qualquer
--     status, lista de espera, Stand-by, trocas de turma…);
--   * nenhuma outra sessão ativa da base se sobrepõe ao horário de destino.

begin;
set local lock_timeout = '5s';

do $capsula_natal_rollback$
declare
  target record;
  refs integer := 0;
  ref record;
  partial integer;
  overlap integer;
  new_start constant timestamptz := make_timestamptz(2026, 12, 25, 17, 30, 0, 'America/Sao_Paulo');
begin
  select s.*, e.base_id into target
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  join public.bases b on b.id = e.base_id
  where e.slug = 'remada-sunset-concha-acustica' and b.slug = 'concha-acustica'
    and (s.starts_at at time zone 'America/Sao_Paulo')::date = date '2026-12-25'
  for update of s;
  if not found then raise exception 'NATAL_SESSION_NOT_FOUND'; end if;
  if (select count(*) from public.sessions s join public.experiences e on e.id = s.experience_id
      where e.slug = 'remada-sunset-concha-acustica'
        and (s.starts_at at time zone 'America/Sao_Paulo')::date = date '2026-12-25') <> 1 then
    raise exception 'NATAL_SESSION_NOT_UNIQUE';
  end if;

  if target.starts_at = new_start and target.duration_minutes = 60 and target.price_cents = 6000 then
    raise notice 'Sessão de 25/12 já está em 17:30, 60 min, R$ 60: nada a fazer.';
    return;
  end if;
  if not (to_char(target.starts_at at time zone 'America/Sao_Paulo', 'HH24:MI') = '17:00'
          and target.duration_minutes = 90 and target.price_cents = 7000) then
    raise exception using message = 'NATAL_SESSION_UNEXPECTED_FORMAT',
      detail = format('Está em %s, %s min, %s centavos.', to_char(target.starts_at at time zone 'America/Sao_Paulo', 'HH24:MI'),
        target.duration_minutes, target.price_cents);
  end if;

  for ref in
    select c.conrelid::regclass as tbl, a.attname as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.contype = 'f' and c.confrelid = 'public.sessions'::regclass
  loop
    execute format('select count(*) from %s where %I = $1', ref.tbl, ref.col) into partial using target.id;
    refs := refs + partial;
  end loop;
  if refs > 0 then
    raise exception using message = 'NATAL_SESSION_HAS_LINKS', detail = format('%s linha(s) apontam para a sessão.', refs);
  end if;

  select count(*) into overlap
  from public.sessions s join public.experiences e on e.id = s.experience_id
  where e.base_id = target.base_id and s.id <> target.id and s.status::text not in ('CANCELLED', 'ARCHIVED')
    and tstzrange(s.starts_at, s.starts_at + make_interval(mins => coalesce(s.duration_minutes, 90)))
     && tstzrange(new_start, new_start + make_interval(mins => 60));
  if overlap > 0 then raise exception 'NATAL_SESSION_OVERLAP'; end if;

  update public.sessions
  set starts_at = new_start, duration_minutes = 60, price_cents = 6000
  where id = target.id;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (null, 'SESSION_UPDATED', 'SESSION', target.id, jsonb_build_object(
    'source', 'capsula_sunset_natal_2026_rollback',
    'before', jsonb_build_object('starts_at', target.starts_at, 'duration_minutes', target.duration_minutes, 'price_cents', target.price_cents),
    'after', jsonb_build_object('starts_at', new_start, 'duration_minutes', 60, 'price_cents', 6000)));

  raise notice 'Sessão % de 25/12: 17:00, 90 min, R$ 70 → 17:30, 60 min, R$ 60.', target.id;
end;
$capsula_natal_rollback$;

commit;
