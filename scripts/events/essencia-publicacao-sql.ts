/**
 * Gera o roteiro de publicação do ESSÊNCIA sem vendas: preflight, publicação,
 * postcheck, conferência como `anon` e desfazer. O conteúdo aprovado sai da
 * fixture (`lib/events/fixtures/essencia.ts`), e
 * `tests/special-events-essencia-publicacao.test.ts` falha se o SQL divergir.
 *
 *   pnpm events:essencia-publicacao-sql
 *
 * Não fala com o banco. O SQL gerado é executado à mão, no SQL Editor, só com
 * autorização. Publicar não abre venda: a sessão continua CLOSED e nada aqui toca
 * variável de ambiente.
 */

import { writeFileSync } from "node:fs";

import { ESSENCIA_CAPACITY, ESSENCIA_EDITORIAL, ESSENCIA_SLUG, ESSENCIA_STARTS_AT } from "../../lib/events/fixtures/essencia.ts";
import { ESSENCIA_ADMIN_EMAIL } from "./essencia-cadastro-sql.ts";

const PRICE_CENTS = 15000;
const DURATION = 210;
const SESSION = `to_char(s.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') = '${ESSENCIA_STARTS_AT.slice(0, 16)}' and s.duration_minutes = ${DURATION} and s.price_cents = ${PRICE_CENTS} and s.capacity = ${ESSENCIA_CAPACITY}`;
const COUNTS = `
  union all
  select 'ASSINATURA_DAS_FUNCOES',
         (select count(*)::text || ' funções, ' || md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), '|' order by p.oid::regprocedure::text)) from pg_proc p where p.pronamespace = 'public'::regnamespace),
         'OK'
  union all
  select 'LISTAGENS_REGULARES',
         (select count(*)::text from public.list_public_regular_experiences()) || ' experiências, ' || (select count(*)::text from public.list_public_regular_catalog()) || ' no catálogo',
         'OK'
  union all
  select 'RESERVAS_POR_STATUS',
         coalesce((select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.reservations group by 1) x), 'nenhuma'),
         'OK'
  union all
  select 'INSCRICOES_DA_LISTA_POR_STATUS',
         coalesce((select string_agg(status || '=' || n, ', ' order by status) from (select status::text, count(*) n from public.waitlist_entries group by 1) x), 'nenhuma'),
         'OK'
  union all
  select 'RESERVAS_E_INSCRICOES_DO_EVENTO',
         (select count(*) from public.reservations r join sess s on s.id = r.session_id)::text || ' reservas, ' || (select count(*) from public.waitlist_entries w join sess s on s.id = w.session_id)::text || ' inscrições',
         case when exists (select 1 from public.reservations r join sess s on s.id = r.session_id) or exists (select 1 from public.waitlist_entries w join sess s on s.id = w.session_id) then 'FALHOU' else 'OK' end
  union all
  select 'SESSAO_FECHADA',
         coalesce((select string_agg(s.status::text || ' ' || s.capacity::text || ' vagas ' || s.price_cents::text || ' centavos', ', ') from sess s), 'nenhuma'),
         case when (select count(*) from sess s where s.status = 'CLOSED' and ${SESSION}) = 1 and (select count(*) from sess) = 1 then 'OK' else 'FALHOU' end
  union all
  select 'CONTEUDO_EDITORIAL_APROVADO',
         case when (select editorial_content = $json$${JSON.stringify(ESSENCIA_EDITORIAL)}$json$::jsonb from ev) then 'idêntico ao aprovado' else 'diferente' end,
         case when (select editorial_content = $json$${JSON.stringify(ESSENCIA_EDITORIAL)}$json$::jsonb from ev) and (select public.experience_editorial_is_publishable(editorial_content) from ev) then 'OK' else 'FALHOU' end
  union all
  select 'AGENDAMENTOS_DA_LISTA',
         coalesce((select string_agg(jobname, ', ') from cron.job where jobname like 'waitlist%'), 'nenhum'),
         case when exists (select 1 from cron.job where jobname like 'waitlist%') then 'FALHOU' else 'OK' end
`;

function closing(token: string) {
  return `)
select check_name, result, status from checks
union all
select '${token}',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s)' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
`;
}

const BASE_CTES = `with ev as (
  select e.*, to_jsonb(e) ->> 'active' as legacy_active from public.experiences e where e.slug = '${ESSENCIA_SLUG}' and e.kind = 'EVENT'
),
sess as (
  select s.* from public.sessions s join ev on ev.id = s.experience_id
),`;

const ACTOR = `from public.admin_users au join auth.users u on u.id = au.user_id
  where lower(u.email) = '${ESSENCIA_ADMIN_EMAIL}' and au.is_active and au.role = 'ADMIN'`;

export function publicacaoPreflightSql() {
  return `-- ESSÊNCIA — PUBLICAÇÃO SEM VENDAS — PREFLIGHT (GERADO; SOMENTE LEITURA)
--
-- Gerado por \`pnpm events:essencia-publicacao-sql\`. A última linha,
-- ESSENCIA_PUBLICACAO_PREFLIGHT_OK, precisa estar OK. Guarde ASSINATURA_DAS_FUNCOES,
-- LISTAGENS_REGULARES e as contagens para comparar com o postcheck.

${BASE_CTES}
checks as (
  select 'EVENTO_EM_RASCUNHO' as check_name,
         coalesce((select kind || '/' || status || ', active=' || coalesce(legacy_active, 'sem coluna') from ev), 'ausente') as result,
         case when (select status = 'DRAFT' from ev) then 'OK' else 'FALHOU' end as status
  union all
  select 'INTERRUPTOR_DESLIGADO',
         coalesce((select case when publication_enabled then 'ligado' else 'desligado' end from public.special_event_settings where singleton), 'ausente'),
         case when (select publication_enabled from public.special_event_settings where singleton) is false then 'OK' else 'FALHOU' end
  union all
  select 'NENHUM_OUTRO_EVENTO',
         (select count(*)::text from public.experiences where kind = 'EVENT' and slug <> '${ESSENCIA_SLUG}'),
         case when exists (select 1 from public.experiences where kind = 'EVENT' and slug <> '${ESSENCIA_SLUG}') then 'FALHOU' else 'OK' end
  union all
  select 'ADMINISTRADOR_DO_ATO',
         (select count(*)::text ${ACTOR}),
         case when (select count(*) ${ACTOR}) = 1 then 'OK' else 'FALHOU' end
  union all
  select 'BASE_ATIVA',
         coalesce((select b.slug || '/' || b.status from public.bases b join ev on ev.base_id = b.id), 'ausente'),
         case when (select b.status = 'ACTIVE' from public.bases b join ev on ev.base_id = b.id) then 'OK' else 'FALHOU' end
  union all
  select 'SEGURANCA_APLICADA',
         (select count(*)::text || ' de 2 políticas' from pg_policy where not polpermissive and polname in ('events hidden until published', 'event sessions hidden until published')),
         case when (select count(*) from pg_policy where not polpermissive and polname in ('events hidden until published', 'event sessions hidden until published')) = 2
               and to_regprocedure('public.event_publication_allows(text)') is not null then 'OK' else 'FALHOU' end
${COUNTS}${closing("ESSENCIA_PUBLICACAO_PREFLIGHT_OK")}`;
}

export function publicacaoSql() {
  return `-- ESSÊNCIA — PUBLICAÇÃO SEM VENDAS (GERADO; NÃO EDITAR À MÃO)
--
-- Rodar no SQL Editor SÓ COM AUTORIZAÇÃO ESPECÍFICA, depois de
-- essencia_publicacao_preflight.sql (ESSENCIA_PUBLICACAO_PREFLIGHT_OK | OK).
--
-- Numa transação: liga o interruptor e publica por admin_update_event (o caminho
-- do painel, com auditoria), mantendo título, resumo, imagem, ordem e conteúdo.
-- NÃO abre a sessão, NÃO toca reserva nem lista de espera, NÃO toca variável de
-- ambiente. Com EVENTS_PUBLIC_ENABLED ausente, o site continua igual. Qualquer
-- conferência que falhe desfaz tudo.

begin;
set local lock_timeout = '5s';

do $publicacao$
declare
  actor uuid;
  actors integer;
  target public.experiences%rowtype;
  regulars_before text;
  regulars_after text;
begin
  select count(*), min(au.user_id::text)::uuid into actors, actor ${ACTOR};
  if actors <> 1 then
    raise exception 'ESSENCIA_ATOR: esperado 1 administrador ativo, encontrado %', actors;
  end if;

  select * into target from public.experiences where slug = '${ESSENCIA_SLUG}' and kind = 'EVENT' for update;
  if not found or target.status <> 'DRAFT' then
    raise exception 'ESSENCIA_ESTADO: evento ausente ou fora do rascunho';
  end if;
  if target.editorial_content <> $json$${JSON.stringify(ESSENCIA_EDITORIAL)}$json$::jsonb
     or not public.experience_editorial_is_publishable(target.editorial_content) then
    raise exception 'ESSENCIA_CONTEUDO: conteúdo diferente do aprovado';
  end if;
  if (select publication_enabled from public.special_event_settings where singleton) is distinct from false then
    raise exception 'ESSENCIA_INTERRUPTOR: esperado desligado';
  end if;
  if (select count(*) from public.sessions s where s.experience_id = target.id) <> 1
     or (select count(*) from public.sessions s where s.experience_id = target.id and s.status = 'CLOSED' and ${SESSION}) <> 1 then
    raise exception 'ESSENCIA_SESSAO: esperada uma sessão CLOSED com os dados aprovados';
  end if;
  if exists (select 1 from public.reservations r join public.sessions s on s.id = r.session_id where s.experience_id = target.id)
     or exists (select 1 from public.waitlist_entries w join public.sessions s on s.id = w.session_id where s.experience_id = target.id) then
    raise exception 'ESSENCIA_RESERVAS: o evento já tem reserva ou inscrição';
  end if;

  select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) into regulars_before from public.list_public_regular_catalog() x;

  update public.special_event_settings set publication_enabled = true, updated_at = now() where singleton;
  perform public.admin_update_event(actor, target.id, target.title, target.summary, 'PUBLISHED', target.image_url, target.display_order, target.editorial_content);

  if (select status from public.experiences where id = target.id) <> 'PUBLISHED' then
    raise exception 'ESSENCIA_PUBLICACAO: status não mudou';
  end if;
  if (select count(*) from public.sessions s where s.experience_id = target.id and s.status = 'CLOSED') <> 1 then
    raise exception 'ESSENCIA_SESSAO_ALTERADA: a sessão precisa continuar CLOSED';
  end if;
  select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) into regulars_after from public.list_public_regular_catalog() x;
  if regulars_before <> regulars_after then
    raise exception 'ESSENCIA_REGULARES: o catálogo regular mudou';
  end if;
  raise notice 'ESSENCIA_PUBLICADO_SEM_VENDAS';
end;
$publicacao$;

commit;
`;
}

export function publicacaoPostcheckSql() {
  return `-- ESSÊNCIA — PUBLICAÇÃO SEM VENDAS — POSTCHECK (GERADO; SOMENTE LEITURA)
--
-- ASSINATURA_DAS_FUNCOES, LISTAGENS_REGULARES e INSCRICOES_DA_LISTA_POR_STATUS
-- precisam ser iguais às do preflight; RESERVAS_POR_STATUS só muda por compra
-- regular. A última linha, ESSENCIA_PUBLICACAO_POSTCHECK_OK, precisa estar OK.

${BASE_CTES}
checks as (
  select 'EVENTO_PUBLICADO' as check_name,
         coalesce((select kind || '/' || status || ', active=' || coalesce(legacy_active, 'sem coluna') from ev), 'ausente') as result,
         case when (select status = 'PUBLISHED' from ev) then 'OK' else 'FALHOU' end as status
  union all
  select 'INTERRUPTOR_LIGADO',
         coalesce((select case when publication_enabled then 'ligado' else 'desligado' end from public.special_event_settings where singleton), 'ausente'),
         case when (select publication_enabled from public.special_event_settings where singleton) then 'OK' else 'FALHOU' end
  union all
  select 'LEITURA_DO_EVENTO',
         (select count(*)::text from public.get_public_event('${ESSENCIA_SLUG}')) || ' evento, ' || coalesce((select string_agg(x.availability, ', ') from public.list_public_event_sessions('${ESSENCIA_SLUG}') x), 'sem sessão'),
         case when (select count(*) from public.get_public_event('${ESSENCIA_SLUG}')) = 1
               and (select count(*) from public.list_public_event_sessions('${ESSENCIA_SLUG}') x where x.availability = 'AVAILABLE') = 0 then 'OK' else 'FALHOU' end
  union all
  select 'SEM_CAMINHO_DE_RESERVA',
         ((select count(*) from public.list_open_sessions('${ESSENCIA_SLUG}'))
          + (select count(*) from public.list_public_sessions('${ESSENCIA_SLUG}'))
          + coalesce((select count(*) from sess, lateral public.get_booking_session(sess.id)), 0))::text || ' sessão(ões) reservável(is)',
         case when ((select count(*) from public.list_open_sessions('${ESSENCIA_SLUG}'))
          + (select count(*) from public.list_public_sessions('${ESSENCIA_SLUG}'))
          + coalesce((select count(*) from sess, lateral public.get_booking_session(sess.id)), 0)) = 0 then 'OK' else 'FALHOU' end
  union all
  select 'FORA_DAS_LISTAGENS_REGULARES',
         ((select count(*) from public.list_public_regular_experiences() x where x.slug = '${ESSENCIA_SLUG}')
          + (select count(*) from public.list_public_regular_catalog() x where x.slug = '${ESSENCIA_SLUG}'))::text || ' linha(s)',
         case when ((select count(*) from public.list_public_regular_experiences() x where x.slug = '${ESSENCIA_SLUG}')
          + (select count(*) from public.list_public_regular_catalog() x where x.slug = '${ESSENCIA_SLUG}')) = 0 then 'OK' else 'FALHOU' end
  union all
  select 'AUDITORIA_DA_PUBLICACAO',
         (select count(*)::text from public.admin_audit_log a join ev on a.entity_id = ev.id where a.action = 'EVENT_UPDATED' and a.metadata ->> 'status' = 'PUBLISHED'),
         case when exists (select 1 from public.admin_audit_log a join ev on a.entity_id = ev.id where a.action = 'EVENT_UPDATED' and a.metadata ->> 'status' = 'PUBLISHED') then 'OK' else 'FALHOU' end
${COUNTS}${closing("ESSENCIA_PUBLICACAO_POSTCHECK_OK")}`;
}

export function publicacaoAnonCheckSql() {
  return `-- ESSÊNCIA — PUBLICAÇÃO SEM VENDAS — CONFERÊNCIA COMO anon (GERADO; SOMENTE LEITURA)
--
-- O postcheck roda com o dono do banco, que não passa pelas políticas. Aqui, com o
-- evento publicado e o interruptor ligado, o esperado é: evento_visivel = 1,
-- sessao_aberta_visivel = 0, regulares_visiveis igual ao preflight,
-- pode_pre_reservar = false e create_reservation_executavel = false ou nulo.

set local role anon;
select
  (select count(*) from public.experiences where slug = '${ESSENCIA_SLUG}' and kind = 'EVENT') as evento_visivel,
  (select count(*) from public.sessions s join public.experiences e on e.id = s.experience_id where e.slug = '${ESSENCIA_SLUG}' and s.status = 'OPEN') as sessao_aberta_visivel,
  (select count(*) from public.experiences where kind = 'REGULAR' and status = 'PUBLISHED') as regulares_visiveis,
  has_function_privilege('anon', 'public.create_pre_reservation(uuid, text, text, text, text, integer, text, uuid)', 'execute') as pode_pre_reservar,
  case when to_regprocedure('public.create_reservation(uuid, text, text, text, integer, text)') is null then null
       else has_function_privilege('anon', to_regprocedure('public.create_reservation(uuid, text, text, text, integer, text)'), 'execute') end as create_reservation_executavel;
`;
}

export function publicacaoRollbackSql() {
  return `-- ESSÊNCIA — DESFAZER A PUBLICAÇÃO (GERADO; NÃO EDITAR À MÃO)
--
-- Rodar SÓ COM AUTORIZAÇÃO. Se EVENTS_PUBLIC_ENABLED estiver ligada, remover a
-- variável e fazer o redeploy primeiro: sem isso, o site mostra a seção vazia até o
-- próximo deploy. Volta o evento a rascunho pelo caminho do painel e desliga o
-- interruptor. Recusa, sem mudar nada, se houver sessão fora de CLOSED, reserva ou
-- inscrição: nesse caso, para tirar do ar, basta desligar o interruptor e decidir à parte.

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
    raise exception 'ESSENCIA_ATOR: esperado 1 administrador ativo, encontrado %', actors;
  end if;
  select * into target from public.experiences where slug = '${ESSENCIA_SLUG}' and kind = 'EVENT' for update;
  if not found then
    raise exception 'ESSENCIA_DESFAZER_RECUSADO: evento ausente';
  end if;
  if exists (select 1 from public.sessions s where s.experience_id = target.id and s.status <> 'CLOSED')
     or exists (select 1 from public.reservations r join public.sessions s on s.id = r.session_id where s.experience_id = target.id)
     or exists (select 1 from public.waitlist_entries w join public.sessions s on s.id = w.session_id where s.experience_id = target.id) then
    raise exception 'ESSENCIA_DESFAZER_RECUSADO: sessão aberta, reserva ou inscrição existente';
  end if;
  if target.status = 'PUBLISHED' then
    perform public.admin_update_event(actor, target.id, target.title, target.summary, 'DRAFT', target.image_url, target.display_order, target.editorial_content);
  end if;
  update public.special_event_settings set publication_enabled = false, updated_at = now() where singleton;
  raise notice 'ESSENCIA_PUBLICACAO_DESFEITA';
end;
$desfazer$;

commit;
`;
}

if (process.argv[1]?.endsWith("essencia-publicacao-sql.ts")) {
  writeFileSync("supabase/diagnostics/essencia_publicacao_preflight.sql", publicacaoPreflightSql(), "utf8");
  writeFileSync("supabase/maintenance/essencia_publicacao.sql", publicacaoSql(), "utf8");
  writeFileSync("supabase/diagnostics/essencia_publicacao_postcheck.sql", publicacaoPostcheckSql(), "utf8");
  writeFileSync("supabase/diagnostics/essencia_publicacao_anon_check.sql", publicacaoAnonCheckSql(), "utf8");
  writeFileSync("supabase/rollback/essencia_publicacao.rollback.sql", publicacaoRollbackSql(), "utf8");
  console.info("Gerados os cinco scripts de publicação do ESSÊNCIA.");
}
