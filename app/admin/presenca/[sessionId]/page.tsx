import { notFound } from "next/navigation";

import { AttendanceBoard } from "@/components/admin/attendance/attendance-board";
import { AdminErrorState } from "@/components/admin/states";
import { requireAdmin } from "@/lib/admin/auth";
import { isUuid } from "@/lib/admin/validation";
import { getAttendanceSession } from "@/lib/checkin/data";
import { checkinErrorResponse } from "@/lib/checkin/parse";
import { isCheckinToken } from "@/lib/checkin/token";

export const metadata = { title: "Lista de Presença" };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function AttendanceSessionPage({ params, searchParams }: {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const context = await requireAdmin();
  const { sessionId } = await params;
  if (!isUuid(sessionId)) notFound();
  const query = await searchParams;
  const initialToken = typeof query.qr === "string" && isCheckinToken(query.qr) ? query.qr.toLowerCase() : null;

  try {
    const session = await getAttendanceSession(context.profile.userId, sessionId);
    if (!session) notFound();
    return <AttendanceBoard session={session} initialToken={initialToken} />;
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    return <AdminErrorState title="Não foi possível carregar a turma." description={checkinErrorResponse(error).message} />;
  }
}
