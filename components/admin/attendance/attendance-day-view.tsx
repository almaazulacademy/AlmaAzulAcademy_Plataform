import Link from "next/link";
import type { ReactNode } from "react";
import { CalendarDays, ChevronRight, Users } from "lucide-react";

import { AdminPageHeader } from "@/components/admin/page-header";
import { AdminEmptyState, AdminErrorState } from "@/components/admin/states";
import { listAttendanceSessions } from "@/lib/checkin/data";
import { checkinErrorResponse } from "@/lib/checkin/parse";
import { isDateKey, localDateKey } from "@/lib/checkin/token";
import { formatSessionDate, formatSessionDateShort, formatSessionTime } from "@/lib/sessions/date-time";
import { cn } from "@/lib/utils";

/**
 * Turmas de um dia na Lista de Presença. Usada pelo painel (/admin/presenca) e
 * pela área do instrutor (/instrutor); muda só o caminho base e a ação do topo.
 * A autorização é da página que a monta e, de novo, da RPC.
 */
export async function AttendanceDayView({ actorUserId, requestedDate, basePath, eyebrow, action }: {
  actorUserId: string;
  requestedDate: string;
  basePath: string;
  eyebrow: string;
  action?: ReactNode;
}) {
  const today = localDateKey();
  const tomorrow = localDateKey(new Date(), 1);
  const date = isDateKey(requestedDate) ? requestedDate : today;

  let sessions: Awaited<ReturnType<typeof listAttendanceSessions>> = [];
  let failure: string | null = null;
  try {
    sessions = await listAttendanceSessions(actorUserId, date);
  } catch (error) {
    failure = checkinErrorResponse(error).message;
  }

  const tabs = [
    { key: today, label: "Hoje" },
    { key: tomorrow, label: "Amanhã" },
  ];
  const dayLabel = formatSessionDate(`${date}T15:00:00Z`);

  return (
    <div>
      <AdminPageHeader
        eyebrow={eyebrow}
        title="Lista de Presença"
        description="Escolha a turma, escaneie o QR Code do cliente ou faça o check-in manual."
        action={action}
      />

      <nav className="mt-6 flex flex-wrap items-center gap-2" aria-label="Escolher dia">
        {tabs.map((tab) => (
          <Link
            key={tab.label}
            href={`${basePath}?data=${tab.key}`}
            aria-current={date === tab.key ? "page" : undefined}
            className={cn(
              "inline-flex h-12 items-center rounded-full px-6 text-base font-semibold transition",
              date === tab.key ? "bg-ink text-white" : "bg-white text-ink ring-1 ring-ink/15 hover:bg-mist",
            )}
          >
            {tab.label}
          </Link>
        ))}
        <form action={basePath} className="flex items-center gap-2">
          <label className="sr-only" htmlFor="attendance-date">Escolher data</label>
          <input
            id="attendance-date"
            type="date"
            name="data"
            defaultValue={date}
            className="h-12 rounded-full border border-ink/15 bg-white px-4 text-base text-ink"
          />
          <button type="submit" className="inline-flex h-12 items-center gap-2 rounded-full bg-white px-5 text-base font-semibold text-ink ring-1 ring-ink/15 hover:bg-mist">
            <CalendarDays className="size-4" /> Ver
          </button>
        </form>
      </nav>

      <p className="mt-5 text-sm font-medium capitalize text-ink/60">{dayLabel}</p>

      <div className="mt-4">
        {failure ? (
          <AdminErrorState title="Não foi possível carregar a lista de presença." description={failure} />
        ) : sessions.length === 0 ? (
          <AdminEmptyState title="Nenhuma turma neste dia" description="Escolha outra data para ver as experiências agendadas." />
        ) : (
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {sessions.map((session) => {
              const waiting = session.pendingSpots;
              const progress = session.reservedSpots ? Math.min(100, Math.round((session.presentCount / session.reservedSpots) * 100)) : 0;
              return (
                <li key={session.sessionId}>
                  <Link
                    href={`${basePath}/${session.sessionId}`}
                    className="block rounded-3xl border border-ink/10 bg-white p-5 transition hover:border-lake/40 hover:shadow-sm active:scale-[0.99]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="text-lg font-semibold leading-6 text-ink">{session.experienceTitle}</h2>
                        <p className="mt-1 text-sm text-ink/60">
                          {formatSessionDateShort(session.startsAt)} • <span className="font-semibold text-ink">{formatSessionTime(session.startsAt)}</span>
                          {session.baseName ? ` • ${session.baseName}` : ""}
                        </p>
                      </div>
                      <ChevronRight className="mt-1 size-5 shrink-0 text-ink/35" />
                    </div>
                    <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                      <div className="rounded-2xl bg-mist/60 p-3"><dt className="text-ink/55">Reservas</dt><dd className="mt-0.5 text-xl font-semibold text-ink">{session.reservationsCount}</dd></div>
                      <div className="rounded-2xl bg-mist/60 p-3"><dt className="text-ink/55">Vagas reservadas</dt><dd className="mt-0.5 text-xl font-semibold text-ink">{session.reservedSpots}</dd></div>
                      <div className="rounded-2xl bg-emerald-50 p-3"><dt className="text-emerald-800/70">Presentes</dt><dd className="mt-0.5 text-xl font-semibold text-emerald-800">{session.presentCount}</dd></div>
                      <div className="rounded-2xl bg-amber-50 p-3"><dt className="text-amber-800/70">Aguardando</dt><dd className="mt-0.5 text-xl font-semibold text-amber-800">{waiting}</dd></div>
                    </dl>
                    <div className="mt-4 h-2 overflow-hidden rounded-full bg-ink/10" aria-hidden>
                      <div className="h-full rounded-full bg-emerald-600" style={{ width: `${progress}%` }} />
                    </div>
                    <span className="mt-4 flex h-12 items-center justify-center gap-2 rounded-full bg-ink text-base font-semibold text-white">
                      <Users className="size-4" /> Abrir lista
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
