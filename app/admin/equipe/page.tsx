import { AdminPageHeader } from "@/components/admin/page-header";
import { AdminErrorState } from "@/components/admin/states";
import { TeamManager } from "@/components/admin/team-manager";
import { requireTeamManager } from "@/lib/admin/auth";
import { listTeam, teamErrorResponse } from "@/lib/team/data";

export const metadata = { title: "Equipe" };

export default async function TeamPage() {
  const context = await requireTeamManager();
  let team: Awaited<ReturnType<typeof listTeam>> | null = null;
  let failure: string | null = null;
  try {
    team = await listTeam(context.profile.userId);
  } catch (error) {
    failure = teamErrorResponse(error).message;
  }

  return (
    <div>
      <AdminPageHeader
        eyebrow="Operação"
        title="Equipe"
        description="Convide instrutores e controle quem tem acesso à Lista de Presença. Instrutores não veem reservas, financeiro nem configurações."
      />
      {failure || !team ? (
        <div className="mt-8"><AdminErrorState title="Não foi possível carregar a equipe." description={failure ?? undefined} /></div>
      ) : (
        <TeamManager instructors={team.instructors} invites={team.invites} />
      )}
    </div>
  );
}
