import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, BellRing, History } from "lucide-react";

import { AdminPageHeader } from "@/components/admin/page-header";
import { AdminErrorState } from "@/components/admin/states";
import { RemoveWaitlistEntryButton } from "@/components/admin/waitlist/remove-entry-button";
import { WaitlistStatusBadge } from "@/components/admin/waitlist/waitlist-status-badge";
import { requireAdmin } from "@/lib/admin/auth";
import { formatAdminDateTime, formatAdminPhone } from "@/lib/admin/format";
import {
  isWaitlistAdminEnabled,
  isWaitlistUuid,
  waitlistClosedReasonLabel,
  waitlistSkipReasonLabel,
  WAITLIST_EVENT_LABELS,
  WAITLIST_NOTIFICATION_KIND_LABELS,
  WAITLIST_NOTIFICATION_STATUS_LABELS,
  type WaitlistEntryDetail,
} from "@/lib/admin/waitlist";
import { waitlistAdminData } from "@/lib/admin/waitlist-server";
import { formatSessionDateTime } from "@/lib/sessions/date-time";

export const metadata = { title: "Inscrição na lista de espera" };

/**
 * Uma inscrição: contato, turma, situação, cada aviso com as tentativas de envio
 * e as ações da equipe. Nunca mostra o link de cancelamento nem a mensagem
 * guardada da fila — a RPC não os devolve.
 */
export default async function AdminWaitlistEntryPage({ params }: { params: Promise<{ entryId: string }> }) {
  const context = await requireAdmin();
  if (!isWaitlistAdminEnabled()) notFound();
  const { entryId } = await params;
  if (!isWaitlistUuid(entryId)) notFound();

  let entry: WaitlistEntryDetail | null;
  try {
    entry = await waitlistAdminData().entry(context.profile.userId, entryId);
  } catch {
    return (
      <div>
        <AdminPageHeader eyebrow="Lista de espera" title="Inscrição" description="Situação e histórico de uma inscrição na lista de espera." />
        <div className="mt-8"><AdminErrorState description="As migrations da lista de espera precisam estar aplicadas no Supabase para consultar esta inscrição." /></div>
      </div>
    );
  }
  if (!entry) notFound();

  return (
    <div>
      <Link href={`/admin/lista-de-espera?session=${entry.sessionId}`} className="mb-6 inline-flex items-center gap-2 text-sm font-semibold text-forest"><ArrowLeft className="size-4" /> Voltar para a turma</Link>
      <AdminPageHeader
        eyebrow="Lista de espera"
        title={entry.anonymized ? "Dados anonimizados" : entry.fullName ?? "Inscrição"}
        description={`${entry.experienceTitle} · ${entry.baseName || "—"} · ${formatSessionDateTime(entry.startsAt)}`}
        action={entry.status === "ACTIVE" ? <RemoveWaitlistEntryButton entryId={entry.entryId} fullName={entry.fullName} /> : undefined}
      />

      <section className="mt-8 rounded-3xl border border-ink/10 bg-white p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-3"><h2 className="text-lg font-semibold">Inscrição</h2><WaitlistStatusBadge status={entry.status} /></div>
        <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div><dt className="text-xs text-ink/45">E-mail</dt><dd className="mt-1 break-all font-semibold">{entry.email ?? "—"}</dd></div>
          <div><dt className="text-xs text-ink/45">WhatsApp</dt><dd className="mt-1 font-semibold">{entry.phone ? formatAdminPhone(entry.phone) : "—"}</dd></div>
          <div><dt className="text-xs text-ink/45">Pessoas</dt><dd className="mt-1 font-semibold">{entry.quantity}</dd></div>
          <div><dt className="text-xs text-ink/45">Inscrição em</dt><dd className="mt-1 font-semibold">{formatAdminDateTime(entry.createdAt)}</dd></div>
          <div><dt className="text-xs text-ink/45">Posição na fila</dt><dd className="mt-1 font-semibold">{entry.position ? `${entry.position}º` : "—"}</dd></div>
          <div><dt className="text-xs text-ink/45">Turma agora</dt><dd className="mt-1 font-semibold">{entry.remainingSpots > 0 ? `${entry.remainingSpots} de ${entry.capacity} vagas livres` : `Esgotada (${entry.capacity} vagas)`}</dd></div>
          {entry.closedAt ? (
            <div className="sm:col-span-2 lg:col-span-3"><dt className="text-xs text-ink/45">Encerrada</dt><dd className="mt-1 font-semibold">{formatAdminDateTime(entry.closedAt)}{entry.closedReason ? `, ${waitlistClosedReasonLabel(entry.closedReason)}` : ""}</dd></div>
          ) : null}
          {entry.convertedReservationId ? (
            <div className="sm:col-span-2 lg:col-span-3"><dt className="text-xs text-ink/45">Reserva</dt><dd className="mt-1"><Link href={`/admin/reservas/${entry.convertedReservationId}`} className="font-semibold text-forest underline-offset-4 hover:underline">Abrir a reserva feita por esta pessoa</Link></dd></div>
          ) : null}
        </dl>
      </section>

      <section className="mt-6 rounded-3xl border border-ink/10 bg-white p-5 sm:p-6" aria-labelledby="waitlist-notifications">
        <div className="flex items-center gap-2"><BellRing className="size-4 text-lake" /><h2 id="waitlist-notifications" className="text-lg font-semibold">Avisos e e-mails</h2></div>
        {entry.notifications.length === 0 ? (
          <p className="mt-4 text-sm text-ink/55">Nenhum e-mail registrado para esta inscrição.</p>
        ) : (
          <ol className="mt-4 space-y-3">
            {entry.notifications.map((notification) => (
              <li key={notification.notificationId} className="rounded-2xl bg-mist/50 p-4 text-sm">
                <p className="font-semibold">{WAITLIST_NOTIFICATION_KIND_LABELS[notification.kind]} — {WAITLIST_NOTIFICATION_STATUS_LABELS[notification.status] ?? notification.status}</p>
                <p className="mt-1 text-ink/60">
                  Criado em {formatAdminDateTime(notification.createdAt)}
                  {notification.sentAt ? ` · enviado em ${formatAdminDateTime(notification.sentAt)}` : ""}
                  {notification.skipReason ? ` · não enviado: ${waitlistSkipReasonLabel(notification.skipReason)}` : ""}
                  {notification.spotsAtQueue ? ` · ${notification.spotsAtQueue} vaga(s) na hora do aviso` : ""}
                  {` · ${notification.attempts} tentativa(s)`}
                  {notification.lastErrorCode ? ` · último erro: ${notification.lastErrorCode}` : ""}
                </p>
                {notification.tries.length ? (
                  <ul className="mt-2 space-y-1 text-xs text-ink/55">
                    {notification.tries.map((attempt) => (
                      <li key={attempt.attempt}>Tentativa {attempt.attempt}: {formatAdminDateTime(attempt.startedAt)} — {attempt.outcome ?? (attempt.finishedAt ? "sem resposta" : "em andamento")}{attempt.errorCode ? ` (${attempt.errorCode})` : ""}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="mt-6 rounded-3xl border border-ink/10 bg-white p-5 sm:p-6" aria-labelledby="waitlist-events">
        <div className="flex items-center gap-2"><History className="size-4 text-lake" /><h2 id="waitlist-events" className="text-lg font-semibold">Ações da equipe</h2></div>
        {entry.events.length === 0 ? (
          <p className="mt-4 text-sm text-ink/55">Nenhuma ação da equipe registrada.</p>
        ) : (
          <ol className="mt-4 space-y-3">
            {entry.events.map((event, index) => (
              <li key={`${event.createdAt}-${index}`} className="rounded-2xl bg-mist/50 p-4 text-sm">
                <p className="font-semibold">{WAITLIST_EVENT_LABELS[event.action] ?? event.action}</p>
                <p className="mt-1 text-ink/60">{formatAdminDateTime(event.createdAt)} · por {event.actorName || "administrador removido"}</p>
                {event.reason ? <p className="mt-2 text-ink/70"><span className="font-semibold text-ink">Motivo:</span> {event.reason}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
