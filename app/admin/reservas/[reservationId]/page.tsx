import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { ReservationActions } from "@/components/admin/reservation-actions";
import { StatusBadge } from "@/components/admin/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { requireAdmin } from "@/lib/admin/auth";
import { getAdminReservation } from "@/lib/admin/data";
import { formatAdminDateTime, formatAdminPhone, formatCurrency, formatMaskedCpf } from "@/lib/admin/format";
import { isUuid } from "@/lib/admin/validation";
import { formatSessionDateTime } from "@/lib/sessions/date-time";

export const metadata = { title: "Detalhe da reserva" };

export default async function AdminReservationDetailPage({ params }: { params: Promise<{ reservationId: string }> }) {
  const context = await requireAdmin();
  const { reservationId } = await params;
  if (!isUuid(reservationId)) notFound();
  const reservation = await getAdminReservation(context.profile.userId, reservationId);
  if (!reservation) notFound();

  const fields = [
    ["Nome", reservation.fullName],
    ["CPF", formatMaskedCpf(reservation.cpfLast4)],
    ["Telefone", formatAdminPhone(reservation.phone)],
    ["Email", reservation.email],
    ["Quantidade", String(reservation.quantity)],
    ["Valor unitário", formatCurrency(reservation.unitPriceCents)],
    ["Valor total", formatCurrency(reservation.totalCents)],
    ["Sessão", `${reservation.experienceTitle} · ${formatSessionDateTime(reservation.startsAt)}`],
    ["Código da reserva", reservation.publicCode],
    ["Criada em", formatAdminDateTime(reservation.createdAt)],
    ["Expiração", formatAdminDateTime(reservation.expiresAt)],
    ["Confirmação", formatAdminDateTime(reservation.confirmedAt)],
  ];

  return (
    <div>
      <Link href="/admin/reservas" className={buttonVariants({ variant: "ghost", size: "sm" })}><ArrowLeft className="size-4" /> Voltar às reservas</Link>
      <header className="mt-6 border-b border-ink/10 pb-7">
        <div className="flex flex-wrap gap-2"><StatusBadge status={reservation.status} /><StatusBadge status={reservation.paymentStatus} /></div>
        <h1 className="mt-4 text-3xl font-semibold tracking-[-0.045em] sm:text-4xl">{reservation.fullName}</h1>
        <p className="mt-3 font-mono text-sm tracking-wide text-lake">{reservation.publicCode}</p>
      </header>
      <dl className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Dados da reserva">
        {fields.map(([label, value]) => <div key={label} className="rounded-3xl border border-ink/10 bg-white p-5"><dt className="text-xs font-medium text-ink/45">{label}</dt><dd className="mt-2 break-words text-sm font-semibold leading-6 text-ink">{value}</dd></div>)}
      </dl>
      <section className="mt-6 rounded-3xl border border-ink/10 bg-white p-6"><h2 className="text-sm font-semibold">Pagamento</h2><dl className="mt-4 grid gap-4 sm:grid-cols-2"><div><dt className="text-xs text-ink/45">Provedor</dt><dd className="mt-1 text-sm font-medium">{reservation.paymentProvider ?? "Não associado"}</dd></div><div><dt className="text-xs text-ink/45">Referência</dt><dd className="mt-1 break-all text-sm font-medium">{reservation.providerReference ?? "Sem referência"}</dd></div></dl></section>
      <section className="mt-6 rounded-3xl border border-ink/10 bg-white p-6"><h2 className="text-sm font-semibold">Observações</h2><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-ink/60">{reservation.notes ?? "Nenhuma observação informada."}</p></section>
      <section className="mt-6 rounded-3xl border border-ink/10 bg-white p-6"><h2 className="text-sm font-semibold">Ações</h2><p className="mt-2 text-sm text-ink/50">A mensagem é apenas preparada; revise antes do envio.</p><div className="mt-5"><ReservationActions reservationId={reservation.id} status={reservation.status} fullName={reservation.fullName} phone={reservation.phone} email={reservation.email} publicCode={reservation.publicCode} showMessageButton /></div></section>
    </div>
  );
}
