import { LAGO_NORTE_SLUG, type PublicBase } from "./types.ts";

/**
 * Localização de uma base: a fonte única do que o cliente lê sobre "onde é".
 *
 * Os dados vivem em `public.bases` (address, meeting_point, maps_url) e chegam
 * aqui por dois caminhos — a base do catálogo público ou o payload das RPCs de
 * e-mail e de check-in, que resolvem reserva → sessão → experiência → base.
 * Site, e-mail de confirmação, lembrete do QR e ingresso de check-in montam o
 * texto a partir daqui, então não existe um segundo endereço para divergir.
 *
 * Módulo puro, sem imports de aplicação: é lido pelo Next e pelos testes.
 */
export type BaseLocation = {
  baseSlug: string;
  baseName: string;
  /** Onde o grupo se encontra ("Em frente ao Cápsula Bar — Concha Acústica"). */
  meetingPoint: string | null;
  address: string | null;
  /** Link oficial do Google Maps. null = a base ainda não tem um link conferido. */
  mapsUrl: string | null;
};

/** Texto do botão de localização, igual no site e nos e-mails. */
export const MAPS_BUTTON_LABEL = "Como chegar — Google Maps";

/**
 * Lago Norte, a base de origem.
 *
 * Usado só quando o banco não informa a base da reserva — isto é, antes de a
 * migration `202610080001_capsula_bar_launch.sql` ser aplicada, quando toda
 * reserva existente é do Lago Norte. Com a migration aplicada, a base sempre
 * vem do banco e este valor não é consultado.
 */
export const LAGO_NORTE_LOCATION: BaseLocation = {
  baseSlug: LAGO_NORTE_SLUG,
  baseName: "Lago Norte",
  meetingPoint: null,
  address: "QL 5 Conjunto 5 - Lago Norte",
  mapsUrl: null,
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/** Só aceita HTTPS: o link vai para dentro de e-mail e de página pública. */
export function safeMapsUrl(value: unknown) {
  const url = text(value);
  if (!/^https:\/\/[^\s"'<>]+$/i.test(url)) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function baseLocation(base: Pick<PublicBase, "slug" | "name" | "address" | "meetingPoint" | "mapsUrl">): BaseLocation {
  return {
    baseSlug: base.slug,
    baseName: base.name,
    meetingPoint: base.meetingPoint,
    address: base.address,
    mapsUrl: safeMapsUrl(base.mapsUrl),
  };
}

/**
 * Lê a localização devolvida pelas RPCs (`baseSlug`, `baseName`, `meetingPoint`,
 * `address`, `mapsUrl`). Sem base no payload devolve null — quem chama decide o
 * que fazer; nunca se deduz a base pelo nome da experiência.
 */
export function parseBaseLocation(value: unknown): BaseLocation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const baseSlug = text(row.baseSlug);
  const baseName = text(row.baseName);
  if (!baseSlug || !baseName) return null;
  return {
    baseSlug,
    baseName,
    meetingPoint: text(row.meetingPoint) || null,
    address: text(row.address) || null,
    mapsUrl: safeMapsUrl(row.mapsUrl),
  };
}

/** Linha principal do local: o ponto de encontro, ou o endereço quando não há um. */
export function locationHeadline(location: BaseLocation) {
  return location.meetingPoint ?? location.address ?? location.baseName;
}

/** Endereço como linha secundária — só quando já não é a linha principal. */
export function locationAddressLine(location: BaseLocation) {
  return location.meetingPoint && location.address ? location.address : null;
}

/**
 * Link de mapa de uma base: o oficial quando existe; senão, uma busca pelo
 * endereço (comportamento anterior da página do Lago Norte).
 */
export function locationMapLink(location: BaseLocation) {
  if (location.mapsUrl) return { href: location.mapsUrl, official: true as const };
  if (!location.address) return null;
  return {
    href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${location.address}, Brasília - DF`)}`,
    official: false as const,
  };
}
