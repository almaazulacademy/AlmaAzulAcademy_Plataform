/**
 * Camada 3 — reconciliação automática.
 *
 * ## Por que existe
 *
 * Até aqui, a confirmação automática tinha um único mecanismo: o webhook da
 * InfinitePay. O retorno do navegador depende do cliente voltar ao site e a
 * verificação administrativa depende de alguém clicar — nenhum dos dois é
 * automático. Qualquer webhook perdido, atrasado, rejeitado ou respondido com
 * erro virava vaga revendida com o dinheiro do primeiro cliente na conta.
 *
 * Esta rotina não espera notificação nenhuma. Ela pergunta à InfinitePay,
 * server-to-server, qual é o estado real do pagamento das reservas em risco.
 *
 * ## As três respostas possíveis
 *
 * | Resposta do gateway | O que fazemos com a vaga |
 * | --- | --- |
 * | Pago | Confirma a reserva. Se não couber mais, gera incidente e nunca silencia. |
 * | Comprovadamente não pago | Libera o hold e deixa expirar normalmente. |
 * | Incerto (rede, timeout, resposta ilegível) | **Estende o hold.** A vaga não sai. |
 *
 * A terceira linha é o coração da correção. "Não consegui verificar" nunca pode
 * ser tratado como "não pagou".
 */

import { newRequestId, type PaymentSource } from "@/lib/payments/observability";
import { recordPaymentStep } from "@/lib/payments/payment-trail";
import {
  confirmPaymentWithJobs,
  type ConfirmationOutcome,
  type ConfirmationPorts,
} from "@/lib/reservations/payment-confirmation";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

const SOURCE: PaymentSource = "RECONCILIATION";

/** Teto de reservas conferidas por execução. Mantém a função dentro do tempo. */
export const MAX_RECONCILIATION_BATCH = 25;

/** Não reconferir a mesma reserva antes disso, salvo quando está prestes a vencer. */
export const RECONCILIATION_STALE_MINUTES = 5;

/** Até quando uma reserva expirada continua sendo candidata a pagamento atrasado. */
export const RECONCILIATION_LOOKBACK_HOURS = 72;

/** Quanto o hold é estendido a cada resposta incerta do gateway. */
export const HOLD_EXTENSION_MINUTES = 15;

/**
 * Quantas reservas a reconciliação oportunista confere de carona.
 *
 * ## Por que existe
 *
 * O plano Hobby da Vercel executa cron **uma vez por dia** — granularidade
 * inútil para uma janela de segurança de trinta minutos. O agendamento diário
 * continua valendo como varredura de fundo, mas a cadência curta vem daqui: todo
 * webhook e toda criação de pré-reserva puxam algumas pendências junto, depois
 * de já terem respondido. Nos momentos em que existe pagamento acontecendo é
 * exatamente quando existem reservas em risco para conferir.
 *
 * Mesmo padrão que a fila de e-mail já usa em `OPPORTUNISTIC_EMAIL_DRAIN`. O
 * lote é pequeno de propósito, e `RECONCILIATION_STALE_MINUTES` impede que a
 * mesma reserva seja reconferida a cada requisição.
 */
export const OPPORTUNISTIC_RECONCILIATION_DRAIN = 3;

type Candidate = {
  reservation_id: string;
  reservation_status: string;
  expires_at: string | null;
  payment_hold_until: string | null;
  original_expires_at: string | null;
  total_cents: number;
  provider_reference: string | null;
  reconciliation_attempts: number;
};

export type ReconciliationReport = {
  outcome: "PROCESSED" | "DISABLED" | "FAILED";
  processed: number;
  confirmed: number;
  released: number;
  held: number;
  incidents: number;
  errorCode?: string;
};

const EMPTY: ReconciliationReport = {
  outcome: "PROCESSED", processed: 0, confirmed: 0, released: 0, held: 0, incidents: 0,
};

/**
 * Traduz o resultado da confirmação em uma decisão sobre a vaga.
 *
 * `RELEASE` só sai de `NOT_PAID` — a única resposta em que a InfinitePay afirma,
 * de forma positiva, que este pedido não foi pago.
 */
export function decide(outcome: ConfirmationOutcome): "CONFIRMED" | "RELEASE" | "HOLD" | "INCIDENT" {
  if (outcome === "CONFIRMED" || outcome === "ALREADY_CONFIRMED" || outcome === "RECONCILED") return "CONFIRMED";
  if (outcome === "NOT_PAID") return "RELEASE";
  if (outcome === "NO_CAPACITY" || outcome === "AMOUNT_MISMATCH") return "INCIDENT";
  if (outcome === "CANCELLED" || outcome === "RESERVATION_NOT_FOUND") return "RELEASE";
  return "HOLD";
}

/**
 * Reconcilia um lote de reservas em risco. Nunca lança.
 *
 * Idempotente por construção em dois níveis: a reivindicação usa
 * `for update skip locked`, então duas execuções simultâneas não pegam a mesma
 * linha; e a confirmação em si já é idempotente, então mesmo que peguem, o
 * resultado final é o mesmo.
 */
export async function reconcilePendingPayments(
  limit = MAX_RECONCILIATION_BATCH,
  ports: ConfirmationPorts = {},
): Promise<ReconciliationReport> {
  const admin = ports.admin !== undefined ? ports.admin : getSupabaseAdminClient();
  if (!admin) return { ...EMPTY, outcome: "DISABLED" };

  let claimed: Candidate[];
  try {
    const claim = await admin.rpc("claim_payment_reconciliation", {
      p_limit: Math.max(1, Math.min(limit, MAX_RECONCILIATION_BATCH)),
      p_stale_minutes: RECONCILIATION_STALE_MINUTES,
      p_lookback_hours: RECONCILIATION_LOOKBACK_HOURS,
    });
    if (claim.error) throw new Error("CLAIM_UNAVAILABLE");
    claimed = Array.isArray(claim.data) ? (claim.data as Candidate[]) : [];
  } catch {
    await recordPaymentStep({
      requestId: newRequestId(), source: SOURCE, step: "RECONCILIATION_FAILED",
      outcome: "FAILED", errorCode: "CLAIM_UNAVAILABLE", stage: "reconciliation",
    });
    return { ...EMPTY, outcome: "FAILED", errorCode: "CLAIM_UNAVAILABLE" };
  }

  const report: ReconciliationReport = { ...EMPTY, processed: claimed.length };

  for (const candidate of claimed) {
    const settled = await reconcileOne(candidate, ports);
    if (settled === "CONFIRMED") report.confirmed += 1;
    else if (settled === "RELEASE") report.released += 1;
    else if (settled === "HOLD") report.held += 1;
    else if (settled === "INCIDENT") report.incidents += 1;
  }

  return report;
}

/**
 * Reconcilia uma reserva específica. Usado pelo lote e disponível para
 * acionamento pontual. Nunca lança.
 */
export async function reconcileReservation(
  reservationId: string,
  ports: ConfirmationPorts = {},
): Promise<ConfirmationOutcome> {
  const admin = ports.admin !== undefined ? ports.admin : getSupabaseAdminClient();
  if (!admin) return "PROVIDER_UNAVAILABLE";

  const row = await admin
    .from("reservations")
    .select("id,status,expires_at,payment_hold_until,original_expires_at,total_cents,provider_reference,reconciliation_attempts")
    .eq("id", reservationId)
    .maybeSingle();
  if (row.error || !row.data) return "RESERVATION_NOT_FOUND";

  const candidate: Candidate = {
    reservation_id: String(row.data.id),
    reservation_status: String(row.data.status),
    expires_at: row.data.expires_at as string | null,
    payment_hold_until: row.data.payment_hold_until as string | null,
    original_expires_at: row.data.original_expires_at as string | null,
    total_cents: Number(row.data.total_cents),
    provider_reference: (row.data.provider_reference as string | null) ?? null,
    reconciliation_attempts: Number(row.data.reconciliation_attempts ?? 0),
  };
  const { outcome } = await runOne(candidate, ports);
  return outcome;
}

async function runOne(candidate: Candidate, ports: ConfirmationPorts) {
  const requestId = newRequestId();

  await recordPaymentStep({
    requestId, source: SOURCE, step: "RECONCILIATION_ATTEMPT", outcome: "OK",
    orderId: candidate.reservation_id, providerReference: candidate.provider_reference ?? undefined,
    stage: "reconciliation",
    payload: {
      reservation_status: candidate.reservation_status,
      attempt: candidate.reconciliation_attempts,
      on_hold: Boolean(candidate.payment_hold_until),
    },
  });

  // A reconciliação não tem webhook para ler: o único identificador disponível é
  // o `order_nsu` (o próprio id da reserva) e o slug guardado na criação do
  // checkout. O `payment_check` da InfinitePay aceita a consulta por order_nsu.
  const { result, settle } = await confirmPaymentWithJobs({
    orderId: candidate.reservation_id,
    transactionId: "",
    invoiceSlug: candidate.provider_reference ?? "",
    payload: { source: "reconciliation", attempt: candidate.reconciliation_attempts },
    requestId,
    stage: "reconciliation",
    source: SOURCE,
    deferSideEffects: true,
  }, ports);

  return { outcome: result.outcome, decision: decide(result.outcome), settle, requestId };
}

async function reconcileOne(candidate: Candidate, ports: ConfirmationPorts) {
  const admin = ports.admin !== undefined ? ports.admin : getSupabaseAdminClient();
  if (!admin) return "HOLD";

  let outcome: ConfirmationOutcome;
  let decision: "CONFIRMED" | "RELEASE" | "HOLD" | "INCIDENT";
  let settle: () => Promise<void>;
  let requestId: string;

  try {
    ({ outcome, decision, settle, requestId } = await runOne(candidate, ports));
  } catch {
    // Exceção aqui é sempre incerteza — nunca prova de não pagamento. Segura.
    await extendHold(candidate.reservation_id, "PROVIDER_UNAVAILABLE", ports);
    return "HOLD";
  }

  if (decision === "CONFIRMED") {
    await recordPaymentStep({
      requestId, source: SOURCE, step: "RECONCILIATION_SUCCESS", outcome: "OK",
      orderId: candidate.reservation_id, stage: "reconciliation",
      payload: { previous_status: candidate.reservation_status, outcome },
    });
    // Planilha e e-mail ficam fora do caminho crítico, mas aqui não há resposta
    // HTTP para atrasar: dá para esperar e reportar de verdade.
    await settle().catch(() => undefined);
    return "CONFIRMED";
  }

  if (decision === "RELEASE") {
    // O builder do supabase-js é *thenable*, não uma Promise: tem `.then`, mas
    // não `.catch`. Todo tratamento de erro aqui precisa de try/catch de verdade.
    let released = false;
    try {
      const response = await admin.rpc("release_reservation_payment_hold", {
        p_reservation_id: candidate.reservation_id,
        p_code: outcome === "NOT_PAID" ? "NOT_PAID" : outcome,
      });
      released = response.data === true;
    } catch {
      released = false;
    }
    await recordPaymentStep({
      requestId, source: SOURCE, step: "EXPIRATION_HOLD_RELEASED",
      outcome: released ? "OK" : "SKIPPED", orderId: candidate.reservation_id,
      errorCode: outcome, stage: "reconciliation",
    });
    // `released` é false quando a reserva ainda está dentro do prazo do próprio
    // cliente: aí não existe retenção para soltar e a vaga continua sendo dela.
    // Um Pix que ainda não liquidou não pode encurtar o prazo de ninguém.
    return released ? "RELEASE" : "HOLD";
  }

  if (decision === "INCIDENT") {
    // NO_CAPACITY e AMOUNT_MISMATCH já gravaram evento próprio na RPC. Aqui só
    // carimbamos o resultado para a revisão administrativa enxergar.
    try {
      await admin.rpc("record_reconciliation_result", { p_reservation_id: candidate.reservation_id, p_code: outcome });
    } catch {
      // Carimbo de observabilidade: falhar aqui não muda o incidente já gravado.
    }
    await recordPaymentStep({
      requestId, source: SOURCE,
      step: outcome === "NO_CAPACITY" ? "PAYMENT_APPROVED_WITHOUT_CAPACITY" : "RECONCILIATION_FAILED",
      outcome: "FAILED", orderId: candidate.reservation_id, errorCode: outcome, stage: "reconciliation",
    });
    return "INCIDENT";
  }

  await extendHold(candidate.reservation_id, outcome, ports);
  await recordPaymentStep({
    requestId, source: SOURCE, step: "EXPIRATION_HELD_FOR_PAYMENT_CHECK", outcome: "OK",
    orderId: candidate.reservation_id, errorCode: outcome, stage: "reconciliation",
  });
  return "HOLD";
}

/**
 * Estende a retenção enquanto o estado do pagamento continua incerto.
 *
 * O teto absoluto vive no banco (`payment_hold_max_minutes`), contado a partir do
 * prazo original: um gateway fora do ar atrasa a liberação, mas nunca congela a
 * capacidade para sempre. Quando o teto chega, `expire_pre_reservations` grava
 * `PAYMENT_HOLD_EXHAUSTED` antes de liberar — a vaga volta, mas com registro.
 */
async function extendHold(reservationId: string, code: string, ports: ConfirmationPorts = {}) {
  const admin = ports.admin !== undefined ? ports.admin : getSupabaseAdminClient();
  if (!admin) return;
  try {
    await admin.rpc("hold_reservation_for_payment_check", {
      p_reservation_id: reservationId,
      p_minutes: HOLD_EXTENSION_MINUTES,
      p_code: /^[A-Z0-9_]{1,64}$/.test(code) ? code : "PROVIDER_UNAVAILABLE",
    });
  } catch {
    // Sem conseguir estender, a vaga sai só quando o hold atual vencer — e a
    // expiração grava PAYMENT_HOLD_EXHAUSTED antes de liberar.
  }
}

/**
 * Reconciliação de carona, para rodar **depois** da resposta HTTP.
 *
 * Nunca lança e nunca é aguardada por quem está no caminho crítico: o chamador
 * envolve em `after()`. Se falhar, a varredura agendada e a próxima requisição
 * tentam de novo.
 */
export async function drainReconciliationOpportunistically(ports: ConfirmationPorts = {}) {
  try {
    return await reconcilePendingPayments(OPPORTUNISTIC_RECONCILIATION_DRAIN, ports);
  } catch {
    return { ...EMPTY, outcome: "FAILED" as const, errorCode: "DRAIN_FAILED" };
  }
}
