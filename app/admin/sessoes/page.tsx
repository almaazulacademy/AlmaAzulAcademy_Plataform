import { SessionFilters } from "@/components/admin/session-filters";
import { SessionsManager } from "@/components/admin/sessions-manager";
import { AdminPageHeader } from "@/components/admin/page-header";
import { AdminErrorState } from "@/components/admin/states";
import { requireAdmin } from "@/lib/admin/auth";
import { listAdminExperiences, listAdminSessionsFiltered } from "@/lib/admin/data";
import { sessionFiltersFrom } from "@/lib/admin/session-filters";

export const metadata = { title: "Sessões" };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function AdminSessionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const context = await requireAdmin();
  const params = await searchParams;
  const filters = sessionFiltersFrom(params);
  try {
    const [sessions, experiences] = await Promise.all([
      listAdminSessionsFiltered(context.profile.userId, filters),
      listAdminExperiences(context.profile.userId),
    ]);
    return (
      <SessionsManager
        sessions={sessions}
        experiences={experiences}
        initiallyOpen={params.novo === "1"}
        filters={filters}
        filtersSlot={<SessionFilters filters={filters} experiences={experiences} />}
      />
    );
  } catch {
    return <div><AdminPageHeader eyebrow="Operação" title="Sessões" description="Crie e organize as datas das experiências." /><div className="mt-8"><AdminErrorState description="A migration administrativa precisa estar aplicada para listar e editar sessões." /></div></div>;
  }
}
