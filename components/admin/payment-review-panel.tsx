import Link from "next/link";
import { AlertTriangle, ShieldAlert, TimerReset } from "lucide-react";

import { formatAdminDateTime, formatCurrency } from "@/lib/admin/format";
import type { PaymentReviewItem, PaymentReviewReason, PaymentReviewReport } from "@/lib/admin/types";

/**
 * "Pagamentos para revisar".
 *
 * Existe para substituir a conferência manual do extrato da InfinitePay. Toda
 * linha aqui é uma situação em que o dinheiro e a vaga podem estar
 * desencontrados — e nenhuma delas desaparece sozinha.
 *
 * A seção não mostra CPF, nome, telefone, e-mail nem payload: o que a equipe
 * precisa para decidir é código público, turma, valor, motivo e vaga disponível.
 */

const REASONS: Record<PaymentReviewReason, { label: string; detail: string; severity: "critical" | "warning" }> = {
  APPROVED_NO_CAPACITY: {
    label: "Pagamento aprovado sem vaga",
    detail: "O pagamento existe na InfinitePay e a turma lotou. Exige realocação ou estorno.",
    severity: "critical",
  },
  PAID_NOT_CONFIRMED: {
    label: "Pago e não confirmado",
    detail: "Há evidência de pagamento fora da retenção. Use Verificar pagamento na reserva.",
    severity: "critical",
  },
  AMOUNT_MISMATCH: {
    label: "Valor divergente",
    detail: "A cobrança ficou abaixo do total da reserva. Confira antes de confirmar.",
    severity: "critical",
  },
  HOLD_EXHAUSTED: {
    label: "Janela de segurança esgotada",
    detail: "A vaga foi liberada sem resposta definitiva do gateway. Confirme o estado real do pagamento.",
    severity: "warning",
  },
  RECONCILIATION_FAILING: {
    label: "Reconciliação falhando",
    detail: "Várias tentativas seguidas sem conseguir falar com a InfinitePay.",
    severity: "warning",
  },
  EXPIRED_WITH_PAYMENT_SIGNAL: {
    label: "Expirada com sinal de pagamento",
    detail: "Chegou webhook para esta reserva e ela expirou mesmo assim.",
    severity: "warning",
  },
};

function ReasonBadge({ reason }: { reason: PaymentReviewReason | null }) {
  if (!reason) return null;
  const meta = REASONS[reason];
  const tone = meta.severity === "critical"
    ? "bg-red-50 text-red-700 ring-red-200"
    : "bg-amber-50 text-amber-800 ring-amber-200";
  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${tone}`}>
      {meta.label}
    </span>
  );
}

function ReviewRow({ item }: { item: PaymentReviewItem }) {
  const meta = item.reason ? REASONS[item.reason] : null;
  return (
    <li className="rounded-2xl border border-ink/10 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/admin/reservas/${item.reservationId}`}
              className="font-mono text-sm font-semibold text-ink underline-offset-4 hover:underline"
            >
              {item.publicCode}
            </Link>
            <ReasonBadge reason={item.reason} />
          </div>
          <p className="mt-2 truncate text-sm text-ink/70">
            {item.experienceTitle} · {formatAdminDateTime(item.startsAt)}
          </p>
          {meta ? <p className="mt-1 text-xs leading-5 text-ink/50">{meta.detail}</p> : null}
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold text-ink">{formatCurrency(item.totalCents)}</p>
          <p className="mt-1 text-xs text-ink/50">
            {item.quantity} {item.quantity === 1 ? "vaga" : "vagas"} · {item.availableSpots} disponíveis
          </p>
        </div>
      </div>

      <dl className="mt-4 grid gap-x-6 gap-y-2 border-t border-ink/5 pt-4 text-xs text-ink/55 sm:grid-cols-3">
        <div>
          <dt className="font-medium text-ink/45">Status</dt>
          <dd>{item.status} · {item.paymentStatus}</dd>
        </div>
        <div>
          <dt className="font-medium text-ink/45">Prazo original</dt>
          <dd>{formatAdminDateTime(item.originalExpiresAt)}</dd>
        </div>
        <div>
          <dt className="font-medium text-ink/45">Última reconciliação</dt>
          <dd>
            {formatAdminDateTime(item.lastReconciledAt)}
            {item.lastReconciliationCode ? ` · ${item.lastReconciliationCode}` : ""}
            {item.reconciliationAttempts ? ` · ${item.reconciliationAttempts} tentativas` : ""}
          </dd>
        </div>
      </dl>
    </li>
  );
}

export function PaymentReviewPanel({ report }: { report: PaymentReviewReport }) {
  const hasItems = report.items.length > 0;
  const hasOrphans = report.orphanWebhooks.length > 0;

  if (!hasItems && !hasOrphans && !report.webhookFailures) {
    return (
      <section className="mt-10 rounded-3xl border border-ink/10 bg-white p-6" aria-label="Pagamentos para revisar">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-2xl bg-lake/10"><ShieldAlert className="size-5 text-lake" /></div>
          <div>
            <h2 className="text-lg font-semibold tracking-[-0.02em] text-ink">Pagamentos para revisar</h2>
            <p className="mt-1 text-sm text-ink/55">
              Nenhuma pendência. Não é necessário conferir o extrato da InfinitePay manualmente.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mt-10" aria-label="Pagamentos para revisar">
      <div className="flex items-start gap-3">
        <div className="grid size-10 place-items-center rounded-2xl bg-red-50"><AlertTriangle className="size-5 text-red-600" /></div>
        <div>
          <h2 className="text-lg font-semibold tracking-[-0.02em] text-ink">Pagamentos para revisar</h2>
          <p className="mt-1 text-sm text-ink/55">
            Situações em que o dinheiro e a vaga podem estar desencontrados. Nenhuma some sozinha.
          </p>
        </div>
      </div>

      {hasItems ? (
        <ul className="mt-5 space-y-3">
          {report.items.map((item) => <ReviewRow key={item.reservationId} item={item} />)}
        </ul>
      ) : null}

      {hasOrphans || report.webhookFailures ? (
        <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50/60 p-5">
          <div className="flex items-center gap-2">
            <TimerReset className="size-4 text-amber-700" />
            <h3 className="text-sm font-semibold text-amber-900">Webhooks com problema</h3>
          </div>
          <p className="mt-2 text-xs leading-5 text-amber-900/80">
            {report.webhookFailures} notificação(ões) respondida(s) com erro HTTP no período.
            {hasOrphans ? ` ${report.orphanWebhooks.length} não corresponderam a nenhuma reserva.` : ""}
          </p>
          {hasOrphans ? (
            <ul className="mt-3 space-y-1 font-mono text-[11px] text-amber-900/70">
              {report.orphanWebhooks.slice(0, 10).map((webhook) => (
                <li key={`${webhook.requestId}-${webhook.receivedAt}`}>
                  {formatAdminDateTime(webhook.receivedAt)} · {webhook.step}
                  {webhook.errorCode ? ` · ${webhook.errorCode}` : ""}
                  {webhook.orderIdMasked ? ` · ${webhook.orderIdMasked}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
