/**
 * Gera a atualização do conteúdo do ESSÊNCIA já cadastrado em rascunho: preflight,
 * atualização, postcheck e rollback. De (`essencia-editorial-v1.json`, a versão que
 * está em produção) para (a fixture atual). O teste
 * `tests/special-events-essencia-editorial.test.ts` falha se o SQL divergir.
 *
 *   pnpm events:essencia-editorial-sql
 *
 * Não fala com o banco. O SQL gerado é executado à mão, no SQL Editor, só com
 * autorização. Só muda `editorial_content`: nem status, nem sessão, nem duração.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { validateEventEditorial } from "../../lib/events/editorial.ts";
import { ESSENCIA_CAPACITY, ESSENCIA_EDITORIAL, ESSENCIA_SLUG, ESSENCIA_STARTS_AT } from "../../lib/events/fixtures/essencia.ts";
import { ESSENCIA_ADMIN_EMAIL } from "./essencia-cadastro-sql.ts";

const V1 = JSON.stringify(JSON.parse(readFileSync(new URL("./essencia-editorial-v1.json", import.meta.url), "utf8")));
const V2 = JSON.stringify(ESSENCIA_EDITORIAL);

const SESSION = `s.status = 'CLOSED' and to_char(s.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') = '${ESSENCIA_STARTS_AT.slice(0, 16)}' and s.duration_minutes = 210 and s.price_cents = 15000 and s.capacity = ${ESSENCIA_CAPACITY}`;
const ACTOR = `from public.admin_users au join auth.users u on u.id = au.user_id
  where lower(u.email) = '${ESSENCIA_ADMIN_EMAIL}' and au.is_active and au.role = 'ADMIN'`;

function diagnostic(header: string, token: string, expected: { name: string; json: string; other: string; otherLabel: string }) {
  return `${header}

with versions as (
  select $json$${expected.json}$json$::jsonb as expected, $json$${expected.other}$json$::jsonb as other
),
ev as (
  select e.*, to_jsonb(e) ->> 'active' as legacy_active from public.experiences e where e.slug = '${ESSENCIA_SLUG}' and e.kind = 'EVENT'
),
sess as (
  select s.* from public.sessions s join ev on ev.id = s.experience_id
),
checks as (
  select 'EVENTO_EM_RASCUNHO' as check_name,
         coalesce((select kind || '/' || status || ', active=' || coalesce(legacy_active, 'sem coluna') from ev), 'ausente') as result,
         case when (select status = 'DRAFT' from ev) then 'OK' else 'FALHOU' end as status
  union all
  select '${expected.name}',
         case when (select ev.editorial_content = v.expected from ev, versions v) then 'é a versão esperada'
              when (select ev.editorial_content = v.other from ev, versions v) then '${expected.otherLabel}'
              else 'DIFERENTE das duas versões' end,
         case when (select ev.editorial_content = v.expected and public.experience_editorial_is_publishable(ev.editorial_content) from ev, versions v) then 'OK'
              when (select ev.editorial_content = v.other from ev, versions v) then 'ATENCAO'
              else 'FALHOU' end
  union all
  select 'SESSAO_INALTERADA',
         coalesce((select string_agg(s.status::text || ' ' || s.capacity::text || ' vagas ' || s.price_cents::text || ' centavos ' || s.duration_minutes::text || ' min', ', ') from sess s), 'nenhuma'),
         case when (select count(*) from sess s where ${SESSION}) = 1 and (select count(*) from sess) = 1 then 'OK' else 'FALHOU' end
  union all
  select 'INTERRUPTOR_DESLIGADO',
         coalesce((select case when publication_enabled then 'ligado' else 'desligado' end from public.special_event_settings where singleton), 'ausente'),
         case when (select publication_enabled from public.special_event_settings where singleton) is false then 'OK' else 'FALHOU' end
  union all
  select 'ADMINISTRADOR_DO_ATO',
         (select count(*)::text ${ACTOR}),
         case when (select count(*) ${ACTOR}) = 1 then 'OK' else 'FALHOU' end
  union all
  select 'RESERVAS_E_INSCRICOES_DO_EVENTO',
         (select count(*) from public.reservations r join sess s on s.id = r.session_id)::text || ' reservas, ' || (select count(*) from public.waitlist_entries w join sess s on s.id = w.session_id)::text || ' inscrições',
         case when exists (select 1 from public.reservations r join sess s on s.id = r.session_id) or exists (select 1 from public.waitlist_entries w join sess s on s.id = w.session_id) then 'FALHOU' else 'OK' end
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
  select * into target from public.experiences where slug = '${ESSENCIA_SLUG}' and kind = 'EVENT' for update;
  if not found or target.status <> 'DRAFT' then
    raise exception '${code}_ESTADO: evento ausente ou fora do rascunho';
  end if;
  if target.editorial_content <> $json$${from}$json$::jsonb then
    raise exception '${code}_CONTEUDO: o conteúdo atual não é a versão de origem';
  end if;
  if (select publication_enabled from public.special_event_settings where singleton) is distinct from false then
    raise exception '${code}_INTERRUPTOR: esperado desligado';
  end if;
  if (select count(*) from public.sessions s where s.experience_id = target.id) <> 1
     or (select count(*) from public.sessions s where s.experience_id = target.id and ${SESSION}) <> 1 then
    raise exception '${code}_SESSAO: esperada uma sessão CLOSED com os dados aprovados';
  end if;
  if exists (select 1 from public.reservations r join public.sessions s on s.id = r.session_id where s.experience_id = target.id)
     or exists (select 1 from public.waitlist_entries w join public.sessions s on s.id = w.session_id where s.experience_id = target.id) then
    raise exception '${code}_RESERVAS: o evento já tem reserva ou inscrição';
  end if;

  select md5(s::text) into session_before from public.sessions s where s.experience_id = target.id;
  select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) into regulars_before from public.list_public_regular_catalog() x;

  perform public.admin_update_event(actor, target.id, target.title, target.summary, 'DRAFT', target.image_url, target.display_order, $json$${to}$json$::jsonb);

  if (select status from public.experiences where id = target.id) <> 'DRAFT'
     or (select editorial_content from public.experiences where id = target.id) <> $json$${to}$json$::jsonb then
    raise exception '${code}_RESULTADO: o conteúdo ou o status não ficaram como esperado';
  end if;
  if not public.experience_editorial_is_publishable((select editorial_content from public.experiences where id = target.id)) then
    raise exception '${code}_RESULTADO: conteúdo fora da régua de publicação';
  end if;
  if (select md5(s::text) from public.sessions s where s.experience_id = target.id) <> session_before then
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

export function editorialPreflightSql() {
  return diagnostic(`-- ESSÊNCIA — ATUALIZAÇÃO DO CONTEÚDO — PREFLIGHT (GERADO; SOMENTE LEITURA)
--
-- Gerado por \`pnpm events:essencia-editorial-sql\`. Rodar ANTES de
-- essencia_editorial_update.sql. A última linha, ESSENCIA_EDITORIAL_PREFLIGHT_OK,
-- precisa estar OK. CONTEUDO_DE_ORIGEM em ATENCAO significa que já foi atualizado.`,
  "ESSENCIA_EDITORIAL_PREFLIGHT_OK", { name: "CONTEUDO_DE_ORIGEM", json: V1, other: V2, otherLabel: "já é a versão nova" });
}

export function editorialUpdateSql() {
  const editorial = validateEventEditorial(ESSENCIA_EDITORIAL);
  if (!editorial.success) throw new Error(`Conteúdo do ESSÊNCIA inválido: ${editorial.errors.join("; ")}`);
  return `-- ESSÊNCIA — ATUALIZAÇÃO DO CONTEÚDO EM RASCUNHO (GERADO; NÃO EDITAR À MÃO)
--
-- Rodar no SQL Editor SÓ COM AUTORIZAÇÃO, depois de essencia_editorial_preflight.sql.
-- Numa transação, pelo caminho do painel (admin_update_event, com auditoria), troca só
-- o conteúdo editorial. Mantém título, resumo, imagem, ordem e status DRAFT. NÃO publica,
-- NÃO liga o interruptor, NÃO toca sessão, preço, vagas, duração, reserva nem variável.
-- Qualquer conferência que falhe desfaz tudo.

${change("atualizacao", "ESSENCIA_EDITORIAL", V1, V2)}`;
}

export function editorialPostcheckSql() {
  return diagnostic(`-- ESSÊNCIA — ATUALIZAÇÃO DO CONTEÚDO — POSTCHECK (GERADO; SOMENTE LEITURA)
--
-- ASSINATURA_DAS_FUNCOES e LISTAGENS_REGULARES precisam ser iguais às do preflight;
-- RESERVAS_POR_STATUS só muda por compra regular ou expiração. A última linha,
-- ESSENCIA_EDITORIAL_POSTCHECK_OK, precisa estar OK.`,
  "ESSENCIA_EDITORIAL_POSTCHECK_OK", { name: "CONTEUDO_NOVO", json: V2, other: V1, otherLabel: "ainda é a versão anterior" });
}

export function editorialRollbackSql() {
  return `-- ESSÊNCIA — DESFAZER A ATUALIZAÇÃO DO CONTEÚDO (GERADO; NÃO EDITAR À MÃO)
--
-- Rodar SÓ COM AUTORIZAÇÃO. Devolve o conteúdo anterior, com o evento ainda em
-- rascunho. Recusa, sem mudar nada, se o evento já foi publicado ou o conteúdo não é
-- a versão nova. Publicado: primeiro desfazer a publicação.

${change("desfazer", "ESSENCIA_EDITORIAL_DESFAZER", V2, V1)}`;
}

if (process.argv[1]?.endsWith("essencia-editorial-sql.ts")) {
  writeFileSync("supabase/diagnostics/essencia_editorial_preflight.sql", editorialPreflightSql(), "utf8");
  writeFileSync("supabase/maintenance/essencia_editorial_update.sql", editorialUpdateSql(), "utf8");
  writeFileSync("supabase/diagnostics/essencia_editorial_postcheck.sql", editorialPostcheckSql(), "utf8");
  writeFileSync("supabase/rollback/essencia_editorial_update.rollback.sql", editorialRollbackSql(), "utf8");
  console.info("Gerados os quatro scripts de atualização do conteúdo do ESSÊNCIA.");
}
