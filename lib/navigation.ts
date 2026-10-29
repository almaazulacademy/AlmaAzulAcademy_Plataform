/**
 * Itens do menu principal. Módulo puro: lido pela Navbar e pelos testes.
 *
 * "Eventos" entra logo depois de "Experiências", só quando o servidor decide
 * que há evento publicado com a seção ligada (`components/layout/navbar.tsx`).
 */

export type NavLink = { label: string; href: string };

const baseLinks: NavLink[] = [
  { label: "Experiências", href: "/experiencias" },
  { label: "Bases", href: "/bases" },
  { label: "Quem Somos", href: "/quem-somos" },
  { label: "Acompanhar reserva", href: "/acompanhar-reserva" },
];

export const EVENTS_LINK: NavLink = { label: "Eventos", href: "/eventos" };

export function navbarLinks(showEvents: boolean): NavLink[] {
  return showEvents ? [baseLinks[0], EVENTS_LINK, ...baseLinks.slice(1)] : baseLinks;
}
