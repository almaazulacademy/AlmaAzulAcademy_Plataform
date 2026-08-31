import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  evaluateOption,
  evaluateSessionChange,
  parseReservationSessionOptions,
  parseSessionChangeResult,
  sessionChangeMessage,
  type ReservationSessionOptions,
  type SessionChangeOption,
  type SessionChangeReservation,
  type SessionChangeTarget,
} from "../lib/admin/session-change.ts";
import { validateReservationSessionChange } from "../lib/admin/validation.ts";
import { adminMutationError } from "../lib/admin/mutation-errors.ts";
import { formatSessionDateShort, formatSessionTime } from "../lib/sessions/date-time.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const sql = source("supabase/migrations/202608240001_admin_change_reservation_session.sql");

/**
 * A migration 202608310001 redefine, com `create or replace`, as três funções
 * criadas aqui. É ela que o banco executa depois de aplicada, então é dela que
 * este arquivo lê os corpos das funções: as garantias abaixo — pagamento
 * intocado, `public_code` preservado, capacidade travada, só admin executa —
 * são exatamente as que precisam sobreviver à evolução, e testá-las contra o
 * corpo antigo provaria apenas que o texto antigo continua no disco.
 *
 * O que continua sendo lido do arquivo original é o que só ele cria: a tabela
 * de histórico e as propriedades da própria migration.
 */
const evolvedSql = source("supabase/migrations/202608310001_admin_cross_experience_rescheduling.sql");

/** Só o SQL executável: os comentários explicam o contrato, não o cumprem. */
function statements(text: string) {
  return text.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
}

function sectionOf(text: string, from: string, to?: string) {
  const start = text.indexOf(from);
  assert.notEqual(start, -1, `seção ausente: ${from}`);
  const end = to ? text.indexOf(to) : text.length;
  assert.notEqual(end, -1, `seção ausente: ${to}`);
  return statements(text.slice(start, end));
}

function section(from: string, to?: string) {
  return sectionOf(sql, from, to);
}

const CHANGE_FUNCTION = sectionOf(evolvedSql, "-- 3. A operação transacional", "-- 4. Turmas de destino");
const OPTIONS_FUNCTION = sectionOf(evolvedSql, "-- 4. Turmas de destino", "-- 5. Histórico exibido");
const HISTORY_FUNCTION = sectionOf(evolvedSql, "-- 5. Histórico exibido", "-- 6. Grants");
const HISTORY_TABLE = section("-- 1. Histórico tipado", "-- 2. A operação transacional");
const GRANTS = sectionOf(evolvedSql, "-- 6. Grants");

// --- Cenário: as três turmas da Imersão Paranoá -----------------------------
//
// Mesmo dia, três horários, mais um sábado seguinte. É o caso que motivou a
// funcionalidade, então é o caso que os testes descrevem.

const NOW = new Date("2026-08-20T12:00:00.000Z");
const EXPERIENCE = "aaaa0000-0000-4000-8000-00000000aaaa";

const SESSION_0900 = "11110000-0000-4000-8000-000000000001";
const SESSION_1200 = "22220000-0000-4000-8000-000000000002";
const SESSION_1500 = "33330000-0000-4000-8000-000000000003";
const SESSION_NEXT_WEEK = "44440000-0000-4000-8000-000000000004";

function target(overrides: Partial<SessionChangeTarget> = {}): SessionChangeTarget {
  return {
    sessionId: SESSION_1200,
    experienceId: EXPERIENCE,
    experienceStatus: "PUBLISHED",
    // 12:00 em Brasília no dia 29/08/2026.
    startsAt: "2026-08-29T15:00:00.000Z",
    status: "OPEN",
    capacity: 28,
    remainingSpots: 10,
    ...overrides,
  };
}

function reservation(overrides: Partial<SessionChangeReservation> = {}): SessionChangeReservation {
  return {
    status: "CONFIRMED",
    quantity: 3,
    sessionId: SESSION_0900,
    experienceId: EXPERIENCE,
    ...overrides,
  };
}

function denialOf(verdict: ReturnType<typeof evaluateSessionChange>) {
  assert.equal(verdict.allowed, false, "a mudança deveria ter sido recusada");
  return verdict.allowed === false ? verdict.reason : "";
}

// --- 1: mover de 09:00 para 12:00 -------------------------------------------

test("1. o admin move uma reserva confirmada das 09:00 para as 12:00", () => {
  const verdict = evaluateSessionChange(reservation(), target(), NOW);
  assert.equal(verdict.allowed, true);

  // O rótulo operacional é o mesmo do pedido: data · horário.
  assert.equal(
    `${formatSessionDateShort(target().startsAt)} · ${formatSessionTime(target().startsAt)}`,
    "29/08/2026 · 12:00",
  );
});

test("1b. as três turmas do mesmo dia são destinos distintos e distinguíveis", () => {
  const turmas = [
    { id: SESSION_0900, startsAt: "2026-08-29T12:00:00.000Z" },
    { id: SESSION_1200, startsAt: "2026-08-29T15:00:00.000Z" },
    { id: SESSION_1500, startsAt: "2026-08-29T18:00:00.000Z" },
  ];
  assert.deepEqual(turmas.map((turma) => formatSessionTime(turma.startsAt)), ["09:00", "12:00", "15:00"]);
  assert.equal(new Set(turmas.map((turma) => turma.id)).size, 3);
});

// --- 2: mover para outro dia ------------------------------------------------

test("2. o admin move a reserva para outro dia", () => {
  const verdict = evaluateSessionChange(
    reservation(),
    target({ sessionId: SESSION_NEXT_WEEK, startsAt: "2026-09-05T12:00:00.000Z" }),
    NOW,
  );
  assert.equal(verdict.allowed, true);
});

// --- 3 e 4: a reserva vai inteira ou não vai --------------------------------

test("3. uma reserva de 3 pessoas só cabe em turma com pelo menos 3 vagas", () => {
  for (const remainingSpots of [3, 4, 28]) {
    assert.equal(evaluateSessionChange(reservation({ quantity: 3 }), target({ remainingSpots }), NOW).allowed, true);
  }
});

test("4. turma com vagas insuficientes é bloqueada — não existe mover parte do grupo", () => {
  for (const remainingSpots of [0, 1, 2]) {
    const verdict = evaluateSessionChange(reservation({ quantity: 3 }), target({ remainingSpots }), NOW);
    assert.equal(denialOf(verdict), "INSUFFICIENT_SPOTS", `${remainingSpots} vagas não bastam para 3 pessoas`);
  }
});

test("4b. a reserva nunca ultrapassa a capacidade da turma de destino", () => {
  // Capacidade menor que a reserva é recusada mesmo que as vagas "restantes"
  // cheguem inconsistentes da tela.
  const verdict = evaluateSessionChange(
    reservation({ quantity: 5 }),
    target({ capacity: 4, remainingSpots: 9 }),
    NOW,
  );
  assert.equal(denialOf(verdict), "INSUFFICIENT_SPOTS");
});

// --- 5, 6 e 7: turma passada, fechada e a própria turma ---------------------

test("5. turma que já aconteceu é bloqueada", () => {
  const verdict = evaluateSessionChange(reservation(), target({ startsAt: "2026-08-01T12:00:00.000Z" }), NOW);
  assert.equal(denialOf(verdict), "SESSION_MUST_BE_FUTURE");
});

test("6. turma fechada, cancelada ou arquivada não recebe reserva", () => {
  for (const status of ["CLOSED", "CANCELLED", "ARCHIVED"] as const) {
    const verdict = evaluateSessionChange(reservation(), target({ status }), NOW);
    assert.equal(denialOf(verdict), "SESSION_NOT_OPEN", `status ${status} não pode receber`);
  }
});

test("7. a própria turma da reserva não pode ser escolhida como destino", () => {
  const verdict = evaluateSessionChange(reservation(), target({ sessionId: SESSION_0900 }), NOW);
  assert.equal(denialOf(verdict), "SAME_SESSION");
});

test("7b. o destino de outra experiência publicada é aceito; o de uma não publicada, não", () => {
  const outra = "bbbb0000-0000-4000-8000-00000000bbbb";

  assert.equal(
    evaluateSessionChange(reservation(), target({ experienceId: outra, experienceStatus: "PUBLISHED" }), NOW).allowed,
    true,
    "reagendar para outra experiência publicada é o comportamento novo",
  );

  for (const status of ["DRAFT", "ARCHIVED"] as const) {
    const verdict = evaluateSessionChange(reservation(), target({ experienceId: outra, experienceStatus: status }), NOW);
    assert.equal(denialOf(verdict), "EXPERIENCE_NOT_AVAILABLE", `experiência ${status} não recebe de fora`);
  }

  // A própria experiência da reserva continua aceita mesmo despublicada: quem
  // já comprou precisa poder trocar de horário dentro dela.
  assert.equal(
    evaluateSessionChange(reservation(), target({ experienceStatus: "ARCHIVED" }), NOW).allowed,
    true,
  );
});

// --- 8: só reserva confirmada muda de turma ---------------------------------

test("8. reserva que não está CONFIRMED não muda de turma", () => {
  for (const status of ["PRE_RESERVED", "EXPIRED", "CANCELLED"] as const) {
    const verdict = evaluateSessionChange(reservation({ status }), target(), NOW);
    assert.equal(denialOf(verdict), "RESERVATION_NOT_CONFIRMED", `status ${status} não pode mover`);
  }
});

test("8b. o SQL guarda o status e nunca o reescreve na reserva movida", () => {
  assert.match(CHANGE_FUNCTION, /if target\.status <> 'CONFIRMED' then\s+raise exception 'RESERVATION_NOT_CONFIRMED'/);

  // A única escrita na reserva-alvo é o vínculo — session_id e experience_id,
  // juntos. Status, confirmed_at e cancelled_at não aparecem em nenhum `set`
  // dirigido a ela.
  assert.match(
    CHANGE_FUNCTION,
    /update public\.reservations\s+set session_id = destination_session\.id,\s+experience_id = destination_session\.experience_id,\s+updated_at = now\(\)\s+where id = target\.id/,
  );
  assert.doesNotMatch(CHANGE_FUNCTION, /set status = 'CONFIRMED'/);
  assert.doesNotMatch(CHANGE_FUNCTION, /confirmed_at = /);
  assert.doesNotMatch(CHANGE_FUNCTION, /cancelled_at = /);
});

// --- 9 e 10: pagamento, valor e código preservados --------------------------

test("9. nenhuma cobrança, estorno ou evento de pagamento é criado", () => {
  assert.doesNotMatch(CHANGE_FUNCTION, /payment_events/);
  assert.doesNotMatch(CHANGE_FUNCTION, /payment_provider = /);
  assert.doesNotMatch(CHANGE_FUNCTION, /provider_reference = /);
  assert.doesNotMatch(CHANGE_FUNCTION, /checkout_url = /);
});

test("9b. o valor pago não é recalculado a partir do preço da nova turma", () => {
  // unit_price_cents é coluna da reserva e total_cents é gerada a partir dela.
  // Nenhuma das duas é escrita, então o valor pago sobrevive à diferença de
  // preço entre as turmas — que é apenas registrada no histórico.
  assert.doesNotMatch(CHANGE_FUNCTION, /unit_price_cents = /);
  assert.doesNotMatch(CHANGE_FUNCTION, /total_cents = /);
  assert.match(CHANGE_FUNCTION, /previous_session_price_cents/);
  assert.match(CHANGE_FUNCTION, /target_session_price_cents/);
});

test("10. public_code, cliente e CPF permanecem intocados", () => {
  for (const field of ["public_code = ", "full_name = ", "cpf_hash = ", "cpf_last4 = ", "email = ", "phone = ", "quantity = "]) {
    assert.doesNotMatch(CHANGE_FUNCTION, new RegExp(field), `${field.trim()} não pode ser reescrito`);
  }
  // Nenhuma reserva nova nasce daqui.
  assert.doesNotMatch(CHANGE_FUNCTION, /insert into public\.reservations/);
  assert.doesNotMatch(CHANGE_FUNCTION, /delete from public\.reservations/);
});

// --- 11 e 12: vagas liberadas e ocupadas ------------------------------------

test("11 e 12. mover o session_id é o que libera a turma antiga e ocupa a nova", () => {
  // `available_spots` soma as reservas *daquela* sessão. Como a linha inteira
  // muda de session_id, a turma antiga deixa de contar a reserva e a nova passa
  // a contá-la — sem nenhum contador paralelo para dessincronizar.
  const availability = statements(source("supabase/migrations/202608010001_reservation_platform.sql"));
  assert.match(availability, /left join public\.reservations r on r\.session_id = s\.id/);
  assert.match(availability, /r\.status = 'CONFIRMED'/);

  assert.doesNotMatch(CHANGE_FUNCTION, /spots_available/, "nenhum snapshot legado é atualizado à mão");
  assert.doesNotMatch(CHANGE_FUNCTION, /update public\.sessions/, "capacidade de sessão não é tocada");
});

test("12b. a ocupação do destino é recontada das linhas reais, com a reserva inteira", () => {
  assert.match(
    CHANGE_FUNCTION,
    /select coalesce\(sum\(quantity\), 0\)::integer into occupied\s+from public\.reservations\s+where session_id = destination_session\.id/,
  );
  assert.match(CHANGE_FUNCTION, /\(status = 'CONFIRMED' or \(status = 'PRE_RESERVED' and expires_at > now\(\)\)\)/);
  assert.match(CHANGE_FUNCTION, /if occupied \+ target\.quantity > destination_session\.capacity then\s+raise exception 'INSUFFICIENT_SPOTS'/);
});

test("12c. retenções vencidas do destino são liberadas antes da contagem, só naquela turma", () => {
  assert.match(
    CHANGE_FUNCTION,
    /update public\.reservations\s+set status = 'EXPIRED', updated_at = now\(\)\s+where session_id = destination_session\.id\s+and status = 'PRE_RESERVED'\s+and expires_at <= now\(\)/,
  );
});

// --- 13: histórico ----------------------------------------------------------

test("13. cada mudança grava um histórico tipado com tudo que a operação precisa", () => {
  for (const column of [
    "reservation_id",
    "previous_session_id",
    "target_session_id",
    "actor_user_id",
    "quantity",
    "unit_price_cents",
    "total_cents",
    "previous_session_price_cents",
    "target_session_price_cents",
    "reason",
    "created_at",
  ]) {
    assert.match(HISTORY_TABLE, new RegExp(`\\b${column}\\b`), `histórico sem ${column}`);
  }

  // O histórico não some junto com uma sessão ou reserva excluída.
  assert.match(HISTORY_TABLE, /references public\.reservations\(id\) on delete restrict/);
  assert.match(HISTORY_TABLE, /references public\.sessions\(id\) on delete restrict/);
  // Um histórico de "mudou para a mesma turma" não é histórico.
  assert.match(HISTORY_TABLE, /check \(previous_session_id <> target_session_id\)/);

  assert.match(CHANGE_FUNCTION, /insert into public\.reservation_session_changes/);
  // A trilha administrativa única continua recebendo a ação.
  assert.match(CHANGE_FUNCTION, /insert into public\.admin_audit_log[\s\S]*'RESERVATION_SESSION_CHANGED',\s+'RESERVATION',/);
});

test("13b. o motivo é opcional, limitado e nunca sai do painel", () => {
  const optional = validateReservationSessionChange({ targetSessionId: SESSION_1200 });
  assert.equal(optional.success, true);
  assert.equal(optional.success && optional.data.reason, "");

  const given = validateReservationSessionChange({
    targetSessionId: SESSION_1200,
    reason: "Cliente  solicitou   mudança de horário",
  });
  assert.equal(given.success && given.data.reason, "Cliente solicitou mudança de horário");

  const tooLong = validateReservationSessionChange({ targetSessionId: SESSION_1200, reason: "x".repeat(501) });
  assert.equal(tooLong.success, false);

  assert.match(HISTORY_TABLE, /check \(reason is null or char_length\(reason\) <= 500\)/);
  // A RPC pública de acompanhamento não conhece este histórico.
  const publicLookup = statements(source("supabase/migrations/202608010001_reservation_platform.sql"));
  assert.doesNotMatch(publicLookup, /reservation_session_changes/);
});

test("13c. destino inválido é recusado antes de qualquer chamada ao banco", () => {
  assert.equal(validateReservationSessionChange({ targetSessionId: "" }).success, false);
  assert.equal(validateReservationSessionChange({ targetSessionId: "nao-e-uuid" }).success, false);
  assert.equal(validateReservationSessionChange(null).success, false);
});

// --- 14: autorização --------------------------------------------------------

test("14. usuário sem permissão administrativa ativa não executa nada", () => {
  for (const body of [CHANGE_FUNCTION, OPTIONS_FUNCTION, HISTORY_FUNCTION]) {
    assert.match(body, /if not public\.is_active_admin\(p_actor_id\) then\s+raise exception 'ADMIN_FORBIDDEN' using errcode = '42501'/);
  }

  // A guarda vem antes de qualquer leitura ou escrita.
  const guard = CHANGE_FUNCTION.indexOf("is_active_admin");
  const firstWrite = CHANGE_FUNCTION.indexOf("update public.reservations");
  const firstRead = CHANGE_FUNCTION.indexOf("select * into target");
  assert.ok(guard !== -1 && guard < firstRead && guard < firstWrite);

  for (const name of [
    "admin_change_reservation_session\\(uuid, uuid, uuid, text\\)",
    "admin_reservation_session_options\\(uuid, uuid\\)",
    "admin_list_reservation_session_changes\\(uuid, uuid\\)",
  ]) {
    assert.match(GRANTS, new RegExp(`revoke all on function public\\.${name} from public, anon, authenticated`));
    assert.match(GRANTS, new RegExp(`grant execute on function public\\.${name} to service_role`));
  }

  // A RLS e a revogação da tabela de histórico nascem na migration original e
  // continuam valendo: a migration nova só adiciona colunas a ela.
  const originalGrants = section("-- 5. Grants");
  assert.match(originalGrants, /alter table public\.reservation_session_changes enable row level security/);
  assert.match(originalGrants, /revoke all on public\.reservation_session_changes from anon, authenticated/);
});

test("14b. o ator vem da sessão validada no servidor, nunca do payload", () => {
  const route = source("app/api/admin/reservations/[reservationId]/change-session/route.ts");
  assert.match(route, /authorization\.context\.profile\.userId/);
  assert.match(route, /isSameOriginRequest\(request\)/);
  // O corpo da requisição só carrega destino e motivo.
  assert.doesNotMatch(route, /actorId|p_actor_id/);
});

// --- 15: concorrência -------------------------------------------------------

test("15. duas trocas simultâneas não ocupam as mesmas últimas vagas", () => {
  // A reserva é travada antes de tudo.
  assert.match(CHANGE_FUNCTION, /select \* into target from public\.reservations where id = p_reservation_id for update;/);

  // As duas sessões são travadas — e sempre na mesma ordem de id, para que
  // mover A de S1 para S2 enquanto alguém move B de S2 para S1 não trave as
  // duas transações uma esperando a outra.
  assert.match(CHANGE_FUNCTION, /if target\.session_id < p_target_session_id then/);
  const locks = CHANGE_FUNCTION.match(/from public\.sessions where id = [\w.]+ for update/g) ?? [];
  assert.equal(locks.length, 4, "as duas sessões são travadas nos dois ramos da ordenação");

  // A contagem de ocupação acontece depois do lock, não antes.
  assert.ok(
    CHANGE_FUNCTION.indexOf("for update") < CHANGE_FUNCTION.indexOf("into occupied"),
    "a ocupação precisa ser recalculada com as sessões já travadas",
  );

  // E a decisão final é do banco: a lista da tela não autoriza nada.
  assert.ok(CHANGE_FUNCTION.indexOf("into occupied") < CHANGE_FUNCTION.indexOf("set session_id = destination_session.id"));
});

test("15b. nada sobrevive parcialmente: toda recusa é exceção, não retorno", () => {
  for (const failure of [
    "RESERVATION_NOT_CONFIRMED",
    "SAME_SESSION",
    "SESSION_NOT_FOUND",
    "EXPERIENCE_NOT_AVAILABLE",
    "SESSION_NOT_OPEN",
    "SESSION_MUST_BE_FUTURE",
    "INSUFFICIENT_SPOTS",
    "RESERVATION_EXPERIENCE_DESYNC",
  ]) {
    assert.match(CHANGE_FUNCTION, new RegExp(`raise exception '${failure}'`), `${failure} precisa abortar a transação`);
  }
  assert.doesNotMatch(CHANGE_FUNCTION, /exception when others/, "nenhum erro é engolido dentro da transação");
});

test("15c. cada recusa do banco vira uma resposta HTTP correta no painel", () => {
  const cases: Array<[string, number]> = [
    ["RESERVATION_NOT_CONFIRMED", 409],
    ["EXPERIENCE_NOT_AVAILABLE", 409],
    ["EXPERIENCE_NOT_FOUND", 404],
    ["RESERVATION_EXPERIENCE_DESYNC", 409],
    // Recusa do banco ainda sem a migration nova aplicada: continua mapeada
    // para o operador não ler um erro genérico durante a janela de deploy.
    ["SESSION_EXPERIENCE_MISMATCH", 409],
    ["SESSION_NOT_OPEN", 409],
    ["SESSION_NOT_FOUND", 404],
    ["SAME_SESSION", 409],
    ["SESSION_MUST_BE_FUTURE", 400],
    ["INSUFFICIENT_SPOTS", 409],
    ["ADMIN_FORBIDDEN", 403],
  ];
  for (const [code, status] of cases) {
    const failure = adminMutationError(new Error(code));
    assert.equal(failure.status, status, `${code} deveria responder ${status}`);
    assert.notEqual(failure.message, "Não foi possível concluir a operação.", `${code} precisa de mensagem própria`);
  }
});

// --- 16: falha da planilha não desfaz a mudança -----------------------------

test("16. a mudança é gravada no Supabase antes de a planilha ser tocada", () => {
  const data = source("lib/admin/data.ts");
  const body = data.slice(
    data.indexOf("export async function changeAdminReservationSession"),
    data.indexOf("export async function listAdminReservationSessionChanges"),
  );

  const rpcCall = body.indexOf('rpc("admin_change_reservation_session"');
  const sheetCall = body.indexOf("syncReservationSessionChange");
  assert.ok(rpcCall !== -1 && sheetCall !== -1);
  assert.ok(rpcCall < sheetCall, "a planilha só é tocada depois de o banco decidir");

  // O resultado devolvido é o da RPC, não o da planilha: nenhuma falha do
  // Google altera o que o painel informa sobre a mudança.
  assert.match(body, /return change;/);
  assert.doesNotMatch(body, /if \(!?sheet/i);
});

test("16b. a sincronização nunca lança para quem a chamou", () => {
  const service = source("lib/integrations/google-sheets/service.ts");
  const helper = service.slice(
    service.indexOf("export async function syncReservationSessionChange"),
    service.indexOf("/** Estado exibido no detalhe da reserva"),
  );
  // As duas chamadas usadas aqui já embrulham tudo em try/catch e devolvem
  // PENDING em vez de propagar.
  assert.match(helper, /syncReservationAfterChange\(reservationId, "SESSION_CHANGED"\)/);
  assert.match(helper, /syncSessionList\(previousSessionId\)/);

  for (const name of ["syncReservationAfterChange", "syncSessionList"]) {
    const fn = service.slice(service.indexOf(`export async function ${name}`));
    assert.match(fn.slice(0, 400), /try \{[\s\S]*\} catch \{[\s\S]*outcome: "PENDING"/);
  }
});

test("16c. nenhuma mensagem automática é disparada ao cliente", () => {
  const data = source("lib/admin/data.ts");
  const body = data.slice(
    data.indexOf("export async function changeAdminReservationSession"),
    data.indexOf("export async function listAdminReservationSessionChanges"),
  );
  assert.doesNotMatch(body, /sendReservationConfirmationEmail|whatsapp|createCheckout/i);
});

// --- 18: consultas futuras mostram a nova data ------------------------------

test("18. toda consulta de reserva lê data e horário pela session_id da própria reserva", () => {
  const platform = statements(source("supabase/migrations/202608010001_reservation_platform.sql"));
  const adminSql = statements(source("supabase/migrations/202608010002_admin_dashboard_mvp.sql"));
  const emailSql = statements(source("supabase/migrations/202608190001_reservation_confirmation_email.sql"));
  const sheetsSql = statements(source("supabase/migrations/202608180001_google_sheets_sync.sql"));

  // Nenhuma delas guarda a data na reserva: todas resolvem a sessão a partir do
  // `session_id` da própria reserva, então mudar o vínculo já muda o que o
  // cliente e a operação enxergam, sem nenhuma outra escrita.
  //
  //   lookup_reservation        → acompanhar reserva por CPF + código
  //   admin_get_reservation     → detalhe da reserva no painel
  //   reservation_confirmation_email → conteúdo de um reenvio de e-mail
  for (const [name, body] of Object.entries({ platform, adminSql, emailSql })) {
    assert.match(body, /join public\.sessions s on s\.id = r\.session_id/, `${name} não lê a sessão pela reserva`);
  }

  // A planilha chega pelo mesmo caminho, por um salto a mais: o bloco da
  // reserva expõe `sessionId` e o snapshot busca a sessão por ele.
  assert.match(sheetsSql, /'sessionId', r\.session_id/);
  assert.match(sheetsSql, /public\.google_sheets_session_block\(\(reservation ->> 'sessionId'\)::uuid\)/);
  assert.doesNotMatch(statements(sql), /alter table public\.reservations add column .*starts_at/);
});

// --- Contrato de leitura das turmas de destino ------------------------------

test("a lista de destinos é recortada pelo banco, com o `fits` calculado lá", () => {
  assert.doesNotMatch(
    OPTIONS_FUNCTION,
    /s\.experience_id = target\.experience_id/,
    "a agenda inteira é elegível, não só a experiência da reserva",
  );
  assert.match(OPTIONS_FUNCTION, /e\.status = 'PUBLISHED' or e\.id = target\.experience_id/);
  assert.match(OPTIONS_FUNCTION, /s\.id <> target\.session_id/);
  assert.match(OPTIONS_FUNCTION, /s\.status = 'OPEN'/);
  assert.match(OPTIONS_FUNCTION, /s\.starts_at > now\(\)/);
  assert.match(OPTIONS_FUNCTION, /'fits', public\.available_spots\(s\.id\) >= target\.quantity/);
  // Leitura pura: a listagem não pode alterar nada.
  assert.doesNotMatch(OPTIONS_FUNCTION, /update public\.|insert into public\.|delete from/);
});

test("o payload das turmas é lido defensivamente e carrega o que a tela mostra", () => {
  const parsed = parseReservationSessionOptions({
    reservationId: "5b1a0000-0000-4000-8000-00000000aaaa",
    publicCode: "AZ7K2M9QX1",
    fullName: "João Silva",
    status: "CONFIRMED",
    quantity: 3,
    totalCents: 21000,
    unitPriceCents: 7000,
    hiddenForCapacity: 0,
    current: {
      sessionId: SESSION_0900,
      experienceId: EXPERIENCE,
      experienceTitle: "Imersão Paranoá",
      experienceStatus: "PUBLISHED",
      startsAt: "2026-08-29T12:00:00.000Z",
      durationMinutes: 90,
      capacity: 28,
      remainingSpots: 5,
      priceCents: 7000,
      status: "OPEN",
    },
    options: [
      {
        sessionId: SESSION_1200,
        experienceId: EXPERIENCE,
        experienceTitle: "Imersão Paranoá",
        experienceStatus: "PUBLISHED",
        startsAt: "2026-08-29T15:00:00.000Z",
        durationMinutes: 90,
        capacity: 28,
        remainingSpots: 10,
        priceCents: 7000,
        status: "OPEN",
        fits: true,
      },
      { sessionId: "", startsAt: "" },
      null,
    ],
  });

  assert.ok(parsed);
  assert.equal(parsed.options.length, 1, "opções sem id ou sem horário são descartadas");
  assert.equal(parsed.current?.remainingSpots, 5);
  assert.equal(parsed.quantity, 3);
  assert.equal(parseReservationSessionOptions(null), null);
  assert.equal(parseReservationSessionOptions({ options: [] }), null);
});

test("uma opção só é oferecida quando o banco e a régua da tela concordam", () => {
  const options: ReservationSessionOptions = {
    reservationId: "5b1a0000-0000-4000-8000-00000000aaaa",
    publicCode: "AZ7K2M9QX1",
    fullName: "João Silva",
    status: "CONFIRMED",
    quantity: 3,
    totalCents: 21000,
    unitPriceCents: 7000,
    hiddenForCapacity: 0,
    current: {
      sessionId: SESSION_0900,
      experienceId: EXPERIENCE,
      experienceTitle: "Imersão Paranoá",
      experienceStatus: "PUBLISHED",
      startsAt: "2026-08-29T12:00:00.000Z",
      durationMinutes: 90,
      capacity: 28,
      remainingSpots: 5,
      priceCents: 7000,
      status: "OPEN",
    },
    options: [],
  };

  const option = (overrides: Partial<SessionChangeOption> = {}): SessionChangeOption => ({
    ...target(),
    experienceTitle: "Imersão Paranoá",
    durationMinutes: 90,
    priceCents: 7000,
    fits: true,
    ...overrides,
  });

  assert.equal(evaluateOption(options, option(), NOW).allowed, true);
  assert.equal(denialOf(evaluateOption(options, option({ remainingSpots: 1 }), NOW)), "INSUFFICIENT_SPOTS");
  assert.equal(denialOf(evaluateOption({ ...options, status: "CANCELLED" }, option(), NOW)), "RESERVATION_NOT_CONFIRMED");
  assert.equal(denialOf(evaluateOption({ ...options, current: null }, option(), NOW)), "SESSION_NOT_FOUND");
});

test("cada recusa tem um texto operacional em português", () => {
  for (const reason of [
    "RESERVATION_NOT_CONFIRMED",
    "SESSION_NOT_FOUND",
    "SAME_SESSION",
    "EXPERIENCE_NOT_AVAILABLE",
    "SESSION_NOT_OPEN",
    "SESSION_MUST_BE_FUTURE",
    "INSUFFICIENT_SPOTS",
  ] as const) {
    assert.ok(sessionChangeMessage(reason).length > 10, `${reason} sem mensagem`);
  }
});

test("o resultado da mudança só é aceito quando o banco confirma que moveu", () => {
  const moved = parseSessionChangeResult({
    moved: true,
    changeId: "cccc0000-0000-4000-8000-00000000cccc",
    reservationId: "5b1a0000-0000-4000-8000-00000000aaaa",
    publicCode: "AZ7K2M9QX1",
    status: "CONFIRMED",
    quantity: 3,
    totalCents: 21000,
    previousSessionId: SESSION_0900,
    previousStartsAt: "2026-08-29T12:00:00.000Z",
    targetSessionId: SESSION_1200,
    targetStartsAt: "2026-08-29T15:00:00.000Z",
  });
  assert.equal(moved?.previousSessionId, SESSION_0900);
  assert.equal(moved?.status, "CONFIRMED");
  assert.equal(moved?.totalCents, 21000);

  assert.equal(parseSessionChangeResult({ moved: false }), null);
  assert.equal(parseSessionChangeResult(null), null);
  assert.equal(parseSessionChangeResult({ moved: true, previousSessionId: SESSION_0900 }), null);
});

// --- A migration é aditiva e idempotente ------------------------------------

test("a migration é aditiva, idempotente e não reescreve nada existente", () => {
  assert.match(sql, /create table if not exists public\.reservation_session_changes/);
  assert.match(sql, /create index if not exists/);
  assert.match(sql, /exception when duplicate_object then null/);
  assert.match(sql, /add column if not exists/);

  const executable = statements(sql);
  assert.doesNotMatch(executable, /drop table|drop function|truncate/i);
  // Nenhuma função histórica é redefinida por esta migration.
  for (const existing of [
    "available_spots",
    "create_pre_reservation",
    "confirm_reservation_payment",
    "admin_confirm_reservation",
    "admin_cancel_reservation",
    "lookup_reservation",
  ]) {
    assert.doesNotMatch(
      executable,
      new RegExp(`create or replace function public\\.${existing}`),
      `${existing} não pode ser reescrita aqui`,
    );
  }
});
