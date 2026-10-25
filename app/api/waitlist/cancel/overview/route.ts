import { handleWaitlistCancelOverview } from "@/lib/waitlist/signup";
import { waitlistCancelGate, waitlistClient, waitlistJson } from "@/lib/waitlist/signup-http";

/**
 * O que a página do link de cancelamento mostra. POST, e não GET, para o token
 * viajar no corpo — nunca na URL, onde iria para log de acesso.
 */
export async function POST(request: Request) {
  const gate = waitlistCancelGate(request);
  if (!gate.deps) return gate.response;
  const body: unknown = await request.json().catch(() => null);
  return waitlistJson(await handleWaitlistCancelOverview(gate.deps, body, waitlistClient(request)));
}
