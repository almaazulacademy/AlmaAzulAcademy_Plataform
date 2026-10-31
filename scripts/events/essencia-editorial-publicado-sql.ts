/**
 * Gera a atualização do conteúdo do ESSÊNCIA já PUBLICADO, com a sessão aberta e
 * reservas reais: preflight, atualização, postcheck e rollback. De
 * `essencia-editorial-v2.json` (a versão em produção) para a fixture atual. O teste
 * `tests/special-events-essencia-editorial-publicado.test.ts` falha se o SQL divergir.
 *
 *   pnpm events:essencia-editorial-publicado-sql
 *
 * Não fala com o banco. O SQL gerado é executado à mão, no SQL Editor, só com
 * autorização. Muda só `editorial_content`, e não exige ausência de reservas.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { validateEventEditorial } from "../../lib/events/editorial.ts";
import { ESSENCIA_CAPACITY, ESSENCIA_EDITORIAL, ESSENCIA_SLUG, ESSENCIA_STARTS_AT } from "../../lib/events/fixtures/essencia.ts";
import { ESSENCIA_ADMIN_EMAIL } from "./essencia-cadastro-sql.ts";

const V2 = JSON.stringify(JSON.parse(readFileSync(new URL("./essencia-editorial-v2.json", import.meta.url), "utf8")));
const V3 = JSON.stringify(ESSENCIA_EDITORIAL);

/** Tudo da sessão que não pode mudar, sem o status: fechar a sessão é decisão da operação. */
const SESSION_DATA = `to_char(s.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') = '${ESSENCIA_STARTS_AT.slice(0, 16)}' and s.duration_minutes = 210 and s.price_cents = 15000 and s.capacity = ${ESSENCIA_CAPACITY}`;
const ACTOR = `from public.admin_users au join auth.users u on u.id = au.user_id
  where lower(u.email) = '${ESSENCIA_ADMIN_EMAIL}' and au.is_active and au.role = 'ADMIN'`;

function diagnostic(header: string, token: string, name: string, expected: string, other: string, otherLabel: string) {
  return `${header}

with versions as (
  select $json$${expected}$json$::jsonb as expected, $json$${other}$json$::jsonb as other
),
ev as (
  select e.* from public.experiences e where e.slug = '${ESSENCIA_SLUG}' and e.kind = 'EVENT'
),
sess as (
  select s.* from public.sessions s join ev on ev.id = s.experience_id
),
checks as (
  select 'EVENTO_PUBLICADO' as check_name,
         coalesce((select kind || '/' || status from ev), 'ausente') as result,
         case when (select status = 'PUBLISHED' from ev) then 'OK' else 'FALHOU' end as status
  union all
  select 'INTERRUPTOR_LIGADO',
         coalesce((select case when publication_enabled then 'ligado' else 'desligado' end from public.special_event_settings where singleton), 'ausente'),
         case when (select publication_enabled from public.special_event_settings where singleton) then 'OK' else 'FALHOU' end
  union all
  select '${name}',
         case when (select ev.editorial_content = v.expected from ev, versions v) then 'é a versão esperada'
              when (select ev.editorial_content = v.other from ev, versions v) then '${otherLabel}'
              else 'DIFERENTE das duas versões' end,
         case when (select ev.editorial_content = v.expected and public.experience_editorial_is_publishable(ev.editorial_content) from ev, versions v) then 'OK'
              when (select ev.editorial_content = v.other from ev, versions v) then 'ATENCAO'
              else 'FALHOU' end
  union all
  select 'SESSAO',
         coalesce((select string_agg(s.status::text || ' ' || s.capacity::text || ' vagas ' || s.price_cents::text || ' centavos ' || s.duration_minutes::text || ' min', ', ') from sess s), 'nenhuma'),
         case when (select count(*) from sess) <> 1 or (select count(*) from sess s where ${SESSION_DATA}) <> 1 then 'FALHOU'
              when (select status from sess) = 'OPEN' then 'OK'
              else 'ATENCAO' end
  union all
  select 'LEITURA_PUBLICA',
         (select count(*)::text from public.get_public_event('${ESSENCIA_SLUG}')) || ' evento, ' || coalesce((select string_agg(x.availability, ', ') from public.list_public_event_sessions('${ESSENCIA_SLUG}') x), 'sem sessão'),
         case when (select count(*) from public.get_public_event('${ESSENCIA_SLUG}')) = 1 then 'OK' else 'FALHOU' end
  union all
  select 'ADMINISTRADOR_DO_ATO',
         (select count(*)::text ${ACTOR}),
         case when (select count(*) ${ACTOR}) = 1 then 'OK' else 'FALHOU' end
  union all
  select 'ASSINATURA_DAS_FUNCOES',
         (select count(*)::text || ' funções, ' || md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), '|' order by p.oid::regprocedure::text)) from pg_proc p where p.pronamespace = 'public'::regnamespace),
         'OK'
  union all
  select 'LISTAGENS_REGULARES',
         (select count(*)::text from public.list_public_regular_experiences()) || ' experiências, ' || (select count(*)::text from public.list_public_regular_catalog()) || ' no catálogo',
         'OK'
  union all
  select 'RESERVAS_DO_EVENTO',
         coalesce((select string_agg(status || '=' || n, ', ' order by status) from (select r.status::text, count(*) n from public.reservations r join sess s on s.id = r.session_id group by 1) x), 'nenhuma') || '; ' || coalesce((select public.available_spots(id)::text from sess), '?') || ' vagas',
         'OK'
)
select check_name, result, status from checks
union all
select '${token}',
       (select count(*) filter (where status = 'FALHOU')::text || ' falha(s), ' || count(*) filter (where status = 'ATENCAO')::text || ' ponto(s) de atenção' from checks),
       case when exists (select 1 from checks where status = 'FALHOU') then 'FALHOU' else 'OK' end;
`;
}

function change(block: string, code: string, from: string, to: string) {
  return `begin;
set local lock_timeout = '5s';

do $${block}$
declare
  actor uuid;
  actors integer;
  target public.experiences%rowtype;
  session_before text;
  regulars_before text;
begin
  select count(*), min(au.user_id::text)::uuid into actors, actor ${ACTOR};
  if actors <> 1 then
    raise exception 'ESSENCIA_ATOR: esperado 1 administrador ativo, encontrado %', actors;
  end if;
  -- NO KEY UPDATE: não bloqueia a checagem de chave estrangeira de uma reserva em andamento.
  select * into target from public.experiences where slug = '${ESSENCIA_SLUG}' and kind = 'EVENT' for no key update;
  if not found or target.status <> 'PUBLISHED' then
    raise exception '${code}_ESTADO: evento ausente ou fora de PUBLISHED';
  end if;
  if target.editorial_content <> $json$${from}$json$::jsonb then
    raise exception '${code}_CONTEUDO: o conteúdo atual não é a versão de origem';
  end if;
  if (select publication_enabled from public.special_event_settings where singleton) is distinct from true then
    raise exception '${code}_INTERRUPTOR: esperado ligado';
  end if;
  if (select count(*) from public.sessions s where s.experience_id = target.id) <> 1
     or (select count(*) from public.sessions s where s.experience_id = target.id and ${SESSION_DATA}) <> 1 then
    raise exception '${code}_SESSAO: esperada uma sessão com os dados aprovados';
  end if;

  select md5(concat_ws('|', s.status, s.starts_at, s.duration_minutes, s.price_cents, s.capacity)) into session_before from public.sessions s where s.experience_id = target.id;
  select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) into regulars_before from public.list_public_regular_catalog() x;

  perform public.admin_update_event(actor, target.id, target.title, target.summary, 'PUBLISHED', target.image_url, target.display_order, $json$${to}$json$::jsonb);

  if (select status from public.experiences where id = target.id) <> 'PUBLISHED'
     or (select editorial_content from public.experiences where id = target.id) <> $json$${to}$json$::jsonb then
    raise exception '${code}_RESULTADO: o conteúdo ou o status não ficaram como esperado';
  end if;
  if not public.experience_editorial_is_publishable((select editorial_content from public.experiences where id = target.id)) then
    raise exception '${code}_RESULTADO: conteúdo fora da régua de publicação';
  end if;
  if (select md5(concat_ws('|', s.status, s.starts_at, s.duration_minutes, s.price_cents, s.capacity)) from public.sessions s where s.experience_id = target.id) <> session_before then
    raise exception '${code}_SESSAO_ALTERADA: a sessão não pode mudar';
  end if;
  if (select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.list_public_regular_catalog() x) <> regulars_before then
    raise exception '${code}_REGULARES: o catálogo regular mudou';
  end if;
  raise notice '${code}_OK';
end;
$${block}$;

commit;
`;
}

export function publicadoPreflightSql() {
  return diagnostic(`-- ESSÊNCIA PUBLICADO — ATUALIZAÇÃO DO CONTEÚDO — PREFLIGHT (GERADO; SOMENTE LEITURA)
--
-- Gerado por \`pnpm events:essencia-editorial-publicado-sql\`. Rodar ANTES de
-- essencia_editorial_publicado_update.sql e DEPOIS do deploy que traz a logo nova. A
-- última linha, ESSENCIA_PUBLICADO_PREFLIGHT_OK, precisa estar OK. CONTEUDO_DE_ORIGEM em
-- ATENCAO significa que já foi atualizado. Reservas existentes são esperadas.`,
  "ESSENCIA_PUBLICADO_PREFLIGHT_OK", "CONTEUDO_DE_ORIGEM", V2, V3, "já é a versão nova");
}

export function publicadoUpdateSql() {
  const editorial = validateEventEditorial(ESSENCIA_EDITORIAL);
  if (!editorial.success) throw new Error(`Conteúdo do ESSÊNCIA inválido: ${editorial.errors.join("; ")}`);
  return `-- ESSÊNCIA PUBLICADO — ATUALIZAÇÃO DO CONTEÚDO (GERADO; NÃO EDITAR À MÃO)
--
-- Rodar no SQL Editor SÓ COM AUTORIZAÇÃO, depois de essencia_editorial_publicado_preflight.sql.
-- Numa transação curta, pelo caminho do painel (admin_update_event, com auditoria), troca só
-- o conteúdo editorial. Evento segue PUBLISHED. NÃO toca sessão, preço, vagas, duração,
-- reserva, pagamento, QR Code, e-mail nem variável. Qualquer conferência que falhe desfaz
-- tudo. Se der lock_timeout, nada foi gravado: esperar um instante e rodar de novo.

${change("atualizacao", "ESSENCIA_PUBLICADO", V2, V3)}`;
}

export function publicadoPostcheckSql() {
  return diagnostic(`-- ESSÊNCIA PUBLICADO — ATUALIZAÇÃO DO CONTEÚDO — POSTCHECK (GERADO; SOMENTE LEITURA)
--
-- ASSINATURA_DAS_FUNCOES e LISTAGENS_REGULARES precisam ser iguais às do preflight;
-- RESERVAS_DO_EVENTO só muda por venda, expiração ou cancelamento. A última linha,
-- ESSENCIA_PUBLICADO_POSTCHECK_OK, precisa estar OK.`,
  "ESSENCIA_PUBLICADO_POSTCHECK_OK", "CONTEUDO_NOVO", V3, V2, "ainda é a versão anterior");
}

export function publicadoRollbackSql() {
  return `-- ESSÊNCIA PUBLICADO — DESFAZER A ATUALIZAÇÃO DO CONTEÚDO (GERADO; NÃO EDITAR À MÃO)
--
-- Rodar SÓ COM AUTORIZAÇÃO. Devolve o conteúdo anterior, com o evento ainda PUBLISHED e sem
-- tocar em sessão nem reservas. Recusa, sem mudar nada, se o conteúdo atual não for a
-- versão nova. A logo pode continuar no código: ela só aparece se o conteúdo apontar para ela.

${change("desfazer", "ESSENCIA_PUBLICADO_DESFAZER", V3, V2)}`;
}

if (process.argv[1]?.endsWith("essencia-editorial-publicado-sql.ts")) {
  writeFileSync("supabase/diagnostics/essencia_editorial_publicado_preflight.sql", publicadoPreflightSql(), "utf8");
  writeFileSync("supabase/maintenance/essencia_editorial_publicado_update.sql", publicadoUpdateSql(), "utf8");
  writeFileSync("supabase/diagnostics/essencia_editorial_publicado_postcheck.sql", publicadoPostcheckSql(), "utf8");
  writeFileSync("supabase/rollback/essencia_editorial_publicado_update.rollback.sql", publicadoRollbackSql(), "utf8");
  console.info("Gerados os quatro scripts de atualização do ESSÊNCIA publicado.");
}
