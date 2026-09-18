import Link from "next/link";
import { ClipboardCheck, Filter, Search, X } from "lucide-react";

import { inputClass, labelClass } from "@/components/admin/form-styles";
import { AdminPageHeader } from "@/components/admin/page-header";
import { ReservationsList } from "@/components/admin/reservations-list";
import { AdminErrorState } from "@/components/admin/states";
import { buttonVariants } from "@/components/ui/button";
import { requireAdmin } from "@/lib/admin/auth";
import { adminExperienceLabel, experiencesInBase, itemsInBase, parseAdminBaseFilter } from "@/lib/admin/base-filter";
import { listAdminBases, listAdminExperiences, listAdminReservations, listAdminSessions } from "@/lib/admin/data";
import type { AdminReservationFilters } from "@/lib/admin/types";
import { PAYMENT_STATUSES, type PaymentStatus } from "@/lib/admin/types";
import { RESERVATION_STATUSES, type ReservationStatus } from "@/lib/reservations/types";
import { formatSessionDateShort } from "@/lib/sessions/date-time";

export const metadata = { title: "Reservas" };

type SearchParams = Record<string, string | string[] | undefined>;

function valueOf(params: SearchParams, key: string) {
  const value = params[key];
  return typeof value === "string" ? value.trim() : "";
}

function filtersFrom(params: SearchParams, baseSlugs: Array<{ slug: string }>): AdminReservationFilters {
  const status = valueOf(params, "status");
  return {
    date: valueOf(params, "date"),
    base: parseAdminBaseFilter(params.base, baseSlugs),
    experienceId: valueOf(params, "experienceId"),
    status: RESERVATION_STATUSES.includes(status as ReservationStatus) ? status as ReservationStatus : "",
    name: valueOf(params, "name"),
    phone: valueOf(params, "phone"),
    cpf: valueOf(params, "cpf"),
    sessionId: valueOf(params, "sessionId"),
    paymentStatus: PAYMENT_STATUSES.includes(valueOf(params, "paymentStatus") as PaymentStatus) ? valueOf(params, "paymentStatus") as PaymentStatus : "",
    query: valueOf(params, "query"),
    sort: (["recent", "oldest", "session"] as const).includes(valueOf(params, "sort") as "recent") ? valueOf(params, "sort") as AdminReservationFilters["sort"] : "recent",
  };
}

export default async function AdminReservationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const context = await requireAdmin();
  const params = await searchParams;
  try {
    const { bases } = await listAdminBases();
    const filters = filtersFrom(params, bases);
    const [allReservations, experiences, allSessions] = await Promise.all([
      listAdminReservations(context.profile.userId, filters),
      listAdminExperiences(context.profile.userId),
      listAdminSessions(context.profile.userId),
    ]);
    // A RPC não conhece base: o recorte é feito pela experiência da reserva.
    const reservations = itemsInBase(allReservations, experiences, filters.base);
    const sessions = itemsInBase(allSessions, experiences, filters.base);
    const baseExperiences = experiencesInBase(experiences, filters.base);
    const hasFilters = Object.values(filters).some(Boolean);
    return (
      <div>
        <AdminPageHeader eyebrow="Atendimento" title="Reservas" description="Localize participantes, acompanhe pagamentos e execute ações operacionais com auditoria." action={<Link href="/admin/presenca" className={buttonVariants({ variant: "outline", size: "sm" })}><ClipboardCheck className="size-4" /> Lista de Presença</Link>} />
        <form method="get" className="mt-8 rounded-3xl border border-ink/10 bg-white p-5 sm:p-6" aria-label="Filtros de reservas">
          <div className="flex items-center gap-2"><Filter className="size-4 text-lake" /><h2 className="text-sm font-semibold">Filtros</h2></div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label><span className={labelClass}>Base</span><select name="base" defaultValue={filters.base} className={inputClass}><option value="">Todas as bases</option>{bases.map((base) => <option key={base.slug} value={base.slug}>{base.name}{base.status === "COMING_SOON" ? " (em breve)" : ""}</option>)}</select></label>
            <label><span className={labelClass}>Data</span><input type="date" name="date" defaultValue={filters.date} className={inputClass} /></label>
            <label><span className={labelClass}>Experiência</span><select name="experienceId" defaultValue={filters.experienceId} className={inputClass}><option value="">Todas</option>{baseExperiences.map((item) => <option key={item.id} value={item.id}>{adminExperienceLabel(item)}</option>)}</select></label>
            <label><span className={labelClass}>Status</span><select name="status" defaultValue={filters.status} className={inputClass}><option value="">Todos</option><option value="PRE_RESERVED">Pré-reserva</option><option value="CONFIRMED">Confirmada</option><option value="EXPIRED">Expirada</option><option value="CANCELLED">Cancelada</option></select></label>
            <label><span className={labelClass}>Pagamento</span><select name="paymentStatus" defaultValue={filters.paymentStatus} className={inputClass}><option value="">Todos</option><option value="PENDING">Pendente</option><option value="PAID">Pago</option><option value="PAID_AFTER_EXPIRATION">Pago após expirar</option><option value="NOT_PAID">Não pago</option></select></label>
            <label><span className={labelClass}>Sessão</span><select name="sessionId" defaultValue={filters.sessionId} className={inputClass}><option value="">Todas</option>{sessions.map((item) => <option key={item.id} value={item.id}>{item.experienceTitle} · {formatSessionDateShort(item.startsAt)}</option>)}</select></label>
            <label><span className={labelClass}>Busca</span><input name="query" defaultValue={filters.query} className={inputClass} placeholder="Nome ou código" /></label>
            <label><span className={labelClass}>Telefone</span><input name="phone" defaultValue={filters.phone} className={inputClass} inputMode="tel" placeholder="DDD ou número" /></label>
            <label><span className={labelClass}>CPF</span><input name="cpf" defaultValue={filters.cpf} className={inputClass} inputMode="numeric" placeholder="CPF completo ou últimos 4" /><span className="mt-1.5 block text-xs text-ink/40">A busca compara o hash; o CPF não é armazenado em texto.</span></label>
            <label><span className={labelClass}>Ordenação</span><select name="sort" defaultValue={filters.sort} className={inputClass}><option value="recent">Mais recentes</option><option value="oldest">Mais antigas</option><option value="session">Data da experiência</option></select></label>
          </div>
          <div className="mt-5 flex flex-wrap justify-end gap-3">{hasFilters ? <Link href="/admin/reservas" className={buttonVariants({ variant: "ghost", size: "sm" })}><X className="size-4" /> Limpar</Link> : null}<button type="submit" className={buttonVariants({ size: "sm" })}><Search className="size-4" /> Aplicar filtros</button></div>
        </form>
        <div className="mt-6"><p className="mb-4 text-sm text-ink/50">{reservations.length} {reservations.length === 1 ? "reserva encontrada" : "reservas encontradas"}</p><ReservationsList reservations={reservations} hasFilters={hasFilters} /></div>
      </div>
    );
  } catch {
    return <div><AdminPageHeader eyebrow="Atendimento" title="Reservas" description="Localize e acompanhe reservas." /><div className="mt-8"><AdminErrorState description="A migration administrativa precisa estar aplicada para consultar reservas e filtros." /></div></div>;
  }
}
