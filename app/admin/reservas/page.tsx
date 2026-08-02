import Link from "next/link";
import { Filter, Search, X } from "lucide-react";

import { inputClass, labelClass } from "@/components/admin/form-styles";
import { AdminPageHeader } from "@/components/admin/page-header";
import { ReservationsList } from "@/components/admin/reservations-list";
import { AdminErrorState } from "@/components/admin/states";
import { buttonVariants } from "@/components/ui/button";
import { requireAdmin } from "@/lib/admin/auth";
import { listAdminExperiences, listAdminReservations, listAdminSessions } from "@/lib/admin/data";
import type { AdminReservationFilters } from "@/lib/admin/types";
import { RESERVATION_STATUSES, type ReservationStatus } from "@/lib/reservations/types";

export const metadata = { title: "Reservas" };

type SearchParams = Record<string, string | string[] | undefined>;

function valueOf(params: SearchParams, key: string) {
  const value = params[key];
  return typeof value === "string" ? value.trim() : "";
}

function filtersFrom(params: SearchParams): AdminReservationFilters {
  const status = valueOf(params, "status");
  return {
    date: valueOf(params, "date"),
    experienceId: valueOf(params, "experienceId"),
    status: RESERVATION_STATUSES.includes(status as ReservationStatus) ? status as ReservationStatus : "",
    name: valueOf(params, "name"),
    phone: valueOf(params, "phone"),
    cpf: valueOf(params, "cpf"),
    sessionId: valueOf(params, "sessionId"),
  };
}

export default async function AdminReservationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const context = await requireAdmin();
  const filters = filtersFrom(await searchParams);
  try {
    const [reservations, experiences, sessions] = await Promise.all([
      listAdminReservations(context.profile.userId, filters),
      listAdminExperiences(context.profile.userId),
      listAdminSessions(context.profile.userId),
    ]);
    const hasFilters = Object.values(filters).some(Boolean);
    return (
      <div>
        <AdminPageHeader eyebrow="Atendimento" title="Reservas" description="Localize participantes, acompanhe pagamentos e execute ações operacionais com auditoria." />
        <form method="get" className="mt-8 rounded-3xl border border-ink/10 bg-white p-5 sm:p-6" aria-label="Filtros de reservas">
          <div className="flex items-center gap-2"><Filter className="size-4 text-lake" /><h2 className="text-sm font-semibold">Filtros</h2></div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label><span className={labelClass}>Data</span><input type="date" name="date" defaultValue={filters.date} className={inputClass} /></label>
            <label><span className={labelClass}>Experiência</span><select name="experienceId" defaultValue={filters.experienceId} className={inputClass}><option value="">Todas</option>{experiences.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
            <label><span className={labelClass}>Status</span><select name="status" defaultValue={filters.status} className={inputClass}><option value="">Todos</option><option value="PRE_RESERVED">Pré-reserva</option><option value="CONFIRMED">Confirmada</option><option value="EXPIRED">Expirada</option><option value="CANCELLED">Cancelada</option></select></label>
            <label><span className={labelClass}>Sessão</span><select name="sessionId" defaultValue={filters.sessionId} className={inputClass}><option value="">Todas</option>{sessions.map((item) => <option key={item.id} value={item.id}>{item.experienceTitle} · {new Date(item.startsAt).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}</option>)}</select></label>
            <label><span className={labelClass}>Nome</span><input name="name" defaultValue={filters.name} className={inputClass} placeholder="Nome do responsável" /></label>
            <label><span className={labelClass}>Telefone</span><input name="phone" defaultValue={filters.phone} className={inputClass} inputMode="tel" placeholder="DDD ou número" /></label>
            <label><span className={labelClass}>CPF</span><input name="cpf" defaultValue={filters.cpf} className={inputClass} inputMode="numeric" placeholder="CPF completo ou últimos 4" /><span className="mt-1.5 block text-xs text-ink/40">A busca compara o hash; o CPF não é armazenado em texto.</span></label>
          </div>
          <div className="mt-5 flex flex-wrap justify-end gap-3">{hasFilters ? <Link href="/admin/reservas" className={buttonVariants({ variant: "ghost", size: "sm" })}><X className="size-4" /> Limpar</Link> : null}<button type="submit" className={buttonVariants({ size: "sm" })}><Search className="size-4" /> Aplicar filtros</button></div>
        </form>
        <div className="mt-6"><p className="mb-4 text-sm text-ink/50">{reservations.length} {reservations.length === 1 ? "reserva encontrada" : "reservas encontradas"}</p><ReservationsList reservations={reservations} /></div>
      </div>
    );
  } catch {
    return <div><AdminPageHeader eyebrow="Atendimento" title="Reservas" description="Localize e acompanhe reservas." /><div className="mt-8"><AdminErrorState description="A migration administrativa precisa estar aplicada para consultar reservas e filtros." /></div></div>;
  }
}
