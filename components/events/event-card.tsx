import Link from "next/link";
import { ArrowUpRight, CalendarDays, MapPin } from "lucide-react";

import { EditorialImage } from "@/components/editorial-image";
import { AvailabilityBadge } from "@/components/events/event-parts";
import { eventDayLabel, eventPrice, eventTimeRange } from "@/lib/events/presentation";
import type { PublicEvent } from "@/lib/events/public";
import { cn } from "@/lib/utils";

/** Card de um evento: foto, nome, data, local, preço e situação das vagas. */
export function EventCard({ event, href, bookingOpen, featured = false }: { event: PublicEvent; href: string; bookingOpen: boolean; featured?: boolean }) {
  const extra = event.editorial.event;
  const image = extra.cardImage ?? event.editorial.hero.image;
  const { session } = event;
  return (
    <Link
      href={href}
      className={cn(
        "group relative isolate flex overflow-hidden rounded-[2rem] bg-night text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-4 focus-visible:ring-offset-night",
        featured ? "min-h-[34rem] sm:min-h-[38rem]" : "min-h-[28rem]",
      )}
    >
      <EditorialImage src={image.src} alt={image.alt} sizes={featured ? "100vw" : "(min-width: 1024px) 45vw, 100vw"} className="object-cover transition-transform duration-700 group-hover:scale-[1.03]" />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(13,21,20,0.15)_0%,rgba(13,21,20,0.35)_40%,rgba(13,21,20,0.94)_100%)]" />
      <div className="relative mt-auto w-full p-7 sm:p-10">
        <div className="flex flex-wrap items-center gap-3">
          <AvailabilityBadge availability={session.availability} remainingSpots={session.remainingSpots} bookingOpen={bookingOpen} />
          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-white/70">{extra.badge}</span>
        </div>
        <h3 className={cn("mt-5 font-event font-extrabold uppercase leading-[0.9]", featured ? "text-5xl sm:text-7xl" : "text-4xl sm:text-5xl")}>
          {event.editorial.hero.title}
        </h3>
        <p className="mt-3 font-event text-sm font-bold uppercase tracking-[0.18em] text-ember sm:text-base">{extra.subtitle}</p>
        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-white/80">
          {session.startsAt ? (
            <span className="flex items-center gap-2"><CalendarDays aria-hidden="true" className="size-4 text-ember" />{eventDayLabel(session.startsAt)} · {eventTimeRange(session.startsAt, session.durationMinutes)}</span>
          ) : null}
          <span className="flex items-center gap-2"><MapPin aria-hidden="true" className="size-4 text-ember" />{event.location.baseName}</span>
          {session.priceCents ? <span className="font-semibold text-white">{eventPrice(session.priceCents)} por pessoa</span> : null}
        </div>
        <span className="mt-7 inline-flex items-center gap-2 text-sm font-semibold text-white">
          Conhecer o evento
          <ArrowUpRight aria-hidden="true" className="size-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
        </span>
      </div>
    </Link>
  );
}
