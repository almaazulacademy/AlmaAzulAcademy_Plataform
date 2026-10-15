import { NextResponse } from "next/server";

import { trustedClientAddress } from "@/lib/http/client-address";
import { lookupReservation } from "@/lib/reservations/data";
import { handlePublicLookup } from "@/lib/reservations/public-lookup";
import { validateLookupInput } from "@/lib/reservations/validation";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

/**
 * Consulta pública da reserva por CPF + código. O limite de tentativas e a
 * consulta ficam em `handlePublicLookup`; aqui só o que depende do servidor.
 */
export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);

  const admin = getSupabaseAdminClient();
  if (!admin) {
    // A ordem de sempre: formato inválido é 400 mesmo sem banco configurado.
    const validation = validateLookupInput(body);
    if (!validation.success) return NextResponse.json({ errors: validation.errors }, { status: 400 });
    return NextResponse.json({ message: "Sistema de reservas ainda não configurado." }, { status: 503 });
  }

  const result = await handlePublicLookup(
    {
      rpc: (name, args) => admin.rpc(name, args),
      lookup: (cpf, publicCode) => lookupReservation(admin, cpf, publicCode),
      logFailure: (symbol) => console.error("Falha ao recuperar reserva:", symbol),
    },
    body,
    trustedClientAddress(request.headers),
  );
  const headers: Record<string, string> = {};
  if (result.retryAfterSeconds) headers["retry-after"] = String(result.retryAfterSeconds);
  return NextResponse.json(result.body, { status: result.status, headers });
}
