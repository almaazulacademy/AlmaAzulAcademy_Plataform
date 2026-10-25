import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { WhatsappFloatButton } from "@/components/layout/whatsapp-float-button";
import { ReservationForm } from "@/components/reservation/reservation-form";
import { SessionTurma } from "@/components/reservation/session-turma";
import { BaseLocationCard } from "@/components/bases/base-location";
import { SoldOutNotice } from "@/components/waitlist/sold-out-notice";
import { getExperiencePlacement, getSessionAvailabilityContext } from "@/lib/bases/data";
import { baseLocation } from "@/lib/bases/location";
import { getBookingSession, listPublicSessions } from "@/lib/reservations/data";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { isSessionBookable, isWaitlistPublicEnabled, type PublicSession } from "@/lib/waitlist/public";

export const metadata: Metadata = { title: "Reservar experiência", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function ReservePage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const supabase = getSupabaseServerClient();
  const waitlistEnabled = isWaitlistPublicEnabled();
  let session = null;
  if (supabase && /^[0-9a-f-]{36}$/i.test(sessionId)) {
    try { session = await getBookingSession(supabase, sessionId); } catch (error) { console.error("Falha ao carregar sessão:", error instanceof Error ? error.message : "erro desconhecido"); }
  }
  // O formulário nunca aparece com zero vagas. get_booking_session já só devolve
  // turma com vaga; esta conferência é a segunda barreira, na própria página.
  if (session && session.remainingSpots < 1) session = null;
  // Sessão fora da reserva: se ela pertence a uma experiência ou base "em
  // breve", explica isso em vez do genérico "sessão indisponível". Não libera
  // nada — a RPC de pré-reserva continua recusando qualquer experiência não publicada.
  const upcoming = !session && supabase && /^[0-9a-f-]{36}$/i.test(sessionId)
    ? await getSessionAvailabilityContext(sessionId).catch(() => null)
    : null;
  // Local de encontro: sai da base da experiência desta sessão, nunca do nome dela.
  const placement = session ? await getExperiencePlacement(session.experienceSlug).catch(() => null) : null;
  const comingSoon = upcoming && (upcoming.experienceStatus === "COMING_SOON" || upcoming.baseStatus !== "ACTIVE") ? upcoming : null;
  // Turma publicada, aberta e futura, mas sem vaga: com a lista de espera
  // pública ligada, a página diz "Esgotado" em vez de "Sessão indisponível".
  // Só leitura, pela mesma função da agenda; nunca abre o formulário.
  const soldOut: PublicSession | null = waitlistEnabled && supabase && !session && upcoming && !comingSoon && upcoming.experienceStatus === "PUBLISHED"
    ? await listPublicSessions(supabase, upcoming.experienceSlug)
        .then((sessions) => sessions.find((item) => item.id === sessionId && !isSessionBookable(item)) ?? null)
        .catch(() => null)
    : null;

  return (
    <main className="min-h-screen bg-paper pt-24">
      <Navbar />
      <div className="container py-12 sm:py-16 lg:py-24">
        <Link href="/agenda" className="mb-8 inline-flex items-center gap-2 text-sm font-semibold text-forest"><ArrowLeft className="size-4" />Voltar para as datas</Link>
        {session ? (
          <>
            {/* Fica fora do ReservationForm de propósito: assim o horário
                continua na tela depois do envio, enquanto o cliente vê o
                contador e segue para o pagamento. */}
            <SessionTurma
              startsAt={session.startsAt}
              experienceTitle={session.experienceTitle}
              note="Cada turma tem horário e vagas próprios. Confira o horário acima antes de seguir para o pagamento."
              className="mb-8"
            />
            {placement ? <BaseLocationCard location={baseLocation(placement.base)} className="mb-8" /> : null}
            <ReservationForm session={session} waitlistEnabled={waitlistEnabled} />
          </>
        ) : soldOut ? (
          <>
            <SessionTurma
              startsAt={soldOut.startsAt}
              experienceTitle={soldOut.experienceTitle}
              label="Turma esgotada"
              className="mb-8"
            />
            <div className="rounded-4xl bg-white p-10 text-center sm:p-16">
              <h1 className="text-4xl font-medium tracking-[-0.05em]">Esgotado</h1>
              <SoldOutNotice className="mx-auto mt-5 max-w-lg items-center text-center" note="Todas as vagas desta turma já foram reservadas. Nenhuma reserva pode ser feita para ela agora." />
              <div className="mt-7 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <Link href={`/experiencias/${soldOut.experienceSlug}#reservas`} className="inline-flex font-semibold text-forest">Ver outras turmas</Link>
                <Link href="/agenda" className="inline-flex font-semibold text-forest">Ver a agenda</Link>
              </div>
            </div>
          </>
        ) : comingSoon ? (
          <div className="rounded-4xl bg-white p-10 text-center sm:p-16" role="status">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-lake">Em breve · Base {comingSoon.baseName}</p>
            <h1 className="mt-4 text-4xl font-medium tracking-[-0.05em]">Reservas ainda não abertas</h1>
            <p className="mx-auto mt-4 max-w-lg leading-7 text-ink/55">
              {comingSoon.experienceTitle} vai acontecer na Base {comingSoon.baseName}, que ainda não abriu a programação. Nenhuma reserva pode ser feita por enquanto.
            </p>
            <div className="mt-7 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link href={`/bases/${comingSoon.baseSlug}`} className="inline-flex font-semibold text-forest">Conhecer a Base {comingSoon.baseName}</Link>
              <Link href="/agenda" className="inline-flex font-semibold text-forest">Ver datas abertas</Link>
            </div>
          </div>
        ) : (
          <div className="rounded-4xl bg-white p-10 text-center sm:p-16"><h1 className="text-4xl font-medium tracking-[-0.05em]">Sessão indisponível</h1><p className="mx-auto mt-4 max-w-lg leading-7 text-ink/55">A data pode ter esgotado ou não estar mais aberta. Confira as próximas sessões disponíveis.</p><Link href="/agenda" className="mt-7 inline-flex font-semibold text-forest">Ver próximas datas</Link></div>
        )}
      </div>
      <Footer />
      <WhatsappFloatButton />
    </main>
  );
}
