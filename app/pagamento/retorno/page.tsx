import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, Clock3 } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { WhatsappFloatButton } from "@/components/layout/whatsapp-float-button";
import { buttonVariants } from "@/components/ui/button";
import { confirmPayment } from "@/lib/reservations/payment-confirmation";

export const metadata: Metadata = { title: "Retorno do pagamento", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function PaymentReturnPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const orderId = single(query.order_nsu);
  const transactionId = single(query.transaction_nsu);
  const invoiceSlug = single(query.slug);
  let confirmed = false;
  if (orderId && transactionId && invoiceSlug) {
    try {
      confirmed = await confirmPayment({
        orderId,
        transactionId,
        invoiceSlug,
        receiptUrl: single(query.receipt_url),
        payload: Object.fromEntries(Object.entries(query).map(([key, value]) => [key, single(value)])),
      });
    } catch (error) {
      console.error("Falha no retorno do pagamento:", error instanceof Error ? error.message : "erro desconhecido");
    }
  }

  return (
    <main className="min-h-screen bg-paper pt-24">
      <Navbar />
      <div className="container py-16 sm:py-24">
        <div className="mx-auto max-w-2xl rounded-4xl bg-white p-8 text-center sm:p-14">
          {confirmed ? <CheckCircle2 className="mx-auto size-11 text-lake" /> : <Clock3 className="mx-auto size-11 text-sand" />}
          <h1 className="mt-7 text-4xl font-medium tracking-[-0.05em] sm:text-5xl">{confirmed ? "Pagamento confirmado." : "Estamos validando o pagamento."}</h1>
          <p className="mx-auto mt-5 max-w-lg leading-7 text-ink/60">{confirmed ? "Sua reserva já está confirmada no sistema da Alma Azul Academy." : "A confirmação pode levar alguns instantes. Consulte novamente usando seu CPF e o código da reserva."}</p>
          <Link href="/acompanhar-reserva" className={buttonVariants({ size: "lg", className: "mt-8" })}>Acompanhar reserva</Link>
        </div>
      </div>
      <Footer />
      <WhatsappFloatButton />
    </main>
  );
}
