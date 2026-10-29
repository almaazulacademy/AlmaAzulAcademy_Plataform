import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EventsIndex } from "@/components/events/events-index";
import { isEventsDemoEnabled } from "@/lib/events/flags";
import { essenciaDemoEvent } from "@/lib/events/fixtures/essencia";
import { parseAvailability } from "@/lib/events/presentation";
import { splitEvents } from "@/lib/events/public";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Prévia · Eventos Especiais", robots: { index: false, follow: false } };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Prévia da listagem com o ESSÊNCIA de demonstração (`lib/events/fixtures`).
 * Só no desenvolvimento local e no Preview da Vercel; em Production, 404.
 * Não lê nem grava nada no banco. `?estado=SOLD_OUT|CLOSED|ENDED` muda a
 * situação; `?vazio=1` mostra a seção sem eventos.
 */
export default async function EventsDemoPage({ searchParams }: Props) {
  if (!isEventsDemoEnabled()) notFound();
  const query = await searchParams;
  const events = query.vazio === "1" ? [] : [essenciaDemoEvent(parseAvailability(query.estado ?? "AVAILABLE"))];
  const { upcoming, past } = splitEvents(events);
  return <EventsIndex upcoming={upcoming} past={past} preview hrefFor={(event) => `/eventos/demonstracao/${event.slug}${query.estado ? `?estado=${String(query.estado)}` : ""}`} />;
}
