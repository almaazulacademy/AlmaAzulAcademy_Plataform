import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, Clock3, MessageCircle } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { WhatsappFloatButton } from "@/components/layout/whatsapp-float-button";
import { buttonVariants } from "@/components/ui/button";
import { isUuid } from "@/lib/admin/validation";
import { buildWhatsappReservationHelpLink } from "@/lib/contact";
import { normalizeCaptureMethod } from "@/lib/payments/webhook-payload";
import { getReservationExperienceTitle } from "@/lib/reservations/data";
import { confirmPayment } from "@/lib/reservations/payment-confirmation";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

const NEXT_STEPS = [
  "localização;",
  "horário de chegada;",
  "o que levar;",
  "previsão do tempo;",
  "comunicados da experiência.",
];

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
  const invoiceSlug = single(query.slug) || single(query.invoice_slug);
  let confirmed = false;

  // Fallback, não fonte de verdade: os parâmetros da URL só apontam qual pedido
  // consultar. Quem decide se está pago é o payment_check server-to-server dentro
  // de confirmPayment. Se o cliente nunca voltar, o webhook confirma sozinho.
  if (orderId) {
    try {
      const confirmation = await confirmPayment({
        orderId,
        transactionId,
        invoiceSlug,
        captureMethod: normalizeCaptureMethod(single(query.capture_method)),
        receiptUrl: single(query.receipt_url),
        payload: Object.fromEntries(Object.entries(query).map(([key, value]) => [key, single(value)])),
        stage: "return_page",
      });
      confirmed = confirmation.confirmed;
    } catch (error) {
      console.error("Falha no retorno do pagamento:", error instanceof Error ? error.message : "erro desconhecido");
    }
  }

  // Só busca o título depois de confirmar, e só com um UUID válido: evita
  // consulta desnecessária e enumeração por parâmetro arbitrário na URL.
  let experienceTitle = "";
  if (confirmed && isUuid(orderId)) {
    const admin = getSupabaseAdminClient();
    if (admin) {
      try {
        experienceTitle = await getReservationExperienceTitle(admin, orderId);
      } catch {
        experienceTitle = "";
      }
    }
  }
  const whatsappLink = buildWhatsappReservationHelpLink(experienceTitle);

  return (
    <main className="min-h-screen bg-paper pt-24">
      <Navbar />
      <div className="container py-16 sm:py-24">
        <div className="mx-auto max-w-2xl rounded-4xl bg-white p-8 text-center sm:p-14">
          {confirmed ? <CheckCircle2 className="mx-auto size-11 text-lake" aria-hidden="true" /> : <Clock3 className="mx-auto size-11 text-sand" aria-hidden="true" />}
          <h1 className="mt-7 text-4xl font-medium tracking-[-0.05em] sm:text-5xl">{confirmed ? "Pagamento confirmado." : "Estamos validando o pagamento."}</h1>

          {confirmed ? (
            <>
              <p className="mx-auto mt-6 max-w-lg text-lg font-medium leading-8 text-ink">
                Sua reserva foi confirmada com sucesso!
              </p>
              <p className="mx-auto mt-4 max-w-lg leading-7 text-ink/65">
                Obrigado por escolher viver essa experiência com a Alma Azul Academy.
              </p>
              <p className="mx-auto mt-4 max-w-lg leading-7 text-ink/65">
                Em breve nossa equipe irá adicionar você ao grupo oficial da sua experiência, onde enviaremos todas as
                informações importantes, como:
              </p>
              <ul className="mx-auto mt-6 max-w-lg space-y-2 rounded-3xl bg-paper p-6 text-left leading-7 text-ink/70 sm:p-7">
                {NEXT_STEPS.map((step) => (
                  <li key={step} className="flex gap-3">
                    <span aria-hidden="true" className="mt-2.5 size-1.5 shrink-0 rounded-full bg-lake" />
                    {step}
                  </li>
                ))}
              </ul>
              <p className="mx-auto mt-6 max-w-lg leading-7 text-ink/65">
                Caso tenha qualquer dúvida antes disso, estamos à disposição para ajudar.
              </p>
            </>
          ) : (
            <p className="mx-auto mt-5 max-w-lg leading-7 text-ink/60">
              A confirmação pode levar alguns instantes. Consulte novamente usando seu CPF e o código da reserva.
            </p>
          )}

          <div className="mt-9 flex flex-col items-center gap-3">
            <Link href="/acompanhar-reserva" className={buttonVariants({ size: "lg", className: "w-full sm:w-auto" })}>
              Acompanhar reserva
            </Link>
            <a
              href={whatsappLink}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Falar com a equipe da Alma Azul pelo WhatsApp sobre a reserva"
              className={buttonVariants({ variant: "outline", size: "sm", className: "w-full sm:w-auto" })}
            >
              <MessageCircle className="size-4" aria-hidden="true" />
              Falar com a equipe
            </a>
          </div>
        </div>
      </div>
      <Footer />
      <WhatsappFloatButton />
    </main>
  );
}
