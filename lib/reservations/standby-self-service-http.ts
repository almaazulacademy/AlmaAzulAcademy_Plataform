/**
 * Ligação das rotas públicas do autoatendimento com o Next, o Supabase, o
 * e-mail da etapa 4 e a planilha. As decisões ficam em
 * `standby-self-service.ts` e no banco; aqui só o que depende do servidor.
 */

import { after, NextResponse } from "next/server";

import { isSameOriginRequest } from "@/lib/admin/http";
import { syncReservationSessionChange } from "@/lib/integrations/google-sheets/service";
import { followUpRescheduleConfirmationEmail, sendRescheduleConfirmationEmail } from "@/lib/reservations/reschedule-email-service";
import {
  isStandbySelfServiceEnabled,
  SELF_SERVICE_MESSAGES,
  type SelfServiceDeps,
  type SelfServiceResponse,
} from "@/lib/reservations/standby-self-service";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

// Nada destas respostas pode ficar em cache: elas dependem da credencial e das
// vagas do momento.
const NO_STORE = { "cache-control": "no-store" };

/**
 * Barreiras comuns às duas rotas, nesta ordem: recurso ligado (senão 404, como
 * se não existisse), origem do próprio site (senão 403) e banco configurado.
 */
export function selfServiceGate(request: Request): { deps: SelfServiceDeps; response: null } | { deps: null; response: NextResponse } {
  if (!isStandbySelfServiceEnabled()) {
    return { deps: null, response: NextResponse.json({ message: "Recurso não disponível." }, { status: 404, headers: NO_STORE }) };
  }
  if (!isSameOriginRequest(request)) {
    return { deps: null, response: NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403, headers: NO_STORE }) };
  }
  const admin = getSupabaseAdminClient();
  if (!admin) {
    return { deps: null, response: NextResponse.json({ code: "UNAVAILABLE", message: SELF_SERVICE_MESSAGES.UNAVAILABLE }, { status: 503, headers: NO_STORE }) };
  }
  return {
    response: null,
    deps: {
      rpc: (name, args) => admin.rpc(name, args),
      sendConfirmationEmail: sendRescheduleConfirmationEmail,
      followUpConfirmationEmail: followUpRescheduleConfirmationEmail,
      syncSheet: syncReservationSessionChange,
      afterResponse: (task) => after(task),
    },
  };
}

export function selfServiceJson(result: SelfServiceResponse) {
  const headers: Record<string, string> = { ...NO_STORE };
  if (result.retryAfterSeconds) headers["retry-after"] = String(result.retryAfterSeconds);
  return NextResponse.json(result.body, { status: result.status, headers });
}
