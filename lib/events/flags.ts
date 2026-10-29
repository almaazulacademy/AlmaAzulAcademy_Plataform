/**
 * Interruptores da seção de Eventos Especiais no site.
 *
 * `EVENTS_PUBLIC_ENABLED=true` expõe `/eventos`, `/eventos/[slug]`, o item do
 * menu e o destaque da home. Desligada (o padrão), essas rotas respondem 404 e
 * nada de evento aparece. Mesmo ligada, só aparece evento publicado no banco —
 * e publicar exige o interruptor `special_event_settings.publication_enabled`.
 *
 * `BOOKING_OPEN` é o botão de reserva da página do evento. Fica desligado até
 * a fase 5 integrar o fluxo de reserva: o botão aparece, mas não leva ao
 * checkout.
 *
 * A prévia com dados de demonstração (`/eventos/demonstracao`) existe só no
 * desenvolvimento local e no Preview da Vercel, nunca em Production, e não
 * lê nem grava nada no banco.
 */

export function isEventsPublicEnabled(env: Record<string, string | undefined> = process.env) {
  return env.EVENTS_PUBLIC_ENABLED === "true";
}

export function isEventsDemoEnabled(env: Record<string, string | undefined> = process.env) {
  if (env.VERCEL_ENV) return env.VERCEL_ENV === "preview";
  return env.NODE_ENV === "development";
}

/** Fase 4: o botão "Garantir minha vaga" ainda não leva ao checkout. */
export const EVENT_BOOKING_OPEN = false;
