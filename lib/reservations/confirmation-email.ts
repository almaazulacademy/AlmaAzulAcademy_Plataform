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
 * O corpo concentra de propósito as respostas que hoje chegam por WhatsApp:
 * onde é, a que horas, o que levar, quanto dura, como cancelar e quando o grupo
 * de comunicação aparece. Cada uma dessas seções é uma constante exportada,
 * para que o teste verifique exatamente o texto que o cliente lê.
 */

import { CONTACT_EMAIL, INSTAGRAM_HANDLE, INSTAGRAM_LINK, WHATSAPP_NUMBER } from "../contact.ts";
import { formatSessionDate, formatSessionTime } from "../sessions/date-time.ts";
import { SITE_NAME, SITE_URL } from "../site.ts";

/**
 * Endereço do ponto de encontro das experiências.
 *
 * Só texto: o projeto não tem link de mapa nem coordenada em lugar nenhum, e
 * inventar um aqui seria criar informação que ninguém conferiu. Quando existir
 * um link oficial, ele entra nesta constante e no bloco de localização.
 *
 * BLOQUEADOR MULTI-BASE (antes de abrir reservas em qualquer base além do Lago
 * Norte): este endereço é fixo no Lago Norte. O local de encontro do e-mail,
 * da confirmação e das demais comunicações precisa vir da base da sessão da
 * reserva (`bases.address`). Ver docs/multi-base.md.
 */
export const MEETING_LOCATION = "QL 5 Conjunto 5 - Lago Norte";

/** Tolerância de chegada, contada a partir do horário da sessão reservada. */
export const MEETING_TOLERANCE_NOTE = "Tolerância de até 20 minutos após o horário marcado.";

/** O que o cliente precisa saber antes de sair de casa. */
export const PREPARATION_TITLE = "Antes de vir";

export const PREPARATION_ITEMS = [
  "Não é necessário ter experiência com esportes ou canoa. A remada em grupo é tranquila de acompanhar e aprender.",
  "Traga roupa de banho, repelente e roupa confortável para praticar atividade física.",
  "Recomendamos vir de chinelo.",
] as const;

/**
 * Duração da experiência.
 *
 * Texto fixo, e não `duration_minutes` da sessão: a RPC que alimenta este
 * e-mail não devolve a duração, todas as experiências atuais duram 90 minutos e
 * a frase fala também da parada para banho, que nenhum campo do banco carrega.
 * Buscar a duração dinamicamente exigiria mexer na RPC — fora do escopo aqui.
 */
export const DURATION_TITLE = "Duração";

export const DURATION_NOTE =
  "A experiência dura em torno de 1h30 e conta com uma parada para banho durante a remada.";

/** Política de cancelamento. Texto operacional — não ampliar nem restringir. */
export const CANCELLATION_TITLE = "Imprevistos acontecem";

export const CANCELLATION_NOTE =
  "Caso ocorra algum imprevisto, é permitido solicitar cancelamento com reembolso ou crédito para uma próxima remada até 1 dia antes do horário marcado.";

/** Aviso do grupo de comunicação, o que mais reduz mensagem individual. */
export const GROUP_TITLE = "Criaremos um grupo";

export const GROUP_NOTE =
  "Até 1 dia antes da sua experiência, criaremos um grupo para facilitar a comunicação, enviar orientações finais e manter todos atualizados.";

/** Fechamento: o código e o canal de contato. */
const CLOSING_PARAGRAPHS = [
  "Guarde o código da reserva: é por ele que identificamos o seu agendamento.",
  "Se precisar falar conosco antes disso, responda a este e-mail ou utilize o nosso canal oficial de atendimento.",
] as const;

/** Paleta da marca, espelhando as variáveis de `app/globals.css`. */
const BRAND = {
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
};

export type ConfirmationEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

/** Primeiro nome, para o cumprimento não ficar solene demais. */
function firstName(fullName: string) {
  return fullName.trim().split(/\s+/)[0] || fullName.trim();
}

/** Escapa o que vai para dentro do HTML. Nome de cliente é entrada de usuário. */
function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function whatsappLink() {
  return `https://wa.me/${WHATSAPP_NUMBER}`;
}

function formatWhatsappNumber() {
  const digits = WHATSAPP_NUMBER.replace(/\D/g, "").replace(/^55/, "");
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  return WHATSAPP_NUMBER;
}

export function reservationConfirmationSubject(publicCode: string) {
  return `Reserva confirmada — ${publicCode}`;
}

/**
 * Linhas de dados da reserva. A data sai sempre no fuso de Brasília, que é o
 * mesmo usado pelo site na hora de escolher a sessão. O horário tem bloco
 * próprio, logo abaixo, junto da tolerância.
 */
function detailRows(data: ReservationConfirmationData) {
  const rows: Array<[string, string]> = [
    ["Código da reserva", data.publicCode],
    ["Experiência", data.experienceTitle],
    ["Data", formatSessionDate(data.startsAt)],
  ];
  if (data.quantity > 1) rows.push(["Pessoas", `${data.quantity}`]);
  return rows;
}

// --- Versão em texto puro ----------------------------------------------------

function buildText(data: ReservationConfirmationData) {
  const rows = detailRows(data).map(([label, value]) => `${label}: ${value}`);

  return [
    `Olá, ${firstName(data.fullName)}!`,
    "",
    "Sua reserva está confirmada. Será um prazer receber você para essa experiência!",
    "",
    ...rows,
    "",
    "Localização",
    MEETING_LOCATION,
    "",
    "Horário de encontro",
    formatSessionTime(data.startsAt),
    MEETING_TOLERANCE_NOTE,
    "",
    PREPARATION_TITLE,
    ...PREPARATION_ITEMS.map((item) => `- ${item}`),
    "",
    DURATION_TITLE,
    DURATION_NOTE,
    "",
    CANCELLATION_TITLE,
    CANCELLATION_NOTE,
    "",
    GROUP_TITLE,
    GROUP_NOTE,
    "",
    ...CLOSING_PARAGRAPHS.flatMap((paragraph) => [paragraph, ""]),
    "Até breve!",
    `Equipe ${SITE_NAME}`,
    "",
    "—",
    `WhatsApp: ${formatWhatsappNumber()}`,
    `E-mail: ${CONTACT_EMAIL}`,
    `Instagram: ${INSTAGRAM_HANDLE}`,
    SITE_URL,
  ].join("\n");
}

// --- Versão HTML -------------------------------------------------------------

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

/** Cartão destacado: rótulo pequeno, valor grande e, quando houver, uma nota. */
function highlightCard(label: string, value: string, note?: string) {
  const noteHtml = note
    ? `
                <p style="margin:8px 0 0;font-size:14px;line-height:21px;color:${BRAND.ink};opacity:0.7;">${escapeHtml(note)}</p>`
    : "";

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

/** Seção de leitura: título curto e um parágrafo ou uma lista curta. */
function infoSection(title: string, body: string) {
  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 4px;">
                <tr>
                  <td style="padding:18px 0 0;border-top:1px solid ${BRAND.mist};">
                    <p style="margin:0 0 8px;font-size:16px;line-height:24px;font-weight:600;color:${BRAND.forest};">${escapeHtml(title)}</p>${body}
                  </td>
                </tr>
              </table>`;
}

function paragraph(text: string) {
  return `
                    <p style="margin:0;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.8;">${escapeHtml(text)}</p>`;
}

/** Lista com marcador em célula própria: é o que sobrevive ao Outlook. */
function bulletList(items: readonly string[]) {
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

function buildHtml(data: ReservationConfirmationData) {
  const rows = detailRows(data)
    .map(([label, value]) => `
                      <tr>
                        <td style="padding:10px 0;border-bottom:1px solid ${BRAND.mist};font-size:14px;color:${BRAND.ink};opacity:0.6;">${escapeHtml(label)}</td>
                        <td style="padding:10px 0;border-bottom:1px solid ${BRAND.mist};font-size:15px;font-weight:600;color:${BRAND.ink};text-align:right;">${escapeHtml(value)}</td>
                      </tr>`)
    .join("");

  const closing = CLOSING_PARAGRAPHS
    .map((text) => `
              <p style="margin:0 0 14px;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.75;">${escapeHtml(text)}</p>`)
    .join("");

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(reservationConfirmationSubject(data.publicCode))}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.paper};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Sua reserva ${escapeHtml(data.publicCode)} está confirmada.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.paper};">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background-color:#ffffff;border-radius:20px;overflow:hidden;">
          <tr>
            <td style="padding:28px 28px 20px;background-color:${BRAND.forest};">
              <p style="margin:0;font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.sand};">${escapeHtml(SITE_NAME)}</p>
              <h1 style="margin:10px 0 0;font-size:26px;line-height:32px;font-weight:600;color:#ffffff;">Reserva confirmada</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;font-family:${SANS};">
              <p style="margin:0 0 16px;font-size:17px;line-height:26px;font-weight:600;color:${BRAND.ink};">Olá, ${escapeHtml(firstName(data.fullName))}!</p>
              <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.75;">Sua reserva está confirmada. Será um prazer receber você para essa experiência!</p>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.paper};border-radius:14px;padding:4px 16px;margin:0 0 20px;">
                <tr><td style="padding:4px 0;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}
                  </table>
                </td></tr>
              </table>
${highlightCard("Localização", MEETING_LOCATION)}
${highlightCard("Horário de encontro", formatSessionTime(data.startsAt), MEETING_TOLERANCE_NOTE)}
              <div style="height:12px;line-height:12px;">&nbsp;</div>
${infoSection(PREPARATION_TITLE, bulletList(PREPARATION_ITEMS))}
${infoSection(DURATION_TITLE, paragraph(DURATION_NOTE))}
${infoSection(CANCELLATION_TITLE, paragraph(CANCELLATION_NOTE))}
${infoSection(GROUP_TITLE, paragraph(GROUP_NOTE))}
              <div style="height:24px;line-height:24px;">&nbsp;</div>
${closing}
              <p style="margin:24px 0 4px;font-size:15px;line-height:24px;color:${BRAND.ink};">Até breve!</p>
              <p style="margin:0;font-size:15px;line-height:24px;font-weight:600;color:${BRAND.forest};">Equipe ${escapeHtml(SITE_NAME)}</p>
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

export function buildReservationConfirmationEmail(data: ReservationConfirmationData): ConfirmationEmail {
  return {
    to: data.email,
    subject: reservationConfirmationSubject(data.publicCode),
    html: buildHtml(data),
    text: buildText(data),
  };
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
  };

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
