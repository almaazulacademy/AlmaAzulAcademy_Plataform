import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EventPage } from "@/components/events/event-page";
import { getPublicEvent } from "@/lib/events/data";
import { isEventBookingOpen, isEventsPublicEnabled, isEventsWaitlistEnabled } from "@/lib/events/flags";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  if (!isEventsPublicEnabled()) return { title: "Página não encontrada", robots: { index: false, follow: false } };
  const event = await getPublicEvent((await params).slug);
  if (!event) return { title: "Evento não encontrado", robots: { index: false, follow: false } };
  const { seo, hero } = event.editorial;
  return {
    title: { absolute: `${seo.title} | Alma Azul Academy` },
    description: seo.description,
    alternates: { canonical: `/eventos/${event.slug}` },
    openGraph: { title: seo.title, description: seo.description, images: [hero.image.src], type: "website" },
    twitter: { card: "summary_large_image", title: seo.title, description: seo.description, images: [hero.image.src] },
  };
}

/** Página de um evento especial publicado. Desligada a seção, ou evento inexistente: 404. */
export default async function SpecialEventPage({ params }: Props) {
  if (!isEventsPublicEnabled()) notFound();
  const event = await getPublicEvent((await params).slug);
  if (!event) notFound();
  return <EventPage event={event} bookingOpen={isEventBookingOpen()} waitlistOpen={isEventsWaitlistEnabled()} />;
}
