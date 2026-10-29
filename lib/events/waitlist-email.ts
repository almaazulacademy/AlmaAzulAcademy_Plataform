/**
 * Eventos especiais — etapa 5C-2: e-mails da lista de espera do evento.
 *
 * Mesma fila, mesma reivindicação, mesma chave de idempotência e mesmas
 * tentativas da lista de sempre (`lib/waitlist/joined-email.ts` e
 * `spot-email.ts`). Só muda o **conteúdo**: antes de montar a mensagem, o
 * payload passa por `withWaitlistEventContext`, que lê o tipo da sessão no
 * banco; sessão de evento recebe estes modelos, com "evento" e "ingresso", e o
 * aviso de vaga leva à página do evento (`/eventos/<slug>#reserva`).
 *
 * Falha fechada: sem conseguir ler o tipo, lança `EVENT_CONTEXT_UNAVAILABLE`; com
 * o conteúdo do evento inválido, `waitlistEventOf` devolve `"INVALID"`. Nos dois
 * casos o e-mail fica pendente — nunca sai o modelo das experiências regulares
 * para uma inscrição de evento.
 */

import { validateEventEditorial, type EventContent } from "./editorial.ts";
import type { RulesQueryClient } from "./booking.ts";
import { clockText, sessionStartClock } from "./policy.ts";
import { baseLocation, type BaseLocation } from "../bases/location.ts";
import { CONTACT_EMAIL, INSTAGRAM_HANDLE } from "../contact.ts";
import {
  BRAND,
  emailLayout,
  escapeHtml,
  firstName,
  formatWhatsappNumber,
  highlightCard,
  infoSection,
  paragraph,
} from "../reservations/confirmation-email.ts";
import { formatSessionDate } from "../sessions/date-time.ts";
import { SITE_NAME, SITE_URL } from "../site.ts";
import { waitlistCancelUrl, WAITLIST_CANCEL_LABEL, WAITLIST_CANCEL_NOTE, WAITLIST_CANCEL_TITLE, type WaitlistJoinedEmailData } from "../waitlist/joined-email-content.ts";
import type { WaitlistSpotEmailData } from "../waitlist/spot-email-content.ts";

export const EVENT_CONTEXT_UNAVAILABLE = "EVENT_CONTEXT_UNAVAILABLE";
export const EVENT_EMAIL_NOT_READY = "EVENT_EMAIL_NOT_READY";

type QueryResult = { data: unknown; error: { message: string; code?: string } | null };

function firstRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" ? row as Record<string, unknown> : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Acrescenta ao payload da fila o tipo da sessão e, para evento, o conteúdo, o
 * slug e o local da base. Payload sem `sessionId` volta intacto (o parser de
 * sempre o recusa). Banco sem a coluna `kind`: regular. Outra falha lança.
 */
export async function withWaitlistEventContext(client: RulesQueryClient, payload: unknown): Promise<unknown> {
  if (!isRecord(payload) || typeof payload.sessionId !== "string" || !payload.sessionId) return payload;
  const fail = () => { throw new Error(EVENT_CONTEXT_UNAVAILABLE); };
  try {
    const session: QueryResult = await client.from("sessions").select("experience_id").eq("id", payload.sessionId);
    if (session.error) fail();
    const experienceId = firstRow(session.data)?.experience_id;
    if (typeof experienceId !== "string" || !experienceId) fail();

    const experience: QueryResult = await client.from("experiences").select("kind, slug, editorial_content, base_id").eq("id", experienceId as string);
    if (experience.error) {
      if (experience.error.code === "42703" || /column .*kind.* does not exist/i.test(experience.error.message)) return { ...payload, experienceKind: "REGULAR" };
      fail();
    }
    const row = firstRow(experience.data);
    if (!row) fail();
    if (row!.kind !== "EVENT") return { ...payload, experienceKind: "REGULAR" };

    let location: BaseLocation | null = null;
    if (typeof row!.base_id === "string" && row!.base_id) {
      const base: QueryResult = await client.from("bases").select("slug, name, address, meeting_point, maps_url").eq("id", row!.base_id);
      if (base.error) fail();
      const b = firstRow(base.data);
      if (b) {
        location = baseLocation({
          slug: String(b.slug ?? ""),
          name: String(b.name ?? ""),
          address: typeof b.address === "string" ? b.address : null,
          meetingPoint: typeof b.meeting_point === "string" ? b.meeting_point : null,
          mapsUrl: typeof b.maps_url === "string" ? b.maps_url : null,
        });
      }
    }
    return { ...payload, experienceKind: "EVENT", eventSlug: row!.slug, eventEditorial: row!.editorial_content, eventLocation: location };
  } catch (error) {
    if (error instanceof Error && error.message === EVENT_CONTEXT_UNAVAILABLE) throw error;
    throw new Error(EVENT_CONTEXT_UNAVAILABLE);
  }
}

export type WaitlistEvent = { slug: string; content: EventContent; location: BaseLocation | null; durationMinutes: number };

/** O evento do payload enriquecido; null se a sessão é regular; "INVALID" se o conteúdo não serve. */
export function waitlistEventOf(payload: unknown): WaitlistEvent | "INVALID" | null {
  if (!isRecord(payload) || payload.experienceKind !== "EVENT") return null;
  const slug = typeof payload.eventSlug === "string" ? payload.eventSlug.trim() : "";
  const editorial = validateEventEditorial(payload.eventEditorial);
  if (!slug || !editorial.success) return "INVALID";
  const location = isRecord(payload.eventLocation) ? payload.eventLocation as BaseLocation : null;
  return { slug, content: editorial.data.event, location, durationMinutes: Number(payload.durationMinutes) || 0 };
}

// --- Conteúdo -------------------------------------------------------------------

export const EVENT_WAITLIST_JOINED_INTRO = "Recebemos sua inscrição na lista de espera do evento:";
export const EVENT_WAITLIST_NOT_A_TICKET_TITLE = "Isto não é um ingresso";
export const EVENT_WAITLIST_NOT_A_TICKET_NOTE =
  "A inscrição na lista de espera não é ingresso nem reserva garantida, não bloqueia vagas e não tem nenhuma cobrança. Você não precisa pagar nada agora.";
export const EVENT_WAITLIST_HOW_TITLE = "Se surgir uma vaga";
export const EVENT_WAITLIST_HOW_NOTE =
  "Avisaremos você por e-mail. A vaga continua aberta no site para todos e fica com quem concluir primeiro a compra do ingresso — por isso, se receber o aviso e ainda quiser participar, garanta seu ingresso assim que puder.";

export const EVENT_WAITLIST_SPOT_HEADING = "Surgiu uma vaga no evento";
export const EVENT_WAITLIST_SPOT_INTRO = "Surgiu disponibilidade no evento que você estava esperando na lista de espera:";
export const EVENT_WAITLIST_SPOT_NOT_GUARANTEED_TITLE = "A vaga não está garantida";
export const EVENT_WAITLIST_SPOT_NOT_GUARANTEED_NOTE =
  "A lista de espera não reserva nem bloqueia vagas. Este aviso foi enviado para outras pessoas da lista também, e a disponibilidade pode mudar até a conclusão da compra: a vaga fica com quem concluir primeiro o pagamento.";
export const EVENT_WAITLIST_SPOT_CTA = "Garantir meu ingresso";
export const EVENT_WAITLIST_SPOT_HOW_TITLE = "Como garantir";
export const EVENT_WAITLIST_SPOT_HOW_NOTE =
  "Toque em \"Garantir meu ingresso\", escolha a quantidade de participantes e conclua o pagamento. O ingresso só é confirmado depois de o pagamento ser aprovado. Se as vagas acabarem antes, nada é cobrado e você continua na lista de espera.";

/** O link do aviso: a seção de reserva da página do evento. */
export function eventWaitlistReserveUrl(slug: string, origin: string = SITE_URL) {
  return `${origin.replace(/\/$/, "")}/eventos/${slug}#reserva`;
}

function participants(quantity: number) {
  return quantity === 1 ? "1 participante" : `${quantity} participantes`;
}

function timeRange(startsAt: string, durationMinutes: number) {
  const start = clockText(sessionStartClock(startsAt));
  if (durationMinutes <= 0) return start;
  return `${start} às ${clockText(sessionStartClock(new Date(new Date(startsAt).getTime() + durationMinutes * 60_000).toISOString()))}`;
}

function placeOf(event: WaitlistEvent, baseName: string) {
  const point = event.location?.meetingPoint || event.location?.baseName || baseName;
  const address = event.location?.address;
  return [point, address].filter(Boolean).join(" — ");
}

function rowsHtml(rows: Array<[string, string]>) {
  return rows
    .map(([label, value]) => `
                      <tr>
                        <td style="padding:10px 0;border-bottom:1px solid ${BRAND.mist};font-size:14px;color:${BRAND.ink};opacity:0.6;">${escapeHtml(label)}</td>
                        <td style="padding:10px 0;border-bottom:1px solid ${BRAND.mist};font-size:15px;font-weight:600;color:${BRAND.ink};text-align:right;">${escapeHtml(value)}</td>
                      </tr>`)
    .join("");
}

function cancelButton(cancelUrl: string) {
  return `
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 0;">
                      <tr><td style="border-radius:999px;border:1px solid ${BRAND.lake};">
                        <a href="${escapeHtml(cancelUrl)}" style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:600;color:${BRAND.lake};text-decoration:none;">${escapeHtml(WAITLIST_CANCEL_LABEL)}</a>
                      </td></tr>
                    </table>`;
}

function footerText() {
  return ["—", `WhatsApp: ${formatWhatsappNumber()}`, `E-mail: ${CONTACT_EMAIL}`, `Instagram: ${INSTAGRAM_HANDLE}`, SITE_URL];
}

function eventRows(title: string, startsAt: string, event: WaitlistEvent, baseName: string, quantity: number, extra: Array<[string, string]> = []): Array<[string, string]> {
  const place = placeOf(event, baseName);
  return [
    ["Evento", title],
    ["Data", formatSessionDate(startsAt)],
    ["Horário", timeRange(startsAt, event.durationMinutes)],
    ...(place ? [["Local", place] as [string, string]] : []),
    ["Participantes", participants(quantity)],
    ...extra,
  ];
}

export function eventWaitlistJoinedSubject(title: string) {
  return `Você está na lista de espera — ${title} | ${SITE_NAME}`;
}

export function buildEventWaitlistJoinedEmail(data: WaitlistJoinedEmailData, event: WaitlistEvent, origin: string = SITE_URL) {
  const subject = eventWaitlistJoinedSubject(data.experienceTitle);
  const greeting = `Olá, ${firstName(data.fullName)}!`;
  const cancelUrl = waitlistCancelUrl(data.cancelToken, origin);
  const rows = eventRows(data.experienceTitle, data.startsAt, event, data.baseName, data.quantity);

  const text = [
    greeting, "",
    EVENT_WAITLIST_JOINED_INTRO, "",
    ...rows.map(([label, value]) => `${label}: ${value}`), "",
    EVENT_WAITLIST_NOT_A_TICKET_TITLE.toUpperCase(), EVENT_WAITLIST_NOT_A_TICKET_NOTE, "",
    EVENT_WAITLIST_HOW_TITLE.toUpperCase(), EVENT_WAITLIST_HOW_NOTE, "",
    WAITLIST_CANCEL_TITLE, WAITLIST_CANCEL_NOTE, cancelUrl, "",
    `Equipe ${SITE_NAME}`, "",
    ...footerText(),
  ].join("\n");

  const body = `
              <p style="margin:0 0 6px;font-size:17px;line-height:26px;font-weight:600;color:${BRAND.forest};">${escapeHtml(greeting)}</p>
              <p style="margin:0 0 18px;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.8;">${escapeHtml(EVENT_WAITLIST_JOINED_INTRO)}</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">${rowsHtml(rows)}
              </table>${highlightCard(EVENT_WAITLIST_NOT_A_TICKET_TITLE, "Nenhuma vaga reservada e nenhuma cobrança", EVENT_WAITLIST_NOT_A_TICKET_NOTE)}${infoSection(EVENT_WAITLIST_HOW_TITLE, paragraph(EVENT_WAITLIST_HOW_NOTE))}${infoSection(WAITLIST_CANCEL_TITLE, paragraph(WAITLIST_CANCEL_NOTE) + cancelButton(cancelUrl))}
              <p style="margin:22px 0 0;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.8;">Equipe ${escapeHtml(SITE_NAME)}</p>`;

  const html = emailLayout({ title: subject, preheader: EVENT_WAITLIST_NOT_A_TICKET_NOTE, heading: "Você está na lista de espera", body });
  return { to: data.email, subject, html, text };
}

export function eventWaitlistSpotSubject(title: string) {
  return `Surgiu uma vaga: ${title} | ${SITE_NAME}`;
}

export function buildEventWaitlistSpotEmail(data: WaitlistSpotEmailData, event: WaitlistEvent, origin: string = SITE_URL) {
  const subject = eventWaitlistSpotSubject(data.experienceTitle);
  const greeting = `Olá, ${firstName(data.fullName)}!`;
  const reserveUrl = eventWaitlistReserveUrl(event.slug, origin);
  const cancelUrl = waitlistCancelUrl(data.cancelToken, origin);
  const price = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(data.priceCents / 100);
  const rows = eventRows(data.experienceTitle, data.startsAt, event, data.baseName, data.quantity, [["Ingresso", `${price} por participante`]]);

  const text = [
    greeting, "",
    EVENT_WAITLIST_SPOT_INTRO, "",
    ...rows.map(([label, value]) => `${label}: ${value}`), "",
    EVENT_WAITLIST_SPOT_NOT_GUARANTEED_TITLE.toUpperCase(), EVENT_WAITLIST_SPOT_NOT_GUARANTEED_NOTE, "",
    `${EVENT_WAITLIST_SPOT_CTA.toUpperCase()}: ${reserveUrl}`, "",
    EVENT_WAITLIST_SPOT_HOW_TITLE.toUpperCase(), EVENT_WAITLIST_SPOT_HOW_NOTE, "",
    WAITLIST_CANCEL_TITLE, WAITLIST_CANCEL_NOTE, cancelUrl, "",
    `Equipe ${SITE_NAME}`, "",
    ...footerText(),
  ].join("\n");

  const button = `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 20px;">
                <tr><td style="border-radius:999px;background-color:${BRAND.forest};">
                  <a href="${escapeHtml(reserveUrl)}" style="display:inline-block;padding:14px 26px;font-size:15px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#ffffff;text-decoration:none;">${escapeHtml(EVENT_WAITLIST_SPOT_CTA)}</a>
                </td></tr>
              </table>`;

  const body = `
              <p style="margin:0 0 6px;font-size:17px;line-height:26px;font-weight:600;color:${BRAND.forest};">${escapeHtml(greeting)}</p>
              <p style="margin:0 0 18px;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.8;">${escapeHtml(EVENT_WAITLIST_SPOT_INTRO)}</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">${rowsHtml(rows)}
              </table>${highlightCard(EVENT_WAITLIST_SPOT_NOT_GUARANTEED_TITLE, "Quem concluir o pagamento primeiro fica com a vaga", EVENT_WAITLIST_SPOT_NOT_GUARANTEED_NOTE)}${button}${infoSection(EVENT_WAITLIST_SPOT_HOW_TITLE, paragraph(EVENT_WAITLIST_SPOT_HOW_NOTE))}${infoSection(WAITLIST_CANCEL_TITLE, paragraph(WAITLIST_CANCEL_NOTE) + cancelButton(cancelUrl))}
              <p style="margin:22px 0 0;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.8;">Equipe ${escapeHtml(SITE_NAME)}</p>`;

  const html = emailLayout({ title: subject, preheader: EVENT_WAITLIST_SPOT_NOT_GUARANTEED_NOTE, heading: EVENT_WAITLIST_SPOT_HEADING, body });
  return { to: data.email, subject, html, text };
}
