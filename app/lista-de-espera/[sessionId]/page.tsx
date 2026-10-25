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
import { listPublicSessions } from "@/lib/reservations/data";
import { getSupabaseServerClient } from "@/lib/supabase/server";
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
 */
export default async function WaitlistSignupPage({ params }: { params: Promise<{ sessionId: string }> }) {
  if (!isWaitlistSignupEnabled()) notFound();
  const { sessionId } = await params;
  const supabase = getSupabaseServerClient();

  let session: PublicSession | null = null;
  if (supabase && UUID.test(sessionId)) {
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
