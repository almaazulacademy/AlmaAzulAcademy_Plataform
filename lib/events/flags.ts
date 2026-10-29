/**
 * Interruptores da seção de Eventos Especiais no site.
 *
 * `EVENTS_PUBLIC_ENABLED=true` expõe `/eventos`, `/eventos/[slug]`, o item do
 * menu e o destaque da home. Desligada (o padrão), essas rotas respondem 404 e
 * nada de evento aparece. Mesmo ligada, só aparece evento publicado no banco —
 * e publicar exige o interruptor `special_event_settings.publication_enabled`.
 *
 * `EVENT_BOOKING_OPEN=true` abre a venda de ingressos de eventos: o botão da
 * página leva a `/reservar/[sessionId]` e `POST /api/reservations` aceita
 * sessões de evento. Só vale junto com `EVENTS_PUBLIC_ENABLED`. Desligada (o
 * padrão), nenhum caminho público inicia uma reserva de evento — nem com o id
 * da sessão em mãos. Não ligar antes do e-mail de evento (etapa 5B) validado.
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

export function isEventBookingOpen(env: Record<string, string | undefined> = process.env) {
  return env.EVENT_BOOKING_OPEN === "true" && isEventsPublicEnabled(env);
}
