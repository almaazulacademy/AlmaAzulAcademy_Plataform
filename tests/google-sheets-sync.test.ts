import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isActiveSpot,
  operationalNote,
  parseSnapshot,
  reservationRow,
  sessionLabel,
  spotKey,
  spotRows,
  type ReservationSnapshot,
  type SessionSnapshot,
  type SheetValue,
  type SyncSnapshot,
} from "../lib/integrations/google-sheets/mapping.ts";
import {
  ACTIVE_NO,
  ACTIVE_YES,
  RESERVATION_HEADERS,
  RESERVATIONS_TAB,
  SESSION_HEADERS,
  SESSIONS_TAB,
  SPOT_HEADERS,
  SPOTS_TAB,
} from "../lib/integrations/google-sheets/schema.ts";
import { sessionListFormula, sessionRevenueFormula } from "../lib/integrations/google-sheets/formulas.ts";
import { findForbiddenPublicKeys, readGoogleSheetsConfig } from "../lib/integrations/google-sheets/config.ts";
import { sanitizeErrorCode } from "../lib/integrations/google-sheets/errors.ts";
import { syncSnapshot, type SheetsGateway } from "../lib/integrations/google-sheets/sync.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

// --- Planilha falsa em memória ----------------------------------------------
//
// Nenhum teste desta suíte fala com o Google. O dublê abaixo implementa o mesmo
// contrato de três operações que o cliente real, o que permite verificar o
// resultado final na "planilha" célula a célula — e garante que a CI jamais
// escreva em uma planilha de verdade.

const COLUMN_INDEX = (letters: string) =>
  [...letters].reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 64), 0) - 1;

function parseRange(range: string) {
  const match = /^'(.+)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d*))?$/.exec(range);
  if (!match) throw new Error(`Intervalo não reconhecido: ${range}`);
  return {
    tab: match[1].replace(/''/g, "'"),
    startColumn: COLUMN_INDEX(match[2]),
    startRow: Number(match[3]) - 1,
    endColumn: match[4] ? COLUMN_INDEX(match[4]) : COLUMN_INDEX(match[2]),
  };
}

type FakeSheets = SheetsGateway & {
  grid(tab: string): SheetValue[][];
  dataRows(tab: string): SheetValue[][];
  failNextCalls(count: number): void;
};

function createFakeSheets(): FakeSheets {
  const tabs = new Map<string, SheetValue[][]>();
  let failures = 0;

  const grid = (tab: string) => {
    const existing = tabs.get(tab);
    if (existing) return existing;
    const created: SheetValue[][] = [];
    tabs.set(tab, created);
    return created;
  };

  const guard = () => {
    if (failures > 0) {
      failures -= 1;
      throw new Error("google indisponível");
    }
  };

  const lastUsedRow = (tab: string) => {
    const rows = grid(tab);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if ((rows[index] ?? []).some((cell) => cell !== "" && cell !== undefined)) return index;
    }
    return -1;
  };

  return {
    grid,
    dataRows: (tab: string) => grid(tab).slice(1).filter((row) => (row ?? []).some((cell) => cell !== "")),
    failNextCalls: (count: number) => { failures = count; },

    async batchGet(ranges: string[]) {
      guard();
      return ranges.map((range) => {
        const { tab, startColumn, startRow, endColumn } = parseRange(range);
        const rows = grid(tab);
        const last = lastUsedRow(tab);
        const slice: string[][] = [];
        for (let index = startRow; index <= last; index += 1) {
          const row = rows[index] ?? [];
          slice.push(row.slice(startColumn, endColumn + 1).map((cell) => (cell === undefined ? "" : String(cell))));
        }
        return slice;
      });
    },

    async batchUpdate(updates) {
      guard();
      for (const update of updates) {
        const { tab, startColumn, startRow } = parseRange(update.range);
        const rows = grid(tab);
        update.values.forEach((values, rowOffset) => {
          const target = startRow + rowOffset;
          while (rows.length <= target) rows.push([]);
          values.forEach((value, columnOffset) => {
            rows[target][startColumn + columnOffset] = value;
          });
        });
      }
    },

    async append(range, values) {
      guard();
      const { tab } = parseRange(range);
      const rows = grid(tab);
      let cursor = lastUsedRow(tab) + 1;
      // Espelha o comportamento real: a planilha nasce com a linha 1 de
      // cabeçalho, então o primeiro append cai na linha 2.
      if (cursor === 0) cursor = 1;
      for (const value of values) {
        while (rows.length <= cursor) rows.push([]);
        rows[cursor] = [...value];
        cursor += 1;
      }
    },
  };
}

// --- Dados de exemplo -------------------------------------------------------

const SESSION: SessionSnapshot = {
  id: "5b1a0000-0000-4000-8000-00000000aaaa",
  experienceTitle: "Imersão Paranoá",
  startsAt: "2026-09-06T12:00:00.000Z", // 09:00 em Brasília
  durationMinutes: 90,
  capacity: 28,
  confirmedSpots: 0,
  remainingSpots: 28,
  status: "OPEN",
};

function reservation(overrides: Partial<ReservationSnapshot> = {}): ReservationSnapshot {
  return {
    id: "11110000-0000-4000-8000-000000000001",
    sessionId: SESSION.id,
    publicCode: "AZ7K2M9QX1",
    fullName: "João Silva",
    phone: "+55 61 99999-8888",
    quantity: 1,
    totalCents: 7000,
    status: "CONFIRMED",
    paymentStatus: "PAID",
    paymentMethod: "pix",
    createdAt: "2026-08-18T14:00:00.000Z",
    confirmedAt: "2026-08-18T14:05:00.000Z",
    cancelledAt: null,
    ...overrides,
  };
}

function snapshot(reservations: ReservationSnapshot[], session: Partial<SessionSnapshot> = {}): SyncSnapshot {
  return { session: { ...SESSION, ...session }, reservations };
}

const AT = "2026-08-18T15:00:00.000Z";

async function sync(gateway: FakeSheets, data: SyncSnapshot, reconcile = false) {
  return syncSnapshot(gateway, data, { syncedAt: AT, reconcileSession: reconcile });
}

function column(headers: readonly string[], name: string) {
  const index = headers.indexOf(name);
  assert.notEqual(index, -1, `coluna "${name}" não existe`);
  return index;
}

// --- 1 a 4: expansão de vagas e valor único ---------------------------------

test("reserva confirmada de 1 pessoa ocupa uma linha e uma vaga", async () => {
  const sheets = createFakeSheets();
  await sync(sheets, snapshot([reservation()]));

  assert.equal(sheets.dataRows(RESERVATIONS_TAB).length, 1);
  assert.equal(sheets.dataRows(SPOTS_TAB).length, 1);
  assert.equal(sheets.dataRows(SESSIONS_TAB).length, 1);

  const row = sheets.dataRows(RESERVATIONS_TAB)[0];
  assert.equal(row[column(RESERVATION_HEADERS, "Responsável")], "João Silva");
  assert.equal(row[column(RESERVATION_HEADERS, "Pessoas")], 1);
  assert.equal(row[column(RESERVATION_HEADERS, "Valor total pago")], 70);
  assert.equal(row[column(RESERVATION_HEADERS, "Origem")], "Site");
  assert.equal(row[column(RESERVATION_HEADERS, "Status da reserva")], "Confirmada");
});

test("reserva confirmada de 3 pessoas ocupa três vagas repetindo o responsável", async () => {
  const sheets = createFakeSheets();
  await sync(sheets, snapshot([reservation({ quantity: 3, totalCents: 21000 })]));

  const spots = sheets.dataRows(SPOTS_TAB);
  assert.equal(spots.length, 3, "três pessoas ocupam três vagas");

  const nameColumn = column(SPOT_HEADERS, "Nome");
  const indexColumn = column(SPOT_HEADERS, "Vaga da reserva");
  assert.deepEqual(spots.map((row) => row[nameColumn]), ["João Silva", "João Silva", "João Silva"]);
  assert.deepEqual(spots.map((row) => row[indexColumn]), [1, 2, 3]);

  // A aba de reservas continua com uma única linha para a mesma reserva.
  assert.equal(sheets.dataRows(RESERVATIONS_TAB).length, 1);
  assert.equal(sheets.dataRows(RESERVATIONS_TAB)[0][column(RESERVATION_HEADERS, "Pessoas")], 3);
});

test("o valor total aparece uma única vez e não é multiplicado pela quantidade", async () => {
  const sheets = createFakeSheets();
  await sync(sheets, snapshot([reservation({ quantity: 3, totalCents: 21000 })]));

  const paidColumn = column(SPOT_HEADERS, "Valor pago");
  const values = sheets.dataRows(SPOTS_TAB).map((row) => row[paidColumn]);

  assert.deepEqual(values, [210, "", ""], "R$ 210 na primeira vaga, vazio nas demais");
  const total = values.reduce((sum: number, value) => sum + (typeof value === "number" ? value : 0), 0);
  assert.equal(total, 210, "a arrecadação da turma não pode virar R$ 630");
});

test("a chave de uma vaga é reservation_id + índice", () => {
  assert.equal(spotKey("abc", 1), "abc:1");
  assert.equal(spotKey("abc", 3), "abc:3");
});

// --- 5, 6 e 19: idempotência e concorrência ---------------------------------

test("webhook duplicado não duplica cliente na planilha", async () => {
  const sheets = createFakeSheets();
  const data = snapshot([reservation({ quantity: 3, totalCents: 21000 })]);

  for (let attempt = 0; attempt < 20; attempt += 1) await sync(sheets, data);

  assert.equal(sheets.dataRows(RESERVATIONS_TAB).length, 1);
  assert.equal(sheets.dataRows(SPOTS_TAB).length, 3);
  assert.equal(sheets.dataRows(SESSIONS_TAB).length, 1);
});

test("sincronização repetida converge para exatamente o mesmo conteúdo", async () => {
  const sheets = createFakeSheets();
  const data = snapshot([reservation()]);

  await sync(sheets, data);
  const afterFirst = JSON.stringify(sheets.grid(SPOTS_TAB));
  await sync(sheets, data);
  await sync(sheets, data);

  assert.equal(JSON.stringify(sheets.grid(SPOTS_TAB)), afterFirst);
});

test("duas reservas concorrentes na mesma sessão convivem sem se sobrescrever", async () => {
  const sheets = createFakeSheets();
  const first = reservation({ id: "11110000-0000-4000-8000-000000000001", publicCode: "AAA1111111" });
  const second = reservation({
    id: "22220000-0000-4000-8000-000000000002",
    publicCode: "BBB2222222",
    fullName: "Maria Souza",
    quantity: 2,
    totalCents: 14000,
  });

  await Promise.all([sync(sheets, snapshot([first])), sync(sheets, snapshot([second]))]);
  await sync(sheets, snapshot([first, second]));

  const codes = sheets.dataRows(RESERVATIONS_TAB).map((row) => row[column(RESERVATION_HEADERS, "Código da reserva")]);
  assert.deepEqual([...codes].sort(), ["AAA1111111", "BBB2222222"]);
  assert.equal(sheets.dataRows(SPOTS_TAB).filter((row) => row[column(SPOT_HEADERS, "Ativo")] === ACTIVE_YES).length, 3);
});

test("uma chave duplicada na planilha é neutralizada em vez de duplicar a pessoa", async () => {
  const sheets = createFakeSheets();
  const data = snapshot([reservation()]);
  await sync(sheets, data);

  // Simula a linha colada à mão (ou o append que se cruzou com outro).
  const duplicated = [...sheets.grid(SPOTS_TAB)[1]];
  sheets.grid(SPOTS_TAB).push(duplicated);

  await sync(sheets, data);

  const active = sheets.dataRows(SPOTS_TAB).filter((row) => row[column(SPOT_HEADERS, "Ativo")] === ACTIVE_YES);
  assert.equal(active.length, 1, "só uma das linhas duplicadas continua valendo");
  assert.equal(sheets.dataRows(SPOTS_TAB).length, 2, "a linha extra não é apagada, só desativada");
});

// --- 7, 8 e 14: cancelamento e reconstrução ---------------------------------

test("cancelamento atualiza o status sem apagar o histórico da reserva", async () => {
  const sheets = createFakeSheets();
  const confirmed = reservation({ quantity: 2, totalCents: 14000 });
  await sync(sheets, snapshot([confirmed]));

  await sync(sheets, snapshot([{
    ...confirmed,
    status: "CANCELLED",
    cancelledAt: "2026-08-18T16:00:00.000Z",
  }]));

  const rows = sheets.dataRows(RESERVATIONS_TAB);
  assert.equal(rows.length, 1, "a linha da reserva continua existindo");
  assert.equal(rows[0][column(RESERVATION_HEADERS, "Status da reserva")], "Cancelada");
  assert.equal(rows[0][column(RESERVATION_HEADERS, "Código da reserva")], "AZ7K2M9QX1");
});

test("uma reserva cancelada deixa de ocupar vaga na lista válida", async () => {
  const sheets = createFakeSheets();
  const confirmed = reservation({ quantity: 2, totalCents: 14000 });
  await sync(sheets, snapshot([confirmed]));

  await sync(sheets, snapshot([{ ...confirmed, status: "CANCELLED", cancelledAt: "2026-08-18T16:00:00.000Z" }]));

  const spots = sheets.dataRows(SPOTS_TAB);
  assert.equal(spots.length, 2, "as vagas continuam registradas para rastreabilidade");
  assert.ok(spots.every((row) => row[column(SPOT_HEADERS, "Ativo")] === ACTIVE_NO));
});

test("apenas reserva CONFIRMED vira participante ativo", () => {
  assert.equal(isActiveSpot(reservation({ status: "CONFIRMED" })), true);
  assert.equal(isActiveSpot(reservation({ status: "PRE_RESERVED" })), false);
  assert.equal(isActiveSpot(reservation({ status: "EXPIRED" })), false);
  assert.equal(isActiveSpot(reservation({ status: "CANCELLED" })), false);
});

test("a reconstrução da sessão desativa vagas que não existem mais no Supabase", async () => {
  const sheets = createFakeSheets();
  const keep = reservation({ id: "11110000-0000-4000-8000-000000000001" });
  const gone = reservation({ id: "99990000-0000-4000-8000-000000000009", publicCode: "ZZZ9999999" });

  await sync(sheets, snapshot([keep, gone]));
  assert.equal(sheets.dataRows(SPOTS_TAB).filter((row) => row[column(SPOT_HEADERS, "Ativo")] === ACTIVE_YES).length, 2);

  // O Supabase agora só conhece uma das reservas.
  const report = await sync(sheets, snapshot([keep]), true);

  assert.equal(report.spotsDeactivated, 1);
  const active = sheets.dataRows(SPOTS_TAB).filter((row) => row[column(SPOT_HEADERS, "Ativo")] === ACTIVE_YES);
  assert.equal(active.length, 1);
  assert.equal(active[0][column(SPOT_HEADERS, "Código da reserva")], "AZ7K2M9QX1");
  assert.equal(sheets.dataRows(SPOTS_TAB).length, 2, "nada é removido, só desativado");
});

// --- 11 e 12: falha e retry -------------------------------------------------

test("uma falha do Google interrompe a escrita sem deixar a planilha pela metade", async () => {
  const sheets = createFakeSheets();
  sheets.failNextCalls(1);

  await assert.rejects(() => sync(sheets, snapshot([reservation()])));
  assert.equal(sheets.dataRows(RESERVATIONS_TAB).length, 0);
});

test("o retry seguinte grava tudo corretamente", async () => {
  const sheets = createFakeSheets();
  sheets.failNextCalls(1);
  await assert.rejects(() => sync(sheets, snapshot([reservation({ quantity: 3, totalCents: 21000 })])));

  await sync(sheets, snapshot([reservation({ quantity: 3, totalCents: 21000 })]));

  assert.equal(sheets.dataRows(RESERVATIONS_TAB).length, 1);
  assert.equal(sheets.dataRows(SPOTS_TAB).length, 3);
  assert.deepEqual(
    sheets.dataRows(SPOTS_TAB).map((row) => row[column(SPOT_HEADERS, "Valor pago")]),
    [210, "", ""],
  );
});

// --- 9, 10, 11: falha do Google não desfaz pagamento nem reserva ------------

test("a confirmação de pagamento é calculada antes da planilha e devolvida intacta", () => {
  const confirmation = source("lib/reservations/payment-confirmation.ts");

  // O resultado vem de runConfirmation; a sincronização acontece depois e o
  // valor devolvido é o mesmo, aconteça o que acontecer com o Google.
  const body = confirmation.slice(
    confirmation.indexOf("export async function confirmPayment"),
    confirmation.indexOf("async function runConfirmation"),
  );

  const computed = body.indexOf("await runConfirmation");
  const synced = body.indexOf("await syncReservationAfterChange");
  const returned = body.indexOf("return confirmation;");
  assert.ok(computed >= 0 && synced > computed && returned > synced, "a planilha é o último passo");

  // O resultado é atribuído uma única vez e nunca reescrito pela integração.
  assert.equal(body.match(/confirmation = /g)?.length, 1);
  assert.doesNotMatch(body, /confirmation\.(confirmed|outcome|retryable) =/);
});

test("a sincronização nunca lança para quem confirmou o pagamento", () => {
  const service = source("lib/integrations/google-sheets/service.ts");

  assert.match(service, /export async function syncReservationAfterChange[\s\S]*?try \{[\s\S]*?\} catch \{[\s\S]*?outcome: "PENDING"/);
  assert.match(service, /export async function syncSessionList[\s\S]*?try \{[\s\S]*?\} catch \{[\s\S]*?outcome: "PENDING"/);
  // O job é gravado antes de qualquer chamada ao Google: se a instância morrer
  // no meio, o pendente já está durável no Supabase.
  const entity = service.slice(service.indexOf("export async function syncSheetEntity"));
  assert.ok(entity.indexOf("enqueue_integration_sync_job") < entity.indexOf("createSheetsClient("));
});

test("uma falha vira job pendente com código sanitizado", () => {
  const service = source("lib/integrations/google-sheets/service.ts");
  assert.match(service, /fail_integration_sync_job/);
  assert.match(service, /p_error_code: errorCode/);

  assert.equal(sanitizeErrorCode(new Error("chave privada -----BEGIN PRIVATE KEY----- vazou")), "UNEXPECTED_ERROR");
  assert.equal(sanitizeErrorCode({ message: "qualquer coisa" }), "UNEXPECTED_ERROR");
});

// --- 13: sincronização administrativa ---------------------------------------

test("as rotas administrativas de sincronização exigem admin e mesma origem", () => {
  for (const path of [
    "app/api/admin/reservations/[reservationId]/sync-sheet/route.ts",
    "app/api/admin/sessions/[sessionId]/sync-sheet/route.ts",
  ]) {
    const route = source(path);
    assert.match(route, /isSameOriginRequest/);
    assert.match(route, /authorizeAdminApi/);
    assert.match(route, /isUuid/);
    assert.match(route, /outcome === "DISABLED"/);
  }

  assert.match(source("components/admin/reservation-actions.tsx"), /Sincronizar planilha/);
  assert.match(source("components/admin/sessions-manager.tsx"), /Sincronizar lista/);
  assert.match(source("app/admin/reservas/[reservationId]/page.tsx"), /getSheetSyncState/);
});

// --- 15, 16, 17: privacidade -------------------------------------------------

test("nenhum CPF, e-mail ou endereço chega às linhas da planilha", async () => {
  const sheets = createFakeSheets();
  await sync(sheets, snapshot([reservation({ quantity: 3, totalCents: 21000 })]));

  const everything = JSON.stringify([
    sheets.grid(RESERVATIONS_TAB),
    sheets.grid(SESSIONS_TAB),
    sheets.grid(SPOTS_TAB),
  ]).toLowerCase();

  for (const forbidden of ["cpf", "@", "endere", "cart", "token", "secret", "private", "checkout", "hash"]) {
    assert.doesNotMatch(everything, new RegExp(forbidden), `"${forbidden}" não pode aparecer na planilha`);
  }
});

test("o tipo de entrada da sincronização não tem campo sensível para preencher", () => {
  const mapping = source("lib/integrations/google-sheets/mapping.ts");
  const type = mapping.slice(mapping.indexOf("export type ReservationSnapshot"), mapping.indexOf("export type SessionSnapshot"));

  for (const field of ["cpf", "email", "address", "checkoutUrl", "providerReference", "payload", "notes"]) {
    assert.doesNotMatch(type, new RegExp(field, "i"), `ReservationSnapshot não pode conhecer "${field}"`);
  }
  for (const header of [...RESERVATION_HEADERS, ...SPOT_HEADERS, ...SESSION_HEADERS]) {
    assert.doesNotMatch(header, /cpf|e-?mail|endere|cart[aã]o/i);
  }
});

test("a observação enviada é gerada pelo sistema, nunca o texto livre do cliente", () => {
  assert.equal(operationalNote(reservation()), "");
  assert.equal(operationalNote(reservation({ quantity: 3 })), "Reserva de 3 pessoas");
  assert.match(operationalNote(reservation({ paymentStatus: "PAID_AFTER_EXPIRATION" })), /reconciliado/i);
  assert.match(operationalNote(reservation({ paymentMethod: "manual" })), /manual/i);
  assert.match(
    operationalNote(reservation({ status: "CANCELLED", cancelledAt: "2026-08-18T16:00:00.000Z" })),
    /Cancelada em 18\/08\/2026/,
  );
});

test("os logs da integração não carregam nome, telefone, célula nem credencial", () => {
  const observability = source("lib/integrations/google-sheets/observability.ts");

  for (const forbidden of ["phone", "fullName", "name", "privateKey", "accessToken", "values", "cell"]) {
    assert.doesNotMatch(observability, new RegExp(`entry\\.${forbidden}`), `log não pode incluir ${forbidden}`);
  }
  assert.match(observability, /maskIdentifier\(fields\.entityId\)/);

  // O erro do Google carrega só um código; corpo e cabeçalho ficam de fora.
  const errors = source("lib/integrations/google-sheets/errors.ts");
  assert.doesNotMatch(errors, /response\.text\(\)|response\.json\(\)|\.body/);

  const client = source("lib/integrations/google-sheets/client.ts");
  assert.doesNotMatch(client, /console\./, "o cliente não loga nada por conta própria");
});

test("as variáveis do Google não podem ser públicas", () => {
  assert.deepEqual(findForbiddenPublicKeys({ NEXT_PUBLIC_GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "x" }), [
    "NEXT_PUBLIC_GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY",
  ]);
  assert.deepEqual(findForbiddenPublicKeys({}), []);

  assert.equal(readGoogleSheetsConfig({}), null, "sem variáveis, a integração fica desligada");
  assert.equal(
    readGoogleSheetsConfig({
      GOOGLE_SHEETS_SPREADSHEET_ID: "id",
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "conta@projeto.iam.gserviceaccount.com",
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "não é um PEM",
    }),
    null,
    "chave malformada não liga a integração",
  );

  const configured = readGoogleSheetsConfig({
    GOOGLE_SHEETS_SPREADSHEET_ID: "id",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "conta@projeto.iam.gserviceaccount.com",
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
  });
  assert.ok(configured);
  assert.match(configured.privateKey, /\n/, "o \\n literal vira quebra de linha de verdade");
  assert.equal(configured.timeoutMs, 8000);

  assert.doesNotMatch(source(".env.example"), /NEXT_PUBLIC_GOOGLE/);
});

// --- 18: a planilha nunca altera o Supabase ---------------------------------

test("a sincronização não escreve em reservas, sessões ou capacidade", () => {
  const engine = source("lib/integrations/google-sheets/sync.ts");
  const service = source("lib/integrations/google-sheets/service.ts");

  for (const code of [engine, service]) {
    assert.doesNotMatch(code, /\.from\("reservations"\)|\.from\("sessions"\)|\.from\("experiences"\)/);
    assert.doesNotMatch(code, /\.update\(|\.insert\(|\.upsert\(|\.delete\(/);
  }

  // As únicas RPCs chamadas são de fila e de leitura de snapshot.
  const calls = [...service.matchAll(/\.rpc\("([a-z_]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual([...new Set(calls)], [
    "claim_integration_sync_jobs",
    "complete_integration_sync_job",
    "enqueue_integration_sync_job",
    "fail_integration_sync_job",
    "integration_sync_state",
  ]);
  assert.match(service, /snapshotFunctionFor/);
});

test("a quantidade da reserva só vira número de vagas na planilha", async () => {
  const sheets = createFakeSheets();
  await sync(sheets, snapshot([reservation({ quantity: 3, totalCents: 21000 })], { capacity: 28, remainingSpots: 25, confirmedSpots: 3 }));

  const row = sheets.dataRows(SESSIONS_TAB)[0];
  assert.equal(row[column(SESSION_HEADERS, "Capacidade")], 28, "a capacidade vem do sistema, não da soma da planilha");
  assert.equal(row[column(SESSION_HEADERS, "Confirmados")], 3);
  assert.equal(row[column(SESSION_HEADERS, "Vagas restantes")], 25);
});

// --- 20, 21: acentos e telefone brasileiro ----------------------------------

test("acentos, cedilha e apóstrofo sobrevivem sem transformação", async () => {
  const sheets = createFakeSheets();
  const name = "João Gonçalves d'Ávila Júnior";
  await sync(sheets, snapshot([reservation({ fullName: name })], { experienceTitle: "Imersão Paranoá" }));

  assert.equal(sheets.dataRows(RESERVATIONS_TAB)[0][column(RESERVATION_HEADERS, "Responsável")], name);
  assert.equal(sheets.dataRows(SPOTS_TAB)[0][column(SPOT_HEADERS, "Nome")], name);
  assert.equal(sheets.dataRows(SESSIONS_TAB)[0][column(SESSION_HEADERS, "Experiência")], "Imersão Paranoá");
});

test("o telefone brasileiro é gravado no formato de discagem", async () => {
  const sheets = createFakeSheets();
  await sync(sheets, snapshot([reservation({ phone: "+55 61 99999-8888" })]));

  assert.equal(sheets.dataRows(RESERVATIONS_TAB)[0][column(RESERVATION_HEADERS, "WhatsApp")], "(61) 99999-8888");
  assert.equal(sheets.dataRows(SPOTS_TAB)[0][column(SPOT_HEADERS, "WhatsApp")], "(61) 99999-8888");

  const fixedLine = createFakeSheets();
  await sync(fixedLine, snapshot([reservation({ phone: "6133334444" })]));
  assert.equal(fixedLine.dataRows(RESERVATIONS_TAB)[0][column(RESERVATION_HEADERS, "WhatsApp")], "(61) 3333-4444");
});

// --- Rótulo, data e fórmulas ------------------------------------------------

test("o rótulo da sessão usa data, experiência e horário de Brasília", () => {
  assert.equal(sessionLabel(SESSION), "06/09/2026 · Imersão Paranoá · 09:00");
});

test("a data e o horário da reserva seguem o fuso de Brasília", () => {
  const row = reservationRow(reservation(), SESSION, AT);
  assert.equal(row[column(RESERVATION_HEADERS, "Data")], "06/09/2026");
  assert.equal(row[column(RESERVATION_HEADERS, "Horário")], "09:00");
});

test("as fórmulas da lista usam só vírgula como separador e não têm literal de matriz", () => {
  for (const formula of [sessionListFormula(), sessionRevenueFormula()]) {
    assert.match(formula, /^=/);
    assert.doesNotMatch(formula, /[{}]/, "literal de matriz depende do idioma da planilha");
    assert.doesNotMatch(formula, /;/, "o separador da API é a vírgula");
  }

  // A lista filtra por session_id e por vaga ativa — nunca por nome.
  assert.match(sessionListFormula(), /\$J\$1/);
  assert.match(sessionListFormula(), /="SIM"/);
  assert.match(sessionRevenueFormula(), /SUMIFS/);
});

// --- Leitura do snapshot ----------------------------------------------------

test("um snapshot malformado não derruba a sincronização", () => {
  assert.equal(parseSnapshot(null), null);
  assert.equal(parseSnapshot({}), null);
  assert.equal(parseSnapshot({ session: { id: "x" } }), null);

  const parsed = parseSnapshot({
    session: { id: "s1", experienceTitle: "Imersão", startsAt: AT, capacity: 28, confirmedSpots: 1, remainingSpots: 27, status: "OPEN" },
    reservations: [null, "texto", { id: "r1", quantity: 0 }],
  });
  assert.ok(parsed);
  assert.equal(parsed.reservations.length, 1);
  assert.equal(parsed.reservations[0].quantity, 1, "quantidade inválida vira ao menos uma vaga");
  assert.equal(parsed.reservations[0].sessionId, "s1");
});

test("as vagas carregam a chave técnica e a ordem de criação", () => {
  const rows = spotRows(reservation({ quantity: 2, totalCents: 14000 }), SESSION, AT);
  assert.deepEqual(rows.map((row) => row.key), [
    "11110000-0000-4000-8000-000000000001:1",
    "11110000-0000-4000-8000-000000000001:2",
  ]);
  assert.equal(rows[1].values[column(SPOT_HEADERS, "Ordem")], "2026-08-18T14:00:00.000Z");
  assert.match(String(rows[1].values[column(SPOT_HEADERS, "Observações")]), /Vaga 2 de 2/);
});

// --- 22: a CI nunca fala com o Google ---------------------------------------

test("nenhum teste alcança a rede: o motor de sincronização não conhece fetch", () => {
  const engine = source("lib/integrations/google-sheets/sync.ts");
  assert.doesNotMatch(engine, /fetch\(|https?:\/\//);
  assert.doesNotMatch(engine, /node:crypto|process\.env/);

  // A suíte só usa o dublê em memória: nenhum import alcança o cliente HTTP
  // nem a autenticação da conta de serviço.
  const suite = source("tests/google-sheets-sync.test.ts");
  const imports = suite.slice(0, suite.indexOf("function source("));
  assert.doesNotMatch(imports, /google-sheets\/(client|auth|service)/);
  assert.doesNotMatch(suite, /process\.env\.GOOGLE/);

  // A CI não define nenhuma variável do Google.
  assert.doesNotMatch(source(".github/workflows/ci.yml"), /GOOGLE_/);
});
