import { getPaymentProvider } from "@/lib/payments";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

type PaymentNotification = {
  orderId: string;
  transactionId: string;
  invoiceSlug: string;
  receiptUrl?: string;
  payload: Record<string, unknown>;
};

export async function confirmPayment(notification: PaymentNotification) {
  const admin = getSupabaseAdminClient();
  if (!admin) throw new Error("Supabase administrativo não configurado.");

  const reservationResult = await admin
    .from("reservations")
    .select("id,total_cents,status")
    .eq("id", notification.orderId)
    .maybeSingle();
  if (reservationResult.error || !reservationResult.data) throw new Error("Reserva não encontrada.");
  if (reservationResult.data.status === "CONFIRMED") return true;

  const provider = getPaymentProvider();
  const verified = await provider.verifyPayment({
    orderId: notification.orderId,
    transactionId: notification.transactionId,
    invoiceSlug: notification.invoiceSlug,
    expectedAmountCents: Number(reservationResult.data.total_cents),
  });
  if (!verified.paid) return false;

  const confirmation = await admin.rpc("confirm_reservation_payment", {
    p_reservation_id: notification.orderId,
    p_provider: provider.name,
    p_provider_event_id: verified.transactionId,
    p_amount_cents: verified.amountCents,
    p_receipt_url: verified.receiptUrl ?? notification.receiptUrl ?? "",
    p_payload: { ...notification.payload, payment_check: verified.raw },
  });
  if (confirmation.error) throw new Error(confirmation.error.message);
  return confirmation.data === true;
}
