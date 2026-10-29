/**
 * Gera `supabase/maintenance/essencia_cadastro.sql` a partir da fixture
 * aprovada (`lib/events/fixtures/essencia.ts`). Nada é digitado à mão: o
 * conteúdo editorial, a data, o preço, a capacidade e o limite por pedido saem
 * do mesmo arquivo que a prévia e os testes usam, e o teste
 * `tests/special-events-essencia-cadastro.test.ts` falha se o SQL divergir.
 *
 *   pnpm events:essencia-sql
 *
 * Não fala com o banco. O SQL gerado é executado à mão, no SQL Editor, só com
 * autorização.
 */

import { writeFileSync } from "node:fs";

import { validateEventEditorial } from "../../lib/events/editorial.ts";
import { ESSENCIA_CAPACITY, ESSENCIA_EDITORIAL, ESSENCIA_SLUG, ESSENCIA_STARTS_AT, essenciaDemoEvent } from "../../lib/events/fixtures/essencia.ts";

export const ESSENCIA_ADMIN_EMAIL = "almaazulacademy@gmail.com";
export const ESSENCIA_BASE_SLUG = "concha-acustica";

export function essenciaCadastroSql() {
  const editorial = validateEventEditorial(ESSENCIA_EDITORIAL);
  if (!editorial.success) throw new Error(`Conteúdo do ESSÊNCIA inválido: ${editorial.errors.join("; ")}`);
  const demo = essenciaDemoEvent();
  const json = JSON.stringify(ESSENCIA_EDITORIAL);
  if (json.includes("$json$")) throw new Error("O conteúdo não pode conter o delimitador $json$.");
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

  return `-- ESSÊNCIA — CADASTRO EM ESTADO FECHADO (GERADO; NÃO EDITAR À MÃO)
--
-- Gerado por \`pnpm events:essencia-sql\` a partir de lib/events/fixtures/essencia.ts.
-- Rodar no SQL Editor SÓ COM AUTORIZAÇÃO, depois de essencia_cadastro_preflight.sql
-- (ESSENCIA_CADASTRO_PREFLIGHT_OK | OK). Depois, essencia_cadastro_postcheck.sql.
--
-- Cria, por \`admin_create_event\` (o caminho do painel, com as mesmas validações
-- e auditoria): a experiência ${ESSENCIA_SLUG} como EVENT em RASCUNHO e a sessão de
-- ${ESSENCIA_STARTS_AT} (05h30 em Brasília), 210 min, R$ 150,00, ${ESSENCIA_CAPACITY} vagas,
-- FECHADA para reservas. Não publica, não liga o interruptor, não abre a sessão,
-- não toca reserva nem lista de espera. Tudo numa transação: qualquer conferência
-- que falhe desfaz o cadastro inteiro.
--
-- Ator: o administrador ativo (role ADMIN) do e-mail ${ESSENCIA_ADMIN_EMAIL}, lido de
-- admin_users + auth.users — exatamente um, ou para. Base: ${ESSENCIA_BASE_SLUG}, lida por slug.

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
  where lower(u.email) = ${literal(ESSENCIA_ADMIN_EMAIL)} and au.is_active and au.role = 'ADMIN';
  if actors <> 1 then
    raise exception 'ESSENCIA_ATOR: esperado 1 administrador ativo, encontrado %', actors;
  end if;
  select au.user_id into actor
  from public.admin_users au join auth.users u on u.id = au.user_id
  where lower(u.email) = ${literal(ESSENCIA_ADMIN_EMAIL)} and au.is_active and au.role = 'ADMIN';

  select id into target_base from public.bases where slug = ${literal(ESSENCIA_BASE_SLUG)} and status = 'ACTIVE';
  if target_base is null then
    raise exception 'ESSENCIA_BASE: base ${ESSENCIA_BASE_SLUG} ausente ou inativa';
  end if;
  if exists (select 1 from public.experiences where slug = ${literal(ESSENCIA_SLUG)}) then
    raise exception 'ESSENCIA_JA_EXISTE: já existe experiência com o slug ${ESSENCIA_SLUG}';
  end if;
  if coalesce((select publication_enabled from public.special_event_settings where singleton), true) then
    raise exception 'ESSENCIA_INTERRUPTOR: o interruptor de publicação precisa estar desligado';
  end if;

  created := public.admin_create_event(
    actor,
    target_base,
    ${literal(ESSENCIA_SLUG)},
    ${literal(demo.title)},
    ${literal(demo.summary)},
    $json$${json}$json$::jsonb,
    ${literal(ESSENCIA_EDITORIAL.event.cardImage.src)},
    ${literal(ESSENCIA_STARTS_AT)}::timestamptz,
    ${demo.session.durationMinutes},
    ${demo.session.priceCents},
    ${ESSENCIA_CAPACITY}
  );

  -- Conferências dentro da transação: falhou, nada fica.
  if (select status from public.experiences where id = (created ->> 'experienceId')::uuid) <> 'DRAFT'
     or (select kind from public.experiences where id = (created ->> 'experienceId')::uuid) <> 'EVENT'
     or (select status from public.sessions where id = (created ->> 'sessionId')::uuid) <> 'CLOSED' then
    raise exception 'ESSENCIA_ESTADO: o evento precisa nascer em rascunho e com a sessão fechada';
  end if;
  if not public.experience_editorial_is_publishable((select editorial_content from public.experiences where id = (created ->> 'experienceId')::uuid)) then
    raise exception 'ESSENCIA_CONTEUDO: conteúdo editorial não passa na régua de publicação';
  end if;

  raise notice 'ESSENCIA_CRIADO experienceId=% sessionId=%', created ->> 'experienceId', created ->> 'sessionId';
end;
$cadastro$;

commit;
`;
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

/** Só leitura, antes do cadastro. */
export function essenciaPreflightSql() {
  const email = `'${ESSENCIA_ADMIN_EMAIL}'`;
  return `-- ESSÊNCIA — PREFLIGHT DO CADASTRO (SOMENTE LEITURA; GERADO, NÃO EDITAR À MÃO)
--
-- Rodar no SQL Editor ANTES de supabase/maintenance/essencia_cadastro.sql.
-- A última linha, ESSENCIA_CADASTRO_PREFLIGHT_OK, precisa estar OK. Guarde
-- LISTAGENS_REGULARES, RESERVAS_POR_STATUS e INSCRICOES_DA_LISTA_POR_STATUS.

with checks as (
  select 'ATOR_ADMINISTRADOR' as check_name,
         (select count(*)::text from public.admin_users au join auth.users u on u.id = au.user_id
          where lower(u.email) = ${email} and au.is_active and au.role = 'ADMIN') || ' administrador(es) ativo(s) com o e-mail da equipe' as result,
         case when (select count(*) from public.admin_users au join auth.users u on u.id = au.user_id
                    where lower(u.email) = ${email} and au.is_active and au.role = 'ADMIN') = 1 then 'OK' else 'FALHOU' end as status
  union all
  select 'BASE_ATIVA',
         coalesce((select slug || '=' || status from public.bases where slug = '${ESSENCIA_BASE_SLUG}'), 'ausente'),
         case when exists (select 1 from public.bases where slug = '${ESSENCIA_BASE_SLUG}' and status = 'ACTIVE') then 'OK' else 'FALHOU' end
  union all
  select 'SLUG_LIVRE',
         case when exists (select 1 from public.experiences where slug = '${ESSENCIA_SLUG}') then 'já existe' else 'livre' end,
         case when exists (select 1 from public.experiences where slug = '${ESSENCIA_SLUG}') then 'FALHOU' else 'OK' end
  union all
  select 'INTERRUPTOR_DESLIGADO',
         coalesce((select case when publication_enabled then 'ligado' else 'desligado' end from public.special_event_settings where singleton), 'ausente'),
         case when (select publication_enabled from public.special_event_settings where singleton) is false then 'OK' else 'FALHOU' end
  union all
  select 'MIGRATIONS_DOS_EVENTOS',
         'leituras com interruptor=' || (select prosrc like '%publication_enabled%' from pg_proc where proname = 'list_public_events' and pronamespace = 'public'::regnamespace)::text
           || ', lista por tipo=' || exists (select 1 from pg_proc where proname = 'claim_pending_waitlist_spot_emails_by_kind' and pronamespace = 'public'::regnamespace)::text,
         case when (select prosrc like '%publication_enabled%' from pg_proc where proname = 'list_public_events' and pronamespace = 'public'::regnamespace)
               and exists (select 1 from pg_proc where proname = 'claim_pending_waitlist_spot_emails_by_kind' and pronamespace = 'public'::regnamespace) then 'OK' else 'FALHOU' end
  union all
  select 'EVENTOS_CADASTRADOS',
         coalesce((select string_agg(slug || '=' || status, ', ' order by slug) from public.experiences where kind = 'EVENT'), 'nenhum'),
         case when exists (select 1 from public.experiences where kind = 'EVENT') then 'ATENCAO' else 'OK' end
${COMMON_COUNTS})
${CHECK_TAIL("ESSENCIA_CADASTRO_PREFLIGHT_OK")}`;
}

/** Só leitura, depois do cadastro: o evento existe, fechado, com os dados aprovados. */
export function essenciaPostcheckSql() {
  const demo = essenciaDemoEvent();
  const json = JSON.stringify(ESSENCIA_EDITORIAL);
  return `-- ESSÊNCIA — POSTCHECK DO CADASTRO (SOMENTE LEITURA; GERADO, NÃO EDITAR À MÃO)
--
-- Rodar no SQL Editor DEPOIS de supabase/maintenance/essencia_cadastro.sql.
-- A última linha, ESSENCIA_CADASTRO_POSTCHECK_OK, precisa estar OK, e
-- LISTAGENS_REGULARES, RESERVAS_POR_STATUS e INSCRICOES_DA_LISTA_POR_STATUS
-- iguais às do preflight.

with ev as (
  select e.*, b.slug as base_slug from public.experiences e join public.bases b on b.id = e.base_id where e.slug = '${ESSENCIA_SLUG}'
),
ses as (
  select s.* from public.sessions s join ev on ev.id = s.experience_id
),
checks as (
  select 'EVENTO_EM_RASCUNHO' as check_name,
         coalesce((select kind || '/' || status || ' na base ' || base_slug from ev), 'ausente') as result,
         case when (select kind = 'EVENT' and status = 'DRAFT' and base_slug = '${ESSENCIA_BASE_SLUG}' from ev) then 'OK' else 'FALHOU' end as status
  union all
  select 'TITULO_E_RESUMO',
         coalesce((select title from ev), 'ausente'),
         case when (select title = '${demo.title}' and summary = '${demo.summary.replace(/'/g, "''")}' from ev) then 'OK' else 'FALHOU' end
  union all
  select 'CONTEUDO_EDITORIAL_APROVADO',
         case when (select editorial_content = $json$${json}$json$::jsonb from ev) then 'idêntico ao aprovado' else 'diferente' end,
         case when (select editorial_content = $json$${json}$json$::jsonb from ev) and (select public.experience_editorial_is_publishable(editorial_content) from ev) then 'OK' else 'FALHOU' end
  union all
  select 'SESSAO_FECHADA',
         coalesce((select string_agg(status || ' ' || to_char(starts_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') || ' ' || duration_minutes || 'min ' || price_cents || ' centavos ' || capacity || ' vagas', '; ') from ses), 'nenhuma'),
         case when (select count(*) from ses) = 1
               and (select status = 'CLOSED' and starts_at = '${ESSENCIA_STARTS_AT}'::timestamptz and duration_minutes = ${demo.session.durationMinutes}
                           and price_cents = ${demo.session.priceCents} and capacity = ${ESSENCIA_CAPACITY} from ses) then 'OK' else 'FALHOU' end
  union all
  select 'LIMITE_POR_PEDIDO_E_PRAZO',
         coalesce((select 'até ' || (editorial_content #>> '{event,reservation,maxPerOrder}') || ' por pedido; cancelamento até ' || (editorial_content #>> '{event,cancellation,deadline}') from ev), 'ausente'),
         case when (select (editorial_content #>> '{event,reservation,maxPerOrder}') = '${ESSENCIA_EDITORIAL.event.reservation.maxPerOrder}'
                           and (editorial_content #>> '{event,cancellation,deadline}') = '${ESSENCIA_EDITORIAL.event.cancellation.deadline}' from ev) then 'OK' else 'FALHOU' end
  union all
  select 'NADA_PUBLICO',
         (select count(*)::text from public.list_public_events()) || ' evento(s) nas leituras públicas; interruptor '
           || coalesce((select case when publication_enabled then 'ligado' else 'desligado' end from public.special_event_settings where singleton), 'ausente'),
         case when not exists (select 1 from public.list_public_events()) and (select publication_enabled from public.special_event_settings where singleton) is false then 'OK' else 'FALHOU' end
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
${COMMON_COUNTS})
${CHECK_TAIL("ESSENCIA_CADASTRO_POSTCHECK_OK")}`;
}

/** Desfaz o cadastro, só enquanto nada depende dele. */
export function essenciaRollbackSql() {
  return `-- =============================================================================
-- ESSÊNCIA — DESFAZER O CADASTRO (GERADO; SOMENTE COM DECISÃO EXPLÍCITA)
-- =============================================================================
--
-- Remove o evento ${ESSENCIA_SLUG} e a sessão dele **só** se ele ainda estiver em
-- rascunho, com a sessão fechada e sem nenhuma reserva, inscrição na lista de
-- espera ou registro de presença. Senão, para sem mudar nada. O registro
-- EVENT_CREATED da auditoria fica (histórico).

begin;
set local lock_timeout = '5s';

do $desfazer$
declare
  target uuid;
begin
  select id into target from public.experiences where slug = '${ESSENCIA_SLUG}' and kind = 'EVENT';
  if target is null then
    raise notice 'ESSENCIA_DESFAZER: nada a desfazer';
    return;
  end if;
  if (select status from public.experiences where id = target) <> 'DRAFT'
     or exists (select 1 from public.sessions where experience_id = target and status <> 'CLOSED')
     or exists (select 1 from public.reservations r join public.sessions s on s.id = r.session_id where s.experience_id = target)
     or exists (select 1 from public.waitlist_entries we join public.sessions s on s.id = we.session_id where s.experience_id = target) then
    raise exception 'ESSENCIA_DESFAZER_RECUSADO: o evento já saiu do rascunho ou tem reserva/inscrição — decidir caso a caso';
  end if;
  delete from public.sessions where experience_id = target;
  delete from public.experiences where id = target;
  raise notice 'ESSENCIA_DESFEITO';
end;
$desfazer$;

commit;
`;
}

if (process.argv[1]?.endsWith("essencia-cadastro-sql.ts")) {
  writeFileSync("supabase/maintenance/essencia_cadastro.sql", essenciaCadastroSql(), "utf8");
  writeFileSync("supabase/diagnostics/essencia_cadastro_preflight.sql", essenciaPreflightSql(), "utf8");
  writeFileSync("supabase/diagnostics/essencia_cadastro_postcheck.sql", essenciaPostcheckSql(), "utf8");
  writeFileSync("supabase/rollback/essencia_cadastro.rollback.sql", essenciaRollbackSql(), "utf8");
  console.info("Gerados: supabase/maintenance/essencia_cadastro.sql, supabase/diagnostics/essencia_cadastro_{preflight,postcheck}.sql, supabase/rollback/essencia_cadastro.rollback.sql");
}
