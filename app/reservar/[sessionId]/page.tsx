import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { WhatsappFloatButton } from "@/components/layout/whatsapp-float-button";
import { ReservationForm } from "@/components/reservation/reservation-form";
import { getBookingSession } from "@/lib/reservations/data";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Reservar experiência" };
export const dynamic = "force-dynamic";

export default async function ReservePage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const supabase = getSupabaseServerClient();
  let session = null;
  if (supabase && /^[0-9a-f-]{36}$/i.test(sessionId)) {
    try { session = await getBookingSession(supabase, sessionId); } catch (error) { console.error("Falha ao carregar sessão:", error instanceof Error ? error.message : "erro desconhecido"); }
  }

  return (
    <main className="min-h-screen bg-paper pt-24">
      <Navbar />
      <div className="container py-12 sm:py-16 lg:py-24">
        <Link href="/imersao-paranoa#reservas" className="mb-8 inline-flex items-center gap-2 text-sm font-semibold text-forest"><ArrowLeft className="size-4" />Voltar para as datas</Link>
        {session ? <ReservationForm session={session} /> : (
          <div className="rounded-4xl bg-white p-10 text-center sm:p-16"><h1 className="text-4xl font-medium tracking-[-0.05em]">Sessão indisponível</h1><p className="mx-auto mt-4 max-w-lg leading-7 text-ink/55">A data pode ter esgotado ou não estar mais aberta. Confira as próximas sessões disponíveis.</p><Link href="/imersao-paranoa#reservas" className="mt-7 inline-flex font-semibold text-forest">Ver próximas datas</Link></div>
        )}
      </div>
      <Footer />
      <WhatsappFloatButton />
    </main>
  );
}
