import Link from "next/link";
import { AlertTriangle } from "lucide-react";

import { formatAdminPhone } from "@/lib/admin/format";
import { undeliveredRescheduleEmailLabel, type UndeliveredRescheduleEmails } from "@/lib/reservations/reschedule-email";
import { formatSessionDateTime } from "@/lib/sessions/date-time";

/**
 * "Clientes que ainda não receberam a confirmação": reservas já reagendadas cujo
 * e-mail não saiu. Depois de reagendada a reserva some da lista de Stand-by, e é
 * aqui que ela continua visível até o cliente ser avisado. A turma mais próxima
 * vem primeiro. Sem pendência, o bloco não aparece.
 */
export function UndeliveredRescheduleEmails({ pending }: { pending: UndeliveredRescheduleEmails }) {
  if (pending.total === 0) return null;
  const hidden = pending.total - pending.items.length;

  return (
    <section role="alert" aria-label="Clientes sem confirmação do reagendamento" className="mt-8 rounded-3xl border border-amber-300 bg-amber-50 p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-700" aria-hidden />
        <div>
          <h2 className="text-sm font-semibold text-amber-950">
            {pending.total === 1
              ? "1 cliente reagendado ainda não recebeu a confirmação por e-mail"
              : `${pending.total} clientes reagendados ainda não receberam a confirmação por e-mail`}
          </h2>
          <p className="mt-1 text-sm leading-6 text-amber-900/80">
            A reserva está confirmada na nova turma; só o e-mail não saiu. Se a experiência for em breve, avise pelo WhatsApp. O reenvio fica no detalhe da reserva.
          </p>
        </div>
      </div>
      <ul className="mt-4 space-y-2">
        {pending.items.map((item) => (
          <li key={item.emailId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-2xl bg-white p-4 ring-1 ring-amber-200">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">
                {item.fullName} <span className="font-mono text-xs font-medium tracking-wide text-lake">{item.publicCode}</span>
              </p>
              <p className="mt-1 text-sm text-ink/70">
                {item.experienceTitle} · {formatSessionDateTime(item.targetStartsAt)}{item.baseName ? ` · ${item.baseName}` : ""}
              </p>
              <p className="mt-1 text-xs font-medium text-amber-900">
                {undeliveredRescheduleEmailLabel(item)} · {formatAdminPhone(item.phone)}
              </p>
            </div>
            <Link href={`/admin/reservas/${item.reservationId}`} className="shrink-0 text-sm font-semibold text-lake hover:underline">Abrir reserva</Link>
          </li>
        ))}
      </ul>
      {hidden > 0 ? <p className="mt-3 text-xs text-amber-900/80">E mais {hidden}, com turmas mais distantes.</p> : null}
    </section>
  );
}
