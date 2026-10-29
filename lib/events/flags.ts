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

/**
 * A confirmação e o aviso de vaga da lista de espera ainda saem com o texto das
 * experiências regulares ("turma"). Até a etapa 5C-2 trazer os e-mails do
 * evento, a inscrição de evento fica fechada **no código**, mesmo com a
 * variável ligada.
 */
export const EVENT_WAITLIST_EMAILS_READY = false;

/**
 * `EVENTS_WAITLIST_ENABLED=true` abre a lista de espera **só dos eventos**:
 * botão "Entrar na lista de espera" no evento esgotado, `/lista-de-espera/[id]`
 * da sessão do evento e a inscrição pela API. Exige a venda do evento aberta
 * (`isEventBookingOpen`). Não depende nem liga `WAITLIST_PUBLIC_ENABLED` /
 * `WAITLIST_SIGNUP_ENABLED`, que continuam valendo só para as experiências
 * regulares. Desligada (o padrão), nenhum caminho inscreve numa sessão de evento.
 */
export function isEventsWaitlistEnabled(env: Record<string, string | undefined> = process.env, emailsReady = EVENT_WAITLIST_EMAILS_READY) {
  return emailsReady && env.EVENTS_WAITLIST_ENABLED === "true" && isEventBookingOpen(env);
}
