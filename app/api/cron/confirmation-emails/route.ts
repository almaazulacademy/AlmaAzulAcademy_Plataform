import { NextResponse } from "next/server";

import { isAuthorizedCronRequest } from "@/lib/cron/authorization";
import { retryPendingConfirmationEmails } from "@/lib/reservations/confirmation-email-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rotina agendada de recuperação dos e-mails de confirmação.
 *
 * Existe para que um envio que falhou não fique esperando a próxima reserva
 * confirmada aparecer.
 *
 * **GET é o método que importa**: é assim que o Vercel Cron invoca o caminho
 * declarado em `vercel.json`, e o segredo chega sozinho no cabeçalho
 * `Authorization: Bearer <CRON_SECRET>` assim que a variável existe no projeto.
 * POST é aceito para acionamento manual e para agendadores externos que
 * prefiram esse verbo — os dois passam pela mesma autenticação e chamam a mesma
 * função interna.
 *
 * Sem `CRON_SECRET` configurado a rota responde 503 e não faz nada: um endpoint
 * público sem como se autenticar não deve executar trabalho.
 *
 * A Vercel documenta que a entrega do cron é *best effort* — uma execução pode
 * ser perdida ou repetida. Nada aqui depende de execução única: a reivindicação
 * no banco é que decide quem envia, então rodar duas vezes não duplica e-mail
 * nenhum.
 */
async function run(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ message: "Rotina não configurada." }, { status: 503 });
  }
  if (!isAuthorizedCronRequest(request, secret)) {
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

/** Chamada do Vercel Cron. */
export async function GET(request: Request) {
  return run(request);
}

/** Acionamento manual ou por agendador externo. Mesma autenticação, mesma função. */
export async function POST(request: Request) {
  return run(request);
}
