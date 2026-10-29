/**
 * Ligação das rotas públicas da lista de espera com o Next e o Supabase. As
 * decisões ficam em `signup.ts` e no banco; aqui só o que depende do servidor.
 */

import { after, NextResponse } from "next/server";

import { isSameOriginRequest } from "@/lib/admin/http";
import type { RulesQueryClient } from "@/lib/events/booking";
import { isEventsWaitlistEnabled } from "@/lib/events/flags";
import { isEventWaitlistVisible, loadWaitlistTarget, resolveWaitlistScope } from "@/lib/events/waitlist";
import { trustedClientAddress } from "@/lib/http/client-address";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { followUpWaitlistConfirmationEmail, sendWaitlistConfirmationEmail } from "@/lib/waitlist/joined-email-service";
import { isWaitlistSignupEnabled, WAITLIST_MESSAGES, type WaitlistCancelDeps, type WaitlistResponse, type WaitlistSignupDeps } from "@/lib/waitlist/signup";

// Nada daqui fica em cache: depende do token, das vagas e do limite do momento.
const NO_STORE = { "cache-control": "no-store" };

type Gate<T> = { deps: T; response: null } | { deps: null; response: NextResponse };

function refuse(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function rpcOf(admin: NonNullable<ReturnType<typeof getSupabaseAdminClient>>) {
  return (name: string, args: Record<string, unknown>) => admin.rpc(name, args);
}

/**
 * Inscrição, nesta ordem: recurso ligado (senão 404, como se não existisse),
 * origem do próprio site (senão 403) e banco configurado (senão 503).
 *
 * "Ligado" é por tipo: a inscrição regular (`isWaitlistSignupEnabled()`) e a
 * dos eventos (`isEventsWaitlistEnabled()`). Com as duas desligadas, 404 sem
 * tocar no banco. Com uma delas, o `scope` lê o tipo da sessão no banco e
 * recusa com 404 a do tipo desligado — o navegador nunca decide o tipo.
 */
export function waitlistSignupGate(request: Request): Gate<WaitlistSignupDeps> {
  const regularEnabled = isWaitlistSignupEnabled();
  const eventsEnabled = isEventsWaitlistEnabled();
  if (!regularEnabled && !eventsEnabled) return { deps: null, response: refuse(404, { message: "Recurso não disponível." }) };
  if (!isSameOriginRequest(request)) return { deps: null, response: refuse(403, { message: "Origem da solicitação inválida." }) };
  const admin = getSupabaseAdminClient();
  if (!admin) return { deps: null, response: refuse(503, { code: "UNAVAILABLE", message: WAITLIST_MESSAGES.UNAVAILABLE }) };
  const rpc = rpcOf(admin);
  return {
    response: null,
    deps: {
      rpc,
      sendConfirmation: sendWaitlistConfirmationEmail,
      followUpConfirmation: followUpWaitlistConfirmationEmail,
      afterResponse: (task) => after(task),
      scope: (sessionId) => resolveWaitlistScope({
        loadTarget: (id) => loadWaitlistTarget(admin as unknown as RulesQueryClient, id),
        eventVisible: (slug, id) => isEventWaitlistVisible(rpc, slug, id),
        regularEnabled,
        eventsEnabled,
      }, sessionId),
    },
  };
}

/**
 * Cancelamento pelo link. **Não depende da variável**: um link já enviado por
 * e-mail precisa continuar funcionando mesmo que a inscrição seja desligada.
 * Sem um token válido — que só existe em e-mail de confirmação —, nada acontece.
 */
export function waitlistCancelGate(request: Request): Gate<WaitlistCancelDeps> {
  if (!isSameOriginRequest(request)) return { deps: null, response: refuse(403, { message: "Origem da solicitação inválida." }) };
  const admin = getSupabaseAdminClient();
  if (!admin) return { deps: null, response: refuse(503, { code: "UNAVAILABLE", message: WAITLIST_MESSAGES.UNAVAILABLE }) };
  return { response: null, deps: { rpc: rpcOf(admin) } };
}

/** Endereço para o limite por origem: só o gravado pela Vercel. */
export function waitlistClient(request: Request) {
  return trustedClientAddress(request.headers);
}

export function waitlistJson(result: WaitlistResponse) {
  const headers: Record<string, string> = { ...NO_STORE };
  if (result.retryAfterSeconds) headers["retry-after"] = String(result.retryAfterSeconds);
  return NextResponse.json(result.body, { status: result.status, headers });
}
