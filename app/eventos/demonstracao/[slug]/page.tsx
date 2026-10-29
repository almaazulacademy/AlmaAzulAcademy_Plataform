import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EventPage } from "@/components/events/event-page";
import { isEventsDemoEnabled } from "@/lib/events/flags";
import { ESSENCIA_CAPACITY, ESSENCIA_SLUG, essenciaDemoEvent } from "@/lib/events/fixtures/essencia";
import { parseAvailability } from "@/lib/events/presentation";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Prévia · ESSÊNCIA", robots: { index: false, follow: false } };

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Prévia da página do ESSÊNCIA com os dados de demonstração. Só no
 * desenvolvimento local e no Preview; em Production, 404. O botão de reserva
 * nunca leva ao checkout aqui. `?estado=` e `?vagas=` mudam a situação;
 * `?lista=1` mostra o botão da lista de espera do evento esgotado, sem destino.
 */
export default async function EventDemoPage({ params, searchParams }: Props) {
  if (!isEventsDemoEnabled()) notFound();
  if ((await params).slug !== ESSENCIA_SLUG) notFound();
  const query = await searchParams;
  const spots = Number(query.vagas);
  const event = essenciaDemoEvent(parseAvailability(query.estado ?? "AVAILABLE"), Number.isInteger(spots) && spots > 0 ? Math.min(spots, ESSENCIA_CAPACITY) : ESSENCIA_CAPACITY);
  return <EventPage event={event} preview bookingOpen={false} waitlistOpen={query.lista === "1"} />;
}
