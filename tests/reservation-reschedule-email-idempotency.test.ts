/**
 * E-mail de reagendamento: idempotência no provedor, recuperação rápida e o que
 * o painel diz enquanto o cliente não recebeu.
 *
 * A pergunta de cada cenário é a mesma: **quantas vezes o cliente recebeu?** Por
 * isso o provedor falso segue o contrato documentado da chave de idempotência do
 * Resend — mesma chave e mesmo corpo não entregam de novo, corpo diferente é
 * recusado, e depois de 24 horas a chave deixa de existir — e conta o que
 * chegou a uma caixa de entrada, não quantos pedidos foram feitos.
 *
 * Postgres real em memória (PGlite), com todas as migrations. Nenhum teste fala
 * com o Supabase de produção nem com o Resend; nenhum e-mail é enviado.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { beforeEach } from "node:test";

import { EmailProviderError } from "../lib/email/email-provider.ts";
import { buildReservationRescheduleEmail, parseReservationConfirmationData } from "../lib/reservations/confirmation-email.ts";
import {
  createRescheduleEmailQueue,
  followUpRescheduleEmail,
  parseRescheduleEmailStates,
  parseUndeliveredRescheduleEmails,
  RESCHEDULE_EMAIL_LEASE_MINUTES,
  RESCHEDULE_EMAIL_MAX_ATTEMPTS,
  RESCHEDULE_FOLLOW_UP_ATTEMPTS,
  RESCHEDULE_IDEMPOTENCY_WINDOW_MINUTES,
  RESCHEDULE_RETRY_BACKOFF_SECONDS,
  rescheduleEmailAlert,
  rescheduleRetryAfterSeconds,
  resendRescheduleEmail,
  retryPendingRescheduleEmails,
  sendRescheduleEmailForChange,
  undeliveredRescheduleEmailLabel,
  UNCERTAIN_DELIVERY_NOTE,
  type RescheduleEmailResult,
  type RescheduleEmailRuntime,
} from "../lib/reservations/reschedule-email.ts";
import { fullDatabase } from "./support/full-database.ts";
import { createPgliteAdmin } from "./support/pglite-admin.ts";
import {
  ADMIN,
  fakeResend,
  INSTRUCTOR,
  keyRefused,
  LEASE_MINUTES,
  MAX_ATTEMPTS,
  rescheduleFixtures,
  WINDOW_MINUTES,
  type Query,
  type Row,
} from "./support/reschedule-email-fixtures.ts";

const db = await fullDatabase();
const query: Query = async (sql, params = []) => (await db.query(sql, params)).rows as Row[];

const {
  rows, one, call,
  SUNSET_CONCHA,
  reservation, rescheduled,
  email, attempts,
  claimFor, claimPending, freeze, complete, fail, messageFor, claimAndFreeze,
  expireLease, skipBackoff, ageGeneration, settleQueue,
} = await rescheduleFixtures(query);

beforeEach(settleQueue);

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** A política de produção, com o tempo simulado: cada espera "passa" na hora. */
function createRuntime(options: { registerRejections?: boolean } = {}) {
  const admin = createPgliteAdmin(db);
  const provider = fakeResend(options);
  const waits: number[] = [];
  const logs: Row[] = [];
  const runtime: RescheduleEmailRuntime = {
    queue: createRescheduleEmailQueue(admin.client),
    provider,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      await skipBackoff();
    },
    log: (fields) => { logs.push(fields); },
  };
  return { runtime, provider, admin, waits, logs };
}

/** O que a rota de reagendar faz: a tentativa imediata e, se valer a pena, as duas seguintes. */
async function routeSend(runtime: RescheduleEmailRuntime, changeId: string): Promise<RescheduleEmailResult> {
  const first = await sendRescheduleEmailForChange(runtime, changeId);
  if (first.outcome === "PENDING" && first.retryable !== false) return followUpRescheduleEmail(runtime, changeId);
  return first;
}

/** A rotina, depois de a espera entre tentativas ter passado. */
async function routine(runtime: RescheduleEmailRuntime) {
  await skipBackoff();
  return retryPendingRescheduleEmails(runtime);
}

const keyOf = (emailId: string, generation: number) => `reschedule-confirmation/${emailId}/${generation}`;
const REJECTED_403 = () => new EmailProviderError("HTTP_403", false, "NOT_SENT");
const REJECTED_429 = () => new EmailProviderError("HTTP_429", true, "NOT_SENT");

test("a política dos testes é a de produção", () => {
  assert.equal(MAX_ATTEMPTS, RESCHEDULE_EMAIL_MAX_ATTEMPTS);
  assert.equal(LEASE_MINUTES, RESCHEDULE_EMAIL_LEASE_MINUTES);
  assert.equal(WINDOW_MINUTES, RESCHEDULE_IDEMPOTENCY_WINDOW_MINUTES);
  // A janela da fila é menor que a do provedor: para antes de a chave expirar lá.
  assert.ok(RESCHEDULE_IDEMPOTENCY_WINDOW_MINUTES < 24 * 60);
  // As tentativas automáticas cabem todas dentro da janela.
  const total = RESCHEDULE_RETRY_BACKOFF_SECONDS.reduce((sum, seconds) => sum + seconds, 0);
  assert.ok(total < RESCHEDULE_IDEMPOTENCY_WINDOW_MINUTES * 60);
  assert.equal(RESCHEDULE_RETRY_BACKOFF_SECONDS.length, RESCHEDULE_EMAIL_MAX_ATTEMPTS - 1);
});

// =============================================================================
// 1. Os quatro casos
// =============================================================================

for (const registerRejections of [false, true]) {
  const variant = registerRejections ? "o provedor registra a chave de pedidos recusados" : "o provedor não registra a chave de pedidos recusados";

  test(`falha comprovada do provedor: chave nova e mensagem atualizada na tentativa seguinte (${variant})`, async () => {
    const { booking, emailId, changeId } = await rescheduled({ name: "Marina Albuquerque" });
    const { runtime, provider } = createRuntime({ registerRejections });

    provider.next(REJECTED_403());
    assert.deepEqual(await sendRescheduleEmailForChange(runtime, changeId), { outcome: "PENDING", errorCode: "HTTP_403", retryable: false });
    let row = await email(emailId);
    assert.deepEqual([row.status, row.generation, row.generation_uncertain], ["FAILED", 1, false], "recusa comprovada não é incerteza");
    assert.deepEqual((await attempts(emailId)).map((item) => item.outcome), ["REJECTED"]);
    assert.equal(provider.delivered.length, 0);

    // Entre as tentativas, o cadastro foi corrigido.
    await rows(`update public.reservations set full_name = 'Mariana Albuquerque' where id = $1::uuid`, [booking.id]);

    assert.deepEqual(await routine(runtime), { outcome: "PROCESSED", processed: 1, sent: 1 });
    assert.deepEqual(provider.requests.map((message) => message.idempotencyKey), [keyOf(emailId, 1), keyOf(emailId, 2)], "nada saiu com a primeira chave: a segunda é nova");
    assert.equal(provider.delivered.length, 1, "o cliente recebeu uma vez");
    assert.ok(provider.delivered[0].html.includes("Olá, Mariana!"), "e a mensagem foi montada de novo, com o dado atual");
    row = await email(emailId);
    assert.deepEqual([row.status, row.generation, row.attempts], ["SENT", 2, 2]);
  });
}

test("timeout com o provedor tendo aceitado: a repetição usa a mesma chave e o mesmo corpo, e não entrega de novo", async () => {
  const { emailId, changeId } = await rescheduled();
  const { runtime, provider } = createRuntime();

  provider.next("accepted-then-timeout");
  const first = await sendRescheduleEmailForChange(runtime, changeId);
  assert.deepEqual(first, { outcome: "PENDING", errorCode: "TIMEOUT", retryable: true });
  assert.equal(provider.delivered.length, 1, "o cliente já recebeu — mas o servidor não sabe");

  let row = await email(emailId);
  assert.deepEqual([row.status, row.generation, row.generation_uncertain], ["FAILED", 1, true], "resultado desconhecido não é tratado como não enviado");
  assert.ok(row.frozen_message, "a mensagem exata fica guardada para a repetição");
  assert.deepEqual((await attempts(emailId)).map((item) => [item.outcome, item.error_code]), [["UNKNOWN", "TIMEOUT"]]);

  assert.deepEqual(await followUpRescheduleEmail(runtime, changeId), { outcome: "SENT" });
  assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests[1].idempotencyKey, provider.requests[0].idempotencyKey);
  assert.equal(provider.requests[1].idempotencyKey, keyOf(emailId, 1));
  assert.deepEqual(
    { to: provider.requests[1].to, subject: provider.requests[1].subject, html: provider.requests[1].html, text: provider.requests[1].text },
    { to: provider.requests[0].to, subject: provider.requests[0].subject, html: provider.requests[0].html, text: provider.requests[0].text },
  );
  assert.equal(provider.delivered.length, 1, "o cliente recebeu UMA vez");

  row = await email(emailId);
  assert.deepEqual([row.status, row.generation, row.attempts, row.frozen_message], ["SENT", 1, 2, null]);
  assert.deepEqual((await attempts(emailId)).map((item) => [item.generation, item.outcome]), [[1, "UNKNOWN"], [1, "SENT"]]);
});

test("timeout com o pedido perdido no caminho: a repetição entrega — uma vez", async () => {
  const { emailId, changeId } = await rescheduled();
  const { runtime, provider } = createRuntime();

  provider.next("lost");
  assert.deepEqual(await routeSend(runtime, changeId), { outcome: "SENT" });

  assert.equal(provider.requests.length, 2);
  assert.deepEqual(provider.requests.map((message) => message.idempotencyKey), [keyOf(emailId, 1), keyOf(emailId, 1)]);
  assert.equal(provider.delivered.length, 1);
  assert.equal((await email(emailId)).status, "SENT");
});

test("5xx depois de o provedor ter aceitado também é resultado desconhecido", async () => {
  const { emailId, changeId } = await rescheduled();
  const { runtime, provider } = createRuntime();

  provider.next("accepted-then-500");
  assert.deepEqual(await routeSend(runtime, changeId), { outcome: "SENT" });
  assert.equal(provider.delivered.length, 1);
  assert.deepEqual((await attempts(emailId)).map((item) => [item.outcome, item.error_code]), [["UNKNOWN", "HTTP_500"], ["SENT", null]]);
});

test("provedor aceitou e o banco falhou ao registrar: nunca vira falha, e a repetição é deduplicada", async () => {
  const { emailId, changeId } = await rescheduled();
  const { runtime, provider, admin, logs } = createRuntime();

  admin.failRpc("complete_reservation_reschedule_email", { message: "connection reset" }, 3);
  assert.deepEqual(await sendRescheduleEmailForChange(runtime, changeId), { outcome: "SENT", errorCode: "SENT_NOT_RECORDED" });
  assert.equal(provider.delivered.length, 1);
  assert.equal(admin.calls.rpc.filter((name) => name === "complete_reservation_reschedule_email").length, 3, "o registro é repetido");
  assert.ok(!admin.calls.rpc.includes("fail_reservation_reschedule_email"), "um envio aceito nunca é devolvido à fila como falha");
  assert.ok(logs.some((entry) => entry.errorCode === "SENT_NOT_RECORDED" && entry.outcome === "failed"), "o estado ambíguo vai para o log de erro");

  let row = await email(emailId);
  assert.equal(row.status, "SENDING", "fica reivindicado até o prazo vencer");
  assert.deepEqual(await routine(runtime), { outcome: "PROCESSED", processed: 0, sent: 0 });
  assert.equal(provider.requests.length, 1);

  // Prazo vencido: para a fila, a tentativa tem resultado desconhecido. A
  // repetição vai com a mesma chave e o mesmo corpo, e o provedor não entrega.
  await expireLease(emailId);
  assert.deepEqual(await routine(runtime), { outcome: "PROCESSED", processed: 1, sent: 1 });
  assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests[1].idempotencyKey, provider.requests[0].idempotencyKey);
  assert.equal(provider.requests[1].html, provider.requests[0].html);
  assert.equal(provider.delivered.length, 1, "o cliente recebeu UMA vez");
  row = await email(emailId);
  assert.equal(row.status, "SENT");
  assert.deepEqual((await attempts(emailId)).map((item) => [item.generation, item.outcome]), [[1, "LEASE_EXPIRED"], [1, "SENT"]]);
});

test("alteração legítima do endereço: é outra entrega, com chave própria — e o endereço novo recebe uma vez", async () => {
  // a) Resultado desconhecido para o endereço antigo; depois o cadastro é corrigido.
  const unknown = await rescheduled();
  const { runtime, provider } = createRuntime();
  provider.next("accepted-then-timeout");
  await sendRescheduleEmailForChange(runtime, unknown.changeId);
  await rows(`update public.reservations set email = 'correto@teste.local' where id = $1::uuid`, [unknown.booking.id]);

  assert.deepEqual(await routine(runtime), { outcome: "PROCESSED", processed: 1, sent: 1 });
  assert.deepEqual(provider.requests.map((message) => [message.to, message.idempotencyKey]), [
    [unknown.booking.email, keyOf(unknown.emailId, 1)],
    ["correto@teste.local", keyOf(unknown.emailId, 2)],
  ]);
  assert.equal(provider.deliveredTo("correto@teste.local").length, 1, "o endereço certo recebe uma vez");
  // Repetir a rotina, o painel ou a requisição não manda outro.
  await routine(runtime);
  await resendRescheduleEmail(runtime, ADMIN, unknown.booking.id);
  await sendRescheduleEmailForChange(runtime, unknown.changeId);
  assert.equal(provider.deliveredTo("correto@teste.local").length, 1);
  assert.equal(provider.requests.length, 2);

  // b) Recusa comprovada (endereço inválido), cadastro corrigido.
  const rejected = await rescheduled();
  const second = createRuntime();
  second.provider.next(new EmailProviderError("HTTP_422", false, "NOT_SENT"));
  await sendRescheduleEmailForChange(second.runtime, rejected.changeId);
  await rows(`update public.reservations set email = 'valido@teste.local' where id = $1::uuid`, [rejected.booking.id]);
  assert.deepEqual(await routine(second.runtime), { outcome: "PROCESSED", processed: 1, sent: 1 });
  assert.equal(second.provider.delivered.length, 1);
  assert.equal(second.provider.delivered[0].to, "valido@teste.local");

  // c) Já enviado: trocar o endereço depois não dispara nada sozinho.
  const sent = await rescheduled();
  const third = createRuntime();
  assert.deepEqual(await sendRescheduleEmailForChange(third.runtime, sent.changeId), { outcome: "SENT" });
  await rows(`update public.reservations set email = 'depois@teste.local' where id = $1::uuid`, [sent.booking.id]);
  assert.deepEqual(await routine(third.runtime), { outcome: "PROCESSED", processed: 0, sent: 0 });
  assert.deepEqual(await resendRescheduleEmail(third.runtime, ADMIN, sent.booking.id), { outcome: "SKIPPED" });
  assert.equal(third.provider.requests.length, 1);
});

// =============================================================================
// 2. Mudanças no payload entre tentativas
// =============================================================================

test("nome do cliente ou template mudam entre tentativas com resultado desconhecido: vai a mesma mensagem, byte a byte", async () => {
  const { booking, emailId, changeId } = await rescheduled({ name: "Marina Albuquerque" });
  const { runtime, provider } = createRuntime();

  provider.next("accepted-then-timeout");
  await sendRescheduleEmailForChange(runtime, changeId);
  const frozen = (await email(emailId)).frozen_message;

  // O nome é corrigido. Uma renderização nova já não seria igual à que foi enviada —
  // o mesmo que acontece quando um deploy muda o template entre as duas tentativas.
  await rows(`update public.reservations set full_name = 'Mariana Albuquerque' where id = $1::uuid`, [booking.id]);
  const fresh = buildReservationRescheduleEmail(parseReservationConfirmationData(
    await call(`public.reservation_confirmation_email($1::uuid)`, [booking.id]),
  )!);
  assert.notEqual(fresh.html, frozen.html, "uma renderização nova teria outro corpo");
  assert.ok(fresh.html.includes("Olá, Mariana!") && frozen.html.includes("Olá, Marina!"));

  assert.deepEqual(await routine(runtime), { outcome: "PROCESSED", processed: 1, sent: 1 });

  // O que foi para o provedor na repetição é a mensagem guardada, não a nova.
  assert.equal(provider.requests[1].idempotencyKey, keyOf(emailId, 1));
  assert.equal(provider.requests[1].html, provider.requests[0].html);
  assert.equal(provider.requests[1].text, provider.requests[0].text);
  assert.equal(provider.requests[1].subject, provider.requests[0].subject);
  assert.equal(provider.requests[1].html, frozen.html);
  assert.equal(provider.delivered.length, 1, "o cliente recebeu UMA vez");
  assert.equal((await email(emailId)).generation, 1, "a chave não mudou");
});

test("o que conta como outra entrega: destinatário e dados da turma — não o nome, o telefone ou as observações", async () => {
  const { booking, destination, emailId } = await rescheduled();
  const fingerprint = () => call(`public.reservation_reschedule_email_fingerprint($1::uuid)`, [emailId]);
  const original = await fingerprint();
  assert.match(original, /^[0-9a-f]{32}$/);

  const reservationBefore = await reservation(booking.id);
  const sessionBefore = await one(`select * from public.sessions where id = $1::uuid`, [destination]);
  const baseBefore = await one(`select * from public.bases where id = $1::uuid`, [SUNSET_CONCHA.base_id]);
  const experienceBefore = await one(`select * from public.experiences where id = $1::uuid`, [SUNSET_CONCHA.id]);

  // Não mudam a entrega.
  await rows(`update public.reservations set full_name = 'Outro Nome', phone = '+5561900000000', notes = 'observação' where id = $1::uuid`, [booking.id]);
  await rows(`update public.sessions set capacity = capacity + 5 where id = $1::uuid`, [destination]);
  assert.equal(await fingerprint(), original, "nome, telefone, observações e capacidade não mudam a entrega");
  await db.query(`set time zone 'America/Sao_Paulo'`);
  assert.equal(await fingerprint(), original, "o fuso da conexão não muda o resumo");
  await db.query(`set time zone 'UTC'`);
  // E-mail com outra caixa ou espaços é o mesmo endereço.
  await rows(`update public.reservations set email = $2 where id = $1::uuid`, [booking.id, `  ${booking.email.toUpperCase()} `]);
  assert.equal(await fingerprint(), original);

  // Mudam: cada um destes, sozinho, faz do e-mail outra entrega.
  const changes: Array<[string, string, unknown[], string, unknown[]]> = [
    ["destinatário", `update public.reservations set email = 'novo@teste.local' where id = $1::uuid`, [booking.id], `update public.reservations set email = $2 where id = $1::uuid`, [booking.id, reservationBefore.email]],
    ["horário da turma", `update public.sessions set starts_at = starts_at + interval '1 hour' where id = $1::uuid`, [destination], `update public.sessions set starts_at = $2 where id = $1::uuid`, [destination, sessionBefore.starts_at]],
    ["endereço da base", `update public.bases set address = 'Outro endereço' where id = $1::uuid`, [SUNSET_CONCHA.base_id], `update public.bases set address = $2 where id = $1::uuid`, [SUNSET_CONCHA.base_id, baseBefore.address]],
    ["ponto de encontro", `update public.bases set meeting_point = 'Outro ponto' where id = $1::uuid`, [SUNSET_CONCHA.base_id], `update public.bases set meeting_point = $2 where id = $1::uuid`, [SUNSET_CONCHA.base_id, baseBefore.meeting_point]],
    ["link do mapa", `update public.bases set maps_url = 'https://maps.app.goo.gl/outro' where id = $1::uuid`, [SUNSET_CONCHA.base_id], `update public.bases set maps_url = $2 where id = $1::uuid`, [SUNSET_CONCHA.base_id, baseBefore.maps_url]],
    ["nome da experiência", `update public.experiences set title = 'Outro título' where id = $1::uuid`, [SUNSET_CONCHA.id], `update public.experiences set title = $2 where id = $1::uuid`, [SUNSET_CONCHA.id, experienceBefore.title]],
  ];
  for (const [label, apply, applyParams, undo, undoParams] of changes) {
    await rows(apply, applyParams);
    assert.notEqual(await fingerprint(), original, label);
    await rows(undo, undoParams);
    assert.equal(await fingerprint(), original, `${label}: desfeito`);
  }
});

test("o horário da turma muda entre tentativas com resultado desconhecido: sai uma correção, com chave nova", async () => {
  const { destination, emailId, changeId } = await rescheduled();
  const { runtime, provider } = createRuntime();

  provider.next("accepted-then-timeout");
  await sendRescheduleEmailForChange(runtime, changeId);
  assert.equal(provider.delivered.length, 1);

  // A equipe corrige o horário da turma. Repetir a mensagem guardada informaria o horário errado.
  await rows(`update public.sessions set starts_at = starts_at + interval '90 minutes' where id = $1::uuid`, [destination]);

  assert.deepEqual(await routine(runtime), { outcome: "PROCESSED", processed: 1, sent: 1 });
  assert.deepEqual(provider.requests.map((message) => message.idempotencyKey), [keyOf(emailId, 1), keyOf(emailId, 2)]);
  assert.notEqual(provider.requests[1].html, provider.requests[0].html, "a segunda mensagem traz o horário corrigido");
  // Duas entregas, e de propósito: a segunda corrige o que a primeira informou.
  assert.equal(provider.delivered.length, 2);
  const row = await email(emailId);
  assert.deepEqual([row.status, row.generation, row.generation_uncertain], ["SENT", 2, false]);
});

test("uma recusa comprovada no meio não apaga a incerteza da tentativa anterior", async () => {
  const { emailId, changeId } = await rescheduled();
  const { runtime, provider } = createRuntime();

  // 1ª: aceita, sem resposta. 2ª: limite de taxa — recusada, e não diz nada sobre a 1ª.
  provider.next("accepted-then-timeout", REJECTED_429());
  assert.deepEqual(await routeSend(runtime, changeId), { outcome: "SENT" });

  assert.deepEqual(provider.requests.map((message) => message.idempotencyKey), [keyOf(emailId, 1), keyOf(emailId, 1), keyOf(emailId, 1)], "a chave não muda enquanto houver resultado desconhecido");
  assert.equal(provider.delivered.length, 1, "o cliente recebeu UMA vez");
  assert.deepEqual((await attempts(emailId)).map((item) => [item.generation, item.outcome]), [[1, "UNKNOWN"], [1, "REJECTED"], [1, "SENT"]]);
});

test("pedido ainda em curso no provedor (409): repete a mesma chave depois, sem entregar de novo", async () => {
  const { emailId, changeId } = await rescheduled();
  const { runtime, provider } = createRuntime();

  provider.next("accepted-then-timeout", "in-progress");
  assert.deepEqual(await routeSend(runtime, changeId), { outcome: "SENT" });

  assert.equal(provider.delivered.length, 1);
  assert.deepEqual((await attempts(emailId)).map((item) => [item.generation, item.outcome, item.error_code]), [
    [1, "UNKNOWN", "TIMEOUT"], [1, "KEY_REFUSED", "HTTP_409"], [1, "SENT", null],
  ]);
  // Uma recusa só não é conflito: o e-mail nunca saiu da fila automática.
  assert.equal((await email(emailId)).status, "SENT");
});

test("chave recusada duas vezes pelo provedor (409): é conflito — ninguém reenvia sozinho; só uma pessoa, e fica na auditoria", async () => {
  const { booking, emailId, changeId } = await rescheduled();
  const { runtime, provider } = createRuntime();

  provider.next("accepted-then-timeout");
  await sendRescheduleEmailForChange(runtime, changeId);
  // O corpo do pedido já não é o que o provedor viu — o remetente configurado
  // mudou entre as tentativas, por exemplo. A mesma chave passa a ser recusada.
  await rows(`update public.reservation_reschedule_emails set frozen_message = jsonb_set(frozen_message, '{html}', '"<p>outro corpo</p>"') where id = $1::uuid`, [emailId]);

  // As duas tentativas em segundo plano: a primeira recusa pode ser um pedido
  // ainda em curso, e vale repetir; a segunda já não é.
  assert.deepEqual(await followUpRescheduleEmail(runtime, changeId), { outcome: "PENDING", errorCode: "HTTP_409", retryable: true });
  assert.equal(provider.requests.length, 3);
  assert.equal(provider.delivered.length, 1);
  assert.deepEqual((await attempts(emailId)).map((item) => [item.generation, item.outcome, item.error_code]), [
    [1, "UNKNOWN", "TIMEOUT"], [1, "KEY_REFUSED", "HTTP_409"], [1, "KEY_REFUSED", "HTTP_409"],
  ]);

  let row = await email(emailId);
  assert.deepEqual([row.status, row.last_error_code, row.next_attempt_at, row.frozen_message], ["UNCERTAIN", "IDEMPOTENCY_CONFLICT", null, null]);

  // Nada automático toca nele.
  assert.deepEqual(await routine(runtime), { outcome: "PROCESSED", processed: 0, sent: 0 });
  assert.equal(await claimFor(changeId), null);
  assert.deepEqual(await claimPending(), []);
  assert.deepEqual(await followUpRescheduleEmail(runtime, changeId), { outcome: "SKIPPED" });
  assert.equal(provider.requests.length, 3);
  assert.equal((await email(emailId)).attempts, 3);

  // Nem uma pessoa pedindo, sem aceitar o risco de duplicidade.
  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, booking.id), { outcome: "NEEDS_CONFIRMATION" });
  assert.equal(provider.requests.length, 3);
  assert.equal((await email(emailId)).attempts, 3);

  // Com o aceite: chave nova, mensagem nova.
  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, booking.id, { acceptUncertain: true }), { outcome: "SENT" });
  assert.equal(provider.requests[3].idempotencyKey, keyOf(emailId, 2));
  row = await email(emailId);
  assert.deepEqual([row.status, row.generation], ["SENT", 2]);
  const [audit] = await rows(`select metadata from public.admin_audit_log where action = 'RESERVATION_RESCHEDULE_EMAIL_RESEND' and entity_id = $1::uuid`, [booking.id]);
  assert.deepEqual(audit.metadata, { emailId, attempt: 4, generation: 2, previousStatus: "UNCERTAIN", acceptedDuplicateRisk: true });
});

test("a segunda recusa só conta na mesma chave: em gerações diferentes, cada uma começa do zero", async () => {
  const { booking, emailId, changeId } = await rescheduled();

  const first = await claimAndFreeze(changeId, booking.id);
  await fail(emailId, first.claimToken, "HTTP_409", "KEY_REFUSED");
  assert.equal((await email(emailId)).status, "FAILED");

  // O destinatário muda: outra entrega, outra chave.
  await rows(`update public.reservations set email = 'outro@teste.local' where id = $1::uuid`, [booking.id]);
  const second = await claimAndFreeze(changeId, booking.id);
  assert.equal(second.generation, 2);
  await fail(emailId, second.claimToken, "HTTP_409", "KEY_REFUSED");
  assert.equal((await email(emailId)).status, "FAILED", "primeira recusa desta chave");

  const third = await claimFor(changeId);
  assert.equal(third.generation, 2);
  await fail(emailId, third.claimToken, "HTTP_409", "KEY_REFUSED");
  assert.deepEqual([(await email(emailId)).status, (await email(emailId)).last_error_code], ["UNCERTAIN", "IDEMPOTENCY_CONFLICT"]);
  // A falha tardia de uma tentativa que já não é a atual não leva o e-mail para UNCERTAIN.
  assert.equal(keyRefused().delivery, "KEY_REFUSED");
});

// =============================================================================
// 3. A janela de idempotência
// =============================================================================

test("dentro da janela a repetição reusa a chave; perto do fim, ainda dentro, também", async () => {
  const { emailId, changeId } = await rescheduled();
  const { runtime, provider } = createRuntime();

  provider.next("accepted-then-timeout");
  await sendRescheduleEmailForChange(runtime, changeId);

  // 22 horas depois — a rotina do dia seguinte, por exemplo.
  await ageGeneration(emailId, "22 hours");
  provider.advance(22);
  assert.deepEqual(await routine(runtime), { outcome: "PROCESSED", processed: 1, sent: 1 });
  assert.equal(provider.requests[1].idempotencyKey, keyOf(emailId, 1));
  assert.equal(provider.delivered.length, 1, "o provedor ainda guarda a chave: UMA entrega");
});

test("janela vencida com resultado desconhecido: a fila para em vez de reenviar às cegas", async () => {
  const { booking, emailId, changeId } = await rescheduled();
  const { runtime, provider } = createRuntime();

  provider.next("accepted-then-timeout");
  await sendRescheduleEmailForChange(runtime, changeId);
  const message = provider.requests[0];
  assert.equal(provider.delivered.length, 1);

  // Passou mais de 23 horas sem a repetição acontecer.
  await ageGeneration(emailId, "23 hours 1 minute");
  provider.advance(24.5);

  assert.deepEqual(await routine(runtime), { outcome: "PROCESSED", processed: 0, sent: 0 });
  let row = await email(emailId);
  assert.deepEqual([row.status, row.last_error_code, row.frozen_message, row.next_attempt_at], ["UNCERTAIN", "IDEMPOTENCY_WINDOW_EXPIRED", null, null]);
  assert.equal(row.attempts, 1, "nenhuma tentativa foi gasta");
  assert.equal(provider.requests.length, 1, "nenhum pedido foi feito ao provedor");

  // Nem a rotina de novo, nem a requisição repetida, nem as tentativas em segundo plano.
  assert.deepEqual(await routine(runtime), { outcome: "PROCESSED", processed: 0, sent: 0 });
  assert.deepEqual(await sendRescheduleEmailForChange(runtime, changeId), { outcome: "SKIPPED" });
  assert.deepEqual(await followUpRescheduleEmail(runtime, changeId), { outcome: "SKIPPED" });
  assert.equal(provider.requests.length, 1);

  // Por que parar: com a chave expirada no provedor, a mesma mensagem com a
  // mesma chave já não é reconhecida — seria entregue como um e-mail novo.
  const control = fakeResend();
  await control.send(message);
  control.advance(24.5);
  await control.send(message);
  assert.equal(control.delivered.length, 2, "depois de 24 horas o provedor não deduplica mais");

  // O painel diz exatamente isso, e o reenvio é uma decisão de uma pessoa.
  const [state] = parseRescheduleEmailStates(await call(`public.admin_reservation_reschedule_emails($1::uuid, $2::uuid)`, [ADMIN, booking.id]));
  assert.equal(state.status, "UNCERTAIN");
  assert.deepEqual(rescheduleEmailAlert(state, String), {
    title: "Não sabemos se o cliente recebeu a confirmação do reagendamento",
    description: UNCERTAIN_DELIVERY_NOTE,
  });

  // Um clique sem o aceite não envia: o banco exige que a pessoa tenha visto o aviso.
  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, booking.id), { outcome: "NEEDS_CONFIRMATION" });
  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, booking.id, { acceptUncertain: false }), { outcome: "NEEDS_CONFIRMATION" });
  assert.equal(provider.requests.length, 1);
  assert.equal((await rows(`select 1 from public.admin_audit_log where action = 'RESERVATION_RESCHEDULE_EMAIL_RESEND' and entity_id = $1::uuid`, [booking.id])).length, 0);

  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, booking.id, { acceptUncertain: true }), { outcome: "SENT" });
  assert.equal(provider.requests[1].idempotencyKey, keyOf(emailId, 2), "chave nova: a anterior já não protege nada");
  row = await email(emailId);
  assert.deepEqual([row.status, row.generation, row.attempts], ["SENT", 2, 2]);
  const [audit] = await rows(`select actor_user_id, metadata from public.admin_audit_log where action = 'RESERVATION_RESCHEDULE_EMAIL_RESEND' and entity_id = $1::uuid`, [booking.id]);
  assert.equal(audit.actor_user_id, ADMIN);
  assert.deepEqual([audit.metadata.previousStatus, audit.metadata.acceptedDuplicateRisk], ["UNCERTAIN", true]);
});

test("tentativas esgotadas com resultado desconhecido e janela vencida: o painel ainda dizia 'falhou' — e o reenvio não sai sem o aceite", async () => {
  const { booking, emailId, changeId } = await rescheduled({ startsIn: "20 days" });
  const { runtime, provider } = createRuntime();

  // O provedor aceitou a primeira e nunca respondeu; as outras cinco deram 503.
  provider.next("accepted-then-timeout", ...Array.from({ length: MAX_ATTEMPTS - 1 }, () => new EmailProviderError("HTTP_503", true, "UNKNOWN")));
  await sendRescheduleEmailForChange(runtime, changeId);
  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) await routine(runtime);
  assert.equal(provider.delivered.length, 1, "o cliente já recebeu — e ninguém sabe");
  let row = await email(emailId);
  assert.deepEqual([row.status, row.attempts, row.generation_uncertain], ["FAILED", MAX_ATTEMPTS, true]);

  // Um dia depois. Nada automático toca num e-mail esgotado, então ele continua
  // "falhou" — e é assim que o painel o mostra, com o botão de reenvio comum.
  await ageGeneration(emailId, "25 hours");
  provider.advance(25);
  assert.deepEqual(await routine(runtime), { outcome: "PROCESSED", processed: 0, sent: 0 });
  const [state] = parseRescheduleEmailStates(await call(`public.admin_reservation_reschedule_emails($1::uuid, $2::uuid)`, [ADMIN, booking.id]));
  assert.equal(state.status, "FAILED");

  // O clique nesse botão não manda aceite. O banco percebe que a entrega não foi
  // confirmada e que o provedor já não deduplica: não envia, e passa a dizer isso.
  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, booking.id), { outcome: "NEEDS_CONFIRMATION" });
  assert.equal(provider.requests.length, MAX_ATTEMPTS, "nenhum pedido novo ao provedor");
  row = await email(emailId);
  assert.deepEqual([row.status, row.last_error_code, row.attempts, row.frozen_message], ["UNCERTAIN", "IDEMPOTENCY_WINDOW_EXPIRED", MAX_ATTEMPTS, null]);
  assert.equal((await rows(`select 1 from public.admin_audit_log where action = 'RESERVATION_RESCHEDULE_EMAIL_RESEND' and entity_id = $1::uuid`, [booking.id])).length, 0);
  // Repetir o clique não muda nada.
  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, booking.id), { outcome: "NEEDS_CONFIRMATION" });
  assert.equal(provider.requests.length, MAX_ATTEMPTS);

  // Só com o aceite — que o painel só manda depois do aviso — o e-mail sai, com chave nova.
  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, booking.id, { acceptUncertain: true }), { outcome: "SENT" });
  assert.equal(provider.requests.at(-1)!.idempotencyKey, keyOf(emailId, 2));
  assert.equal(provider.delivered.length, 2, "o risco aceito: o cliente recebeu de novo");
  const [audit] = await rows(`select metadata from public.admin_audit_log where action = 'RESERVATION_RESCHEDULE_EMAIL_RESEND' and entity_id = $1::uuid`, [booking.id]);
  assert.deepEqual([audit.metadata.previousStatus, audit.metadata.acceptedDuplicateRisk], ["UNCERTAIN", true]);
});

test("o aceite do risco não contorna nenhuma outra regra", async () => {
  const { runtime, provider } = createRuntime();

  // Dentro da janela, o aceite é irrelevante: a repetição reusa a chave e o provedor deduplica.
  const inside = await rescheduled();
  provider.next("accepted-then-timeout");
  await sendRescheduleEmailForChange(runtime, inside.changeId);
  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, inside.booking.id, { acceptUncertain: true }), { outcome: "SENT" });
  assert.equal(provider.requests.at(-1)!.idempotencyKey, keyOf(inside.emailId, 1));
  assert.equal(provider.deliveredTo(inside.booking.email).length, 1);

  // Enviado continua enviado.
  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, inside.booking.id, { acceptUncertain: true }), { outcome: "SKIPPED" });

  // Reserva cancelada não recebe, com ou sem aceite.
  const cancelled = await rescheduled();
  provider.next("accepted-then-timeout");
  await sendRescheduleEmailForChange(runtime, cancelled.changeId);
  await ageGeneration(cancelled.emailId, "25 hours");
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Cliente desistiu')`, [ADMIN, cancelled.booking.id]);
  const before = provider.requests.length;
  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, cancelled.booking.id, { acceptUncertain: true }), { outcome: "SKIPPED" });
  assert.equal(provider.requests.length, before);
  assert.equal((await email(cancelled.emailId)).status, "SKIPPED");

  // Envio em curso não é atropelado, nem com aceite.
  const flying = await rescheduled();
  await claimFor(flying.changeId);
  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, flying.booking.id, { acceptUncertain: true }), { outcome: "SKIPPED" });

  // E só a equipe: o aceite não substitui a autorização.
  const refused = await rescheduled();
  await assert.rejects(call(`public.admin_claim_reservation_reschedule_email($1::uuid, $2::uuid, 2, 1380, true)`, [INSTRUCTOR, refused.booking.id]), /ADMIN_FORBIDDEN/);
});

test("janela vencida sem incerteza não bloqueia nada: só recusas comprovadas, ou fila nunca tentada", async () => {
  // a) Só recusas: nada pode ter saído. Mesmo dias depois, segue normalmente.
  const rejected = await rescheduled({ startsIn: "30 days" });
  const { runtime, provider } = createRuntime();
  provider.next(REJECTED_403());
  await sendRescheduleEmailForChange(runtime, rejected.changeId);
  await ageGeneration(rejected.emailId, "5 days");
  provider.advance(120);
  assert.deepEqual(await routine(runtime), { outcome: "PROCESSED", processed: 1, sent: 1 });
  assert.equal((await email(rejected.emailId)).status, "SENT");
  assert.equal(provider.delivered.length, 1);

  // b) Nunca tentado (e-mail desligado na época): não há chave em uso.
  const queued = await rescheduled({ startsIn: "30 days" });
  await rows(`update public.reservation_reschedule_emails set created_at = now() - interval '5 days' where id = $1::uuid`, [queued.emailId]);
  assert.deepEqual(await routine(runtime), { outcome: "PROCESSED", processed: 1, sent: 1 });
  assert.equal((await email(queued.emailId)).status, "SENT");
});

test("prazo vencido antes de a mensagem ser guardada não é incerteza: nada foi enviado", async () => {
  const { emailId, changeId } = await rescheduled();

  // A instância morreu entre reivindicar e guardar a mensagem: o envio nem começou.
  const lost = await claimFor(changeId);
  assert.equal(lost.message, null);
  await expireLease(emailId);

  const next = await claimFor(changeId);
  assert.deepEqual([next.attempt, next.generation, next.message], [2, 2, null], "geração nova, sem nada a repetir");
  const row = await email(emailId);
  assert.equal(row.generation_uncertain, false);
  assert.deepEqual((await attempts(emailId)).map((item) => [item.generation, item.outcome]), [[1, "LEASE_EXPIRED"], [2, null]]);
});

test("a mensagem só é guardada pela tentativa em curso, uma vez, e só para o e-mail da reserva", async () => {
  const { booking, emailId, changeId } = await rescheduled();
  const message = await messageFor(booking.id);
  const claim = await claimFor(changeId);

  // Formato: os quatro campos, preenchidos.
  for (const broken of [null, {}, { ...message, to: "" }, { ...message, html: "" }, { ...message, text: undefined }, { to: message.to, subject: "s" }]) {
    assert.equal(await freeze(emailId, claim.claimToken, broken as Row | null), false, JSON.stringify(broken));
  }
  // Destinatário: só o e-mail cadastrado na reserva. A aplicação não tem como
  // fazer a fila escrever para outro endereço.
  assert.equal(await freeze(emailId, claim.claimToken, { ...message, to: "outro@exemplo.com" }), false);
  assert.equal((await email(emailId)).frozen_message, null);

  // Campos a mais não são guardados.
  assert.equal(await freeze(emailId, claim.claimToken, { ...message, bcc: "espiao@exemplo.com", to: `  ${message.to.toUpperCase()} ` }), true);
  assert.deepEqual(Object.keys((await email(emailId)).frozen_message).sort(), ["html", "subject", "text", "to"]);
  // Uma vez só por geração.
  assert.equal(await freeze(emailId, claim.claimToken, { ...message, html: "<p>outra</p>" }), false);

  // Resultado desconhecido → a próxima reivindicação devolve exatamente o que foi guardado.
  await fail(emailId, claim.claimToken, "TIMEOUT", "UNKNOWN");
  const retry = await claimFor(changeId);
  assert.equal(retry.generation, 1);
  assert.deepEqual(retry.message, (await email(emailId)).frozen_message);
  assert.equal(retry.message.html, message.html);
  // A tentativa antiga não guarda mais nada, e a nova não substitui o que existe.
  assert.equal(await freeze(emailId, claim.claimToken, message), false);
  assert.equal(await freeze(emailId, retry.claimToken, { ...message, html: "<p>outra</p>" }), false);

  // Concluído: a mensagem some, e ninguém guarda outra.
  assert.equal(await complete(emailId, retry.claimToken), true);
  assert.equal((await email(emailId)).frozen_message, null);
  assert.equal(await freeze(emailId, retry.claimToken, message), false);

  // Nada da mensagem aparece para o painel.
  const state = JSON.stringify(await call(`public.admin_reservation_reschedule_emails($1::uuid, $2::uuid)`, [ADMIN, booking.id]));
  assert.ok(!state.includes(booking.email) && !state.includes("frozen") && !state.includes("claimToken"));
});

test("o que o banco aceita como resultado: na dúvida, desconhecido — nunca 'não enviado'", async () => {
  for (const [given, outcome, uncertain] of [["REJECTED", "REJECTED", false], ["rejected ", "REJECTED", false], ["UNKNOWN", "UNKNOWN", true], ["KEY_REFUSED", "KEY_REFUSED", true], ["", "UNKNOWN", true], ["qualquer coisa", "UNKNOWN", true]] as const) {
    const { booking, emailId, changeId } = await rescheduled();
    const claim = await claimAndFreeze(changeId, booking.id);
    assert.equal(await fail(emailId, claim.claimToken, "HTTP_500", given), true);
    assert.equal((await attempts(emailId))[0].outcome, outcome, JSON.stringify(given));
    assert.equal((await email(emailId)).generation_uncertain, uncertain, JSON.stringify(given));
  }
  // O tipo do TypeScript também não tem "não enviado" como padrão.
  assert.match(source("lib/email/email-provider.ts"), /constructor\(causeCode: string, retryable: boolean, delivery: EmailDelivery = "UNKNOWN"\)/);
  assert.match(source("lib/email/email-provider.ts"), /return error instanceof EmailProviderError \? error\.delivery : "UNKNOWN";/);
});

// =============================================================================
// 4. Recuperação rápida
// =============================================================================

test("falha passageira: mais duas tentativas na própria requisição, sem esperar a rotina", async () => {
  const { emailId, changeId } = await rescheduled();
  const { runtime, provider, waits } = createRuntime();
  const waitingFor: number[] = [];
  const instantSkip = runtime.wait!;
  runtime.wait = async (milliseconds) => {
    const row = await one(`select extract(epoch from (next_attempt_at - now())) as seconds from public.reservation_reschedule_emails where id = $1::uuid`, [emailId]);
    waitingFor.push(Math.round(Number(row.seconds)));
    await instantSkip(milliseconds);
  };

  provider.next(new EmailProviderError("HTTP_503", true, "UNKNOWN"), new EmailProviderError("HTTP_503", true, "UNKNOWN"));
  assert.deepEqual(await sendRescheduleEmailForChange(runtime, changeId), { outcome: "PENDING", errorCode: "HTTP_503", retryable: true });
  assert.deepEqual(await followUpRescheduleEmail(runtime, changeId), { outcome: "SENT" });

  // 3 s e 15 s — meio segundo além da espera que o banco gravou.
  assert.deepEqual(waits, [3500, 15500]);
  assert.deepEqual(waitingFor, [3, 15], "a espera gravada pelo banco é a da política");
  assert.equal(RESCHEDULE_FOLLOW_UP_ATTEMPTS, 2);
  // Tudo cabe no tempo máximo da rota: três envios de até 8 s e as duas esperas.
  assert.ok(3 * 8000 + waits[0] + waits[1] < 60_000);
  assert.match(source("app/api/admin/reservations/[reservationId]/standby/reschedule/route.ts"), /export const maxDuration = 60;/);

  assert.equal(provider.requests.length, 3);
  assert.equal(provider.delivered.length, 1);
  const row = await email(emailId);
  assert.deepEqual([row.status, row.attempts], ["SENT", 3]);
  assert.deepEqual((await attempts(emailId)).map((item) => item.source), ["RESCHEDULE", "RESCHEDULE", "RESCHEDULE"]);
});

test("sem a espera cumprida, a requisição não fura a fila", async () => {
  const { emailId, changeId } = await rescheduled();
  const { runtime, provider } = createRuntime();
  runtime.wait = async () => undefined; // o tempo não passou

  provider.next(new EmailProviderError("HTTP_503", true, "UNKNOWN"));
  await sendRescheduleEmailForChange(runtime, changeId);
  assert.deepEqual(await followUpRescheduleEmail(runtime, changeId), { outcome: "SKIPPED" });
  assert.equal(provider.requests.length, 1);
  assert.equal((await email(emailId)).attempts, 1);
});

test("recusa que repetir não resolve: não insiste em segundos, e a espera seguinte é longa", async () => {
  const { emailId, changeId } = await rescheduled();
  const { runtime, provider, waits } = createRuntime();

  provider.next(REJECTED_403(), REJECTED_403());
  const first = await sendRescheduleEmailForChange(runtime, changeId);
  assert.deepEqual(first, { outcome: "PENDING", errorCode: "HTTP_403", retryable: false });
  // A rota só agenda as novas tentativas quando repetir pode resolver.
  assert.deepEqual(await routeSend(runtime, changeId), { outcome: "SKIPPED" }, "dentro da espera, a própria requisição não repete");
  assert.deepEqual(waits, []);

  const row = await one(`select extract(epoch from (next_attempt_at - now())) as seconds from public.reservation_reschedule_emails where id = $1::uuid`, [emailId]);
  assert.ok(Number(row.seconds) > 290 && Number(row.seconds) <= 300, "chave revogada ou domínio não verificado não se resolvem em 3 segundos");

  // Chamadas diretamente, as tentativas em segundo plano param na primeira recusa definitiva.
  await skipBackoff();
  runtime.wait = async () => undefined;
  assert.deepEqual(await followUpRescheduleEmail(runtime, changeId), { outcome: "PENDING", errorCode: "HTTP_403", retryable: false });
  assert.equal(provider.requests.length, 2);
});

test("as tentativas em segundo plano param se outra instância já enviou ou se o e-mail deixou de fazer sentido", async () => {
  const { runtime, provider } = createRuntime();

  // Outra instância (a rotina, o painel) enviou enquanto a requisição esperava.
  const first = await rescheduled();
  provider.next(new EmailProviderError("HTTP_500", true, "UNKNOWN"));
  await sendRescheduleEmailForChange(runtime, first.changeId);
  assert.deepEqual(await routine(runtime), { outcome: "PROCESSED", processed: 1, sent: 1 });
  assert.deepEqual(await followUpRescheduleEmail(runtime, first.changeId), { outcome: "SKIPPED" });
  assert.equal(provider.delivered.length, 1);

  // A reserva foi cancelada enquanto a requisição esperava.
  const second = await rescheduled();
  provider.next(new EmailProviderError("HTTP_500", true, "UNKNOWN"));
  await sendRescheduleEmailForChange(runtime, second.changeId);
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Cliente desistiu')`, [ADMIN, second.booking.id]);
  assert.deepEqual(await followUpRescheduleEmail(runtime, second.changeId), { outcome: "SKIPPED" });
  assert.equal((await email(second.emailId)).status, "SKIPPED");
  assert.equal(provider.delivered.length, 1);
});

test("a espera cresce — 3 s, 15 s, 5 min, 30 min, 2 h — e depois de seis tentativas só uma pessoa reenvia", async () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map((attempt) => rescheduleRetryAfterSeconds(attempt, true)), [3, 15, 300, 1800, 7200, 7200, 7200]);
  assert.deepEqual([1, 2, 3, 4].map((attempt) => rescheduleRetryAfterSeconds(attempt, false)), [300, 300, 300, 1800]);

  const { booking, emailId, changeId } = await rescheduled();
  const { runtime, provider } = createRuntime();
  provider.next(...Array.from({ length: MAX_ATTEMPTS }, () => new EmailProviderError("HTTP_503", true, "UNKNOWN")));

  const observed: number[] = [];
  await sendRescheduleEmailForChange(runtime, changeId);
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
    const row = await one(`select extract(epoch from (next_attempt_at - now())) as seconds from public.reservation_reschedule_emails where id = $1::uuid`, [emailId]);
    observed.push(Math.round(Number(row.seconds)));
    // Antes da hora, a rotina não pega.
    assert.deepEqual(await retryPendingRescheduleEmails(runtime), { outcome: "PROCESSED", processed: 0, sent: 0 });
    assert.deepEqual(await routine(runtime), { outcome: "PROCESSED", processed: 1, sent: 0 });
  }
  assert.deepEqual(observed, [...RESCHEDULE_RETRY_BACKOFF_SECONDS]);

  // Seis tentativas: nada mais sai sozinho, mesmo com a espera cumprida.
  let row = await email(emailId);
  assert.deepEqual([row.status, row.attempts], ["FAILED", MAX_ATTEMPTS]);
  assert.deepEqual(await routine(runtime), { outcome: "PROCESSED", processed: 0, sent: 0 });
  assert.deepEqual(await sendRescheduleEmailForChange(runtime, changeId), { outcome: "SKIPPED" });
  assert.equal(provider.requests.length, MAX_ATTEMPTS);
  assert.deepEqual(new Set(provider.requests.map((message) => message.idempotencyKey)), new Set([keyOf(emailId, 1)]), "todas com a mesma chave: o resultado era desconhecido");

  // O painel avisa, e a pessoa reenvia — ainda dentro da janela, com a mesma chave.
  const [state] = parseRescheduleEmailStates(await call(`public.admin_reservation_reschedule_emails($1::uuid, $2::uuid)`, [ADMIN, booking.id]));
  assert.match(rescheduleEmailAlert(state, String)!.description, /As 6 tentativas automáticas falharam \(HTTP_503\) e nenhuma outra será feita sozinha/);
  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, booking.id), { outcome: "SENT" });
  assert.equal(provider.requests.at(-1)!.idempotencyKey, keyOf(emailId, 1));
  row = await email(emailId);
  assert.deepEqual([row.status, row.attempts], ["SENT", MAX_ATTEMPTS + 1]);
});

// =============================================================================
// 5. O painel: quem ainda não recebeu
// =============================================================================

test("a lista do painel traz quem ainda não recebeu — e só quem ainda importa avisar", async () => {
  const { runtime, provider } = createRuntime();
  const undelivered = async (limit = 20) => parseUndeliveredRescheduleEmails(await call(`public.admin_list_undelivered_reschedule_emails($1::uuid, $2)`, [ADMIN, limit]));
  assert.deepEqual(await undelivered(), { total: 0, items: [] });

  const sent = await rescheduled({ startsIn: "3 days" });
  await sendRescheduleEmailForChange(runtime, sent.changeId);

  const later = await rescheduled({ startsIn: "20 days", name: "Cliente Distante" });
  const soon = await rescheduled({ startsIn: "1 day", name: "Cliente de Amanhã" });
  provider.next(new EmailProviderError("HTTP_503", true, "UNKNOWN"));
  await sendRescheduleEmailForChange(runtime, soon.changeId);

  const uncertain = await rescheduled({ startsIn: "5 days", name: "Cliente Incerto" });
  provider.next("accepted-then-timeout");
  await sendRescheduleEmailForChange(runtime, uncertain.changeId);
  await ageGeneration(uncertain.emailId, "24 hours");
  await skipBackoff(uncertain.emailId);
  assert.equal(await claimFor(uncertain.changeId), null);

  // Não entram: cancelada, de volta ao Stand-by e turma que já começou.
  const cancelled = await rescheduled();
  await call(`public.admin_cancel_reservation($1::uuid, $2::uuid, 'Cliente desistiu')`, [ADMIN, cancelled.booking.id]);
  const parked = await rescheduled();
  await call(`public.admin_set_reservation_standby($1::uuid, $2::uuid, 'Outra vez')`, [ADMIN, parked.booking.id]);
  const started = await rescheduled();
  await rows(`update public.sessions set starts_at = now() - interval '1 hour' where id = $1::uuid`, [started.destination]);

  const list = await undelivered();
  assert.equal(list.total, 3);
  // A turma mais próxima primeiro: é quem precisa ser avisado antes.
  assert.deepEqual(list.items.map((item) => item.fullName), ["Cliente de Amanhã", "Cliente Incerto", "Cliente Distante"]);
  assert.deepEqual(list.items.map((item) => item.status), ["FAILED", "UNCERTAIN", "QUEUED"]);
  assert.deepEqual(list.items.map((item) => undeliveredRescheduleEmailLabel(item)), [
    "Falhou (HTTP_503) — nova tentativa pendente",
    "Entrega não confirmada — confirme com o cliente antes de reenviar",
    "Na fila, ainda não enviado",
  ]);

  const [first] = list.items;
  assert.equal(first.reservationId, soon.booking.id);
  assert.equal(first.publicCode, soon.booking.code);
  assert.equal(first.experienceTitle, SUNSET_CONCHA.title);
  assert.equal(first.baseName, SUNSET_CONCHA.base_name);
  assert.equal(first.attempts, 1);
  assert.ok(first.phone.startsWith("+5561"), "o contato vem para a equipe avisar por outro canal");
  const target = await one(`select starts_at from public.sessions where id = $1::uuid`, [soon.destination]);
  assert.equal(new Date(first.targetStartsAt).getTime(), new Date(target.starts_at).getTime());

  // Só o necessário: sem CPF, sem e-mail, sem a mensagem guardada, sem token.
  const raw = await call(`public.admin_list_undelivered_reschedule_emails($1::uuid, 20)`, [ADMIN]);
  assert.deepEqual(Object.keys(raw.items[0]).sort(), [
    "attempts", "baseName", "emailId", "experienceTitle", "fullName", "inFlight", "lastErrorCode", "nextAttemptAt",
    "phone", "publicCode", "rescheduledAt", "reservationId", "status", "targetStartsAt",
  ]);
  const dump = JSON.stringify(raw);
  for (const secret of [soon.booking.email, soon.booking.cpf, "frozen", "claim"]) assert.ok(!dump.includes(secret), secret);

  // O limite corta a lista, não a contagem.
  const limited = await undelivered(1);
  assert.equal(limited.total, 3);
  assert.equal(limited.items.length, 1);

  // Só a equipe.
  await assert.rejects(call(`public.admin_list_undelivered_reschedule_emails($1::uuid, 20)`, [INSTRUCTOR]), /ADMIN_FORBIDDEN/);

  // Enviado, sai da lista.
  assert.deepEqual(await resendRescheduleEmail(runtime, ADMIN, later.booking.id), { outcome: "SENT" });
  assert.deepEqual((await undelivered()).items.map((item) => item.fullName), ["Cliente de Amanhã", "Cliente Incerto"]);
});

test("o detalhe da reserva avisa com destaque enquanto o cliente não recebeu, e só nesse caso", () => {
  const base = { emailId: "e", standbyId: "s", inFlight: false, attempts: 0, lastErrorCode: null, lastAttemptAt: null, nextAttemptAt: null, sentAt: null, createdAt: "2026-10-13T12:00:00Z" };
  const format = (value: string | null) => `<${value}>`;
  const title = "O cliente ainda não recebeu a confirmação do reagendamento";

  // Sem aviso: enviado, ou descartado (não há mais o que fazer).
  assert.equal(rescheduleEmailAlert({ ...base, status: "SENT", sentAt: "2026-10-13T12:01:00Z" }, format), null);
  assert.equal(rescheduleEmailAlert({ ...base, status: "SKIPPED", lastErrorCode: "SESSION_STARTED" }, format), null);

  const queued = rescheduleEmailAlert({ ...base, status: "QUEUED" }, format)!;
  assert.equal(queued.title, title);
  assert.match(queued.description, /na fila e ainda não foi enviado/);
  assert.match(queued.description, /avise o cliente por outro canal/);

  const sending = rescheduleEmailAlert({ ...base, status: "SENDING", inFlight: true, attempts: 1 }, format)!;
  assert.equal(sending.title, title);
  assert.match(sending.description, /sendo enviado agora/);

  const failed = rescheduleEmailAlert({ ...base, status: "FAILED", attempts: 2, lastErrorCode: "HTTP_503", nextAttemptAt: "2026-10-13T12:05:00Z" }, format)!;
  assert.equal(failed.title, title);
  assert.match(failed.description, /A tentativa 2 falhou \(HTTP_503\)\. A próxima tentativa fica liberada em <2026-10-13T12:05:00Z>/);
  assert.match(failed.description, /Reenviar e-mail de reagendamento/);

  const exhausted = rescheduleEmailAlert({ ...base, status: "FAILED", attempts: 6, lastErrorCode: "HTTP_403" }, format)!;
  assert.match(exhausted.description, /As 6 tentativas automáticas falharam \(HTTP_403\) e nenhuma outra será feita sozinha/);

  // Prazo vencido sem resposta: continua sendo "não recebeu", não "em envio".
  const stale = rescheduleEmailAlert({ ...base, status: "SENDING", inFlight: false, attempts: 1 }, format)!;
  assert.match(stale.description, /na fila e ainda não foi enviado/);

  const uncertain = rescheduleEmailAlert({ ...base, status: "UNCERTAIN", attempts: 1 }, format)!;
  assert.equal(uncertain.title, "Não sabemos se o cliente recebeu a confirmação do reagendamento");
  assert.match(uncertain.description, /Confirme com o cliente antes de reenviar/);

  // Na tela: o aviso fica no topo do detalhe, como alerta, e o reenvio de uma
  // entrega não confirmada pede confirmação antes.
  const page = source("app/admin/reservas/[reservationId]/page.tsx");
  assert.ok(page.indexOf("{rescheduleEmailWarning ? (") < page.indexOf('aria-label="Dados da reserva"'), "antes dos dados da reserva");
  assert.match(page, /\{rescheduleEmailWarning \? \(\s+<section role="alert"/);
  assert.match(page, /const latestRescheduleEmail = reservation\.status === "CONFIRMED" \? rescheduleEmails\[0\] \?\? null : null;/);
  assert.match(page, /latestRescheduleEmail\.status === "UNCERTAIN" \? "CONFIRM" : "DIRECT"/);
  const actions = source("components/admin/reservation-actions.tsx");
  assert.match(actions, /standby\.rescheduleEmailResend === "CONFIRM" \? \(\) => setAction\("resendReschedule"\) : \(\) => resendRescheduleEmail\(false\)/);
  assert.match(actions, /open=\{action === "resendReschedule"\}\s+title="Reenviar sem saber se o cliente já recebeu\?"/);
  // O aceite só sai do diálogo de confirmação; e se o banco pedir confirmação no
  // meio do caminho, o diálogo é aberto em vez de o envio acontecer.
  assert.match(actions, /onConfirm=\{\(\) => resendRescheduleEmail\(true\)\}/);
  assert.equal((actions.match(/resendRescheduleEmail\(true\)/g) ?? []).length, 1, "um único lugar manda o aceite");
  assert.match(actions, /if \(payload\.outcome === "NEEDS_CONFIRMATION"\) \{\s+setAction\("resendReschedule"\);/);
  const resendRoute = source("app/api/admin/reservations/[reservationId]/standby/reschedule-email/route.ts");
  assert.match(resendRoute, /\.acceptUncertain === true;/, "só o valor exato true conta como aceite");
  assert.match(resendRoute, /result\.outcome === "NEEDS_CONFIRMATION" \? 409/);

  // Na lista de Stand-by: o bloco de quem não recebeu, antes dos filtros.
  const list = source("app/admin/stand-by/page.tsx");
  assert.ok(list.indexOf("<UndeliveredRescheduleEmails pending={undelivered} />") < list.indexOf('aria-label="Filtros de Stand-by"'));
  const block = source("components/admin/standby/undelivered-reschedule-emails.tsx");
  assert.match(block, /if \(pending\.total === 0\) return null;/);
  assert.match(block, /role="alert"/);
  assert.doesNotMatch(block, /"use client"/, "renderizado no servidor: os dados não vão para o navegador além do que aparece");

  // Logo depois de reagendar: o aviso vira alerta quando o e-mail não saiu.
  const dialog = source("components/admin/standby/standby-dialogs.tsx");
  assert.match(dialog, /title: attention \? "Reagendada — cliente ainda não avisado" : "Reserva reagendada"/);
  assert.match(dialog, /variant: attention \? "error" : undefined/);
});
