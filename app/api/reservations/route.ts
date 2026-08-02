import { NextResponse } from "next/server";

import { getPaymentProvider } from "@/lib/payments";
import { validateReservationInput } from "@/lib/reservations/validation";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

type CreatedReservation = {
  reservationId: string;
  publicCode: string;
  expiresAt: string;
  quantity: number;
  totalCents: number;
  experienceTitle: string;
};

function isCreatedReservation(value: unknown): value is CreatedReservation {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.reservationId === "string"
    && typeof item.publicCode === "string"
    && typeof item.expiresAt === "string"
    && Number.isInteger(Number(item.quantity))
    && Number.isInteger(Number(item.totalCents));
}

function publicOrigin(request: Request) {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return new URL(configured).origin;
  return new URL(request.url).origin;
}

function reservationError(message: string) {
  if (message.includes("INSUFFICIENT_SPOTS")) return { status: 409, message: "Não há vagas suficientes para essa quantidade." };
  if (message.includes("SESSION_UNAVAILABLE")) return { status: 409, message: "Essa sessão não está mais disponível." };
  return { status: 500, message: "Não foi possível criar a pré-reserva." };
}

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const validation = validateReservationInput(body);
  if (!validation.success) return NextResponse.json({ errors: validation.errors }, { status: 400 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ message: "Sistema de reservas ainda não configurado." }, { status: 503 });

  const input = validation.data;
  const creation = await admin.rpc("create_pre_reservation", {
    p_session_id: input.sessionId,
    p_full_name: input.fullName,
    p_cpf: input.cpf,
    p_phone: input.phone,
    p_email: input.email,
    p_quantity: input.quantity,
    p_notes: input.notes ?? "",
    p_idempotency_key: input.idempotencyKey,
  });
  if (creation.error) {
    const error = reservationError(creation.error.message);
    return NextResponse.json({ message: error.message }, { status: error.status });
  }
  if (!isCreatedReservation(creation.data)) return NextResponse.json({ message: "Resposta inválida ao criar reserva." }, { status: 500 });

  const created = creation.data;
  const existing = await admin.from("reservations").select("checkout_url").eq("id", created.reservationId).maybeSingle();
  if (existing.data?.checkout_url) {
    return NextResponse.json({ ...created, checkoutUrl: existing.data.checkout_url });
  }

  try {
    const provider = getPaymentProvider();
    const origin = publicOrigin(request);
    const checkout = await provider.createCheckout({
      orderId: created.reservationId,
      description: created.experienceTitle || "Experiência Alma Azul Academy",
      quantity: created.quantity,
      unitPriceCents: Math.round(created.totalCents / created.quantity),
      customer: { name: input.fullName, email: input.email, phone: input.phone },
      returnUrl: `${origin}/pagamento/retorno`,
      webhookUrl: `${origin}/api/payments/infinitepay/webhook`,
    });
    const attachment = await admin.rpc("attach_payment_checkout", {
      p_reservation_id: created.reservationId,
      p_provider: provider.name,
      p_provider_reference: checkout.providerReference ?? "",
      p_checkout_url: checkout.checkoutUrl,
    });
    if (attachment.error || attachment.data !== true) throw new Error("Não foi possível vincular o checkout.");
    return NextResponse.json({ ...created, checkoutUrl: checkout.checkoutUrl }, { status: 201 });
  } catch (error) {
    await admin.rpc("cancel_pre_reservation", { p_reservation_id: created.reservationId });
    console.error("Falha ao gerar checkout:", error instanceof Error ? error.message : "erro desconhecido");
    return NextResponse.json({ message: "Não foi possível iniciar o pagamento. Nenhuma vaga ficou bloqueada." }, { status: 502 });
  }
}
