import { readFileSync, writeFileSync } from "node:fs";

import { ESSENCIA_LUA_CHEIA_EDITION as edition, ESSENCIA_LUA_CHEIA_EDITORIAL as editorial } from "../../lib/events/fixtures/essencia-lua-cheia.ts";
import { COMMON_COUNTS, EDITION_ADMIN_EMAIL, SECURITY_APPLIED, editionFileStem, literal, otherEventsFingerprint } from "./edition-cadastro-sql.ts";

const previousTitle = "ESSÊNCIA — Experiência Relax | Celebração da Lua Cheia";
const previousBadge = "Celebração da Lua Cheia · Especial de Confraternização de Fim de Ano";
// Conteúdo publicado a partir do PR #70. O snapshot também mantém os SQLs
// históricos do rascunho reproduzíveis após as correções na edição publicada.
const publishedEditorial = JSON.parse(readFileSync(new URL("./essencia-lua-cheia-editorial-2b386d8.json", import.meta.url), "utf8")) as typeof editorial;
const publishedTitle = publishedEditorial.seo.title;
const previousEditorial = {
  ...publishedEditorial,
  hero: { ...publishedEditorial.hero, eyebrow: previousBadge, title: "ESSÊNCIA" },
  seo: { ...publishedEditorial.seo, title: previousTitle },
  event: { ...publishedEditorial.event, badge: previousBadge, subtitle: "Experiência Relax" },
};

const stem = editionFileStem(edition.slug);
const slug = literal(edition.slug);
const actor = `from public.admin_users au join auth.users u on u.id = au.user_id
    where lower(u.email) = ${literal(EDITION_ADMIN_EMAIL)} and au.is_active and au.role = 'ADMIN'`;
const fingerprints = otherEventsFingerprint(edition.slug);
const approvedSession = `s.status = 'CLOSED' and s.starts_at = ${literal(edition.startsAt)}::timestamptz
    and s.duration_minutes = ${edition.durationMinutes} and s.price_cents = ${edition.priceCents} and s.capacity = ${edition.capacity}`;

function json(value: unknown) {
  const content = JSON.stringify(value);
  if (content.includes("$json$") || content.includes("$editorial$")) throw new Error("Delimitador SQL no editorial.");
  return `$json$${content}$json$::jsonb`;
}

function noBookings(sessionId: string, experienceId: string) {
  return `not exists (select 1 from public.reservations where session_id = ${sessionId} or experience_id = ${experienceId})
    and not exists (select 1 from public.waitlist_entries where session_id = ${sessionId})`;
}

const hidden = `not exists (select 1 from public.list_public_events() where slug = ${slug})
    and not exists (select 1 from public.get_public_event(${slug}))
    and not exists (select 1 from public.list_public_event_sessions(${slug}))`;

const publicPageWithSalesClosed = `(select count(*) from public.get_public_event(${slug})) = 1
    and not exists (select 1 from public.list_public_event_sessions(${slug}) where availability = 'AVAILABLE')`;

function diagnostics(after: boolean, published = false) {
  const originalTitle = published ? publishedTitle : previousTitle;
  const title = after ? publishedTitle : originalTitle;
  const before = published ? publishedEditorial : previousEditorial;
  const revised = published ? editorial : publishedEditorial;
  const content = after ? revised : before;
  const status = published ? "PUBLISHED" : "DRAFT";
  const expectedState = published ? "status = 'PUBLISHED'" : "status = 'DRAFT' and coalesce(to_jsonb(ev) ->> 'active', 'false') = 'false'";
  const phase = after ? "POSTCHECK" : "PREFLIGHT";
  return `-- ESSÊNCIA 2ª edição | ${phase} da correção editorial (somente leitura).
-- Compare IDs, sessão e indicadores antes e depois. Requer 0 falhas.
with ev as (
  select * from public.experiences where slug = ${slug} and kind = 'EVENT'
), sess as (
  select s.* from public.sessions s join ev on ev.id = s.experience_id
), checks as (
  select '${published ? "PUBLICADO_E_CONTEUDO" : "RASCUNHO_E_CONTEUDO"}' as check_name,
         coalesce((select id::text || ' ' || status || ' ' || title from ev), 'ausente') as result,
         case when (select ${expectedState}
           and title = ${literal(title)} and editorial_content = ${json(content)}
           and public.experience_editorial_is_publishable(editorial_content)
           and exists (select 1 from public.bases b where b.id = ev.base_id and b.slug = ${literal(edition.baseSlug)} and b.status = 'ACTIVE') from ev)
           then 'OK' else 'FALHOU' end as status
  union all
  select 'SESSAO_FECHADA',
         coalesce((select s.id::text || ' ' || s.status || ' ' || to_char(s.starts_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
           || ' ' || s.duration_minutes || 'min ' || s.price_cents || ' centavos ' || s.capacity || ' vagas' from sess s limit 1), 'ausente'),
         case when (select count(*) from sess) = 1 and exists (select 1 from sess s where ${approvedSession})
           then 'OK' else 'FALHOU' end
  union all
  select 'SEM_RESERVAS_OU_INSCRICOES',
         (select count(*)::text from public.reservations where experience_id in (select id from ev) or session_id in (select id from sess))
           || ' reserva(s); ' || (select count(*)::text from public.waitlist_entries where session_id in (select id from sess)) || ' inscrição(ões)',
         case when (select ${noBookings("s.id", "s.experience_id")} from sess s limit 1) then 'OK' else 'FALHOU' end
  union all
  select '${published ? "PAGINA_PUBLICA_SEM_CHECKOUT" : "RASCUNHO_OCULTO_E_SEM_CHECKOUT"}', 'leituras públicas e checkout',
         case when ${published ? publicPageWithSalesClosed : hidden}
           and not exists (select 1 from sess s, lateral public.get_booking_session(s.id)) then 'OK' else 'FALHOU' end
  union all
  select 'SEGURANCA_DOS_EVENTOS', 'políticas e gatilhos de publicação',
         case when ${SECURITY_APPLIED} then 'OK' else 'FALHOU' end
  union all
  select 'ATOR_ADMINISTRADOR', (select count(*)::text ${actor}),
         case when (select count(*) ${actor}) = 1 then 'OK' else 'FALHOU' end
${after ? `  union all
  select 'AUDITORIA', 'EVENT_UPDATED em ${status} com o novo título',
         case when exists (select 1 from public.admin_audit_log a join ev on a.entity_id = ev.id
           where a.action = 'EVENT_UPDATED' and a.metadata ->> 'title' = ${literal(title)}
             and a.metadata ->> 'status' = '${status}' and a.metadata ->> 'previousStatus' = '${status}') then 'OK' else 'FALHOU' end
` : ""}  union all
  select 'OUTROS_EVENTOS', ${fingerprints}, 'OK'
${COMMON_COUNTS}
)
select check_name, result, status from checks
union all
select 'EVENTO_EDITORIAL_${published ? "PUBLICADO_" : ""}${phase}_OK',
       count(*) filter (where status = 'FALHOU') || ' falha(s)',
       case when bool_and(status = 'OK') then 'OK' else 'FALHOU' end
from checks;
`;
}

function change(rollback: boolean, published = false) {
  const status = published ? "PUBLISHED" : "DRAFT";
  const expectedState = published ? "target.status <> 'PUBLISHED'" : "target.status <> 'DRAFT' or coalesce(to_jsonb(target) ->> 'active', 'false') <> 'false'";
  const originalTitle = published ? publishedTitle : previousTitle;
  const [fromTitle, toTitle] = rollback ? [publishedTitle, originalTitle] : [originalTitle, publishedTitle];
  const [before, after] = published ? [publishedEditorial, editorial] : [previousEditorial, publishedEditorial];
  const [fromContent, toContent] = rollback ? [after, before] : [before, after];
  return `-- ESSÊNCIA 2ª edição | ${rollback ? "reversão" : "atualização"} editorial do ${published ? "evento publicado" : "rascunho"} com autorização específica.
begin;
set local lock_timeout = '5s';

do $editorial$
declare
  actor_id uuid;
  actors integer;
  target public.experiences%rowtype;
  session_before public.sessions%rowtype;
  event_after public.experiences%rowtype;
  expected_content constant jsonb := ${json(fromContent)};
  replacement_content constant jsonb := ${json(toContent)};
  other_events_before text;
  regular_catalog_before text;
begin
  select count(*), min(au.user_id::text)::uuid into actors, actor_id ${actor};
  if actors <> 1 then
    raise exception 'EVENTO_EDITORIAL_ATOR: esperado exatamente um administrador ativo';
  end if;
  if not (${SECURITY_APPLIED}) then
    raise exception 'EVENTO_EDITORIAL_SEGURANCA: proteção de evento ausente';
  end if;

  select * into target from public.experiences where slug = ${slug} and kind = 'EVENT' for update;
  if not found or ${expectedState} then
    raise exception 'EVENTO_EDITORIAL_ESTADO: esperado ${published ? "evento publicado" : "rascunho inativo"}';
  end if;
  if target.title is distinct from ${literal(fromTitle)} or target.editorial_content is distinct from expected_content then
    raise exception 'EVENTO_EDITORIAL_ORIGEM: título ou conteúdo divergente';
  end if;
  if not exists (select 1 from public.bases where id = target.base_id and slug = ${literal(edition.baseSlug)} and status = 'ACTIVE') then
    raise exception 'EVENTO_EDITORIAL_BASE: base divergente';
  end if;

  select * into session_before from public.sessions s where s.experience_id = target.id and ${approvedSession} for update;
  if not found or (select count(*) from public.sessions where experience_id = target.id) <> 1 then
    raise exception 'EVENTO_EDITORIAL_SESSAO: esperada uma sessão CLOSED com os parâmetros aprovados';
  end if;
  if not (${noBookings("session_before.id", "target.id")}) then
    raise exception 'EVENTO_EDITORIAL_RESERVAS: existem reservas ou inscrições';
  end if;

${published ? `  if not (${publicPageWithSalesClosed}) or exists (select 1 from public.get_booking_session(session_before.id)) then
    raise exception 'EVENTO_EDITORIAL_VISIBILIDADE: esperada página pública e checkout bloqueado';
  end if;

` : ""}  select ${fingerprints} into other_events_before;
  select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) into regular_catalog_before from public.list_public_regular_catalog() x;

  perform public.admin_update_event(actor_id, target.id, ${literal(toTitle)}, target.summary, '${status}',
    target.image_url, target.display_order, replacement_content);

  select * into event_after from public.experiences where id = target.id;
  if event_after.title is distinct from ${literal(toTitle)} or event_after.editorial_content is distinct from replacement_content
     or not public.experience_editorial_is_publishable(event_after.editorial_content)
     or (to_jsonb(event_after) - array['title', 'editorial_content', 'updated_at'])
        is distinct from (to_jsonb(target) - array['title', 'editorial_content', 'updated_at']) then
    raise exception 'EVENTO_EDITORIAL_RESULTADO: alteração fora dos campos de identidade';
  end if;
  if (select to_jsonb(s) from public.sessions s where s.id = session_before.id) is distinct from to_jsonb(session_before)
     or (select count(*) from public.sessions where experience_id = target.id) <> 1 then
    raise exception 'EVENTO_EDITORIAL_SESSAO_ALTERADA';
  end if;
  if not (${published ? publicPageWithSalesClosed : hidden}) or exists (select 1 from public.get_booking_session(session_before.id))
     or not (${noBookings("session_before.id", "target.id")}) then
    raise exception 'EVENTO_EDITORIAL_VISIBILIDADE: ${published ? "página pública" : "rascunho"}, checkout ou inscrições divergentes';
  end if;
  if other_events_before is distinct from ${fingerprints}
     or regular_catalog_before is distinct from (select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.list_public_regular_catalog() x) then
    raise exception 'EVENTO_EDITORIAL_ISOLAMENTO: outro evento ou catálogo mudou';
  end if;

  raise notice 'EVENTO_EDITORIAL_${rollback ? "REVERTIDO" : "ATUALIZADO"} experienceId=% sessionId=%', target.id, session_before.id;
end;
$editorial$;

commit;
`;
}

export const editorialFiles = {
  [`supabase/diagnostics/${stem}_editorial_preflight.sql`]: diagnostics(false),
  [`supabase/maintenance/${stem}_editorial_update.sql`]: change(false),
  [`supabase/diagnostics/${stem}_editorial_postcheck.sql`]: diagnostics(true),
  [`supabase/rollback/${stem}_editorial_update.rollback.sql`]: change(true),
};

export const publishedEditorialFiles = {
  [`supabase/diagnostics/${stem}_editorial_publicado_preflight.sql`]: diagnostics(false, true),
  [`supabase/maintenance/${stem}_editorial_publicado_update.sql`]: change(false, true),
  [`supabase/diagnostics/${stem}_editorial_publicado_postcheck.sql`]: diagnostics(true, true),
  [`supabase/rollback/${stem}_editorial_publicado_update.rollback.sql`]: change(true, true),
};

if (process.argv[1]?.endsWith("essencia-lua-cheia-editorial-sql.ts")) {
  const files = { ...editorialFiles, ...publishedEditorialFiles };
  for (const [path, sql] of Object.entries(files)) writeFileSync(path, sql, "utf8");
  console.info(`Gerados:\n${Object.keys(files).join("\n")}`);
}
