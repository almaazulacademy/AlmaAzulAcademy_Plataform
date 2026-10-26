import { NextResponse } from "next/server";

import { isAuthorizedCronRequest } from "@/lib/cron/authorization";
import { sendPendingWaitlistSpotNotices } from "@/lib/waitlist/spot-email-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Envio dos avisos de vaga da lista de espera.
 *
 * **Nenhuma rotina agendada chama esta rota hoje.** Ela existe para o
 * agendamento da fase 6 — o recomendado é o pg_cron do Supabase, por `pg_net`,
 * a cada minuto (`supabase/maintenance/waitlist_notify_schedule.sql`, não
 * aplicado). Mesma autenticação das outras rotinas: sem `CRON_SECRET` responde
 * 503 e não faz nada; com o segredo errado, 401. GET para agendadores que só
 * fazem GET, POST para o `net.http_post` do pg_cron.
 *
 * Desligada (`WAITLIST_NOTIFY_ENABLED`), responde DISABLED sem tocar no banco.
 * Rodar duas vezes ao mesmo tempo não duplica e-mail: o banco entrega cada
 * aviso a uma execução só, e confere a vaga de novo antes de cada envio.
 */
async function run(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ message: "Rotina não configurada." }, { status: 503 });
  }
  if (!isAuthorizedCronRequest(request, secret)) {
    return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
  }

  const report = await sendPendingWaitlistSpotNotices();
  // Só contadores. Nenhum e-mail, nome ou turma na resposta.
  return NextResponse.json(
    { outcome: report.outcome, processed: report.processed, sent: report.sent, errorCode: report.errorCode },
    { status: report.outcome === "FAILED" ? 503 : 200, headers: { "cache-control": "no-store" } },
  );
}

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
