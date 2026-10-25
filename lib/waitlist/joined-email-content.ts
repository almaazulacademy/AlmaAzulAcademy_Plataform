/**
 * E-mail de confirmação da inscrição na lista de espera: assunto, HTML e texto.
 *
 * Função pura, como os outros e-mails: entra o payload da fila, sai a mensagem.
 * Mesma moldura, paleta e rodapé dos e-mails de reserva.
 *
 * O que ele precisa deixar claro, sem margem para leitura otimista: a inscrição
 * **não reserva vaga e não cobra nada**; se abrir vaga, o aviso chega por
 * e-mail e a vaga fica com quem concluir a reserva primeiro.
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

export type WaitlistJoinedEmailData = {
  fullName: string;
  email: string;
  quantity: number;
  experienceTitle: string;
  startsAt: string;
  baseName: string;
  /** Token do link de cancelamento: 64 caracteres hexadecimais. */
  cancelToken: string;
};

export type WaitlistJoinedEmail = { to: string; subject: string; html: string; text: string };

export const WAITLIST_JOINED_HEADING = "Você está na lista de espera";

export const WAITLIST_JOINED_INTRO = "Recebemos sua inscrição na lista de espera desta turma:";

export const WAITLIST_NOT_A_RESERVATION_TITLE = "Isto não é uma reserva";

export const WAITLIST_NOT_A_RESERVATION_NOTE =
  "A lista de espera não garante vaga, não bloqueia vagas e não tem nenhuma cobrança. Você não precisa pagar nada agora.";

export const WAITLIST_HOW_IT_WORKS_TITLE = "Se abrir uma vaga";

export const WAITLIST_HOW_IT_WORKS_NOTE =
  "Avisaremos você por e-mail. A vaga continua aberta no site para todos e fica com quem concluir primeiro a reserva e o pagamento — por isso, se receber o aviso e ainda quiser ir, reserve assim que puder.";

export const WAITLIST_CANCEL_TITLE = "Mudou de ideia?";

export const WAITLIST_CANCEL_NOTE = "Você pode sair da lista de espera a qualquer momento pelo link abaixo.";

export const WAITLIST_CANCEL_LABEL = "Sair da lista de espera";

const CANCEL_TOKEN = /^[0-9a-f]{64}$/;

/**
 * Link de cancelamento. O token vai no fragmento (`#t=`): o navegador não o
 * envia ao servidor, então ele não aparece em log de acesso nem em pré-visualização.
 */
export function waitlistCancelUrl(token: string, origin: string = SITE_URL) {
  return `${origin.replace(/\/$/, "")}/lista-de-espera#t=${token}`;
}

export function waitlistJoinedSubject(experienceTitle: string) {
  return `Você está na lista de espera — ${experienceTitle} | ${SITE_NAME}`;
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/** Lê o payload da fila. null quando falta algo que o e-mail não pode inventar. */
export function parseWaitlistJoinedEmailData(value: unknown): WaitlistJoinedEmailData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const startsAt = typeof row.startsAt === "string" ? row.startsAt : row.startsAt instanceof Date ? row.startsAt.toISOString() : "";
  const data = {
    fullName: asString(row.fullName),
    email: asString(row.email).toLowerCase(),
    quantity: Number(row.quantity),
    experienceTitle: asString(row.experienceTitle),
    startsAt,
    baseName: asString(row.baseName),
    cancelToken: asString(row.cancelToken).toLowerCase(),
  };
  if (!data.fullName || !data.email.includes("@") || !data.experienceTitle || !data.startsAt) return null;
  if (!Number.isInteger(data.quantity) || data.quantity < 1) return null;
  if (!CANCEL_TOKEN.test(data.cancelToken)) return null;
  if (Number.isNaN(new Date(data.startsAt).getTime())) return null;
  return data;
}

function participants(quantity: number) {
  return quantity === 1 ? "1 pessoa" : `${quantity} pessoas`;
}

function detailRows(data: WaitlistJoinedEmailData): Array<[string, string]> {
  return [
    ["Experiência", data.experienceTitle],
    ["Data", formatSessionDate(data.startsAt)],
    ["Horário", formatSessionTime(data.startsAt)],
    ...(data.baseName ? [["Base", data.baseName] as [string, string]] : []),
    ["Participantes", participants(data.quantity)],
  ];
}

export function buildWaitlistJoinedEmail(data: WaitlistJoinedEmailData, origin: string = SITE_URL): WaitlistJoinedEmail {
  const subject = waitlistJoinedSubject(data.experienceTitle);
  const greeting = `Olá, ${firstName(data.fullName)}!`;
  const rows = detailRows(data);
  const cancelUrl = waitlistCancelUrl(data.cancelToken, origin);

  const text = [
    greeting,
    "",
    WAITLIST_JOINED_INTRO,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    WAITLIST_NOT_A_RESERVATION_TITLE.toUpperCase(),
    WAITLIST_NOT_A_RESERVATION_NOTE,
    "",
    WAITLIST_HOW_IT_WORKS_TITLE,
    WAITLIST_HOW_IT_WORKS_NOTE,
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

  const cancelButton = `
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 0;">
                      <tr><td style="border-radius:999px;border:1px solid ${BRAND.lake};">
                        <a href="${escapeHtml(cancelUrl)}" style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:600;color:${BRAND.lake};text-decoration:none;">${escapeHtml(WAITLIST_CANCEL_LABEL)}</a>
                      </td></tr>
                    </table>`;

  const body = `
              <p style="margin:0 0 6px;font-size:17px;line-height:26px;font-weight:600;color:${BRAND.forest};">${escapeHtml(greeting)}</p>
              <p style="margin:0 0 18px;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.8;">${escapeHtml(WAITLIST_JOINED_INTRO)}</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">${detailRowsHtml}
              </table>${highlightCard(WAITLIST_NOT_A_RESERVATION_TITLE, "Nenhuma vaga reservada, nenhuma cobrança", WAITLIST_NOT_A_RESERVATION_NOTE)}${infoSection(WAITLIST_HOW_IT_WORKS_TITLE, paragraph(WAITLIST_HOW_IT_WORKS_NOTE))}${infoSection(WAITLIST_CANCEL_TITLE, paragraph(WAITLIST_CANCEL_NOTE) + cancelButton)}
              <p style="margin:22px 0 0;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.8;">Equipe ${escapeHtml(SITE_NAME)}</p>`;

  const html = emailLayout({ title: subject, preheader: WAITLIST_NOT_A_RESERVATION_NOTE, heading: WAITLIST_JOINED_HEADING, body });

  return { to: data.email, subject, html, text };
}
