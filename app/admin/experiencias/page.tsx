import { ExperiencesManager } from "@/components/admin/experiences-manager";
import { AdminPageHeader } from "@/components/admin/page-header";
import { AdminErrorState } from "@/components/admin/states";
import { requireAdmin } from "@/lib/admin/auth";
import { listAdminExperiences } from "@/lib/admin/data";

export const metadata = { title: "Experiências" };

export default async function AdminExperiencesPage() {
  const context = await requireAdmin();
  try {
    const experiences = await listAdminExperiences(context.profile.userId);
    return <ExperiencesManager experiences={experiences} />;
  } catch {
    return <div><AdminPageHeader eyebrow="Catálogo" title="Experiências" description="Gerencie o catálogo transacional da Alma Azul." /><div className="mt-8"><AdminErrorState description="A migration administrativa precisa estar aplicada para listar e editar experiências." /></div></div>;
  }
}
