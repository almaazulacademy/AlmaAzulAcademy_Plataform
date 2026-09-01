/**
 * Reagendamento administrativo entre experiências diferentes.
 *
 * O caso real: uma reserva paga da Imersão Paranoá precisa virar uma Remada
 * Sunset. É a **mesma** reserva — mesmo id, mesmo `public_code`, mesmo
 * pagamento, mesmo status CONFIRMED — apontando para outra sessão e, agora,
 * para outra experiência.
 *
 * Três tipos de teste convivem aqui, e vale saber qual é qual:
 *
 *   1. **Comportamento de verdade.** A régua de decisão (`evaluateSessionChange`),
 *      a leitura do payload e a sincronização com a planilha rodam de fato,
 *      contra uma planilha falsa em memória. O que passa aqui passou executando.
 *   2. **Contrato do SQL.** O que só o Postgres executa — locks, transação,
 *      `security definer` — é verificado lendo a migration. Prova que a regra
 *      está escrita, não que o Postgres a executou; para isso existe
 *      `supabase/diagnostics/admin_cross_experience_rescheduling_check.sql`.
 *   3. **Modelo de ocupação.** A aritmética de vagas de `available_spots` é
 *      reproduzida aqui em TypeScript para provar a direção do movimento — a
 *      turma antiga libera, a nova ocupa — a partir da mesma definição que o SQL
 *      usa: a soma das reservas *daquela* sessão.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  evaluateOption,
  evaluateSessionChange,
  parseReservationSessionOptions,
  parseSessionChangeResult,
  priceDifferenceCents,
  sessionChangeMessage,
  type ReservationSessionOptions,
  type SessionChangeOption,
  type SessionChangeReservation,
  type SessionChangeTarget,
} from "../lib/admin/session-change.ts";
import { adminMutationError } from "../lib/admin/mutation-errors.ts";
import {
  reservationRow,
  type ReservationSnapshot,
  type SessionSnapshot,
  type SheetValue,
} from "../lib/integrations/google-sheets/mapping.ts";
import {
  ACTIVE_YES,
  RESERVATION_COLUMN,
  RESERVATION_HEADERS,
  RESERVATIONS_TAB,
  SPOT_COLUMN,
  SPOT_HEADERS,
  SPOTS_TAB,
  SESSION_HEADERS,
  SESSIONS_TAB,
} from "../lib/integrations/google-sheets/schema.ts";
import { syncSnapshot, type SheetsGateway } from "../lib/integrations/google-sheets/sync.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const MIGRATION = source("supabase/migrations/202608310001_admin_cross_experience_rescheduling.sql");

/** Só o SQL executável: os comentários explicam o contrato, não o cumprem. */
function statements(text: string) {
  return text.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
}

function section(from: string, to?: string) {
  const start = MIGRATION.indexOf(from);
  assert.notEqual(start, -1, `seção ausente: ${from}`);
  const end = to ? MIGRATION.indexOf(to) : MIGRATION.length;
  assert.notEqual(end, -1, `seção ausente: ${to}`);
  return statements(MIGRATION.slice(start, end));
}

const HISTORY_COLUMNS = section("-- 1. Histórico", "-- 2. A coerência");
const CONSISTENCY_TRIGGER = section("-- 2. A coerência", "-- 3. A operação transacional");
const CHANGE_FUNCTION = section("-- 3. A operação transacional", "-- 4. Turmas de destino");
const OPTIONS_FUNCTION = section("-- 4. Turmas de destino", "-- 5. Histórico exibido");
const HISTORY_FUNCTION = section("-- 5. Histórico exibido", "-- 6. Grants");
const GRANTS = section("-- 6. Grants");

// --- Cenário ----------------------------------------------------------------
//
// Duas experiências reais da agenda, com preços diferentes de propósito: é a
// diferença de preço que precisa ser registrada sem ser cobrada.

const NOW = new Date("2026-08-20T12:00:00.000Z");

const PARANOA = "aaaa0000-0000-4000-8000-00000000aaaa";
const SUNSET = "bbbb0000-0000-4000-8000-00000000bbbb";
const LUA_CHEIA = "cccc0000-0000-4000-8000-00000000cccc";

const PARANOA_0900 = "11110000-0000-4000-8000-000000000001";
const PARANOA_1200 = "22220000-0000-4000-8000-000000000002";
const SUNSET_1730 = "33330000-0000-4000-8000-000000000003";
const LUA_CHEIA_1900 = "44440000-0000-4000-8000-000000000004";

const PARANOA_PRICE = 21000;
const SUNSET_PRICE = 14000;

/** A reserva do cenário: 3 pessoas, confirmadas, na Imersão Paranoá das 09:00. */
function reservation(overrides: Partial<SessionChangeReservation> = {}): SessionChangeReservation {
  return {
    status: "CONFIRMED",
    quantity: 3,
    sessionId: PARANOA_0900,
    experienceId: PARANOA,
    ...overrides,
  };
}

function target(overrides: Partial<SessionChangeTarget> = {}): SessionChangeTarget {
  return {
    sessionId: SUNSET_1730,
    experienceId: SUNSET,
    experienceStatus: "PUBLISHED",
    startsAt: "2026-09-05T20:30:00.000Z", // 17:30 em Brasília
    status: "OPEN",
    capacity: 12,
    remainingSpots: 8,
    ...overrides,
  };
}

function denialOf(verdict: ReturnType<typeof evaluateSessionChange>) {
  assert.equal(verdict.allowed, false, "a mudança deveria ter sido recusada");
  return verdict.allowed === false ? verdict.reason : "";
}

// --- 1. Mesma experiência, outra sessão: o fluxo antigo continua de pé ------

test("1. regressão: mesma experiência, outra sessão com vagas, continua permitido", () => {
  const verdict = evaluateSessionChange(
    reservation(),
    target({ sessionId: PARANOA_1200, experienceId: PARANOA, startsAt: "2026-08-29T15:00:00.000Z" }),
    NOW,
  );
  assert.equal(verdict.allowed, true);
});

test("1b. regressão: nenhuma das recusas antigas foi afrouxada", () => {
  const dentroDaExperiencia = { sessionId: PARANOA_1200, experienceId: PARANOA };

  // Turma passada.
  assert.equal(
    denialOf(evaluateSessionChange(reservation(), target({ ...dentroDaExperiencia, startsAt: "2026-08-01T12:00:00.000Z" }), NOW)),
    "SESSION_MUST_BE_FUTURE",
  );
  // Turma fechada, cancelada ou arquivada.
  for (const status of ["CLOSED", "CANCELLED", "ARCHIVED"] as const) {
    assert.equal(
      denialOf(evaluateSessionChange(reservation(), target({ ...dentroDaExperiencia, status }), NOW)),
      "SESSION_NOT_OPEN",
    );
  }
  // A própria turma.
  assert.equal(
    denialOf(evaluateSessionChange(reservation(), target({ sessionId: PARANOA_0900, experienceId: PARANOA }), NOW)),
    "SAME_SESSION",
  );
  // Reserva que não está confirmada.
  for (const status of ["PRE_RESERVED", "EXPIRED", "CANCELLED"] as const) {
    assert.equal(
      denialOf(evaluateSessionChange(reservation({ status }), target(dentroDaExperiencia), NOW)),
      "RESERVATION_NOT_CONFIRMED",
    );
  }
});

// --- 2 e 3. A → B e B → A ---------------------------------------------------

test("2. experiência A → experiência B: Imersão Paranoá vira Remada Sunset", () => {
  const verdict = evaluateSessionChange(reservation(), target(), NOW);
  assert.equal(verdict.allowed, true);
});

test("3. experiência B → experiência A: a volta é igualmente permitida", () => {
  const verdict = evaluateSessionChange(
    reservation({ sessionId: SUNSET_1730, experienceId: SUNSET }),
    target({ sessionId: PARANOA_1200, experienceId: PARANOA, startsAt: "2026-08-29T15:00:00.000Z", capacity: 28 }),
    NOW,
  );
  assert.equal(verdict.allowed, true);
});

test("3b. uma terceira experiência da agenda também é destino válido", () => {
  const verdict = evaluateSessionChange(
    reservation(),
    target({ sessionId: LUA_CHEIA_1900, experienceId: LUA_CHEIA, startsAt: "2026-09-26T22:00:00.000Z" }),
    NOW,
  );
  assert.equal(verdict.allowed, true);
});

test("3c. experiência não publicada não recebe reserva de outra experiência", () => {
  for (const status of ["DRAFT", "ARCHIVED"] as const) {
    const verdict = evaluateSessionChange(reservation(), target({ experienceStatus: status }), NOW);
    assert.equal(denialOf(verdict), "EXPERIENCE_NOT_AVAILABLE");
  }

  // Dentro da própria experiência da reserva, a publicação não é exigida: quem
  // já comprou precisa poder trocar de horário mesmo depois de o produto sair
  // do site.
  const dentro = evaluateSessionChange(
    reservation(),
    target({ sessionId: PARANOA_1200, experienceId: PARANOA, experienceStatus: "ARCHIVED" }),
    NOW,
  );
  assert.equal(dentro.allowed, true);

  assert.match(
    CHANGE_FUNCTION,
    /if experience_changed and destination_experience\.status <> 'PUBLISHED' then\s+raise exception 'EXPERIENCE_NOT_AVAILABLE'/,
  );
});

// --- 4 e 7. Vagas insuficientes e quantidade maior que a capacidade ---------

test("4. destino sem vagas suficientes é bloqueado com mensagem clara", () => {
  for (const remainingSpots of [0, 1, 2]) {
    const verdict = evaluateSessionChange(reservation({ quantity: 3 }), target({ remainingSpots }), NOW);
    assert.equal(denialOf(verdict), "INSUFFICIENT_SPOTS", `${remainingSpots} vagas não bastam para 3 pessoas`);
  }

  assert.equal(
    sessionChangeMessage("INSUFFICIENT_SPOTS"),
    "Esta turma não tem vagas suficientes para a reserva inteira.",
  );
  assert.equal(adminMutationError(new Error("INSUFFICIENT_SPOTS")).status, 409);
});

test("7. quantidade maior que a capacidade da turma é bloqueada mesmo com o número de vagas inconsistente", () => {
  const verdict = evaluateSessionChange(
    reservation({ quantity: 10 }),
    target({ capacity: 8, remainingSpots: 12 }),
    NOW,
  );
  assert.equal(denialOf(verdict), "INSUFFICIENT_SPOTS");
});

test("7b. a reserva vai inteira: 3 pessoas cabem em 3 vagas, não em 2", () => {
  assert.equal(evaluateSessionChange(reservation({ quantity: 3 }), target({ remainingSpots: 3 }), NOW).allowed, true);
  assert.equal(
    denialOf(evaluateSessionChange(reservation({ quantity: 3 }), target({ remainingSpots: 2 }), NOW)),
    "INSUFFICIENT_SPOTS",
  );
});

// --- 5 e 6. Sessão cancelada e sessão passada, agora entre experiências -----

test("5. sessão cancelada de outra experiência não recebe a reserva", () => {
  const verdict = evaluateSessionChange(reservation(), target({ status: "CANCELLED" }), NOW);
  assert.equal(denialOf(verdict), "SESSION_NOT_OPEN");
});

test("6. sessão passada de outra experiência não recebe a reserva", () => {
  const verdict = evaluateSessionChange(reservation(), target({ startsAt: "2026-08-19T20:30:00.000Z" }), NOW);
  assert.equal(denialOf(verdict), "SESSION_MUST_BE_FUTURE");
});

test("6b. o banco recusa de novo o que a tela recusou, na mesma ordem", () => {
  // A ordem das checagens no SQL é a mesma da régua de `evaluateSessionChange`:
  // confirmada → existe → não é a própria → experiência elegível → aberta →
  // futura → cabe.
  const order = [
    "RESERVATION_NOT_CONFIRMED",
    "SAME_SESSION",
    "EXPERIENCE_NOT_AVAILABLE",
    "SESSION_NOT_OPEN",
    "SESSION_MUST_BE_FUTURE",
    "INSUFFICIENT_SPOTS",
  ].map((code) => CHANGE_FUNCTION.indexOf(`raise exception '${code}'`));

  assert.ok(order.every((position) => position !== -1), "toda recusa precisa existir no SQL");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "as recusas precisam estar na ordem da régua da tela");
});

// --- 8. A mesma reserva: id, public_code e pagamento -------------------------

test("8. a reserva movida é a mesma: nem id, nem código, nem pagamento são reescritos", () => {
  // Nenhuma reserva nova nasce, nenhuma antiga morre.
  assert.doesNotMatch(CHANGE_FUNCTION, /insert into public\.reservations/);
  assert.doesNotMatch(CHANGE_FUNCTION, /delete from public\.reservations/);

  for (const field of [
    "public_code = ",
    "id = gen_random_uuid",
    "set status = 'CANCELLED'",
    "set status = 'CONFIRMED'",
    "confirmed_at = ",
    "cancelled_at = ",
    "full_name = ",
    "cpf_hash = ",
    "quantity = ",
  ]) {
    assert.doesNotMatch(CHANGE_FUNCTION, new RegExp(field), `${field.trim()} não pode ser reescrito`);
  }

  // Pagamento: nenhum evento, nenhuma cobrança, nenhum checkout.
  assert.doesNotMatch(CHANGE_FUNCTION, /payment_events/);
  assert.doesNotMatch(CHANGE_FUNCTION, /payment_provider = /);
  assert.doesNotMatch(CHANGE_FUNCTION, /provider_reference = /);
  assert.doesNotMatch(CHANGE_FUNCTION, /checkout_url = /);
});

test("8b. o status CONFIRMED é exigido na entrada e nunca reescrito na saída", () => {
  assert.match(CHANGE_FUNCTION, /if target\.status <> 'CONFIRMED' then\s+raise exception 'RESERVATION_NOT_CONFIRMED'/);
  assert.match(CHANGE_FUNCTION, /'status', target\.status/);
});

// --- 9. experience_id atualizado junto com session_id -----------------------

test("9. o UPDATE escreve as duas colunas do vínculo, na mesma transação", () => {
  assert.match(
    CHANGE_FUNCTION,
    /update public\.reservations\s+set session_id = destination_session\.id,\s+experience_id = destination_session\.experience_id,\s+updated_at = now\(\)\s+where id = target\.id\s+returning \* into moved;/,
  );
});

test("9b. a coerência é reconferida depois da escrita, dentro da transação", () => {
  assert.match(
    CHANGE_FUNCTION,
    /if moved\.session_id is distinct from destination_session\.id\s+or moved\.experience_id is distinct from destination_session\.experience_id then\s+raise exception 'RESERVATION_EXPERIENCE_DESYNC'/,
  );
});

test("9c. a proteção antiga foi substituída por uma invariante do banco, não removida", () => {
  // A regra antiga: "não deixe a experiência mudar". Ela não existe mais.
  assert.doesNotMatch(CHANGE_FUNCTION, /SESSION_EXPERIENCE_MISMATCH/);

  // A nova: "a experiência da reserva é sempre a experiência da sessão dela" —
  // garantida por trigger, para nenhum caminho futuro poder divergir.
  assert.match(CONSISTENCY_TRIGGER, /create trigger reservations_experience_consistency\s+before insert or update on public\.reservations/);
  assert.match(CONSISTENCY_TRIGGER, /raise exception 'RESERVATION_EXPERIENCE_DESYNC'/);

  // E só cobra o preço da validação quando o par é realmente escrito: confirmar
  // ou cancelar uma reserva não passa por ela.
  assert.match(
    CONSISTENCY_TRIGGER,
    /if tg_op = 'UPDATE'\s+and new\.session_id is not distinct from old\.session_id\s+and new\.experience_id is not distinct from old\.experience_id then\s+return new;/,
  );
});

test("9d. quem lê a experiência da reserva passa a ler a nova", () => {
  // Estas quatro resolvem a experiência por `r.experience_id`, não pela sessão.
  // É por isso que mover só o `session_id` deixaria as quatro erradas — e é o
  // que torna a escrita da segunda coluna obrigatória, não cosmética.
  const readers: Array<[string, string]> = [
    ["lookup_reservation", "supabase/migrations/202608010001_reservation_platform.sql"],
    ["admin_get_reservation", "supabase/migrations/202608010002_admin_dashboard_mvp.sql"],
    ["admin_list_reservations", "supabase/migrations/202608280001_payment_confirmation_reliability.sql"],
    ["reservation_confirmation_email", "supabase/migrations/202608190001_reservation_confirmation_email.sql"],
  ];

  for (const [name, path] of readers) {
    const body = statements(source(path));
    assert.ok(body.includes(name), `${name} não encontrada em ${path}`);
    assert.match(body, /join public\.experiences e on e\.id ?= ?r\.experience_id/, `${name} lê a experiência da reserva`);
  }
});

// --- 10 e 11. Disponibilidade das duas turmas -------------------------------
//
// `available_spots` é `capacity - soma das reservas válidas daquela sessão`.
// O modelo abaixo repete essa definição para provar a direção do movimento.

type ModelReservation = { id: string; sessionId: string; quantity: number; status: string };

function availableSpots(sessions: Record<string, number>, reservations: ModelReservation[], sessionId: string) {
  const occupied = reservations
    .filter((row) => row.sessionId === sessionId && row.status === "CONFIRMED")
    .reduce((total, row) => total + row.quantity, 0);
  return Math.max(0, sessions[sessionId] - occupied);
}

test("10 e 11. a turma antiga libera as vagas e a nova as ocupa, sem contador paralelo", () => {
  const capacities = { [PARANOA_0900]: 28, [SUNSET_1730]: 12 };
  const rows: ModelReservation[] = [
    { id: "reserva", sessionId: PARANOA_0900, quantity: 3, status: "CONFIRMED" },
    { id: "outra", sessionId: SUNSET_1730, quantity: 2, status: "CONFIRMED" },
  ];

  assert.equal(availableSpots(capacities, rows, PARANOA_0900), 25);
  assert.equal(availableSpots(capacities, rows, SUNSET_1730), 10);

  // A operação: uma única linha muda de sessão.
  rows[0].sessionId = SUNSET_1730;

  assert.equal(availableSpots(capacities, rows, PARANOA_0900), 28, "a turma antiga precisa liberar as 3 vagas");
  assert.equal(availableSpots(capacities, rows, SUNSET_1730), 7, "a turma nova precisa ocupar as 3 vagas");

  // É exatamente isso que o SQL faz: nenhuma capacidade é reescrita e nenhum
  // snapshot legado de vagas é tocado.
  assert.doesNotMatch(CHANGE_FUNCTION, /update public\.sessions/);
  assert.doesNotMatch(CHANGE_FUNCTION, /spots_available/);
});

test("11b. a ocupação do destino é recontada das linhas reais, com as sessões travadas", () => {
  assert.match(
    CHANGE_FUNCTION,
    /select coalesce\(sum\(quantity\), 0\)::integer into occupied\s+from public\.reservations\s+where session_id = destination_session\.id/,
  );
  assert.match(CHANGE_FUNCTION, /if occupied \+ target\.quantity > destination_session\.capacity then\s+raise exception 'INSUFFICIENT_SPOTS'/);
  assert.ok(
    CHANGE_FUNCTION.indexOf("for update") < CHANGE_FUNCTION.indexOf("into occupied"),
    "a contagem precisa acontecer depois do lock",
  );
});

// --- 12. Histórico com as duas experiências ---------------------------------

test("12. o histórico grava a experiência de antes e a de depois", () => {
  for (const column of ["previous_experience_id", "target_experience_id"]) {
    assert.match(HISTORY_COLUMNS, new RegExp(`add column if not exists ${column} uuid references public\\.experiences`));
    assert.match(CHANGE_FUNCTION, new RegExp(`\\b${column}\\b`), `a RPC precisa preencher ${column}`);
  }

  // O histórico antigo é preenchido, não descartado: toda troca já gravada
  // nasceu dentro de uma experiência só.
  assert.match(HISTORY_COLUMNS, /update public\.reservation_session_changes c/);
  assert.match(HISTORY_COLUMNS, /coalesce\(c\.previous_experience_id, previous\.experience_id\)/);

  // E a leitura devolve os dois títulos, com o sinal de que a fronteira foi
  // atravessada.
  assert.match(HISTORY_FUNCTION, /previous_experience_title text/);
  assert.match(HISTORY_FUNCTION, /target_experience_title text/);
  assert.match(HISTORY_FUNCTION, /experience_changed boolean/);
});

test("12b. a trilha administrativa registra as duas experiências e o ator", () => {
  assert.match(CHANGE_FUNCTION, /'RESERVATION_SESSION_CHANGED',\s+'RESERVATION',/);
  for (const key of [
    "'previousExperienceId'",
    "'previousExperienceTitle'",
    "'targetExperienceId'",
    "'targetExperienceTitle'",
    "'experienceChanged'",
  ]) {
    assert.match(CHANGE_FUNCTION, new RegExp(key), `a auditoria precisa de ${key}`);
  }
  assert.match(CHANGE_FUNCTION, /insert into public\.admin_audit_log \(actor_user_id, action, entity_type, entity_id, reason, metadata\)/);
});

test("12c. o resultado da troca chega tipado ao painel, com as duas experiências", () => {
  const moved = parseSessionChangeResult({
    moved: true,
    changeId: "dddd0000-0000-4000-8000-00000000dddd",
    reservationId: "5b1a0000-0000-4000-8000-00000000aaaa",
    publicCode: "AZ7K2M9QX1",
    status: "CONFIRMED",
    quantity: 3,
    totalCents: 3 * PARANOA_PRICE,
    unitPriceCents: PARANOA_PRICE,
    experienceChanged: true,
    previousSessionId: PARANOA_0900,
    previousStartsAt: "2026-08-29T12:00:00.000Z",
    previousExperienceId: PARANOA,
    previousExperienceTitle: "Imersão Paranoá",
    previousSessionPriceCents: PARANOA_PRICE,
    targetSessionId: SUNSET_1730,
    targetStartsAt: "2026-09-05T20:30:00.000Z",
    targetExperienceId: SUNSET,
    targetExperienceTitle: "Remada Sunset",
    targetSessionPriceCents: SUNSET_PRICE,
  });

  assert.equal(moved?.experienceChanged, true);
  assert.equal(moved?.previousExperienceTitle, "Imersão Paranoá");
  assert.equal(moved?.targetExperienceTitle, "Remada Sunset");
  assert.equal(moved?.status, "CONFIRMED");
  assert.equal(moved?.publicCode, "AZ7K2M9QX1");

  // Uma resposta que não afirma ter movido nunca vira sucesso na tela.
  assert.equal(parseSessionChangeResult({ moved: false }), null);
});

// --- 13. Preço entre experiências diferentes --------------------------------

test("13. a diferença de preço é informada, nunca cobrada nem estornada", () => {
  // A reserva pagou 210,00 por pessoa; a turma nova custa 140,00 hoje.
  assert.equal(priceDifferenceCents(PARANOA_PRICE, SUNSET_PRICE), -7000);
  assert.equal(priceDifferenceCents(SUNSET_PRICE, PARANOA_PRICE), 7000);
  assert.equal(priceDifferenceCents(PARANOA_PRICE, PARANOA_PRICE), 0);

  // O valor pago é coluna da reserva e não é recalculado a partir da turma nova.
  assert.doesNotMatch(CHANGE_FUNCTION, /unit_price_cents = /);
  assert.doesNotMatch(CHANGE_FUNCTION, /total_cents = /);

  // Os dois preços ficam registrados no histórico, para a diferença ser
  // auditável depois.
  assert.match(CHANGE_FUNCTION, /previous_session_price_cents/);
  assert.match(CHANGE_FUNCTION, /target_session_price_cents/);
  assert.match(CHANGE_FUNCTION, /'priceDiffers', origin_session\.price_cents is distinct from destination_session\.price_cents/);
});

// --- 14. Pagamento intocado -------------------------------------------------

test("14. nenhuma camada dispara cobrança, estorno, checkout ou e-mail na troca", () => {
  const data = source("lib/admin/data.ts");
  const body = data.slice(
    data.indexOf("export async function changeAdminReservationSession"),
    data.indexOf("export async function listAdminReservationSessionChanges"),
  );
  assert.doesNotMatch(body, /sendReservationConfirmationEmail|createCheckout|refund|estorno/i);

  const route = source("app/api/admin/reservations/[reservationId]/change-session/route.ts");
  assert.doesNotMatch(route, /payment|checkout|refund/i);
});

// --- 15. Concorrência: nunca overbooking ------------------------------------

test("15. duas trocas simultâneas são serializadas, e sem deadlock", () => {
  // A reserva é travada antes de qualquer leitura de sessão.
  assert.match(CHANGE_FUNCTION, /select \* into target from public\.reservations where id = p_reservation_id for update;/);

  // As duas sessões são travadas sempre na ordem dos ids — nunca "origem
  // primeiro" — para que mover A de S1 para S2 enquanto alguém move B de S2
  // para S1 não trave as duas transações uma esperando a outra.
  assert.match(CHANGE_FUNCTION, /if target\.session_id < p_target_session_id then/);
  const locks = CHANGE_FUNCTION.match(/from public\.sessions where id = [\w.]+ for update/g) ?? [];
  assert.equal(locks.length, 4, "as duas sessões são travadas nos dois ramos da ordenação");

  // Com a agenda inteira elegível, a troca cruzada entre experiências diferentes
  // é justamente o caso que mais expõe o deadlock — e a ordenação por id não
  // depende de experiência nenhuma.
  assert.doesNotMatch(CHANGE_FUNCTION, /order by .*experience_id.* for update/);

  // A decisão final é do banco, depois do lock.
  assert.ok(
    CHANGE_FUNCTION.indexOf("into occupied") < CHANGE_FUNCTION.indexOf("set session_id = destination_session.id"),
  );
});

test("15b. toda recusa aborta a transação inteira; nada sobrevive pela metade", () => {
  for (const failure of [
    "RESERVATION_NOT_CONFIRMED",
    "SAME_SESSION",
    "SESSION_NOT_FOUND",
    "EXPERIENCE_NOT_FOUND",
    "EXPERIENCE_NOT_AVAILABLE",
    "SESSION_NOT_OPEN",
    "SESSION_MUST_BE_FUTURE",
    "INSUFFICIENT_SPOTS",
    "RESERVATION_EXPERIENCE_DESYNC",
  ]) {
    assert.match(CHANGE_FUNCTION, new RegExp(`raise exception '${failure}'`));
    assert.notEqual(
      adminMutationError(new Error(failure)).message,
      "Não foi possível concluir a operação.",
      `${failure} precisa de mensagem própria no painel`,
    );
  }
  assert.doesNotMatch(CHANGE_FUNCTION, /exception when others/, "nenhum erro é engolido dentro da transação");
});

// --- 16. Só admin executa ---------------------------------------------------

test("16. usuário não-admin não executa nada, em nenhuma das três funções", () => {
  for (const body of [CHANGE_FUNCTION, OPTIONS_FUNCTION, HISTORY_FUNCTION]) {
    assert.match(body, /if not public\.is_active_admin\(p_actor_id\) then\s+raise exception 'ADMIN_FORBIDDEN' using errcode = '42501'/);
  }

  // A guarda vem antes de qualquer leitura ou escrita.
  const guard = CHANGE_FUNCTION.indexOf("is_active_admin");
  assert.ok(guard !== -1);
  assert.ok(guard < CHANGE_FUNCTION.indexOf("select * into target"));
  assert.ok(guard < CHANGE_FUNCTION.indexOf("update public.reservations"));

  // Execução revogada de todo mundo menos a service role.
  for (const name of [
    "admin_change_reservation_session\\(uuid, uuid, uuid, text\\)",
    "admin_reservation_session_options\\(uuid, uuid\\)",
    "admin_list_reservation_session_changes\\(uuid, uuid\\)",
  ]) {
    assert.match(GRANTS, new RegExp(`revoke all on function public\\.${name} from public, anon, authenticated`));
    assert.match(GRANTS, new RegExp(`grant execute on function public\\.${name} to service_role`));
  }

  // As três continuam `security definer` com `search_path` fixo.
  for (const body of [CHANGE_FUNCTION, OPTIONS_FUNCTION, HISTORY_FUNCTION]) {
    assert.match(body, /security definer\s+set search_path = public/);
  }
});

test("16b. o ator vem da sessão validada no servidor, nunca do payload", () => {
  const route = source("app/api/admin/reservations/[reservationId]/change-session/route.ts");
  assert.match(route, /authorization\.context\.profile\.userId/);
  assert.match(route, /isSameOriginRequest\(request\)/);
  assert.doesNotMatch(route, /actorId|p_actor_id/);

  const options = source("app/api/admin/reservations/[reservationId]/session-options/route.ts");
  assert.match(options, /authorizeAdminApi\(\)/);
  assert.match(options, /authorization\.context\.profile\.userId/);
});

// --- 17. O seletor: a agenda inteira, recortada pelo banco ------------------

test("17. o seletor oferece toda a agenda futura elegível, não só a experiência atual", () => {
  assert.doesNotMatch(OPTIONS_FUNCTION, /s\.experience_id = target\.experience_id/);
  assert.match(OPTIONS_FUNCTION, /s\.id <> target\.session_id/);
  assert.match(OPTIONS_FUNCTION, /s\.status = 'OPEN'/);
  assert.match(OPTIONS_FUNCTION, /s\.starts_at > now\(\)/);
  assert.match(OPTIONS_FUNCTION, /e\.status = 'PUBLISHED' or e\.id = target\.experience_id/);

  // Cada opção nomeia a experiência, a data, o horário e as vagas.
  for (const field of ["'experienceId'", "'experienceTitle'", "'experienceStatus'", "'startsAt'", "'remainingSpots'", "'capacity'", "'priceCents'"]) {
    assert.match(OPTIONS_FUNCTION, new RegExp(field), `a opção precisa carregar ${field}`);
  }

  // Sem vaga para o grupo inteiro, a turma não é oferecida — e é contada, para
  // a tela poder explicar a ausência.
  assert.match(OPTIONS_FUNCTION, /filter \(where candidate\.fits\)/);
  assert.match(OPTIONS_FUNCTION, /count\(\*\) filter \(where not candidate\.fits\)/);
  assert.match(OPTIONS_FUNCTION, /'hiddenForCapacity'/);

  // Leitura pura: a listagem não altera nada.
  assert.doesNotMatch(OPTIONS_FUNCTION, /update public\.|insert into public\.|delete from/);
});

test("17b. o payload do seletor é lido defensivamente e sobrevive a lixo", () => {
  const parsed = parseReservationSessionOptions({
    reservationId: "5b1a0000-0000-4000-8000-00000000aaaa",
    publicCode: "AZ7K2M9QX1",
    fullName: "João Silva",
    status: "CONFIRMED",
    quantity: 3,
    totalCents: 3 * PARANOA_PRICE,
    unitPriceCents: PARANOA_PRICE,
    hiddenForCapacity: 2,
    current: {
      sessionId: PARANOA_0900,
      experienceId: PARANOA,
      experienceTitle: "Imersão Paranoá",
      experienceStatus: "PUBLISHED",
      startsAt: "2026-08-29T12:00:00.000Z",
      durationMinutes: 240,
      capacity: 28,
      remainingSpots: 5,
      priceCents: PARANOA_PRICE,
      status: "OPEN",
    },
    options: [
      {
        sessionId: SUNSET_1730,
        experienceId: SUNSET,
        experienceTitle: "Remada Sunset",
        experienceStatus: "PUBLISHED",
        startsAt: "2026-09-05T20:30:00.000Z",
        durationMinutes: 90,
        capacity: 12,
        remainingSpots: 8,
        priceCents: SUNSET_PRICE,
        status: "OPEN",
        fits: true,
      },
      { sessionId: "", startsAt: "" },
      null,
    ],
  });

  assert.ok(parsed);
  assert.equal(parsed.options.length, 1, "opções sem id ou sem horário são descartadas");
  assert.equal(parsed.options[0].experienceTitle, "Remada Sunset");
  assert.equal(parsed.options[0].experienceStatus, "PUBLISHED");
  assert.equal(parsed.unitPriceCents, PARANOA_PRICE);
  assert.equal(parsed.hiddenForCapacity, 2);

  // Um status de experiência desconhecido nunca vira "PUBLISHED" por acidente.
  const suspeito = parseReservationSessionOptions({
    reservationId: "5b1a0000-0000-4000-8000-00000000aaaa",
    current: { sessionId: PARANOA_0900, startsAt: "2026-08-29T12:00:00.000Z" },
    options: [{ sessionId: SUNSET_1730, startsAt: "2026-09-05T20:30:00.000Z", experienceStatus: "qualquer coisa" }],
  });
  assert.equal(suspeito?.options[0].experienceStatus, "DRAFT");
});

test("17c. a tela reaplica a régua do banco antes de habilitar uma opção", () => {
  const options: ReservationSessionOptions = {
    reservationId: "5b1a0000-0000-4000-8000-00000000aaaa",
    publicCode: "AZ7K2M9QX1",
    fullName: "João Silva",
    status: "CONFIRMED",
    quantity: 3,
    totalCents: 3 * PARANOA_PRICE,
    unitPriceCents: PARANOA_PRICE,
    hiddenForCapacity: 0,
    current: {
      sessionId: PARANOA_0900,
      experienceId: PARANOA,
      experienceTitle: "Imersão Paranoá",
      experienceStatus: "PUBLISHED",
      startsAt: "2026-08-29T12:00:00.000Z",
      durationMinutes: 240,
      capacity: 28,
      remainingSpots: 5,
      priceCents: PARANOA_PRICE,
      status: "OPEN",
    },
    options: [],
  };

  const option = (overrides: Partial<SessionChangeOption> = {}): SessionChangeOption => ({
    ...target(),
    experienceTitle: "Remada Sunset",
    durationMinutes: 90,
    priceCents: SUNSET_PRICE,
    fits: true,
    ...overrides,
  });

  assert.equal(evaluateOption(options, option(), NOW).allowed, true);
  assert.equal(denialOf(evaluateOption(options, option({ remainingSpots: 2 }), NOW)), "INSUFFICIENT_SPOTS");
  assert.equal(denialOf(evaluateOption(options, option({ experienceStatus: "ARCHIVED" }), NOW)), "EXPERIENCE_NOT_AVAILABLE");
  assert.equal(denialOf(evaluateOption({ ...options, status: "CANCELLED" }, option(), NOW)), "RESERVATION_NOT_CONFIRMED");
});

// --- 18. Google Sheets: a mesma reserva, sem duplicar -----------------------
//
// Este bloco roda a sincronização de verdade contra uma planilha falsa em
// memória. É o mesmo motor que fala com o Google em produção.

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

function createFakeSheets() {
  const tabs = new Map<string, SheetValue[][]>();
  for (const [tab, headers] of [
    [RESERVATIONS_TAB, RESERVATION_HEADERS],
    [SESSIONS_TAB, SESSION_HEADERS],
    [SPOTS_TAB, SPOT_HEADERS],
  ] as Array<readonly [string, readonly string[]]>) {
    tabs.set(tab, [[...headers]]);
  }

  const grid = (tab: string) => {
    const existing = tabs.get(tab);
    if (existing) return existing;
    const created: SheetValue[][] = [];
    tabs.set(tab, created);
    return created;
  };

  const lastUsedRow = (tab: string) => {
    const rows = grid(tab);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if ((rows[index] ?? []).some((cell) => cell !== "" && cell !== undefined)) return index;
    }
    return -1;
  };

  const gateway: SheetsGateway & { dataRows(tab: string): SheetValue[][] } = {
    dataRows: (tab: string) => grid(tab).slice(1).filter((row) => (row ?? []).some((cell) => cell !== "")),

    async batchGet(ranges: string[]) {
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
      for (const update of updates) {
        const { tab, startColumn, startRow } = parseRange(update.range);
        const rows = grid(tab);
        update.values.forEach((values, rowOffset) => {
          const position = startRow + rowOffset;
          while (rows.length <= position) rows.push([]);
          values.forEach((value, columnOffset) => {
            rows[position][startColumn + columnOffset] = value;
          });
        });
      }
    },
  };

  return gateway;
}

const RESERVA: ReservationSnapshot = {
  id: "5b1a0000-0000-4000-8000-00000000aaaa",
  sessionId: PARANOA_0900,
  publicCode: "AZ7K2M9QX1",
  fullName: "João Silva",
  phone: "+5561999990000",
  quantity: 3,
  totalCents: 3 * PARANOA_PRICE,
  status: "CONFIRMED",
  paymentStatus: "PAID",
  paymentMethod: "pix",
  createdAt: "2026-08-10T12:00:00.000Z",
  confirmedAt: "2026-08-10T12:30:00.000Z",
  cancelledAt: null,
};

const TURMA_PARANOA: SessionSnapshot = {
  id: PARANOA_0900,
  experienceTitle: "Imersão Paranoá",
  startsAt: "2026-08-29T12:00:00.000Z", // 09:00 em Brasília
  durationMinutes: 240,
  capacity: 28,
  confirmedSpots: 3,
  remainingSpots: 25,
  status: "OPEN",
};

const TURMA_SUNSET: SessionSnapshot = {
  id: SUNSET_1730,
  experienceTitle: "Remada Sunset",
  startsAt: "2026-09-05T20:30:00.000Z", // 17:30 em Brasília
  durationMinutes: 90,
  capacity: 12,
  confirmedSpots: 3,
  remainingSpots: 9,
  status: "OPEN",
};

test("18. a planilha atualiza a mesma linha da reserva ao mudar de experiência", async () => {
  const sheets = createFakeSheets();

  await syncSnapshot(sheets, { session: TURMA_PARANOA, reservations: [RESERVA] }, { syncedAt: "2026-08-10T13:00:00.000Z" });

  const antes = sheets.dataRows(RESERVATIONS_TAB);
  assert.equal(antes.length, 1);
  assert.equal(antes[0][RESERVATION_COLUMN.sessionId - 1], PARANOA_0900);
  assert.equal(antes[0][3], "Imersão Paranoá");

  // A troca: a mesma reserva, agora na Remada Sunset.
  await syncSnapshot(
    sheets,
    { session: TURMA_SUNSET, reservations: [{ ...RESERVA, sessionId: SUNSET_1730 }] },
    { syncedAt: "2026-08-20T13:00:00.000Z" },
  );

  const depois = sheets.dataRows(RESERVATIONS_TAB);
  assert.equal(depois.length, 1, "a reserva não pode ser duplicada na planilha");
  assert.equal(depois[0][RESERVATION_COLUMN.reservationId - 1], RESERVA.id, "é a mesma linha, pela mesma chave");
  assert.equal(depois[0][RESERVATION_COLUMN.publicCode - 1], "AZ7K2M9QX1");
  assert.equal(depois[0][RESERVATION_COLUMN.sessionId - 1], SUNSET_1730);
  assert.equal(depois[0][3], "Remada Sunset", "a experiência nova precisa aparecer");
  assert.equal(depois[0][4], "05/09/2026", "a data nova precisa aparecer");
  assert.equal(depois[0][5], "17:30", "o horário novo precisa aparecer");
  assert.equal(depois[0][9], 630, "o valor pago não muda com a experiência");
});

test("18b. as vagas confirmadas trocam de sessão sem virar vagas novas", async () => {
  const sheets = createFakeSheets();

  await syncSnapshot(sheets, { session: TURMA_PARANOA, reservations: [RESERVA] }, { syncedAt: "2026-08-10T13:00:00.000Z" });
  await syncSnapshot(
    sheets,
    { session: TURMA_SUNSET, reservations: [{ ...RESERVA, sessionId: SUNSET_1730 }] },
    { syncedAt: "2026-08-20T13:00:00.000Z" },
  );

  const vagas = sheets.dataRows(SPOTS_TAB);
  assert.equal(vagas.length, 3, "três participantes continuam sendo três vagas, não seis");
  for (const vaga of vagas) {
    assert.equal(vaga[SPOT_COLUMN.sessionId - 1], SUNSET_1730);
    assert.equal(vaga[SPOT_COLUMN.reservationId - 1], RESERVA.id);
    assert.equal(vaga[SPOT_COLUMN.active - 1], ACTIVE_YES);
  }

  // O valor total aparece uma vez só, na primeira vaga — a troca de experiência
  // não pode transformar 630 em 1890 na arrecadação da turma.
  assert.deepEqual(vagas.map((vaga) => vaga[SPOT_COLUMN.totalPaid - 1]), [630, "", ""]);
});

test("18c. as duas turmas são reescritas: a nova pelo snapshot, a antiga pela reconstrução", () => {
  const service = source("lib/integrations/google-sheets/service.ts");
  const helper = service.slice(
    service.indexOf("export async function syncReservationSessionChange"),
    service.indexOf("/** Estado exibido no detalhe da reserva"),
  );
  assert.match(helper, /syncReservationAfterChange\(reservationId, "SESSION_CHANGED"\)/);
  assert.match(helper, /syncSessionList\(previousSessionId\)/);

  // A experiência exibida na planilha vem do bloco da sessão, resolvido pelo
  // `session_id` da própria reserva: mudar o vínculo já muda o que a planilha
  // mostra, sem nenhuma escrita adicional.
  const sheetsSql = statements(source("supabase/migrations/202608180001_google_sheets_sync.sql"));
  assert.match(sheetsSql, /'experienceTitle', e\.title/);
  assert.match(sheetsSql, /join public\.experiences e on e\.id = s\.experience_id/);
  assert.match(sheetsSql, /public\.google_sheets_session_block\(\(reservation ->> 'sessionId'\)::uuid\)/);
});

test("18d. a linha da planilha é chaveada pelo reservation_id, não pela sessão", () => {
  const linha = reservationRow(
    { ...RESERVA, sessionId: SUNSET_1730 },
    TURMA_SUNSET,
    "2026-08-20T13:00:00.000Z",
  );
  assert.equal(linha[RESERVATION_COLUMN.reservationId - 1], RESERVA.id);
  assert.equal(linha.length, RESERVATION_HEADERS.length);
});

// --- 19. E-mail: nenhuma mensagem automática, nenhuma duplicada -------------

test("19. a troca não dispara e-mail, e o de confirmação continua uma-vez-por-reserva", () => {
  // Não existe hoje um e-mail de "sua turma mudou": o único e-mail automático é
  // o de confirmação, disparado uma única vez por reserva na confirmação do
  // pagamento. A troca de turma — inclusive entre experiências — não o
  // redispara, o que também significa que ela não gera e-mail duplicado.
  const data = source("lib/admin/data.ts");
  const body = data.slice(
    data.indexOf("export async function changeAdminReservationSession"),
    data.indexOf("export async function listAdminReservationSessionChanges"),
  );
  assert.doesNotMatch(body, /ConfirmationEmail|sendReservation|deliverReservation/i);

  // E o conteúdo de um reenvio manual é montado no banco a partir da sessão
  // atual da reserva, então ele já sai com a experiência e a data novas.
  const emailSql = statements(source("supabase/migrations/202608190001_reservation_confirmation_email.sql"));
  assert.match(emailSql, /join public\.sessions s on s\.id = r\.session_id/);
  assert.match(emailSql, /join public\.experiences e on e\.id = r\.experience_id/);
});

// --- 20. A migration é aditiva e idempotente --------------------------------

test("20. a migration é aditiva, idempotente e não apaga nada", () => {
  assert.match(MIGRATION, /add column if not exists previous_experience_id/);
  assert.match(MIGRATION, /add column if not exists target_experience_id/);
  assert.match(MIGRATION, /create index if not exists/);

  const executable = statements(MIGRATION);
  assert.doesNotMatch(executable, /drop table|truncate|delete from/i);

  // A única função descartada é a de leitura do histórico, e só porque a
  // assinatura de retorno mudou — ela é recriada na linha seguinte.
  const drops = executable.match(/drop function[^;]+;/g) ?? [];
  assert.deepEqual(drops, ["drop function if exists public.admin_list_reservation_session_changes(uuid, uuid);"]);
  assert.match(executable, /create or replace function public\.admin_list_reservation_session_changes/);

  // Nenhuma função do motor de reservas é reescrita aqui.
  for (const existing of [
    "available_spots",
    "create_pre_reservation",
    "confirm_reservation_payment",
    "admin_confirm_reservation",
    "admin_cancel_reservation",
    "lookup_reservation",
    "admin_get_reservation",
  ]) {
    assert.doesNotMatch(
      executable,
      new RegExp(`create or replace function public\\.${existing}\\b`),
      `${existing} não pode ser reescrita aqui`,
    );
  }
});
