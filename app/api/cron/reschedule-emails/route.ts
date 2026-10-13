import { NextResponse } from "next/server";

import { isAuthorizedCronRequest } from "@/lib/cron/authorization";
import { retryPendingRescheduleConfirmationEmails } from "@/lib/reservations/reschedule-email-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Recuperação dos e-mails de reagendamento, sozinha.
 *
 * **Nenhuma rotina agendada chama esta rota hoje**: ela não está em
 * `vercel.json`. A recuperação diária continua em `/api/cron/confirmation-emails`,
 * que roda esta mesma função logo depois da do e-mail de pagamento.
 *
 * Existe para que um agendamento mais frequente — se e quando for aprovado —
 * acione só esta fila, sem mexer na cadência do e-mail de pagamento. Mesma
 * autenticação das outras rotinas: sem `CRON_SECRET` responde 503 e não faz
 * nada. GET é o verbo do Vercel Cron; POST serve a um agendador externo.
 *
 * Rodar duas vezes não duplica e-mail: quem decide o envio é a reivindicação no
 * banco, que respeita o envio em curso, a espera entre tentativas e o teto.
 */
async function run(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ message: "Rotina não configurada." }, { status: 503 });
  }
  if (!isAuthorizedCronRequest(request, secret)) {
    return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
  }

  const report = await retryPendingRescheduleConfirmationEmails();
  // Só contadores. Nenhum e-mail, nome ou código de reserva na resposta.
  return NextResponse.json(
    { outcome: report.outcome, processed: report.processed, sent: report.sent, errorCode: report.errorCode },
    { status: report.outcome === "FAILED" ? 503 : 200 },
  );
}

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
