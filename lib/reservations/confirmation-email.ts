/**
 * Mensagem de confirmação de reserva: assunto, HTML responsivo e texto puro.
 *
 * Tudo aqui é função pura — entra dado, sai mensagem. Sem rede, sem banco, sem
 * segredo. É o que permite testar o conteúdo, o fuso e a idempotência sem nunca
 * enviar um e-mail de verdade.
 *
 * O HTML é deliberadamente antiquado: tabelas, largura máxima fixa, estilo
 * inline e nada de flexbox ou grid. Cliente de e-mail não é navegador — Outlook
 * e Gmail ignoram boa parte do CSS moderno, e o layout precisa se manter de pé
 * no celular e no desktop.
 *
 * O corpo concentra de propósito tudo o que o cliente precisa para participar:
 * a experiência, a data, o ponto de encontro (com foto da base), como chegar,
 * o que levar, quanto dura e como cancelar. Nenhuma orientação fica para depois
 * — o e-mail não promete grupo nem mensagem complementar. Cada seção é uma
 * constante exportada, para que o teste verifique exatamente o texto que o
 * cliente lê.
 *
 * Ordem do e-mail regular: confirmação, experiência, data e horário, dados da
 * reserva (com o QR), ponto de encontro, chegada, o que levar, informações
 * importantes, cancelamento e o atendimento pelo WhatsApp.
 */

import {
  LAGO_NORTE_LOCATION,
  locationAddressLine,
  locationHeadline,
  MAPS_BUTTON_LABEL,
  parseBaseLocation,
  type BaseLocation,
} from "../bases/location.ts";
import { LAGO_NORTE_SLUG } from "../bases/types.ts";
import { checkinQrImageUrl, checkinUrl, isCheckinToken } from "../checkin/token.ts";
import { CONTACT_EMAIL, INSTAGRAM_HANDLE, INSTAGRAM_LINK, WHATSAPP_NUMBER } from "../contact.ts";
import { formatSessionDate, formatSessionTime } from "../sessions/date-time.ts";
import { formatDurationLabel } from "../sessions/modality.ts";
import { absoluteUrl, SITE_NAME, SITE_URL } from "../site.ts";
import { validateEventEditorial, type EventContent } from "../events/editorial.ts";
import {
  LAGO_NORTE_ARRIVAL_TITLE,
  LAGO_NORTE_MEETING_POINT,
  meetingPointPhoto,
  WHATSAPP_BUTTON_LABEL,
} from "./meeting-point.ts";
import { isEventEmailReady } from "../events/email-readiness.ts";
import { buildEventCheckinReminderEmail, buildEventConfirmationEmail, buildEventRescheduleEmail } from "./event-email.ts";

/**
 * Endereço do Lago Norte, a base de origem.
 *
 * O local de encontro de cada e-mail vem da base da reserva (reserva → sessão →
 * experiência → base), devolvida pela RPC `reservation_confirmation_email` e
 * lida por `lib/bases/location.ts`. Esta constante é só o valor usado quando o
 * banco ainda não informa a base — ver `LAGO_NORTE_LOCATION`.
 */
export const MEETING_LOCATION = LAGO_NORTE_LOCATION.address ?? "";

/** Tolerância de chegada, contada a partir do horário da sessão reservada. */
export const MEETING_TOLERANCE_NOTE = "Tolerância de até 20 minutos após o horário marcado.";

/**
 * O que o cliente precisa saber antes de sair de casa. O primeiro item vai para
 * "Informações importantes"; os outros dois formam "O que levar".
 */
export const PREPARATION_ITEMS = [
  "Não é necessário ter experiência com esportes ou canoa. A remada em grupo é tranquila de acompanhar e aprender.",
  "Traga roupa de banho, repelente e roupa confortável para praticar atividade física.",
  "Recomendamos vir de chinelo.",
] as const;

/**
 * Duração da experiência no Lago Norte, em "Informações importantes".
 *
 * Texto fixo para a turma tradicional: a frase fala também da parada para
 * banho, que nenhum campo do banco carrega.
 */
export const DURATION_NOTE =
  "A experiência dura em torno de 1h30 e conta com uma parada para banho durante a remada.";

/**
 * Frase de duração do Lago Norte para a sessão reservada.
 *
 * A turma tradicional (90 min) — e todo payload antigo, sem a duração — mantém
 * `DURATION_NOTE` palavra por palavra. Uma turma com outra duração (a remada de
 * 1 hora dos dias de semana, a partir de dezembro/2026) recebe a duração real
 * da sessão, sem prometer a parada para banho da experiência tradicional.
 */
export function durationNoteFor(durationMinutes: number | null | undefined) {
  if (typeof durationMinutes !== "number" || durationMinutes <= 0 || durationMinutes === 90) return DURATION_NOTE;
  return `A experiência dura em torno de ${formatDurationLabel(durationMinutes)}.`;
}

/** Política de cancelamento. Texto operacional — não ampliar nem restringir. */
export const CANCELLATION_TITLE = "Cancelamento e remarcação";

export const CANCELLATION_NOTE =
  "Caso ocorra algum imprevisto, é permitido solicitar cancelamento com reembolso ou crédito para uma próxima remada até 1 dia antes do horário marcado.";

/** "O que levar": os itens de preparo que são, de fato, coisas para trazer. */
export const WHAT_TO_BRING_TITLE = "O que levar";

export const WHAT_TO_BRING_ITEMS = [PREPARATION_ITEMS[1], PREPARATION_ITEMS[2]] as const;

/** "Informações importantes": experiência prévia, duração e o código. */
export const IMPORTANT_INFO_TITLE = "Informações importantes";

export const RESERVATION_CODE_NOTE = "Guarde o código da reserva: é por ele que identificamos o seu agendamento.";

/** Cartão do ponto de encontro: foto, local, endereço e "Como chegar". */
export const MEETING_POINT_TITLE = "Ponto de encontro";

/** Chegada nas bases sem orientação própria: o horário e a tolerância de sempre. */
export const ARRIVAL_TITLE = "Chegada";

export const MEETING_TIME_LABEL = "Horário de encontro";

/**
 * Chegada no Lago Norte: o instrutor abre o portão 10 minutos antes. Texto
 * aprovado pela equipe; só aparece nas reservas do Lago Norte.
 */
export const LAGO_NORTE_ARRIVAL_PARAGRAPHS = [
  "Um de nossos instrutores estará disponível para abrir o portão de acesso 10 minutos antes do horário marcado para sua experiência.",
  "Pedimos que chegue com antecedência para que possamos realizar a preparação e iniciar a atividade da melhor forma possível.",
  "Teremos uma tolerância de até 20 minutos após o horário marcado para a chegada dos participantes.",
  `Caso tenha algum atraso ou dificuldade para encontrar nossa entrada, entre em contato com a equipe da Alma Azul Academy pelo WhatsApp: ${formatWhatsappNumber()}.`,
] as const;

/**
 * Fechamento: o canal de atendimento, com o único botão do WhatsApp do e-mail
 * (a chegada do Lago Norte cita o número em texto, sem botão próprio).
 */
export const SUPPORT_TITLE = "Atendimento pelo WhatsApp";

export const SUPPORT_NOTE = `Se precisar falar conosco, responda a este e-mail ou chame a nossa equipe pelo WhatsApp: ${formatWhatsappNumber()}.`;

/** Paleta da marca, espelhando as variáveis de `app/globals.css`. */
export const BRAND = {
  ink: "#14312c",
  paper: "#f7f5ef",
  mist: "#e9eee8",
  lake: "#277f87",
  forest: "#214f43",
  sand: "#d7c5a0",
  tint: "#eff5f4",
} as const;

export type ReservationConfirmationData = {
  reservationId: string;
  publicCode: string;
  fullName: string;
  email: string;
  quantity: number;
  experienceTitle: string;
  startsAt: string;
  /**
   * Token do QR de check-in. null enquanto a migration do check-in não estiver
   * aplicada: o e-mail sai como antes, só sem a seção do QR.
   */
  checkinToken: string | null;
  /** Duração da sessão reservada, em minutos. Ausente no payload antigo. */
  durationMinutes?: number | null;
  /**
   * Base onde a experiência acontece. Ausente só quando o banco ainda não
   * devolve a base; nesse caso toda reserva é do Lago Norte.
   */
  location?: BaseLocation;
  /**
   * Evento especial: o conteúdo do e-mail de evento, já validado. Ausente =
   * experiência regular, e os e-mails são exatamente os de sempre.
   */
  event?: EventContent;
  /**
   * A reserva é de um evento, mas o conteúdo não serve para o e-mail. Nada é
   * enviado — nem o e-mail genérico de remada: o envio fica pendente.
   */
  eventContentInvalid?: boolean;
};

/** Reserva de evento sem conteúdo de e-mail utilizável: o envio não sai. */
export const EVENT_EMAIL_NOT_READY = "EVENT_EMAIL_NOT_READY";

/** Seção do QR de check-in. Constantes exportadas para o teste ler o mesmo texto. */
export const CHECKIN_TITLE = "Seu QR Code de check-in";

export const CHECKIN_NOTE =
  "No dia da experiência, apresente este QR Code à nossa equipe para realizar seu check-in na Alma Azul.";

export const CHECKIN_LINK_LABEL = "Abrir meu QR Code";

export type ConfirmationEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

/** Primeiro nome, para o cumprimento não ficar solene demais. */
export function firstName(fullName: string) {
  return fullName.trim().split(/\s+/)[0] || fullName.trim();
}

/** Escapa o que vai para dentro do HTML. Nome de cliente é entrada de usuário. */
export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** WhatsApp oficial da equipe, sem mensagem pronta: https://wa.me/5561992682522. */
export function whatsappLink() {
  return `https://wa.me/${WHATSAPP_NUMBER}`;
}

export function formatWhatsappNumber() {
  const digits = WHATSAPP_NUMBER.replace(/\D/g, "").replace(/^55/, "");
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  return WHATSAPP_NUMBER;
}

/** Assunto do e-mail das bases abertas depois do Lago Norte. */
export const NEW_BASE_SUBJECT = `Sua reserva está confirmada! 🌊 | ${SITE_NAME}`;

/** Abertura do e-mail das bases abertas depois do Lago Norte. */
export const NEW_BASE_INTRO = [
  "Sua experiência com a Alma Azul está confirmada! 💙",
  "Estamos felizes em receber você para mais um momento de conexão com a natureza e com as águas do Lago Paranoá.",
  "Confira os detalhes da sua reserva:",
] as const;

export const NEW_BASE_SIGNOFF = "Nos vemos na água! 💙";

function locationOf(data: ReservationConfirmationData) {
  return data.location ?? LAGO_NORTE_LOCATION;
}

/**
 * O Lago Norte tem abertura, assinatura, frase de duração e orientações de
 * chegada próprias; as demais bases usam as do Cápsula Bar. A decisão é pela
 * base da reserva — nunca pelo nome da experiência, que se repete entre bases.
 */
function usesOriginTemplate(data: ReservationConfirmationData) {
  return locationOf(data).baseSlug === LAGO_NORTE_SLUG;
}

/** Abertura do e-mail do Lago Norte. */
export const ORIGIN_INTRO = "Sua reserva está confirmada. Será um prazer receber você para essa experiência!";

export const ORIGIN_SIGNOFF = "Até breve!";

/**
 * Onde o grupo se encontra: o ponto cadastrado na base; no Lago Norte, que não
 * tem um, o portão de entrada; e, em último caso, o endereço.
 */
export function meetingPointOf(location: BaseLocation) {
  return (
    location.meetingPoint ??
    (location.baseSlug === LAGO_NORTE_SLUG ? LAGO_NORTE_MEETING_POINT : null) ??
    location.address ??
    location.baseName
  );
}

/** Endereço como linha própria, quando não é ele mesmo o ponto de encontro. */
function meetingAddressOf(location: BaseLocation) {
  return location.address && location.address !== meetingPointOf(location) ? location.address : null;
}

export function formatDuration(minutes: number | null | undefined) {
  return typeof minutes === "number" && minutes > 0 ? `${minutes} minutos` : null;
}

export function reservationConfirmationSubject(publicCode: string, location: BaseLocation = LAGO_NORTE_LOCATION) {
  return location.baseSlug === LAGO_NORTE_SLUG ? `Reserva confirmada — ${publicCode}` : NEW_BASE_SUBJECT;
}

/** Rótulo do bloco de localização: o Lago Norte mantém o dele. */
function locationLabel(data: ReservationConfirmationData) {
  return usesOriginTemplate(data) ? "Localização" : "📍 Local de encontro";
}

/** Local de encontro em texto puro: ponto de encontro, endereço e link do mapa. */
export function locationText(data: ReservationConfirmationData) {
  const location = locationOf(data);
  const address = locationAddressLine(location);
  return [
    usesOriginTemplate(data) ? locationHeadline(location) : `${locationHeadline(location)}.`,
    ...(address ? [`Endereço: ${address}`] : []),
    ...(location.mapsUrl ? [`${MAPS_BUTTON_LABEL}: ${location.mapsUrl}`] : []),
  ];
}

/**
 * Dados da reserva logo abaixo da experiência, da data e do horário (que têm
 * cartão próprio, sempre no fuso de Brasília). No Lago Norte a duração sai em
 * "Informações importantes", com a parada para banho; nas demais bases, a
 * duração da sessão entra aqui.
 */
function reservationRows(data: ReservationConfirmationData) {
  const rows: Array<[string, string]> = [
    ["Código da reserva", data.publicCode],
    ["Participantes", `${data.quantity}`],
  ];
  const duration = formatDuration(data.durationMinutes);
  if (!usesOriginTemplate(data) && duration) rows.push(["Duração", duration]);
  return rows;
}

/** Itens de "Informações importantes". */
function importantItems(data: ReservationConfirmationData, codeNote: string) {
  return [
    PREPARATION_ITEMS[0],
    ...(usesOriginTemplate(data) ? [durationNoteFor(data.durationMinutes)] : []),
    codeNote,
  ];
}

/** Do ponto de encontro ao atendimento: igual na confirmação e no reagendamento. */
type GuidanceOptions = {
  /** O reagendamento não antecipa a política de cancelamento. */
  cancellation: boolean;
  codeNote: string;
};

// --- Versão em texto puro ----------------------------------------------------

function vagasLabel(quantity: number) {
  return `${quantity} ${quantity === 1 ? "vaga" : "vagas"}`;
}

/** Bloco do QR no texto puro: sem imagem, o link é a alternativa. */
function checkinText(data: ReservationConfirmationData) {
  if (!data.checkinToken) return [];
  return [
    CHECKIN_TITLE.toUpperCase(),
    CHECKIN_NOTE,
    `Responsável: ${data.fullName}`,
    `Vagas reservadas: ${vagasLabel(data.quantity)}`,
    `${CHECKIN_LINK_LABEL}: ${checkinUrl(data.checkinToken)}`,
    "",
  ];
}

/** Ponto de encontro no texto puro: o mesmo do cartão, sem a foto. */
function meetingPointText(data: ReservationConfirmationData) {
  const location = locationOf(data);
  const address = meetingAddressOf(location);
  return [
    MEETING_POINT_TITLE,
    meetingPointOf(location),
    ...(address ? [`Endereço: ${address}`] : []),
    ...(location.mapsUrl ? [`${MAPS_BUTTON_LABEL}: ${location.mapsUrl}`] : []),
  ];
}

function arrivalText(data: ReservationConfirmationData) {
  if (usesOriginTemplate(data)) {
    return [LAGO_NORTE_ARRIVAL_TITLE, ...LAGO_NORTE_ARRIVAL_PARAGRAPHS];
  }
  return [ARRIVAL_TITLE, `${MEETING_TIME_LABEL}: ${formatSessionTime(data.startsAt)}`, MEETING_TOLERANCE_NOTE];
}

function guidanceText(data: ReservationConfirmationData, options: GuidanceOptions) {
  return [
    ...meetingPointText(data),
    "",
    ...arrivalText(data),
    "",
    WHAT_TO_BRING_TITLE,
    ...WHAT_TO_BRING_ITEMS.map((item) => `- ${item}`),
    "",
    IMPORTANT_INFO_TITLE,
    ...importantItems(data, options.codeNote).map((item) => `- ${item}`),
    "",
    ...(options.cancellation ? [CANCELLATION_TITLE, CANCELLATION_NOTE, ""] : []),
    SUPPORT_TITLE,
    SUPPORT_NOTE,
    `${WHATSAPP_BUTTON_LABEL}: ${whatsappLink()}`,
    "",
  ];
}

function textFooter() {
  return [
    "—",
    `WhatsApp: ${formatWhatsappNumber()}`,
    `E-mail: ${CONTACT_EMAIL}`,
    `Instagram: ${INSTAGRAM_HANDLE}`,
    SITE_URL,
  ];
}

function buildText(data: ReservationConfirmationData) {
  const origin = usesOriginTemplate(data);

  return [
    `Olá, ${firstName(data.fullName)}!`,
    "",
    ...(origin ? [ORIGIN_INTRO, ""] : NEW_BASE_INTRO.flatMap((line) => [line, ""])),
    "Sua experiência",
    data.experienceTitle,
    `Data: ${formatSessionDate(data.startsAt)}`,
    `Horário: ${formatSessionTime(data.startsAt)}`,
    "",
    ...reservationRows(data).map(([label, value]) => `${label}: ${value}`),
    "",
    ...checkinText(data),
    ...guidanceText(data, { cancellation: true, codeNote: RESERVATION_CODE_NOTE }),
    origin ? ORIGIN_SIGNOFF : NEW_BASE_SIGNOFF,
    `Equipe ${SITE_NAME}`,
    "",
    ...textFooter(),
  ].join("\n");
}

// --- Versão HTML -------------------------------------------------------------

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

/** Cartão destacado: rótulo pequeno, valor grande e, quando houver, uma nota e um botão. */
export function highlightCard(label: string, value: string, note?: string, extraHtml = "") {
  const noteHtml = (note
    ? `
                <p style="margin:8px 0 0;font-size:14px;line-height:21px;color:${BRAND.ink};opacity:0.7;">${escapeHtml(note)}</p>`
    : "") + extraHtml;

  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;">
                <tr>
                  <td style="padding:16px 18px;background-color:${BRAND.tint};border-radius:14px;">
                    <p style="margin:0;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.lake};font-weight:600;">${escapeHtml(label)}</p>
                    <p style="margin:6px 0 0;font-size:20px;line-height:28px;font-weight:600;color:${BRAND.forest};">${escapeHtml(value)}</p>${noteHtml}
                  </td>
                </tr>
              </table>`;
}

/** Botão "Como chegar": só existe quando a base tem um link oficial do mapa. */
function mapsButton(url: string) {
  return `
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 0;">
                  <tr><td style="border-radius:999px;background-color:${BRAND.lake};">
                    <a href="${escapeHtml(url)}" style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">📍 ${escapeHtml(MAPS_BUTTON_LABEL)}</a>
                  </td></tr>
                </table>`;
}

/** Cartão do local de encontro, montado a partir da base da reserva. */
export function locationCard(data: ReservationConfirmationData) {
  const location = locationOf(data);
  const address = locationAddressLine(location);
  const headline = usesOriginTemplate(data) ? locationHeadline(location) : `${locationHeadline(location)}.`;
  return highlightCard(
    locationLabel(data),
    headline,
    address ? `Endereço: ${address}` : undefined,
    location.mapsUrl ? mapsButton(location.mapsUrl) : "",
  );
}

/** Seção de leitura: título curto e um parágrafo ou uma lista curta. */
export function infoSection(title: string, body: string) {
  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 4px;">
                <tr>
                  <td style="padding:18px 0 0;border-top:1px solid ${BRAND.mist};">
                    <p style="margin:0 0 8px;font-size:16px;line-height:24px;font-weight:600;color:${BRAND.forest};">${escapeHtml(title)}</p>${body}
                  </td>
                </tr>
              </table>`;
}

export function paragraph(text: string) {
  return `
                    <p style="margin:0;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.8;">${escapeHtml(text)}</p>`;
}

/** Lista com marcador em célula própria: é o que sobrevive ao Outlook. */
export function bulletList(items: readonly string[]) {
  const rows = items
    .map((item, index) => `
                      <tr>
                        <td width="16" valign="top" style="padding:0 0 ${index === items.length - 1 ? "0" : "10px"};font-size:15px;line-height:24px;color:${BRAND.lake};">&bull;</td>
                        <td style="padding:0 0 ${index === items.length - 1 ? "0" : "10px"};font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.8;">${escapeHtml(item)}</td>
                      </tr>`)
    .join("");

  return `
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}
                    </table>`;
}

/**
 * Seção destacada do QR. A imagem é um PNG servido pelo site — Gmail e Outlook
 * não exibem SVG nem data URI — e o botão abaixo abre a mesma página caso a
 * imagem seja bloqueada. Nenhum dos dois carrega dado pessoal: só o token.
 */
function checkinHtml(data: ReservationConfirmationData) {
  if (!data.checkinToken) return "";
  const rows: Array<[string, string]> = [
    ["Responsável", data.fullName],
    ["Experiência", data.experienceTitle],
    ["Data", formatSessionDate(data.startsAt)],
    ["Horário", formatSessionTime(data.startsAt)],
    ["Vagas reservadas", vagasLabel(data.quantity)],
  ];
  const details = rows
    .map(([label, value]) => `
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:${BRAND.ink};opacity:0.6;text-align:left;">${escapeHtml(label)}</td>
                        <td style="padding:6px 0;font-size:14px;font-weight:600;color:${BRAND.ink};text-align:right;">${escapeHtml(value)}</td>
                      </tr>`)
    .join("");

  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
                <tr>
                  <td align="center" style="padding:24px 18px;background-color:${BRAND.tint};border:2px solid ${BRAND.lake};border-radius:18px;">
                    <p style="margin:0;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.lake};font-weight:700;">${escapeHtml(CHECKIN_TITLE)}</p>
                    <p style="margin:10px 0 18px;font-size:15px;line-height:23px;color:${BRAND.ink};">${escapeHtml(CHECKIN_NOTE)}</p>
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

/** Logo oficial (branca, recortada para o cabeçalho), servida pelo site. */
export const EMAIL_LOGO_PATH = "/images/email/alma-azul-logo-branca.png";

/**
 * Moldura comum aos e-mails: cabeçalho da marca, corpo e rodapé de contato.
 * `logo` troca o nome em texto pela logo oficial no
 * cabeçalho (o texto alternativo mantém o nome quando a imagem é bloqueada);
 * sem ele a moldura é exatamente a de sempre.
 */
export function emailLayout({ title, preheader, heading, body, logo = false }: { title: string; preheader: string; heading: string; body: string; logo?: boolean }) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.paper};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.paper};">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background-color:#ffffff;border-radius:20px;overflow:hidden;">
          <tr>
            <td style="padding:28px 28px 20px;background-color:${BRAND.forest};${logo ? `font-family:${SANS};` : ""}">
              ${logo
                ? `<img src="${absoluteUrl(EMAIL_LOGO_PATH)}" width="120" height="50" alt="${escapeHtml(SITE_NAME)}" style="display:block;width:120px;height:50px;border:0;font-family:${SANS};font-size:14px;line-height:20px;color:#ffffff;">`
                : `<p style="margin:0;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.sand};">${escapeHtml(SITE_NAME)}</p>`}
              <h1 style="margin:${logo ? "16px" : "10px"} 0 0;font-size:26px;line-height:32px;font-weight:600;color:#ffffff;">${escapeHtml(heading)}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;font-family:${SANS};">${body}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 28px;background-color:${BRAND.mist};font-family:${SANS};">
              <p style="margin:0 0 8px;font-size:13px;line-height:20px;color:${BRAND.ink};opacity:0.7;">
                WhatsApp <a href="${whatsappLink()}" style="color:${BRAND.lake};text-decoration:none;">${escapeHtml(formatWhatsappNumber())}</a>
                &nbsp;·&nbsp; <a href="mailto:${CONTACT_EMAIL}" style="color:${BRAND.lake};text-decoration:none;">${escapeHtml(CONTACT_EMAIL)}</a>
              </p>
              <p style="margin:0;font-size:13px;line-height:20px;color:${BRAND.ink};opacity:0.7;">
                <a href="${INSTAGRAM_LINK}" style="color:${BRAND.lake};text-decoration:none;">${escapeHtml(INSTAGRAM_HANDLE)}</a>
                &nbsp;·&nbsp; <a href="${SITE_URL}" style="color:${BRAND.lake};text-decoration:none;">${escapeHtml(SITE_URL.replace("https://", ""))}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Botão de ação em tabela: é o formato que sobrevive ao Outlook. */
function actionButton(href: string, label: string, color: string) {
  return `
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 0;">
                      <tr><td style="border-radius:999px;background-color:${color};">
                        <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
                      </td></tr>
                    </table>`;
}

function paragraphs(lines: readonly string[]) {
  return lines
    .map((line, index) => `
                    <p style="margin:0 0 ${index === lines.length - 1 ? "0" : "10px"};font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.8;">${escapeHtml(line)}</p>`)
    .join("");
}

/** Tabela de dados no fundo areia: rótulo à esquerda, valor à direita. */
function detailsTable(rows: Array<[string, string]>) {
  const body = rows
    .map(([label, value]) => `
                      <tr>
                        <td style="padding:10px 0;border-bottom:1px solid ${BRAND.mist};font-size:14px;color:${BRAND.ink};opacity:0.6;">${escapeHtml(label)}</td>
                        <td style="padding:10px 0;border-bottom:1px solid ${BRAND.mist};font-size:15px;font-weight:600;color:${BRAND.ink};text-align:right;">${escapeHtml(value)}</td>
                      </tr>`)
    .join("");

  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.paper};border-radius:14px;padding:4px 16px;margin:0 0 20px;">
                <tr><td style="padding:4px 0;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}
                  </table>
                </td></tr>
              </table>`;
}

/** Cartão de abertura: o nome da experiência, a data e o horário. */
function experienceCard(data: ReservationConfirmationData) {
  const line = (label: string, value: string) => `
                      <tr>
                        <td width="72" valign="top" style="padding:3px 0;font-size:13px;line-height:24px;color:${BRAND.ink};opacity:0.6;">${escapeHtml(label)}</td>
                        <td style="padding:3px 0;font-size:16px;line-height:24px;font-weight:600;color:${BRAND.ink};">${escapeHtml(value)}</td>
                      </tr>`;

  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;">
                <tr>
                  <td style="padding:20px 18px;background-color:${BRAND.tint};border-radius:14px;">
                    <p style="margin:0;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.lake};font-weight:600;">Sua experiência</p>
                    <p style="margin:6px 0 0;font-size:24px;line-height:31px;font-weight:600;color:${BRAND.forest};">${escapeHtml(data.experienceTitle)}</p>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 0;">${line("Data", formatSessionDate(data.startsAt))}${line("Horário", formatSessionTime(data.startsAt))}
                    </table>
                  </td>
                </tr>
              </table>`;
}

/** Largura útil do corpo: 560px da moldura menos 28px de cada lado. */
const CONTENT_WIDTH = 504;

/**
 * Cartão do ponto de encontro: foto real da base, o local, o endereço e o
 * botão "Como chegar". A foto é complemento — local e endereço são texto, e o
 * texto alternativo descreve a foto quando o cliente bloqueia imagens.
 */
export function meetingPointCard(data: ReservationConfirmationData) {
  const location = locationOf(data);
  const photo = meetingPointPhoto(location.baseSlug);
  const address = meetingAddressOf(location);

  const photoRow = photo
    ? `
                <tr>
                  <td style="padding:0;background-color:${BRAND.mist};border-radius:14px 14px 0 0;">
                    <img src="${escapeHtml(photo.url)}" width="${CONTENT_WIDTH}" alt="${escapeHtml(photo.alt)}" style="display:block;width:100%;max-width:${CONTENT_WIDTH}px;height:auto;border:0;border-radius:14px 14px 0 0;font-family:${SANS};font-size:13px;line-height:20px;color:${BRAND.ink};">
                  </td>
                </tr>`
    : "";

  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;background-color:${BRAND.tint};border-radius:14px;">${photoRow}
                <tr>
                  <td style="padding:16px 18px 18px;">
                    <p style="margin:0;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.lake};font-weight:600;">📍 ${escapeHtml(MEETING_POINT_TITLE)}</p>
                    <p style="margin:6px 0 0;font-size:20px;line-height:28px;font-weight:600;color:${BRAND.forest};">${escapeHtml(meetingPointOf(location))}</p>${address ? `
                    <p style="margin:8px 0 0;font-size:14px;line-height:21px;color:${BRAND.ink};opacity:0.8;">Endereço: ${escapeHtml(address)}</p>` : ""}${location.mapsUrl ? actionButton(location.mapsUrl, MAPS_BUTTON_LABEL, BRAND.lake) : ""}
                  </td>
                </tr>
              </table>`;
}

function arrivalHtml(data: ReservationConfirmationData) {
  if (usesOriginTemplate(data)) {
    return infoSection(LAGO_NORTE_ARRIVAL_TITLE, paragraphs(LAGO_NORTE_ARRIVAL_PARAGRAPHS));
  }
  return infoSection(ARRIVAL_TITLE, paragraphs([`${MEETING_TIME_LABEL}: ${formatSessionTime(data.startsAt)}`, MEETING_TOLERANCE_NOTE]));
}

function guidanceHtml(data: ReservationConfirmationData, options: GuidanceOptions) {
  return `${meetingPointCard(data)}
              <div style="height:8px;line-height:8px;">&nbsp;</div>
${arrivalHtml(data)}
${infoSection(WHAT_TO_BRING_TITLE, bulletList(WHAT_TO_BRING_ITEMS))}
${infoSection(IMPORTANT_INFO_TITLE, bulletList(importantItems(data, options.codeNote)))}${options.cancellation ? `
${infoSection(CANCELLATION_TITLE, paragraph(CANCELLATION_NOTE))}` : ""}
${infoSection(SUPPORT_TITLE, paragraph(SUPPORT_NOTE) + actionButton(whatsappLink(), WHATSAPP_BUTTON_LABEL, BRAND.forest))}`;
}

function signoffHtml(signoff: string) {
  return `
              <p style="margin:28px 0 4px;font-size:15px;line-height:24px;color:${BRAND.ink};">${escapeHtml(signoff)}</p>
              <p style="margin:0;font-size:15px;line-height:24px;font-weight:600;color:${BRAND.forest};">Equipe ${escapeHtml(SITE_NAME)}</p>
`;
}

function buildHtml(data: ReservationConfirmationData) {
  const origin = usesOriginTemplate(data);
  const intro = origin
    ? `
              <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.75;">${escapeHtml(ORIGIN_INTRO)}</p>`
    : NEW_BASE_INTRO
        .map((text, index) => `
              <p style="margin:0 0 ${index === NEW_BASE_INTRO.length - 1 ? "24px" : "12px"};font-size:15px;line-height:24px;color:${BRAND.ink};opacity:${index === 0 ? "1" : "0.75"};${index === 0 ? "font-weight:600;" : ""}">${escapeHtml(text)}</p>`)
        .join("");

  return emailLayout({
    title: reservationConfirmationSubject(data.publicCode, locationOf(data)),
    preheader: `Sua reserva ${data.publicCode} está confirmada.`,
    heading: "Reserva confirmada",
    logo: true,
    body: `
              <p style="margin:0 0 16px;font-size:17px;line-height:26px;font-weight:600;color:${BRAND.ink};">Olá, ${escapeHtml(firstName(data.fullName))}!</p>${intro}
${experienceCard(data)}
${detailsTable(reservationRows(data))}
${checkinHtml(data)}
${guidanceHtml(data, { cancellation: true, codeNote: RESERVATION_CODE_NOTE })}
${signoffHtml(origin ? ORIGIN_SIGNOFF : NEW_BASE_SIGNOFF)}`,
  });
}

export function buildReservationConfirmationEmail(data: ReservationConfirmationData): ConfirmationEmail {
  if (data.eventContentInvalid) throw new Error(EVENT_EMAIL_NOT_READY);
  if (data.event) return buildEventConfirmationEmail(data, data.event);
  return {
    to: data.email,
    subject: reservationConfirmationSubject(data.publicCode, locationOf(data)),
    html: buildHtml(data),
    text: buildText(data),
  };
}

// --- Lembrete com o QR ("Reenviar QR Code") ---------------------------------

export function checkinReminderSubject(experienceTitle: string) {
  return `Seu QR Code de check-in — ${experienceTitle}`;
}

/**
 * Lembrete enviado pelo painel. Reaproveita a mesma seção do QR — e o mesmo
 * token — da confirmação. Exige token: sem ele não há o que reenviar.
 */
export function buildCheckinReminderEmail(data: ReservationConfirmationData): ConfirmationEmail | null {
  if (!data.checkinToken) return null;
  if (data.eventContentInvalid) return null;
  if (data.event) return buildEventCheckinReminderEmail(data, data.event);
  const greeting = `Olá, ${firstName(data.fullName)}!`;
  const intro = "Passando para confirmar sua experiência na Alma Azul Academy.";
  const summary: Array<[string, string]> = [
    ["Experiência", data.experienceTitle],
    ["Data", formatSessionDate(data.startsAt)],
    ["Horário", formatSessionTime(data.startsAt)],
    ["Vagas reservadas", vagasLabel(data.quantity)],
  ];
  const instruction = "No dia da experiência, apresente o QR Code abaixo à nossa equipe para realizar seu check-in.";

  const text = [
    greeting,
    "",
    intro,
    "",
    ...summary.map(([label, value]) => `${label}: ${value}`),
    "",
    instruction,
    `${CHECKIN_LINK_LABEL}: ${checkinUrl(data.checkinToken)}`,
    "",
    `Local: ${locationText(data).join("\n")}`,
    MEETING_TOLERANCE_NOTE,
    "",
    "Nos vemos na água!",
    SITE_NAME,
    "",
    "—",
    `WhatsApp: ${formatWhatsappNumber()}`,
    `E-mail: ${CONTACT_EMAIL}`,
    SITE_URL,
  ].join("\n");

  const summaryRows = summary
    .map(([label, value]) => `
                      <tr>
                        <td style="padding:10px 0;border-bottom:1px solid ${BRAND.mist};font-size:14px;color:${BRAND.ink};opacity:0.6;">${escapeHtml(label)}</td>
                        <td style="padding:10px 0;border-bottom:1px solid ${BRAND.mist};font-size:15px;font-weight:600;color:${BRAND.ink};text-align:right;">${escapeHtml(value)}</td>
                      </tr>`)
    .join("");

  const html = emailLayout({
    title: checkinReminderSubject(data.experienceTitle),
    preheader: "Seu QR Code de check-in para a experiência na Alma Azul.",
    heading: "Nos vemos na água!",
    body: `
              <p style="margin:0 0 16px;font-size:17px;line-height:26px;font-weight:600;color:${BRAND.ink};">${escapeHtml(greeting)}</p>
              <p style="margin:0 0 20px;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.75;">${escapeHtml(intro)}</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.paper};border-radius:14px;padding:4px 16px;margin:0 0 20px;">
                <tr><td style="padding:4px 0;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${summaryRows}
                  </table>
                </td></tr>
              </table>
${checkinHtml(data)}
${locationCard(data)}
${highlightCard("Horário de encontro", formatSessionTime(data.startsAt), MEETING_TOLERANCE_NOTE)}
              <p style="margin:24px 0 4px;font-size:15px;line-height:24px;color:${BRAND.ink};">Nos vemos na água!</p>
              <p style="margin:0;font-size:15px;line-height:24px;font-weight:600;color:${BRAND.forest};">${escapeHtml(SITE_NAME)}</p>
`,
  });

  return { to: data.email, subject: checkinReminderSubject(data.experienceTitle), html, text };
}

// --- Confirmação de reagendamento (Stand-by) --------------------------------

/** O código é o da reserva original: reagendar não cria reserva nova. */
export function rescheduleConfirmationSubject(publicCode: string) {
  return `Reagendamento confirmado — ${publicCode}`;
}

export const RESCHEDULE_HEADING = "Reagendamento confirmado";

export const RESCHEDULE_INTRO =
  "Sua reserva foi reagendada e está confirmada. Confira os novos detalhes da sua experiência:";

/** O que mais gera dúvida depois de um reagendamento: se é preciso pagar de novo. */
export const RESCHEDULE_PAYMENT_LABEL = "Pagamento";

export const RESCHEDULE_PAYMENT_HEADLINE = "Seu pagamento continua válido";

export const RESCHEDULE_PAYMENT_NOTE =
  "Esta é a mesma reserva, com o mesmo código. Não há nova cobrança e você não precisa pagar novamente.";

export const RESCHEDULE_QR_NOTE = "O QR Code da sua reserva continua o mesmo e vale para a nova data.";

const RESCHEDULE_SIGNOFF = "Nos vemos na água!";

/** No reagendamento o código é o mesmo da reserva original. */
export const RESCHEDULE_CODE_NOTE = "O código da sua reserva não mudou: é por ele que identificamos o seu agendamento.";

/** Os dados da turma nova, iguais para todas as bases. */
function rescheduleRows(data: ReservationConfirmationData): Array<[string, string]> {
  return [
    ["Código da reserva", data.publicCode],
    ["Experiência", data.experienceTitle],
    ["Data", formatSessionDate(data.startsAt)],
    ["Horário", formatSessionTime(data.startsAt)],
    ["Base", locationOf(data).baseName],
    ["Participantes", `${data.quantity}`],
  ];
}

/**
 * Enviado quando uma reserva em Stand-by é reagendada. Não é o e-mail de
 * pagamento de novo: é outra mensagem, com a turma nova, o mesmo código, o
 * mesmo QR e o aviso de que nada precisa ser pago outra vez. Do ponto de
 * encontro em diante, as orientações são as mesmas da confirmação.
 *
 * A política de cancelamento fica de fora de propósito: o que vale para uma
 * reserva reagendada é decisão da operação, e este e-mail não a antecipa.
 */
export function buildReservationRescheduleEmail(data: ReservationConfirmationData): ConfirmationEmail {
  if (data.eventContentInvalid) throw new Error(EVENT_EMAIL_NOT_READY);
  if (data.event) return buildEventRescheduleEmail(data, data.event);
  const subject = rescheduleConfirmationSubject(data.publicCode);
  const greeting = `Olá, ${firstName(data.fullName)}!`;
  const rows = rescheduleRows(data);
  const guidance: GuidanceOptions = { cancellation: false, codeNote: RESCHEDULE_CODE_NOTE };

  const text = [
    greeting,
    "",
    RESCHEDULE_INTRO,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    RESCHEDULE_PAYMENT_HEADLINE.toUpperCase(),
    RESCHEDULE_PAYMENT_NOTE,
    "",
    ...checkinText(data),
    ...(data.checkinToken ? [RESCHEDULE_QR_NOTE, ""] : []),
    ...guidanceText(data, guidance),
    RESCHEDULE_SIGNOFF,
    `Equipe ${SITE_NAME}`,
    "",
    ...textFooter(),
  ].join("\n");

  const qrNote = data.checkinToken
    ? `
              <p style="margin:0 0 16px;font-size:14px;line-height:22px;color:${BRAND.ink};opacity:0.75;text-align:center;">${escapeHtml(RESCHEDULE_QR_NOTE)}</p>`
    : "";

  const html = emailLayout({
    title: subject,
    preheader: `Sua reserva ${data.publicCode} tem nova data. O pagamento continua válido.`,
    heading: RESCHEDULE_HEADING,
    logo: true,
    body: `
              <p style="margin:0 0 16px;font-size:17px;line-height:26px;font-weight:600;color:${BRAND.ink};">${escapeHtml(greeting)}</p>
              <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.75;">${escapeHtml(RESCHEDULE_INTRO)}</p>
${detailsTable(rows)}
${highlightCard(RESCHEDULE_PAYMENT_LABEL, RESCHEDULE_PAYMENT_HEADLINE, RESCHEDULE_PAYMENT_NOTE)}
${checkinHtml(data)}${qrNote}
${guidanceHtml(data, guidance)}
${signoffHtml(RESCHEDULE_SIGNOFF)}`,
  });

  return { to: data.email, subject, html, text };
}

// --- Leitura defensiva do que vem do banco ----------------------------------

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * Converte o retorno da RPC em dados de mensagem.
 *
 * Devolve null quando falta qualquer coisa indispensável — inclusive quando o
 * status não é CONFIRMED. A RPC já filtra por status; esta é a segunda tranca.
 */
export function parseReservationConfirmationData(value: unknown): ReservationConfirmationData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;

  if (asString(row.status) !== "CONFIRMED") return null;

  const data: ReservationConfirmationData = {
    reservationId: asString(row.reservationId),
    publicCode: asString(row.publicCode),
    fullName: asString(row.fullName).trim(),
    email: asString(row.email).trim(),
    quantity: Math.max(1, asNumber(row.quantity)),
    experienceTitle: asString(row.experienceTitle),
    startsAt: asString(row.startsAt),
    checkinToken: isCheckinToken(row.checkinToken) ? row.checkinToken.toLowerCase() : null,
    durationMinutes: asNumber(row.durationMinutes) > 0 ? asNumber(row.durationMinutes) : null,
    // A base vem do banco. Payload sem base só existe antes da migration de
    // lançamento da segunda base, quando toda reserva é do Lago Norte.
    location: parseBaseLocation(row) ?? LAGO_NORTE_LOCATION,
  };

  // Evento especial (`withEventEmailContext`): o e-mail sai do conteúdo do
  // evento, e só se ele tiver tudo o que o e-mail precisa.
  if (row.experienceKind === "EVENT") {
    const editorial = validateEventEditorial(row.eventEditorial);
    if (editorial.success && isEventEmailReady(editorial.data.event)) data.event = editorial.data.event;
    else data.eventContentInvalid = true;
  }

  if (!data.reservationId || !data.publicCode || !data.fullName || !data.startsAt) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return null;

  return data;
}

// --- Orquestração do envio ---------------------------------------------------

export type ConfirmationEmailOutcome =
  /** Enviado agora. */
  | "SENT"
  /** Nada a fazer: já enviado antes, reserva não confirmada, ou envio em curso. */
  | "SKIPPED"
  /** Falhou; o job ficou registrado para nova tentativa. */
  | "PENDING"
  /** Provedor de e-mail não configurado neste ambiente. */
  | "DISABLED";

export type ConfirmationEmailResult = {
  outcome: ConfirmationEmailOutcome;
  errorCode?: string;
};

export type ConfirmationEmailDeps = {
  /** Devolve o id do job quando este chamador tem direito de enviar, ou null. */
  claim: () => Promise<string | null>;
  load: () => Promise<unknown>;
  send: (message: ConfirmationEmail) => Promise<void>;
  complete: (jobId: string) => Promise<void>;
  fail: (jobId: string, errorCode: string) => Promise<void>;
  sanitizeError: (error: unknown) => string;
};

/**
 * O envio propriamente dito, sem conhecer Supabase nem provedor.
 *
 * A ordem é o que garante a idempotência: **reivindica primeiro, envia depois**.
 * Quem não conseguir a reivindicação não envia — e é assim que um webhook
 * duplicado, um reprocessamento ou dois cliques simultâneos terminam em um único
 * e-mail. Falhar depois de reivindicar marca o job como FAILED, que é o único
 * estado que permite nova tentativa.
 */
export async function deliverReservationConfirmationEmail(
  deps: ConfirmationEmailDeps,
): Promise<ConfirmationEmailResult> {
  const jobId = await deps.claim();
  if (!jobId) return { outcome: "SKIPPED" };

  try {
    const data = parseReservationConfirmationData(await deps.load());
    if (!data) {
      // Sem dado utilizável não adianta insistir: encerra o job para ele não
      // ficar girando na fila para sempre.
      await deps.complete(jobId);
      return { outcome: "SKIPPED", errorCode: "PAYLOAD_EMPTY" };
    }

    await deps.send(buildReservationConfirmationEmail(data));
    await deps.complete(jobId);
    return { outcome: "SENT" };
  } catch (error) {
    const errorCode = deps.sanitizeError(error);
    await deps.fail(jobId, errorCode).catch(() => undefined);
    return { outcome: "PENDING", errorCode };
  }
}
