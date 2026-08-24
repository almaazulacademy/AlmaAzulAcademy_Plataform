import { NextResponse } from "next/server";

import { authorizeAdminApi } from "@/lib/admin/http";
import { getAdminReservationSessionOptions } from "@/lib/admin/data";
import { isUuid } from "@/lib/admin/validation";

type RouteContext = { params: Promise<{ reservationId: string }> };

/**
 * Turmas de destino para "Alterar turma".
 *
 * Leitura pura, consultada quando o modal abre — nunca junto com a listagem —
 * porque as vagas restantes mudam a cada confirmação e o número que interessa é
 * o do instante da decisão.
 *
 * Sem verificação de origem, ao contrário das mutações: um GET do mesmo domínio
 * não carrega cabeçalho `Origin`, e não há efeito colateral a proteger. A
 * autorização administrativa continua sendo exigida aqui e no middleware.
 */
export async function GET(_request: Request, context: RouteContext) {
  const authorization = await authorizeAdminApi();
  if (!authorization.context) return authorization.response;

  const { reservationId } = await context.params;
  if (!isUuid(reservationId)) return NextResponse.json({ message: "Reserva inválida." }, { status: 400 });

  try {
    const options = await getAdminReservationSessionOptions(authorization.context.profile.userId, reservationId);
    if (!options) return NextResponse.json({ message: "Reserva não encontrada." }, { status: 404 });
    return NextResponse.json(options);
  } catch {
    return NextResponse.json({ message: "Não foi possível carregar as turmas disponíveis." }, { status: 500 });
  }
}
