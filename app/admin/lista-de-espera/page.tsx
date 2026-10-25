import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, ChevronLeft, ChevronRight, Filter, Search, Users, X } from "lucide-react";

import { inputClass, labelClass } from "@/components/admin/form-styles";
import { AdminPageHeader } from "@/components/admin/page-header";
import { AdminEmptyState, AdminErrorState } from "@/components/admin/states";
import { RemoveWaitlistEntryButton } from "@/components/admin/waitlist/remove-entry-button";
import { WaitlistStatusBadge } from "@/components/admin/waitlist/waitlist-status-badge";
import { buttonVariants } from "@/components/ui/button";
import { requireAdmin } from "@/lib/admin/auth";
import { listAdminBases } from "@/lib/admin/data";
import { formatAdminDateTime, formatAdminPhone } from "@/lib/admin/format";
import {
  filterWaitlistSessions,
  isWaitlistAdminEnabled,
  parseWaitlistFilters,
  waitlistExperienceOptions,
  waitlistListHref,
  waitlistPageCount,
  WAITLIST_ENTRIES_PAGE_SIZE,
  WAITLIST_ENTRY_STATUSES,
  WAITLIST_SESSIONS_PAGE_SIZE,
  WAITLIST_STATUS_LABELS,
} from "@/lib/admin/waitlist";
import { waitlistAdminData } from "@/lib/admin/waitlist-server";
import { formatSessionDateTime } from "@/lib/sessions/date-time";
import { cn } from "@/lib/utils";

export const metadata = { title: "Lista de espera" };

type SearchParams = Record<string, string | string[] | undefined>;

const DESCRIPTION = "Turmas esgotadas com pessoas aguardando vaga. A lista não reserva nem bloqueia vagas: quem for avisado ainda precisa reservar e pagar normalmente.";

function people(count: number) {
  return `${count} ${count === 1 ? "pessoa" : "pessoas"}`;
}

/**
 * Lista de espera no painel.
 *
 * Duas partes. As **turmas** com inscrição vêm de `admin_waitlist_sessions` —
 * poucas, só as que têm inscrição — e os filtros de experiência, base e data
 * recortam essa lista. As **inscrições** vêm de
 * `admin_list_waitlist_entries_page`, paginadas no banco, na ordem da fila,
 * filtradas por turma (quando escolhida), base, status e busca.
 */
export default async function AdminWaitlistPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const context = await requireAdmin();
  // Painel desligado: a rota não existe, nem para quem digita o endereço.
  if (!isWaitlistAdminEnabled()) notFound();
  const params = await searchParams;
  const actor = context.profile.userId;

  try {
    const { bases } = await listAdminBases();
    const filters = parseWaitlistFilters(params, bases);
    const baseId = bases.find((base) => base.slug === filters.base)?.id ?? null;
    const data = waitlistAdminData();

    const allSessions = await data.sessions(actor, filters.past);
    const sessions = filterWaitlistSessions(allSessions, filters, baseId);
    const experiences = waitlistExperienceOptions(allSessions);
    const selected = filters.session ? allSessions.find((session) => session.sessionId === filters.session) ?? null : null;

    const sessionPages = waitlistPageCount(sessions.length, WAITLIST_SESSIONS_PAGE_SIZE);
    const sessionsPage = Math.min(filters.sessionsPage, sessionPages);
    const visibleSessions = sessions.slice((sessionsPage - 1) * WAITLIST_SESSIONS_PAGE_SIZE, sessionsPage * WAITLIST_SESSIONS_PAGE_SIZE);

    const page = await data.entries(actor, {
      sessionId: selected?.sessionId ?? (filters.session || null),
      baseId,
      status: filters.status,
      query: filters.query,
      page: filters.page,
    });
    const entryPages = waitlistPageCount(page.total, WAITLIST_ENTRIES_PAGE_SIZE);
    const first = page.total === 0 ? 0 : page.offset + 1;
    const last = page.offset + page.items.length;
    const hasFilters = Boolean(filters.experience || filters.base || filters.date || filters.query || filters.past || filters.status !== "ACTIVE");
    const sessionScopedOnly = !filters.session && Boolean(filters.experience || filters.date);

    return (
      <div>
        <AdminPageHeader eyebrow="Atendimento" title="Lista de espera" description={DESCRIPTION} />

        <form method="get" className="mt-8 rounded-3xl border border-ink/10 bg-white p-5 sm:p-6" aria-label="Filtros da lista de espera">
          <div className="flex items-center gap-2"><Filter className="size-4 text-lake" /><h2 className="text-sm font-semibold">Filtros</h2></div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label><span className={labelClass}>Experiência</span><select name="experience" defaultValue={filters.experience} className={inputClass}><option value="">Todas as experiências</option>{experiences.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
            <label><span className={labelClass}>Base</span><select name="base" defaultValue={filters.base} className={inputClass}><option value="">Todas as bases</option>{bases.map((base) => <option key={base.slug} value={base.slug}>{base.name}</option>)}</select></label>
            <label><span className={labelClass}>Data da turma</span><input type="date" name="date" defaultValue={filters.date} className={inputClass} /></label>
            <label><span className={labelClass}>Status da inscrição</span><select name="status" defaultValue={filters.status} className={inputClass}>{WAITLIST_ENTRY_STATUSES.map((status) => <option key={status} value={status}>{WAITLIST_STATUS_LABELS[status]}</option>)}<option value="ALL">Todos os status</option></select></label>
            <label><span className={labelClass}>Busca</span><input name="query" defaultValue={filters.query} className={inputClass} maxLength={120} placeholder="Nome, e-mail ou WhatsApp" /></label>
            <label className="flex items-end gap-3 pb-2.5 text-sm"><input type="checkbox" name="past" value="1" defaultChecked={filters.past} className="size-4 accent-lake" /> Incluir turmas que já aconteceram</label>
          </div>
          <div className="mt-5 flex flex-wrap justify-end gap-3">
            {hasFilters || filters.session ? <Link href="/admin/lista-de-espera" className={buttonVariants({ variant: "ghost", size: "sm" })}><X className="size-4" /> Limpar</Link> : null}
            <button type="submit" className={buttonVariants({ size: "sm" })}><Search className="size-4" /> Aplicar filtros</button>
          </div>
        </form>

        <section className="mt-8" aria-labelledby="waitlist-sessions">
          <h2 id="waitlist-sessions" className="text-lg font-semibold">Turmas com lista de espera</h2>
          <p className="mt-1 text-sm text-ink/50">
            {sessions.length === 0 ? "Nenhuma turma com inscrição nestes filtros" : `${sessions.length} ${sessions.length === 1 ? "turma" : "turmas"}${filters.past ? "" : " a partir de hoje"}`}
          </p>
          {sessions.length === 0 ? (
            <div className="mt-4">
              <AdminEmptyState
                title={hasFilters ? "Nenhuma turma encontrada" : "Ninguém na lista de espera"}
                description={hasFilters ? "Ajuste ou remova os filtros para ampliar a busca." : "Quando alguém entrar na lista de espera de uma turma esgotada, a turma aparece aqui."}
              />
            </div>
          ) : (
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              {visibleSessions.map((session) => {
                const isSelected = session.sessionId === filters.session;
                return (
                  <article key={session.sessionId} className={cn("rounded-3xl border bg-white p-5", isSelected ? "border-lake ring-2 ring-lake/20" : "border-ink/10")}>
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <h3 className="truncate font-semibold">{session.experienceTitle || "Experiência"}</h3>
                        <p className="mt-1 text-sm text-ink/55">{session.baseName || "—"} · {formatSessionDateTime(session.startsAt)}</p>
                      </div>
                      <Link href={waitlistListHref(filters, { session: session.sessionId, page: 1 })} aria-current={isSelected ? "true" : undefined} className={buttonVariants({ variant: isSelected ? "default" : "outline", size: "sm" })}>
                        Ver inscritos <ArrowRight className="size-4" />
                      </Link>
                    </div>
                    <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
                      <div><dt className="text-xs text-ink/45">Capacidade</dt><dd className="mt-1 font-semibold">{session.capacity}</dd></div>
                      <div><dt className="text-xs text-ink/45">Vagas agora</dt><dd className={cn("mt-1 font-semibold", session.remainingSpots > 0 ? "text-emerald-700" : "")}>{session.remainingSpots > 0 ? session.remainingSpots : "Esgotada"}</dd></div>
                      <div><dt className="text-xs text-ink/45">Aguardando</dt><dd className="mt-1 flex items-center gap-1.5 font-semibold"><Users className="size-4 text-lake" /> {session.activeEntries}</dd></div>
                      <div><dt className="text-xs text-ink/45">Pessoas</dt><dd className="mt-1 font-semibold">{session.activeParticipants}</dd></div>
                    </dl>
                    <p className="mt-3 text-xs text-ink/45">{session.totalEntries} {session.totalEntries === 1 ? "inscrição" : "inscrições"} no total{session.lastSignupAt ? ` · última em ${formatAdminDateTime(session.lastSignupAt)}` : ""}</p>
                  </article>
                );
              })}
            </div>
          )}
          {sessionPages > 1 ? (
            <nav className="mt-4 flex items-center justify-between gap-3" aria-label="Paginação das turmas">
              {sessionsPage > 1 ? <Link href={waitlistListHref(filters, { sessionsPage: sessionsPage - 1 })} className={buttonVariants({ variant: "outline", size: "sm" })}><ChevronLeft className="size-4" /> Anterior</Link> : <span />}
              <p className="text-sm text-ink/50">Turmas: página {sessionsPage} de {sessionPages}</p>
              {sessionsPage < sessionPages ? <Link href={waitlistListHref(filters, { sessionsPage: sessionsPage + 1 })} className={buttonVariants({ variant: "outline", size: "sm" })}>Próxima <ChevronRight className="size-4" /></Link> : <span />}
            </nav>
          ) : null}
        </section>

        <section className="mt-10" aria-labelledby="waitlist-entries">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="waitlist-entries" className="text-lg font-semibold">
                {selected ? `Inscritos — ${selected.experienceTitle}, ${formatSessionDateTime(selected.startsAt)}` : "Inscrições"}
              </h2>
              <p className="mt-1 text-sm text-ink/50">
                {page.total === 0
                  ? "Nenhuma inscrição nestes filtros"
                  : `${page.total} ${page.total === 1 ? "inscrição" : "inscrições"} · ${people(page.totalParticipants)} · mostrando ${first}–${last}`}
              </p>
            </div>
            {filters.session ? <Link href={waitlistListHref(filters, { session: "", page: 1 })} className={buttonVariants({ variant: "ghost", size: "sm" })}><X className="size-4" /> Ver todas as turmas</Link> : null}
          </div>
          {sessionScopedOnly ? (
            <p className="mt-3 rounded-2xl bg-mist/60 p-3 text-xs leading-5 text-ink/60">Experiência e data filtram a lista de turmas acima. Para ver só os inscritos de uma delas, use &ldquo;Ver inscritos&rdquo;.</p>
          ) : null}

          {page.items.length === 0 ? (
            <div className="mt-4"><AdminEmptyState title="Nenhuma inscrição encontrada" description="Ajuste os filtros, escolha outra turma ou inclua outros status." /></div>
          ) : (
            <div className="mt-4 space-y-3">
              {page.items.map((entry) => (
                <article key={entry.entryId} className="rounded-3xl border border-ink/10 bg-white p-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 lg:w-72">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate font-semibold">{entry.anonymized ? "Dados anonimizados" : entry.fullName}</h3>
                        <WaitlistStatusBadge status={entry.status} />
                      </div>
                      {entry.anonymized ? null : (
                        <>
                          <p className="mt-1 text-sm text-ink/55">{entry.phone ? formatAdminPhone(entry.phone) : "—"}</p>
                          <p className="mt-1 truncate text-xs text-ink/45">{entry.email}</p>
                        </>
                      )}
                    </div>
                    <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
                      <div><dt className="text-xs text-ink/45">Pessoas</dt><dd className="mt-1 font-semibold">{entry.quantity}</dd></div>
                      <div><dt className="text-xs text-ink/45">Posição na fila</dt><dd className="mt-1 font-semibold">{entry.position ? `${entry.position}º` : "—"}</dd></div>
                      <div><dt className="text-xs text-ink/45">Inscrição</dt><dd className="mt-1 font-semibold">{formatAdminDateTime(entry.createdAt)}</dd></div>
                      <div><dt className="text-xs text-ink/45">Avisos de vaga</dt><dd className="mt-1 font-semibold">{entry.notificationsSent}</dd></div>
                      {selected ? null : (
                        <div className="col-span-2 sm:col-span-4"><dt className="text-xs text-ink/45">Turma</dt><dd className="mt-1 font-semibold">{entry.experienceTitle} · {entry.baseName || "—"} · {formatSessionDateTime(entry.startsAt)}</dd></div>
                      )}
                    </dl>
                  </div>
                  <div className="mt-4 flex flex-wrap justify-end gap-3 border-t border-ink/10 pt-4">
                    {entry.status === "ACTIVE" ? <RemoveWaitlistEntryButton entryId={entry.entryId} fullName={entry.fullName} /> : null}
                    <Link href={`/admin/lista-de-espera/${entry.entryId}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Histórico <ArrowRight className="size-4" /></Link>
                  </div>
                </article>
              ))}
            </div>
          )}

          {entryPages > 1 ? (
            <nav className="mt-6 flex items-center justify-between gap-3" aria-label="Paginação das inscrições">
              {filters.page > 1 ? <Link href={waitlistListHref(filters, { page: filters.page - 1 })} className={buttonVariants({ variant: "outline", size: "sm" })}><ChevronLeft className="size-4" /> Anterior</Link> : <span />}
              <p className="text-sm text-ink/50">Página {Math.min(filters.page, entryPages)} de {entryPages} · {WAITLIST_ENTRIES_PAGE_SIZE} por página</p>
              {filters.page < entryPages ? <Link href={waitlistListHref(filters, { page: filters.page + 1 })} className={buttonVariants({ variant: "outline", size: "sm" })}>Próxima <ChevronRight className="size-4" /></Link> : <span />}
            </nav>
          ) : null}
        </section>
      </div>
    );
  } catch {
    return (
      <div>
        <AdminPageHeader eyebrow="Atendimento" title="Lista de espera" description={DESCRIPTION} />
        <div className="mt-8"><AdminErrorState description="As migrations da lista de espera precisam estar aplicadas no Supabase para consultar esta lista." /></div>
      </div>
    );
  }
}
