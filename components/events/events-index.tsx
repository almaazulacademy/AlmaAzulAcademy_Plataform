import Image from "next/image";
import Link from "next/link";
import { Sunrise } from "lucide-react";

import { EventCard } from "@/components/events/event-card";
import { EventDemoBanner, EventEyebrow } from "@/components/events/event-parts";
import { eventDisplayFont } from "@/components/events/fonts";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { WhatsappFloatButton } from "@/components/layout/whatsapp-float-button";
import { buttonVariants } from "@/components/ui/button";
import type { PublicEvent } from "@/lib/events/public";
import { cn } from "@/lib/utils";

/** Foto do Hero da seção: o Lago Paranoá visto do Cápsula Bar ao entardecer. */
const SECTION_IMAGE = {
  src: "/images/bases/concha-acustica/capsula-lago-por-do-sol-desktop.webp",
  alt: "Lago Paranoá visto do Cápsula Bar, com o céu colorido sobre a água",
};

/**
 * `/eventos`: Hero da seção, próximos eventos, edições anteriores e um estado
 * vazio quando nada está publicado. `hrefFor` decide o link de cada card (a
 * prévia aponta para a rota de demonstração).
 */
export function EventsIndex({
  upcoming,
  past,
  preview = false,
  hrefFor = (event) => `/eventos/${event.slug}`,
}: {
  upcoming: PublicEvent[];
  past: PublicEvent[];
  preview?: boolean;
  hrefFor?: (event: PublicEvent) => string;
}) {
  const [featured, ...others] = upcoming;
  return (
    <main className={cn(eventDisplayFont.variable, "bg-night text-white")}>
      <Navbar overlay />

      <section className="relative isolate flex min-h-[78svh] items-end overflow-hidden">
        <Image src={SECTION_IMAGE.src} alt={SECTION_IMAGE.alt} fill priority sizes="100vw" className="object-cover" />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(13,21,20,0.55)_0%,rgba(13,21,20,0.3)_40%,rgba(13,21,20,0.95)_100%)]" />
        <div className="container relative z-10 pb-16 pt-40 sm:pb-24">
          <div className="max-w-4xl animate-fade-up [text-shadow:0_2px_24px_rgba(0,0,0,0.35)]">
            {preview ? <EventDemoBanner /> : null}
            <EventEyebrow>Alma Azul Academy</EventEyebrow>
            <h1 className="mt-6 font-event text-[clamp(3rem,10vw,7.5rem)] font-extrabold uppercase leading-[0.9]">Eventos Especiais</h1>
            <p className="mt-8 max-w-2xl text-lg leading-8 text-white/80 sm:text-xl">
              Encontros em datas únicas que vão além da remada: movimento, natureza e pessoas reunidas em manhãs e tardes pensadas do começo ao fim, muitas vezes ao lado de marcas parceiras.
            </p>
          </div>
        </div>
      </section>

      <section className="py-20 sm:py-28" aria-labelledby="proximos-eventos">
        <div className="container">
          <EventEyebrow>Próximos eventos</EventEyebrow>
          <h2 id="proximos-eventos" className="sr-only">Próximos eventos</h2>
          {featured ? (
            <div className="mt-10 space-y-6">
              <EventCard event={featured} href={hrefFor(featured)} featured />
              {others.length ? (
                <div className="grid gap-6 lg:grid-cols-2">
                  {others.map((event) => <EventCard key={event.id} event={event} href={hrefFor(event)} />)}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="mt-10 rounded-[2rem] border border-white/10 bg-white/5 px-6 py-16 text-center sm:px-16 sm:py-24">
              <Sunrise aria-hidden="true" className="mx-auto size-10 text-ember" />
              <p className="mt-6 font-event text-3xl font-extrabold uppercase sm:text-4xl">Novos encontros em breve</p>
              <p className="mx-auto mt-5 max-w-xl text-lg leading-8 text-white/70">
                Ainda não há um evento especial com data marcada. Enquanto isso, as experiências da agenda acontecem toda semana.
              </p>
              <Link href="/experiencias" className={cn(buttonVariants({ variant: "light", size: "lg" }), "mt-8")}>Ver as experiências</Link>
            </div>
          )}
        </div>
      </section>

      {past.length ? (
        <section className="border-t border-white/10 py-20 sm:py-28" aria-labelledby="edicoes-anteriores">
          <div className="container">
            <EventEyebrow>Edições anteriores</EventEyebrow>
            <h2 id="edicoes-anteriores" className="mt-6 font-event text-3xl font-extrabold uppercase sm:text-5xl">Já aconteceu por aqui</h2>
            <div className="mt-10 grid gap-6 lg:grid-cols-2">
              {past.map((event) => <EventCard key={event.id} event={event} href={hrefFor(event)} />)}
            </div>
          </div>
        </section>
      ) : null}

      <Footer />
      <WhatsappFloatButton />
    </main>
  );
}
