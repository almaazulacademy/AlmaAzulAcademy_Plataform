import Link from "next/link";
import { ArrowRight, Users } from "lucide-react";

import { ReservationActions } from "@/components/admin/reservation-actions";
import { StatusBadge } from "@/components/admin/status-badge";
import { AdminEmptyState } from "@/components/admin/states";
import { buttonVariants } from "@/components/ui/button";
import type { AdminReservation } from "@/lib/admin/types";
import { formatAdminDateTime, formatAdminPhone, formatCurrency } from "@/lib/admin/format";

export function ReservationsList({ reservations }: { reservations: AdminReservation[] }) {
  if (reservations.length === 0) {
    return <AdminEmptyState title="Nenhuma reserva encontrada" description="Ajuste os filtros ou aguarde novas reservas." />;
  }

  return (
    <div className="space-y-4">
      {reservations.map((reservation) => (
        <article key={reservation.id} className="rounded-3xl border border-ink/10 bg-white p-5 sm:p-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0 xl:w-64">
              <div className="flex flex-wrap gap-2"><StatusBadge status={reservation.status} /><StatusBadge status={reservation.paymentStatus} /></div>
              <h2 className="mt-4 truncate text-lg font-semibold">{reservation.fullName}</h2>
              <p className="mt-1 text-sm text-ink/50">{formatAdminPhone(reservation.phone)}</p>
            </div>
            <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 xl:grid-cols-5">
              <div><dt className="text-xs text-ink/45">Experiência</dt><dd className="mt-1 text-sm font-semibold">{reservation.experienceTitle}</dd></div>
              <div><dt className="text-xs text-ink/45">Horário</dt><dd className="mt-1 text-sm font-semibold">{formatAdminDateTime(reservation.startsAt)}</dd></div>
              <div><dt className="text-xs text-ink/45">Pessoas</dt><dd className="mt-1 flex items-center gap-1.5 text-sm font-semibold"><Users className="size-4 text-lake" /> {reservation.quantity}</dd></div>
              <div><dt className="text-xs text-ink/45">Valor</dt><dd className="mt-1 text-sm font-semibold">{formatCurrency(reservation.totalCents)}</dd></div>
              <div><dt className="text-xs text-ink/45">Código</dt><dd className="mt-1 font-mono text-sm font-semibold tracking-wide">{reservation.publicCode}</dd></div>
            </dl>
          </div>
          <div className="mt-5 flex flex-col gap-3 border-t border-ink/10 pt-4 xl:flex-row xl:items-center xl:justify-between">
            <ReservationActions
              reservationId={reservation.id}
              status={reservation.status}
              fullName={reservation.fullName}
              phone={reservation.phone}
              email={reservation.email}
              publicCode={reservation.publicCode}
            />
            <Link href={`/admin/reservas/${reservation.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Abrir detalhes <ArrowRight className="size-4" /></Link>
          </div>
        </article>
      ))}
    </div>
  );
}
