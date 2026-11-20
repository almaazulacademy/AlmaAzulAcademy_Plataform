-- REMADA SUNSET DO CÁPSULA BAR EM 25/12/2026 (NATAL) — DIAGNÓSTICO (SOMENTE LEITURA)
--
-- A agenda de dezembro criou a Sunset do Cápsula de 25/12 pela regra de dia
-- útil: 17:30, 60 min, R$ 60, 12 vagas. Pela regra comercial, feriado é a
-- experiência tradicional: 17:00, 90 min, R$ 70 (como sábados e domingos).
--
-- Um único SELECT, check_name | result | status, sem dado pessoal. Mostra a
-- sessão, tudo o que aponta para ela (reservas por status, pagamentos, cupons,
-- Stand-by, lista de espera e qualquer outra tabela com chave estrangeira para
-- public.sessions) e se o horário das 17:00 está livre na base. A linha final,
-- READY_FOR_HOLIDAY_FORMAT, só fica OK quando a troca segura
-- (supabase/maintenance/capsula_sunset_natal_2026.sql) pode rodar.
--
-- A decisão de operar ou não no Natal é da equipe. Se não houver remada, o
-- caminho é fechar ou cancelar a sessão pelo painel, não este script.

with target as (
  select s.*, (s.starts_at at time zone 'America/Sao_Paulo') as local_start, e.base_id
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  join public.bases b on b.id = e.base_id
  where e.slug = 'remada-sunset-concha-acustica' and b.slug = 'concha-acustica'
    and (s.starts_at at time zone 'America/Sao_Paulo')::date = date '2026-12-25'
),
foreign_refs as (
  -- Toda tabela com chave estrangeira para public.sessions, contando as linhas
  -- que apontam para a sessão (query_to_xml só lê).
  select format('%s.%s', c.conrelid::regclass, a.attname) as ref,
         (xpath('/row/n/text()', query_to_xml(
           format('select count(*) as n from %s where %I = %L', c.conrelid::regclass, a.attname, t.id),
           false, true, '')))[1]::text::integer as total
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
  cross join target t
  where c.contype = 'f' and c.confrelid = 'public.sessions'::regclass
),
facts as (
  select
    (select count(*) from target) as target_rows,
    (select string_agg(format('id %s · %s · %s · %s min · %s centavos · %s vagas · notas: %s', t.id, to_char(t.local_start, 'DD/MM HH24:MI'),
              t.status, t.duration_minutes, t.price_cents, t.capacity, coalesce(t.internal_notes, '-')), ' | ') from target t) as target_info,
    (select string_agg(format('%s: %s pedido(s), %s pessoa(s)', g.status, g.orders, g.people), ', ' order by g.status)
     from (select r.status::text as status, count(*) as orders, coalesce(sum(r.quantity), 0) as people
           from public.reservations r join target t on t.id = r.session_id group by 1) g) as reservations_by_status,
    (select count(*) from public.reservations r join target t on t.id = r.session_id) as reservations_total,
    (select count(*) from public.payment_events p join public.reservations r on r.id = p.reservation_id join target t on t.id = r.session_id) as payment_events,
    (select string_agg(format('%s: %s', f.ref, f.total), ' · ' order by f.ref) from foreign_refs f where f.total > 0) as referencing_rows,
    (select coalesce(sum(f.total), 0) from foreign_refs f) as referencing_total,
    (select count(*) from public.admin_audit_log a join target t on t.id = a.entity_id) as audit_rows,
    (select public.available_spots(t.id) from target t limit 1) as available_spots,
    (select string_agg(format('%s %s %s', e.slug, to_char(s.starts_at at time zone 'America/Sao_Paulo', 'HH24:MI'), s.status), ', ')
     from public.sessions s join public.experiences e on e.id = s.experience_id join target t on e.base_id = t.base_id
     where s.id <> t.id and (s.starts_at at time zone 'America/Sao_Paulo')::date = date '2026-12-25') as other_base_sessions_same_day,
    (select count(*) from public.sessions s join public.experiences e on e.id = s.experience_id join target t on e.base_id = t.base_id
     where s.id <> t.id and s.status::text not in ('CANCELLED', 'ARCHIVED')
       and tstzrange(s.starts_at, s.starts_at + make_interval(mins => coalesce(s.duration_minutes, 90)))
        && tstzrange(make_timestamptz(2026, 12, 25, 17, 0, 0, 'America/Sao_Paulo'), make_timestamptz(2026, 12, 25, 18, 30, 0, 'America/Sao_Paulo'))) as overlap_17_00,
    (select count(*) from target t where to_char(t.local_start, 'HH24:MI') = '17:00' and t.duration_minutes = 90 and t.price_cents = 7000) as already_holiday_format,
    (select count(*) from target t where to_char(t.local_start, 'HH24:MI') = '17:30' and t.duration_minutes = 60 and t.price_cents = 6000) as weekday_format,
    (select md5(to_jsonb(t)::text) from target t limit 1) as session_fingerprint
)
select checks.check_name, checks.result, checks.status
from (
  select 1 as ord, 'session' as check_name, coalesce(facts.target_info, 'não encontrada') as result,
         case when facts.target_rows = 1 then 'OK' else 'REVIEW_REQUIRED' end as status from facts
  union all select 2, 'reservations_by_status', coalesce(facts.reservations_by_status, 'nenhuma'),
         case when facts.reservations_total = 0 then 'OK' else 'REVIEW_REQUIRED: há reservas' end from facts
  union all select 3, 'payment_events', facts.payment_events::text, case when facts.payment_events = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 4, 'referencing_rows', coalesce(facts.referencing_rows, 'nenhuma linha aponta para a sessão'),
         case when facts.referencing_total = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 5, 'available_spots', coalesce(facts.available_spots::text, '-'), 'INFO' from facts
  union all select 6, 'audit_rows', facts.audit_rows::text, 'INFO' from facts
  union all select 7, 'other_base_sessions_same_day', coalesce(facts.other_base_sessions_same_day, 'nenhuma'), 'INFO' from facts
  union all select 8, 'overlap_17_00_18_30', facts.overlap_17_00::text, case when facts.overlap_17_00 = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 9, 'session_fingerprint', coalesce(facts.session_fingerprint, '-'), 'INFO: comparar antes da troca' from facts
  union all select 10, 'READY_FOR_HOLIDAY_FORMAT',
         case
           when facts.target_rows <> 1 then 'sessão de 25/12 não encontrada ou duplicada'
           when facts.already_holiday_format = 1 then 'já está em 17:00, 90 min, R$ 70: nada a fazer'
           when facts.weekday_format <> 1 then 'formato atual diferente de 17:30, 60 min, R$ 60: o script recusa; conferir à mão'
           when facts.referencing_total > 0 or facts.reservations_total > 0 then 'há reservas ou vínculos: não trocar sem decisão caso a caso'
           when facts.overlap_17_00 > 0 then 'outra sessão da base ocupa 17:00–18:30'
           else 'sem reservas nem vínculos: a troca para 17:00, 90 min, R$ 70 pode ser feita'
         end,
         case when facts.target_rows = 1 and facts.referencing_total = 0 and facts.reservations_total = 0 and facts.overlap_17_00 = 0
                   and (facts.weekday_format = 1 or facts.already_holiday_format = 1)
              then 'OK' else 'REVIEW_REQUIRED' end
  from facts
) checks
order by checks.ord;
