/**
 * E-mails de reserva de evento especial: confirmação, lembrete do QR e
 * reagendamento.
 *
 * O conteúdo vem do `editorial_content` do evento (bloco `event`): programação,
 * chegada, o que levar, segurança, alimentação, clima e política de
 * cancelamento — nada do ESSÊNCIA fica fixo aqui. Data, horário, código,
 * participantes, local e QR vêm da reserva, como nos e-mails das experiências.
 *
 * A moldura, os cartões e o envio (fila, idempotência, tentativas e
 * recuperação) são os de `confirmation-email.ts`. Os e-mails das experiências
 * regulares não mudam: a escolha do modelo é pelo tipo da experiência.
 *
 * Tudo aqui é função pura — entra dado, sai mensagem.
 */

import { infoParagraphs, type EventContent } from "../events/editorial.ts";
import { arrivalMatchesSession, clockText, deadlineShortText, sessionStartClock } from "../events/policy.ts";
import { programItemTime } from "../events/presentation.ts";
import { checkinQrImageUrl, checkinUrl } from "../checkin/token.ts";
import { CONTACT_EMAIL, INSTAGRAM_HANDLE } from "../contact.ts";
import { formatSessionDate } from "../sessions/date-time.ts";
import { SITE_NAME, SITE_URL } from "../site.ts";
import {
  BRAND,
  bulletList,
  CHECKIN_LINK_LABEL,
  CHECKIN_TITLE,
  emailLayout,
  escapeHtml,
  firstName,
  formatWhatsappNumber,
  highlightCard,
  infoSection,
  locationCard,
  locationText,
  paragraph,
  RESCHEDULE_PAYMENT_HEADLINE,
  RESCHEDULE_PAYMENT_LABEL,
  RESCHEDULE_PAYMENT_NOTE,
  type ConfirmationEmail,
  type ReservationConfirmationData,
} from "./confirmation-email.ts";

export const EVENT_CHECKIN_NOTE = "No dia do evento, apresente este QR Code à nossa equipe para realizar seu check-in.";
export const EVENT_SIGNOFF = "Até o dia do evento! 💙";
export const EVENT_CLOSING = [
  "Guarde o código da reserva: é por ele que identificamos o seu ingresso.",
  "Se precisar falar conosco antes do evento, responda a este e-mail ou utilize o nosso canal oficial de atendimento.",
] as const;

/** Início, tolerância e encerramento previstos, no horário de Brasília. */
export function eventTimes(data: ReservationConfirmationData, content: EventContent) {
  const start = sessionStartClock(data.startsAt);
  const minutes = data.durationMinutes ?? 0;
  // Com horário geral sem fim fixo, o e-mail não anuncia encerramento.
  const end = minutes > 0 && !content.scheduleLabel ? sessionStartClock(new Date(new Date(data.startsAt).getTime() + minutes * 60_000).toISOString()) : null;
  // A tolerância só aparece quando combina com a sessão cadastrada: uma sessão
  // remarcada sem o conteúdo atualizado não manda um horário de chegada errado.
  const tolerance = content.arrival && minutes > 0 && arrivalMatchesSession(content.arrival, data.startsAt, minutes) ? content.arrival.toleranceUntil : null;
  return { start: clockText(start), tolerance: tolerance ? clockText(tolerance) : null, end: end ? clockText(end) : null };
}

function participants(quantity: number) {
  return `${quantity} ${quantity === 1 ? "participante" : "participantes"}`;
}

function info(content: EventContent, id: string) {
  const item = content.info.items.find((entry) => entry.id === id && !entry.pending);
  return infoParagraphs(item?.body ?? null);
}

function programLines(content: EventContent) {
  return content.program.items.map((item) => {
    const hosts = item.hosts.length ? ` (com ${item.hosts.length === 1 ? item.hosts[0] : `${item.hosts.slice(0, -1).join(", ")} e ${item.hosts[item.hosts.length - 1]}`})` : "";
    return `${programItemTime(item)} — ${item.title}${hosts}`;
  });
}

/** Linhas do resumo: o que identifica o ingresso. */
function eventRows(data: ReservationConfirmationData, content: EventContent): Array<[string, string]> {
  const times = eventTimes(data, content);
  return [
    ["Evento", data.experienceTitle],
    ["Código da reserva", data.publicCode],
    ["Data", formatSessionDate(data.startsAt)],
    ["Início", times.start],
    ...(times.tolerance ? [["Tolerância de chegada", `até ${times.tolerance}`] as [string, string]] : []),
    ...(times.end ? [["Encerramento previsto", times.end] as [string, string]] : []),
    ["Participantes", participants(data.quantity)],
    ["Ingresso", "Único, com toda a programação"],
  ];
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

function summaryTable(rows: Array<[string, string]>) {
  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.paper};border-radius:14px;padding:4px 16px;margin:0 0 20px;">
                <tr><td style="padding:4px 0;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rowsHtml(rows)}
                  </table>
                </td></tr>
              </table>`;
}

/** QR do ingresso: o mesmo token e a mesma página da experiência, com textos de evento. */
function eventCheckinHtml(data: ReservationConfirmationData) {
  if (!data.checkinToken) return "";
  const details = rowsHtml([
    ["Responsável", data.fullName],
    ["Evento", data.experienceTitle],
    ["Data", formatSessionDate(data.startsAt)],
    ["Participantes", participants(data.quantity)],
  ]);
  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
                <tr>
                  <td align="center" style="padding:24px 18px;background-color:${BRAND.tint};border:2px solid ${BRAND.lake};border-radius:18px;">
                    <p style="margin:0;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.lake};font-weight:700;">${escapeHtml(CHECKIN_TITLE)}</p>
                    <p style="margin:10px 0 18px;font-size:15px;line-height:23px;color:${BRAND.ink};">${escapeHtml(EVENT_CHECKIN_NOTE)}</p>
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
                      <tr><td style="padding:12px;background-color:#ffffff;border-radius:14px;">
                        <img src="${checkinQrImageUrl(data.checkinToken)}" width="220" height="220" alt="QR Code de check-in" style="display:block;width:220px;height:220px;max-width:100%;border:0;">
                      </td></tr>
                    </table>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 0;">${details}
                    </table>
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px auto 0;">
                      <tr><td style="border-radius:999px;background-color:${BRAND.forest};">
                        <a href="${checkinUrl(data.checkinToken)}" style="display:inline-block;padding:13px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(CHECKIN_LINK_LABEL)}</a>
                      </td></tr>
                    </table>
                    <p style="margin:10px 0 0;font-size:12px;line-height:18px;color:${BRAND.ink};opacity:0.6;">Se a imagem não carregar, toque no botão acima.</p>
                  </td>
                </tr>
              </table>`;
}

function eventCheckinText(data: ReservationConfirmationData) {
  if (!data.checkinToken) return [];
  return [CHECKIN_TITLE.toUpperCase(), EVENT_CHECKIN_NOTE, `Responsável: ${data.fullName}`, `Participantes: ${participants(data.quantity)}`, `${CHECKIN_LINK_LABEL}: ${checkinUrl(data.checkinToken)}`, ""];
}

function paragraphsHtml(lines: string[]) {
  return lines.map((line, index) => (index === 0 ? paragraph(line) : `
                    <div style="height:8px;line-height:8px;">&nbsp;</div>${paragraph(line)}`)).join("");
}

/** As seções de leitura do evento, na ordem do e-mail. Só as que têm texto. */
function eventSections(content: EventContent, options: { cancellation: boolean }) {
  const sections: Array<{ title: string; lines: string[]; list?: boolean }> = [
    { title: "Programação", lines: programLines(content), list: true },
    { title: "O que levar", lines: info(content, "o-que-levar") },
    { title: "Segurança durante a remada", lines: info(content, "seguranca") },
    { title: "Lanche incluso", lines: info(content, "alimentacao") },
    { title: "Condições climáticas", lines: info(content, "clima") },
  ];
  if (options.cancellation) {
    const deadline = content.cancellation ? [`Prazo: ${deadlineShortText(content.cancellation.deadline)}.`] : [];
    sections.push({ title: "Política de cancelamento", lines: [...info(content, "cancelamento"), ...deadline] });
  }
  return sections.filter((section) => section.lines.length);
}

function footerText() {
  return ["—", `WhatsApp: ${formatWhatsappNumber()}`, `E-mail: ${CONTACT_EMAIL}`, `Instagram: ${INSTAGRAM_HANDLE}`, SITE_URL];
}

// --- Confirmação ------------------------------------------------------------

export function eventConfirmationSubject(data: ReservationConfirmationData) {
  return `Ingresso confirmado — ${data.experienceTitle} · ${data.publicCode}`;
}

export function buildEventConfirmationEmail(data: ReservationConfirmationData, content: EventContent): ConfirmationEmail {
  const subject = eventConfirmationSubject(data);
  const greeting = `Olá, ${firstName(data.fullName)}!`;
  const intro = [`Seu ingresso para o ${data.experienceTitle} está confirmado! 💙`, "Confira os detalhes da sua reserva:"];
  const rows = eventRows(data, content);
  const sections = eventSections(content, { cancellation: true });

  const text = [
    greeting,
    "",
    ...intro.flatMap((line) => [line, ""]),
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    ...eventCheckinText(data),
    "📍 Local de encontro",
    ...locationText(data),
    "",
    ...sections.flatMap((section) => [section.title.toUpperCase(), ...(section.list ? section.lines.map((line) => `- ${line}`) : section.lines), ""]),
    ...EVENT_CLOSING.flatMap((line) => [line, ""]),
    EVENT_SIGNOFF,
    `Equipe ${SITE_NAME}`,
    "",
    ...footerText(),
  ].join("\n");

  const html = emailLayout({
    title: subject,
    preheader: `Seu ingresso ${data.publicCode} está confirmado. Programação, chegada e política de cancelamento.`,
    heading: "Ingresso confirmado",
    body: `
              <p style="margin:0 0 16px;font-size:17px;line-height:26px;font-weight:600;color:${BRAND.ink};">${escapeHtml(greeting)}</p>${intro.map((line) => `
              <p style="margin:0 0 14px;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.8;">${escapeHtml(line)}</p>`).join("")}
${summaryTable(rows)}
${eventCheckinHtml(data)}
${locationCard(data)}
              <div style="height:12px;line-height:12px;">&nbsp;</div>
${sections.map((section) => infoSection(section.title, section.list ? bulletList(section.lines) : paragraphsHtml(section.lines))).join("")}
              <div style="height:24px;line-height:24px;">&nbsp;</div>${EVENT_CLOSING.map((line) => `
              <p style="margin:0 0 14px;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.75;">${escapeHtml(line)}</p>`).join("")}
              <p style="margin:24px 0 4px;font-size:15px;line-height:24px;color:${BRAND.ink};">${escapeHtml(EVENT_SIGNOFF)}</p>
              <p style="margin:0;font-size:15px;line-height:24px;font-weight:600;color:${BRAND.forest};">Equipe ${escapeHtml(SITE_NAME)}</p>
`,
  });

  return { to: data.email, subject, html, text };
}

// --- Lembrete do QR ---------------------------------------------------------

export function buildEventCheckinReminderEmail(data: ReservationConfirmationData, content: EventContent): ConfirmationEmail | null {
  if (!data.checkinToken) return null;
  const subject = `Seu QR Code de check-in — ${data.experienceTitle}`;
  const greeting = `Olá, ${firstName(data.fullName)}!`;
  const intro = `Passando para lembrar do seu ingresso para o ${data.experienceTitle}.`;
  const times = eventTimes(data, content);
  const rows: Array<[string, string]> = [
    ["Evento", data.experienceTitle],
    ["Data", formatSessionDate(data.startsAt)],
    ["Início", times.start],
    ...(times.tolerance ? [["Tolerância de chegada", `até ${times.tolerance}`] as [string, string]] : []),
    ["Participantes", participants(data.quantity)],
  ];

  const text = [
    greeting,
    "",
    intro,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    EVENT_CHECKIN_NOTE,
    `${CHECKIN_LINK_LABEL}: ${checkinUrl(data.checkinToken)}`,
    "",
    `Local: ${locationText(data).join("\n")}`,
    "",
    EVENT_SIGNOFF,
    SITE_NAME,
    "",
    ...footerText(),
  ].join("\n");

  const html = emailLayout({
    title: subject,
    preheader: `Seu QR Code de check-in para o ${data.experienceTitle}.`,
    heading: "Seu ingresso está pronto",
    body: `
              <p style="margin:0 0 16px;font-size:17px;line-height:26px;font-weight:600;color:${BRAND.ink};">${escapeHtml(greeting)}</p>
              <p style="margin:0 0 20px;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.75;">${escapeHtml(intro)}</p>
${summaryTable(rows)}
${eventCheckinHtml(data)}
${locationCard(data)}
              <p style="margin:24px 0 4px;font-size:15px;line-height:24px;color:${BRAND.ink};">${escapeHtml(EVENT_SIGNOFF)}</p>
              <p style="margin:0;font-size:15px;line-height:24px;font-weight:600;color:${BRAND.forest};">${escapeHtml(SITE_NAME)}</p>
`,
  });

  return { to: data.email, subject, html, text };
}

// --- Reagendamento (Stand-by) ---------------------------------------------

export function buildEventRescheduleEmail(data: ReservationConfirmationData, content: EventContent): ConfirmationEmail {
  const subject = `Nova data confirmada — ${data.experienceTitle} · ${data.publicCode}`;
  const greeting = `Olá, ${firstName(data.fullName)}!`;
  const intro = "Seu ingresso foi transferido para uma nova data e está confirmado. Confira os novos detalhes:";
  const rows = eventRows(data, content);
  // A política de cancelamento fica de fora, como no reagendamento das
  // experiências: o que vale para uma reserva remarcada é decisão da operação.
  const sections = eventSections(content, { cancellation: false });
  const qrNote = "O QR Code do seu ingresso continua o mesmo e vale para a nova data.";

  const text = [
    greeting,
    "",
    intro,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    RESCHEDULE_PAYMENT_HEADLINE.toUpperCase(),
    RESCHEDULE_PAYMENT_NOTE,
    "",
    ...eventCheckinText(data),
    ...(data.checkinToken ? [qrNote, ""] : []),
    "📍 Local de encontro",
    ...locationText(data),
    "",
    ...sections.flatMap((section) => [section.title.toUpperCase(), ...(section.list ? section.lines.map((line) => `- ${line}`) : section.lines), ""]),
    ...EVENT_CLOSING.flatMap((line) => [line, ""]),
    EVENT_SIGNOFF,
    `Equipe ${SITE_NAME}`,
    "",
    ...footerText(),
  ].join("\n");

  const html = emailLayout({
    title: subject,
    preheader: `Seu ingresso ${data.publicCode} tem nova data. O pagamento continua válido.`,
    heading: "Nova data confirmada",
    body: `
              <p style="margin:0 0 16px;font-size:17px;line-height:26px;font-weight:600;color:${BRAND.ink};">${escapeHtml(greeting)}</p>
              <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.75;">${escapeHtml(intro)}</p>
${summaryTable(rows)}
${highlightCard(RESCHEDULE_PAYMENT_LABEL, RESCHEDULE_PAYMENT_HEADLINE, RESCHEDULE_PAYMENT_NOTE)}
${eventCheckinHtml(data)}${data.checkinToken ? `
              <p style="margin:0 0 16px;font-size:14px;line-height:22px;color:${BRAND.ink};opacity:0.75;text-align:center;">${escapeHtml(qrNote)}</p>` : ""}
${locationCard(data)}
              <div style="height:12px;line-height:12px;">&nbsp;</div>
${sections.map((section) => infoSection(section.title, section.list ? bulletList(section.lines) : paragraphsHtml(section.lines))).join("")}
              <div style="height:24px;line-height:24px;">&nbsp;</div>${EVENT_CLOSING.map((line) => `
              <p style="margin:0 0 14px;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.75;">${escapeHtml(line)}</p>`).join("")}
              <p style="margin:24px 0 4px;font-size:15px;line-height:24px;color:${BRAND.ink};">${escapeHtml(EVENT_SIGNOFF)}</p>
              <p style="margin:0;font-size:15px;line-height:24px;font-weight:600;color:${BRAND.forest};">Equipe ${escapeHtml(SITE_NAME)}</p>
`,
  });

  return { to: data.email, subject, html, text };
}
