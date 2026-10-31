import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { BaseLocationCard } from "@/components/bases/base-location";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { WhatsappFloatButton } from "@/components/layout/whatsapp-float-button";
import { SessionTurma } from "@/components/reservation/session-turma";
import { WaitlistSignupForm } from "@/components/waitlist/waitlist-signup-form";
import { getExperiencePlacement, getSessionAvailabilityContext } from "@/lib/bases/data";
import { baseLocation } from "@/lib/bases/location";
import type { RulesQueryClient } from "@/lib/events/booking";
import { getPublicEvent } from "@/lib/events/data";
import { isEventsWaitlistEnabled } from "@/lib/events/flags";
import { eventDayLabel, eventScheduleLabel } from "@/lib/events/presentation";
import type { PublicEvent } from "@/lib/events/public";
import { EVENT_SOLD_OUT_TITLE, loadWaitlistTarget, type WaitlistTarget } from "@/lib/events/waitlist";
import { listPublicSessions } from "@/lib/reservations/data";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase/server";
import { isSessionBookable, type PublicSession } from "@/lib/waitlist/public";
import { isWaitlistSignupEnabled } from "@/lib/waitlist/signup";

export const metadata: Metadata = { title: "Lista de espera", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Inscrição na lista de espera de uma turma.
 *
 * Só existe com a inscrição ligada (senão 404). A turma é lida pela mesma
 * função da agenda (`list_public_sessions`): o formulário só aparece para turma
 * publicada, aberta, futura **e esgotada**. Com vaga, a página manda reservar;
 * qualquer outra coisa, "turma indisponível". O banco confere tudo de novo na
 * inscrição.
 *
 * Cada tipo tem a sua variável: sessão de evento especial só com
 * `EVENTS_WAITLIST_ENABLED` (textos de evento, máximo por pedido do evento,
 * volta para a página dele); sessão regular só com a inscrição regular. O tipo
 * vem do banco, com a service role.
 */
export default async function WaitlistSignupPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const regularEnabled = isWaitlistSignupEnabled();
  const eventsEnabled = isEventsWaitlistEnabled();
  if (!regularEnabled && !eventsEnabled) notFound();
  const { sessionId } = await params;
  const supabase = getSupabaseServerClient();
  const admin = getSupabaseAdminClient();

  // Sem saber o tipo, nada de formulário: "indisponível".
  let target: WaitlistTarget | null | "ERROR" = null;
  if (admin && UUID.test(sessionId)) {
    target = await loadWaitlistTarget(admin as unknown as RulesQueryClient, sessionId).catch(() => "ERROR" as const);
  }
  if (target !== "ERROR" && target?.kind === "EVENT") {
    if (!eventsEnabled) notFound();
    const event = await getPublicEvent(target.slug).catch(() => null);
    return <EventWaitlistPage event={event && event.session.id === sessionId ? event : null} slug={target.slug} maxPerOrder={target.maxPerOrder} />;
  }
  if (!regularEnabled) notFound();

  let session: PublicSession | null = null;
  if (supabase && target !== "ERROR" && UUID.test(sessionId)) {
    const context = await getSessionAvailabilityContext(sessionId).catch(() => null);
    if (context && context.experienceStatus === "PUBLISHED" && context.baseStatus === "ACTIVE") {
      session = await listPublicSessions(supabase, context.experienceSlug)
        .then((sessions) => sessions.find((item) => item.id === sessionId) ?? null)
        .catch(() => null);
    }
  }
  const placement = session ? await getExperiencePlacement(session.experienceSlug).catch(() => null) : null;

  return (
    <main className="min-h-screen bg-paper pt-24">
      <Navbar />
      <div className="container py-12 sm:py-16 lg:py-24">
        <Link href="/agenda" className="mb-8 inline-flex items-center gap-2 text-sm font-semibold text-forest"><ArrowLeft className="size-4" />Voltar para as datas</Link>
        {session && !isSessionBookable(session) ? (
          <div className="grid gap-8 lg:grid-cols-[1fr_0.72fr] lg:items-start lg:gap-12">
            <WaitlistSignupForm sessionId={session.id} experienceSlug={session.experienceSlug} />
            <div className="space-y-6">
              <SessionTurma startsAt={session.startsAt} experienceTitle={session.experienceTitle} label="Turma esgotada" note="Cada turma tem lista de espera própria." />
              {placement ? <BaseLocationCard location={baseLocation(placement.base)} /> : null}
            </div>
          </div>
        ) : session ? (
          <div className="rounded-4xl bg-white p-10 text-center sm:p-16">
            <h1 className="text-4xl font-medium tracking-[-0.05em]">Esta turma tem vagas</h1>
            <p className="mx-auto mt-4 max-w-lg leading-7 text-ink/55">Abriu vaga nesta turma. Não é preciso entrar na lista de espera: você pode reservar agora.</p>
            <Link href={`/reservar/${session.id}`} className="mt-7 inline-flex font-semibold text-forest">Reservar esta turma</Link>
          </div>
        ) : (
          <div className="rounded-4xl bg-white p-10 text-center sm:p-16">
            <h1 className="text-4xl font-medium tracking-[-0.05em]">Turma indisponível</h1>
            <p className="mx-auto mt-4 max-w-lg leading-7 text-ink/55">Esta turma não está aberta para a lista de espera. Confira as próximas datas.</p>
            <Link href="/agenda" className="mt-7 inline-flex font-semibold text-forest">Ver próximas datas</Link>
          </div>
        )}
      </div>
      <Footer />
      <WhatsappFloatButton />
    </main>
  );
}

/** A lista de espera de um evento especial: só com o evento esgotado no site. */
function EventWaitlistPage({ event, slug, maxPerOrder }: { event: PublicEvent | null; slug: string; maxPerOrder: number }) {
  const session = event?.session ?? null;
  const day = session?.startsAt ? eventDayLabel(session.startsAt) : null;
  const time = session?.startsAt && session ? eventScheduleLabel(event?.editorial.event.scheduleLabel, session.startsAt, session.durationMinutes) : null;
  return (
    <main className="min-h-screen bg-paper pt-24">
      <Navbar />
      <div className="container py-12 sm:py-16 lg:py-24">
        <Link href={`/eventos/${slug}`} className="mb-8 inline-flex items-center gap-2 text-sm font-semibold text-forest"><ArrowLeft className="size-4" />Voltar para o evento</Link>
        {event && session?.id && session.availability === "SOLD_OUT" ? (
          <div className="grid gap-8 lg:grid-cols-[1fr_0.72fr] lg:items-start lg:gap-12">
            <WaitlistSignupForm sessionId={session.id} experienceSlug={event.slug} event={{ slug: event.slug, title: event.editorial.hero.title, maxPerOrder }} />
            <div className="space-y-6">
              <div className="rounded-4xl bg-night p-7 text-white sm:p-9">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-ember">{EVENT_SOLD_OUT_TITLE}</p>
                <p className="mt-5 text-3xl font-semibold uppercase tracking-[-0.02em]">{event.editorial.hero.title}</p>
                <p className="mt-2 text-sm font-semibold uppercase tracking-[0.16em] text-white/70">{event.editorial.event.subtitle}</p>
                {day || time ? <p className="mt-6 text-lg font-semibold">{[day, time].filter(Boolean).join(" · ")}</p> : null}
                <p className="mt-4 text-sm leading-6 text-white/70">A lista de espera é desta edição do evento.</p>
              </div>
              <BaseLocationCard location={event.location} />
            </div>
          </div>
        ) : event && session?.availability === "AVAILABLE" ? (
          <div className="rounded-4xl bg-white p-10 text-center sm:p-16">
            <h1 className="text-4xl font-medium tracking-[-0.05em]">Este evento tem vagas</h1>
            <p className="mx-auto mt-4 max-w-lg leading-7 text-ink/55">Surgiu vaga no {event.editorial.hero.title}. Não é preciso entrar na lista de espera: você pode garantir seu ingresso agora.</p>
            <Link href={`/eventos/${event.slug}#reserva`} className="mt-7 inline-flex font-semibold text-forest">Ir para o evento</Link>
          </div>
        ) : (
          <div className="rounded-4xl bg-white p-10 text-center sm:p-16">
            <h1 className="text-4xl font-medium tracking-[-0.05em]">Lista de espera indisponível</h1>
            <p className="mx-auto mt-4 max-w-lg leading-7 text-ink/55">Esta edição do evento não está aberta para a lista de espera.</p>
            <Link href="/eventos" className="mt-7 inline-flex font-semibold text-forest">Ver os eventos</Link>
          </div>
        )}
      </div>
      <Footer />
      <WhatsappFloatButton />
    </main>
  );
}
