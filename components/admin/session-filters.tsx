import Link from "next/link";
import { Filter, Search, X } from "lucide-react";

import { inputClass, labelClass } from "@/components/admin/form-styles";
import { buttonVariants } from "@/components/ui/button";
import type { AdminExperience, AdminSessionFilters } from "@/lib/admin/types";
import {
  SESSION_PERIOD_OPTIONS,
  SESSION_SORT_OPTIONS,
  SESSION_STATUS_OPTIONS,
  hasSessionFilters,
  sessionPeriodParam,
  sessionSortParam,
  sessionStatusParam,
} from "@/lib/admin/session-filters";

export function SessionFilters({ filters, experiences }: { filters: AdminSessionFilters; experiences: AdminExperience[] }) {
  const hasFilters = hasSessionFilters(filters);
  return (
    <form method="get" className="mt-6 rounded-3xl border border-ink/10 bg-white p-5 sm:p-6" aria-label="Filtros de sessões">
      <div className="flex items-center gap-2"><Filter className="size-4 text-lake" /><h2 className="text-sm font-semibold">Filtros</h2></div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="sm:col-span-2"><span className={labelClass}>Busca</span><input name="busca" defaultValue={filters.query} className={inputClass} placeholder="Buscar por experiência..." /></label>
        <label><span className={labelClass}>Status</span><select name="filtro" defaultValue={sessionStatusParam(filters.status)} className={inputClass}>{SESSION_STATUS_OPTIONS.map((option) => <option key={option.param} value={option.param}>{option.label}</option>)}</select></label>
        <label><span className={labelClass}>Experiência</span><select name="experiencia" defaultValue={filters.experienceId} className={inputClass}><option value="">Todas</option>{experiences.map((experience) => <option key={experience.id} value={experience.id}>{experience.title}</option>)}</select></label>
        <label><span className={labelClass}>Data</span><select name="periodo" defaultValue={sessionPeriodParam(filters.period)} className={inputClass}>{SESSION_PERIOD_OPTIONS.map((option) => <option key={option.param} value={option.param}>{option.label}</option>)}</select></label>
        <label><span className={labelClass}>De</span><input type="date" name="de" defaultValue={filters.from} className={inputClass} /></label>
        <label><span className={labelClass}>Até</span><input type="date" name="ate" defaultValue={filters.to} className={inputClass} /></label>
        <label><span className={labelClass}>Ordenação</span><select name="ordem" defaultValue={sessionSortParam(filters.sort)} className={inputClass}>{SESSION_SORT_OPTIONS.map((option) => <option key={option.param} value={option.param}>{option.label}</option>)}</select></label>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-3">
        {hasFilters ? <Link href="/admin/sessoes" className={buttonVariants({ variant: "ghost", size: "sm" })}><X className="size-4" /> Limpar filtros</Link> : null}
        <button type="submit" className={buttonVariants({ size: "sm" })}><Search className="size-4" /> Aplicar filtros</button>
      </div>
    </form>
  );
}
