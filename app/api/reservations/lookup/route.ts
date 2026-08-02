import { NextResponse } from "next/server";

import { lookupReservation } from "@/lib/reservations/data";
import { validateLookupInput } from "@/lib/reservations/validation";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const validation = validateLookupInput(body);
  if (!validation.success) return NextResponse.json({ errors: validation.errors }, { status: 400 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ message: "Sistema de reservas ainda não configurado." }, { status: 503 });

  try {
    const reservation = await lookupReservation(admin, validation.data.cpf, validation.data.publicCode);
    if (!reservation) return NextResponse.json({ message: "Reserva não encontrada. Confira o CPF e o código." }, { status: 404 });
    return NextResponse.json({ reservation });
  } catch (error) {
    console.error("Falha ao recuperar reserva:", error instanceof Error ? error.message : "erro desconhecido");
    return NextResponse.json({ message: "Não foi possível consultar a reserva agora." }, { status: 500 });
  }
}
