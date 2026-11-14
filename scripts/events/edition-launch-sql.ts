/**
 * Scripts de lançamento de uma edição já cadastrada: publicação (página no ar,
 * vendas bloqueadas) e abertura das vendas. Gerados da edição registrada em
 * `lib/events/editions.ts`; nada é digitado à mão.
 *
 *   pnpm events:edition-launch-sql <slug>
 *
 * Gera, para a edição pedida:
 *
 *   PUBLICAÇÃO (rascunho → publicada; sessão segue CLOSED; "em breve" segue ativo)
 *   supabase/diagnostics/evento_<slug>_publicacao_preflight.sql   (só leitura)
 *   supabase/maintenance/evento_<slug>_publicacao.sql             (transação)
 *   supabase/diagnostics/evento_<slug>_publicacao_postcheck.sql   (só leitura)
 *   supabase/diagnostics/evento_<slug>_publicacao_anon_check.sql  (só leitura, como anon)
 *   supabase/rollback/evento_<slug>_publicacao.rollback.sql       (volta a rascunho)
 *
 *   ABERTURA DAS VENDAS (sai o "em breve" e a sessão abre — com EVENT_BOOKING_OPEN
 *   ligada em Production, o checkout passa a funcionar na hora)
 *   supabase/diagnostics/evento_<slug>_abertura_preflight.sql
 *   supabase/maintenance/evento_<slug>_abertura.sql
 *   supabase/diagnostics/evento_<slug>_abertura_postcheck.sql
 *   supabase/rollback/evento_<slug>_abertura.rollback.sql         (fecha de novo, só sem reservas)
 *
 * Regras de todos:
 *   - só tocam a edição pedida (por slug e `kind = 'EVENT'`); a impressão das
 *     outras edições (`OUTROS_EVENTOS`) e o catálogo regular precisam sair iguais;
 *   - nunca tocam o interruptor de publicação (ligado: desligá-lo esconderia as
 *     outras edições), variáveis de ambiente, reservas, pagamentos ou a lista;
 *   - cada script exige o estado exato anterior e trava as linhas (`for update`):
 *     rodar duas vezes, ou fora de ordem, recusa sem mudar nada;
 *   - mudanças relacionadas ficam numa transação, pelas RPCs do painel
 *     (`admin_update_event`, `admin_update_session`), com auditoria;
 *   - desfazer nunca apaga nada e recusa quando já existe reserva ou inscrição:
 *     aí o caminho é fechar a sessão pelo painel e tratar caso a caso.
 *
 * Não fala com o banco. O SQL gerado é executado à mão, no SQL Editor, só com
 * autorização de cada etapa.
 */

import { writeFileSync } from "node:fs";

import { validateEventEditorial } from "../../lib/events/editorial.ts";
import { editionErrors, type EventEdition } from "../../lib/events/edition.ts";
import { getEventEdition } from "../../lib/events/editions.ts";
import {
  CHECK_TAIL,
  COMMON_COUNTS,
  EDITION_ADMIN_EMAIL,
  editionFileStem,
  literal,
  otherEventsFingerprint,
  overlappingRegularSessions,
  SECURITY_APPLIED,
} from "./edition-cadastro-sql.ts";

/** O conteúdo aprovado, como cadastrado ("em breve" ligado). */
function approved(edition: EventEdition) {
  return JSON.stringify(edition.editorial);
}

/** O conteúdo aprovado com a venda desta edição aberta: só `event.reservation.comingSoon` muda. */
export function openedEditorial(edition: EventEdition) {
  const copy = JSON.parse(JSON.stringify(edition.editorial)) as { event: { reservation: Record<string, unknown> } };
  copy.event.reservation.comingSoon = false;
  return copy;
}

/** Recusa antes de gerar qualquer SQL. */
export function editionLaunchErrors(edition: EventEdition): string[] {
  const errors = editionErrors(edition);
  const editorial = validateEventEditorial(edition.editorial);
  if (editorial.success && !editorial.data.event.reservation.comingSoon) {
    errors.push("O conteúdo aprovado precisa estar com event.reservation.comingSoon = true: a abertura é um passo próprio.");
  }
  const opened = validateEventEditorial(openedEditorial(edition));
  if (!opened.success) errors.push(`O conteúdo com a venda aberta não valida: ${opened.errors.join("; ")}`);
  if (JSON.stringify(edition.editorial).includes("$json$")) errors.push("O conteúdo não pode conter o delimitador $json$.");
  return errors;
}

function assertReady(edition: EventEdition) {
  const errors = editionLaunchErrors(edition);
  if (errors.length) throw new Error(`Edição ${edition.slug} não pode gerar o lançamento: ${errors.join("; ")}`);
}

export function editionLaunchPaths(slug: string) {
  const stem = editionFileStem(slug);
  return {
    publicacaoPreflight: `supabase/diagnostics/${stem}_publicacao_preflight.sql`,
    publicacao: `supabase/maintenance/${stem}_publicacao.sql`,
    publicacaoPostcheck: `supabase/diagnostics/${stem}_publicacao_postcheck.sql`,
    publicacaoAnon: `supabase/diagnostics/${stem}_publicacao_anon_check.sql`,
    publicacaoRollback: `supabase/rollback/${stem}_publicacao.rollback.sql`,
    aberturaPreflight: `supabase/diagnostics/${stem}_abertura_preflight.sql`,
    abertura: `supabase/maintenance/${stem}_abertura.sql`,
    aberturaPostcheck: `supabase/diagnostics/${stem}_abertura_postcheck.sql`,
    aberturaRollback: `supabase/rollback/${stem}_abertura.rollback.sql`,
  };
}

// --- Peças comuns -------------------------------------------------------------

const ACTOR = `from public.admin_users au join auth.users u on u.id = au.user_id
    where lower(u.email) = ${literal(EDITION_ADMIN_EMAIL)} and au.is_active and au.role = 'ADMIN'`;

function ctes(edition: EventEdition) {
  return `with ev as (
  select e.*, to_jsonb(e) ->> 'active' as legacy_active from public.experiences e where e.slug = ${literal(edition.slug)} and e.kind = 'EVENT'
),
sess as (
  select s.* from public.sessions s join ev on ev.id = s.experience_id
),`;
}

/** A sessão com os dados aprovados (início, duração, preço, vagas). */
function sessionMatches(edition: EventEdition, alias = "s") {
  return `${alias}.starts_at = ${literal(edition.startsAt)}::timestamptz and ${alias}.duration_minutes = ${edition.durationMinutes} and ${alias}.price_cents = ${edition.priceCents} and ${alias}.capacity = ${edition.capacity}`;
}

function sessionCheck(edition: EventEdition, status: "CLOSED" | "OPEN", name: string) {
  return `  select '${name}',
         coalesce((select string_agg(s.status::text || ' ' || to_char(s.starts_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') || ' ' || s.duration_minutes || 'min ' || s.price_cents || ' centavos ' || s.capacity || ' vagas', '; ') from sess s), 'nenhuma'),
         case when (select count(*) from sess) = 1 and (select count(*) from sess s where s.status = '${status}' and ${sessionMatches(edition)}) = 1 then 'OK' else 'FALHOU' end`;
}

function contentCheck(json: string, name: string) {
  return `  select '${name}',
         case when (select editorial_content = $json$${json}$json$::jsonb from ev) then 'idêntico ao aprovado' else coalesce((select 'diferente' from ev), 'ausente') end,
         case when (select editorial_content = $json$${json}$json$::jsonb from ev) and (select public.experience_editorial_is_publishable(editorial_content) from ev) then 'OK' else 'FALHOU' end`;
}

function commonChecks(edition: EventEdition, options: { reservationsMustBeZero: boolean }) {
  return `  union all
  select 'ADMINISTRADOR_DO_ATO',
         (select count(*)::text ${ACTOR}),
         case when (select count(*) ${ACTOR}) = 1 then 'OK' else 'FALHOU' end
  union all
  select 'INTERRUPTOR_LIGADO',
         coalesce((select case when publication_enabled then 'ligado (não é alterado)' else 'desligado' end from public.special_event_settings where singleton), 'ausente'),
         case when (select publication_enabled from public.special_event_settings where singleton) then 'OK' else 'FALHOU' end
  union all
  select 'SEGURANCA_DOS_EVENTOS',
         case when ${SECURITY_APPLIED} then 'migration 202610310004 aplicada' else 'AUSENTE' end,
         case when ${SECURITY_APPLIED} then 'OK' else 'FALHOU' end
  union all
  select 'RESERVAS_E_INSCRICOES_DA_EDICAO',
         coalesce((select string_agg(status || '=' || n, ', ' order by status) from (select r.status::text, count(*) n from public.reservations r join sess s on s.id = r.session_id group by 1) x), 'nenhuma reserva')
           || '; ' || (select count(*) from public.waitlist_entries w join sess s on s.id = w.session_id)::text || ' inscrição(ões) na lista'
           || '; ' || coalesce((select public.available_spots(s.id)::text || ' vaga(s) livre(s)' from sess s limit 1), 'sem sessão'),
         ${options.reservationsMustBeZero
    ? `case when exists (select 1 from public.reservations r join sess s on s.id = r.session_id) or exists (select 1 from public.waitlist_entries w join sess s on s.id = w.session_id) then 'FALHOU' else 'OK' end`
    : `'OK'`}
  union all
  select 'TURMAS_REGULARES_SOBREPOSTAS',
         coalesce((select string_agg(e.slug || ' ' || to_char(s.starts_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') || ' ' || s.status::text, '; ' order by s.starts_at)
          ${overlappingRegularSessions(edition)}), 'nenhuma'),
         case when exists (select 1 ${overlappingRegularSessions(edition)}) then 'ATENCAO' else 'OK' end
  union all
  select 'OUTROS_EVENTOS',
         ${otherEventsFingerprint(edition.slug)},
         'OK'
${COMMON_COUNTS}`;
}

/** Leituras públicas da edição: página, sessões e caminhos de reserva. */
function publicReads(edition: EventEdition) {
  const slug = literal(edition.slug);
  return {
    page: `(select count(*) from public.get_public_event(${slug}))`,
    availability: `coalesce((select string_agg(x.availability, ', ') from public.list_public_event_sessions(${slug}) x), 'sem sessão pública')`,
    bookable: `((select count(*) from public.list_open_sessions(${slug})) + (select count(*) from public.list_public_sessions(${slug})) + coalesce((select count(*) from sess, lateral public.get_booking_session(sess.id)), 0))`,
    regularListings: `((select count(*) from public.list_public_regular_experiences() x where x.slug = ${slug}) + (select count(*) from public.list_public_regular_catalog() x where x.slug = ${slug}))`,
  };
}

const header = (edition: EventEdition, what: string, lines: string) => `-- ${edition.title} — ${what} (GERADO por \`pnpm events:edition-launch-sql ${edition.slug}\`; NÃO EDITAR À MÃO)
--
${lines}
`;

// ===========================================================================
// PUBLICAÇÃO — página no ar, vendas bloqueadas
// ===========================================================================

export function publicacaoPreflightSql(edition: EventEdition) {
  assertReady(edition);
  const reads = publicReads(edition);
  return `${header(edition, "PUBLICAÇÃO — PREFLIGHT (SOMENTE LEITURA)", `-- Rodar ANTES de ${editionLaunchPaths(edition.slug).publicacao}. A última linha,
-- EVENTO_PUBLICACAO_PREFLIGHT_OK, precisa estar OK. Guarde OUTROS_EVENTOS,
-- LISTAGENS_REGULARES, RESERVAS_POR_STATUS e INSCRICOES_DA_LISTA_POR_STATUS.`)}
${ctes(edition)}
checks as (
  select 'EVENTO_EM_RASCUNHO' as check_name,
         coalesce((select kind || '/' || status || ', active=' || coalesce(legacy_active, 'sem coluna') from ev), 'ausente') as result,
         case when (select status = 'DRAFT' and coalesce(legacy_active, 'false') = 'false' from ev) then 'OK' else 'FALHOU' end as status
  union all
${contentCheck(approved(edition), "CONTEUDO_APROVADO_EM_BREVE")}
  union all
${sessionCheck(edition, "CLOSED", "SESSAO_FECHADA")}
  union all
  select 'FORA_DAS_LEITURAS_PUBLICAS',
         ${reads.page}::text || ' página, ' || ${reads.bookable}::text || ' caminho(s) de reserva',
         case when ${reads.page} = 0 and ${reads.bookable} = 0 then 'OK' else 'FALHOU' end
${commonChecks(edition, { reservationsMustBeZero: true })})
${CHECK_TAIL("EVENTO_PUBLICACAO_PREFLIGHT_OK")}`;
}

export function publicacaoSql(edition: EventEdition) {
  assertReady(edition);
  const slug = literal(edition.slug);
  return `${header(edition, "PUBLICAÇÃO COM VENDAS BLOQUEADAS", `-- Rodar no SQL Editor SÓ COM AUTORIZAÇÃO ESPECÍFICA, depois do preflight
-- (EVENTO_PUBLICACAO_PREFLIGHT_OK | OK).
--
-- Numa transação: publica ${edition.slug} por admin_update_event (caminho do painel,
-- com auditoria), mantendo título, resumo, imagem, ordem e o conteúdo aprovado com
-- "Reservas abrem em breve". NÃO abre a sessão, NÃO mexe no interruptor (já ligado),
-- NÃO toca reserva, lista, outras edições nem variável de ambiente. Rodar de novo
-- recusa (o evento já não está em rascunho). Qualquer conferência que falhe desfaz tudo.`)}
begin;
set local lock_timeout = '5s';

do $publicacao$
declare
  actor uuid;
  actors integer;
  target public.experiences%rowtype;
  regulars_before text;
  regulars_after text;
  others_before text;
  others_after text;
begin
  select count(*), min(au.user_id::text)::uuid into actors, actor ${ACTOR};
  if actors <> 1 then
    raise exception 'EVENTO_ATOR: esperado 1 administrador ativo, encontrado %', actors;
  end if;

  select * into target from public.experiences where slug = ${slug} and kind = 'EVENT' for update;
  if not found then
    raise exception 'EVENTO_AUSENTE: rode antes o cadastro';
  end if;
  if target.status <> 'DRAFT' then
    raise exception 'EVENTO_ESTADO: esperado DRAFT, encontrado % (publicação já feita?)', target.status;
  end if;
  if target.editorial_content <> $json$${approved(edition)}$json$::jsonb
     or not public.experience_editorial_is_publishable(target.editorial_content) then
    raise exception 'EVENTO_CONTEUDO: conteúdo diferente do aprovado (com "em breve")';
  end if;
  if (select publication_enabled from public.special_event_settings where singleton) is distinct from true then
    raise exception 'EVENTO_INTERRUPTOR: esperado ligado; este script não o altera';
  end if;
  perform 1 from public.sessions s where s.experience_id = target.id for update;
  if (select count(*) from public.sessions s where s.experience_id = target.id) <> 1
     or (select count(*) from public.sessions s where s.experience_id = target.id and s.status = 'CLOSED' and ${sessionMatches(edition)}) <> 1 then
    raise exception 'EVENTO_SESSAO: esperada uma sessão CLOSED com os dados aprovados';
  end if;
  if exists (select 1 from public.reservations r join public.sessions s on s.id = r.session_id where s.experience_id = target.id)
     or exists (select 1 from public.waitlist_entries w join public.sessions s on s.id = w.session_id where s.experience_id = target.id) then
    raise exception 'EVENTO_RESERVAS: a edição já tem reserva ou inscrição';
  end if;

  select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) into regulars_before from public.list_public_regular_catalog() x;
  select ${otherEventsFingerprint(edition.slug)} into others_before;

  perform public.admin_update_event(actor, target.id, target.title, target.summary, 'PUBLISHED', target.image_url, target.display_order, target.editorial_content);

  if (select status from public.experiences where id = target.id) <> 'PUBLISHED' then
    raise exception 'EVENTO_PUBLICACAO: status não mudou';
  end if;
  if (select count(*) from public.sessions s where s.experience_id = target.id and s.status = 'CLOSED') <> 1 then
    raise exception 'EVENTO_SESSAO_ALTERADA: a sessão precisa continuar CLOSED';
  end if;
  if (select count(*) from public.get_public_event(${slug})) <> 1 then
    raise exception 'EVENTO_LEITURA: a página pública não apareceu';
  end if;
  if (select count(*) from public.list_public_event_sessions(${slug}) x where x.availability = 'AVAILABLE') <> 0
     or exists (select 1 from public.sessions s, lateral public.get_booking_session(s.id) b where s.experience_id = target.id) then
    raise exception 'EVENTO_VENDA_ABERTA: a publicação abriu um caminho de reserva';
  end if;
  select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) into regulars_after from public.list_public_regular_catalog() x;
  select ${otherEventsFingerprint(edition.slug)} into others_after;
  if regulars_before <> regulars_after or others_before <> others_after then
    raise exception 'EVENTO_ISOLAMENTO: o catálogo regular ou outra edição mudou';
  end if;
  raise notice 'EVENTO_PUBLICADO_COM_VENDAS_BLOQUEADAS';
end;
$publicacao$;

commit;
`;
}

export function publicacaoPostcheckSql(edition: EventEdition) {
  assertReady(edition);
  const reads = publicReads(edition);
  return `${header(edition, "PUBLICAÇÃO — POSTCHECK (SOMENTE LEITURA)", `-- OUTROS_EVENTOS, LISTAGENS_REGULARES e INSCRICOES_DA_LISTA_POR_STATUS precisam ser
-- iguais às do preflight; RESERVAS_POR_STATUS só muda por compra regular. A última
-- linha, EVENTO_PUBLICACAO_POSTCHECK_OK, precisa estar OK. Depois, rode a conferência
-- como anon (${editionLaunchPaths(edition.slug).publicacaoAnon}).`)}
${ctes(edition)}
checks as (
  select 'EVENTO_PUBLICADO' as check_name,
         coalesce((select kind || '/' || status from ev), 'ausente') as result,
         case when (select status = 'PUBLISHED' from ev) then 'OK' else 'FALHOU' end as status
  union all
${contentCheck(approved(edition), "CONTEUDO_APROVADO_EM_BREVE")}
  union all
${sessionCheck(edition, "CLOSED", "SESSAO_FECHADA")}
  union all
  select 'LEITURA_DO_EVENTO',
         ${reads.page}::text || ' página; sessão pública: ' || ${reads.availability},
         case when ${reads.page} = 1 and (select count(*) from public.list_public_event_sessions(${literal(edition.slug)}) x where x.availability = 'AVAILABLE') = 0 then 'OK' else 'FALHOU' end
  union all
  select 'SEM_CAMINHO_DE_RESERVA',
         ${reads.bookable}::text || ' sessão(ões) reservável(is)',
         case when ${reads.bookable} = 0 then 'OK' else 'FALHOU' end
  union all
  select 'FORA_DAS_LISTAGENS_REGULARES',
         ${reads.regularListings}::text || ' linha(s)',
         case when ${reads.regularListings} = 0 then 'OK' else 'FALHOU' end
  union all
  select 'AUDITORIA_DA_PUBLICACAO',
         (select count(*)::text from public.admin_audit_log a join ev on a.entity_id = ev.id where a.action = 'EVENT_UPDATED' and a.metadata ->> 'status' = 'PUBLISHED') || ' registro(s)',
         case when exists (select 1 from public.admin_audit_log a join ev on a.entity_id = ev.id where a.action = 'EVENT_UPDATED' and a.metadata ->> 'status' = 'PUBLISHED') then 'OK' else 'FALHOU' end
${commonChecks(edition, { reservationsMustBeZero: true })})
${CHECK_TAIL("EVENTO_PUBLICACAO_POSTCHECK_OK")}`;
}

export function publicacaoAnonCheckSql(edition: EventEdition) {
  assertReady(edition);
  const slug = literal(edition.slug);
  return `${header(edition, "PUBLICAÇÃO — CONFERÊNCIA COMO anon (SOMENTE LEITURA)", `-- O postcheck roda com o dono do banco, que não passa pelas políticas. Aqui, como a
-- chave pública, o esperado com a edição publicada e a sessão fechada é:
-- evento_visivel = 1, sessao_aberta_visivel = 0, sessao_reservavel = 0 e
-- pode_pre_reservar = false.`)}
begin;
set local role anon;
select
  (select count(*) from public.experiences where slug = ${slug} and kind = 'EVENT') as evento_visivel,
  (select count(*) from public.sessions s join public.experiences e on e.id = s.experience_id where e.slug = ${slug} and s.status = 'OPEN') as sessao_aberta_visivel,
  ((select count(*) from public.list_open_sessions(${slug})) + (select count(*) from public.list_public_sessions(${slug}))) as sessao_reservavel,
  has_function_privilege('anon', 'public.create_pre_reservation(uuid, text, text, text, text, integer, text, uuid)', 'execute') as pode_pre_reservar;
rollback;
`;
}

export function publicacaoRollbackSql(edition: EventEdition) {
  assertReady(edition);
  const slug = literal(edition.slug);
  return `${header(edition, "DESFAZER A PUBLICAÇÃO (SOMENTE COM DECISÃO EXPLÍCITA)", `-- Volta ${edition.slug} a rascunho pelo caminho do painel: a página sai do ar. NÃO mexe
-- no interruptor (as outras edições continuam no ar), não apaga nada. Recusa, sem
-- mudar nada, se a sessão não estiver CLOSED ou se houver reserva ou inscrição —
-- aí o procedimento é outro (fechar a sessão pelo painel e decidir caso a caso).
-- Já em rascunho: avisa e não faz nada.`)}
begin;
set local lock_timeout = '5s';

do $desfazer$
declare
  actor uuid;
  actors integer;
  target public.experiences%rowtype;
begin
  select count(*), min(au.user_id::text)::uuid into actors, actor ${ACTOR};
  if actors <> 1 then
    raise exception 'EVENTO_ATOR: esperado 1 administrador ativo, encontrado %', actors;
  end if;
  select * into target from public.experiences where slug = ${slug} and kind = 'EVENT' for update;
  if not found then
    raise exception 'EVENTO_DESFAZER_RECUSADO: edição ausente';
  end if;
  if target.status = 'DRAFT' then
    raise notice 'EVENTO_DESFAZER: a edição já está em rascunho; nada a fazer';
    return;
  end if;
  if exists (select 1 from public.sessions s where s.experience_id = target.id and s.status <> 'CLOSED')
     or exists (select 1 from public.reservations r join public.sessions s on s.id = r.session_id where s.experience_id = target.id)
     or exists (select 1 from public.waitlist_entries w join public.sessions s on s.id = w.session_id where s.experience_id = target.id) then
    raise exception 'EVENTO_DESFAZER_RECUSADO: sessão aberta, reserva ou inscrição existente — fechar a sessão pelo painel e tratar caso a caso';
  end if;
  perform public.admin_update_event(actor, target.id, target.title, target.summary, 'DRAFT', target.image_url, target.display_order, target.editorial_content);
  raise notice 'EVENTO_PUBLICACAO_DESFEITA';
end;
$desfazer$;

commit;
`;
}

// ===========================================================================
// ABERTURA DAS VENDAS — sai o "em breve" e a sessão abre
// ===========================================================================

export function aberturaPreflightSql(edition: EventEdition) {
  assertReady(edition);
  const editorial = validateEventEditorial(edition.editorial);
  const deadline = editorial.success ? editorial.data.event.cancellation?.deadline ?? null : null;
  return `${header(edition, "ABERTURA DAS VENDAS — PREFLIGHT (SOMENTE LEITURA)", `-- ATENÇÃO: com EVENT_BOOKING_OPEN ligada em Production, rodar a abertura libera o
-- checkout desta edição na hora. Rodar ANTES de ${editionLaunchPaths(edition.slug).abertura}.
-- A última linha, EVENTO_ABERTURA_PREFLIGHT_OK, precisa estar OK.`)}
${ctes(edition)}
checks as (
  select 'EVENTO_PUBLICADO' as check_name,
         coalesce((select kind || '/' || status from ev), 'ausente') as result,
         case when (select status = 'PUBLISHED' from ev) then 'OK' else 'FALHOU' end as status
  union all
${contentCheck(approved(edition), "CONTEUDO_APROVADO_EM_BREVE")}
  union all
${sessionCheck(edition, "CLOSED", "SESSAO_FECHADA_COM_OS_DADOS")}
  union all
  select 'VAGAS_LIVRES',
         coalesce((select public.available_spots(s.id)::text || ' de ' || s.capacity from sess s limit 1), 'sem sessão'),
         case when (select public.available_spots(s.id) = ${edition.capacity} from sess s limit 1) then 'OK' else 'FALHOU' end
  union all
  select 'SESSAO_NO_FUTURO',
         coalesce((select to_char(s.starts_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') from sess s limit 1), 'sem sessão'),
         case when (select s.starts_at > now() from sess s limit 1) then 'OK' else 'FALHOU' end
  union all
  select 'PRAZO_DE_CANCELAMENTO',
         ${deadline ? `case when now() <= ${literal(deadline)}::timestamptz then 'antes do prazo (${deadline})' else 'DEPOIS do prazo (${deadline}): a política anunciada já não vale' end` : `'sem prazo'`},
         ${deadline ? `case when now() <= ${literal(deadline)}::timestamptz then 'OK' else 'ATENCAO' end` : `'OK'`}
${commonChecks(edition, { reservationsMustBeZero: true })})
${CHECK_TAIL("EVENTO_ABERTURA_PREFLIGHT_OK")}`;
}

export function aberturaSql(edition: EventEdition) {
  assertReady(edition);
  const slug = literal(edition.slug);
  return `${header(edition, "ABERTURA DAS VENDAS (SENSÍVEL)", `-- Rodar no SQL Editor SÓ COM AUTORIZAÇÃO ESPECÍFICA, depois do preflight
-- (EVENTO_ABERTURA_PREFLIGHT_OK | OK). Com EVENT_BOOKING_OPEN ligada em Production,
-- o checkout desta edição fica disponível assim que a transação terminar.
--
-- Numa transação, pelas RPCs do painel (com auditoria): tira o "em breve" SÓ desta
-- edição (event.reservation.comingSoon = false; o resto do conteúdo fica igual) e abre
-- SÓ a sessão dela (OPEN, mesmos início, duração, preço e ${edition.capacity} vagas). Não toca o
-- interruptor, variáveis, outras edições, turmas regulares nem a lista de espera.
-- Rodar de novo recusa (o "em breve" já saiu). Qualquer conferência que falhe desfaz tudo.`)}
begin;
set local lock_timeout = '5s';

do $abertura$
declare
  actor uuid;
  actors integer;
  target public.experiences%rowtype;
  target_session public.sessions%rowtype;
  regulars_before text;
  regulars_after text;
  others_before text;
  others_after text;
begin
  select count(*), min(au.user_id::text)::uuid into actors, actor ${ACTOR};
  if actors <> 1 then
    raise exception 'EVENTO_ATOR: esperado 1 administrador ativo, encontrado %', actors;
  end if;

  select * into target from public.experiences where slug = ${slug} and kind = 'EVENT' for update;
  if not found or target.status <> 'PUBLISHED' then
    raise exception 'EVENTO_ESTADO: esperada a edição publicada';
  end if;
  if target.editorial_content <> $json$${approved(edition)}$json$::jsonb then
    raise exception 'EVENTO_CONTEUDO: esperado o conteúdo aprovado com "em breve" (abertura já feita?)';
  end if;
  if (select publication_enabled from public.special_event_settings where singleton) is distinct from true then
    raise exception 'EVENTO_INTERRUPTOR: esperado ligado';
  end if;
  if (select count(*) from public.sessions s where s.experience_id = target.id) <> 1 then
    raise exception 'EVENTO_SESSAO: esperada exatamente uma sessão';
  end if;
  select * into target_session from public.sessions s where s.experience_id = target.id for update;
  if target_session.status <> 'CLOSED'
     or not (target_session.starts_at = ${literal(edition.startsAt)}::timestamptz and target_session.duration_minutes = ${edition.durationMinutes}
             and target_session.price_cents = ${edition.priceCents} and target_session.capacity = ${edition.capacity}) then
    raise exception 'EVENTO_SESSAO: esperada a sessão CLOSED com os dados aprovados';
  end if;
  if target_session.starts_at <= now() then
    raise exception 'EVENTO_SESSAO_PASSADA: a sessão já começou';
  end if;
  if exists (select 1 from public.reservations r where r.session_id = target_session.id)
     or exists (select 1 from public.waitlist_entries w where w.session_id = target_session.id) then
    raise exception 'EVENTO_RESERVAS_INESPERADAS: a sessão fechada já tem reserva ou inscrição';
  end if;
  if public.available_spots(target_session.id) <> ${edition.capacity} then
    raise exception 'EVENTO_VAGAS: esperadas ${edition.capacity} vagas livres';
  end if;

  select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) into regulars_before from public.list_public_regular_catalog() x;
  select ${otherEventsFingerprint(edition.slug)} into others_before;

  perform public.admin_update_event(actor, target.id, target.title, target.summary, 'PUBLISHED', target.image_url, target.display_order,
    jsonb_set(target.editorial_content, '{event,reservation,comingSoon}', 'false'::jsonb));
  perform public.admin_update_session(actor, target_session.id, target.id, target_session.starts_at, target_session.duration_minutes,
    target_session.price_cents, target_session.capacity, 'OPEN', target_session.internal_notes);

  if (select editorial_content from public.experiences where id = target.id) <> $json$${JSON.stringify(openedEditorial(edition))}$json$::jsonb then
    raise exception 'EVENTO_CONTEUDO_ABERTO: o conteúdo não ficou igual ao aprovado sem "em breve"';
  end if;
  if (select status from public.sessions where id = target_session.id) <> 'OPEN' then
    raise exception 'EVENTO_SESSAO_NAO_ABRIU';
  end if;
  if public.available_spots(target_session.id) <> ${edition.capacity} then
    raise exception 'EVENTO_VAGAS: esperadas ${edition.capacity} vagas livres depois da abertura';
  end if;
  if (select count(*) from public.list_public_event_sessions(${slug}) x where x.id = target_session.id and x.availability = 'AVAILABLE') <> 1
     or not exists (select 1 from public.get_booking_session(target_session.id)) then
    raise exception 'EVENTO_SEM_VENDA: a sessão não ficou reservável';
  end if;
  select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) into regulars_after from public.list_public_regular_catalog() x;
  select ${otherEventsFingerprint(edition.slug)} into others_after;
  if regulars_before <> regulars_after or others_before <> others_after then
    raise exception 'EVENTO_ISOLAMENTO: o catálogo regular ou outra edição mudou';
  end if;
  raise notice 'EVENTO_VENDAS_ABERTAS sessionId=%', target_session.id;
end;
$abertura$;

commit;
`;
}

export function aberturaPostcheckSql(edition: EventEdition) {
  assertReady(edition);
  const reads = publicReads(edition);
  return `${header(edition, "ABERTURA DAS VENDAS — POSTCHECK (SOMENTE LEITURA)", `-- Logo depois da abertura: VAGAS = ${edition.capacity} de ${edition.capacity}. Depois das primeiras vendas, as vagas caem
-- e RESERVAS_E_INSCRICOES_DA_EDICAO passa a listar as reservas (informativo). A última
-- linha, EVENTO_ABERTURA_POSTCHECK_OK, precisa estar OK.`)}
${ctes(edition)}
checks as (
  select 'EVENTO_PUBLICADO' as check_name,
         coalesce((select kind || '/' || status from ev), 'ausente') as result,
         case when (select status = 'PUBLISHED' from ev) then 'OK' else 'FALHOU' end as status
  union all
${contentCheck(JSON.stringify(openedEditorial(edition)), "CONTEUDO_APROVADO_VENDA_ABERTA")}
  union all
${sessionCheck(edition, "OPEN", "SESSAO_ABERTA")}
  union all
  select 'VAGAS',
         coalesce((select public.available_spots(s.id)::text || ' livre(s) de ' || s.capacity from sess s limit 1), 'sem sessão'),
         case when (select public.available_spots(s.id) between 0 and ${edition.capacity} from sess s limit 1) then 'OK' else 'FALHOU' end
  union all
  select 'LEITURA_DO_EVENTO',
         ${reads.page}::text || ' página; sessão pública: ' || ${reads.availability},
         case when ${reads.page} = 1 and (select count(*) from public.list_public_event_sessions(${literal(edition.slug)}) x where x.availability in ('AVAILABLE', 'SOLD_OUT')) = 1 then 'OK' else 'FALHOU' end
  union all
  select 'RESERVAVEL',
         coalesce((select count(*) from sess, lateral public.get_booking_session(sess.id)), 0)::text || ' sessão(ões) no fluxo de reserva',
         case when coalesce((select count(*) from sess, lateral public.get_booking_session(sess.id)), 0) = 1
               or (select public.available_spots(s.id) = 0 from sess s limit 1) then 'OK' else 'FALHOU' end
  union all
  select 'FORA_DAS_LISTAGENS_REGULARES',
         ${reads.regularListings}::text || ' linha(s)',
         case when ${reads.regularListings} = 0 then 'OK' else 'FALHOU' end
  union all
  select 'AUDITORIA_DA_ABERTURA',
         (select count(*)::text from public.admin_audit_log a join sess s on a.entity_id = s.id where a.action = 'SESSION_UPDATED' and a.metadata ->> 'status' = 'OPEN') || ' registro(s) de sessão aberta',
         case when exists (select 1 from public.admin_audit_log a join sess s on a.entity_id = s.id where a.action = 'SESSION_UPDATED' and a.metadata ->> 'status' = 'OPEN') then 'OK' else 'FALHOU' end
${commonChecks(edition, { reservationsMustBeZero: false })})
${CHECK_TAIL("EVENTO_ABERTURA_POSTCHECK_OK")}`;
}

export function aberturaRollbackSql(edition: EventEdition) {
  assertReady(edition);
  const slug = literal(edition.slug);
  return `${header(edition, "DESFAZER A ABERTURA (SOMENTE COM DECISÃO EXPLÍCITA)", `-- Fecha de novo a venda desta edição: sessão CLOSED e "Reservas abrem em breve" de
-- volta, pelas RPCs do painel. Só enquanto NÃO existe nenhuma reserva (de qualquer
-- situação) nem inscrição na lista: com elas, recusa sem mudar nada — o procedimento
-- é fechar a sessão pelo painel ("Reservas encerradas") e tratar reservas, pagamentos
-- e reembolsos caso a caso. Nunca apaga nada. Já fechada e em breve: avisa e não faz nada.`)}
begin;
set local lock_timeout = '5s';

do $desfazer$
declare
  actor uuid;
  actors integer;
  target public.experiences%rowtype;
  target_session public.sessions%rowtype;
begin
  select count(*), min(au.user_id::text)::uuid into actors, actor ${ACTOR};
  if actors <> 1 then
    raise exception 'EVENTO_ATOR: esperado 1 administrador ativo, encontrado %', actors;
  end if;
  select * into target from public.experiences where slug = ${slug} and kind = 'EVENT' for update;
  if not found or target.status <> 'PUBLISHED' then
    raise exception 'EVENTO_DESFAZER_RECUSADO: esperada a edição publicada';
  end if;
  if (select count(*) from public.sessions s where s.experience_id = target.id) <> 1 then
    raise exception 'EVENTO_DESFAZER_RECUSADO: esperada exatamente uma sessão';
  end if;
  select * into target_session from public.sessions s where s.experience_id = target.id for update;
  if target_session.status = 'CLOSED' and target.editorial_content = $json$${approved(edition)}$json$::jsonb then
    raise notice 'EVENTO_DESFAZER: a venda já está fechada e em breve; nada a fazer';
    return;
  end if;
  if exists (select 1 from public.reservations r where r.session_id = target_session.id)
     or exists (select 1 from public.waitlist_entries w where w.session_id = target_session.id) then
    raise exception 'EVENTO_DESFAZER_RECUSADO: já existem reservas ou inscrições — fechar a sessão pelo painel e tratar caso a caso (procedimento específico)';
  end if;
  if target.editorial_content <> $json$${JSON.stringify(openedEditorial(edition))}$json$::jsonb then
    raise exception 'EVENTO_DESFAZER_RECUSADO: conteúdo diferente do aprovado — decidir à parte';
  end if;
  perform public.admin_update_session(actor, target_session.id, target.id, target_session.starts_at, target_session.duration_minutes,
    target_session.price_cents, target_session.capacity, 'CLOSED', target_session.internal_notes);
  perform public.admin_update_event(actor, target.id, target.title, target.summary, 'PUBLISHED', target.image_url, target.display_order,
    $json$${approved(edition)}$json$::jsonb);
  raise notice 'EVENTO_ABERTURA_DESFEITA';
end;
$desfazer$;

commit;
`;
}

/** Os nove scripts de lançamento de uma edição, por caminho. Recusa antes de gerar qualquer SQL. */
export function editionLaunchFiles(edition: EventEdition) {
  assertReady(edition);
  const paths = editionLaunchPaths(edition.slug);
  return {
    [paths.publicacaoPreflight]: publicacaoPreflightSql(edition),
    [paths.publicacao]: publicacaoSql(edition),
    [paths.publicacaoPostcheck]: publicacaoPostcheckSql(edition),
    [paths.publicacaoAnon]: publicacaoAnonCheckSql(edition),
    [paths.publicacaoRollback]: publicacaoRollbackSql(edition),
    [paths.aberturaPreflight]: aberturaPreflightSql(edition),
    [paths.abertura]: aberturaSql(edition),
    [paths.aberturaPostcheck]: aberturaPostcheckSql(edition),
    [paths.aberturaRollback]: aberturaRollbackSql(edition),
  };
}

if (process.argv[1]?.endsWith("edition-launch-sql.ts")) {
  const slug = process.argv[2] ?? "";
  const edition = getEventEdition(slug);
  if (!edition) {
    console.error(`Edição "${slug}" não está registrada em lib/events/editions.ts.`);
    process.exit(1);
  }
  const errors = editionLaunchErrors(edition);
  if (errors.length) {
    console.error(`Nada gerado para ${slug}:\n- ${errors.join("\n- ")}`);
    process.exit(1);
  }
  const files = editionLaunchFiles(edition);
  for (const [path, sql] of Object.entries(files)) writeFileSync(path, sql, "utf8");
  console.info(`Gerados:\n${Object.keys(files).join("\n")}`);
}
