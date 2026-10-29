import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EventsIndex } from "@/components/events/events-index";
import { listPublicEvents } from "@/lib/events/data";
import { isEventsPublicEnabled } from "@/lib/events/flags";
import { splitEvents } from "@/lib/events/public";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  if (!isEventsPublicEnabled()) return { title: "Página não encontrada", robots: { index: false, follow: false } };
  return {
    title: "Eventos Especiais",
    description: "Encontros em datas únicas da Alma Azul Academy: movimento, natureza e experiências que vão além da remada, em Brasília.",
    alternates: { canonical: "/eventos" },
  };
}

/** Desligada `EVENTS_PUBLIC_ENABLED`, a seção não existe (404). */
export default async function EventsPage() {
  if (!isEventsPublicEnabled()) notFound();
  const { upcoming, past } = splitEvents(await listPublicEvents());
  return <EventsIndex upcoming={upcoming} past={past} />;
}
