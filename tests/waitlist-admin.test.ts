/**
 * Lista de espera — fase 4: painel administrativo.
 *
 * As regras puras (variável, filtros, leitura das respostas, validação) são
 * testadas direto. O acesso ao banco (`createWaitlistAdminData`) e o corpo da
 * rota de remoção (`handleWaitlistRemoval`) rodam contra o Postgres em memória
 * com todas as migrations, pelas RPCs de verdade da fase 1. As páginas e a rota,
 * que o runner do Node não executa, são conferidas no código-fonte.
 *
 * Esta fase não traz migration: só lê e remove pelas funções já aplicadas.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";
import { ADMIN, INSTRUCTOR, STRANGER, rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";
import {
  filterWaitlistSessions,
  isWaitlistAdminEnabled,
  parseWaitlistEntryDetail,
  parseWaitlistEntryPage,
  parseWaitlistFilters,
  parseWaitlistSessions,
  validateWaitlistRemoval,
  waitlistAdminError,
  waitlistExperienceOptions,
  waitlistListHref,
  waitlistPageCount,
  WAITLIST_ENTRIES_PAGE_SIZE,
  type WaitlistSession,
} from "../lib/admin/waitlist.ts";
import { createWaitlistAdminData, handleWaitlistRemoval } from "../lib/admin/waitlist-data.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function code(path: string) {
  return source(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
}

const db = await fullDatabase();
const pglite = createPgliteAdmin(db);
const data = createWaitlistAdminData((name, args) => pglite.client.rpc(name, args));
const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
const { one, rows, call, IMERSAO, SUNSET_CONCHA, makeSession, reserve, uniquePrice } = fx;

const BASES = [{ slug: "lago-norte" }, { slug: "concha-acustica" }];

let sequence = 0;

async function soldOut(experienceId: string = IMERSAO.id, options: { capacity?: number; startsIn?: string } = {}) {
  const capacity = options.capacity ?? 2;
  const session = await makeSession(experienceId, { price: uniquePrice(), capacity, startsIn: options.startsIn });
  await reserve(session, capacity);
  return session;
}

async function join(sessionId: string, quantity = 1, name?: string) {
  sequence += 1;
  const email = `painel${sequence}@teste.local`;
  const answer = await call(`public.waitlist_join($1::uuid, $2, $3, $4, $5, null, '')`, [
    sessionId, name ?? `Pessoa Painel ${sequence}`, email, `+5561${String(910000000 + sequence)}`, quantity,
  ]);
  assert.equal(answer.status, "ACCEPTED");
  return one(`select * from public.waitlist_entries where session_id = $1::uuid and email = $2`, [sessionId, email]);
}

async function resetThrottle() {
  await db.exec(`delete from public.waitlist_throttle`);
}

// ===========================================================================
// 1. Regras puras
// ===========================================================================

test("variável: só o valor exato true liga o painel, e ela independe das do site", () => {
  assert.equal(isWaitlistAdminEnabled({}), false);
  for (const value of ["", "1", "yes", "false"]) assert.equal(isWaitlistAdminEnabled({ WAITLIST_ADMIN_ENABLED: value }), false, value);
  assert.equal(isWaitlistAdminEnabled({ WAITLIST_ADMIN_ENABLED: " TRUE " }), true);
  assert.equal(isWaitlistAdminEnabled({ WAITLIST_PUBLIC_ENABLED: "true", WAITLIST_SIGNUP_ENABLED: "true" }), false);
  assert.equal(isWaitlistAdminEnabled({ NEXT_PUBLIC_WAITLIST_ADMIN_ENABLED: "true" }), false);
});

test("filtros: tudo da URL é validado; o inválido vira 'sem filtro'", () => {
  const experience = "6c212186-5809-4eb6-8f52-5c3bc6570d33";
  const parsed = parseWaitlistFilters({ experience, base: "concha-acustica", date: "2026-11-07", status: "removed", query: "  ana  ", past: "1", session: experience, page: "3", turmas: "2" }, BASES);
  assert.deepEqual(parsed, { experience, base: "concha-acustica", date: "2026-11-07", status: "REMOVED", query: "ana", past: true, session: experience, page: 3, sessionsPage: 2 });

  const junk = parseWaitlistFilters({ experience: "x", base: "outra", date: "2026-02-30", status: "DROP", query: "q".repeat(300), past: "true", session: "1; drop", page: "-1", turmas: "abc" }, BASES);
  assert.deepEqual(junk, { experience: "", base: "", date: "", status: "ACTIVE", query: "q".repeat(120), past: false, session: "", page: 1, sessionsPage: 1 });
  assert.equal(parseWaitlistFilters({ status: "all" }, BASES).status, "ALL");
  assert.equal(parseWaitlistFilters({ status: ["ACTIVE", "REMOVED"] }, BASES).status, "ACTIVE", "parâmetro repetido não vale");
});

test("endereço: preserva os filtros, troca só o pedido e omite os padrões", () => {
  const filters = parseWaitlistFilters({ base: "lago-norte", status: "ALL", query: "ana", page: "2" }, BASES);
  assert.equal(waitlistListHref(filters), "/admin/lista-de-espera?base=lago-norte&status=ALL&query=ana&page=2");
  assert.equal(waitlistListHref(filters, { page: 1, session: "6c212186-5809-4eb6-8f52-5c3bc6570d33" }), "/admin/lista-de-espera?base=lago-norte&status=ALL&query=ana&session=6c212186-5809-4eb6-8f52-5c3bc6570d33");
  assert.equal(waitlistListHref(parseWaitlistFilters({}, BASES)), "/admin/lista-de-espera");
});

test("turmas: experiência, base e data (no fuso de Brasília) recortam a lista", () => {
  const base = { sessionStatus: "OPEN", capacity: 6, remainingSpots: 0, activeEntries: 1, activeParticipants: 1, totalEntries: 1, lastSignupAt: null };
  const sessions: WaitlistSession[] = [
    { ...base, sessionId: "a", startsAt: "2026-11-07T12:00:00.000Z", experienceId: "e1", experienceTitle: "Imersão", baseId: "b1", baseName: "Lago Norte" },
    // 23:30 de 07/11 em Brasília é 02:30Z de 08/11: continua sendo dia 07.
    { ...base, sessionId: "b", startsAt: "2026-11-08T02:30:00.000Z", experienceId: "e2", experienceTitle: "Sunset", baseId: "b2", baseName: "Concha" },
    { ...base, sessionId: "c", startsAt: "2026-11-08T12:00:00.000Z", experienceId: "e1", experienceTitle: "Imersão", baseId: "b1", baseName: "Lago Norte" },
  ];
  const ids = (list: WaitlistSession[]) => list.map((item) => item.sessionId);
  assert.deepEqual(ids(filterWaitlistSessions(sessions, { experience: "", date: "" }, null)), ["a", "b", "c"]);
  assert.deepEqual(ids(filterWaitlistSessions(sessions, { experience: "e1", date: "" }, null)), ["a", "c"]);
  assert.deepEqual(ids(filterWaitlistSessions(sessions, { experience: "", date: "2026-11-07" }, null)), ["a", "b"]);
  assert.deepEqual(ids(filterWaitlistSessions(sessions, { experience: "", date: "" }, "b2")), ["b"]);
  assert.deepEqual(ids(filterWaitlistSessions(sessions, { experience: "e1", date: "2026-11-07" }, "b2")), []);
  assert.deepEqual(waitlistExperienceOptions(sessions), [{ id: "e1", title: "Imersão" }, { id: "e2", title: "Sunset" }]);
  assert.equal(waitlistPageCount(0, 25), 1);
  assert.equal(waitlistPageCount(26, 25), 2);
});

test("leitura: linhas incompletas ou com status desconhecido são descartadas", () => {
  assert.deepEqual(parseWaitlistSessions(null), []);
  assert.deepEqual(parseWaitlistSessions([{ sessionId: "" }, "x"]), []);
  const page = parseWaitlistEntryPage({ items: [{ entryId: "a", status: "ACTIVE" }, { entryId: "b", status: "HACKED" }, null], total: 2 });
  assert.deepEqual(page.items.map((item) => item.entryId), ["a"]);
  assert.equal(parseWaitlistEntryDetail(null), null);
  assert.equal(parseWaitlistEntryDetail({ entryId: "a", status: "OUTRO" }), null);
});

test("remoção: motivo de 3 a 500 caracteres e confirmação explícita", () => {
  assert.deepEqual(validateWaitlistRemoval({ reason: "  Pediu  por WhatsApp ", confirmed: true }), { success: true, data: { reason: "Pediu por WhatsApp" } });
  for (const body of [null, {}, { reason: "ok", confirmed: true }, { reason: "x".repeat(501), confirmed: true }, { reason: "Motivo válido" }, { reason: "Motivo válido", confirmed: "true" }]) {
    assert.equal(validateWaitlistRemoval(body).success, false, JSON.stringify(body));
  }
});

test("erros: recusa do banco vira mensagem da equipe, sem repassar o texto original", () => {
  assert.equal(waitlistAdminError(new Error("ADMIN_FORBIDDEN")).status, 403);
  assert.equal(waitlistAdminError(new Error("P0002: WAITLIST_ENTRY_NOT_FOUND")).status, 404);
  assert.equal(waitlistAdminError(new Error("WAITLIST_INVALID_REASON")).status, 400);
  assert.equal(waitlistAdminError(new Error("PGRST202: Could not find the function public.admin_waitlist_sessions")).status, 503);
  const generic = waitlistAdminError(new Error("relation secreta tem dados de ana@x.com"));
  assert.equal(generic.status, 500);
  assert.doesNotMatch(generic.message, /ana@x\.com|secreta/);
});

// ===========================================================================
// 2. Banco: leituras, filtros e paginação
// ===========================================================================

test("permissões: só ADMIN e OPERATOR ativos leem ou removem; instrutor e desconhecido não", async () => {
  await resetThrottle();
  const session = await soldOut();
  const entry = await join(session);
  for (const actor of [INSTRUCTOR, STRANGER]) {
    await assert.rejects(data.sessions(actor, false), /ADMIN_FORBIDDEN/);
    await assert.rejects(data.entries(actor, { sessionId: null, baseId: null, status: "ACTIVE", query: "", page: 1 }), /ADMIN_FORBIDDEN/);
    await assert.rejects(data.entry(actor, entry.id), /ADMIN_FORBIDDEN/);
    const refused = await handleWaitlistRemoval(data, actor, entry.id, { reason: "Tentativa indevida", confirmed: true });
    assert.equal(refused.status, 403);
  }
  assert.equal((await one(`select status from public.waitlist_entries where id = $1::uuid`, [entry.id])).status, "ACTIVE");
  assert.equal((await one(`select count(*)::int as n from public.admin_audit_log where entity_id = $1::uuid`, [entry.id])).n, 0);
});

test("turmas: experiência, base, data, capacidade, vagas e interessados vêm do banco", async () => {
  await resetThrottle();
  const session = await soldOut(SUNSET_CONCHA.id, { capacity: 3 });
  await join(session, 2);
  await join(session, 1);
  const listed = (await data.sessions(ADMIN, false)).find((item) => item.sessionId === session);
  assert.ok(listed);
  assert.equal(listed.experienceTitle, SUNSET_CONCHA.title);
  assert.equal(listed.baseName, SUNSET_CONCHA.base_name);
  assert.equal(listed.baseId, SUNSET_CONCHA.base_id);
  assert.equal(listed.capacity, 3);
  assert.equal(listed.remainingSpots, 0);
  assert.deepEqual([listed.activeEntries, listed.activeParticipants, listed.totalEntries], [2, 3, 2]);
  assert.ok(listed.startsAt);

  // Turma que já aconteceu só aparece pedindo as passadas.
  const past = await soldOut();
  await join(past);
  await db.query(`update public.sessions set starts_at = now() - interval '2 days' where id = $1::uuid`, [past]);
  assert.ok(!(await data.sessions(ADMIN, false)).some((item) => item.sessionId === past));
  assert.ok((await data.sessions(ADMIN, true)).some((item) => item.sessionId === past));
});

test("inscrições: nome, e-mail, WhatsApp, quantidade, data e status, na ordem da fila", async () => {
  await resetThrottle();
  const session = await soldOut(IMERSAO.id, { capacity: 4 });
  const first = await join(session, 3, "Primeira Da Fila");
  const second = await join(session, 1, "Segunda Da Fila");
  const page = await data.entries(ADMIN, { sessionId: session, baseId: null, status: "ALL", query: "", page: 1 });
  assert.deepEqual(page.items.map((item) => [item.fullName, item.position, item.quantity]), [["Primeira Da Fila", 1, 3], ["Segunda Da Fila", 2, 1]]);
  const [item] = page.items;
  assert.equal(item.entryId, first.id);
  assert.equal(item.email, first.email);
  assert.equal(item.phone, first.phone);
  assert.equal(item.status, "ACTIVE");
  assert.ok(item.createdAt);
  assert.deepEqual([page.total, page.totalParticipants], [2, 4]);
  assert.ok(second.id);
});

test("inscrições: filtros por base, status e busca; paginação no banco acima de 25", async () => {
  await resetThrottle();
  const session = await soldOut(IMERSAO.id, { capacity: 1 });
  const created: Row[] = [];
  for (let index = 0; index < WAITLIST_ENTRIES_PAGE_SIZE + 5; index += 1) {
    if (index % 25 === 0) await resetThrottle();
    created.push(await join(session, 1, `Paginada ${String(index).padStart(2, "0")} Teste`));
  }
  const firstPage = await data.entries(ADMIN, { sessionId: session, baseId: null, status: "ACTIVE", query: "", page: 1 });
  const secondPage = await data.entries(ADMIN, { sessionId: session, baseId: null, status: "ACTIVE", query: "", page: 2 });
  assert.deepEqual([firstPage.total, firstPage.items.length, secondPage.items.length, secondPage.offset], [30, 25, 5, 25]);
  const seen = new Set([...firstPage.items, ...secondPage.items].map((item) => item.entryId));
  assert.equal(seen.size, 30, "nenhuma repetida entre as páginas");
  assert.equal(secondPage.items.at(-1)?.position, 30);

  await call(`public.admin_remove_waitlist_entry($1::uuid, $2::uuid, 'Remoção de teste')`, [ADMIN, created[0].id]);
  const removed = await data.entries(ADMIN, { sessionId: session, baseId: null, status: "REMOVED", query: "", page: 1 });
  assert.deepEqual(removed.items.map((item) => item.entryId), [created[0].id]);
  assert.equal((await data.entries(ADMIN, { sessionId: session, baseId: null, status: "ACTIVE", query: "", page: 1 })).total, 29);

  const byName = await data.entries(ADMIN, { sessionId: null, baseId: null, status: "ALL", query: "Paginada 07", page: 1 });
  assert.deepEqual(byName.items.map((item) => item.entryId), [created[7].id]);
  const byPhone = await data.entries(ADMIN, { sessionId: null, baseId: null, status: "ALL", query: created[9].phone.slice(-7), page: 1 });
  assert.ok(byPhone.items.some((item) => item.entryId === created[9].id));

  const otherBase = await data.entries(ADMIN, { sessionId: session, baseId: SUNSET_CONCHA.base_id, status: "ALL", query: "", page: 1 });
  assert.equal(otherBase.total, 0, "a turma é do Lago Norte");
  const sameBase = await data.entries(ADMIN, { sessionId: session, baseId: IMERSAO.base_id, status: "ALL", query: "", page: 1 });
  assert.equal(sameBase.total, 30);
});

test("histórico: avisos com tentativas e ações da equipe, sem token nem mensagem guardada", async () => {
  await resetThrottle();
  const session = await soldOut();
  const entry = await join(session, 2, "Historico Completo Teste");
  const detail = await data.entry(ADMIN, entry.id);
  assert.ok(detail);
  assert.equal(detail.notifications.length, 1);
  assert.equal(detail.notifications[0].kind, "JOINED");
  assert.equal(detail.notifications[0].status, "QUEUED");
  assert.equal(detail.capacity, 2);
  assert.equal(await data.entry(ADMIN, "00000000-0000-4000-8000-000000000000"), null);
  const raw = JSON.stringify(detail);
  assert.ok(!raw.includes(entry.cancel_token_hash));
  assert.doesNotMatch(raw, /frozen|claimToken|cancelToken/);
});

// ===========================================================================
// 3. Remoção pelo corpo da rota
// ===========================================================================

test("remoção: grava REMOVED, descarta o e-mail pendente e audita com o motivo, sem dado pessoal", async () => {
  await resetThrottle();
  const session = await soldOut();
  const entry = await join(session, 1, "Removida Pelo Painel");
  const response = await handleWaitlistRemoval(data, ADMIN, entry.id, { reason: "  Pediu para sair  pelo WhatsApp ", confirmed: true });
  assert.equal(response.status, 200);
  assert.equal(response.body.removed, true);

  const after = await one(`select status, closed_reason from public.waitlist_entries where id = $1::uuid`, [entry.id]);
  assert.deepEqual([after.status, after.closed_reason], ["REMOVED", "ADMIN"]);
  const notification = await one(`select status, skip_reason from public.waitlist_notifications where entry_id = $1::uuid`, [entry.id]);
  assert.deepEqual([notification.status, notification.skip_reason], ["SKIPPED", "ENTRY_CLOSED"]);

  const audit = await rows(`select * from public.admin_audit_log where entity_type = 'waitlist_entry' and entity_id = $1::uuid`, [entry.id]);
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].action, audit[0].actor_user_id, audit[0].reason], ["WAITLIST_ENTRY_REMOVED", ADMIN, "Pediu para sair pelo WhatsApp"]);
  for (const leaked of [entry.email, entry.phone, entry.full_name]) assert.ok(!JSON.stringify(audit[0].metadata).includes(leaked), leaked);

  const detail = await data.entry(ADMIN, entry.id);
  assert.deepEqual(detail?.events.map((event) => [event.action, event.reason, event.actorName]), [["WAITLIST_ENTRY_REMOVED", "Pediu para sair pelo WhatsApp", "Admin Teste"]]);
  for (const leaked of [entry.email, entry.phone]) assert.ok(!JSON.stringify(response.body).includes(leaked), leaked);
});

test("remoção: repetir não muda nada nem audita de novo; pedido inválido nem chega ao banco", async () => {
  await resetThrottle();
  const session = await soldOut();
  const entry = await join(session);
  assert.equal((await handleWaitlistRemoval(data, ADMIN, entry.id, { reason: "Primeira vez", confirmed: true })).status, 200);
  const again = await handleWaitlistRemoval(data, ADMIN, entry.id, { reason: "Segunda vez", confirmed: true });
  assert.deepEqual([again.status, again.body.removed, again.body.status], [409, false, "REMOVED"]);
  assert.equal((await one(`select count(*)::int as n from public.admin_audit_log where entity_id = $1::uuid`, [entry.id])).n, 1);

  const calls: string[] = [];
  const counting = createWaitlistAdminData((name, args) => { calls.push(name); return pglite.client.rpc(name, args); });
  for (const body of [null, { reason: "ok", confirmed: true }, { reason: "Motivo válido" }]) {
    assert.equal((await handleWaitlistRemoval(counting, ADMIN, entry.id, body)).status, 400);
  }
  assert.deepEqual(calls, []);
  assert.equal((await handleWaitlistRemoval(data, ADMIN, "00000000-0000-4000-8000-000000000000", { reason: "Não existe", confirmed: true })).status, 404);
});

test("remoção não toca reservas, pagamentos nem Stand-by", async () => {
  await resetThrottle();
  const session = await soldOut();
  const entry = await join(session);
  const digest = async () => (await one(
    `select md5(string_agg(t, '|' order by t)) as h from (
       select r::text as t from public.reservations r
       union all select p::text from public.payment_events p
       union all select s::text from public.reservation_standby s
       union all select x::text from public.sessions x) z`,
  )).h;
  const before = await digest();
  await handleWaitlistRemoval(data, ADMIN, entry.id, { reason: "Conferência de isolamento", confirmed: true });
  assert.equal(await digest(), before);
});

// ===========================================================================
// 4. Páginas, rota e menu, no código-fonte
// ===========================================================================

test("rota de remoção: origem, depois autorização (404 desligado, 401, 403), id e corpo", () => {
  const route = code("app/api/admin/waitlist/[entryId]/remove/route.ts");
  const order = ["isSameOriginRequest(request)", "authorizeWaitlistAdminApi()", "isWaitlistUuid(entryId)", "handleWaitlistRemoval("].map((marker) => route.indexOf(marker));
  assert.ok(order.every((index) => index > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(route, /authorization\.context\.profile\.userId/, "o ator vem da sessão");
  assert.doesNotMatch(route, /export async function GET/);
  assert.match(route, /"cache-control": "no-store"/);

  const http = code("lib/admin/http.ts");
  const gate = http.match(/export async function authorizeWaitlistAdminApi[\s\S]*?\n}\n?/)?.[0] ?? "";
  assert.ok(gate.indexOf("isWaitlistAdminEnabled()") < gate.indexOf("authorizeAdminApi()"));
  assert.match(gate, /status: 404/);
});

test("páginas: exigem admin, somem com a variável desligada e não registram dado pessoal", () => {
  for (const path of ["app/admin/lista-de-espera/page.tsx", "app/admin/lista-de-espera/[entryId]/page.tsx"]) {
    const page = code(path);
    assert.ok(page.indexOf("await requireAdmin()") >= 0 && page.indexOf("await requireAdmin()") < page.indexOf("if (!isWaitlistAdminEnabled()) notFound();"), path);
    assert.doesNotMatch(page, /console\.(log|info|warn|error)/, path);
    assert.match(page, /waitlistAdminData\(\)/, path);
    assert.match(page, /context\.profile\.userId/, path);
  }
  const list = code("app/admin/lista-de-espera/page.tsx");
  assert.match(list, /data\.entries\(actor,/);
  assert.match(list, /aria-label="Paginação das inscrições"/);
  assert.match(list, /entry\.status === "ACTIVE" \? <RemoveWaitlistEntryButton/);
  for (const path of ["lib/admin/waitlist.ts", "lib/admin/waitlist-data.ts", "lib/admin/waitlist-server.ts", "components/admin/waitlist/remove-entry-button.tsx"]) {
    assert.doesNotMatch(code(path), /console\.|NEXT_PUBLIC_WAITLIST/, path);
  }
});

test("menu: o item só existe com a variável ligada, depois de Reservas e do Stand-by", () => {
  const shell = code("components/admin/admin-shell.tsx");
  assert.match(shell, /waitlistEnabled\s*\n?\s*\?\s*\[item, \{ href: "\/admin\/lista-de-espera", label: "Lista de espera"/);
  assert.match(shell, /waitlistEnabled = false/);
  assert.match(code("app/admin/layout.tsx"), /waitlistEnabled=\{isWaitlistAdminEnabled\(\)\}/);
  // O trecho do Stand-by continua igual.
  assert.match(shell, /standbyEnabled\s*\?\s*\[item, \{ href: "\/admin\/stand-by"/);
});

test("remoção pede motivo e confirmação na tela, e o botão não aparece para inscrição encerrada", () => {
  const button = code("components/admin/waitlist/remove-entry-button.tsx");
  assert.match(button, /requireReason/);
  assert.match(button, /JSON\.stringify\(\{ reason, confirmed: true \}\)/);
  assert.match(button, /\/api\/admin\/waitlist\/\$\{entryId\}\/remove/);
  assert.match(code("app/admin/lista-de-espera/[entryId]/page.tsx"), /entry\.status === "ACTIVE" \? <RemoveWaitlistEntryButton/);
});

test("a fase 4 não traz migration nem toca reservas, pagamento ou Stand-by", () => {
  const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((file) => file.endsWith(".sql")).sort();
  // O painel só usa as RPCs da fase 1: nenhuma migration é dele.
  assert.ok(migrations.includes("202610250001_waitlist_foundation.sql"));
  assert.ok(!migrations.some((file) => /waitlist_(admin|panel|painel)/i.test(file)));
  for (const path of ["lib/admin/waitlist-data.ts", "app/api/admin/waitlist/[entryId]/remove/route.ts", "app/admin/lista-de-espera/page.tsx", "app/admin/lista-de-espera/[entryId]/page.tsx"]) {
    assert.doesNotMatch(code(path), /admin_cancel_reservation|admin_set_reservation_standby|create_pre_reservation|confirm_reservation_payment|syncReservation/, path);
  }
  assert.match(source(".env.example"), /^# WAITLIST_ADMIN_ENABLED=true$/m);
});
