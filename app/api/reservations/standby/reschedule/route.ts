import { handleSelfServiceReschedule } from "@/lib/reservations/standby-self-service";
import { selfServiceClient, selfServiceGate, selfServiceJson } from "@/lib/reservations/standby-self-service-http";

// A tentativa imediata do e-mail e as duas seguintes, em segundo plano, cabem
// com folga — o mesmo orçamento da rota do painel.
export const maxDuration = 60;

/**
 * Autoatendimento do Stand-by: confirma a nova data escolhida pelo cliente.
 *
 * O corpo traz a credencial, a autorização que o cliente viu e a turma
 * escolhida — nada mais. Quantidade, valor e pagamento são os da reserva e não
 * mudam; a régua (aberta, futura, publicada, com vagas para o grupo e o mesmo
 * valor por participante) e o uso único são do banco.
 */
export async function POST(request: Request) {
  const gate = selfServiceGate(request);
  if (!gate.deps) return gate.response;
  const body: unknown = await request.json().catch(() => null);
  return selfServiceJson(await handleSelfServiceReschedule(gate.deps, body, selfServiceClient(request)));
}
