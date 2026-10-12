/**
 * Painel de Stand-by (etapa 3): regras da aplicação.
 *
 * Sem banco e sem Next: ativação por variável de ambiente, validação das ações,
 * leitura das respostas, textos, a regra do modo "somente atualizar" da planilha
 * e os contratos das rotas — quem pode chamar, de onde, e o que nunca é
 * registrado. O comportamento do banco está em `reservation-standby-admin.test.ts`.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { adminMutationError, standbyMutationError } from "../lib/admin/mutation-errors.ts";
import { isAdminRole } from "../lib/admin/roles.ts";
import {
  isStandbyAdminEnabled,
  isStandbyLinkToken,
  parseStandbyHistory,
  parseStandbyLink,
  parseStandbyListFilters,
  parseStandbyListPage,
  parseStandbyOptions,
  parseStandbyResolution,
  restoreRejectionMessage,
  STANDBY_PAGE_SIZE,
  standbyActorLabel,
  standbyEventLabel,
  standbyLinkMessage,
  standbyLinkUrl,
  standbyListHref,
  standbyPageCount,
  standbyResolutionLabel,
  validateStandbyEntry,
  validateStandbyReschedule,
  validateStandbyUndo,
} from "../lib/admin/standby.ts";
import { sanitizeErrorCode } from "../lib/integrations/google-sheets/errors.ts";
import type { ReservationSnapshot, SessionSnapshot } from "../lib/integrations/google-sheets/mapping.ts";
import { RESERVATIONS_TAB, SESSIONS_TAB, SPOTS_TAB } from "../lib/integrations/google-sheets/schema.ts";
import { isStandbyOriginUpdateOnly, isStandbyTableMissing, parseStandbyOriginRows, type StandbyOriginRow } from "../lib/integrations/google-sheets/standby-guard.ts";
import { syncSnapshot } from "../lib/integrations/google-sheets/sync.ts";
import { createFakeSheets } from "./support/fake-sheets.ts";

const ROOT = new URL("../", import.meta.url).pathname;

function source(path: string) {
  return readFileSync(join(ROOT, path), "utf8");
}

function files(dir: string): string[] {
  if (!existsSync(join(ROOT, dir))) return [];
  return readdirSync(join(ROOT, dir)).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(join(ROOT, path)).isDirectory() ? files(path) : [path];
  });
}

const STANDBY_ROUTES = files("app/api/admin/reservations/[reservationId]/standby").filter((path) => path.endsWith("route.ts"));
const TOKEN = "a".repeat(64);

// =============================================================================
// 1. Ativação: publicar não liga nada
// =============================================================================

test("o painel só existe com STANDBY_ADMIN_ENABLED=true", () => {
  assert.equal(isStandbyAdminEnabled({}), false);
  for (const value of ["", "false", "0", "1", "yes", "on", "TRUE-ish", "habilitado"]) {
    assert.equal(isStandbyAdminEnabled({ STANDBY_ADMIN_ENABLED: value }), false, value);
  }
  for (const value of ["true", "TRUE", " true "]) {
    assert.equal(isStandbyAdminEnabled({ STANDBY_ADMIN_ENABLED: value }), true, value);
  }
});

test("a variável é de servidor e está documentada como desligada por padrão", () => {
  const env = source(".env.example");
  assert.match(env, /^# STANDBY_ADMIN_ENABLED=true$/m, "comentada no exemplo: quem copiar o arquivo não liga o painel");
  assert.doesNotMatch(env, /NEXT_PUBLIC_STANDBY/);
  for (const path of [...files("app"), ...files("components"), ...files("lib")].filter((file) => /\.tsx?$/.test(file))) {
    assert.doesNotMatch(source(path), /NEXT_PUBLIC_STANDBY/, path);
  }
});

test("com o painel desligado: sem menu, sem página, sem botões e sem rota", () => {
  // Menu: o item só entra quando o layout diz que o painel está ligado.
  const shell = source("components/admin/admin-shell.tsx");
  assert.match(shell, /standbyEnabled\s*\?\s*\[item, \{ href: "\/admin\/stand-by"/);
  assert.match(shell, /standbyEnabled = false/);
  assert.match(source("app/admin/layout.tsx"), /standbyEnabled=\{isStandbyAdminEnabled\(\)\}/);

  // Página: 404 antes de qualquer consulta.
  const page = source("app/admin/stand-by/page.tsx");
  assert.ok(page.indexOf("if (!isStandbyAdminEnabled()) notFound();") < page.indexOf("listStandbyReservations("));
  assert.ok(page.indexOf("requireAdmin()") < page.indexOf("isStandbyAdminEnabled()"));

  // Botões: só existem quando a página passa `standby`.
  const actions = source("components/admin/reservation-actions.tsx");
  assert.match(actions, /status === "CONFIRMED" && standby\?\.entry/);
  assert.match(actions, /status === "AWAITING_RESCHEDULE" && standby \?/);
  assert.match(source("app/admin/reservas/page.tsx"), /standbyEnabled=\{isStandbyAdminEnabled\(\)\}/);
  assert.match(source("components/admin/reservations-list.tsx"), /standby=\{standbyEnabled \? \{/);
  assert.match(source("app/admin/reservas/[reservationId]/page.tsx"), /standby=\{standbyEnabled \? \{/);

  // Rotas: 404 antes da autorização.
  const http = source("lib/admin/http.ts");
  const gate = http.slice(http.indexOf("export async function authorizeStandbyApi"));
  assert.ok(gate.indexOf("!isStandbyAdminEnabled()") < gate.indexOf("authorizeAdminApi()"));
  assert.match(gate, /status: 404/);
});

// =============================================================================
// 2. Rotas: quem pode chamar, e de onde
// =============================================================================

test("as quatro rotas de Stand-by existem", () => {
  assert.deepEqual(STANDBY_ROUTES.map((path) => path.replace("app/api/admin/reservations/[reservationId]/", "")).sort(), [
    "standby/link/route.ts",
    "standby/reschedule/route.ts",
    "standby/route.ts",
    "standby/undo/route.ts",
  ]);
});

test("toda rota de Stand-by exige painel ligado e ADMIN ou OPERATOR; instrutor recebe 403", () => {
  for (const path of STANDBY_ROUTES) {
    const code = source(path);
    assert.match(code, /authorizeStandbyApi\(\)/, path);
    assert.doesNotMatch(code, /authorizeCheckinApi|getStaffContext/, `${path} não pode aceitar instrutor`);
    assert.match(code, /if \(!authorization\.context\) return authorization\.response;/, path);
    assert.match(code, /isUuid\(reservationId\)/, path);
    // O ator vem da sessão validada, nunca do corpo da requisição.
    assert.match(code, /authorization\.context\.profile\.userId/, path);
    assert.doesNotMatch(code, /actorId|p_actor_id|body\.actor/, path);
  }
  const http = source("lib/admin/http.ts");
  assert.match(http, /export async function authorizeAdminApi\(\) \{[\s\S]*?getAdminContext\(\)[\s\S]*?denied\(403\)/);
  assert.equal(isAdminRole("INSTRUCTOR"), false);
  assert.equal(isAdminRole("ADMIN"), true);
  assert.equal(isAdminRole("OPERATOR"), true);
  assert.match(source("app/admin/stand-by/page.tsx"), /await requireAdmin\(\)/);
});

test("toda mutação de Stand-by confere a origem antes de qualquer outra coisa", () => {
  for (const path of STANDBY_ROUTES) {
    const code = source(path);
    for (const handler of code.split(/(?=export async function )/).filter((part) => part.startsWith("export async function"))) {
      const method = /export async function (\w+)/.exec(handler)?.[1];
      if (method === "GET") {
        assert.doesNotMatch(handler, /\.rpc\(|setReservationStandby|undoReservationStandby|rescheduleReservationFromStandby|generateStandbyLink|revokeStandbyLink/, `${path} GET é leitura`);
        continue;
      }
      assert.ok(handler.indexOf("isSameOriginRequest(request)") !== -1, `${path} ${method} confere origem`);
      assert.ok(handler.indexOf("isSameOriginRequest(request)") < handler.indexOf("authorizeStandbyApi()"), `${path} ${method}: origem primeiro`);
    }
  }
});

test("as rotas só chamam as operações de Stand-by — nenhuma escreve em tabela", () => {
  const data = source("lib/admin/standby-data.ts");
  const called = [...data.matchAll(/\.rpc\("([a-z_]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(called, [
    "admin_generate_reservation_standby_link",
    "admin_list_standby_reservations_page",
    "admin_reschedule_standby_same_price",
    "admin_reservation_standby_history",
    "admin_revoke_reservation_standby_link",
    "admin_set_reservation_standby",
    "admin_standby_reschedule_options",
    "admin_undo_reservation_standby",
  ]);
  assert.doesNotMatch(data, /\.from\(|\.update\(|\.insert\(|\.delete\(|\.upsert\(/);
  // O reagendamento do painel é o da régua do mesmo valor, nunca o sem régua.
  assert.doesNotMatch(data, /"admin_reschedule_reservation_from_standby"|"admin_change_reservation_session"/);
  // Nenhum e-mail sai por estas ações.
  assert.doesNotMatch(data, /sendReservationConfirmationEmail|resend/i);
});

// =============================================================================
// 3. Token do link: aparece uma vez e não é registrado
// =============================================================================

test("o token do link não vai para log, auditoria, URL nem armazenamento do navegador", () => {
  const touched = [
    ...STANDBY_ROUTES,
    "lib/admin/standby-data.ts",
    "lib/admin/standby.ts",
    ...files("components/admin/standby"),
  ];
  for (const path of touched) {
    const code = source(path);
    assert.doesNotMatch(code, /console\.(log|info|warn|error|debug)/, `${path} não registra nada`);
    assert.doesNotMatch(code, /localStorage|sessionStorage|document\.cookie|searchParams\.set\("r"/, `${path} não guarda o link`);
  }
  const route = source("app/api/admin/reservations/[reservationId]/standby/link/route.ts");
  assert.match(route, /"cache-control": "no-store"/);
  assert.doesNotMatch(route, /token: link\.token/, "a resposta leva a URL pronta, não o token solto");
  assert.doesNotMatch(route, /recordPaymentStep|admin_audit_log|logSheets|logPayment/);

  // Na tela, o link vive só no estado do componente e some ao fechar.
  const actions = source("components/admin/standby/standby-actions.tsx");
  assert.match(actions, /const \[linkUrl, setLinkUrl\] = useState\(""\)/);
  assert.match(actions, /onClick=\{\(\) => setLinkUrl\(""\)\}/);
  assert.match(actions, /não será mostrado de novo/);
});

test("link: o token vai no fragmento, que o navegador não envia ao servidor", () => {
  const url = standbyLinkUrl("https://www.almaazulacademy.com.br/", TOKEN);
  assert.equal(url, `https://www.almaazulacademy.com.br/acompanhar-reserva#r=${TOKEN}`);
  assert.equal(new URL(url).search, "", "nada do token na query string");
  assert.equal(new URL(url).hash, `#r=${TOKEN}`);

  const message = standbyLinkMessage("  Marina Lopes  ", "AZ7K2M9QX1", url);
  assert.match(message, /^Olá, Marina!/);
  assert.match(message, /AZ7K2M9QX1/);
  assert.ok(message.endsWith(url));

  assert.equal(isStandbyLinkToken(TOKEN), true);
  for (const value of [TOKEN.toUpperCase(), TOKEN.slice(1), `${TOKEN}0`, "", null, 42]) assert.equal(isStandbyLinkToken(value), false);
  assert.deepEqual(parseStandbyLink({ standbyId: "s", token: TOKEN, createdAt: "2026-10-14T12:00:00Z" }), { standbyId: "s", token: TOKEN, createdAt: "2026-10-14T12:00:00Z" });
  assert.equal(parseStandbyLink({ standbyId: "s", token: "curto" }), null);
  assert.equal(parseStandbyLink(null), null);
});

// =============================================================================
// 4. Validação das ações
// =============================================================================

test("colocar em Stand-by exige motivo e confirmação explícita", () => {
  assert.deepEqual(validateStandbyEntry({ reason: "  Turma   cancelada ", confirmed: true }), { success: true, data: { reason: "Turma cancelada" } });

  const noReason = validateStandbyEntry({ reason: " x ", confirmed: true });
  assert.equal(noReason.success, false);
  assert.ok(!noReason.success && noReason.errors.reason);

  for (const confirmed of [false, "true", 1, undefined, null]) {
    const result = validateStandbyEntry({ reason: "Motivo válido", confirmed });
    assert.equal(result.success, false, `confirmed=${String(confirmed)} não é confirmação`);
    assert.ok(!result.success && result.errors.confirmed);
  }
  assert.equal(validateStandbyEntry({ reason: "x".repeat(501), confirmed: true }).success, false);
  assert.equal(validateStandbyEntry(null).success, false);
  assert.equal(validateStandbyEntry("texto").success, false);
});

test("reagendar aceita só a turma e um motivo opcional; desfazer, só o motivo", () => {
  const sessionId = "5b1a0000-0000-4000-8000-00000000aaaa";
  assert.deepEqual(validateStandbyReschedule({ targetSessionId: sessionId, reason: "" }), { success: true, data: { targetSessionId: sessionId, reason: "" } });
  // Quantidade e valor não são parâmetros: o que vier a mais é ignorado.
  const extra = validateStandbyReschedule({ targetSessionId: sessionId, quantity: 99, unitPriceCents: 1, totalCents: 1 });
  assert.deepEqual(extra, { success: true, data: { targetSessionId: sessionId, reason: "" } });
  assert.equal(validateStandbyReschedule({ targetSessionId: "não-é-uuid" }).success, false);
  assert.equal(validateStandbyReschedule({ targetSessionId: sessionId, reason: "x".repeat(501) }).success, false);
  assert.equal(validateStandbyReschedule(null).success, false);

  assert.deepEqual(validateStandbyUndo(null), { success: true, data: { reason: "" } });
  assert.deepEqual(validateStandbyUndo({ reason: " Engano " }), { success: true, data: { reason: "Engano" } });
  assert.equal(validateStandbyUndo({ reason: "x".repeat(501) }).success, false);
});

test("as telas pedem a confirmação que a rota exige", () => {
  const dialogs = source("components/admin/standby/standby-dialogs.tsx");
  assert.match(dialogs, /type="checkbox"/);
  assert.match(dialogs, /disabled=\{saving \|\| !confirmed\}/);
  assert.match(dialogs, /JSON\.stringify\(\{ reason: reason\.trim\(\), confirmed: true \}\)/);
  assert.match(dialogs, /deixam de ocupar vaga na turma original/);
  for (const label of ["Cliente", "Código da reserva", "Experiência", "Turma original", "Participantes", "Valor pago", "Motivo do Stand-by"]) {
    assert.ok(dialogs.includes(label), `o modal mostra "${label}"`);
  }
  // Presença registrada: o modal bloqueia antes de chamar a rota.
  assert.match(dialogs, /blocked \? null :/);
  assert.match(source("app/admin/reservas/[reservationId]/page.tsx"), /checkinBlocked: \(checkin\?\.checkedInCount \?\? 0\) > 0/);
  // Reagendar: duas etapas, e o corpo só leva a turma e o motivo.
  assert.match(dialogs, /JSON\.stringify\(\{ targetSessionId: selected\.sessionId, reason: reason\.trim\(\) \}\)/);
  assert.match(dialogs, /Revisar reagendamento/);
  assert.match(dialogs, /Confirmar reagendamento/);
});

// =============================================================================
// 5. Lista: filtros e paginação
// =============================================================================

test("filtros da lista: base conhecida, link WITH/WITHOUT e página positiva", () => {
  const bases = [{ slug: "lago-norte" }, { slug: "concha-acustica" }];
  assert.deepEqual(parseStandbyListFilters({}, bases), { query: "", base: "", link: "", page: 1 });
  assert.deepEqual(
    parseStandbyListFilters({ query: "  Marina ", base: "concha-acustica", link: "with", page: "3" }, bases),
    { query: "Marina", base: "concha-acustica", link: "WITH", page: 3 },
  );
  assert.deepEqual(parseStandbyListFilters({ base: "outra-base", link: "talvez", page: "-2" }, bases), { query: "", base: "", link: "", page: 1 });
  assert.equal(parseStandbyListFilters({ page: "abc" }, bases).page, 1);
  assert.equal(parseStandbyListFilters({ query: ["a", "b"] }, bases).query, "");
  assert.equal(parseStandbyListFilters({ query: "x".repeat(300) }, bases).query.length, 120);
});

test("paginação: a última página existe para qualquer total e os links preservam os filtros", () => {
  assert.equal(STANDBY_PAGE_SIZE, 25);
  assert.equal(standbyPageCount(0), 1);
  assert.equal(standbyPageCount(25), 1);
  assert.equal(standbyPageCount(26), 2);
  assert.equal(standbyPageCount(500), 20);
  assert.equal(standbyPageCount(501), 21, "a 501ª reserva tem página");
  assert.equal(standbyPageCount(1234), 50);

  assert.equal(standbyListHref({ query: "", base: "", link: "", page: 1 }, 1), "/admin/stand-by");
  assert.equal(standbyListHref({ query: "Ana Lima", base: "lago-norte", link: "WITHOUT", page: 1 }, 21), "/admin/stand-by?query=Ana+Lima&base=lago-norte&link=WITHOUT&page=21");

  const page = source("app/admin/stand-by/page.tsx");
  assert.match(page, /listStandbyReservations\(/);
  assert.doesNotMatch(page, /admin_list_standby_reservations\b|\.slice\(0, 500\)|limit 500/);
  assert.doesNotMatch(source("lib/admin/standby-data.ts"), /"admin_list_standby_reservations"/, "a função com teto de 500 não é usada pelo painel");
});

test("a página mostra os nove dados pedidos de cada reserva", () => {
  const page = source("app/admin/stand-by/page.tsx");
  for (const field of ["item.fullName", "item.publicCode", "item.originalStartsAt", "item.originalBaseName", "item.originalExperienceTitle", "item.quantity", "item.totalCents", "item.reason", "item.enteredAt"]) {
    assert.ok(page.includes(field), `a lista mostra ${field}`);
  }
  assert.doesNotMatch(page, /cpf/i);
});

// =============================================================================
// 6. Leitura das respostas do banco
// =============================================================================

test("respostas malformadas viram valores neutros em vez de derrubar a tela", () => {
  assert.deepEqual(parseStandbyListPage(null), { total: 0, totalParticipants: 0, totalCents: 0, limit: 0, offset: 0, items: [] });
  assert.equal(parseStandbyListPage({ total: "7", items: [null, "x", { standbyId: "a", hasActiveLink: "true" }] }).items.length, 1);
  assert.equal(parseStandbyListPage({ items: [{ hasActiveLink: "true" }] }).items[0].hasActiveLink, false);
  assert.equal(parseStandbyOptions(null), null);
  assert.equal(parseStandbyOptions({ options: [] }), null);
  assert.deepEqual(parseStandbyHistory(undefined), { cycles: [], events: [] });
  assert.equal(parseStandbyResolution({ standbyId: "a", resolution: "CANCELLED" }), null);
  assert.equal(parseStandbyResolution({ standbyId: "a", resolution: "RESCHEDULED", replayed: true })?.replayed, true);

  const options = parseStandbyOptions({
    standbyId: "s", quantity: 3, unitPriceCents: 7000, totalCents: 21000,
    restore: { allowed: true, remainingSpots: 4 },
    options: [{ sessionId: "t", startsAt: "2026-11-01T12:00:00Z", priceCents: 7000, isOriginal: true }],
  });
  assert.equal(options?.options[0].id, "t", "no formato de groupSessionsByDay");
  assert.equal(options?.options[0].isOriginal, true);
  assert.equal(options?.restore.allowed, true);

  const history = parseStandbyHistory({
    cycles: [{ standbyId: "s", open: true, resolution: "INVENTADA", resolvedByType: "ROBOT" }],
    events: [{ id: "e", action: "RESERVATION_STANDBY_SET", actorType: "CUSTOMER", access: "LINK" }],
  });
  assert.equal(history.cycles[0].resolution, null);
  assert.equal(history.cycles[0].resolvedByType, null);
  assert.equal(history.events[0].actorType, "CUSTOMER");
});

test("textos da auditoria", () => {
  assert.equal(standbyEventLabel("RESERVATION_STANDBY_SET"), "Colocada em Stand-by");
  assert.equal(standbyEventLabel("RESERVATION_STANDBY_RESTORED"), "Stand-by desfeito");
  assert.equal(standbyEventLabel("RESERVATION_STANDBY_RESCHEDULED"), "Reagendada");
  assert.equal(standbyEventLabel("RESERVATION_STANDBY_LINK_GENERATED"), "Link gerado");
  assert.equal(standbyEventLabel("RESERVATION_STANDBY_LINK_REVOKED"), "Link revogado");

  assert.equal(standbyActorLabel({ actorName: "Rudah", actorType: "ADMIN", access: "ADMIN" }), "Rudah");
  assert.equal(standbyActorLabel({ actorName: "", actorType: "ADMIN", access: null }), "Administrador removido");
  assert.equal(standbyActorLabel({ actorName: "", actorType: "CUSTOMER", access: "LINK" }), "Cliente, pelo link");
  assert.equal(standbyActorLabel({ actorName: "", actorType: "CUSTOMER", access: "CPF_CODE" }), "Cliente, com CPF e código");

  assert.equal(standbyResolutionLabel({ open: true, resolution: null }), "Aguardando reagendamento");
  assert.equal(standbyResolutionLabel({ open: false, resolution: "RESCHEDULED" }), "Reagendada");
  assert.equal(standbyResolutionLabel({ open: false, resolution: "RESTORED" }), "Stand-by desfeito");
  assert.equal(standbyResolutionLabel({ open: false, resolution: "CANCELLED" }), "Reserva cancelada");

  assert.equal(restoreRejectionMessage(null), "");
  assert.match(restoreRejectionMessage("INSUFFICIENT_SPOTS"), /vagas/);
  assert.match(restoreRejectionMessage("SESSION_MUST_BE_FUTURE"), /já começou/);
  assert.match(restoreRejectionMessage("SESSION_NOT_OPEN"), /não está aberta/);
  assert.ok(restoreRejectionMessage("QUALQUER_OUTRA"));
});

test("o detalhe da reserva exibe quem, por quê, quando e como saiu — sem token", () => {
  const page = source("app/admin/reservas/[reservationId]/page.tsx");
  for (const field of ["cycle.enteredByName", "cycle.reason", "cycle.enteredAt", "cycle.resolvedAt", "cycle.linkCreatedAt", "cycle.linkRevokedAt", "standbyEventLabel(event.action)", "standbyActorLabel(event)"]) {
    assert.ok(page.includes(field), `o detalhe mostra ${field}`);
  }
  assert.match(page, /getStandbyHistory\(context\.profile\.userId, reservation\.id\)\.catch\(\(\) => null\)/, "uma falha no histórico não esconde o detalhe");
  assert.doesNotMatch(page, /token_hash|linkToken|\.token\b/);
});

// =============================================================================
// 7. Mensagens de erro
// =============================================================================

test("cada recusa do banco vira uma mensagem própria do Stand-by", () => {
  const cases: Array<[string, number, RegExp]> = [
    ["RESERVATION_ALREADY_IN_STANDBY", 409, /já está em Stand-by/],
    ["RESERVATION_PAYMENT_NOT_CONFIRMED", 409, /pagamento confirmado/],
    ["RESERVATION_NOT_CONFIRMED", 409, /confirmada pode entrar em Stand-by/],
    ["STANDBY_CHECKIN_REGISTERED", 409, /presença registrada/],
    ["RESERVATION_NOT_IN_STANDBY", 409, /não está em Stand-by/],
    ["STANDBY_ALREADY_USED", 409, /já foi resolvido/],
    ["PRICE_NOT_ELIGIBLE", 409, /preço diferente/],
    ["BASE_NOT_AVAILABLE", 409, /não está em operação/],
    ["INSUFFICIENT_SPOTS", 409, /grupo inteiro/],
    ["SESSION_MUST_BE_FUTURE", 409, /já começou/],
    ["REASON_REQUIRED", 400, /motivo/],
    ["STANDBY_INVALID_FILTER", 400, /Filtro/],
    ["STANDBY_STILL_OPEN", 409, /Atualize a página/],
    ["SESSION_NOT_OPEN", 409, /não está aberta/],
    ["EXPERIENCE_NOT_AVAILABLE", 409, /não está publicada/],
    ["ADMIN_FORBIDDEN", 403, /não está ativo/],
  ];
  for (const [symbol, status, pattern] of cases) {
    const failure = standbyMutationError(new Error(symbol));
    assert.equal(failure.status, status, symbol);
    assert.match(failure.message, pattern, symbol);
  }
  // Migration do painel ainda não aplicada: mensagem que diz o que fazer.
  const missing = standbyMutationError(new Error("Could not find the function public.admin_standby_reschedule_options(p_actor_id, p_reservation_id) in the schema cache"));
  assert.equal(missing.status, 503);
  assert.match(missing.message, /migration/);
  assert.equal(standbyMutationError(new Error("falha qualquer")).status, 500);
});

test("o reagendamento tradicional continua com as mensagens de sempre", () => {
  assert.deepEqual(adminMutationError(new Error("RESERVATION_NOT_CONFIRMED")), { status: 409, message: "Só uma reserva confirmada pode trocar de turma." });
  assert.deepEqual(adminMutationError(new Error("INSUFFICIENT_SPOTS")), { status: 409, message: "Não há vagas para confirmar essa reserva sem overbooking." });
  assert.deepEqual(adminMutationError(new Error("SESSION_MUST_BE_FUTURE")), { status: 400, message: "A nova sessão precisa estar no futuro." });

  // A rota, a validação e o modal da troca direta não ganharam nenhuma regra.
  const route = source("app/api/admin/reservations/[reservationId]/change-session/route.ts");
  assert.match(route, /authorizeAdminApi\(\)/);
  assert.doesNotMatch(route, /Standby|standby|priceCents/);
  assert.doesNotMatch(source("components/admin/change-session-dialog.tsx"), /standby|Stand-by/i);
  assert.match(source("components/admin/reservation-actions.tsx"), /status === "CONFIRMED" \? \(\s*<Button type="button" size="sm" variant="outline" onClick=\{\(\) => setChangingSession\(true\)\}>/);
});

// =============================================================================
// 8. Google Sheets: a regra do modo "somente atualizar"
// =============================================================================

const SESSION_A = "5b1a0000-0000-4000-8000-00000000aaaa";
const SESSION_B = "5b1a0000-0000-4000-8000-00000000bbbb";
const RESERVATION_1 = "11110000-0000-4000-8000-000000000001";
const RESERVATION_2 = "11110000-0000-4000-8000-000000000002";

function origin(overrides: Partial<StandbyOriginRow> = {}): StandbyOriginRow {
  return { reservationId: RESERVATION_1, open: true, resolution: null, resolvedSessionId: null, ...overrides };
}

test("regra: reserva em Stand-by ou cancelada em Stand-by só atualiza; reagendada ou devolvida volta ao normal", () => {
  assert.equal(isStandbyOriginUpdateOnly("RESERVATION", RESERVATION_1, SESSION_A, []), false, "sem Stand-by, fluxo normal");
  assert.equal(isStandbyOriginUpdateOnly("RESERVATION", RESERVATION_1, SESSION_A, [origin()]), true, "em Stand-by");
  assert.equal(isStandbyOriginUpdateOnly("RESERVATION", RESERVATION_1, SESSION_A, [origin({ open: false, resolution: "CANCELLED" })]), true, "cancelada em Stand-by");
  assert.equal(isStandbyOriginUpdateOnly("RESERVATION", RESERVATION_1, SESSION_A, [origin({ open: false, resolution: "RESTORED", resolvedSessionId: SESSION_A })]), false, "devolvida à turma");
  assert.equal(isStandbyOriginUpdateOnly("RESERVATION", RESERVATION_1, SESSION_A, [origin({ open: false, resolution: "RESCHEDULED", resolvedSessionId: SESSION_A })]), false, "reagendada para a própria turma original");
  // O Stand-by de outra reserva da mesma turma não muda a sincronização desta.
  assert.equal(isStandbyOriginUpdateOnly("RESERVATION", RESERVATION_2, SESSION_A, [origin()]), false);
  // Vários ciclos: basta um aberto.
  assert.equal(isStandbyOriginUpdateOnly("RESERVATION", RESERVATION_1, SESSION_A, [
    origin({ open: false, resolution: "RESTORED", resolvedSessionId: SESSION_A }),
    origin(),
  ]), true);
});

test("regra: turma que foi origem de um Stand-by nunca é criada por reconstrução", () => {
  assert.equal(isStandbyOriginUpdateOnly("SESSION", SESSION_A, SESSION_A, []), false);
  assert.equal(isStandbyOriginUpdateOnly("SESSION", SESSION_A, SESSION_A, [origin()]), true, "Stand-by aberto");
  assert.equal(isStandbyOriginUpdateOnly("SESSION", SESSION_A, SESSION_A, [origin({ open: false, resolution: "CANCELLED" })]), true, "cancelada");
  assert.equal(isStandbyOriginUpdateOnly("SESSION", SESSION_A, SESSION_A, [origin({ open: false, resolution: "RESCHEDULED", resolvedSessionId: SESSION_B })]), true, "reagendada para outra turma");
  assert.equal(isStandbyOriginUpdateOnly("SESSION", SESSION_A, SESSION_A, [origin({ open: false, resolution: "RESTORED", resolvedSessionId: SESSION_A })]), false, "todos voltaram para ela");
});

test("regra: leitura das linhas do banco e erros que significam 'sem Stand-by neste banco'", () => {
  assert.deepEqual(parseStandbyOriginRows(null), []);
  assert.deepEqual(parseStandbyOriginRows([
    { reservation_id: RESERVATION_1, resolved_at: null, resolution: null, resolved_session_id: null },
    { reservation_id: RESERVATION_2, resolved_at: "2026-10-14T12:00:00Z", resolution: "RESCHEDULED", resolved_session_id: SESSION_B },
    "lixo",
  ]), [
    { reservationId: RESERVATION_1, open: true, resolution: null, resolvedSessionId: null },
    { reservationId: RESERVATION_2, open: false, resolution: "RESCHEDULED", resolvedSessionId: SESSION_B },
  ]);
  assert.equal(isStandbyTableMissing("PGRST205"), true);
  assert.equal(isStandbyTableMissing("42P01"), true);
  for (const code of ["PGRST301", "57014", "", undefined, null]) assert.equal(isStandbyTableMissing(code), false);
});

const SHEET_SESSION: SessionSnapshot = {
  id: SESSION_A,
  experienceTitle: "Imersão Paranoá",
  startsAt: "2026-08-02T12:00:00.000Z",
  durationMinutes: 90,
  capacity: 28,
  confirmedSpots: 5,
  remainingSpots: 23,
  status: "CLOSED",
};

function sheetReservation(overrides: Partial<ReservationSnapshot> = {}): ReservationSnapshot {
  return {
    id: RESERVATION_1,
    sessionId: SESSION_A,
    publicCode: "AZ7K2M9QX1",
    fullName: "João Silva",
    phone: "+55 61 99999-8888",
    quantity: 2,
    totalCents: 14000,
    status: "AWAITING_RESCHEDULE",
    paymentStatus: "PAID",
    paymentMethod: "pix",
    createdAt: "2026-07-20T14:00:00.000Z",
    confirmedAt: "2026-07-20T14:05:00.000Z",
    cancelledAt: null,
    ...overrides,
  };
}

test("motor: em modo 'somente atualizar', turma ausente não gera nenhuma escrita nem chamada de estrutura", async () => {
  const sheets = createFakeSheets();
  let writes = 0;
  const counting = { ...sheets, batchUpdate: async (updates: Parameters<typeof sheets.batchUpdate>[0]) => { writes += 1; return sheets.batchUpdate(updates); } };

  const report = await syncSnapshot(counting, { session: SHEET_SESSION, reservations: [sheetReservation()] }, { syncedAt: "2026-10-14T12:00:00.000Z", updateOnly: true });
  assert.deepEqual(report, { sessionId: SESSION_A, reservations: 1, rowsUpdated: 0, rowsAppended: 0, spotsDeactivated: 0, skipped: true });
  assert.equal(writes, 0);
  assert.equal(sheets.ensureRowsCalls(), 0);
  for (const tab of [SESSIONS_TAB, RESERVATIONS_TAB, SPOTS_TAB]) assert.equal(sheets.dataRows(tab).length, 0, tab);

  // Reconstrução da sessão inteira, com todas as reservas dela: idem.
  const rebuild = await syncSnapshot(counting, {
    session: SHEET_SESSION,
    reservations: [sheetReservation(), sheetReservation({ id: RESERVATION_2, status: "CONFIRMED", publicCode: "BZ00000002" })],
  }, { syncedAt: "2026-10-14T12:00:00.000Z", reconcileSession: true, updateOnly: true });
  assert.equal(rebuild.skipped, true);
  assert.equal(writes, 0);
});

test("motor: sem o modo, a mesma sincronização criaria a turma — é o que a proteção impede", async () => {
  const sheets = createFakeSheets();
  const report = await syncSnapshot(sheets, { session: SHEET_SESSION, reservations: [sheetReservation()] }, { syncedAt: "2026-10-14T12:00:00.000Z" });
  assert.equal(report.skipped, false);
  assert.equal(sheets.dataRows(SESSIONS_TAB).length, 1);
  assert.equal(sheets.dataRows(RESERVATIONS_TAB).length, 1);
});

test("motor: em modo 'somente atualizar', turma presente é atualizada normalmente e de forma idempotente", async () => {
  const sheets = createFakeSheets();
  const at = "2026-10-14T12:00:00.000Z";
  await syncSnapshot(sheets, { session: SHEET_SESSION, reservations: [sheetReservation({ status: "CONFIRMED" })] }, { syncedAt: at });
  const rowsBefore = [SESSIONS_TAB, RESERVATIONS_TAB, SPOTS_TAB].map((tab) => sheets.dataRows(tab).length);

  const report = await syncSnapshot(sheets, { session: SHEET_SESSION, reservations: [sheetReservation()] }, { syncedAt: at, updateOnly: true });
  assert.equal(report.skipped, false);
  assert.equal(report.rowsAppended, 0);
  assert.ok(report.rowsUpdated > 0);
  assert.deepEqual([SESSIONS_TAB, RESERVATIONS_TAB, SPOTS_TAB].map((tab) => sheets.dataRows(tab).length), rowsBefore);
  assert.ok(sheets.dataRows(RESERVATIONS_TAB)[0].includes("Aguardando reagendamento"));

  const frozen = JSON.stringify([SESSIONS_TAB, RESERVATIONS_TAB, SPOTS_TAB].map((tab) => sheets.grid(tab)));
  await syncSnapshot(sheets, { session: SHEET_SESSION, reservations: [sheetReservation()] }, { syncedAt: at, updateOnly: true });
  assert.equal(JSON.stringify([SESSIONS_TAB, RESERVATIONS_TAB, SPOTS_TAB].map((tab) => sheets.grid(tab))), frozen);
});

test("serviço: o modo é decidido a cada execução, lendo o banco — vale para job pendente retomado", () => {
  const service = source("lib/integrations/google-sheets/service.ts");
  const runJob = service.slice(service.indexOf("async function runJob"), service.indexOf("async function drainPendingJobs"));

  // A decisão acontece dentro de `runJob`, que é o caminho comum do envio
  // imediato e da fila — nenhum chamador a informa.
  assert.match(runJob, /const updateOnly = await standbyUpdateOnly\(admin, job\.entityType, job\.entityId, snapshot\.session\.id\);/);
  assert.match(runJob, /updateOnly,\s*\}\);/);
  assert.ok(runJob.indexOf("standbyUpdateOnly(") < runJob.indexOf("syncSnapshot("), "decide antes de escrever");
  assert.doesNotMatch(service, /export async function syncSheetEntity\([^)]*updateOnly/);

  // A mesma consulta que o teste de banco reproduz.
  assert.match(service, /\.from\("reservation_standby"\)\s*\.select\("reservation_id, resolved_at, resolution, resolved_session_id"\)\s*\.eq\("original_session_id", sessionId\)/);

  // Falha na consulta interrompe: job pendente, nada escrito.
  assert.match(service, /if \(isStandbyTableMissing\(result\.error\.code\)\) return false;\s*throw new Error\("STANDBY_LOOKUP_UNAVAILABLE"\);/);
  assert.equal(sanitizeErrorCode(new Error("STANDBY_LOOKUP_UNAVAILABLE")), "STANDBY_LOOKUP_UNAVAILABLE");

  // Turma fora da planilha: job encerrado, resultado próprio, sem nova tentativa.
  assert.match(runJob, /if \(report\.skipped\) \{[\s\S]*?errorCode: "SESSION_NOT_IN_SHEET"[\s\S]*?return \{ synced: true, skipped: true \};/);
  assert.match(service, /if \(result\.skipped\) return \{ outcome: "SKIPPED" \};/);
});

test("todos os caminhos que sincronizam a turma de origem passam pelo mesmo serviço", () => {
  // Stand-by, desfazer e reagendamento.
  const data = source("lib/admin/standby-data.ts");
  assert.equal([...data.matchAll(/syncReservationAfterChange\(reservationId, "STANDBY"\)/g)].length, 2);
  assert.match(data, /syncReservationSessionChange\(reservationId, resolution\.previousSessionId\)/);
  assert.doesNotMatch(data, /createSheetsClient|syncSnapshot\(|batchUpdate/);

  // Cancelamento (inclusive de reserva em Stand-by) e os dois botões manuais.
  assert.match(source("lib/admin/data.ts"), /if \(cancelled\) await syncReservationAfterChange\(reservationId, "CANCELLED"\);/);
  const reservationButton = source("app/api/admin/reservations/[reservationId]/sync-sheet/route.ts");
  const sessionButton = source("app/api/admin/sessions/[sessionId]/sync-sheet/route.ts");
  assert.match(reservationButton, /syncReservationAfterChange\(reservationId, "ADMIN"\)/);
  assert.match(sessionButton, /syncSessionList\(sessionId\)/);
  for (const button of [reservationButton, sessionButton]) {
    assert.match(button, /result\.outcome === "SKIPPED"/);
    assert.match(button, /Nada foi criado nem alterado/);
  }

  // Não existe outro lugar que escreva na planilha.
  const writers = [...files("app"), ...files("lib"), ...files("components")]
    .filter((path) => /\.tsx?$/.test(path) && !path.startsWith("lib/integrations/google-sheets/"))
    .filter((path) => /createSheetsClient|syncSnapshot\(/.test(source(path)));
  assert.deepEqual(writers, []);
});

test("a estrutura da planilha não mudou", () => {
  const schema = source("lib/integrations/google-sheets/schema.ts");
  const mapping = source("lib/integrations/google-sheets/mapping.ts");
  assert.doesNotMatch(schema, /stand-?by/i);
  assert.match(mapping, /AWAITING_RESCHEDULE: "Aguardando reagendamento"/);
  assert.match(mapping, /return reservation\.status === "CONFIRMED";/, "só confirmada ocupa vaga ativa");
});
