import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { AvailabilityBadge } from "@/components/events/event-parts";
import { eventDisplayFont } from "@/components/events/fonts";
import { eventDayLabel, eventPrice, eventScheduleLabel } from "@/lib/events/presentation";
import type { PublicEvent } from "@/lib/events/public";
import { cn } from "@/lib/utils";

/**
 * Destaque do próximo evento especial na home, logo depois do Hero. Só é
 * renderizado com a seção de eventos ligada e um evento futuro publicado.
 */
export function EventHighlight({ event, bookingOpen }: { event: PublicEvent; bookingOpen: boolean }) {
  const extra = event.editorial.event;
  const image = extra.cardImage ?? event.editorial.hero.image;
  const { session } = event;
  return (
    <section className={cn(eventDisplayFont.variable, "bg-night py-6 text-white sm:py-10")} aria-labelledby="destaque-evento">
      <div className="container">
        <Link
          href={`/eventos/${event.slug}`}
          className="group relative isolate grid overflow-hidden rounded-[2rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember lg:grid-cols-[1.2fr_1fr]"
        >
          <div className="relative min-h-[18rem] lg:min-h-[26rem]">
            <Image src={image.src} alt={image.alt} fill sizes="(min-width: 1024px) 55vw, 100vw" className="object-cover transition-transform duration-700 group-hover:scale-[1.03]" />
          </div>
          <div className="flex flex-col justify-center bg-white/5 p-8 sm:p-12">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-semibold uppercase tracking-[0.22em] text-ember">Evento especial</span>
              <AvailabilityBadge availability={session.availability} remainingSpots={session.remainingSpots} bookingOpen={bookingOpen} />
            </div>
            <h2 id="destaque-evento" className="mt-5 font-event text-5xl font-extrabold uppercase leading-[0.9] sm:text-6xl">{event.editorial.hero.title}</h2>
            <p className="mt-3 font-event text-sm font-bold uppercase tracking-[0.18em] text-ember">{extra.subtitle}</p>
            <p className="mt-5 text-base leading-7 text-white/75">{extra.tagline}</p>
            <p className="mt-6 text-sm font-semibold uppercase tracking-[0.1em] text-white/80">
              {[session.startsAt ? `${eventDayLabel(session.startsAt)} · ${eventScheduleLabel(extra.scheduleLabel, session.startsAt, session.durationMinutes)}` : null, session.priceCents ? `${eventPrice(session.priceCents)} por pessoa` : null].filter(Boolean).join(" · ")}
            </p>
            <span className="mt-8 inline-flex items-center gap-2 font-semibold">
              Conhecer o evento
              <ArrowRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-1" />
            </span>
          </div>
        </Link>
      </div>
    </section>
  );
}
