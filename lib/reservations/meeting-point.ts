/**
 * Ponto de encontro nos e-mails das experiências regulares: a foto do local e
 * as orientações de chegada de cada base.
 *
 * Endereço, ponto de encontro e link do mapa continuam vindo de `public.bases`
 * (ver `lib/bases/location.ts`) — aqui fica só o que existe apenas no e-mail.
 * A escolha é sempre pelo slug da base da reserva, nunca pelo nome da
 * experiência, que se repete entre bases.
 *
 * As fotos são JPEG (Outlook não exibe WebP) servidos pelo próprio site, em
 * URL HTTPS absoluta e estável. Trocar uma foto = arquivo com nome novo, para
 * que e-mails já enviados continuem mostrando a imagem que tinham.
 *
 * Módulo puro: entra slug, sai conteúdo. Sem rede, sem banco.
 */

import { LAGO_NORTE_SLUG } from "../bases/types.ts";
import { absoluteUrl } from "../site.ts";

export type MeetingPointPhoto = {
  /** Caminho público, sob `public/`. */
  path: string;
  width: number;
  height: number;
  /** Texto alternativo: é o que aparece quando o cliente bloqueia imagens. */
  alt: string;
};

export const CAPSULA_BAR_SLUG = "concha-acustica";

/** Fotos reais de cada base, enviadas pela equipe em 25/11/2026. */
export const MEETING_POINT_PHOTOS: Readonly<Record<string, MeetingPointPhoto>> = {
  [LAGO_NORTE_SLUG]: {
    path: "/images/email/ponto-de-encontro-lago-norte.jpg",
    width: 1200,
    height: 675,
    alt: "Entrada da Alma Azul Academy no Lago Norte, com o portão de acesso",
  },
  [CAPSULA_BAR_SLUG]: {
    path: "/images/email/ponto-de-encontro-capsula-bar.jpg",
    width: 1200,
    height: 675,
    alt: "Cápsula Bar visto do lago, na orla da Concha Acústica",
  },
};

export function meetingPointPhoto(baseSlug: string) {
  const photo = MEETING_POINT_PHOTOS[baseSlug];
  return photo ? { ...photo, url: absoluteUrl(photo.path) } : null;
}

/**
 * Ponto de encontro do Lago Norte.
 *
 * `bases.meeting_point` do Lago Norte é nulo de propósito (o site mostra só o
 * endereço). No e-mail o cliente precisa saber onde parar: o portão de acesso,
 * que é o que o instrutor abre antes da experiência.
 */
export const LAGO_NORTE_MEETING_POINT = "Portão de entrada da Alma Azul Academy";

/** Orientações de chegada exclusivas do Lago Norte (texto aprovado pela equipe). */
export const LAGO_NORTE_ARRIVAL_TITLE = "Chegada e acesso à Alma Azul Academy";

/** Botão do WhatsApp da equipe: um só por e-mail, no fechamento "Atendimento pelo WhatsApp". */
export const WHATSAPP_BUTTON_LABEL = "Falar com a nossa equipe";
