import { handleWaitlistSignup } from "@/lib/waitlist/signup";
import { waitlistClient, waitlistJson, waitlistSignupGate } from "@/lib/waitlist/signup-http";

/**
 * Inscrição gratuita na lista de espera de uma turma esgotada.
 *
 * Não cria reserva, não bloqueia vaga e não cobra nada: grava a inscrição e a
 * confirmação na fila (`waitlist_join`), e o e-mail sai depois da resposta.
 */
export async function POST(request: Request) {
  const gate = waitlistSignupGate(request);
  if (!gate.deps) return gate.response;
  const body: unknown = await request.json().catch(() => null);
  return waitlistJson(await handleWaitlistSignup(gate.deps, body, waitlistClient(request)));
}
