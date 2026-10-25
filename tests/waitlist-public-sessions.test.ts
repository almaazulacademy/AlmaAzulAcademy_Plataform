/**
 * Lista de espera — fase 2: turmas esgotadas no site.
 *
 * Três camadas. As regras de apresentação (`lib/waitlist/public.ts`) são puras
 * e testadas direto. A escolha da fonte (`loadPublicSessions`) e a leitura
 * (`listPublicSessions`) rodam contra o Postgres em memória com todas as
 * migrations, pelo mesmo formato `rpc(nome, argumentos)` do supabase-js. As
 * telas, que o runner do Node não renderiza, são conferidas no código-fonte:
 * nenhum caminho de turma esgotada leva a `/reservar`, e a variável desligada
 * deixa tudo como era.
 *
 * Nenhuma inscrição é criada, nenhum e-mail sai e nada é agendado nesta fase.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import { fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";
import { rescheduleFixtures, type Row } from "./support/reschedule-email-fixtures.ts";
import { getBookingSession, isMissingFunctionError, listOpenSessions, listPublicSessions, SessionListError } from "../lib/reservations/data.ts";
import {
  asOpenSession,
  fewerSpotsMessage,
  isSessionBookable,
  isWaitlistPublicEnabled,
  reservationQuantityOptions,
  resolveReservationConflict,
  SOLD_OUT_LABEL,
} from "../lib/waitlist/public.ts";
import { loadPublicSessions } from "../lib/waitlist/sessions.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** O código sem comentários: o que importa é o que roda. */
function code(path: string) {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "");
}

const db = await fullDatabase();
const admin = createPgliteAdmin(db);
const client = admin.client as unknown as SupabaseClient;
const fx = await rescheduleFixtures(async (sql, params = []) => (await db.query(sql, params)).rows as Row[]);
const { IMERSAO, makeSession, reserve, setStandby, uniquePrice } = fx;

const SLUG = "imersao-paranoa";

const sources = (enabled: boolean, overrides: Partial<Parameters<typeof loadPublicSessions>[1]> = {}) => ({
  enabled,
  listOpen: (slug: string) => listOpenSessions(client, slug),
  listPublic: (slug: string) => listPublicSessions(client, slug),
  ...overrides,
});

const byId = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));

// ===========================================================================
// 1. Regras de apresentação
// ===========================================================================

test("variável: só o valor exato true liga a exibição das esgotadas", () => {
  assert.equal(isWaitlistPublicEnabled({}), false);
  for (const value of ["", "false", "1", "yes", "on", "verdadeiro"]) assert.equal(isWaitlistPublicEnabled({ WAITLIST_PUBLIC_ENABLED: value }), false, value);
  for (const value of ["true", " TRUE ", "True"]) assert.equal(isWaitlistPublicEnabled({ WAITLIST_PUBLIC_ENABLED: value }), true, value);
  assert.equal(isWaitlistPublicEnabled({ NEXT_PUBLIC_WAITLIST_PUBLIC_ENABLED: "true" }), false, "o prefixo público não liga nada");
});

test("reservável só com vaga de verdade, mesmo com marca incoerente", () => {
  assert.equal(isSessionBookable({ soldOut: false, remainingSpots: 3 }), true);
  assert.equal(isSessionBookable({ soldOut: true, remainingSpots: 0 }), false);
  assert.equal(isSessionBookable({ soldOut: true, remainingSpots: 2 }), false, "a marca do banco basta");
  assert.equal(isSessionBookable({ soldOut: false, remainingSpots: 0 }), false, "a contagem também basta");
  assert.equal(SOLD_OUT_LABEL, "Esgotado");
});

test("quantidades do formulário: de 1 até as vagas, no máximo 20; com zero vagas, nenhuma", () => {
  assert.deepEqual(reservationQuantityOptions(0), []);
  assert.deepEqual(reservationQuantityOptions(-3), []);
  assert.deepEqual(reservationQuantityOptions(Number.NaN), []);
  assert.deepEqual(reservationQuantityOptions(1), [1]);
  assert.deepEqual(reservationQuantityOptions(3), [1, 2, 3]);
  assert.equal(reservationQuantityOptions(25).length, 20);
});

test("recusa por falta de vaga: esgotou, sobrou menos ou só a mensagem", () => {
  assert.deepEqual(resolveReservationConflict({ code: "INSUFFICIENT_SPOTS", remainingSpots: 0 }, true), { kind: "SOLD_OUT" });
  assert.deepEqual(resolveReservationConflict({ code: "INSUFFICIENT_SPOTS", remainingSpots: 2 }, true), { kind: "FEWER", remainingSpots: 2 });
  // Variável desligada: exatamente o comportamento de antes, só a mensagem.
  assert.deepEqual(resolveReservationConflict({ code: "INSUFFICIENT_SPOTS", remainingSpots: 0 }, false), { kind: "MESSAGE" });
  for (const payload of [null, "x", {}, { code: "SESSION_UNAVAILABLE" }, { code: "INSUFFICIENT_SPOTS" }, { code: "INSUFFICIENT_SPOTS", remainingSpots: -1 }, { code: "INSUFFICIENT_SPOTS", remainingSpots: 1.5 }]) {
    assert.deepEqual(resolveReservationConflict(payload, true), { kind: "MESSAGE" }, JSON.stringify(payload));
  }
  assert.match(fewerSpotsMessage(1), /resta 1 vaga/);
  assert.match(fewerSpotsMessage(3), /restam 3 vagas/);
});

// ===========================================================================
// 2. Leitura e escolha da fonte, contra o banco
// ===========================================================================

test("desligada: exatamente list_open_sessions — nenhuma esgotada aparece", async () => {
  const withSpots = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 6 });
  await reserve(withSpots, 2);
  const full = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 2 });
  await reserve(full, 2);

  const shown = await loadPublicSessions(SLUG, sources(false));
  const open = await listOpenSessions(client, SLUG);
  assert.deepEqual(byId(shown), byId(open.map(asOpenSession)));
  assert.ok(shown.every((session) => !session.soldOut));
  assert.ok(!shown.some((session) => session.id === full));
  assert.ok(shown.some((session) => session.id === withSpots));
});

test("ligada: as mesmas turmas com vaga, mais as esgotadas marcadas", async () => {
  const withSpots = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 6 });
  await reserve(withSpots, 5);
  const full = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 3 });
  await reserve(full, 3);

  const shown = await loadPublicSessions(SLUG, sources(true));
  const open = await listOpenSessions(client, SLUG);
  assert.deepEqual(byId(shown.filter((session) => !session.soldOut)), byId(open.map(asOpenSession)), "as reserváveis não mudam");

  const soldOut = shown.find((session) => session.id === full);
  assert.ok(soldOut, "a esgotada aparece");
  assert.deepEqual([soldOut.soldOut, soldOut.remainingSpots, isSessionBookable(soldOut)], [true, 0, false]);
  const available = shown.find((session) => session.id === withSpots);
  assert.deepEqual([available?.soldOut, available?.remainingSpots], [false, 1]);

  // Reservar continua impossível: a leitura da página de reserva não muda.
  assert.equal(await getBookingSession(client, full), null);
  assert.ok(await getBookingSession(client, withSpots));
});

test("ligada: vaga devolvida (Stand-by) tira a marca de esgotado na hora", async () => {
  const full = await makeSession(IMERSAO.id, { price: uniquePrice(), capacity: 2 });
  const booking = await reserve(full, 2);
  assert.equal((await loadPublicSessions(SLUG, sources(true))).find((session) => session.id === full)?.soldOut, true);
  await setStandby(booking.id);
  const reopened = (await loadPublicSessions(SLUG, sources(true))).find((session) => session.id === full);
  assert.deepEqual([reopened?.soldOut, reopened?.remainingSpots], [false, 2]);
  assert.equal((await getBookingSession(client, full))?.remainingSpots, 2);
});

test("ligada sem a função no banco: volta para list_open_sessions em vez de derrubar a agenda", async () => {
  const bare = await fullDatabase();
  await bare.exec(`drop function public.list_public_sessions(text)`);
  const bareClient = createPgliteAdmin(bare).client as unknown as SupabaseClient;
  const warnings: string[] = [];
  const shown = await loadPublicSessions(SLUG, {
    enabled: true,
    listOpen: (slug) => listOpenSessions(bareClient, slug),
    listPublic: (slug) => listPublicSessions(bareClient, slug),
    warn: (codeName) => warnings.push(codeName),
  });
  assert.deepEqual(byId(shown), byId((await listOpenSessions(bareClient, SLUG)).map(asOpenSession)));
  assert.deepEqual(warnings, ["LIST_PUBLIC_SESSIONS_MISSING"]);
  await bare.close();
});

test("ligada com outra falha: sobe, como a leitura de sempre", async () => {
  await assert.rejects(
    loadPublicSessions(SLUG, sources(true, { listPublic: async () => { throw new SessionListError("timeout", "57014"); } })),
    /timeout/,
  );
  assert.equal(isMissingFunctionError(new SessionListError("x", "PGRST202")), true);
  assert.equal(isMissingFunctionError(new SessionListError("x", "42883")), true);
  assert.equal(isMissingFunctionError(new SessionListError("statement timeout", "57014")), false);
  assert.equal(isMissingFunctionError(new Error("does not exist")), false, "só o erro da leitura conta");
});

// ===========================================================================
// 3. Telas, no código-fonte
// ===========================================================================

test("grade da experiência: esgotada vira cartão sem link; reservável continua igual", () => {
  const grid = code("components/sessions-section.tsx");
  assert.match(grid, /readPublicSessions\(experienceSlug\)/);
  assert.match(grid, /if \(!isSessionBookable\(session\)\) return <SoldOutSessionCard/);
  const soldOutCard = grid.match(/function SoldOutSessionCard[\s\S]*?\n}\n/)?.[0] ?? "";
  assert.ok(soldOutCard, "SoldOutSessionCard não encontrado");
  assert.doesNotMatch(soldOutCard, /<Link|href=|\/reservar|choice\.href/);
  assert.match(soldOutCard, /<SoldOutNotice/);
  assert.match(soldOutCard, /\{choice\.time\}/, "o horário continua em destaque");
  // O cartão de reserva de sempre.
  assert.match(grid, /href=\{choice\.href\}/);
  assert.match(grid, /Reservar esta turma/);
});

test("destaque de horários e agenda leem a mesma fonte, e a agenda marca Esgotado sem link", () => {
  assert.match(code("components/session-times.tsx"), /readPublicSessions\(experienceSlug\)/);
  const agenda = code("components/agenda-sessions.tsx");
  assert.match(agenda, /const soldOut = !isSessionBookable\(session\)/);
  assert.match(agenda, /soldOut \? SOLD_OUT_LABEL/);
  assert.match(agenda, /\{soldOut \? \(\s*<SoldOutNotice[\s\S]*?\/>\s*\) : \(\s*<Link/);
  const data = code("lib/agenda/data.ts");
  assert.match(data, /enabled: isWaitlistPublicEnabled\(\)/);
  assert.match(data, /listOpen: \(slug\) => listOpenSessions\(client, slug\)/);
});

test("aviso de esgotado: nunca é link de reserva; o botão da lista só aparece com a inscrição ligada (fase 3)", () => {
  const notice = code("components/waitlist/sold-out-notice.tsx");
  assert.doesNotMatch(notice, /<Link|href=|\/reservar|fetch\(|waitlist_join/);
  assert.match(notice, /action\?: ReactNode/);
  for (const path of ["components/sessions-section.tsx", "components/agenda-sessions.tsx", "app/reservar/[sessionId]/page.tsx", "components/reservation/reservation-form.tsx"]) {
    // Fase 3: o lugar é preenchido, mas só com WAITLIST_SIGNUP_ENABLED, e sempre
    // com o link de inscrição — nunca com reserva.
    for (const action of code(path).match(/action=\{[^}]*\}/g) ?? []) {
      assert.match(action, /^action=\{waitlistSignup \? <WaitlistJoinLink/, `${path}: ${action}`);
    }
  }
});

test("página de reserva: formulário só com vaga; esgotada diz Esgotado só com a variável", () => {
  const page = code("app/reservar/[sessionId]/page.tsx");
  assert.match(page, /if \(session && session\.remainingSpots < 1\) session = null;/);
  assert.match(page, /const waitlistEnabled = isWaitlistPublicEnabled\(\);/);
  assert.match(page, /waitlistEnabled && supabase && !session && upcoming && !comingSoon/);
  assert.match(page, /!isSessionBookable\(item\)/);
  assert.match(page, /<ReservationForm session=\{session\} waitlistEnabled=\{waitlistEnabled\} waitlistSignup=\{waitlistSignup\} \/>/);
  // A ordem dos estados: formulário (com vaga), esgotado, em breve, indisponível.
  const order = ["<ReservationForm", ") : soldOut ? (", ") : comingSoon ? (", "Sessão indisponível"].map((marker) => page.indexOf(marker));
  assert.ok(order.every((index) => index > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  const soldOutState = page.slice(order[1], order[2]);
  assert.doesNotMatch(soldOutState, /ReservationForm|\/reservar/);
  assert.match(soldOutState, /<SessionTurma/);
});

test("formulário: nunca sem vaga; corrida entre a página e o envio só muda a tela com a variável", () => {
  const form = code("components/reservation/reservation-form.tsx");
  assert.match(form, /const quantityOptions = reservationQuantityOptions\(spots\);/);
  assert.match(form, /if \(soldOut \|\| quantityOptions\.length === 0\) \{/);
  assert.doesNotMatch(form, /Math\.min\(session\.remainingSpots/);
  assert.match(form, /resolveReservationConflict\(payload, waitlistEnabled\)/);
  assert.match(form, /waitlistEnabled = false/, "desligado por padrão");
  // O envio continua o mesmo: mesma rota, mesma validação, mesma chave.
  assert.match(form, /fetch\("\/api\/reservations", \{ method: "POST"/);
  assert.match(form, /validateReservationInput\(input\)/);
  assert.match(form, /idempotencyKey/);
});

test("API de reserva: recusa por falta de vaga ganha código e vagas atuais; o resto não muda", () => {
  const route = code("app/api/reservations/route.ts");
  assert.match(route, /code: "INSUFFICIENT_SPOTS", message: "Não há vagas suficientes para essa quantidade\."/);
  assert.match(route, /code: "SESSION_UNAVAILABLE", message: "Essa sessão não está mais disponível\."/);
  assert.match(route, /error\.code === "INSUFFICIENT_SPOTS" \? await remainingSpotsNow\(admin, input\.sessionId\)/);
  // As vagas atuais são lidas por get_booking_session, só leitura, e antes de qualquer checkout.
  const helper = route.match(/async function remainingSpotsNow[\s\S]*?\n}\n/)?.[0] ?? "";
  assert.match(helper, /getBookingSession\(client, sessionId\)/);
  assert.doesNotMatch(helper, /rpc\(|createCheckout|insert|update/);
  assert.ok(route.indexOf("remainingSpotsNow(admin") < route.indexOf("provider.createCheckout"));
  assert.match(route, /admin\.rpc\("create_pre_reservation"/);
  assert.match(route, /admin\.rpc\("cancel_pre_reservation"/);
});

test("nada de inscrição, e-mail ou agendamento nesta fase; a variável é só do servidor", () => {
  for (const path of [
    "lib/waitlist/public.ts", "lib/waitlist/sessions.ts", "lib/reservations/session-catalog.ts", "lib/agenda/data.ts",
    "components/sessions-section.tsx", "components/session-times.tsx", "components/agenda-sessions.tsx",
    "components/waitlist/sold-out-notice.tsx", "components/reservation/reservation-form.tsx", "app/reservar/[sessionId]/page.tsx",
  ]) {
    const file = code(path);
    assert.doesNotMatch(file, /waitlist_join|waitlist_cancel|admin_.*waitlist|sendEmail|getEmailProvider|cron/i, path);
    assert.doesNotMatch(file, /NEXT_PUBLIC_WAITLIST/, path);
  }
  assert.doesNotMatch(source("vercel.json"), /waitlist/i);
  assert.match(source(".env.example"), /^# WAITLIST_PUBLIC_ENABLED=true$/m, "documentada e desligada no exemplo");
  // Só o servidor lê a variável: o formulário recebe o valor pronto.
  assert.doesNotMatch(code("components/reservation/reservation-form.tsx"), /process\.env|isWaitlistPublicEnabled/);
});

test("a fase 2 não traz migration: nada no banco muda", () => {
  const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((file) => file.endsWith(".sql")).sort();
  // Depois da fundação (fase 1), só a fila do e-mail de confirmação (fase 3).
  assert.deepEqual(migrations.filter((file) => file > "202610250001_waitlist_foundation.sql"), ["202610250002_waitlist_signup_email.sql"]);
});
