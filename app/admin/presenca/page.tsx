import { AttendanceDayView } from "@/components/admin/attendance/attendance-day-view";
import { QrBulkSender } from "@/components/admin/attendance/qr-bulk-sender";
import { requireAdmin } from "@/lib/admin/auth";
import { canSendCheckinQr } from "@/lib/admin/roles";

export const metadata = { title: "Lista de Presença" };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function AttendancePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const context = await requireAdmin();
  const params = await searchParams;
  return (
    <AttendanceDayView
      actorUserId={context.profile.userId}
      requestedDate={typeof params.data === "string" ? params.data : ""}
      basePath="/admin/presenca"
      eyebrow="Reservas"
      action={canSendCheckinQr(context.profile.role) ? <QrBulkSender /> : undefined}
    />
  );
}
