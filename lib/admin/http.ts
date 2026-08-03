import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/auth";

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

export function adminMutationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("CAPACITY_BELOW_OCCUPANCY")) {
    return { status: 409, message: "A capacidade não pode ficar abaixo das vagas já ocupadas." };
  }
  if (message.includes("SESSION_EXPERIENCE_LOCKED")) {
    return { status: 409, message: "A experiência não pode ser alterada depois que a sessão recebe reservas." };
  }
  if (message.includes("SESSION_HAS_RESERVATIONS")) {
    return { status: 409, message: "Sessões com histórico de reservas não podem ser excluídas." };
  }
  if (message.includes("SESSION_MUST_BE_FUTURE")) {
    return { status: 400, message: "A nova sessão precisa estar no futuro." };
  }
  if (message.includes("INSUFFICIENT_SPOTS")) {
    return { status: 409, message: "Não há vagas para confirmar essa reserva sem overbooking." };
  }
  if (message.includes("CANCELLED_RESERVATION")) {
    return { status: 409, message: "Uma reserva cancelada não pode ser confirmada." };
  }
  if (message.includes("SESSION_CANCELLED")) {
    return { status: 409, message: "A sessão está cancelada." };
  }
  if (message.includes("duplicate key")) {
    return { status: 409, message: "Já existe um registro com esses dados." };
  }
  if (message.includes("EXPERIENCE_SLUG_EXISTS")) {
    return { status: 409, message: "Já existe uma experiência com esse identificador." };
  }
  if (message.includes("RESERVED_EXPERIENCE_SLUG")) {
    return { status: 409, message: "Esse identificador é reservado pela plataforma." };
  }
  if (message.includes("INCOMPLETE_EDITORIAL_CONTENT")) {
    return { status: 400, message: "Complete o conteúdo editorial obrigatório antes de publicar." };
  }
  if (message.includes("ADMIN_FORBIDDEN")) {
    return { status: 403, message: "Seu acesso administrativo não está ativo." };
  }
  return { status: 500, message: "Não foi possível concluir a operação." };
}
