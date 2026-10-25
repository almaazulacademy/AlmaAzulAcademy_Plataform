import { NextResponse } from "next/server";

import { authorizeWaitlistAdminApi, isSameOriginRequest } from "@/lib/admin/http";
import { isWaitlistUuid } from "@/lib/admin/waitlist";
import { handleWaitlistRemoval } from "@/lib/admin/waitlist-data";
import { waitlistAdminData } from "@/lib/admin/waitlist-server";

type RouteContext = { params: Promise<{ entryId: string }> };

const NO_STORE = { "cache-control": "no-store" };

/**
 * "Remover da lista de espera".
 *
 * Valida origem, sessão administrativa e payload — motivo e confirmação
 * explícita — e entrega a decisão a `admin_remove_waitlist_entry`, que trava a
 * inscrição, descarta os avisos pendentes e grava a auditoria. O ator vem da
 * sessão, nunca do corpo. Nenhuma reserva, pagamento ou Stand-by é tocado.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403, headers: NO_STORE });
  }
  const authorization = await authorizeWaitlistAdminApi();
  if (!authorization.context) return authorization.response;

  const { entryId } = await context.params;
  if (!isWaitlistUuid(entryId)) return NextResponse.json({ message: "Inscrição inválida." }, { status: 400, headers: NO_STORE });

  const body: unknown = await request.json().catch(() => null);
  try {
    const result = await handleWaitlistRemoval(waitlistAdminData(), authorization.context.profile.userId, entryId, body);
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
  } catch {
    return NextResponse.json({ message: "O painel da lista de espera não está configurado." }, { status: 503, headers: NO_STORE });
  }
}
