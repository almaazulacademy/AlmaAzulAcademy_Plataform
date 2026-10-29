import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { WhatsappFloatButton } from "@/components/layout/whatsapp-float-button";
import { ReservationForm } from "@/components/reservation/reservation-form";
import { SessionTurma } from "@/components/reservation/session-turma";
import { BaseLocationCard } from "@/components/bases/base-location";
import { WaitlistJoinLink } from "@/components/waitlist/join-link";
import { SoldOutNotice } from "@/components/waitlist/sold-out-notice";
import { getExperiencePlacement, getSessionAvailabilityContext } from "@/lib/bases/data";
import { baseLocation } from "@/lib/bases/location";
import { eventBookingContext } from "@/lib/events/booking";
import { getPublicEvent } from "@/lib/events/data";
import { isEventBookingOpen, isEventsWaitlistEnabled } from "@/lib/events/flags";
import { EVENT_WAITLIST_CTA, EVENT_WAITLIST_INVITE } from "@/lib/events/waitlist";
import { getBookingSession, listPublicSessions } from "@/lib/reservations/data";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { isSessionBookable, isWaitlistPublicEnabled, type PublicSession } from "@/lib/waitlist/public";
import { isWaitlistSignupEnabled } from "@/lib/waitlist/signup";

export const metadata: Metadata = { title: "Reservar experiência", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function ReservePage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const supabase = getSupabaseServerClient();
  const waitlistEnabled = isWaitlistPublicEnabled();
  const waitlistSignup = isWaitlistSignupEnabled();
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
  // Evento especial publicado: textos de ingresso, local e política do evento,
  // e volta para a página dele. Com a venda fechada, nada de formulário — e a
  // API recusa do mesmo jeito (`POST /api/reservations`).
  const eventSlug = session?.experienceSlug ?? upcoming?.experienceSlug ?? null;
  const event = eventSlug ? await getPublicEvent(eventSlug).catch(() => null) : null;
  const bookingOpen = isEventBookingOpen();
  // Evento esgotado, venda aberta e lista de espera dos eventos ligada: o botão
  // leva à lista desta edição. Nunca abre o formulário de reserva.
  const eventWaitlist = Boolean(event && bookingOpen && isEventsWaitlistEnabled() && event.session.availability === "SOLD_OUT" && event.session.id === sessionId);
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
        {event
          ? <Link href={`/eventos/${event.slug}`} className="mb-8 inline-flex items-center gap-2 text-sm font-semibold text-forest"><ArrowLeft className="size-4" />Voltar para o evento</Link>
          : <Link href="/agenda" className="mb-8 inline-flex items-center gap-2 text-sm font-semibold text-forest"><ArrowLeft className="size-4" />Voltar para as datas</Link>}
        {event ? (
          session && bookingOpen ? (
            <>
              <SessionTurma
                startsAt={session.startsAt}
                experienceTitle={`${event.editorial.hero.title} — ${event.editorial.event.subtitle}`}
                label="Seu ingresso"
                note="Ingresso único com toda a programação do evento. Confira data e horário antes de seguir para o pagamento."
                className="mb-8"
              />
              <BaseLocationCard location={event.location} className="mb-8" />
              <ReservationForm session={session} event={eventBookingContext(event)} />
            </>
          ) : (
            <div className="rounded-4xl bg-white p-10 text-center sm:p-16" role="status">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-lake">Evento especial · {event.editorial.hero.title}</p>
              <h1 className="mt-4 text-4xl font-medium tracking-[-0.05em]">
                {!bookingOpen ? "Reservas ainda não abertas" : event.session.availability === "SOLD_OUT" ? "Evento esgotado" : "Reservas indisponíveis"}
              </h1>
              <p className="mx-auto mt-4 max-w-lg leading-7 text-ink/55">
                {!bookingOpen
                  ? "As reservas deste evento ainda não estão abertas. Nenhuma reserva pode ser feita por enquanto."
                  : event.session.availability === "SOLD_OUT"
                    ? eventWaitlist ? EVENT_WAITLIST_INVITE : "Todas as vagas desta edição foram preenchidas."
                    : "Este ingresso não está disponível para reserva agora."}
              </p>
              {eventWaitlist && event.session.id ? (
                <Link href={`/lista-de-espera/${event.session.id}`} className="mt-7 inline-flex h-12 items-center rounded-full bg-forest px-6 font-semibold text-white">{EVENT_WAITLIST_CTA}</Link>
              ) : null}
              <Link href={`/eventos/${event.slug}`} className={eventWaitlist ? "mt-4 block font-semibold text-forest" : "mt-7 inline-flex font-semibold text-forest"}>Voltar ao evento</Link>
            </div>
          )
        ) : session ? (
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
            <ReservationForm session={session} waitlistEnabled={waitlistEnabled} waitlistSignup={waitlistSignup} />
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
              <SoldOutNotice
                className="mx-auto mt-5 max-w-lg items-center text-center"
                note="Todas as vagas desta turma já foram reservadas. Nenhuma reserva pode ser feita para ela agora."
                action={waitlistSignup ? <WaitlistJoinLink sessionId={soldOut.id} className="mt-2" /> : undefined}
              />
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
