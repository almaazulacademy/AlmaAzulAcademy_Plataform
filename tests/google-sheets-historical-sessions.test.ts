/**
 * Planilha: sessões históricas congeladas, consulta ao Stand-by e recuperação.
 *
 * Exercita o serviço central de sincronização de verdade — `runSheetSyncJob` e a
 * fila de pendentes — contra um Postgres real em memória e a planilha falsa. Os
 * snapshots, os jobs e as autorizações de Stand-by são os do banco; só o Google
 * e o Supabase hospedado são dublês. Nenhum teste fala com a rede.
 *
 * Os `session_id` congelados vêm do registro do código, não de valores inventados
 * aqui: cada teste percorre o que estiver em `FROZEN_SHEET_SESSION_IDS`.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  FROZEN_SHEET_SESSION_IDS,
  HISTORICAL_SESSION_PREFIXES,
  isFrozenSheetSession,
  pendingHistoricalPrefixes,
} from "../lib/integrations/google-sheets/frozen-sessions.ts";
import { parseSnapshot, reservationRow, sessionRow, spotRows, type SyncSnapshot } from "../lib/integrations/google-sheets/mapping.ts";
import {
  ACTIVE_YES,
  RESERVATION_COLUMN,
  RESERVATION_HEADERS,
  RESERVATIONS_TAB,
  rowRange,
  SESSION_HEADERS,
  SESSIONS_TAB,
  SPOT_COLUMN,
  SPOT_HEADERS,
  SPOTS_TAB,
} from "../lib/integrations/google-sheets/schema.ts";
import { drainPendingSheetJobs, runSheetSyncJob } from "../lib/integrations/google-sheets/service.ts";
import { isStandbyOriginUpdateOnly, parseStandbyOriginRows, standbyLookupNeed } from "../lib/integrations/google-sheets/standby-guard.ts";
import { syncSnapshot } from "../lib/integrations/google-sheets/sync.ts";
import { createFakeSheets, type FakeSheets } from "./support/fake-sheets.ts";
import { fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";

const ROOT = new URL("../", import.meta.url).pathname;

function source(path: string) {
  return readFileSync(join(ROOT, path), "utf8");
}

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(join(ROOT, path)).isDirectory() ? files(path) : [path];
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
type Entity = "RESERVATION" | "SESSION";
type AdminClient = Parameters<typeof runSheetSyncJob>[0];
type Gateway = Parameters<typeof runSheetSyncJob>[1];

const FROZEN_IDS = [...FROZEN_SHEET_SESSION_IDS];
const ADMIN = "c0000000-0000-4000-8000-000000000001";
const AT = "2026-10-14T12:00:00.000Z";
const FROZEN = { synced: true, skipped: true, skipReason: "SESSION_FROZEN" } as const;

// --- Planilha que conta chamadas ------------------------------------------------

function countingSheets(sheets: FakeSheets = createFakeSheets()) {
  const count = { batchGet: 0, batchUpdate: 0, ensureRows: 0 };
  const gateway: Gateway = {
    batchGet: async (ranges) => { count.batchGet += 1; return sheets.batchGet(ranges); },
    ensureRows: async (requirements) => { count.ensureRows += 1; return sheets.ensureRows(requirements); },
    batchUpdate: async (updates) => { count.batchUpdate += 1; return sheets.batchUpdate(updates); },
  };
  return { sheets, gateway, count, calls: () => count.batchGet + count.batchUpdate + count.ensureRows };
}

type Target = ReturnType<typeof countingSheets>;

function cells(sheets: FakeSheets) {
  return [SESSIONS_TAB, RESERVATIONS_TAB, SPOTS_TAB].flatMap((tab) => sheets.dataRows(tab).flat().map(String));
}

function frozenState(sheets: FakeSheets) {
  return JSON.stringify([SESSIONS_TAB, RESERVATIONS_TAB, SPOTS_TAB].map((tab) => sheets.grid(tab)));
}

function sessionIds(sheets: FakeSheets) {
  return sheets.dataRows(SESSIONS_TAB).map((row) => String(row[0])).sort();
}

function reservationRows(sheets: FakeSheets, sessionId: string) {
  return sheets.dataRows(RESERVATIONS_TAB).filter((row) => row[RESERVATION_COLUMN.sessionId - 1] === sessionId);
}

function spotRowsOf(sheets: FakeSheets, sessionId: string) {
  return sheets.dataRows(SPOTS_TAB).filter((row) => row[SPOT_COLUMN.sessionId - 1] === sessionId);
}

// --- Um banco, com equipe, catálogo e fábricas ----------------------------------

async function createWorld() {
  const db = await fullDatabase();
  const admin = createPgliteAdmin(db);
  const client = admin.client as unknown as AdminClient;
  let sequence = 0;

  async function rows(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await db.query(sql, params)).rows as Row[];
  }
  async function one(sql: string, params: unknown[] = []): Promise<Row> {
    const result = await rows(sql, params);
    assert.ok(result.length >= 1, `sem linhas: ${sql}`);
    return result[0];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function call(expression: string, params: unknown[] = []): Promise<any> {
    return (await one(`select ${expression} as value`, params)).value;
  }

  await db.exec(`
    insert into auth.users (id, email) values ('${ADMIN}', 'admin@teste.local');
    insert into public.admin_users (user_id, display_name, role, is_active) values ('${ADMIN}', 'Admin Teste', 'ADMIN', true);
  `);
  const experience = await one(`select id from public.experiences where slug = 'imersao-paranoa'`);

  function uniquePrice() {
    sequence += 1;
    return 40_000 + sequence * 100;
  }

  async function makeSession(options: { id?: string; price: number; capacity?: number }) {
    sequence += 1;
    const created = await one(
      `insert into public.sessions (id, experience_id, starts_at, duration_minutes, price_cents, capacity, status)
       values (coalesce($1::uuid, gen_random_uuid()), $2::uuid, now() + interval '10 days' + make_interval(secs => $3), 90, $4, $5, 'OPEN')
       returning id`,
      [options.id ?? null, experience.id, sequence, options.price, options.capacity ?? 12],
    );
    return created.id as string;
  }

  async function preReserve(sessionId: string, quantity = 1) {
    sequence += 1;
    const created = await call(
      `public.create_pre_reservation($1::uuid, $2, $3, '+5561999990000', $4, $5, null, gen_random_uuid())`,
      [sessionId, `Cliente Histórico ${sequence}`, String(30_000_000_000 + sequence), `historico${sequence}@teste.local`, quantity],
    );
    return { id: created.reservationId as string, total: created.totalCents as number };
  }

  async function reserve(sessionId: string, quantity = 1) {
    const booking = await preReserve(sessionId, quantity);
    assert.equal(
      await call(`public.confirm_reservation_payment($1::uuid, 'INFINITEPAY', $2, $3, 'https://recibo.teste/1', '{}'::jsonb)`, [booking.id, `tx-${booking.id}`, booking.total]),
      true,
    );
    return booking.id;
  }

  /** Os dois passos de `syncSheetEntity`: grava o job e tenta agora. */
  async function sync(target: Target, entity: Entity, entityId: string, operation: string) {
    const enqueue = await admin.client.rpc("enqueue_integration_sync_job", {
      p_integration: "GOOGLE_SHEETS", p_entity_type: entity, p_entity_id: entityId, p_operation: operation,
    });
    assert.equal(enqueue.error, null);
    return runSheetSyncJob(client, target.gateway, { id: enqueue.data as string, entityType: entity, entityId, operation, attempt: 1 });
  }

  function drain(target: Target) {
    return drainPendingSheetJobs(client, target.gateway, 25);
  }

  function job(entity: Entity, entityId: string) {
    return one(
      `select status, attempts, last_error_code from public.integration_sync_jobs where integration = 'GOOGLE_SHEETS' and entity_type = $1 and entity_id = $2::uuid`,
      [entity, entityId],
    );
  }

  async function snapshot(entity: Entity, entityId: string): Promise<SyncSnapshot> {
    const raw = entity === "SESSION"
      ? await call(`public.google_sheets_session_snapshot($1::uuid)`, [entityId])
      : await call(`public.google_sheets_reservation_snapshot($1::uuid)`, [entityId]);
    const parsed = parseSnapshot(raw);
    assert.ok(parsed, "snapshot");
    return parsed;
  }

  const setStandby = (reservationId: string) => call(`public.admin_set_reservation_standby($1::uuid, $2::uuid, 'Turma cancelada por mau tempo')`, [ADMIN, reservationId]);
  const cancel = (reservationId: string) => call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Cliente pediu o cancelamento')`, [ADMIN, reservationId]);
  const reschedule = (reservationId: string, sessionId: string) => call(`public.admin_reschedule_standby_same_price($1::uuid, $2::uuid, $3::uuid, null)`, [ADMIN, reservationId, sessionId]);
  const undo = (reservationId: string) => call(`public.admin_undo_reservation_standby($1::uuid, $2::uuid, null)`, [ADMIN, reservationId]);
  const changeSession = (reservationId: string, sessionId: string) => call(`public.admin_change_reservation_session($1::uuid, $2::uuid, $3::uuid, 'Pedido do cliente')`, [ADMIN, reservationId, sessionId]);

  /**
   * Uma sessão histórica com o `session_id` congelado e seis reservas pagas,
   * levada para 15/08/2026 depois de receber as reservas.
   */
  async function historicalSession(sessionId: string) {
    const price = uniquePrice();
    await makeSession({ id: sessionId, price });
    const reservations: string[] = [];
    for (let index = 0; index < 6; index += 1) reservations.push(await reserve(sessionId));
    await db.query(`update public.sessions set starts_at = timestamptz '2026-08-15 12:00:00+00' where id = $1::uuid`, [sessionId]);
    const [a, b, c, d, e, f] = reservations;
    return { sessionId, price, a, b, c, d, e, f };
  }

  return { db, admin, client, rows, one, call, uniquePrice, makeSession, preReserve, reserve, sync, drain, job, snapshot, setStandby, cancel, reschedule, undo, changeSession, historicalSession };
}

type World = Awaited<ReturnType<typeof createWorld>>;
type Historical = Awaited<ReturnType<World["historicalSession"]>>;

/**
 * Passa a sessão histórica por todas as origens de sincronização que existem.
 * Cada passo confere, na hora, que a sessão congelada não gerou nenhuma chamada
 * ao Google nem leitura de Stand-by.
 */
async function runEveryOrigin(world: World, target: Target, session: Historical) {
  const { sync, admin } = world;
  const destination = await world.makeSession({ price: session.price });
  const otherDestination = await world.makeSession({ price: session.price });

  async function frozenStep(label: string, run: () => ReturnType<World["sync"]>) {
    const before = target.calls();
    admin.reset();
    assert.deepEqual(await run(), FROZEN, label);
    assert.equal(target.calls(), before, `${label}: nenhuma chamada ao Google`);
    assert.deepEqual(admin.calls.from, [], `${label}: nenhuma leitura de Stand-by`);
  }

  // 1. Confirmação de pagamento — webhook repetido, retorno e reconciliação
  //    chegam todos como uma sincronização "CONFIRMED" da reserva.
  await frozenStep("pagamento confirmado", () => sync(target, "RESERVATION", session.a, "CONFIRMED"));
  await frozenStep("reconciliação de pagamento", () => sync(target, "RESERVATION", session.a, "CONFIRMED"));
  assert.equal((await world.job("RESERVATION", session.a)).status, "SYNCED", "o job é encerrado, não fica girando na fila");

  // 2. Cancelamento comum.
  await world.cancel(session.b);
  await frozenStep("cancelamento", () => sync(target, "RESERVATION", session.b, "CANCELLED"));

  // 3. Entrada em Stand-by e cancelamento em Stand-by.
  await world.setStandby(session.c);
  await frozenStep("entrada em Stand-by", () => sync(target, "RESERVATION", session.c, "STANDBY"));
  await world.cancel(session.c);
  await frozenStep("cancelamento em Stand-by", () => sync(target, "RESERVATION", session.c, "CANCELLED"));

  // 4. Reagendamento a partir do Stand-by: as duas escritas de
  //    `syncReservationSessionChange` — a reserva e a turma antiga.
  await world.setStandby(session.d);
  await frozenStep("entrada em Stand-by (d)", () => sync(target, "RESERVATION", session.d, "STANDBY"));
  await world.reschedule(session.d, destination);
  const moved = await sync(target, "RESERVATION", session.d, "SESSION_CHANGED");
  assert.deepEqual(moved, { synced: true }, "a reserva reagendada sincroniza normalmente na turma nova");
  await frozenStep("reconstrução da turma antiga após Stand-by", () => sync(target, "SESSION", session.sessionId, "REBUILD"));

  // 5. Reagendamento administrativo tradicional.
  assert.ok(await world.changeSession(session.e, otherDestination), "a troca direta continua aceitando sessão histórica como origem");
  assert.deepEqual(await sync(target, "RESERVATION", session.e, "SESSION_CHANGED"), { synced: true });
  await frozenStep("reconstrução da turma antiga após troca direta", () => sync(target, "SESSION", session.sessionId, "REBUILD"));

  // 6. Sincronização manual: os dois botões.
  await frozenStep("botão da reserva", () => sync(target, "RESERVATION", session.a, "ADMIN"));
  await frozenStep("botão da sessão", () => sync(target, "SESSION", session.sessionId, "REBUILD"));

  // 7. Jobs pendentes: dois jobs que já falharam duas vezes, retomados pela fila.
  await world.setStandby(session.f);
  for (const [entity, id] of [["RESERVATION", session.f], ["SESSION", session.sessionId]] as const) {
    const enqueued = await admin.client.rpc("enqueue_integration_sync_job", { p_integration: "GOOGLE_SHEETS", p_entity_type: entity, p_entity_id: id, p_operation: "REBUILD" });
    for (let failure = 0; failure < 2; failure += 1) {
      await admin.client.rpc("fail_integration_sync_job", { p_job_id: enqueued.data, p_error_code: "HTTP_400" });
    }
    assert.deepEqual(await world.job(entity, id), { status: "FAILED", attempts: 2, last_error_code: "HTTP_400" });
  }
  const before = target.calls();
  admin.reset();
  assert.equal(await world.drain(target), 2, "a fila retoma os dois jobs");
  assert.equal(target.calls(), before, "jobs pendentes: nenhuma chamada ao Google");
  assert.deepEqual(admin.calls.from, [], "jobs pendentes: nenhuma leitura de Stand-by");
  assert.equal((await world.job("RESERVATION", session.f)).status, "SYNCED");
  assert.equal((await world.job("SESSION", session.sessionId)).status, "SYNCED");

  return { destination, otherDestination };
}

const absent = await createWorld();
const absentSessions = new Map<string, Historical>();
for (const sessionId of FROZEN_IDS) absentSessions.set(sessionId, await absent.historicalSession(sessionId));

const partial = await createWorld();
const partialSessions = new Map<string, Historical>();
for (const sessionId of FROZEN_IDS) partialSessions.set(sessionId, await partial.historicalSession(sessionId));

// =============================================================================
// 1. O registro
// =============================================================================

test("registro: os prefixos do código são exatamente os 14 do documento do incidente", () => {
  const document = source("docs/incident-2026-10-google-sheets-grid-limit.md");
  const line = document.split("\n").find((entry) => entry.startsWith("Prefixos dos `session_id`"));
  assert.ok(line, "o documento do incidente lista os prefixos");
  const documented = [...line.matchAll(/`([0-9a-f]{8})`/g)].map((match) => match[1]);
  assert.equal(documented.length, 14);
  assert.equal(new Set(documented).size, 14);
  assert.deepEqual([...HISTORICAL_SESSION_PREFIXES].sort(), [...documented].sort());
});

test("registro: só session_id completo, cada um de um prefixo documentado, sem repetição", () => {
  assert.ok(FROZEN_IDS.length >= 2);
  for (const id of FROZEN_IDS) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, id);
    assert.ok((HISTORICAL_SESSION_PREFIXES as readonly string[]).includes(id.slice(0, 8)), `${id} não é uma das 14 sessões documentadas`);
  }
  assert.equal(new Set(FROZEN_IDS.map((id) => id.slice(0, 8))).size, FROZEN_IDS.length, "um id por prefixo");
  // As duas turmas de 15/08/2026 parcialmente presentes na planilha.
  assert.ok(FROZEN_SHEET_SESSION_IDS.has("0a98cf4c-4d40-411d-987e-a383479fc2e1"));
  assert.ok(FROZEN_SHEET_SESSION_IDS.has("87077465-49ee-4b94-b89d-aa56296aabd0"));
});

test("registro: PENDENTE — doze das 14 ainda sem o session_id completo", () => {
  // O documento do incidente guarda só os oito primeiros caracteres, e as doze
  // sessões abaixo não estão na planilha nem no repositório. Quando os ids
  // completos vierem do Supabase e entrarem no registro, esta lista fica vazia —
  // e este teste precisa ser atualizado junto, de propósito.
  assert.deepEqual(pendingHistoricalPrefixes(), [
    "0ca42ebe", "49a818bf", "4d77bf1d", "5589d4c6", "6547901a", "86480dee",
    "8796cfff", "8d78dd76", "9b40060d", "c3969f2c", "c42e5181", "d47907c1",
  ]);
  assert.equal(FROZEN_IDS.length + pendingHistoricalPrefixes().length, 14);
});

test("registro: só o id inteiro congela — prefixo, id parecido e lixo não", () => {
  for (const id of FROZEN_IDS) {
    assert.equal(isFrozenSheetSession(id), true);
    assert.equal(isFrozenSheetSession(id.toUpperCase()), true);
    assert.equal(isFrozenSheetSession(`  ${id} `), true);
    assert.equal(isFrozenSheetSession(id.slice(0, 8)), false, "prefixo sozinho não congela");
    assert.equal(isFrozenSheetSession(`${id.slice(0, 8)}-0000-4000-8000-000000000000`), false, "mesmo prefixo, outra sessão");
    assert.equal(isFrozenSheetSession(`${id.slice(0, -1)}${id.endsWith("0") ? "1" : "0"}`), false, "um caractere de diferença");
    assert.equal(isFrozenSheetSession(`${id}0`), false);
  }
  // Os prefixos ainda sem id completo não congelam nada: não há regra por prefixo.
  for (const prefix of pendingHistoricalPrefixes()) {
    assert.equal(isFrozenSheetSession(prefix), false);
    assert.equal(isFrozenSheetSession(`${prefix}-0000-4000-8000-000000000000`), false);
  }
  for (const value of ["", "5b1a0000-0000-4000-8000-00000000aaaa", null, undefined, 42, {}]) assert.equal(isFrozenSheetSession(value), false);
});

test("a consulta que devolve os ids completos é somente leitura, sem dado pessoal e cobre os 14 prefixos", async () => {
  const sql = source("supabase/diagnostics/google_sheets_historical_sessions.sql");
  const code = sql.replace(/--.*$/gm, "");
  assert.ok(!/\b(insert|update|delete|alter|create|drop|grant|revoke|truncate)\b/i.test(code.replace(/'[^']*'/g, "''")), "somente leitura");
  assert.doesNotMatch(code, /full_name|cpf|phone|email|public_code/i, "sem dado pessoal");
  assert.deepEqual([...code.matchAll(/'([0-9a-f]{8})'/g)].map((match) => match[1]).sort(), [...HISTORICAL_SESSION_PREFIXES].sort());

  // Roda de verdade e devolve o id inteiro das sessões que existem neste banco.
  const result = await absent.rows(sql);
  assert.deepEqual(result.map((row) => row.session_id).sort(), [...FROZEN_IDS].sort());
  for (const row of result) {
    assert.equal(row.prefixo, String(row.session_id).slice(0, 8));
    assert.equal(row.inicio, "15/08/2026 09:00");
    assert.deepEqual(Object.keys(row).sort(), ["experiencia", "inicio", "prefixo", "reservas_confirmadas", "session_id", "status", "vagas_confirmadas"]);
  }
});

// =============================================================================
// 2. O motor
// =============================================================================

test("motor: sessão congelada não é lida nem escrita, em nenhum modo", async () => {
  for (const sessionId of FROZEN_IDS) {
    const data = await absent.snapshot("SESSION", sessionId);
    assert.equal(data.session.id, sessionId);
    assert.equal(data.reservations.length, 6);
    for (const options of [{}, { reconcileSession: true }, { updateOnly: true }, { reconcileSession: true, updateOnly: true }]) {
      const target = countingSheets();
      const report = await syncSnapshot(target.gateway, data, { syncedAt: AT, ...options });
      assert.deepEqual(report, { sessionId, reservations: 6, rowsUpdated: 0, rowsAppended: 0, spotsDeactivated: 0, skipped: true, skipReason: "SESSION_FROZEN" });
      assert.equal(target.calls(), 0, "nem a leitura da planilha acontece");
    }
  }
});

// =============================================================================
// 3. Todas as origens, sessão ausente da planilha
// =============================================================================

for (const sessionId of FROZEN_IDS) {
  test(`sessão histórica ${sessionId.slice(0, 8)}, ausente da planilha: nenhuma origem cria, reconstrói ou acrescenta linha`, async () => {
    const session = absentSessions.get(sessionId)!;
    const target = countingSheets();

    // A planilha já tem uma turma normal, para "nada da histórica" não ser "planilha vazia".
    const regularSession = await absent.makeSession({ price: absent.uniquePrice() });
    const regular = await absent.reserve(regularSession, 2);
    assert.deepEqual(await absent.sync(target, "RESERVATION", regular, "CONFIRMED"), { synced: true });

    const { destination, otherDestination } = await runEveryOrigin(absent, target, session);

    assert.ok(!cells(target.sheets).includes(sessionId), "o session_id congelado não aparece em nenhuma célula");
    assert.deepEqual(sessionIds(target.sheets), [regularSession, destination, otherDestination].sort());
    for (const reservationId of [session.a, session.b, session.c, session.f]) {
      assert.ok(!cells(target.sheets).includes(reservationId), "reserva que ficou na sessão histórica não é escrita");
    }
    // As duas reservas que saíram da sessão histórica estão nas turmas novas.
    assert.equal(reservationRows(target.sheets, destination)[0][0], session.d);
    assert.equal(reservationRows(target.sheets, otherDestination)[0][0], session.e);
    assert.equal(spotRowsOf(target.sheets, destination).filter((row) => row[SPOT_COLUMN.active - 1] === ACTIVE_YES).length, 1);
  });
}

// =============================================================================
// 4. Todas as origens, sessão parcialmente presente na planilha
// =============================================================================

/** Grava na planilha, como a sincronização teria gravado em agosto, a sessão e duas das seis reservas. */
async function seedPartialSession(world: World, target: Target, session: Historical) {
  const data = await world.snapshot("SESSION", session.sessionId);
  const present = data.reservations.filter((reservation) => reservation.id === session.a || reservation.id === session.d);
  assert.equal(present.length, 2);
  const spots = present.flatMap((reservation) => spotRows(reservation, data.session, AT));
  const sessionRowNumber = target.sheets.grid(SESSIONS_TAB).length + 1;
  const reservationRowNumber = target.sheets.grid(RESERVATIONS_TAB).length + 1;
  const spotRowNumber = target.sheets.grid(SPOTS_TAB).length + 1;
  await target.sheets.batchUpdate([
    { range: rowRange(SESSIONS_TAB, sessionRowNumber, SESSION_HEADERS.length), values: [sessionRow(data.session, AT)] },
    ...present.map((reservation, index) => ({
      range: rowRange(RESERVATIONS_TAB, reservationRowNumber + index, RESERVATION_HEADERS.length),
      values: [reservationRow(reservation, data.session, AT)],
    })),
    ...spots.map((spot, index) => ({ range: rowRange(SPOTS_TAB, spotRowNumber + index, SPOT_HEADERS.length), values: [spot.values] })),
  ]);
}

for (const sessionId of FROZEN_IDS) {
  test(`sessão histórica ${sessionId.slice(0, 8)}, parcialmente presente: as linhas existentes não são reescritas e nenhuma é acrescentada`, async () => {
    const session = partialSessions.get(sessionId)!;
    const target = countingSheets();
    await seedPartialSession(partial, target, session);

    const sessionRowBefore = JSON.stringify(target.sheets.dataRows(SESSIONS_TAB).find((row) => row[0] === sessionId));
    const keptReservationBefore = JSON.stringify(target.sheets.dataRows(RESERVATIONS_TAB).find((row) => row[0] === session.a));
    const keptSpotsBefore = JSON.stringify(target.sheets.dataRows(SPOTS_TAB).filter((row) => row[SPOT_COLUMN.reservationId - 1] === session.a));
    assert.equal(reservationRows(target.sheets, sessionId).length, 2, "duas das seis reservas estão na planilha");
    assert.equal(spotRowsOf(target.sheets, sessionId).length, 2);
    const reservationCountBefore = target.sheets.dataRows(RESERVATIONS_TAB).length;

    // Até a reserva `d` sair da sessão, a planilha não pode mudar em nada:
    // pagamento repetido, cancelamentos e Stand-by acontecem com ela congelada.
    const stateBefore = frozenState(target.sheets);
    const callsBefore = target.calls();
    for (const [reservationId, operation] of [[session.a, "CONFIRMED"], [session.a, "ADMIN"], [session.d, "ADMIN"]] as const) {
      assert.deepEqual(await partial.sync(target, "RESERVATION", reservationId, operation), FROZEN);
    }
    assert.deepEqual(await partial.sync(target, "SESSION", sessionId, "REBUILD"), FROZEN);
    assert.equal(frozenState(target.sheets), stateBefore, "byte a byte igual");
    assert.equal(target.calls(), callsBefore);

    const { destination, otherDestination } = await runEveryOrigin(partial, target, session);

    // A linha da sessão histórica e a reserva que ficou nela: intactas.
    assert.equal(JSON.stringify(target.sheets.dataRows(SESSIONS_TAB).find((row) => row[0] === sessionId)), sessionRowBefore, "linha da sessão não foi reescrita");
    assert.equal(JSON.stringify(target.sheets.dataRows(RESERVATIONS_TAB).find((row) => row[0] === session.a)), keptReservationBefore, "linha da reserva não foi reescrita");
    assert.equal(JSON.stringify(target.sheets.dataRows(SPOTS_TAB).filter((row) => row[SPOT_COLUMN.reservationId - 1] === session.a)), keptSpotsBefore, "vagas não foram reescritas");

    // Nenhuma linha foi acrescentada à sessão histórica: canceladas, em
    // Stand-by e as que nunca estiveram na planilha continuam fora.
    for (const reservationId of [session.b, session.c, session.f]) {
      assert.ok(!cells(target.sheets).includes(reservationId), "reserva ausente continua ausente");
    }
    assert.deepEqual(reservationRows(target.sheets, sessionId).map((row) => row[0]), [session.a], "só a reserva que ficou");
    assert.equal(spotRowsOf(target.sheets, sessionId).length, 1);

    // A única linha que mudou é a da reserva reagendada: ela deixou de pertencer
    // à sessão histórica, e a mesma linha — mesma chave — passou para a turma nova.
    assert.deepEqual(reservationRows(target.sheets, destination).map((row) => row[0]), [session.d]);
    assert.equal(target.sheets.dataRows(RESERVATIONS_TAB).filter((row) => row[0] === session.d).length, 1, "sem linha duplicada");
    // A reserva `e` não estava na planilha: entrou só na turma nova dela.
    assert.deepEqual(reservationRows(target.sheets, otherDestination).map((row) => row[0]), [session.e]);
    assert.equal(target.sheets.dataRows(RESERVATIONS_TAB).length, reservationCountBefore + 1, "uma única linha nova: a da reserva `e`, na turma nova");
    assert.deepEqual(sessionIds(target.sheets), [sessionId, destination, otherDestination].sort());
  });
}

// =============================================================================
// 5. As demais sessões: comportamento normal preservado
// =============================================================================

test("pagamento normal: a turma é criada pela primeira reserva e reservation_standby não é consultada", async () => {
  const world = absent;
  const target = countingSheets();
  const sessionId = await world.makeSession({ price: world.uniquePrice() });
  const first = await world.reserve(sessionId, 2);
  const second = await world.reserve(sessionId, 1);

  world.admin.reset();
  assert.deepEqual(await world.sync(target, "RESERVATION", first, "CONFIRMED"), { synced: true });
  assert.deepEqual(await world.sync(target, "RESERVATION", second, "CONFIRMED"), { synced: true });
  // Webhook repetido: mesma sincronização, mesmas linhas.
  assert.deepEqual(await world.sync(target, "RESERVATION", first, "CONFIRMED"), { synced: true });

  assert.deepEqual(world.admin.calls.from, [], "o caminho do pagamento não lê reservation_standby");
  assert.deepEqual(sessionIds(target.sheets), [sessionId]);
  assert.deepEqual(reservationRows(target.sheets, sessionId).map((row) => row[0]).sort(), [first, second].sort());
  assert.equal(spotRowsOf(target.sheets, sessionId).filter((row) => row[SPOT_COLUMN.active - 1] === ACTIVE_YES).length, 3);
  assert.equal((await world.job("RESERVATION", first)).status, "SYNCED");
});

test("a consulta ao Stand-by só acontece quando o snapshot não basta para decidir", async () => {
  const world = absent;
  const price = world.uniquePrice();
  const sessionId = await world.makeSession({ price });
  const confirmed = await world.reserve(sessionId);
  const pending = (await world.preReserve(sessionId)).id;
  const cancelled = await world.reserve(sessionId);
  const parked = await world.reserve(sessionId);
  await world.cancel(cancelled);
  await world.setStandby(parked);

  const target = countingSheets();
  await world.sync(target, "RESERVATION", confirmed, "CONFIRMED");

  const cases: Array<[string, Entity, string, string, number]> = [
    ["confirmada", "RESERVATION", confirmed, "CONFIRMED", 0],
    ["pré-reserva", "RESERVATION", pending, "ADMIN", 0],
    ["em Stand-by", "RESERVATION", parked, "STANDBY", 0],
    ["cancelada", "RESERVATION", cancelled, "CANCELLED", 1],
    ["reconstrução da sessão", "SESSION", sessionId, "REBUILD", 1],
  ];
  for (const [label, entity, entityId, operation, lookups] of cases) {
    world.admin.reset();
    assert.deepEqual(await world.sync(target, entity, entityId, operation), { synced: true }, label);
    assert.equal(world.admin.calls.from.filter((table) => table === "reservation_standby").length, lookups, `${label}: ${lookups} consulta(s)`);
  }
});

test("o atalho pelo status decide igual à regra completa, em todos os estados que o banco produz", async () => {
  const world = absent;
  const price = world.uniquePrice();
  const sessionId = await world.makeSession({ price });
  const elsewhere = await world.makeSession({ price });

  const confirmed = await world.reserve(sessionId);
  const pending = (await world.preReserve(sessionId)).id;
  const cancelled = await world.reserve(sessionId);
  const parked = await world.reserve(sessionId);
  const cancelledInStandby = await world.reserve(sessionId);
  const restored = await world.reserve(sessionId);
  const moved = await world.reserve(sessionId);
  await world.cancel(cancelled);
  await world.setStandby(parked);
  await world.setStandby(cancelledInStandby);
  await world.cancel(cancelledInStandby);
  await world.setStandby(restored);
  await world.undo(restored);
  await world.setStandby(moved);
  await world.reschedule(moved, elsewhere);

  const expected: Array<[string, string, boolean]> = [
    ["confirmada", confirmed, false],
    ["pré-reserva", pending, false],
    ["cancelada sem Stand-by", cancelled, false],
    ["em Stand-by", parked, true],
    ["cancelada em Stand-by", cancelledInStandby, true],
    ["devolvida à turma", restored, false],
    ["reagendada", moved, false],
  ];
  for (const [label, reservationId, updateOnly] of expected) {
    const data = await world.snapshot("RESERVATION", reservationId);
    const origins = parseStandbyOriginRows(await world.rows(
      `select reservation_id, resolved_at, resolution, resolved_session_id from public.reservation_standby where original_session_id = $1::uuid`,
      [data.session.id],
    ));
    const full = isStandbyOriginUpdateOnly("RESERVATION", reservationId, data.session.id, origins);
    assert.equal(full, updateOnly, `${label}: regra completa`);

    const need = standbyLookupNeed("RESERVATION", reservationId, data.reservations);
    if (need === "LOOKUP") continue;
    assert.equal(need === "UPDATE_ONLY", full, `${label}: o atalho (${need}) não pode discordar da regra completa`);
  }
  // E os estados em que o atalho dispensa a consulta são os esperados.
  const needOf = async (reservationId: string) => standbyLookupNeed("RESERVATION", reservationId, (await world.snapshot("RESERVATION", reservationId)).reservations);
  assert.equal(await needOf(confirmed), "NORMAL");
  assert.equal(await needOf(restored), "NORMAL");
  assert.equal(await needOf(moved), "NORMAL");
  assert.equal(await needOf(parked), "UPDATE_ONLY");
  assert.equal(await needOf(cancelled), "LOOKUP");
  assert.equal(await needOf(cancelledInStandby), "LOOKUP");
  assert.equal(standbyLookupNeed("SESSION", sessionId, []), "LOOKUP");
  assert.equal(standbyLookupNeed("RESERVATION", confirmed, []), "LOOKUP", "reserva fora do próprio snapshot: pergunta ao banco");
});

test("turma comum que foi origem de Stand-by e não está na planilha continua em 'somente atualizar'", async () => {
  const world = absent;
  const price = world.uniquePrice();
  const origin = await world.makeSession({ price });
  const parked = await world.reserve(origin);
  const cancelled = await world.reserve(origin);
  await world.setStandby(parked);
  await world.setStandby(cancelled);
  await world.cancel(cancelled);

  const target = countingSheets();
  const skipped = { synced: true, skipped: true, skipReason: "SESSION_NOT_IN_SHEET" };
  assert.deepEqual(await world.sync(target, "RESERVATION", parked, "STANDBY"), skipped);
  assert.deepEqual(await world.sync(target, "RESERVATION", cancelled, "CANCELLED"), skipped);
  assert.deepEqual(await world.sync(target, "SESSION", origin, "REBUILD"), skipped);
  assert.equal(target.count.batchUpdate + target.count.ensureRows, 0);
  assert.deepEqual(sessionIds(target.sheets), []);
});

// =============================================================================
// 6. Falhas e recuperação
// =============================================================================

test("Google fora do ar: o pagamento e a reserva não mudam, o job fica pendente e a fila recupera", async () => {
  const world = absent;
  const sessionId = await world.makeSession({ price: world.uniquePrice() });
  const reservationId = await world.reserve(sessionId, 2);
  const before = await world.one(`select status, confirmed_at, total_cents from public.reservations where id = $1::uuid`, [reservationId]);
  const eventsBefore = await world.rows(`select id from public.payment_events where reservation_id = $1::uuid order by id`, [reservationId]);

  const target = countingSheets();
  target.sheets.failNextCalls(1);
  const failed = await world.sync(target, "RESERVATION", reservationId, "CONFIRMED");
  assert.deepEqual(failed, { synced: false, errorCode: "UNEXPECTED_ERROR" }, "devolve o resultado; não lança");
  assert.deepEqual(await world.job("RESERVATION", reservationId), { status: "FAILED", attempts: 1, last_error_code: "UNEXPECTED_ERROR" });
  assert.deepEqual(sessionIds(target.sheets), [], "nada pela metade");

  // Nada do pagamento ou da reserva foi tocado.
  assert.deepEqual(await world.one(`select status, confirmed_at, total_cents from public.reservations where id = $1::uuid`, [reservationId]), before);
  assert.deepEqual(await world.rows(`select id from public.payment_events where reservation_id = $1::uuid order by id`, [reservationId]), eventsBefore);

  // A próxima sincronização bem-sucedida de qualquer reserva drena a fila.
  assert.equal(await world.drain(target), 1);
  assert.deepEqual(await world.job("RESERVATION", reservationId), { status: "SYNCED", attempts: 1, last_error_code: null });
  assert.deepEqual(reservationRows(target.sheets, sessionId).map((row) => row[0]), [reservationId]);
});

test("falha na consulta necessária ao Stand-by: nada é escrito, o job fica pendente e a nova tentativa conclui", async () => {
  const world = absent;
  const sessionId = await world.makeSession({ price: world.uniquePrice() });
  const kept = await world.reserve(sessionId);
  const cancelled = await world.reserve(sessionId);
  const target = countingSheets();
  await world.sync(target, "RESERVATION", kept, "CONFIRMED");
  await world.sync(target, "RESERVATION", cancelled, "CONFIRMED");
  await world.cancel(cancelled);
  const stateBefore = frozenState(target.sheets);
  const callsBefore = target.calls();

  // Reserva cancelada: é preciso perguntar ao banco, e a pergunta falha.
  world.admin.failFrom("reservation_standby", { code: "57014", message: "canceling statement due to statement timeout" });
  assert.deepEqual(await world.sync(target, "RESERVATION", cancelled, "CANCELLED"), { synced: false, errorCode: "STANDBY_LOOKUP_UNAVAILABLE" });
  assert.equal(target.calls(), callsBefore, "sem saber o modo, a planilha nem é lida");
  assert.equal(frozenState(target.sheets), stateBefore);
  assert.deepEqual(await world.job("RESERVATION", cancelled), { status: "FAILED", attempts: 1, last_error_code: "STANDBY_LOOKUP_UNAVAILABLE" });

  // Reconstrução de sessão: mesma coisa.
  world.admin.failFrom("reservation_standby", { code: "XX000" });
  assert.deepEqual(await world.sync(target, "SESSION", sessionId, "REBUILD"), { synced: false, errorCode: "STANDBY_LOOKUP_UNAVAILABLE" });
  assert.equal(frozenState(target.sheets), stateBefore);

  // A nova tentativa, com o banco respondendo, conclui os dois.
  assert.equal(await world.drain(target), 2);
  assert.equal((await world.job("RESERVATION", cancelled)).status, "SYNCED");
  assert.equal((await world.job("SESSION", sessionId)).status, "SYNCED");
  const cancelledRow = target.sheets.dataRows(RESERVATIONS_TAB).find((row) => row[0] === cancelled);
  assert.ok(cancelledRow?.includes("Cancelada"));
});

test("a mesma falha não alcança a confirmação de pagamento: reserva confirmada não consulta o Stand-by", async () => {
  const world = absent;
  const sessionId = await world.makeSession({ price: world.uniquePrice() });
  const reservationId = await world.reserve(sessionId);
  const target = countingSheets();

  // Toda leitura de reservation_standby falharia — mas nenhuma é feita.
  world.admin.failFrom("reservation_standby", { code: "57014" }, 5);
  world.admin.reset();
  assert.deepEqual(await world.sync(target, "RESERVATION", reservationId, "CONFIRMED"), { synced: true });
  assert.deepEqual(world.admin.calls.from, []);
  assert.deepEqual(reservationRows(target.sheets, sessionId).map((row) => row[0]), [reservationId]);
  world.admin.clearFailures();
});

test("banco sem a tabela de Stand-by: a sincronização segue normal", async () => {
  const world = absent;
  const sessionId = await world.makeSession({ price: world.uniquePrice() });
  const cancelled = await world.reserve(sessionId);
  await world.cancel(cancelled);
  const target = countingSheets();

  for (const code of ["PGRST205", "42P01"]) {
    world.admin.failFrom("reservation_standby", { code });
    assert.deepEqual(await world.sync(target, "RESERVATION", cancelled, "CANCELLED"), { synced: true }, code);
  }
  assert.deepEqual(sessionIds(target.sheets), [sessionId]);
});

test("o serviço nunca lança: nem com o snapshot fora do ar, nem se o registro da falha também falhar", async () => {
  const world = absent;
  const sessionId = await world.makeSession({ price: world.uniquePrice() });
  const reservationId = await world.reserve(sessionId);
  const target = countingSheets();

  world.admin.failRpc("google_sheets_reservation_snapshot", { code: "57P03" });
  assert.deepEqual(await world.sync(target, "RESERVATION", reservationId, "CONFIRMED"), { synced: false, errorCode: "SNAPSHOT_UNAVAILABLE" });

  target.sheets.failNextCalls(1);
  world.admin.failRpc("fail_integration_sync_job", { code: "57P03" });
  assert.deepEqual(await world.sync(target, "RESERVATION", reservationId, "CONFIRMED"), { synced: false, errorCode: "UNEXPECTED_ERROR" });
  // O job continua aberto — pior caso, é retentado.
  assert.notEqual((await world.job("RESERVATION", reservationId)).status, "SYNCED");
  assert.equal(await world.drain(target), 1);
  assert.equal((await world.job("RESERVATION", reservationId)).status, "SYNCED");
});

test("tentativas esgotadas: a fila para de insistir e o botão manual reabre o job", async () => {
  const world = absent;
  const sessionId = await world.makeSession({ price: world.uniquePrice() });
  const reservationId = await world.reserve(sessionId);
  const target = countingSheets();

  target.sheets.failNextCalls(1);
  await world.sync(target, "RESERVATION", reservationId, "CONFIRMED");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    target.sheets.failNextCalls(1);
    assert.equal(await world.drain(target), 0);
  }
  assert.deepEqual(await world.job("RESERVATION", reservationId), { status: "FAILED", attempts: 5, last_error_code: "UNEXPECTED_ERROR" });
  assert.equal(await world.drain(target), 0, "com cinco falhas a fila não retoma sozinha");
  assert.deepEqual(sessionIds(target.sheets), []);

  // "Sincronizar planilha": o mesmo job, com as tentativas zeradas.
  assert.deepEqual(await world.sync(target, "RESERVATION", reservationId, "ADMIN"), { synced: true });
  assert.deepEqual(await world.job("RESERVATION", reservationId), { status: "SYNCED", attempts: 0, last_error_code: null });
  assert.deepEqual(reservationRows(target.sheets, sessionId).map((row) => row[0]), [reservationId]);
});

// =============================================================================
// 7. A proteção mora no serviço central
// =============================================================================

test("toda sincronização — imediata ou da fila — passa por runSheetSyncJob, e é lá que a sessão congelada é barrada", () => {
  const service = source("lib/integrations/google-sheets/service.ts");
  const engine = source("lib/integrations/google-sheets/sync.ts");
  const job = service.slice(service.indexOf("export async function runSheetSyncJob"), service.indexOf("export async function drainPendingSheetJobs"));

  // Dois chamadores, e só dois: o envio imediato e a fila.
  assert.equal([...service.matchAll(/await runSheetSyncJob\(admin, client, \{/g)].length, 2);
  assert.match(service.slice(service.indexOf("export async function drainPendingSheetJobs")), /await runSheetSyncJob\(admin, client, \{/);
  assert.match(service.slice(service.indexOf("export async function syncSheetEntity")), /await runSheetSyncJob\(admin, client, \{/);

  // No serviço: antes da consulta ao Stand-by e antes do motor.
  const frozenCheck = job.indexOf("isFrozenSheetSession(snapshot.session.id)");
  assert.ok(frozenCheck > 0);
  assert.ok(frozenCheck < job.indexOf("standbyUpdateOnly("));
  assert.ok(frozenCheck < job.indexOf("syncSnapshot("));
  assert.match(job, /errorCode: "SESSION_FROZEN"/);

  // No motor: antes da primeira chamada ao Google.
  const body = engine.slice(engine.indexOf("export async function syncSnapshot"));
  assert.ok(body.indexOf("isFrozenSheetSession(session.id)") < body.indexOf("gateway.batchGet("));

  // Nenhuma rota, tela ou módulo fora da integração escreve na planilha.
  const outside = [...files("app"), ...files("lib"), ...files("components")]
    .filter((path) => /\.tsx?$/.test(path) && !path.startsWith("lib/integrations/google-sheets/"))
    .filter((path) => /createSheetsClient|syncSnapshot\(|runSheetSyncJob\(|\.batchUpdate\(/.test(source(path)));
  assert.deepEqual(outside, []);

  // E o registro não tem regra por data nem por prefixo.
  const registry = source("lib/integrations/google-sheets/frozen-sessions.ts");
  assert.doesNotMatch(registry, /startsWith\(|new Date\(|Date\.parse|starts_at|startsAt/);
});

test("as origens pedidas chegam todas ao mesmo serviço", () => {
  const callers: Array<[string, RegExp]> = [
    // Confirmação de pagamento: webhook, retorno e "Verificar pagamento".
    ["lib/reservations/payment-confirmation.ts", /await syncReservationAfterChange\(reservationId, "CONFIRMED"\)/],
    // Reconciliação: os mesmos efeitos pós-confirmação.
    ["lib/reservations/payment-reconciliation.ts", /await settle\(\)\.catch\(\(\) => undefined\)/],
    // Confirmação manual, cancelamento e reagendamento tradicional.
    ["lib/admin/data.ts", /await syncReservationAfterChange\(reservationId, "ADMIN"\)/],
    ["lib/admin/data.ts", /await syncReservationAfterChange\(reservationId, "CANCELLED"\)/],
    ["lib/admin/data.ts", /await syncReservationSessionChange\(reservationId, change\.previousSessionId\)/],
    // Stand-by: entrada, desfazer e reagendamento.
    ["lib/admin/standby-data.ts", /await syncReservationAfterChange\(reservationId, "STANDBY"\)/],
    ["lib/admin/standby-data.ts", /await syncReservationSessionChange\(reservationId, resolution\.previousSessionId\)/],
    // Botões manuais.
    ["app/api/admin/reservations/[reservationId]/sync-sheet/route.ts", /await syncReservationAfterChange\(reservationId, "ADMIN"\)/],
    ["app/api/admin/sessions/[sessionId]/sync-sheet/route.ts", /await syncSessionList\(sessionId\)/],
  ];
  for (const [path, pattern] of callers) assert.match(source(path), pattern, path);

  const service = source("lib/integrations/google-sheets/service.ts");
  for (const entry of ["syncReservationAfterChange", "syncSessionList"]) {
    const body = service.slice(service.indexOf(`export async function ${entry}`));
    assert.match(body.slice(0, body.indexOf("\n}\n")), /return await syncSheetEntity\(/, entry);
  }
  // Os botões dizem ao admin por que nada foi escrito.
  for (const route of ["app/api/admin/reservations/[reservationId]/sync-sheet/route.ts", "app/api/admin/sessions/[sessionId]/sync-sheet/route.ts"]) {
    assert.match(source(route), /result\.skipReason === "SESSION_FROZEN"/);
    assert.match(source(route), /sessão histórica mantida fora da sincronização/);
  }
});
