import { NextResponse } from "next/server";

import { isAuthorizedCronRequest } from "@/lib/cron/authorization";
import { reconcilePendingPayments } from "@/lib/reservations/payment-reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * A rotina fala com a InfinitePay uma vez por reserva do lote. Com o teto de 25
 * reservas e o timeout de 8s por chamada, o pior caso realista fica bem abaixo
 * disso — mas o limite explícito evita que uma degradação do gateway derrube a
 * execução no meio.
 */
export const maxDuration = 60;

/**
 * Camada 3 da confirmação: reconciliação automática.
 *
 * Confere na InfinitePay o estado real do pagamento das reservas em risco —
 * prestes a vencer, em janela de segurança, recém-expiradas, ou com sinal de
 * pagamento sem confirmação. **Não depende de webhook e não depende de o cliente
 * voltar ao site.**
 *
 * **GET é o método que importa**: é assim que o Vercel Cron invoca o caminho
 * declarado em `vercel.json`, e o segredo chega sozinho no cabeçalho
 * `Authorization: Bearer <CRON_SECRET>` assim que a variável existe no projeto.
 * POST é aceito para acionamento manual e para agendadores externos.
 *
 * Sem `CRON_SECRET` a rota responde 503 e não faz nada: um endpoint público sem
 * como se autenticar não deve executar trabalho.
 *
 * A entrega do cron da Vercel é *best effort* — uma execução pode ser perdida ou
 * repetida. Nada aqui depende de execução única: a reivindicação acontece no
 * banco com `for update skip locked`, e a confirmação já é idempotente.
 */
async function run(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ message: "Rotina não configurada." }, { status: 503 });
  }
  if (!isAuthorizedCronRequest(request, secret)) {
    return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
  }

  const report = await reconcilePendingPayments();
  const status = report.outcome === "FAILED" ? 503 : 200;

  // Só contadores. Nenhum identificador de reserva, nome ou valor na resposta.
  return NextResponse.json(
    {
      outcome: report.outcome,
      processed: report.processed,
      confirmed: report.confirmed,
      released: report.released,
      held: report.held,
      incidents: report.incidents,
      errorCode: report.errorCode,
    },
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
