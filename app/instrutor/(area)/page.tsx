import { AttendanceDayView } from "@/components/admin/attendance/attendance-day-view";
import { requireCheckinStaff } from "@/lib/admin/auth";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function InstructorHomePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const context = await requireCheckinStaff();
  const params = await searchParams;
  return (
    <div>
      {params.acesso === "negado" ? (
        <p className="mb-6 rounded-2xl bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900" role="status">
          Seu perfil de instrutor dá acesso somente à Lista de Presença e ao check-in.
        </p>
      ) : null}
      <AttendanceDayView
        actorUserId={context.profile.userId}
        requestedDate={typeof params.data === "string" ? params.data : ""}
        basePath="/instrutor"
        eyebrow="Check-in"
      />
    </div>
  );
}
