import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EventPage } from "@/components/events/event-page";
import { editionDemoEvent } from "@/lib/events/edition";
import { getEventEdition } from "@/lib/events/editions";
import { isEventsDemoEnabled } from "@/lib/events/flags";
import { parseAvailability } from "@/lib/events/presentation";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Prévia · Eventos Especiais", robots: { index: false, follow: false } };

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Prévia da página de uma edição registrada em `lib/events/editions.ts`, com os
 * dados de demonstração. Só no desenvolvimento local e no Preview; em
 * Production, 404. Não lê nem grava nada no banco e o botão de reserva nunca
 * leva ao checkout aqui. `?estado=` e `?vagas=` mudam a situação; `?lista=1`
 * mostra o botão da lista de espera do evento esgotado, sem destino.
 */
export default async function EventDemoPage({ params, searchParams }: Props) {
  if (!isEventsDemoEnabled()) notFound();
  const edition = getEventEdition((await params).slug);
  if (!edition) notFound();
  const query = await searchParams;
  const spots = Number(query.vagas);
  const event = editionDemoEvent(edition, parseAvailability(query.estado ?? "AVAILABLE"), Number.isInteger(spots) && spots > 0 ? Math.min(spots, edition.capacity) : edition.capacity);
  return <EventPage event={event} preview bookingOpen={false} waitlistOpen={query.lista === "1"} />;
}
