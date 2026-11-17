import { readFileSync, writeFileSync } from "node:fs";

import { ESSENCIA_LUA_CHEIA_EDITION as edition } from "../../lib/events/fixtures/essencia-lua-cheia.ts";
import { EDITION_ADMIN_EMAIL, literal, otherEventsFingerprint, SECURITY_APPLIED } from "./edition-cadastro-sql.ts";
import { openedEditorial } from "./edition-launch-sql.ts";

const original = JSON.parse(readFileSync(new URL("./essencia-lua-cheia-editorial-0deab56.json", import.meta.url), "utf8"));
original.event.reservation.comingSoon = false;

export const scheduleIds = {
  experience: "7755ad49-ca13-40ec-aaf0-234f62db2555",
  session: "70c6a4a4-1fa9-4941-850d-b62b26135c31",
};

const experienceId = literal(scheduleIds.experience);
const sessionId = literal(scheduleIds.session);
const priorStart = "2026-11-23T19:30:00.000Z";
const priorDuration = 210;
const actor = `from public.admin_users au join auth.users u on u.id = au.user_id
  where lower(u.email) = ${literal(EDITION_ADMIN_EMAIL)} and au.is_active and au.role = 'ADMIN'`;
const action = "'ESSENCIA_SCHEDULE_UPDATED'";
const scope = `e.id = ${experienceId} and e.slug = ${literal(edition.slug)} and e.kind = 'EVENT'`;

function json(value: unknown) {
  const content = JSON.stringify(value);
  if (/\$(json|schedule)\$/.test(content)) throw new Error("Delimitador SQL no editorial.");
  return `$json$${content}$json$::jsonb`;
}

function overlaps(startsAt: string, minutes: number, baseId: string) {
  return `select 1 from public.sessions s join public.experiences e on e.id = s.experience_id
    where e.base_id = ${baseId} and s.id <> ${sessionId} and s.status not in ('CANCELLED', 'ARCHIVED')
      and s.starts_at < ${literal(startsAt)}::timestamptz + make_interval(mins => ${minutes})
      and s.starts_at + make_interval(mins => s.duration_minutes) > ${literal(startsAt)}::timestamptz`;
}

function editorialMatches(content: unknown, minutes: number, alias: string) {
  return `${alias}.status = 'PUBLISHED' and ${alias}.title = ${literal(edition.title)}
    and ${alias}.editorial_content = ${json(content)}
    and ${alias}.duration_minutes = ${minutes} and ${alias}.price_cents = ${edition.priceCents}
    and ${alias}.default_capacity = ${edition.capacity}
    and exists (select 1 from public.bases b where b.id = ${alias}.base_id and b.slug = ${literal(edition.baseSlug)} and b.status = 'ACTIVE')`;
}

function sessionMatches(startsAt: string, minutes: number, alias: string) {
  return `${alias}.status = 'OPEN' and ${alias}.starts_at = ${literal(startsAt)}::timestamptz
    and ${alias}.duration_minutes = ${minutes} and ${alias}.price_cents = ${edition.priceCents} and ${alias}.capacity = ${edition.capacity}`;
}

// IDs e estados, sem dados pessoais. Permite verificar o rollback sem apagar
// reservas ou interferir em confirmações ocorridas depois da atualização.
const bookingFingerprint = `(select md5(coalesce(string_agg(concat_ws(':', r.id, r.status, r.quantity), ',' order by r.id), ''))
  from public.reservations r where r.session_id = ${sessionId})`;

function diagnostic(after: boolean) {
  const phase = after ? "POSTCHECK" : "PREFLIGHT";
  const content = after ? openedEditorial(edition) : original;
  const startsAt = after ? edition.startsAt : priorStart;
  const duration = after ? edition.durationMinutes : priorDuration;
  return `-- ESSÊNCIA 2ª edição | ${phase} de programação (somente leitura).
-- Guarde os indicadores agregados. Reservas existentes são esperadas.
begin read only;
with ev as (
  select e.* from public.experiences e where ${scope}
), sess as (
  select s.* from public.sessions s join ev on ev.id = s.experience_id where s.id = ${sessionId}
), reservations as (
  select r.* from public.reservations r where r.session_id = ${sessionId}
), checks as (
  select 'EVENTO_E_EDITORIAL' as check_name,
    coalesce((select id::text || ' ' || status || ' ' || title from ev), 'ausente') as result,
    case when exists (select 1 from ev e where ${editorialMatches(content, duration, "e")}) then 'OK' else 'FALHOU' end as status
  union all
  select 'SESSAO',
    coalesce((select id::text || ' ' || status || ' ' || to_char(starts_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
      || ' · ' || duration_minutes || ' min · ' || price_cents || ' centavos · ' || capacity || ' vagas' from sess), 'ausente'),
    case when exists (select 1 from sess s where ${sessionMatches(startsAt, duration, "s")} and s.starts_at > now()) then 'OK' else 'FALHOU' end
  union all
  select 'AGENDA_DA_BASE', '17h15–20h30',
    case when not exists (${overlaps(edition.startsAt, edition.durationMinutes, "(select base_id from ev)")})
      then 'OK' else 'FALHOU' end
  union all
  select 'PROTECOES_E_PUBLICACAO', 'políticas de eventos e página pública',
    case when (${SECURITY_APPLIED}) and (select count(*) from public.get_public_event(${literal(edition.slug)})) = 1
      then 'OK' else 'FALHOU' end
  union all
  select 'ATOR_ADMINISTRADOR', (select count(*)::text ${actor}),
    case when (select count(*) ${actor}) = 1 then 'OK' else 'FALHOU' end
  union all
  select 'RESERVAS_POR_STATUS', coalesce((
    select string_agg(status || '=' || total || ' (' || spots || ' participantes)', ', ' order by status)
    from (select status::text, count(*) as total, sum(quantity) as spots from reservations group by 1) t
  ), 'nenhuma'), 'INFO'
  union all
  select 'PRE_RESERVAS_E_PAGAMENTO', 'ativas=' || count(*) filter (where status = 'PRE_RESERVED' and expires_at > now())
    || ', vencidas ainda em PRE_RESERVED=' || count(*) filter (where status = 'PRE_RESERVED' and expires_at <= now())
    || ', ativas com checkout=' || count(*) filter (where status = 'PRE_RESERVED' and expires_at > now() and checkout_url is not null)
    || ', sinais de pagamento sem confirmação=' || count(*) filter (where status <> 'CONFIRMED' and exists (
      select 1 from public.payment_events p where p.reservation_id = reservations.id
        and p.event_type in ('PAYMENT_WEBHOOK_RECEIVED', 'PAYMENT_AFTER_EXPIRATION', 'PAYMENT_AFTER_EXPIRATION_NO_CAPACITY')
    )), 'INFO' from reservations
  union all
  select 'PAGAMENTOS_POR_ESTADO', coalesce((
    select string_agg(state || '=' || total, ', ' order by state)
    from (select coalesce(public.reservation_payment_status(id), 'SEM_ESTADO') as state, count(*) as total
          from reservations group by 1) t
  ), 'nenhum'), 'INFO'
  union all
  select 'INSCRICOES_NA_LISTA', count(*)::text, 'INFO' from public.waitlist_entries where session_id = ${sessionId}
  union all
  select 'OUTROS_EVENTOS', ${otherEventsFingerprint(edition.slug)}, 'INFO'
${after ? `  union all
  select 'AUDITORIA', 'programação atualizada',
    case when exists (select 1 from public.admin_audit_log a where a.entity_id = ${sessionId}
      and a.action = ${action} and a.metadata ->> 'direction' = 'update'
      and (a.metadata ->> 'to_starts_at')::timestamptz = ${literal(edition.startsAt)}::timestamptz)
      then 'OK' else 'FALHOU' end
` : ""})
select check_name, result, status from checks
union all
select 'EVENTO_PROGRAMACAO_${phase}_OK', count(*) filter (where status = 'FALHOU') || ' falha(s)',
  case when bool_or(status = 'FALHOU') then 'FALHOU' else 'OK' end from checks;
commit;
`;
}

function change(rollback: boolean) {
  const [fromStart, toStart] = rollback ? [edition.startsAt, priorStart] : [priorStart, edition.startsAt];
  const [fromDuration, toDuration] = rollback ? [edition.durationMinutes, priorDuration] : [priorDuration, edition.durationMinutes];
  const [fromEditorial, toEditorial] = rollback ? [openedEditorial(edition), original] : [original, openedEditorial(edition)];
  return `-- ESSÊNCIA 2ª edição | ${rollback ? "reversão" : "atualização"} de programação com autorização específica.
begin;
set local lock_timeout = '5s';

do $schedule$
declare
  actor_id uuid;
  actors integer;
  target public.experiences%rowtype;
  session_before public.sessions%rowtype;
  event_after public.experiences%rowtype;
  session_after public.sessions%rowtype;
  booked_before text;
  target_editorial constant jsonb := ${json(toEditorial)};
begin
  select count(*), min(au.user_id::text)::uuid into actors, actor_id ${actor};
  if actors <> 1 or not (${SECURITY_APPLIED}) then
    raise exception 'EVENTO_PROGRAMACAO_SEGURANCA: administrador ou proteções divergentes';
  end if;

  -- A pré-reserva também trava a sessão antes de consultar a experiência.
  select * into session_before from public.sessions s where s.id = ${sessionId} and s.experience_id = ${experienceId} for update;
  if not found or (${sessionMatches(fromStart, fromDuration, "session_before")}) is not true then
    raise exception 'EVENTO_PROGRAMACAO_SESSAO: estado, horário ou parâmetros de origem divergentes';
  end if;
  select e.* into target from public.experiences e where ${scope} for update;
  if not found or (${editorialMatches(fromEditorial, fromDuration, "target")}) is not true then
    raise exception 'EVENTO_PROGRAMACAO_ORIGEM: editorial, publicação ou parâmetros divergentes';
  end if;
  if session_before.starts_at <= now() or ${literal(toStart)}::timestamptz <= now()
     or exists (${overlaps(toStart, toDuration, "target.base_id")})
     or (select count(*) from public.get_public_event(${literal(edition.slug)})) <> 1
     or not public.experience_editorial_is_publishable(target_editorial) then
    raise exception 'EVENTO_PROGRAMACAO_AGENDA: destino inválido, sobreposição ou página indisponível';
  end if;

  select ${bookingFingerprint} into booked_before;
${rollback ? `  if booked_before is distinct from (
    select a.metadata ->> 'reservations_fingerprint' from public.admin_audit_log a
    where a.entity_id = session_before.id and a.action = ${action}
      and a.metadata ->> 'direction' = 'update'
    order by a.created_at desc limit 1
  ) then
    raise exception 'EVENTO_PROGRAMACAO_REVERSAO: reservas mudaram desde a atualização';
  end if;
` : ""}
  -- A RPC admin_update_session expira pré-reservas vencidas. Esta operação
  -- escreve apenas os campos do horário e do editorial, com auditoria própria.
  update public.experiences set duration_minutes = ${toDuration}, editorial_content = target_editorial, updated_at = now()
    where id = target.id returning * into event_after;
  update public.sessions set starts_at = ${literal(toStart)}::timestamptz, duration_minutes = ${toDuration}
    where id = session_before.id returning * into session_after;

  if (to_jsonb(event_after) - array['editorial_content', 'duration_minutes', 'updated_at'])
        is distinct from (to_jsonb(target) - array['editorial_content', 'duration_minutes', 'updated_at'])
     or (to_jsonb(session_after) - array['starts_at', 'duration_minutes', 'updated_at'])
        is distinct from (to_jsonb(session_before) - array['starts_at', 'duration_minutes', 'updated_at'])
     or event_after.editorial_content is distinct from target_editorial
     or event_after.duration_minutes is distinct from ${toDuration}
     or (${sessionMatches(toStart, toDuration, "session_after")}) is not true
     or (select count(*) from public.get_public_event(${literal(edition.slug)})) <> 1 then
    raise exception 'EVENTO_PROGRAMACAO_RESULTADO: alteração fora do escopo ou página indisponível';
  end if;

  insert into public.admin_audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  values (actor_id, ${action}, 'SESSION', session_before.id, jsonb_build_object(
    'direction', '${rollback ? "rollback" : "update"}', 'experience_id', target.id,
    'from_starts_at', session_before.starts_at, 'to_starts_at', session_after.starts_at,
    'from_duration_minutes', session_before.duration_minutes, 'to_duration_minutes', session_after.duration_minutes,
    'reservations_fingerprint', booked_before
  ));
  raise notice 'EVENTO_PROGRAMACAO_${rollback ? "REVERTIDA" : "ATUALIZADA"} experienceId=% sessionId=%', target.id, session_before.id;
end;
$schedule$;
commit;
`;
}

const stem = "evento_essencia_lua_cheia_programacao";
export const scheduleFiles = {
  [`supabase/diagnostics/${stem}_preflight.sql`]: diagnostic(false),
  [`supabase/maintenance/${stem}_update.sql`]: change(false),
  [`supabase/diagnostics/${stem}_postcheck.sql`]: diagnostic(true),
  [`supabase/rollback/${stem}_update.rollback.sql`]: change(true),
};

if (process.argv[1]?.endsWith("essencia-lua-cheia-programacao-sql.ts")) {
  for (const [path, sql] of Object.entries(scheduleFiles)) writeFileSync(path, sql, "utf8");
}
