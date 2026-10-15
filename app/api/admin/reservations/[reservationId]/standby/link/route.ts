import { NextResponse } from "next/server";

import { authorizeStandbyApi, isSameOriginRequest, standbyMutationError } from "@/lib/admin/http";
import { standbyLinkUrl } from "@/lib/admin/standby";
import { generateStandbyLink, revokeStandbyLink } from "@/lib/admin/standby-data";
import { isUuid } from "@/lib/admin/validation";
import { isStandbySelfServiceEnabled } from "@/lib/reservations/standby-self-service";
import { SITE_URL } from "@/lib/site";

type RouteContext = { params: Promise<{ reservationId: string }> };

// O token aparece uma única vez, nesta resposta. Nada aqui o registra: nem log,
// nem auditoria, nem cache.
const NO_STORE = { "cache-control": "no-store" };

/**
 * "Gerar link": cria o link individual da reserva em Stand-by, ou substitui o
 * anterior — que deixa de valer na hora. O admin copia e compartilha por conta
 * própria; nenhuma mensagem é enviada por este handler.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const authorization = await authorizeStandbyApi();
  if (!authorization.context) return authorization.response;

  const { reservationId } = await context.params;
  if (!isUuid(reservationId)) return NextResponse.json({ message: "Reserva inválida." }, { status: 400 });

  try {
    const link = await generateStandbyLink(authorization.context.profile.userId, reservationId);
    if (!link) return NextResponse.json({ message: "Reserva não encontrada." }, { status: 404, headers: NO_STORE });
    return NextResponse.json(
      { success: true, url: standbyLinkUrl(SITE_URL, link.token), createdAt: link.createdAt, selfServiceEnabled: isStandbySelfServiceEnabled() },
      { headers: NO_STORE },
    );
  } catch (error) {
    const failure = standbyMutationError(error);
    return NextResponse.json({ message: failure.message }, { status: failure.status, headers: NO_STORE });
  }
}

/** "Revogar link": apaga o hash. O link que estava com o cliente para de funcionar. */
export async function DELETE(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ message: "Origem da solicitação inválida." }, { status: 403 });
  }
  const authorization = await authorizeStandbyApi();
  if (!authorization.context) return authorization.response;

  const { reservationId } = await context.params;
  if (!isUuid(reservationId)) return NextResponse.json({ message: "Reserva inválida." }, { status: 400 });

  try {
    const revoked = await revokeStandbyLink(authorization.context.profile.userId, reservationId);
    return NextResponse.json({ success: true, revoked });
  } catch (error) {
    const failure = standbyMutationError(error);
    return NextResponse.json({ message: failure.message }, { status: failure.status });
  }
}
