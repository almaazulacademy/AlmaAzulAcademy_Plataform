import { SessionsManager } from "@/components/admin/sessions-manager";
import { AdminPageHeader } from "@/components/admin/page-header";
import { AdminErrorState } from "@/components/admin/states";
import { requireAdmin } from "@/lib/admin/auth";
import { listAdminExperiences, listAdminSessions } from "@/lib/admin/data";
import type { SessionFilter } from "@/lib/admin/types";

export const metadata = { title: "Sessões" };

const FILTER_BY_PARAM: Record<string, SessionFilter> = {
  ativas: "ACTIVE",
  arquivadas: "ARCHIVED",
  todas: "ALL",
};

export default async function AdminSessionsPage({ searchParams }: { searchParams: Promise<{ novo?: string; filtro?: string }> }) {
  const context = await requireAdmin();
  const params = await searchParams;
  const filter = FILTER_BY_PARAM[params.filtro ?? "ativas"] ?? "ACTIVE";
  try {
    const [sessions, experiences] = await Promise.all([
      listAdminSessions(context.profile.userId, filter),
      listAdminExperiences(context.profile.userId),
    ]);
    return <SessionsManager sessions={sessions} experiences={experiences} initiallyOpen={params.novo === "1"} filter={filter} />;
  } catch {
    return <div><AdminPageHeader eyebrow="Operação" title="Sessões" description="Crie e organize as datas das experiências." /><div className="mt-8"><AdminErrorState description="A migration administrativa precisa estar aplicada para listar e editar sessões." /></div></div>;
  }
}
