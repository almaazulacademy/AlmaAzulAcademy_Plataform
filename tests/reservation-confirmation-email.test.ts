import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildReservationConfirmationEmail,
  deliverReservationConfirmationEmail,
  MEETING_LOCATION,
  parseReservationConfirmationData,
  reservationConfirmationSubject,
  type ConfirmationEmail,
  type ConfirmationEmailDeps,
  type ReservationConfirmationData,
} from "../lib/reservations/confirmation-email.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const RESERVATION_ID = "11110000-0000-4000-8000-000000000001";

function data(overrides: Partial<ReservationConfirmationData> = {}): ReservationConfirmationData {
  return {
    reservationId: RESERVATION_ID,
    publicCode: "AZ7K2M9QX1",
    fullName: "João Gonçalves d'Ávila",
    email: "joao@exemplo.com.br",
    quantity: 1,
    experienceTitle: "Imersão Paranoá",
    startsAt: "2026-09-06T12:00:00.000Z", // 09:00 em Brasília
    ...overrides,
  };
}

/**
 * Dublê da entrega. Modela o contrato real: a reivindicação é quem decide se há
 * direito de enviar, e ela só devolve um id na primeira vez.
 */
function createDeps(overrides: Partial<ConfirmationEmailDeps> = {}) {
  const sent: ConfirmationEmail[] = [];
  const completed: string[] = [];
  const failed: Array<{ jobId: string; errorCode: string }> = [];
  let claims = 0;

  const deps: ConfirmationEmailDeps = {
    claim: async () => {
      claims += 1;
      // Exatamente-uma-vez: a segunda chamada não devolve job, como o
      // `on conflict ... do update ... where` faz no banco.
      return claims === 1 ? "job-1" : null;
    },
    load: async () => ({ ...data(), status: "CONFIRMED" }),
    send: async (message) => { sent.push(message); },
    complete: async (jobId) => { completed.push(jobId); },
    fail: async (jobId, errorCode) => { failed.push({ jobId, errorCode }); },
    sanitizeError: (error) => (error instanceof Error ? error.message : "UNEXPECTED_ERROR"),
    ...overrides,
  };

  return { deps, sent, completed, failed, claimCount: () => claims };
}

// --- Conteúdo da mensagem ---------------------------------------------------

test("o assunto usa o código real da reserva", () => {
  assert.equal(reservationConfirmationSubject("AZ7K2M9QX1"), "Reserva confirmada — AZ7K2M9QX1");
  assert.equal(buildReservationConfirmationEmail(data()).subject, "Reserva confirmada — AZ7K2M9QX1");
});

test("a mensagem traz nome, código, data e horário reais", () => {
  const email = buildReservationConfirmationEmail(data());

  for (const conteudo of [email.html, email.text]) {
    assert.match(conteudo, /Olá, João!/, "cumprimenta pelo primeiro nome");
    assert.match(conteudo, /AZ7K2M9QX1/);
    assert.match(conteudo, /Imersão Paranoá/);
    assert.match(conteudo, new RegExp(MEETING_LOCATION));
    assert.match(conteudo, /Sua reserva está confirmada/);
  }
  assert.equal(email.to, "joao@exemplo.com.br");
});

test("a data e o horário saem no fuso de Brasília", () => {
  // 12:00 UTC é 09:00 em Brasília. Um fuso errado mostraria 12:00 e o dia errado.
  const email = buildReservationConfirmationEmail(data());

  for (const conteudo of [email.html, email.text]) {
    assert.match(conteudo, /09:00/);
    assert.match(conteudo, /setembro de 2026/);
    assert.match(conteudo, /domingo/, "06/09/2026 cai num domingo em Brasília");
    assert.doesNotMatch(conteudo, /12:00/);
  }
});

test("existe versão em texto puro além do HTML", () => {
  const email = buildReservationConfirmationEmail(data());

  assert.doesNotMatch(email.text, /<[a-z]/i, "a versão texto não pode conter marcação");
  assert.match(email.text, /Código da reserva: AZ7K2M9QX1/);
  assert.match(email.text, /Equipe Alma Azul Academy/);
  assert.ok(email.text.length > 400, "o texto puro precisa ser a mensagem inteira, não um resumo");
});

test("o HTML é responsivo e sobrevive a cliente de e-mail antigo", () => {
  const { html } = buildReservationConfirmationEmail(data());

  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(html, /max-width:560px/);
  assert.match(html, /width="100%"/);
  assert.match(html, /lang="pt-BR"/);
  // Cliente de e-mail não é navegador: nada de layout moderno nem CSS externo.
  assert.doesNotMatch(html, /display:\s*(flex|grid)/);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/);
  assert.doesNotMatch(html, /<script/i);
});

test("o rodapé traz o contato e a identidade que já existem no projeto", () => {
  const email = buildReservationConfirmationEmail(data());
  const contato = source("lib/contact.ts");

  assert.ok(contato.includes("almaazulacademy@gmail.com"));
  for (const conteudo of [email.html, email.text]) {
    assert.match(conteudo, /almaazulacademy@gmail\.com/);
    assert.match(conteudo, /@almaazulacademy/);
    assert.match(conteudo, /\(61\) 99268-2522/);
  }
  assert.match(email.html, /#214f43/, "usa a paleta da marca");
});

test("nome do cliente é escapado antes de entrar no HTML", () => {
  const { html } = buildReservationConfirmationEmail(data({ fullName: "<script>alert(1)</script> Silva" }));
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test("reserva de mais de uma pessoa mostra a quantidade", () => {
  const uma = buildReservationConfirmationEmail(data());
  const tres = buildReservationConfirmationEmail(data({ quantity: 3 }));

  assert.doesNotMatch(uma.text, /^Pessoas:/m);
  assert.match(tres.text, /^Pessoas: 3$/m);
});

// --- Disparo correto --------------------------------------------------------

test("uma reserva confirmada dispara exatamente um e-mail", async () => {
  const { deps, sent, completed, failed } = createDeps();

  const result = await deliverReservationConfirmationEmail(deps);

  assert.equal(result.outcome, "SENT");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, "Reserva confirmada — AZ7K2M9QX1");
  assert.deepEqual(completed, ["job-1"]);
  assert.equal(failed.length, 0);
});

test("reserva não confirmada não gera e-mail", async () => {
  // A reivindicação no banco confere o status antes de devolver job; aqui ela
  // devolve null, que é o que acontece com pendente, expirada ou cancelada.
  const { deps, sent } = createDeps({ claim: async () => null });

  const result = await deliverReservationConfirmationEmail(deps);

  assert.equal(result.outcome, "SKIPPED");
  assert.equal(sent.length, 0, "nenhuma mensagem pode ser montada sequer");
});

test("um payload sem status CONFIRMED é recusado na segunda tranca", () => {
  assert.equal(parseReservationConfirmationData({ ...data(), status: "PRE_RESERVED" }), null);
  assert.equal(parseReservationConfirmationData({ ...data(), status: "CANCELLED" }), null);
  assert.equal(parseReservationConfirmationData({ ...data(), status: "EXPIRED" }), null);
  assert.ok(parseReservationConfirmationData({ ...data(), status: "CONFIRMED" }));
});

test("payload incompleto ou e-mail inválido não vira mensagem", () => {
  assert.equal(parseReservationConfirmationData(null), null);
  assert.equal(parseReservationConfirmationData({}), null);
  assert.equal(parseReservationConfirmationData({ ...data(), status: "CONFIRMED", email: "sem-arroba" }), null);
  assert.equal(parseReservationConfirmationData({ ...data(), status: "CONFIRMED", publicCode: "" }), null);
  assert.equal(parseReservationConfirmationData({ ...data(), status: "CONFIRMED", fullName: "  " }), null);
});

// --- Prevenção de duplicidade -----------------------------------------------

test("webhook reprocessado vinte vezes não duplica o e-mail", async () => {
  const { deps, sent } = createDeps();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await deliverReservationConfirmationEmail(deps);
    if (attempt === 0) assert.equal(result.outcome, "SENT");
    else assert.equal(result.outcome, "SKIPPED", `a tentativa ${attempt + 1} não podia enviar`);
  }

  assert.equal(sent.length, 1, "exatamente um e-mail, mesmo com vinte reprocessamentos");
});

test("a reivindicação vem antes do envio, nunca depois", async () => {
  const ordem: string[] = [];
  const { deps } = createDeps({
    claim: async () => { ordem.push("claim"); return "job-1"; },
    send: async () => { ordem.push("send"); },
    complete: async () => { ordem.push("complete"); },
  });

  await deliverReservationConfirmationEmail(deps);

  assert.deepEqual(ordem, ["claim", "send", "complete"]);
});

// --- Falha não desfaz a reserva ---------------------------------------------

test("uma falha do provedor registra o job e não derruba a confirmação", async () => {
  const { deps, sent, completed, failed } = createDeps({
    send: async () => { throw new Error("HTTP_503"); },
  });

  const result = await deliverReservationConfirmationEmail(deps);

  assert.equal(result.outcome, "PENDING");
  assert.equal(result.errorCode, "HTTP_503");
  assert.equal(sent.length, 0);
  assert.equal(completed.length, 0);
  assert.deepEqual(failed, [{ jobId: "job-1", errorCode: "HTTP_503" }]);
});

test("depois de uma falha, uma nova tentativa consegue enviar", async () => {
  const sent: ConfirmationEmail[] = [];
  let tentativas = 0;
  const base = createDeps().deps;

  // O banco devolve job de novo justamente porque o anterior ficou FAILED.
  const deps: ConfirmationEmailDeps = {
    ...base,
    claim: async () => "job-1",
    send: async (message) => {
      tentativas += 1;
      if (tentativas === 1) throw new Error("TIMEOUT");
      sent.push(message);
    },
  };

  const primeira = await deliverReservationConfirmationEmail(deps);
  const segunda = await deliverReservationConfirmationEmail(deps);

  assert.equal(primeira.outcome, "PENDING");
  assert.equal(segunda.outcome, "SENT");
  assert.equal(sent.length, 1);
});

test("o serviço nunca deixa exceção escapar para quem confirmou o pagamento", () => {
  const service = source("lib/reservations/confirmation-email-service.ts");

  assert.match(service, /export async function sendReservationConfirmationEmail[\s\S]*?try \{[\s\S]*?\} catch \(error\)[\s\S]*?outcome: "PENDING"/);
  assert.match(service, /if \(!provider\) return DISABLED/);

  // O e-mail é o último passo da confirmação, depois de o Supabase já ter decidido.
  const confirmation = source("lib/reservations/payment-confirmation.ts");
  const body = confirmation.slice(
    confirmation.indexOf("export async function confirmPayment"),
    confirmation.indexOf("async function runConfirmation"),
  );
  assert.ok(body.indexOf("await runConfirmation") < body.indexOf("sendReservationConfirmationEmail"));
  assert.ok(body.indexOf("sendReservationConfirmationEmail") < body.indexOf("return confirmation;"));
});

test("a confirmação manual do admin também dispara o e-mail", () => {
  const data_ = source("lib/admin/data.ts");
  const confirm = data_.slice(data_.indexOf("export async function confirmAdminReservation"), data_.indexOf("export async function cancelAdminReservation"));

  assert.match(confirm, /if \(confirmed\)/);
  assert.match(confirm, /sendReservationConfirmationEmail\(reservationId\)/);

  // Cancelamento não envia nada.
  const cancel = data_.slice(data_.indexOf("export async function cancelAdminReservation"));
  assert.doesNotMatch(cancel, /sendReservationConfirmationEmail/);
});

// --- Segredos e dados pessoais ----------------------------------------------

test("os logs não expõem e-mail, nome nem credencial", () => {
  const observability = source("lib/email/observability.ts");

  for (const proibido of ["email", "to", "fullName", "name", "subject", "html", "text", "apiKey"]) {
    assert.doesNotMatch(observability, new RegExp(`entry\\.${proibido}\\b`), `log não pode incluir ${proibido}`);
  }
  assert.match(observability, /maskIdentifier\(fields\.reservationId\)/);

  const resend = source("lib/email/resend.ts");
  assert.doesNotMatch(resend, /console\./, "o cliente do provedor não loga nada");
  // O corpo do erro do provedor pode citar o destinatário: só o status sobrevive.
  assert.doesNotMatch(resend, /response\.text\(\)|response\.json\(\)/);
});

test("chave e remetente vivem em variável de ambiente, nunca no código", () => {
  const email = source("lib/email/index.ts");
  const resend = source("lib/email/resend.ts");

  assert.match(email, /env\.RESEND_API_KEY/);
  assert.match(email, /env\.EMAIL_FROM/);
  assert.doesNotMatch(resend, /re_[A-Za-z0-9]{10,}/, "nenhuma chave literal");
  assert.doesNotMatch(email, /re_[A-Za-z0-9]{10,}/);

  // Nada de chave de e-mail no bundle do navegador.
  assert.match(email, /NEXT_PUBLIC_RESEND_API_KEY/);
  assert.match(email, /PUBLIC_ENV_FORBIDDEN/);
  assert.doesNotMatch(source(".env.example"), /RESEND_API_KEY=re_/);
});

test("o e-mail não carrega CPF, telefone nem dado de pagamento", () => {
  const email = buildReservationConfirmationEmail(data());
  const conteudo = `${email.html}\n${email.text}`.toLowerCase();

  for (const proibido of ["cpf", "cartão", "cartao", "checkout", "infinitepay", "token"]) {
    assert.doesNotMatch(conteudo, new RegExp(proibido), `"${proibido}" não pode aparecer no e-mail`);
  }

  // O tipo de entrada nem conhece esses campos.
  const template = source("lib/reservations/confirmation-email.ts");
  const tipo = template.slice(template.indexOf("export type ReservationConfirmationData"), template.indexOf("export type ConfirmationEmail"));
  for (const campo of ["cpf", "phone", "address", "checkoutUrl", "totalCents"]) {
    assert.doesNotMatch(tipo, new RegExp(campo, "i"));
  }
});

test("nenhum teste envia e-mail de verdade", () => {
  const suite = source("tests/reservation-confirmation-email.test.ts");
  const imports = suite.slice(0, suite.indexOf("function source("));

  assert.doesNotMatch(imports, /lib\/email/, "a suíte não importa o provedor real");
  assert.doesNotMatch(suite, /api\.resend\.com/);
  assert.doesNotMatch(source(".github/workflows/ci.yml"), /RESEND|EMAIL_FROM/);
});

// --- Recuperação de falhas sem depender de nova confirmação -----------------

test("a rotina agendada exige segredo e não vaza nada na resposta", () => {
  const route = source("app/api/cron/confirmation-emails/route.ts");

  assert.match(route, /process\.env\.CRON_SECRET/);
  assert.match(route, /status: 503/, "sem segredo configurado a rota não roda");
  assert.match(route, /status: 401/, "segredo errado é recusado");
  // Comparação de tempo constante: `===` vazaria o segredo por temporização.
  assert.match(route, /timingSafeEqual/);
  assert.match(route, /retryPendingConfirmationEmails\(\)/);

  // A resposta é só contador — nenhum e-mail, nome ou código de reserva.
  const body = route.slice(route.indexOf("return NextResponse.json(\n    { outcome"));
  assert.doesNotMatch(body, /email|fullName|publicCode/i);
});

test("a ação do painel reenvia sem poder duplicar", () => {
  const route = source("app/api/admin/reservations/[reservationId]/resend-email/route.ts");

  assert.match(route, /isSameOriginRequest/);
  assert.match(route, /authorizeAdminApi/);
  assert.match(route, /isUuid/);
  // Quem decide se envia é o banco, não o endpoint: ele só repassa o resultado.
  assert.match(route, /sendReservationConfirmationEmail\(reservationId\)/);
  assert.match(route, /SKIPPED: "Nada a enviar/);
  assert.doesNotMatch(route, /force|reenviar_sempre|ignoreClaim/i);

  assert.match(source("components/admin/reservation-actions.tsx"), /Reenviar e-mail/);
  assert.match(source("app/admin/reservas/[reservationId]/page.tsx"), /getConfirmationEmailState/);
});

test("a recuperação não depende de uma nova confirmação chegar", () => {
  const service = source("lib/reservations/confirmation-email-service.ts");

  // A drenagem oportunista continua existindo, mas agora há uma função própria
  // que a rotina agendada e o painel chamam sem precisar de um envio bem-sucedido.
  assert.match(service, /export async function retryPendingConfirmationEmails/);
  const retry = service.slice(service.indexOf("export async function retryPendingConfirmationEmails"));
  assert.match(retry, /claim_pending_confirmation_emails/);
  assert.doesNotMatch(retry.slice(0, retry.indexOf("}\n\n")), /sendReservationConfirmationEmail/);
});

test("job já concluído nunca é reivindicado de novo pela recuperação", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/202608190001_reservation_confirmation_email.sql", import.meta.url),
    "utf8",
  );
  const drain = sql.slice(
    sql.indexOf("function public.claim_pending_confirmation_emails"),
    sql.indexOf("function public.reservation_confirmation_email"),
  );

  assert.match(drain, /k\.status <> 'SYNCED'/, "enviado nunca volta para a fila");
  // FAILED pode ser retentado na hora; PENDING só depois da carência, para a
  // rotina agendada não disputar um envio em andamento.
  assert.match(drain, /k\.status = 'FAILED'\s*\n\s*or k\.updated_at </);
});

test("o agendamento configurado é compatível com o plano atual", () => {
  const vercel = JSON.parse(source("vercel.json")) as { crons?: Array<{ path: string; schedule: string }> };
  const cron = vercel.crons?.[0];

  assert.ok(cron, "vercel.json precisa declarar a rotina");
  assert.equal(cron.path, "/api/cron/confirmation-emails");
  // Uma vez por dia: é o que o plano Hobby da Vercel permite.
  assert.match(cron.schedule, /^\d+ \d+ \* \* \*$/);
});
