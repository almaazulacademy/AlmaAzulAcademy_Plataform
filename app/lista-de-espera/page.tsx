import type { Metadata } from "next";

import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { WhatsappFloatButton } from "@/components/layout/whatsapp-float-button";
import { WaitlistCancel } from "@/components/waitlist/waitlist-cancel";

export const metadata: Metadata = { title: "Lista de espera", robots: { index: false, follow: false } };

/**
 * Página do link do e-mail de confirmação: `/lista-de-espera#t=<token>`.
 *
 * Não depende da variável de inscrição: um link já enviado precisa continuar
 * funcionando. Sem token válido — que só existe nesses e-mails — a página só
 * diz "link indisponível".
 */
export default function WaitlistCancelPage() {
  return (
    <main className="min-h-screen bg-paper pt-24">
      <Navbar />
      <div className="container py-12 sm:py-20 lg:py-28"><WaitlistCancel /></div>
      <Footer />
      <WhatsappFloatButton />
    </main>
  );
}
