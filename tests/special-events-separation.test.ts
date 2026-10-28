/**
 * Eventos especiais — fase 3: separação no site.
 *
 * Roda contra o Postgres em memória (PGlite) com todas as migrations. Prova que
 * as áreas regulares (home, vitrine, agenda, bases, sitemap e a landing de
 * experiência) leem só a agenda regular, e que as três listas de turmas de
 * destino — troca de turma do painel, Stand-by do painel e autoatendimento do
 * cliente — só oferecem sessões do mesmo tipo da reserva. A trava do banco
 * (`EVENT_KIND_MISMATCH`) continua sendo a última palavra.
 *
 * Os eventos daqui são cadastrados só no banco de teste. Nada é publicado em
 * produção.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseStandbyOptions } from "../lib/admin/standby.ts";
import { parseReservationSessionOptions } from "../lib/admin/session-change.ts";
import { filterSameKind, keepSameKind, sessionKindsFrom, type KindQueryClient } from "../lib/events/kind.ts";
import { handleSelfServiceOverview, type SelfServiceDeps } from "../lib/reservations/standby-self-service.ts";
import { isMissingFunction, rpcWithLegacyFallback } from "../lib/supabase/rpc-fallback.ts";
import { fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";
import { ADMIN, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";

const PREVIOUS = "202610260002_waitlist_spot_email.sql";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const db = await fullDatabase();
const admin = createPgliteAdmin(db);
const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
const { one, rows, call, IMERSAO, SUNSET_CONCHA, makeSession, reserve, setStandby } = fx;
const kinds = sessionKindsFrom(admin.client as unknown as KindQueryClient);

const PRICE = 15_000;
let sequence = 0;

/** Evento publicado com a sessão aberta, só no banco de teste. */
async function onSaleEvent(startsIn = "10 days") {
  sequence += 1;
  const created = await call(
    `public.admin_create_event($1::uuid, $2::uuid, $3, 'Evento Separação', 'x', '{}'::jsonb, null, now() + $4::interval, 210, $5, 12)`,
    [ADMIN, SUNSET_CONCHA.base_id, `evento-separacao-${sequence}`, startsIn, PRICE],
  );
  await rows(`update public.special_event_settings set publication_enabled = true`);
  await rows(`update public.experiences set status = 'PUBLISHED' where id = $1::uuid`, [created.experienceId]);
  await rows(`update public.special_event_settings set publication_enabled = false`);
  await rows(`update public.sessions set status = 'OPEN' where id = $1::uuid`, [created.sessionId]);
  return { slug: `evento-separacao-${sequence}`, experienceId: created.experienceId as string, sessionId: created.sessionId as string };
}

// ===========================================================================
// 1. Listagens públicas
// ===========================================================================

test("tipo: as 9 experiências existentes continuam REGULAR", async () => {
  const fresh = await fullDatabase();
  const kindsBySlug = (await fresh.query<Row>(`select kind, count(*)::int as n from public.experiences group by kind`)).rows;
  assert.deepEqual(kindsBySlug, [{ kind: "REGULAR", n: 9 }]);
  await fresh.close();
});

test("listagens: as funções regulares devolvem o mesmo que as atuais e escondem o evento publicado", async () => {
  const fresh = await fullDatabase();
  const freshAdmin = createPgliteAdmin(fresh);
  const before = {
    experiences: (await freshAdmin.client.rpc("list_public_experiences")).data,
    catalog: (await freshAdmin.client.rpc("list_public_catalog")).data,
  };
  assert.deepEqual((await rpcWithLegacyFallback(freshAdmin.client, "list_public_regular_experiences", "list_public_experiences")).data, before.experiences);
  assert.deepEqual((await rpcWithLegacyFallback(freshAdmin.client, "list_public_regular_catalog", "list_public_catalog")).data, before.catalog);

  const local = await rescheduleFixtures(async (sql, params = []) => (await fresh.query(sql, params)).rows as Row[]);
  const created = await local.call(
    `public.admin_create_event($1::uuid, $2::uuid, 'essencia-teste', 'ESSÊNCIA', 'x', '{}'::jsonb, null, now() + interval '10 days', 210, 15000, 12)`,
    [ADMIN, local.SUNSET_CONCHA.base_id],
  );
  await fresh.query(`update public.special_event_settings set publication_enabled = true`);
  await fresh.query(`update public.experiences set status = 'PUBLISHED', editorial_content = (select editorial_content from public.experiences where slug = 'imersao-paranoa') where id = $1::uuid`, [created.experienceId]);

  const slugs = (value: unknown) => (value as Row[]).map((row) => row.slug);
  // As antigas passam a ver o evento; as regulares, usadas pelo site, não.
  assert.ok(slugs((await freshAdmin.client.rpc("list_public_experiences")).data).includes("essencia-teste"));
  const regular = await rpcWithLegacyFallback(freshAdmin.client, "list_public_regular_experiences", "list_public_experiences");
  const catalog = await rpcWithLegacyFallback(freshAdmin.client, "list_public_regular_catalog", "list_public_catalog");
  assert.deepEqual(regular.data, before.experiences);
  assert.deepEqual(catalog.data, before.catalog);
  assert.ok(!slugs(regular.data).includes("essencia-teste"));
  assert.ok(!slugs(catalog.data).includes("essencia-teste"));
  // A landing de experiência reconhece o evento e não o mostra.
  assert.equal(((await freshAdmin.client.rpc("get_public_event", { p_slug: "essencia-teste" })).data as Row[]).length, 1);
  await fresh.close();
});

test("listagens: sem as funções novas no banco, volta para as antigas; erro passageiro não volta", async () => {
  const old = await fullDatabase({ until: PREVIOUS });
  const oldAdmin = createPgliteAdmin(old);
  const result = await rpcWithLegacyFallback(oldAdmin.client, "list_public_regular_catalog", "list_public_catalog");
  assert.equal(result.error, null);
  assert.deepEqual(result.data, (await oldAdmin.client.rpc("list_public_catalog")).data);
  await old.close();

  const called: string[] = [];
  const transient = {
    async rpc(name: string) {
      called.push(name);
      return { data: null, error: { message: "fetch failed", code: "" } };
    },
  };
  const failed = await rpcWithLegacyFallback(transient, "list_public_regular_experiences", "list_public_experiences");
  assert.equal(failed.error?.message, "fetch failed");
  assert.deepEqual(called, ["list_public_regular_experiences"], "não consulta a listagem antiga num erro passageiro");
  assert.equal(isMissingFunction({ message: "Could not find the function public.list_public_regular_catalog without parameters in the schema cache", code: "PGRST202" }), true);
  assert.equal(isMissingFunction({ message: "permission denied for function list_public_regular_catalog", code: "42501" }), false);
});

test("site: home, vitrine, agenda, bases, sitemap e landing leem só a agenda regular", () => {
  const editorial = source("lib/editorial/data.ts");
  const bases = source("lib/bases/data.ts");
  assert.match(editorial, /rpcWithLegacyFallback\(client, "list_public_regular_experiences", "list_public_experiences"\)/);
  assert.match(bases, /rpcWithLegacyFallback\(client, "list_public_regular_catalog", "list_public_catalog"\)/);
  assert.doesNotMatch(editorial, /client\.rpc\("list_public_experiences"\)/);
  assert.doesNotMatch(bases, /client\.rpc\("list_public_catalog"\)/);
  // A landing `/experiencias/[slug]` não mostra um evento publicado.
  assert.match(editorial, /client\.rpc\("get_public_event", \{ p_slug: slug \}\)/);
  assert.match(editorial, /if \(event\) return null;/);

  // Todas as listagens públicas passam por essas duas leituras.
  for (const file of ["app/page.tsx", "app/experiencias/page.tsx", "app/bases/page.tsx", "app/bases/[slug]/page.tsx", "app/sitemap.ts", "lib/agenda/data.ts"]) {
    const code = source(file);
    assert.doesNotMatch(code, /rpc\("list_public_(experiences|catalog)"\)/, file);
    assert.match(code, /listPublishedExperiences|listCatalogExperiences/, file);
  }
});

// ===========================================================================
// 2. Tipo das sessões
// ===========================================================================

test("tipo da sessão: regular e evento lidos do banco; origem desconhecida não oferece nada", async () => {
  const event = await onSaleEvent();
  const regular = await makeSession(IMERSAO.id, { price: PRICE });
  const read = await kinds([event.sessionId, regular, "00000000-0000-4000-8000-000000000000"]);
  assert.equal(read.get(event.sessionId), "EVENT");
  assert.equal(read.get(regular), "REGULAR");
  assert.equal(read.has("00000000-0000-4000-8000-000000000000"), false);

  const options = [{ sessionId: event.sessionId }, { sessionId: regular }];
  assert.deepEqual(keepSameKind(regular, options, (option) => option.sessionId, read), [{ sessionId: regular }]);
  assert.deepEqual(keepSameKind(event.sessionId, options, (option) => option.sessionId, read), [{ sessionId: event.sessionId }]);
  assert.deepEqual(keepSameKind("00000000-0000-4000-8000-000000000000", options, (option) => option.sessionId, read), []);
  assert.deepEqual(await filterSameKind(kinds, null, options, (option) => option.sessionId), []);
});

test("tipo da sessão: banco sem a coluna kind trata tudo como regular; outra falha lança", async () => {
  const sessionA = "10000000-0000-4000-8000-000000000001";
  const sessionB = "10000000-0000-4000-8000-000000000002";
  const fake = (experiencesError: { message: string; code?: string } | null): KindQueryClient => ({
    from(table: string) {
      return {
        select() {
          return {
            in: async () => table === "sessions"
              ? { data: [{ id: sessionA, experience_id: "e1" }, { id: sessionB, experience_id: "e2" }], error: null }
              : { data: null, error: experiencesError },
          };
        },
      };
    },
  });
  const legacy = await sessionKindsFrom(fake({ message: 'column experiences.kind does not exist', code: "42703" }))([sessionA, sessionB]);
  assert.deepEqual([...legacy.values()], ["REGULAR", "REGULAR"]);
  await assert.rejects(sessionKindsFrom(fake({ message: "fetch failed" }))([sessionA]), /SESSION_KIND_LOOKUP_FAILED/);
});

// ===========================================================================
// 3. Listas de turmas de destino
// ===========================================================================

test("troca de turma do painel: reserva regular só vê turmas regulares; de evento, só sessões de evento", async () => {
  const event = await onSaleEvent();
  const secondEdition = await makeSession(event.experienceId, { price: PRICE, capacity: 12, startsIn: "20 days" });
  const regularOrigin = await makeSession(SUNSET_CONCHA.id, { price: PRICE, capacity: 10 });
  const regularTarget = await makeSession(SUNSET_CONCHA.id, { price: PRICE, capacity: 10 });

  const options = async (reservationId: string) => {
    const parsed = parseReservationSessionOptions(await call(`public.admin_reservation_session_options($1::uuid, $2::uuid)`, [ADMIN, reservationId]));
    assert.ok(parsed);
    const raw = parsed.options.map((option) => option.sessionId);
    const shown = (await filterSameKind(kinds, parsed.current?.sessionId, parsed.options, (option) => option.sessionId)).map((option) => option.sessionId);
    return { raw, shown };
  };

  const regularBooking = await reserve(regularOrigin, 2);
  const forRegular = await options(regularBooking.id);
  assert.ok(forRegular.raw.includes(event.sessionId), "a RPC, sozinha, ainda oferece a sessão do evento");
  assert.ok(!forRegular.shown.includes(event.sessionId));
  assert.ok(!forRegular.shown.includes(secondEdition));
  assert.ok(forRegular.shown.includes(regularTarget));
  const shownKinds = await kinds(forRegular.shown);
  assert.ok([...shownKinds.values()].every((kind) => kind === "REGULAR"));

  // Evento com evento: a outra edição (e outro evento, se houver) entra; turma regular, não.
  const eventBooking = await reserve(event.sessionId, 2);
  const forEvent = await options(eventBooking.id);
  assert.ok(forEvent.shown.includes(secondEdition));
  assert.ok(!forEvent.shown.includes(regularTarget));
  assert.ok([...(await kinds(forEvent.shown)).values()].every((kind) => kind === "EVENT"));

  // A trava do banco continua valendo mesmo com uma escolha forjada.
  await assert.rejects(call(
    `public.admin_change_reservation_session($1::uuid, $2::uuid, $3::uuid, 'Escolha forjada')`, [ADMIN, regularBooking.id, event.sessionId],
  ), /EVENT_KIND_MISMATCH/);
});

test("Stand-by do painel: só turmas do mesmo tipo da original, com a mesma régua de preço", async () => {
  const event = await onSaleEvent();
  const secondEdition = await makeSession(event.experienceId, { price: PRICE, capacity: 12, startsIn: "21 days" });
  const regularOrigin = await makeSession(SUNSET_CONCHA.id, { price: PRICE, capacity: 10 });
  const regularTarget = await makeSession(IMERSAO.id, { price: PRICE, capacity: 10 });
  const otherPrice = await makeSession(IMERSAO.id, { price: PRICE + 100, capacity: 10 });

  const options = async (reservationId: string) => {
    const parsed = parseStandbyOptions(await call(`public.admin_standby_reschedule_options($1::uuid, $2::uuid)`, [ADMIN, reservationId]));
    assert.ok(parsed);
    return (await filterSameKind(kinds, parsed.original.sessionId, parsed.options, (option) => option.sessionId)).map((option) => option.sessionId);
  };

  const regularBooking = await reserve(regularOrigin, 2);
  await setStandby(regularBooking.id);
  const forRegular = await options(regularBooking.id);
  assert.ok(forRegular.includes(regularTarget));
  assert.ok(!forRegular.includes(event.sessionId));
  assert.ok(!forRegular.includes(secondEdition));
  assert.ok(!forRegular.includes(otherPrice), "a régua de preço da RPC continua valendo");

  const eventBooking = await reserve(event.sessionId, 1);
  await setStandby(eventBooking.id);
  const forEvent = await options(eventBooking.id);
  assert.ok(forEvent.includes(secondEdition));
  assert.ok(!forEvent.includes(regularTarget));
  const shownKinds = await kinds(forEvent);
  assert.ok([...shownKinds.values()].every((kind) => kind === "EVENT"));
});

let clientSequence = 0;
const nextClient = () => `198.51.100.${(clientSequence += 1) % 250}`;

let cpfSequence = 200_000_000;

/** CPF com dígitos verificadores válidos: o autoatendimento recusa qualquer outro antes do banco. */
function nextCpf() {
  cpfSequence += 7919;
  const base = String(cpfSequence).padStart(9, "0").slice(-9);
  const digit = (digits: string) => {
    const sum = digits.split("").reduce((total, value, index) => total + Number(value) * (digits.length + 1 - index), 0);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  const first = digit(base);
  return `${base}${first}${digit(`${base}${first}`)}`;
}

/** Reserva paga pelo caminho real, com CPF válido. */
async function book(sessionId: string, quantity: number) {
  const cpf = nextCpf();
  const created = await call(
    `public.create_pre_reservation($1::uuid, $2, $3, $4, $5, $6, null, gen_random_uuid())`,
    [sessionId, `Cliente Separação ${cpf.slice(-4)}`, cpf, `+55619${cpf.slice(-8)}`, `separacao${cpf}@teste.local`, quantity],
  );
  assert.equal(await call(
    `public.confirm_reservation_payment($1::uuid, 'INFINITEPAY', $2, $3, 'https://recibo.teste/1', '{}'::jsonb)`,
    [created.reservationId, `tx-${cpf}`, created.totalCents],
  ), true);
  return { id: created.reservationId as string, cpf, code: created.publicCode as string };
}

function deps(sessionKinds = kinds): SelfServiceDeps {
  return { rpc: (name, args) => admin.client.rpc(name, args), sessionKinds };
}

test("autoatendimento: o cliente só vê turmas do mesmo tipo; sem saber o tipo, a tela fica indisponível", async () => {
  const event = await onSaleEvent();
  const secondEdition = await makeSession(event.experienceId, { price: PRICE, capacity: 12, startsIn: "22 days" });
  const regularOrigin = await makeSession(IMERSAO.id, { price: PRICE, capacity: 10 });
  const regularTarget = await makeSession(SUNSET_CONCHA.id, { price: PRICE, capacity: 10 });

  const overview = async (booking: { cpf: string; code: string }, sessionKinds = kinds) => handleSelfServiceOverview(
    deps(sessionKinds), { credential: { cpf: booking.cpf, publicCode: booking.code } }, nextClient(),
  );
  const shown = (response: Awaited<ReturnType<typeof overview>>) => ((response.body.overview as Row).options as Row[]).map((option) => option.sessionId);

  const regularBooking = await book(regularOrigin, 2);
  await setStandby(regularBooking.id);
  const raw = await call(`public.customer_reschedule_overview($1, $2, null)`, [regularBooking.cpf, regularBooking.code]);
  assert.ok((raw.options as Row[]).some((option) => option.sessionId === event.sessionId), "a RPC, sozinha, ainda oferece a sessão do evento");
  const forRegular = await overview(regularBooking);
  assert.equal(forRegular.status, 200);
  assert.ok(shown(forRegular).includes(regularTarget));
  assert.ok(!shown(forRegular).includes(event.sessionId));
  assert.ok(!shown(forRegular).includes(secondEdition));

  const eventBooking = await book(event.sessionId, 1);
  await setStandby(eventBooking.id);
  const forEvent = await overview(eventBooking);
  assert.ok(shown(forEvent).includes(secondEdition));
  assert.ok(!shown(forEvent).includes(regularTarget));
  assert.ok([...(await kinds(shown(forEvent))).values()].every((kind) => kind === "EVENT"));

  const unavailable = await overview(regularBooking, async () => { throw new Error("SESSION_KIND_LOOKUP_FAILED: fetch failed"); });
  assert.deepEqual([unavailable.status, unavailable.body.code], [503, "UNAVAILABLE"]);
});

test("painel e autoatendimento: as três listas passam pelo filtro de tipo no servidor", () => {
  assert.match(source("lib/admin/data.ts"), /filterSameKind\(sessionKindsFromSupabase\(adminClient\(\)\), parsed\.current\?\.sessionId, parsed\.options/);
  assert.match(source("lib/admin/standby-data.ts"), /filterSameKind\(sessionKindsFromSupabase\(adminClient\(\)\), parsed\.original\.sessionId, parsed\.options/);
  assert.match(source("lib/reservations/standby-self-service-http.ts"), /sessionKinds: sessionKindsFromSupabase\(admin\)/);
});

// ===========================================================================
// 4. Reservas e pagamentos seguem iguais
// ===========================================================================

test("reservas e pagamentos: regular e evento seguem pelo mesmo caminho de sempre", async () => {
  const regular = await makeSession(IMERSAO.id, { price: 7_000, capacity: 6 });
  const regularBooking = await reserve(regular, 2);
  const event = await onSaleEvent();
  const eventBooking = await reserve(event.sessionId, 3);
  const status = async (id: string) => (await one(`select status::text as status, total_cents from public.reservations where id = $1::uuid`, [id]));
  assert.deepEqual(await status(regularBooking.id), { status: "CONFIRMED", total_cents: 14_000 });
  assert.deepEqual(await status(eventBooking.id), { status: "CONFIRMED", total_cents: 45_000 });
  assert.equal((await one(`select count(*)::int as n from public.payment_events where reservation_id = any($1::uuid[])`, [[regularBooking.id, eventBooking.id]])).n, 2);
});
