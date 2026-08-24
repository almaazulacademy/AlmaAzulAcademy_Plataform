import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/auth";
import { adminMutationError } from "@/lib/admin/mutation-errors";

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

export async function authorizeAdminApi() {
  const context = await getAdminContext();
  if (!context) {
    return {
      context: null,
      response: NextResponse.json({ message: "Sessão administrativa inválida ou expirada." }, { status: 401 }),
    };
  }
  return { context, response: null };
}

// Reexportado para os Route Handlers continuarem importando de um lugar só.
export { adminMutationError };
