import Image from "next/image";
import { CalendarDays, Check, Clock, DoorOpen, MapPin, Ticket, Users } from "lucide-react";

import { BaseLocationCard } from "@/components/bases/base-location";
import { EditorialImage } from "@/components/editorial-image";
import { AvailabilityBadge, EventCtaButton, EventDemoBanner, EventEyebrow } from "@/components/events/event-parts";
import { eventDisplayFont } from "@/components/events/fonts";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { infoParagraphs, visibleInfoItems } from "@/lib/events/editorial";
import { clockText, deadlineShortText } from "@/lib/events/policy";
import { eventCta, eventDayLabel, eventLongDate, eventPrice, eventScheduleLabel, programItemTime, spotsLabel } from "@/lib/events/presentation";
import type { PublicEvent } from "@/lib/events/public";
import { cn } from "@/lib/utils";

function joinHosts(hosts: string[]) {
  if (hosts.length <= 1) return hosts.join("");
  return `${hosts.slice(0, -1).join(", ")} e ${hosts[hosts.length - 1]}`;
}

/**
 * Página de um evento especial. Tudo vem do evento cadastrado — conteúdo
 * editorial, sessão e base —; nada é específico de um evento. `preview` mostra
 * a faixa de demonstração e as informações ainda pendentes.
 */
export function EventPage({ event, preview = false, bookingOpen = false, waitlistOpen = false }: { event: PublicEvent; preview?: boolean; bookingOpen?: boolean; waitlistOpen?: boolean }) {
  const content = event.editorial;
  const extra = content.event;
  const { session } = event;
  // A prévia (sem sessão de verdade) mostra o botão da lista sem levar a lugar nenhum.
  const waitlistHref = !waitlistOpen ? null : preview ? "#reserva" : session.id ? `/lista-de-espera/${session.id}` : null;
  const cta = eventCta({ availability: session.availability, sessionId: session.id, ctaLabel: extra.reservation.ctaLabel, bookingOpen, waitlistHref });
  // Hero e barra do celular levam à seção de reserva; com a lista, dizem "Evento esgotado".
  const anchorLabel = cta.kind === "WAITLIST" ? cta.title : cta.label;
  const info = visibleInfoItems(extra, preview);
  const spots = spotsLabel(session.availability, session.remainingSpots);
  const day = session.startsAt ? eventDayLabel(session.startsAt) : null;
  const time = session.startsAt ? eventScheduleLabel(extra.scheduleLabel, session.startsAt, session.durationMinutes) : null;
  const place = `${event.location.baseName} · Brasília`;

  return (
    <main className={cn(eventDisplayFont.variable, "bg-night pb-28 text-white lg:pb-0")}>
      <Navbar overlay />

      {/* 1. Hero */}
      <section className="relative isolate flex min-h-[100svh] items-end overflow-hidden">
        <Image src={content.hero.image.src} alt={content.hero.image.alt} fill priority sizes="100vw" className={cn("object-cover", extra.heroImageMobile && "hidden sm:block")} />
        {extra.heroImageMobile ? (
          <Image src={extra.heroImageMobile.src} alt={extra.heroImageMobile.alt} fill priority sizes="100vw" className="object-cover sm:hidden" />
        ) : null}
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(13,21,20,0.6)_0%,rgba(13,21,20,0.45)_35%,rgba(13,21,20,0.94)_100%)] sm:bg-[linear-gradient(180deg,rgba(13,21,20,0.55)_0%,rgba(13,21,20,0.25)_35%,rgba(13,21,20,0.92)_100%)]" />
        <div className="container relative z-10 pb-16 pt-40 sm:pb-24">
          <div className="max-w-4xl animate-fade-up [text-shadow:0_2px_24px_rgba(0,0,0,0.35)]">
            {preview ? <EventDemoBanner /> : null}
            <EventEyebrow>{extra.badge}</EventEyebrow>
            <h1 className="mt-6 font-event text-[clamp(2.75rem,11vw,9.5rem)] font-extrabold uppercase leading-[0.88] tracking-[-0.02em]">
              {content.hero.title}
            </h1>
            <p className="mt-4 font-event text-lg font-bold uppercase tracking-[0.18em] text-ember sm:text-2xl">{extra.subtitle}</p>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-white/85 sm:text-xl">{extra.tagline}</p>
            {extra.highlights.length ? (
              <p className="mt-4 text-sm font-medium text-white/70 sm:text-base">{extra.highlights.join("  •  ")}</p>
            ) : null}
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm font-semibold uppercase tracking-[0.12em] text-white/80">
              {day ? <span className="flex items-center gap-2"><CalendarDays aria-hidden="true" className="size-4 text-ember" />{day}</span> : null}
              {time ? <span className="flex items-center gap-2"><Clock aria-hidden="true" className="size-4 text-ember" />{time}</span> : null}
              <span className="flex items-center gap-2"><MapPin aria-hidden="true" className="size-4 text-ember" />{place}</span>
            </div>
            <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center">
              <a href="#reserva" className={cn("inline-flex h-14 items-center justify-center rounded-full px-8 font-event text-sm font-bold uppercase tracking-[0.08em] transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white", cta.kind === "UNAVAILABLE" || cta.kind === "WAITLIST" ? "border border-white/40 text-white" : "bg-ember text-night")}>
                {anchorLabel}
              </a>
              <a href="#programacao" className="inline-flex h-14 items-center justify-center rounded-full border border-white/40 px-8 text-sm font-semibold text-white transition-colors hover:bg-white hover:text-night focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
                Ver a programação
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* 2. Apresentação */}
      <section className="relative py-24 sm:py-32" aria-labelledby="evento-intro">
        <div className="container grid items-center gap-14 lg:grid-cols-[1.05fr_0.95fr] lg:gap-20">
          <div className="reveal-on-scroll">
            {extra.intro.eyebrow ? <EventEyebrow>{extra.intro.eyebrow}</EventEyebrow> : null}
            <h2 id="evento-intro" className="mt-6 font-event text-4xl font-extrabold uppercase leading-[0.95] sm:text-6xl">{extra.intro.title}</h2>
            <div className="mt-8 space-y-6 text-lg leading-8 text-white/75 sm:text-xl sm:leading-9">
              {extra.intro.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            </div>
          </div>
          {extra.intro.image ? (
            <div className="relative aspect-[4/5] overflow-hidden rounded-[2rem] sm:aspect-[5/4] lg:aspect-[4/5]">
              <EditorialImage src={extra.intro.image.src} alt={extra.intro.image.alt} sizes="(min-width: 1024px) 45vw, 100vw" className="object-cover" />
            </div>
          ) : null}
        </div>
      </section>

      {/* 3. Programação */}
      <section id="programacao" className="scroll-mt-24 border-t border-white/10 py-24 sm:py-32" aria-labelledby="evento-programacao">
        <div className="container">
          {extra.program.eyebrow ? <EventEyebrow>{extra.program.eyebrow}</EventEyebrow> : null}
          <h2 id="evento-programacao" className="mt-6 max-w-3xl font-event text-4xl font-extrabold uppercase leading-[0.95] sm:text-6xl">{extra.program.title}</h2>
          <ol className="mt-16 space-y-16 sm:mt-20 sm:space-y-24">
            {extra.program.items.map((item, index) => (
              <li key={`${item.time}-${item.title}`} className={cn("grid items-center gap-8 lg:gap-16", item.image && "lg:grid-cols-2")}>
                <div className={cn("relative border-l border-ember/40 pl-6 sm:pl-10", item.image && index % 2 === 1 && "lg:order-2")}>
                  <span aria-hidden="true" className="absolute -left-[5px] top-3 size-[9px] rounded-full bg-ember" />
                  <p className="inline-flex rounded-md bg-ember px-3 py-1.5 font-event text-lg font-extrabold uppercase text-night sm:text-xl">
                    {item.time && !item.timeLabel ? <time>{programItemTime(item).toUpperCase()}</time> : programItemTime(item).toUpperCase()}
                  </p>
                  <h3 className="mt-5 font-event text-2xl font-bold uppercase leading-tight sm:text-4xl">{item.title}</h3>
                  <p className="mt-4 max-w-xl text-lg leading-8 text-white/75">{item.description}</p>
                  {item.hosts.length ? <p className="mt-4 text-sm font-semibold text-white">Com {joinHosts(item.hosts)}.</p> : null}
                  {item.note ? (
                    <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-ember/50 px-4 py-1.5 text-sm font-medium text-ember">
                      <Check aria-hidden="true" className="size-4" />{item.note}
                    </p>
                  ) : null}
                </div>
                {item.image ? (
                  <div className="relative aspect-[4/3] overflow-hidden rounded-[2rem]">
                    <EditorialImage src={item.image.src} alt={item.image.alt} sizes="(min-width: 1024px) 45vw, 100vw" className="object-cover" />
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 4. O que está incluso */}
      <section className="bg-paper py-24 text-ink sm:py-32" aria-labelledby="evento-incluso">
        <div className="container grid gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:gap-20">
          <div>
            {extra.included.eyebrow ? <EventEyebrow tone="dark">{extra.included.eyebrow}</EventEyebrow> : null}
            <h2 id="evento-incluso" className="mt-6 font-event text-4xl font-extrabold uppercase leading-[0.95] text-forest sm:text-5xl">{extra.included.title}</h2>
            {extra.included.description ? <p className="mt-6 max-w-md text-lg leading-8 text-ink/70">{extra.included.description}</p> : null}
            <p className="mt-8 inline-flex items-center gap-3 rounded-full bg-forest px-5 py-3 font-event text-sm font-bold uppercase tracking-[0.08em] text-white">
              <Ticket aria-hidden="true" className="size-5 text-ember" />
              {session.priceCents ? `${eventPrice(session.priceCents)} por pessoa · ingresso único` : "Ingresso único"}
            </p>
          </div>
          <ul className="divide-y divide-ink/10 border-y border-ink/10">
            {extra.included.items.map((item) => (
              <li key={item} className="flex items-center gap-5 py-5 text-lg font-medium sm:text-xl">
                <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-ember/15 text-[#a8611b]">
                  <Check className="size-5" />
                </span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* 5. Quem faz acontecer */}
      {extra.partners.items.length ? (
        <section className="bg-mist py-24 text-ink sm:py-32" aria-labelledby="evento-parceiros">
          <div className="container">
            {extra.partners.eyebrow ? <EventEyebrow tone="dark">{extra.partners.eyebrow}</EventEyebrow> : null}
            <h2 id="evento-parceiros" className="mt-6 max-w-3xl font-event text-4xl font-extrabold uppercase leading-[0.95] text-forest sm:text-5xl">{extra.partners.title}</h2>
            <ul className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-5">
              {extra.partners.items.map((partner) => (
                <li key={partner.name} className="flex flex-col rounded-3xl border border-ink/10 bg-white p-6 shadow-[0_10px_30px_rgba(20,49,44,0.05)]">
                  <div className="relative grid h-24 place-items-center">
                    {partner.logo ? (
                      <Image src={partner.logo.src} alt={partner.logo.alt} fill sizes="240px" className="object-contain" />
                    ) : (
                      <span aria-hidden="true" className="font-event text-2xl font-extrabold uppercase tracking-[0.04em] text-forest">{partner.name}</span>
                    )}
                  </div>
                  <p className="mt-6 font-semibold text-ink">{partner.name}</p>
                  {partner.role ? <p className="mt-1 text-sm leading-6 text-ink/60">{partner.role}</p> : null}
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {/* 6. Local */}
      <section className="bg-paper py-24 text-ink sm:py-28" aria-labelledby="evento-local">
        <div className="container grid items-center gap-10 lg:grid-cols-2">
          <div>
            <EventEyebrow tone="dark">Local</EventEyebrow>
            <h2 id="evento-local" className="mt-6 font-event text-4xl font-extrabold uppercase leading-[0.95] text-forest sm:text-5xl">{event.location.baseName}</h2>
            <p className="mt-6 max-w-md text-lg leading-8 text-ink/70">À beira do Lago Paranoá, em Brasília.</p>
          </div>
          <BaseLocationCard location={event.location} label="Ponto de encontro" />
        </div>
      </section>

      {/* 7. Informações importantes */}
      {info.length ? (
        <section id="informacoes" className="scroll-mt-24 bg-night py-24 sm:py-32" aria-labelledby="evento-info">
          <div className="container">
            {extra.info.eyebrow ? <EventEyebrow>{extra.info.eyebrow}</EventEyebrow> : null}
            <h2 id="evento-info" className="mt-6 font-event text-4xl font-extrabold uppercase leading-[0.95] sm:text-5xl">{extra.info.title}</h2>
            <dl className="mt-12 grid gap-4 lg:grid-cols-2">
              {info.map((item) => (
                <div
                  key={item.title}
                  id={item.id ? `info-${item.id}` : undefined}
                  className={cn(
                    "scroll-mt-28 rounded-3xl border p-6 sm:p-8",
                    item.pending ? "border-dashed border-ember/50 bg-ember/5" : "border-white/10 bg-white/5",
                    // A política com prazo ocupa a linha inteira e ganha o traço âmbar.
                    item.id === "cancelamento" && extra.cancellation && "border-ember/40 lg:col-span-2",
                  )}
                >
                  <dt className="font-event text-base font-bold uppercase tracking-[0.06em] sm:text-lg">{item.title}</dt>
                  <dd className="mt-4 max-w-prose space-y-3 text-base leading-7 text-white/75 sm:text-[1.05rem] sm:leading-8">
                    {infoParagraphs(item.body).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                    {item.pending ? <p className="text-sm font-semibold text-ember">Texto a confirmar antes da publicação.</p> : null}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      ) : null}

      {/* 8. Reserva */}
      <section id="reserva" className="relative isolate scroll-mt-24 overflow-hidden py-24 sm:py-32" aria-labelledby="evento-reserva">
        {extra.reservation.image ? (
          <Image src={extra.reservation.image.src} alt="" fill sizes="100vw" className="-z-10 object-cover" />
        ) : null}
        <div className="absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgba(13,21,20,0.88)_0%,rgba(13,21,20,0.72)_45%,rgba(13,21,20,0.92)_100%)]" />
        <div className="container">
          <div className="max-w-3xl">
            {extra.reservation.eyebrow ? <EventEyebrow>{extra.reservation.eyebrow}</EventEyebrow> : null}
            <h2 id="evento-reserva" className="mt-6 font-event text-4xl font-extrabold uppercase leading-[0.95] sm:text-6xl">{extra.reservation.title}</h2>
            <div className="mt-6"><AvailabilityBadge availability={session.availability} remainingSpots={session.remainingSpots} bookingOpen={bookingOpen} /></div>
            <dl className="mt-10 grid gap-6 border-y border-white/15 py-8 sm:grid-cols-2">
              {day ? <SummaryRow icon={<CalendarDays className="size-5" />} label="Data" value={day} /> : null}
              {time ? <SummaryRow icon={<Clock className="size-5" />} label="Horário" value={time} /> : null}
              <SummaryRow icon={<MapPin className="size-5" />} label="Local" value={place.toUpperCase()} />
              {extra.arrival ? <SummaryRow icon={<DoorOpen className="size-5" />} label="Chegada" value={`TOLERÂNCIA ATÉ ${clockText(extra.arrival.toleranceUntil).toUpperCase()}`} /> : null}
              {spots ? <SummaryRow icon={<Users className="size-5" />} label="Vagas" value={spots.toUpperCase()} /> : null}
              {session.priceCents ? <SummaryRow icon={<Ticket className="size-5" />} label="Investimento" value={`${eventPrice(session.priceCents)} POR PESSOA`} /> : null}
            </dl>
            {session.startsAt ? <p className="mt-6 text-sm text-white/60">Edição de {eventLongDate(session.startsAt)}. {extra.included.items.length ? `Inclui: ${extra.included.items.join(" · ")}.` : ""}</p> : null}
            {extra.cancellation ? (
              <p className="mt-4 text-sm leading-6 text-white/75">
                <span className="font-semibold text-white">Cancelamento até {deadlineShortText(extra.cancellation.deadline)}:</span>{" "}
                {extra.cancellation.summary}.{" "}
                <a href="#info-cancelamento" className="font-semibold text-ember underline-offset-4 hover:underline">Ver a política completa</a>
              </p>
            ) : null}
            <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
              <EventCtaButton cta={cta} />
              {cta.kind === "WAITLIST" ? (
                <p className="max-w-md text-sm leading-6 text-white/75"><span className="block font-event font-bold uppercase tracking-[0.08em] text-white">{cta.title}</span>{cta.note}</p>
              ) : cta.kind !== "BOOK" ? <p className="text-sm text-white/70">{cta.note}</p> : null}
            </div>
          </div>
        </div>
      </section>

      <Footer />

      {/* CTA fixo no celular: fica acima do conteúdo, que ganha espaço embaixo (pb-28). */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-night/95 px-4 py-3 backdrop-blur lg:hidden" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
        <div className="mx-auto flex max-w-xl items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="truncate font-event text-sm font-bold uppercase">{content.hero.title}</p>
            <p className="truncate text-xs text-white/70">{[day, session.priceCents ? `${eventPrice(session.priceCents)}/pessoa` : null].filter(Boolean).join(" · ")}</p>
          </div>
          {cta.kind === "BOOK" ? <EventCtaButton cta={cta} compact /> : (
            <a href="#reserva" className={cn("inline-flex h-12 shrink-0 items-center rounded-full px-5 font-event text-xs font-bold uppercase tracking-[0.08em]", cta.kind === "SOON" ? "bg-ember text-night" : "border border-white/25 text-white/80")}>
              {anchorLabel}
            </a>
          )}
        </div>
      </div>
    </main>
  );
}

function SummaryRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-4">
      <span aria-hidden="true" className="mt-0.5 text-ember">{icon}</span>
      <div>
        <dt className="text-xs font-semibold uppercase tracking-[0.18em] text-white/55">{label}</dt>
        <dd className="mt-1 font-event text-lg font-bold uppercase sm:text-xl">{value}</dd>
      </div>
    </div>
  );
}
