import { SessionsManager } from "@/components/admin/sessions-manager";
import { AdminPageHeader } from "@/components/admin/page-header";
import { AdminErrorState } from "@/components/admin/states";
import { requireAdmin } from "@/lib/admin/auth";
import { listAdminExperiences, listAdminSessions } from "@/lib/admin/data";

export const metadata = { title: "Sessões" };

export default async function AdminSessionsPage({ searchParams }: { searchParams: Promise<{ novo?: string }> }) {
  const context = await requireAdmin();
  const params = await searchParams;
  try {
    const [sessions, experiences] = await Promise.all([
      listAdminSessions(context.profile.userId),
      listAdminExperiences(context.profile.userId),
    ]);
    return <SessionsManager sessions={sessions} experiences={experiences} initiallyOpen={params.novo === "1"} />;
  } catch {
    return <div><AdminPageHeader eyebrow="Operação" title="Sessões" description="Crie e organize as datas das experiências." /><div className="mt-8"><AdminErrorState description="A migration administrativa precisa estar aplicada para listar e editar sessões." /></div></div>;
  }
}
