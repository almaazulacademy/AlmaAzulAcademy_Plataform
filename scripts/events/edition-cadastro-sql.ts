/**
 * Scripts de cadastro de uma edição nova de evento especial, gerados da
 * edição registrada em `lib/events/editions.ts`. Nada é digitado à mão.
 *
 *   pnpm events:edition-sql <slug>
 *
 * Gera, para a edição pedida:
 *
 *   supabase/diagnostics/evento_<slug>_cadastro_preflight.sql   (só leitura)
 *   supabase/maintenance/evento_<slug>_cadastro.sql             (cadastro, numa transação)
 *   supabase/diagnostics/evento_<slug>_cadastro_postcheck.sql   (só leitura)
 *   supabase/rollback/evento_<slug>_cadastro.rollback.sql       (desfazer, só em rascunho)
 *
 * Não fala com o banco. O SQL gerado é executado à mão, no SQL Editor, só com
 * autorização. Os scripts do ESSÊNCIA de 07/11/2026 (`essencia-cadastro-sql.ts`)
 * ficam como estão: são o histórico da 1ª edição.
 *
 * O interruptor de publicação. O roteiro da 1ª edição exigia o interruptor
 * desligado: naquele momento era a única garantia de que nada do evento
 * ficaria público durante o cadastro (o gatilho `experiences_kind_guard` só
 * deixa publicar com ele ligado). Com a 1ª edição no ar, o interruptor fica
 * ligado — e a garantia passa a vir de outro lugar, conferido aqui:
 *
 *   - a migration `202610310004` precisa estar aplicada: políticas restritivas
 *     que escondem da chave pública evento fora de "publicado", leituras
 *     públicas que só devolvem evento publicado e gatilhos que recusam reserva
 *     e inscrição em evento oculto;
 *   - a edição nasce em RASCUNHO, com a sessão FECHADA e `active = false`;
 *   - o conteúdo sai com `event.reservation.comingSoon = true`: mesmo depois de
 *     publicada, a edição diz "Reservas abrem em breve" e o servidor recusa
 *     reserva até a abertura explícita;
 *   - dentro da transação, depois de criar, nenhuma leitura pública
 *     (`list_public_events`, `get_public_event`, `list_public_event_sessions`)
 *     devolve a edição. Qualquer conferência que falhe desfaz tudo.
 *
 * Sem duplicidade: slug livre e nenhuma sessão de evento na mesma base com o
 * mesmo início. As outras edições não mudam: o preflight e o postcheck guardam
 * uma impressão delas (`OUTROS_EVENTOS`), que precisa sair igual.
 */

import { writeFileSync } from "node:fs";

import { validateEventEditorial } from "../../lib/events/editorial.ts";
import { editionErrors, type EventEdition } from "../../lib/events/edition.ts";
import { getEventEdition } from "../../lib/events/editions.ts";

export const EDITION_ADMIN_EMAIL = "almaazulacademy@gmail.com";

/** md5 do corpo de `experiences_fill_legacy_columns` com a regra do `active` (migration 202610310003). */
const LEGACY_ACTIVE_RULE_MD5 = "4ee78d0a6fcbc88ca58c7c22875152f5";

function literal(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Recusa antes de gerar qualquer SQL: edição já cadastrada, inválida ou sem o "em breve". */
export function editionCadastroErrors(edition: EventEdition): string[] {
  const errors = editionErrors(edition);
  if (edition.registered) errors.unshift(`${edition.slug} já está cadastrada em produção: os scripts dela são os históricos.`);
  const editorial = validateEventEditorial(edition.editorial);
  if (editorial.success && !editorial.data.event.reservation.comingSoon) {
    errors.push("O cadastro exige event.reservation.comingSoon = true: a venda da edição só abre num passo explícito.");
  }
  return errors;
}

function assertReady(edition: EventEdition) {
  const errors = editionCadastroErrors(edition);
  if (errors.length) throw new Error(`Edição ${edition.slug} não pode gerar o cadastro: ${errors.join("; ")}`);
}

/** Nome dos arquivos: `evento_<slug com _>`. */
export function editionFileStem(slug: string) {
  return `evento_${slug.replace(/-/g, "_")}`;
}

export function editionCadastroPaths(slug: string) {
  const stem = editionFileStem(slug);
  return {
    preflight: `supabase/diagnostics/${stem}_cadastro_preflight.sql`,
    cadastro: `supabase/maintenance/${stem}_cadastro.sql`,
    postcheck: `supabase/diagnostics/${stem}_cadastro_postcheck.sql`,
    rollback: `supabase/rollback/${stem}_cadastro.rollback.sql`,
  };
}

function cardImage(edition: EventEdition) {
  const editorial = validateEventEditorial(edition.editorial);
  if (!editorial.success) throw new Error(editorial.errors.join("; "));
  return (editorial.data.event.cardImage ?? editorial.data.hero.image).src;
}

// --- Conferências comuns ----------------------------------------------------

/** A migration 202610310004 (segurança das leituras e da reserva de evento) está aplicada? */
const SECURITY_APPLIED = `exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'experiences' and policyname = 'events hidden until published')
     and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sessions' and policyname = 'event sessions hidden until published')
     and exists (select 1 from pg_trigger where tgrelid = 'public.reservations'::regclass and tgname = 'reservations_event_publication_guard')
     and exists (select 1 from pg_trigger where tgrelid = 'public.waitlist_entries'::regclass and tgname = 'waitlist_entries_event_publication_guard')
     and exists (select 1 from pg_proc where proname = 'event_publication_allows' and pronamespace = 'public'::regnamespace)`;

/** Impressão das outras edições: status, conteúdo e sessões. Precisa sair igual no postcheck. */
function otherEventsFingerprint(slug: string) {
  return `(select coalesce(count(*)::text || ' evento(s) [' || string_agg(e.slug || '=' || e.status, ', ' order by e.slug) || '] ' || md5(string_agg(e.id::text || e.status || e.editorial_content::text || coalesce((
            select string_agg(s.id::text || s.status::text || s.starts_at::text || s.capacity || s.price_cents || s.duration_minutes, ',' order by s.id)
            from public.sessions s where s.experience_id = e.id), ''), '|' order by e.id)), 'nenhum outro evento')
          from public.experiences e where e.kind = 'EVENT' and e.slug <> ${literal(slug)})`;
}

/** Sessão de evento na mesma base com o mesmo início (exceto arquivadas e as da própria edição). */
function duplicateSessionCount(edition: EventEdition) {
  return `(select count(*) from public.sessions s join public.experiences e on e.id = s.experience_id join public.bases b on b.id = e.base_id
          where e.kind = 'EVENT' and e.slug <> ${literal(edition.slug)} and b.slug = ${literal(edition.baseSlug)}
            and s.starts_at = ${literal(edition.startsAt)}::timestamptz and s.status <> 'ARCHIVED')`;
}

const CHECK_TAIL = (name: string) => `select check_name, result, status from checks
union all
select '${name}',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
`;

const COMMON_COUNTS = `  union all
  select 'LISTAGENS_REGULARES',
         (select count(*)::text from public.list_public_regular_experiences()) || ' experiências, ' || (select count(*)::text from public.list_public_regular_catalog()) || ' no catálogo',
         'OK'
  union all
  select 'RESERVAS_POR_STATUS',
         (select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.reservations group by 1) x),
         'OK'
  union all
  select 'INSCRICOES_DA_LISTA_POR_STATUS',
         coalesce((select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.waitlist_entries group by 1) x), 'nenhuma'),
         'OK'
`;

// --- Cadastro ---------------------------------------------------------------

export function editionCadastroSql(edition: EventEdition) {
  assertReady(edition);
  const json = JSON.stringify(edition.editorial);
  const slug = literal(edition.slug);
  const paths = editionCadastroPaths(edition.slug);
  return `-- ${edition.title} — CADASTRO EM ESTADO FECHADO (GERADO; NÃO EDITAR À MÃO)
--
-- Gerado por \`pnpm events:edition-sql ${edition.slug}\` a partir de lib/events/editions.ts.
-- Rodar no SQL Editor SÓ COM AUTORIZAÇÃO, depois de ${paths.preflight}
-- (EVENTO_CADASTRO_PREFLIGHT_OK | OK). Depois, ${paths.postcheck}.
--
-- Cria, por \`admin_create_event\` (o caminho do painel, com as mesmas validações
-- e auditoria): a experiência ${edition.slug} como EVENT em RASCUNHO e a sessão de
-- ${edition.startsAt}, ${edition.durationMinutes} min, ${edition.priceCents} centavos, ${edition.capacity} vagas,
-- FECHADA para reservas, com o conteúdo em "Reservas abrem em breve". Não publica,
-- não mexe no interruptor, não abre a sessão, não toca reserva, lista de espera
-- nem as outras edições. Tudo numa transação: qualquer conferência que falhe
-- desfaz o cadastro inteiro.
--
-- Ator: o administrador ativo (role ADMIN) do e-mail ${EDITION_ADMIN_EMAIL}, lido de
-- admin_users + auth.users — exatamente um, ou para. Base: ${edition.baseSlug}, lida por slug.

begin;
set local lock_timeout = '5s';

do $cadastro$
declare
  actor uuid;
  actors integer;
  target_base uuid;
  created jsonb;
begin
  select count(*) into actors
  from public.admin_users au join auth.users u on u.id = au.user_id
  where lower(u.email) = ${literal(EDITION_ADMIN_EMAIL)} and au.is_active and au.role = 'ADMIN';
  if actors <> 1 then
    raise exception 'EVENTO_ATOR: esperado 1 administrador ativo, encontrado %', actors;
  end if;
  select au.user_id into actor
  from public.admin_users au join auth.users u on u.id = au.user_id
  where lower(u.email) = ${literal(EDITION_ADMIN_EMAIL)} and au.is_active and au.role = 'ADMIN';

  select id into target_base from public.bases where slug = ${literal(edition.baseSlug)} and status = 'ACTIVE';
  if target_base is null then
    raise exception 'EVENTO_BASE: base ${edition.baseSlug} ausente ou inativa';
  end if;
  if exists (select 1 from public.experiences where slug = ${slug}) then
    raise exception 'EVENTO_JA_EXISTE: já existe experiência com o slug ${edition.slug}';
  end if;
  if ${duplicateSessionCount(edition)} > 0 then
    raise exception 'EVENTO_SESSAO_DUPLICADA: já existe sessão de evento nesta base com o mesmo início';
  end if;
  -- Com o interruptor ligado (a 1ª edição no ar), quem esconde o rascunho são as
  -- políticas e as leituras da 202610310004. Sem ela, não cadastra.
  if not (${SECURITY_APPLIED}) then
    raise exception 'EVENTO_SEGURANCA: aplique antes a migration 202610310004 (segurança dos eventos)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'experiences' and column_name = 'eyebrow')
     and not exists (select 1 from pg_trigger where tgrelid = 'public.experiences'::regclass and tgname = 'experiences_fill_legacy_columns') then
    raise exception 'EVENTO_LEGADO: aplique antes a migration 202610310002 (colunas legadas de experiences)';
  end if;

  created := public.admin_create_event(
    actor,
    target_base,
    ${slug},
    ${literal(edition.title)},
    ${literal(edition.summary)},
    $json$${json}$json$::jsonb,
    ${literal(cardImage(edition))},
    ${literal(edition.startsAt)}::timestamptz,
    ${edition.durationMinutes},
    ${edition.priceCents},
    ${edition.capacity}
  );

  -- Conferências dentro da transação: falhou, nada fica.
  if (select status from public.experiences where id = (created ->> 'experienceId')::uuid) <> 'DRAFT'
     or (select kind from public.experiences where id = (created ->> 'experienceId')::uuid) <> 'EVENT'
     or (select status from public.sessions where id = (created ->> 'sessionId')::uuid) <> 'CLOSED' then
    raise exception 'EVENTO_ESTADO: a edição precisa nascer em rascunho e com a sessão fechada';
  end if;
  if not public.experience_editorial_is_publishable((select editorial_content from public.experiences where id = (created ->> 'experienceId')::uuid)) then
    raise exception 'EVENTO_CONTEUDO: conteúdo editorial não passa na régua de publicação';
  end if;
  if (select editorial_content #>> '{event,reservation,comingSoon}' from public.experiences where id = (created ->> 'experienceId')::uuid) is distinct from 'true' then
    raise exception 'EVENTO_EM_BREVE: o conteúdo precisa nascer com event.reservation.comingSoon = true';
  end if;
  if (select to_jsonb(e) ->> 'active' from public.experiences e where e.id = (created ->> 'experienceId')::uuid) = 'true' then
    raise exception 'EVENTO_ATIVO: o rascunho não pode nascer com active = true (aplique a migration 202610310003)';
  end if;
  if exists (select 1 from public.list_public_events() where slug = ${slug})
     or exists (select 1 from public.get_public_event(${slug}))
     or exists (select 1 from public.list_public_event_sessions(${slug})) then
    raise exception 'EVENTO_PUBLICO: o rascunho apareceu numa leitura pública';
  end if;

  raise notice 'EVENTO_CRIADO experienceId=% sessionId=%', created ->> 'experienceId', created ->> 'sessionId';
end;
$cadastro$;

commit;
`;
}

// --- Preflight --------------------------------------------------------------

/** Só leitura, antes do cadastro. */
export function editionPreflightSql(edition: EventEdition) {
  assertReady(edition);
  const email = literal(EDITION_ADMIN_EMAIL);
  const slug = literal(edition.slug);
  const paths = editionCadastroPaths(edition.slug);
  return `-- ${edition.title} — PREFLIGHT DO CADASTRO (SOMENTE LEITURA; GERADO, NÃO EDITAR À MÃO)
--
-- Rodar no SQL Editor ANTES de ${paths.cadastro}.
-- A última linha, EVENTO_CADASTRO_PREFLIGHT_OK, precisa estar OK. Guarde
-- OUTROS_EVENTOS, LISTAGENS_REGULARES, RESERVAS_POR_STATUS e INSCRICOES_DA_LISTA_POR_STATUS.

with checks as (
  select 'ATOR_ADMINISTRADOR' as check_name,
         (select count(*)::text from public.admin_users au join auth.users u on u.id = au.user_id
          where lower(u.email) = ${email} and au.is_active and au.role = 'ADMIN') || ' administrador(es) ativo(s) com o e-mail da equipe' as result,
         case when (select count(*) from public.admin_users au join auth.users u on u.id = au.user_id
                    where lower(u.email) = ${email} and au.is_active and au.role = 'ADMIN') = 1 then 'OK' else 'FALHOU' end as status
  union all
  select 'BASE_ATIVA',
         coalesce((select slug || '=' || status from public.bases where slug = ${literal(edition.baseSlug)}), 'ausente'),
         case when exists (select 1 from public.bases where slug = ${literal(edition.baseSlug)} and status = 'ACTIVE') then 'OK' else 'FALHOU' end
  union all
  select 'SLUG_LIVRE',
         case when exists (select 1 from public.experiences where slug = ${slug}) then 'já existe' else 'livre' end,
         case when exists (select 1 from public.experiences where slug = ${slug}) then 'FALHOU' else 'OK' end
  union all
  select 'SESSAO_SEM_DUPLICIDADE',
         ${duplicateSessionCount(edition)}::text || ' sessão(ões) de evento na base ${edition.baseSlug} com início ${edition.startsAt}',
         case when ${duplicateSessionCount(edition)} = 0 then 'OK' else 'FALHOU' end
  union all
  select 'SEGURANCA_DOS_EVENTOS',
         case when ${SECURITY_APPLIED} then 'migration 202610310004 aplicada' else 'migration 202610310004 AUSENTE' end,
         case when ${SECURITY_APPLIED} then 'OK' else 'FALHOU' end
  union all
  select 'INTERRUPTOR',
         coalesce((select case when publication_enabled then 'ligado (rascunho escondido pelas políticas da 202610310004)' else 'desligado' end from public.special_event_settings where singleton), 'ausente'),
         case when exists (select 1 from public.special_event_settings where singleton) then 'OK' else 'FALHOU' end
  union all
  select 'MIGRATIONS_DOS_EVENTOS',
         'leituras com interruptor=' || (select prosrc like '%publication_enabled%' from pg_proc where proname = 'list_public_events' and pronamespace = 'public'::regnamespace)::text
           || ', lista por tipo=' || exists (select 1 from pg_proc where proname = 'claim_pending_waitlist_spot_emails_by_kind' and pronamespace = 'public'::regnamespace)::text,
         case when (select prosrc like '%publication_enabled%' from pg_proc where proname = 'list_public_events' and pronamespace = 'public'::regnamespace)
               and exists (select 1 from pg_proc where proname = 'claim_pending_waitlist_spot_emails_by_kind' and pronamespace = 'public'::regnamespace) then 'OK' else 'FALHOU' end
  union all
  select 'COLUNAS_LEGADAS_COBERTAS',
         case when not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'experiences' and column_name = 'eyebrow') then 'sem colunas legadas'
              when exists (select 1 from pg_trigger where tgrelid = 'public.experiences'::regclass and tgname = 'experiences_fill_legacy_columns') then 'colunas legadas preenchidas pelo gatilho'
              else 'colunas legadas SEM o gatilho (aplicar 202610310002)' end,
         case when not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'experiences' and column_name = 'eyebrow')
               or exists (select 1 from pg_trigger where tgrelid = 'public.experiences'::regclass and tgname = 'experiences_fill_legacy_columns') then 'OK' else 'FALHOU' end
  union all
  select 'RASCUNHO_NASCE_INATIVO',
         case when not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'experiences' and column_name = 'active') then 'sem a coluna active'
              when (select md5(regexp_replace(btrim(p.prosrc, E' \\t\\r\\n'), '\\s+', ' ', 'g')) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'experiences_fill_legacy_columns') = '${LEGACY_ACTIVE_RULE_MD5}' then 'gatilho com a regra do active'
              else 'gatilho SEM a regra do active (aplicar 202610310003)' end,
         case when not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'experiences' and column_name = 'active')
               or (select md5(regexp_replace(btrim(p.prosrc, E' \\t\\r\\n'), '\\s+', ' ', 'g')) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'experiences_fill_legacy_columns') = '${LEGACY_ACTIVE_RULE_MD5}' then 'OK' else 'FALHOU' end
  union all
  select 'OUTROS_EVENTOS',
         ${otherEventsFingerprint(edition.slug)},
         'OK'
${COMMON_COUNTS})
${CHECK_TAIL("EVENTO_CADASTRO_PREFLIGHT_OK")}`;
}

// --- Postcheck --------------------------------------------------------------

/** Só leitura, depois do cadastro: a edição existe, fechada, com os dados aprovados; nada mais mudou. */
export function editionPostcheckSql(edition: EventEdition) {
  assertReady(edition);
  const editorial = validateEventEditorial(edition.editorial);
  if (!editorial.success) throw new Error(editorial.errors.join("; "));
  const event = editorial.data.event;
  const json = JSON.stringify(edition.editorial);
  const slug = literal(edition.slug);
  const paths = editionCadastroPaths(edition.slug);
  const deadline = event.cancellation?.deadline ?? null;
  return `-- ${edition.title} — POSTCHECK DO CADASTRO (SOMENTE LEITURA; GERADO, NÃO EDITAR À MÃO)
--
-- Rodar no SQL Editor DEPOIS de ${paths.cadastro}.
-- A última linha, EVENTO_CADASTRO_POSTCHECK_OK, precisa estar OK, e
-- OUTROS_EVENTOS, LISTAGENS_REGULARES, RESERVAS_POR_STATUS e
-- INSCRICOES_DA_LISTA_POR_STATUS iguais às do preflight.

with ev as (
  select e.*, b.slug as base_slug from public.experiences e join public.bases b on b.id = e.base_id where e.slug = ${slug}
),
ses as (
  select s.* from public.sessions s join ev on ev.id = s.experience_id
),
checks as (
  select 'EVENTO_EM_RASCUNHO' as check_name,
         coalesce((select kind || '/' || status || ' na base ' || base_slug from ev), 'ausente') as result,
         case when (select kind = 'EVENT' and status = 'DRAFT' and base_slug = ${literal(edition.baseSlug)} from ev) then 'OK' else 'FALHOU' end as status
  union all
  select 'TITULO_E_RESUMO',
         coalesce((select title from ev), 'ausente'),
         case when (select title = ${literal(edition.title)} and summary = ${literal(edition.summary)} from ev) then 'OK' else 'FALHOU' end
  union all
  select 'CONTEUDO_EDITORIAL_APROVADO',
         case when (select editorial_content = $json$${json}$json$::jsonb from ev) then 'idêntico ao aprovado' else 'diferente' end,
         case when (select editorial_content = $json$${json}$json$::jsonb from ev) and (select public.experience_editorial_is_publishable(editorial_content) from ev) then 'OK' else 'FALHOU' end
  union all
  select 'SESSAO_FECHADA',
         coalesce((select string_agg(status || ' ' || to_char(starts_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') || ' ' || duration_minutes || 'min ' || price_cents || ' centavos ' || capacity || ' vagas', '; ') from ses), 'nenhuma'),
         case when (select count(*) from ses) = 1
               and (select status = 'CLOSED' and starts_at = ${literal(edition.startsAt)}::timestamptz and duration_minutes = ${edition.durationMinutes}
                           and price_cents = ${edition.priceCents} and capacity = ${edition.capacity} from ses) then 'OK' else 'FALHOU' end
  union all
  select 'RESERVAS_EM_BREVE',
         coalesce((select 'comingSoon=' || coalesce(editorial_content #>> '{event,reservation,comingSoon}', 'ausente') || '; até ' || (editorial_content #>> '{event,reservation,maxPerOrder}') || ' por pedido; cancelamento até ' || coalesce(editorial_content #>> '{event,cancellation,deadline}', 'sem prazo') from ev), 'ausente'),
         case when (select (editorial_content #>> '{event,reservation,comingSoon}') = 'true'
                           and (editorial_content #>> '{event,reservation,maxPerOrder}') = '${event.reservation.maxPerOrder}'
                           and (editorial_content #>> '{event,cancellation,deadline}') is not distinct from ${deadline === null ? "null" : literal(deadline)} from ev) then 'OK' else 'FALHOU' end
  union all
  select 'RASCUNHO_INATIVO',
         coalesce((select coalesce('active=' || (to_jsonb(ev) ->> 'active'), 'sem a coluna active') from ev), 'ausente'),
         case when (select coalesce(to_jsonb(ev) ->> 'active', 'false') = 'false' from ev) then 'OK' else 'FALHOU' end
  union all
  select 'EDICAO_FORA_DAS_LEITURAS_PUBLICAS',
         (select count(*)::text from public.list_public_events() where slug = ${slug}) || ' na listagem, '
           || (select count(*)::text from public.get_public_event(${slug})) || ' na página, '
           || (select count(*)::text from public.list_public_event_sessions(${slug})) || ' sessão(ões) públicas',
         case when not exists (select 1 from public.list_public_events() where slug = ${slug})
               and not exists (select 1 from public.get_public_event(${slug}))
               and not exists (select 1 from public.list_public_event_sessions(${slug})) then 'OK' else 'FALHOU' end
  union all
  select 'SEM_RESERVAS_NEM_LISTA',
         (select count(*)::text from public.reservations r join ses on ses.id = r.session_id) || ' reserva(s), '
           || (select count(*)::text from public.waitlist_entries we join ses on ses.id = we.session_id) || ' inscrição(ões)',
         case when not exists (select 1 from public.reservations r join ses on ses.id = r.session_id)
               and not exists (select 1 from public.waitlist_entries we join ses on ses.id = we.session_id) then 'OK' else 'FALHOU' end
  union all
  select 'AUDITORIA',
         (select count(*)::text from public.admin_audit_log a join ev on ev.id = a.entity_id where a.action = 'EVENT_CREATED') || ' registro(s) EVENT_CREATED',
         case when (select count(*) from public.admin_audit_log a join ev on ev.id = a.entity_id where a.action = 'EVENT_CREATED') = 1 then 'OK' else 'FALHOU' end
  union all
  select 'OUTROS_EVENTOS',
         ${otherEventsFingerprint(edition.slug)},
         'OK'
${COMMON_COUNTS})
${CHECK_TAIL("EVENTO_CADASTRO_POSTCHECK_OK")}`;
}

// --- Desfazer ---------------------------------------------------------------

/** Desfaz o cadastro, só enquanto nada depende dele. */
export function editionRollbackSql(edition: EventEdition) {
  assertReady(edition);
  const slug = literal(edition.slug);
  return `-- =============================================================================
-- ${edition.title} — DESFAZER O CADASTRO (GERADO; SOMENTE COM DECISÃO EXPLÍCITA)
-- =============================================================================
--
-- Remove a edição ${edition.slug} e a sessão dela **só** se ela ainda estiver em
-- rascunho, com a sessão fechada e sem nenhuma reserva ou inscrição na lista de
-- espera. Senão, para sem mudar nada. Nenhuma outra edição é tocada. O registro
-- EVENT_CREATED da auditoria fica (histórico).

begin;
set local lock_timeout = '5s';

do $desfazer$
declare
  target uuid;
begin
  select id into target from public.experiences where slug = ${slug} and kind = 'EVENT';
  if target is null then
    raise notice 'EVENTO_DESFAZER: nada a desfazer';
    return;
  end if;
  if (select status from public.experiences where id = target) <> 'DRAFT'
     or exists (select 1 from public.sessions where experience_id = target and status <> 'CLOSED')
     or exists (select 1 from public.reservations r join public.sessions s on s.id = r.session_id where s.experience_id = target)
     or exists (select 1 from public.waitlist_entries we join public.sessions s on s.id = we.session_id where s.experience_id = target) then
    raise exception 'EVENTO_DESFAZER_RECUSADO: a edição já saiu do rascunho ou tem reserva/inscrição — decidir caso a caso';
  end if;
  delete from public.sessions where experience_id = target;
  delete from public.experiences where id = target;
  raise notice 'EVENTO_DESFEITO';
end;
$desfazer$;

commit;
`;
}

/** Os quatro scripts de uma edição, por caminho. Recusa antes de gerar qualquer SQL. */
export function editionCadastroFiles(edition: EventEdition) {
  assertReady(edition);
  const paths = editionCadastroPaths(edition.slug);
  return {
    [paths.preflight]: editionPreflightSql(edition),
    [paths.cadastro]: editionCadastroSql(edition),
    [paths.postcheck]: editionPostcheckSql(edition),
    [paths.rollback]: editionRollbackSql(edition),
  };
}

if (process.argv[1]?.endsWith("edition-cadastro-sql.ts")) {
  const slug = process.argv[2] ?? "";
  const edition = getEventEdition(slug);
  if (!edition) {
    console.error(`Edição "${slug}" não está registrada em lib/events/editions.ts.`);
    process.exit(1);
  }
  const errors = editionCadastroErrors(edition);
  if (errors.length) {
    console.error(`Nada gerado para ${slug}:\n- ${errors.join("\n- ")}`);
    process.exit(1);
  }
  const files = editionCadastroFiles(edition);
  for (const [path, sql] of Object.entries(files)) writeFileSync(path, sql, "utf8");
  console.info(`Gerados:\n${Object.keys(files).join("\n")}`);
}
