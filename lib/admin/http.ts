import { NextResponse } from "next/server";

import { getAdminContext, getStaffContext } from "@/lib/admin/auth";
import { canManageTeam } from "@/lib/admin/roles";
import { adminMutationError, standbyMutationError } from "@/lib/admin/mutation-errors";
import { isStandbyAdminEnabled } from "@/lib/admin/standby";
import { isWaitlistAdminEnabled } from "@/lib/admin/waitlist";

export function isSameOriginRequest(request: Request) {
  const originHeader = request.headers.get("origin");
  if (!originHeader) return false;

  let origin: string;
  try {
    origin = new URL(originHeader).origin;
  } catch {
    return false;
  }

  const requestUrl = new URL(request.url);
  const allowed = new Set<string>([requestUrl.origin]);
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host");
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol || requestUrl.protocol.replace(":", "");
  if (host) {
    try {
      allowed.add(new URL(`${protocol}://${host}`).origin);
    } catch {
      return false;
    }
  }
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) {
    try {
      allowed.add(new URL(configured).origin);
    } catch {
      return false;
    }
  }
  return allowed.has(origin);
}

const INVALID_SESSION = "Sessão administrativa inválida ou expirada.";
const FORBIDDEN = "Seu perfil não tem permissão para esta função.";

function denied(status: 401 | 403) {
  return NextResponse.json({ message: status === 401 ? INVALID_SESSION : FORBIDDEN }, { status });
}

/**
 * Rotas administrativas: só ADMIN/OPERATOR. Um instrutor com sessão válida
 * recebe 403 (e não 401), para não ser tratado como sessão expirada.
 */
export async function authorizeAdminApi() {
  const staff = await getStaffContext();
  if (!staff) return { context: null, response: denied(401) };
  const context = await getAdminContext();
  if (!context) return { context: null, response: denied(403) };
  return { context, response: null };
}

/** Gestão da equipe: só ADMIN. */
export async function authorizeTeamManagerApi() {
  const authorization = await authorizeAdminApi();
  if (!authorization.context) return authorization;
  if (!canManageTeam(authorization.context.profile.role)) return { context: null, response: denied(403) };
  return authorization;
}

/** Lista de Presença: qualquer pessoa da equipe com acesso ativo, inclusive instrutor. */
export async function authorizeCheckinApi() {
  const context = await getStaffContext();
  if (!context) return { context: null, response: denied(401) };
  return { context, response: null };
}

// Reexportado para os Route Handlers continuarem importando de um lugar só.
export { adminMutationError, standbyMutationError };

/**
 * Rotas do painel de Stand-by. Enquanto `STANDBY_ADMIN_ENABLED` não for `true`
 * elas respondem 404 antes de qualquer outra coisa — para o mundo, e para o
 * próprio painel, o recurso não existe. Com a variável ligada, valem as mesmas
 * regras das demais rotas administrativas: só ADMIN e OPERATOR; instrutor
 * recebe 403.
 */
export async function authorizeStandbyApi() {
  if (!isStandbyAdminEnabled()) {
    return { context: null, response: NextResponse.json({ message: "Recurso não disponível." }, { status: 404 }) };
  }
  return authorizeAdminApi();
}

/**
 * Rotas do painel da lista de espera. Com `WAITLIST_ADMIN_ENABLED` desligada,
 * 404 antes de qualquer outra coisa. Ligada, as regras das demais rotas
 * administrativas: só ADMIN e OPERATOR; instrutor recebe 403.
 */
export async function authorizeWaitlistAdminApi() {
  if (!isWaitlistAdminEnabled()) {
    return { context: null, response: NextResponse.json({ message: "Recurso não disponível." }, { status: 404 }) };
  }
  return authorizeAdminApi();
}
