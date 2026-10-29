import { NavbarClient } from "@/components/layout/navbar-client";
import { hasPublishedEvents } from "@/lib/events/data";
import { isEventsPublicEnabled } from "@/lib/events/flags";

/**
 * Navbar do site. A parte interativa (scroll, menu mobile) é `NavbarClient`;
 * aqui, no servidor, só se decide se o item "Eventos" aparece: com
 * `EVENTS_PUBLIC_ENABLED` ligada e pelo menos um evento publicado. Desligada,
 * nem consulta o banco.
 */
export async function Navbar({ overlay = false }: { overlay?: boolean }) {
  const showEvents = isEventsPublicEnabled() && (await hasPublishedEvents().catch(() => false));
  return <NavbarClient overlay={overlay} showEvents={showEvents} />;
}
