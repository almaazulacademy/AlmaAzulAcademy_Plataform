import { clientAddress, handleSelfServiceOverview } from "@/lib/reservations/standby-self-service";
import { selfServiceGate, selfServiceJson } from "@/lib/reservations/standby-self-service-http";

/**
 * Autoatendimento do Stand-by: o que o cliente vê.
 *
 * POST, e não GET, para a credencial (CPF + código, ou o token do link) viajar
 * no corpo — nunca na URL, onde iria para log de acesso e histórico. Cada
 * chamada conta no limite de tentativas antes de qualquer consulta.
 */
export async function POST(request: Request) {
  const gate = selfServiceGate(request);
  if (!gate.deps) return gate.response;
  const body: unknown = await request.json().catch(() => null);
  return selfServiceJson(await handleSelfServiceOverview(gate.deps, body, clientAddress(request.headers)));
}
