-- REMADA SUNSET DO CÁPSULA BAR EM 25/12/2026 (NATAL) — POSTCHECK (SOMENTE LEITURA)
--
-- Rodar logo depois de supabase/maintenance/capsula_sunset_natal_2026.sql.
-- Um único SELECT. CAPSULA_NATAL_HOLIDAY_FORMAT_OK fica OK quando a sessão de
-- 25/12 está em 17:00–18:30, 90 min, R$ 70, 12 vagas, OPEN, sem vínculos, com
-- a linha de auditoria da troca e sem sobreposição na base.
-- other_sessions_fingerprint deve ser igual ao do preflight: prova que nenhuma
-- outra sessão mudou. reservations_total pode subir se o site vender outra
-- turma entre o preflight e o postcheck; o script já conferiu reservas e
-- pagamentos dentro da própria transação.

with target as (
  select s.*, (s.starts_at at time zone 'America/Sao_Paulo') as local_start, e.base_id
  from public.sessions s
  join public.experiences e on e.id = s.experience_id
  join public.bases b on b.id = e.base_id
  where e.slug = 'remada-sunset-concha-acustica' and b.slug = 'concha-acustica'
    and (s.starts_at at time zone 'America/Sao_Paulo')::date = date '2026-12-25'
),
facts as (
  select
    (select count(*) from target) as target_rows,
    (select string_agg(format('id %s · %s–%s · %s · %s min · %s centavos · %s vagas', t.id, to_char(t.local_start, 'DD/MM HH24:MI'),
              to_char(t.local_start + make_interval(mins => t.duration_minutes), 'HH24:MI'), t.status, t.duration_minutes, t.price_cents, t.capacity), ' | ')
     from target t) as target_info,
    (select count(*) from target t
     where to_char(t.local_start, 'HH24:MI') = '17:00' and t.duration_minutes = 90 and t.price_cents = 7000
       and t.capacity = 12 and t.status::text = 'OPEN') as holiday_format,
    (select public.available_spots(t.id) from target t limit 1) as available_spots,
    (select count(*) from public.reservations r join target t on t.id = r.session_id) as reservations_on_target,
    (select count(*) from public.admin_audit_log a join target t on t.id = a.entity_id
     where a.action = 'SESSION_UPDATED' and a.metadata ->> 'source' = 'capsula_sunset_natal_2026') as audit_rows,
    (select count(*) from public.sessions s join public.experiences e on e.id = s.experience_id join target t on e.base_id = t.base_id
     where s.id <> t.id and s.status::text not in ('CANCELLED', 'ARCHIVED')
       and tstzrange(s.starts_at, s.starts_at + make_interval(mins => coalesce(s.duration_minutes, 90)))
        && tstzrange(t.starts_at, t.starts_at + make_interval(mins => t.duration_minutes))) as overlaps,
    (select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.sessions s
     where not exists (select 1 from target t where t.id = s.id)) as other_sessions_fingerprint,
    (select count(*) from public.sessions) as sessions_total,
    (select count(*) from public.reservations) as reservations_total
)
select checks.check_name, checks.result, checks.status
from (
  select 1 as ord, 'session' as check_name, coalesce(facts.target_info, 'não encontrada') as result,
         case when facts.target_rows = 1 then 'OK' else 'REVIEW_REQUIRED' end as status from facts
  union all select 2, 'holiday_format', case when facts.holiday_format = 1 then '17:00, 90 min, R$ 70, 12 vagas, OPEN' else 'diferente do esperado' end,
         case when facts.holiday_format = 1 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 3, 'available_spots', coalesce(facts.available_spots::text, '-'), 'INFO' from facts
  union all select 4, 'reservations_on_session', facts.reservations_on_target::text, 'INFO: reservas feitas depois da troca' from facts
  union all select 5, 'audit_rows', facts.audit_rows::text, case when facts.audit_rows = 1 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 6, 'overlaps_in_base', facts.overlaps::text, case when facts.overlaps = 0 then 'OK' else 'REVIEW_REQUIRED' end from facts
  union all select 7, 'other_sessions_fingerprint', facts.other_sessions_fingerprint, 'COMPARE_WITH_PREFLIGHT' from facts
  union all select 8, 'sessions_total', facts.sessions_total::text, 'COMPARE_WITH_PREFLIGHT' from facts
  union all select 9, 'reservations_total', facts.reservations_total::text, 'INFO' from facts
  union all select 10, 'CAPSULA_NATAL_HOLIDAY_FORMAT_OK',
         case when facts.target_rows = 1 and facts.holiday_format = 1 and facts.audit_rows = 1 and facts.overlaps = 0
              then 'sessão de 25/12 em 17:00–18:30, 90 min, R$ 70, 12 vagas' else 'conferir as linhas acima' end,
         case when facts.target_rows = 1 and facts.holiday_format = 1 and facts.audit_rows = 1 and facts.overlaps = 0
              then 'OK' else 'REVIEW_REQUIRED' end
  from facts
) checks
order by checks.ord;
