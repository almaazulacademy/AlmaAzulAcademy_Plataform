import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { retryPendingConfirmationEmails } from "@/lib/reservations/confirmation-email-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rotina agendada de recuperação dos e-mails de confirmação.
 *
 * Existe para que um envio que falhou não fique esperando a próxima reserva
 * confirmada aparecer. Chamada pelo Vercel Cron, mas funciona com qualquer
 * agendador que envie o cabeçalho `Authorization: Bearer <CRON_SECRET>`.
 *
 * Sem `CRON_SECRET` configurado a rota responde 503 e não faz nada: é o
 * comportamento correto para um endpoint sem como se autenticar.
 *
 * Não há risco de duplicidade mesmo se o agendador disparar duas vezes: quem
 * não reivindica o job não envia, e job concluído nunca é reivindicado.
 */
function authorized(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;

  const header = request.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (offered.length !== secret.length) return false;

  // Comparação de tempo constante: um `===` vazaria o segredo por temporização.
  return timingSafeEqual(Buffer.from(offered), Buffer.from(secret));
}

async function run(request: Request) {
  if (!process.env.CRON_SECRET?.trim()) {
    return NextResponse.json({ message: "Rotina não configurada." }, { status: 503 });
  }
  if (!authorized(request)) {
    return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
  }

  const report = await retryPendingConfirmationEmails();
  const status = report.outcome === "FAILED" ? 503 : 200;

  // Só contadores. Nenhum e-mail, nome ou código de reserva na resposta.
  return NextResponse.json(
    { outcome: report.outcome, processed: report.processed, sent: report.sent, errorCode: report.errorCode },
    { status },
  );
}

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
