import { handleWaitlistCancel } from "@/lib/waitlist/signup";
import { waitlistCancelGate, waitlistClient, waitlistJson } from "@/lib/waitlist/signup-http";

/** Saída da lista de espera, confirmada pelo cliente na página do link. */
export async function POST(request: Request) {
  const gate = waitlistCancelGate(request);
  if (!gate.deps) return gate.response;
  const body: unknown = await request.json().catch(() => null);
  return waitlistJson(await handleWaitlistCancel(gate.deps, body, waitlistClient(request)));
}
