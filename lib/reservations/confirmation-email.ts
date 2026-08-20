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
 */

import { CONTACT_EMAIL, INSTAGRAM_HANDLE, INSTAGRAM_LINK, WHATSAPP_NUMBER } from "../contact.ts";
import { formatSessionDate, formatSessionTime } from "../sessions/date-time.ts";
import { SITE_NAME, SITE_URL } from "../site.ts";

/** Local de encontro das experiências. */
export const MEETING_LOCATION = "Lago Norte";

/** Paleta da marca, espelhando as variáveis de `app/globals.css`. */
const BRAND = {
  ink: "#14312c",
  paper: "#f7f5ef",
  mist: "#e9eee8",
  lake: "#277f87",
  forest: "#214f43",
  sand: "#d7c5a0",
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

const BODY_PARAGRAPHS = [
  "O encontro acontecerá no mesmo horário selecionado durante a reserva. Recomendamos chegar com alguns minutos de antecedência para que possamos começar tudo com tranquilidade.",
  "Até um dia antes da experiência, você será adicionado(a) a um grupo de comunicação. Por lá, reforçaremos as orientações importantes, os detalhes do ponto de encontro e facilitaremos nosso contato no dia da remada.",
  "Por favor, guarde o código da reserva para facilitar a identificação do seu agendamento.",
  "Se precisar falar conosco antes disso, responda a este e-mail ou utilize o nosso canal oficial de atendimento.",
];

/**
 * Linhas de dados da reserva. O horário e a data saem sempre no fuso de
 * Brasília, que é o mesmo usado pelo site na hora de escolher a sessão.
 */
function detailRows(data: ReservationConfirmationData) {
  const rows: Array<[string, string]> = [
    ["Código da reserva", data.publicCode],
    ["Experiência", data.experienceTitle],
    ["Data", formatSessionDate(data.startsAt)],
    ["Horário de encontro", formatSessionTime(data.startsAt)],
    ["Local da experiência", MEETING_LOCATION],
  ];
  if (data.quantity > 1) rows.push(["Pessoas", `${data.quantity}`]);
  return rows;
}

function buildText(data: ReservationConfirmationData) {
  const rows = detailRows(data).map(([label, value]) => `${label}: ${value}`);

  return [
    `Olá, ${firstName(data.fullName)}!`,
    "",
    "Sua reserva está confirmada. Será um prazer receber você para essa experiência!",
    "",
    ...rows,
    "",
    ...BODY_PARAGRAPHS.flatMap((paragraph) => [paragraph, ""]),
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

function buildHtml(data: ReservationConfirmationData) {
  const rows = detailRows(data)
    .map(([label, value]) => `
              <tr>
                <td style="padding:10px 0;border-bottom:1px solid ${BRAND.mist};font-size:14px;color:${BRAND.ink};opacity:0.6;">${escapeHtml(label)}</td>
                <td style="padding:10px 0;border-bottom:1px solid ${BRAND.mist};font-size:15px;font-weight:600;color:${BRAND.ink};text-align:right;">${escapeHtml(value)}</td>
              </tr>`)
    .join("");

  const paragraphs = BODY_PARAGRAPHS
    .map((paragraph) => `
            <p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.75;">${escapeHtml(paragraph)}</p>`)
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
            <td style="padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
              <p style="margin:0 0 16px;font-size:17px;line-height:26px;font-weight:600;color:${BRAND.ink};">Olá, ${escapeHtml(firstName(data.fullName))}!</p>
              <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:${BRAND.ink};opacity:0.75;">Sua reserva está confirmada. Será um prazer receber você para essa experiência!</p>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.paper};border-radius:14px;padding:4px 16px;">
                <tr><td style="padding:4px 0;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}
                  </table>
                </td></tr>
              </table>

              <div style="height:24px;line-height:24px;">&nbsp;</div>
${paragraphs}
              <p style="margin:24px 0 4px;font-size:15px;line-height:24px;color:${BRAND.ink};">Até breve!</p>
              <p style="margin:0;font-size:15px;line-height:24px;font-weight:600;color:${BRAND.forest};">Equipe ${escapeHtml(SITE_NAME)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 28px;background-color:${BRAND.mist};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
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
