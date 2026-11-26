import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron/authorization";
import { drainLastMinuteAlerts } from "@/lib/reservations/last-minute-alert-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Somente POST: acionado pelo agendador autenticado, sem expor reservas. */
export async function POST(request: Request) {
  const secret = process.env.LAST_MINUTE_ALERTS_CRON_SECRET;
  if (!secret?.trim()) return NextResponse.json({ message: "Rotina não configurada." }, { status: 503 });
  if (!isAuthorizedCronRequest(request, secret)) return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
  const report = await drainLastMinuteAlerts();
  return NextResponse.json(report, { status: report.outcome === "FAILED" ? 503 : 200, headers: { "cache-control": "no-store" } });
}
