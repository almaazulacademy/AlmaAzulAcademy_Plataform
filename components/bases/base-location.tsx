import { MapPin, Navigation } from "lucide-react";

import { locationAddressLine, locationHeadline, locationMapLink, MAPS_BUTTON_LABEL, type BaseLocation } from "@/lib/bases/location";
import { cn } from "@/lib/utils";

/**
 * Link de mapa de uma base. Com link oficial, o botão "Como chegar — Google
 * Maps"; sem ele, a busca pelo endereço que a página da base já oferecia.
 */
export function BaseMapLink({ location, className }: { location: BaseLocation; className?: string }) {
  const link = locationMapLink(location);
  if (!link) return null;
  return (
    <a
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("inline-flex items-center gap-2 text-sm font-semibold text-lake underline-offset-4 hover:underline", className)}
    >
      {link.official ? <MapPin aria-hidden="true" className="size-4" /> : <Navigation aria-hidden="true" className="size-4" />}
      {link.official ? MAPS_BUTTON_LABEL : "Abrir no mapa"}
    </a>
  );
}

/**
 * Local de encontro de uma reserva ou experiência: base, ponto de encontro,
 * endereço e o botão do mapa. Usado no fluxo de reserva, na confirmação, na
 * consulta da reserva e no ingresso de check-in — sempre a partir da base.
 */
export function BaseLocationCard({ location, className, label = "Local de encontro" }: { location: BaseLocation; className?: string; label?: string }) {
  const address = locationAddressLine(location);
  return (
    <div className={cn("rounded-3xl border border-ink/10 bg-white p-5 text-left sm:p-6", className)}>
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-lake">{label} · Base {location.baseName}</p>
      <p className="mt-3 flex items-start gap-2 text-lg font-semibold leading-snug text-forest">
        <MapPin aria-hidden="true" className="mt-1 size-4 shrink-0 text-lake" />
        <span>
          {locationHeadline(location)}
          {address ? <span className="mt-1 block text-base font-normal text-ink/60">{address}</span> : null}
        </span>
      </p>
      <BaseMapLink location={location} className="mt-4" />
    </div>
  );
}
