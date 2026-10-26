/**
 * Aviso de vaga da lista de espera: assunto, HTML e texto.
 *
 * Função pura, como os outros e-mails, com a mesma moldura. O que ele precisa
 * deixar claro, antes de qualquer outra coisa: **a vaga não está garantida**. A
 * lista não reserva nem bloqueia vaga (opção A); quem concluir primeiro a
 * reserva e o pagamento fica com ela. O botão leva à turma certa, no fluxo
 * normal de reserva (`/reservar/<turma>`), sem atalho nem preço especial.
 */

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
import { CONTACT_EMAIL, INSTAGRAM_HANDLE } from "../contact.ts";
import { formatSessionDate, formatSessionTime } from "../sessions/date-time.ts";
import { SITE_NAME, SITE_URL } from "../site.ts";
import { waitlistCancelUrl, WAITLIST_CANCEL_LABEL, WAITLIST_CANCEL_NOTE, WAITLIST_CANCEL_TITLE } from "./joined-email-content.ts";

export type WaitlistSpotEmailData = {
  fullName: string;
  email: string;
  quantity: number;
  sessionId: string;
  experienceTitle: string;
  startsAt: string;
  baseName: string;
  priceCents: number;
  /** Vagas no momento do envio. Só informativo: podem acabar a qualquer instante. */
  remainingSpots: number;
  cancelToken: string;
};

export type WaitlistSpotEmail = { to: string; subject: string; html: string; text: string };

export const WAITLIST_SPOT_HEADING = "Abriu vaga na sua turma";

export const WAITLIST_SPOT_INTRO = "Abriu vaga na turma que você estava esperando na lista de espera:";

export const WAITLIST_SPOT_NOT_GUARANTEED_TITLE = "A vaga não está garantida";

export const WAITLIST_SPOT_NOT_GUARANTEED_NOTE =
  "A lista de espera não reserva nem bloqueia vagas. Este aviso foi enviado para outras pessoas da lista também, e a vaga continua aberta no site para qualquer cliente: ela fica com quem concluir primeiro a reserva e o pagamento.";

export const WAITLIST_SPOT_HOW_TITLE = "Como garantir";

export const WAITLIST_SPOT_HOW_NOTE =
  "Toque em \"Reservar esta turma\", preencha seus dados e conclua o pagamento. A reserva só é confirmada depois de o pagamento ser aprovado. Se as vagas acabarem antes, nada é cobrado e você continua na lista de espera.";

export const WAITLIST_SPOT_CTA = "Reservar esta turma";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANCEL_TOKEN = /^[0-9a-f]{64}$/;

/** O link do aviso: a turma certa, no fluxo normal de reserva. */
export function waitlistReserveUrl(sessionId: string, origin: string = SITE_URL) {
  return `${origin.replace(/\/$/, "")}/reservar/${sessionId}`;
}

export function waitlistSpotSubject(experienceTitle: string, startsAt: string) {
  return `Abriu vaga: ${experienceTitle}, ${formatSessionDate(startsAt)} às ${formatSessionTime(startsAt)} | ${SITE_NAME}`;
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function parseWaitlistSpotEmailData(value: unknown): WaitlistSpotEmailData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const startsAt = typeof row.startsAt === "string" ? row.startsAt : row.startsAt instanceof Date ? row.startsAt.toISOString() : "";
  const data = {
    fullName: asString(row.fullName),
    email: asString(row.email).toLowerCase(),
    quantity: Number(row.quantity),
    sessionId: asString(row.sessionId),
    experienceTitle: asString(row.experienceTitle),
    startsAt,
    baseName: asString(row.baseName),
    priceCents: Number(row.priceCents),
    remainingSpots: Number(row.remainingSpots),
    cancelToken: asString(row.cancelToken).toLowerCase(),
  };
  if (!data.fullName || !data.email.includes("@") || !data.experienceTitle || !UUID.test(data.sessionId)) return null;
  if (!Number.isInteger(data.quantity) || data.quantity < 1) return null;
  if (!Number.isFinite(data.priceCents) || data.priceCents < 0 || !Number.isInteger(data.remainingSpots)) return null;
  if (!CANCEL_TOKEN.test(data.cancelToken) || Number.isNaN(new Date(data.startsAt).getTime())) return null;
  return data;
}

function participants(quantity: number) {
  return quantity === 1 ? "1 pessoa" : `${quantity} pessoas`;
}

function formatPrice(cents: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

export function buildWaitlistSpotEmail(data: WaitlistSpotEmailData, origin: string = SITE_URL): WaitlistSpotEmail {
  const subject = waitlistSpotSubject(data.experienceTitle, data.startsAt);
  const greeting = `Olá, ${firstName(data.fullName)}!`;
  const reserveUrl = waitlistReserveUrl(data.sessionId, origin);
  const cancelUrl = waitlistCancelUrl(data.cancelToken, origin);
  const rows: Array<[string, string]> = [
    ["Experiência", data.experienceTitle],
    ["Data", formatSessionDate(data.startsAt)],
    ["Horário", formatSessionTime(data.startsAt)],
    ...(data.baseName ? [["Base", data.baseName] as [string, string]] : []),
    ["Você pediu", participants(data.quantity)],
    ["Valor por pessoa", formatPrice(data.priceCents)],
  ];

  const text = [
    greeting,
    "",
    WAITLIST_SPOT_INTRO,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    WAITLIST_SPOT_NOT_GUARANTEED_TITLE.toUpperCase(),
    WAITLIST_SPOT_NOT_GUARANTEED_NOTE,
    "",
    `${WAITLIST_SPOT_CTA}: ${reserveUrl}`,
    "",
    WAITLIST_SPOT_HOW_TITLE,
    WAITLIST_SPOT_HOW_NOTE,
    "",
    WAITLIST_CANCEL_TITLE,
    WAITLIST_CANCEL_NOTE,
    cancelUrl,
    "",
    `Equipe ${SITE_NAME}`,
    "",
    "—",
    `WhatsApp: ${formatWhatsappNumber()}`,
    `E-mail: ${CONTACT_EMAIL}`,
    `Instagram: ${INSTAGRAM_HANDLE}`,
    SITE_URL,
  ].join("\n");

  const detailRowsHtml = rows
    .map(([label, value]) => `
                      <tr>
                        <td style="padding:10px 0;border-bottom:1px solid ${BRAND.mist};font-size:14px;color:${BRAND.ink};opacity:0.6;">${escapeHtml(label)}</td>
                        <td style="padding:10px 0;border-bottom:1px solid ${BRAND.mist};font-size:15px;font-weight:600;color:${BRAND.ink};text-align:right;">${escapeHtml(value)}</td>
                      </tr>`)
    .join("");

  const reserveButton = `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 20px;">
                <tr><td style="border-radius:999px;background-color:${BRAND.forest};">
                  <a href="${escapeHtml(reserveUrl)}" style="display:inline-block;padding:14px 26px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(WAITLIST_SPOT_CTA)}</a>
                </td></tr>
              </table>`;

  const cancelButton = `
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 0;">
                      <tr><td style="border-radius:999px;border:1px solid ${BRAND.lake};">
                        <a href="${escapeHtml(cancelUrl)}" style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:600;color:${BRAND.lake};text-decoration:none;">${escapeHtml(WAITLIST_CANCEL_LABEL)}</a>
                      </td></tr>
                    </table>`;

  const body = `
              <p style="margin:0 0 6px;font-size:17px;line-height:26px;font-weight:600;color:${BRAND.forest};">${escapeHtml(greeting)}</p>
              <p style="margin:0 0 18px;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.8;">${escapeHtml(WAITLIST_SPOT_INTRO)}</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">${detailRowsHtml}
              </table>${highlightCard(WAITLIST_SPOT_NOT_GUARANTEED_TITLE, "Quem concluir o pagamento primeiro fica com a vaga", WAITLIST_SPOT_NOT_GUARANTEED_NOTE)}${reserveButton}${infoSection(WAITLIST_SPOT_HOW_TITLE, paragraph(WAITLIST_SPOT_HOW_NOTE))}${infoSection(WAITLIST_CANCEL_TITLE, paragraph(WAITLIST_CANCEL_NOTE) + cancelButton)}
              <p style="margin:22px 0 0;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.8;">Equipe ${escapeHtml(SITE_NAME)}</p>`;

  const html = emailLayout({ title: subject, preheader: WAITLIST_SPOT_NOT_GUARANTEED_NOTE, heading: WAITLIST_SPOT_HEADING, body });

  return { to: data.email, subject, html, text };
}
