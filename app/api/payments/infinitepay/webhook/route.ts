import { NextResponse } from "next/server";

import { confirmPayment } from "@/lib/reservations/payment-confirmation";

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request) {
  const payload: unknown = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object") return NextResponse.json({ received: false }, { status: 400 });
  const event = payload as Record<string, unknown>;
  const orderId = stringValue(event.order_nsu);
  const transactionId = stringValue(event.transaction_nsu);
  const invoiceSlug = stringValue(event.invoice_slug ?? event.slug);
  if (!orderId || !transactionId || !invoiceSlug) return NextResponse.json({ received: false }, { status: 400 });

  try {
    const confirmed = await confirmPayment({
      orderId,
      transactionId,
      invoiceSlug,
      receiptUrl: stringValue(event.receipt_url),
      payload: event,
    });
    return NextResponse.json({ received: true, confirmed });
  } catch (error) {
    console.error("Falha ao confirmar webhook InfinitePay:", error instanceof Error ? error.message : "erro desconhecido");
    return NextResponse.json({ received: false }, { status: 400 });
  }
}
