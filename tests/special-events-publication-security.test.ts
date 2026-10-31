/**
 * Eventos especiais — segurança antes da abertura (migration 202610310004).
 *
 * Testes de permissão com papéis de verdade: cada consulta roda com `set role`
 * como `anon`, `authenticated` e `service_role`, contra um banco com o que a
 * auditoria de produção mostrou e o repositório não tem: colunas legadas, as
 * políticas legadas, o SELECT dos dois papéis nas tabelas e `create_reservation`.
 * O evento nunca pode aparecer nem ser reservado com o interruptor desligado, e
 * as experiências regulares precisam responder igual antes e depois.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ESSENCIA_CAPACITY, ESSENCIA_EDITORIAL } from "../lib/events/fixtures/essencia.ts";
import { applyMigration, fullDatabase } from "./support/full-database.ts";
import { ADMIN, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

const MIGRATION = "202610310004_event_publication_security.sql";
const PREVIOUS = "202610310003_experiences_active_on_insert.sql";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const PREFLIGHT = source("supabase/diagnostics/event_publication_security_preflight.sql");
const POSTCHECK = source("supabase/diagnostics/event_publication_security_postcheck.sql");
const ROLLBACK = source("supabase/rollback/202610310004_event_publication_security.rollback.sql");

/** O que a auditoria de 31/10/2026 mostrou em produção e as migrations não criam. */
const PRODUCTION_ONLY = `
  alter table public.experiences
    add column eyebrow text not null default 'legado',
    add column short_description text not null default 'legado',
    add column location text not null default 'legado',
    add column cover_image text not null default 'legado',
    add column gallery jsonb not null default '[]'::jsonb,
    add column included jsonb not null default '[]'::jsonb,
    add column active boolean not null default true;
  alter table public.experiences
    alter column eyebrow drop default, alter column short_description drop default,
    alter column location drop default, alter column cover_image drop default;
  update public.experiences set active = (status = 'PUBLISHED');

  create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$ select public.is_active_admin(auth.uid()) $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant execute on function public.is_admin() to anon, authenticated, service_role;

  create policy "Admins manage experiences" on public.experiences for all using (public.is_admin()) with check (public.is_admin());
  create policy "Public can view active experiences" on public.experiences for select using (active = true or public.is_admin());
  create policy "Admins manage sessions" on public.sessions for all using (public.is_admin()) with check (public.is_admin());
  create policy "Public can view scheduled future sessions" on public.sessions for select using ((status = 'OPEN' and starts_at > now()) or public.is_admin());

  grant usage on schema public to anon, authenticated, service_role;
  grant select on public.experiences, public.sessions, public.bases to anon, authenticated, service_role;

  create function public.create_reservation(p_session_id uuid, p_customer_name text, p_customer_email text, p_customer_phone text, p_participants integer, p_pix_code text)
  returns uuid language plpgsql security definer set search_path to '' as $f$
  declare target_session public.sessions%rowtype;
  begin
    if p_participants < 1 or p_participants > 10 then raise exception 'invalid_participant_count'; end if;
    select * into target_session from public.sessions where id = p_session_id for update;
    if target_session.id is null or target_session.status <> 'scheduled' or target_session.starts_at <= now() then raise exception 'session_unavailable'; end if;
    return null;
  end;
  $f$;
  grant execute on function public.create_reservation(uuid, text, text, text, integer, text) to public, anon, authenticated, service_role;
`;

async function productionLike(until: string = PREVIOUS) {
  const db = await fullDatabase({ until });
  await db.exec(PRODUCTION_ONLY);
  const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
  return { db, fx };
}

type Db = Awaited<ReturnType<typeof productionLike>>["db"];

async function as<T>(db: Db, role: string, run: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}`);
  try {
    return await run();
  } finally {
    await db.exec(`reset role`);
  }
}

async function report(db: Db, sql: string) {
  return new Map(((await db.query(sql)).rows as Array<{ check_name: string; result: string; status: string }>).map((row) => [row.check_name, row]));
}

async function setSwitch(db: Db, on: boolean) {
  await db.query(`update public.special_event_settings set publication_enabled = $1`, [on]);
}

/** O ESSÊNCIA pelo caminho real: rascunho, sessão fechada. */
async function createEvent(db: Db, fx: Awaited<ReturnType<typeof productionLike>>["fx"]) {
  const created = await fx.call(
    `public.admin_create_event($1::uuid, $2::uuid, 'essencia', 'ESSÊNCIA — Corpo, Mente e Natureza', 'Resumo do evento', $3::jsonb, null, now() + interval '9 days', 210, 15000, $4)`,
    [ADMIN, fx.SUNSET_CONCHA.base_id, JSON.stringify(ESSENCIA_EDITORIAL), ESSENCIA_CAPACITY],
  );
  return { experienceId: created.experienceId as string, sessionId: created.sessionId as string };
}

async function publish(db: Db, experienceId: string) {
  await setSwitch(db, true);
  await db.query(`update public.experiences set status = 'PUBLISHED' where id = $1::uuid`, [experienceId]);
}

/** Todas as leituras alcançáveis, cada uma com o número de linhas do evento. */
async function reads(db: Db, sessionId: string) {
  const n = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows.length;
  return {
    tabela_experiences: await n(`select 1 from public.experiences where slug = 'essencia'`),
    tabela_sessions: await n(`select 1 from public.sessions where id = $1::uuid`, [sessionId]),
    list_public_experiences: await n(`select 1 from public.list_public_experiences() where slug = 'essencia'`),
    list_public_catalog: await n(`select 1 from public.list_public_catalog() where slug = 'essencia'`),
    get_public_experience: await n(`select 1 from public.get_public_experience('essencia')`),
    list_open_sessions: await n(`select 1 from public.list_open_sessions('essencia')`),
    list_public_sessions: await n(`select 1 from public.list_public_sessions('essencia')`),
    get_booking_session: await n(`select 1 from public.get_booking_session($1::uuid)`, [sessionId]),
    public_session_context: await n(`select 1 from public.public_session_context($1::uuid)`, [sessionId]),
    list_public_events: await n(`select 1 from public.list_public_events() where slug = 'essencia'`),
    get_public_event: await n(`select 1 from public.get_public_event('essencia')`),
    list_public_event_sessions: await n(`select 1 from public.list_public_event_sessions('essencia')`),
    regulares: await n(`select 1 from public.list_public_regular_experiences() where slug = 'essencia'`),
  };
}

const NOTHING = { tabela_experiences: 0, tabela_sessions: 0, list_public_experiences: 0, list_public_catalog: 0, get_public_experience: 0, list_open_sessions: 0, list_public_sessions: 0, get_booking_session: 0, public_session_context: 0, list_public_events: 0, get_public_event: 0, list_public_event_sessions: 0, regulares: 0 };
const PUBLIC_ROLES = ["anon", "authenticated"] as const;

test("sem a migration: reproduz os caminhos de exposição da auditoria", async () => {
  const { db, fx } = await productionLike();
  const event = await createEvent(db, fx);
  await db.query(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [event.sessionId]);
  assert.equal((await as(db, "anon", () => reads(db, event.sessionId))).tabela_sessions, 1, "sessão aberta de rascunho é legível");
  await publish(db, event.experienceId);
  await setSwitch(db, false);
  const hidden = await as(db, "anon", () => reads(db, event.sessionId));
  for (const path of ["tabela_experiences", "list_public_experiences", "list_public_catalog", "get_public_experience", "list_open_sessions", "list_public_sessions", "get_booking_session", "public_session_context"] as const) {
    assert.equal(hidden[path], 1, path);
  }
  await assert.rejects(as(db, "anon", () => db.query(`select public.create_reservation($1::uuid, 'A B', 'a@b.co', '1', 1, 'x')`, [event.sessionId])), /invalid input value for enum/, "executável, e falha só no rótulo antigo");
  await db.close();
});

test("com a migration: anon e authenticated não veem o evento em nenhum estado fechado, por slug nem por id", async () => {
  const { db, fx } = await productionLike();
  await applyMigration(db, MIGRATION);
  const event = await createEvent(db, fx);
  const check = async (label: string) => {
    for (const role of PUBLIC_ROLES) assert.deepEqual(await as(db, role, () => reads(db, event.sessionId)), NOTHING, `${label} / ${role}`);
  };
  await check("rascunho, sessão fechada");
  await db.query(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [event.sessionId]);
  await check("rascunho, sessão aberta");
  await publish(db, event.experienceId);
  await setSwitch(db, false);
  await check("publicado, sessão aberta, interruptor desligado");
  await db.query(`update public.sessions set status = 'CLOSED' where id = $1::uuid`, [event.sessionId]);
  await check("publicado, sessão fechada, interruptor desligado");
  await db.close();
});

test("transições: active e status não abrem o evento; religar só mostra o que está publicado", async () => {
  const { db, fx } = await productionLike();
  await applyMigration(db, MIGRATION);
  const event = await createEvent(db, fx);
  await db.query(`update public.experiences set active = true where id = $1::uuid`, [event.experienceId]);
  await db.query(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [event.sessionId]);
  assert.deepEqual(await as(db, "anon", () => reads(db, event.sessionId)), NOTHING, "rascunho com active = true");
  await setSwitch(db, true);
  assert.deepEqual(await as(db, "anon", () => reads(db, event.sessionId)), NOTHING, "interruptor ligado não abre rascunho");

  await db.query(`update public.experiences set status = 'PUBLISHED' where id = $1::uuid`, [event.experienceId]);
  const open = await as(db, "anon", () => reads(db, event.sessionId));
  for (const [path, count] of Object.entries(open)) assert.equal(count, path === "regulares" ? 0 : 1, `publicado e ligado: ${path}`);

  await db.query(`update public.experiences set status = 'DRAFT' where id = $1::uuid`, [event.experienceId]);
  assert.deepEqual(await as(db, "anon", () => reads(db, event.sessionId)), NOTHING, "voltou a rascunho com active = true");
  await db.close();
});

test("service_role: ignora RLS na tabela, como o servidor precisa, mas as leituras públicas seguem fechadas", async () => {
  const { db, fx } = await productionLike();
  await applyMigration(db, MIGRATION);
  const event = await createEvent(db, fx);
  const seen = await as(db, "service_role", () => reads(db, event.sessionId));
  assert.deepEqual(seen, { ...NOTHING, tabela_experiences: 1, tabela_sessions: 1 });
  await db.close();
});

test("administrador autenticado vê o evento oculto na tabela; usuário comum não", async () => {
  const { db, fx } = await productionLike();
  await applyMigration(db, MIGRATION);
  const event = await createEvent(db, fx);
  const view = async (uid: string) => {
    await db.query(`select set_config('test.uid', $1, false)`, [uid]);
    const result = await as(db, "authenticated", () => reads(db, event.sessionId));
    await db.query(`select set_config('test.uid', '', false)`);
    return result;
  };
  assert.equal((await view(ADMIN)).tabela_experiences, 1);
  assert.equal((await view("00000000-0000-4000-8000-00000000abcd")).tabela_experiences, 0);
  await db.close();
});

test("reserva e escrita: nada passa pela chave pública; com o interruptor desligado, nem pelo servidor", async () => {
  const { db, fx } = await productionLike();
  await applyMigration(db, MIGRATION);
  const event = await createEvent(db, fx);
  await db.query(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [event.sessionId]);
  await publish(db, event.experienceId);
  await setSwitch(db, false);
  const reservation = `select public.create_pre_reservation($1::uuid, 'Pessoa Teste', '52998224725', '+5561988887777', 'p@teste.local', 1, null, gen_random_uuid())`;
  for (const role of PUBLIC_ROLES) {
    await assert.rejects(as(db, role, () => db.query(reservation, [event.sessionId])), /permission denied/, `${role}: create_pre_reservation`);
    await assert.rejects(as(db, role, () => db.query(`update public.experiences set status = 'PUBLISHED'`)), /permission denied/, `${role}: update`);
    await assert.rejects(as(db, role, () => db.query(`insert into public.reservations (session_id) values ($1::uuid)`, [event.sessionId])), /permission denied/, `${role}: insert`);
    await assert.rejects(as(db, role, () => db.query(`select * from public.special_event_settings`)), /permission denied/, `${role}: interruptor`);
  }
  for (const role of [...PUBLIC_ROLES, "service_role"]) {
    await assert.rejects(as(db, role, () => db.query(`select public.create_reservation($1::uuid, 'A B', 'a@b.co', '1', 1, 'x')`, [event.sessionId])), /permission denied/, `${role}: create_reservation`);
  }
  await assert.rejects(as(db, "service_role", () => db.query(reservation, [event.sessionId])), /EVENT_NOT_PUBLIC/);
  await assert.rejects(db.query(`select public.create_pre_reservation($1::uuid, 'Pessoa Dono', '52998224725', '+5561988887777', 'o@teste.local', 1, null, gen_random_uuid())`, [event.sessionId]), /EVENT_NOT_PUBLIC/);
  assert.equal((await db.query(`select 1 from public.reservations where session_id = $1::uuid`, [event.sessionId])).rows.length, 0);

  await setSwitch(db, true);
  const accepted = (await as(db, "service_role", () => db.query<Row>(reservation, [event.sessionId]))).rows[0];
  assert.ok(accepted, "ligado, a reserva do servidor volta a passar");
  await db.close();
});

test("inscrição na lista: gatilho recusa evento oculto; inscrição existente e cancelamento continuam", async () => {
  const { db, fx } = await productionLike();
  await applyMigration(db, MIGRATION);
  const event = await createEvent(db, fx);
  await db.query(`update public.sessions set status = 'OPEN', capacity = 1 where id = $1::uuid`, [event.sessionId]);
  await publish(db, event.experienceId);
  const booking = await fx.reserve(event.sessionId, 1);
  const join = (email: string) => db.query<Row>(`select public.waitlist_join($1::uuid, 'Pessoa Lista', $2, '+5561970000001', 1, null, '') as v`, [event.sessionId, email]);
  assert.equal((await join("antes@teste.local")).rows[0].v.status, "ACCEPTED");
  await setSwitch(db, false);
  await assert.rejects(join("depois@teste.local"), /EVENT_NOT_PUBLIC/);
  // Quem já comprou continua: a linha existe, e nada do pós-venda passa por INSERT.
  assert.equal((await db.query<Row>(`select status::text as s from public.reservations where id = $1::uuid`, [booking.id])).rows[0].s, "CONFIRMED");
  await fx.call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Pós-venda com o interruptor desligado')`, [ADMIN, booking.id]);
  assert.equal((await db.query<Row>(`select status::text as s from public.reservations where id = $1::uuid`, [booking.id])).rows[0].s, "CANCELLED");
  await db.close();
});

test("experiências regulares: todas as leituras e a reserva respondem igual antes e depois, por papel", async () => {
  const { db, fx } = await productionLike();
  const regular = await fx.makeSession(fx.IMERSAO.id, { price: fx.uniquePrice(), capacity: 6 });
  const slug = (await db.query<Row>(`select e.slug from public.sessions s join public.experiences e on e.id = s.experience_id where s.id = $1::uuid`, [regular])).rows[0].slug as string;
  const snapshot = async () => {
    const out: Record<string, unknown> = {};
    for (const role of [...PUBLIC_ROLES, "service_role"]) {
      out[role] = await as(db, role, async () => ({
        experiences: (await db.query(`select * from public.experiences order by id`)).rows,
        sessions: (await db.query(`select * from public.sessions order by id`)).rows,
        bases: (await db.query(`select * from public.bases order by id`)).rows,
        list: (await db.query(`select * from public.list_public_experiences()`)).rows,
        catalog: (await db.query(`select * from public.list_public_catalog()`)).rows,
        regularList: (await db.query(`select * from public.list_public_regular_experiences()`)).rows,
        regularCatalog: (await db.query(`select * from public.list_public_regular_catalog()`)).rows,
        one: (await db.query(`select * from public.get_public_experience($1)`, [slug])).rows,
        open: (await db.query(`select * from public.list_open_sessions($1)`, [slug])).rows,
        all: (await db.query(`select * from public.list_public_sessions($1)`, [slug])).rows,
        booking: (await db.query(`select * from public.get_booking_session($1::uuid)`, [regular])).rows,
        context: (await db.query(`select * from public.public_session_context($1::uuid)`, [regular])).rows,
        spots: (await db.query(`select public.available_spots($1::uuid) as n`, [regular])).rows,
      }));
    }
    return out;
  };
  const before = await snapshot();
  await applyMigration(db, MIGRATION);
  assert.deepEqual(await snapshot(), before);
  const booking = await fx.reserve(regular, 2);
  assert.equal((await db.query<Row>(`select status::text as s from public.reservations where id = $1::uuid`, [booking.id])).rows[0].s, "CONFIRMED");
  await db.close();
});

test("migration: mudanças só as previstas; create_reservation ausente não quebra; reaplicar não muda nada", async () => {
  const { db } = await productionLike();
  const bodies = async () => new Map((await db.query<{ name: string; src: string }>(`select p.oid::regprocedure::text as name, md5(p.prosrc) as src from pg_proc p where p.pronamespace = 'public'::regnamespace`)).rows.map((row) => [row.name, row.src]));
  const old = await bodies();
  await applyMigration(db, MIGRATION);
  await applyMigration(db, MIGRATION);
  const current = await bodies();
  assert.deepEqual([...current.keys()].filter((name) => !old.has(name)).sort(), [
    "enforce_event_publication_on_insert()", "event_publication_allows(text)", "experience_row_is_public(text,text)", "session_experience_is_public(uuid)",
  ]);
  assert.deepEqual([...current.keys()].filter((name) => old.has(name) && old.get(name) !== current.get(name)).sort(), [
    "get_public_experience(text)", "list_open_sessions(text)", "list_public_catalog()", "list_public_experiences()", "list_public_sessions(text)", "public_session_context(uuid)",
  ]);
  const migration = source(`supabase/migrations/${MIGRATION}`).split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
  assert.doesNotMatch(migration, /(insert into|update|delete from) public\.|publication_enabled\s*=\s*true|alter table|cron\.|create extension/i);
  await db.close();

  const clean = await fullDatabase({ until: PREVIOUS });
  await applyMigration(clean, MIGRATION);
  await clean.close();
});

test("preflight e postcheck: aprovam nas duas pontas com o ESSÊNCIA fechado; assinatura e contagens iguais", async () => {
  const { db, fx } = await productionLike();
  await createEvent(db, fx);
  const pre = await report(db, PREFLIGHT);
  for (const [name, row] of pre) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  assert.match(pre.get("LEITURAS_ANTIGAS")!.result, /list_open_sessions=CORPO_ATUAL/);
  assert.match(pre.get("CREATE_RESERVATION")!.result, /anon=true/);
  await applyMigration(db, MIGRATION);
  const post = await report(db, POSTCHECK);
  for (const [name, row] of post) assert.equal(row.status, "OK", `${name}: ${row.result}`);
  assert.equal(post.get("FUNCOES_COM_A_DEFINICAO_DO_REPOSITORIO")?.result, "10 de 10");
  assert.equal(post.get("ESSENCIA_NAS_LEITURAS_PUBLICAS")?.result, "0 linha(s)");
  assert.equal(post.get("CREATE_RESERVATION_FECHADA")?.result, "anon=false, authenticated=false, service_role=false");
  for (const key of ["ASSINATURA_DAS_OUTRAS_FUNCOES", "LISTAGENS_REGULARES", "ESSENCIA_FECHADO", "RESERVAS_POR_STATUS", "INSCRICOES_DA_LISTA_POR_STATUS"]) {
    assert.equal(post.get(key)?.result, pre.get(key)?.result, key);
  }
  assert.equal((await report(db, PREFLIGHT)).get("LEITURAS_ANTIGAS")?.status, "ATENCAO", "já aplicada");
  await db.close();
});

test("preflight reprova leitura alterada à mão e interruptor ligado", async () => {
  const { db } = await productionLike();
  await db.exec(`create or replace function public.get_public_experience(p_slug text) returns table (id uuid, slug text, title text, summary text, image_url text, display_order integer, editorial_content jsonb) language sql stable security definer set search_path = public as $$ select null::uuid, null, null, null, null, 0, null::jsonb where false $$`);
  assert.equal((await report(db, PREFLIGHT)).get("LEITURAS_ANTIGAS")?.status, "FALHOU");
  await setSwitch(db, true);
  assert.equal((await report(db, PREFLIGHT)).get("INTERRUPTOR_DESLIGADO")?.status, "FALHOU");
  await db.close();
});

test("rollback: tira tudo, devolve os corpos, não reabre create_reservation; reaplicar volta ao postcheck", async () => {
  const { db, fx } = await productionLike();
  await createEvent(db, fx);
  const bodies = async () => (await db.query<{ name: string; src: string }>(`select p.oid::regprocedure::text as name, md5(p.prosrc) as src from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname <> 'create_reservation' order by 1`)).rows;
  const before = await bodies();
  await applyMigration(db, MIGRATION);
  await db.exec(ROLLBACK);
  assert.deepEqual(await bodies(), before);
  assert.equal((await db.query(`select 1 from pg_policy where polname in ('events hidden until published', 'event sessions hidden until published')`)).rows.length, 0);
  assert.equal((await db.query(`select 1 from pg_trigger where tgname like '%event_publication_guard'`)).rows.length, 0);
  assert.equal((await db.query<Row>(`select has_function_privilege('anon', 'public.create_reservation(uuid, text, text, text, integer, text)', 'execute') as p`)).rows[0].p, false);
  await applyMigration(db, MIGRATION);
  assert.equal((await report(db, POSTCHECK)).get("EVENTOS_SEGURANCA_POSTCHECK_OK")?.status, "OK");
  await db.close();
});
