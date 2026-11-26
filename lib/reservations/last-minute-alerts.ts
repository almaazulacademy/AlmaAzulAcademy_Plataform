/** Fila interna de última hora. Sem rede ou configuração implícita neste módulo. */
import { emailDeliveryOf, isRetryableEmailError, sanitizeEmailErrorCode, type EmailMessage, type EmailProvider } from "../email/email-provider.ts";
import { formatSessionDateTime } from "../sessions/date-time.ts";

export const ALERT_RECIPIENT = "almaazulacademy@gmail.com";
export const ALERT_BATCH_SIZE = 2;

type RecordValue = Record<string, unknown>;
export type AlertPayload = {
  reservationId: string;
  priority: "URGENTE" | "PRIORITARIO";
  lateConfirmation: boolean;
  origin: "CONFIRMATION" | "RESCHEDULE" | "SESSION_TIME_CHANGED";
  experienceTitle: string;
  baseName: string;
  startsAt: string;
  confirmedAt: string;
  occurredAt: string;
  quantity: number;
};
type AlertClaim = { id: string; claimToken: string; attempt: number; payload: AlertPayload };
export type AlertReport = { outcome: "PROCESSED" | "DISABLED" | "FAILED"; processed: number; sent: number; errorCode?: string };
export type AlertLog = { outcome: "sent" | "skipped" | "failed"; alertId: string; attempt: number; errorCode?: string };
export type AlertRpcClient = { rpc(name: string, args: RecordValue): PromiseLike<{ data: unknown; error: unknown }> };

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseClaim(value: unknown): AlertClaim {
  const root = record(value);
  const p = record(root?.payload);
  if (!root || !p || typeof root.id !== "string" || !UUID.test(root.id)
    || typeof root.claimToken !== "string" || !UUID.test(root.claimToken)
    || !Number.isInteger(root.attempt) || Number(root.attempt) < 1
    || typeof p.reservationId !== "string" || !UUID.test(p.reservationId)
    || !["URGENTE", "PRIORITARIO"].includes(String(p.priority))
    || !["CONFIRMATION", "RESCHEDULE", "SESSION_TIME_CHANGED"].includes(String(p.origin))
    || typeof p.lateConfirmation !== "boolean"
    || typeof p.experienceTitle !== "string" || !p.experienceTitle.trim()
    || typeof p.baseName !== "string" || !p.baseName.trim()
    || !Number.isInteger(p.quantity) || Number(p.quantity) < 1
    || [p.startsAt, p.confirmedAt, p.occurredAt].some((date) => typeof date !== "string" || !Number.isFinite(Date.parse(date)))) {
    throw new Error("INVALID_ALERT_CLAIM");
  }
  return { id: root.id, claimToken: root.claimToken, attempt: Number(root.attempt), payload: p as AlertPayload };
}

function messageContent(value: unknown): EmailMessage {
  const m = record(value);
  if (!m || m.to !== ALERT_RECIPIENT || typeof m.subject !== "string" || typeof m.html !== "string" || typeof m.text !== "string") {
    throw new Error("INVALID_ALERT_MESSAGE");
  }
  return { to: ALERT_RECIPIENT, subject: m.subject, html: m.html, text: m.text };
}
function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function buildLastMinuteAlert(payload: AlertPayload, siteUrl: string): EmailMessage {
  const origin = new URL(siteUrl);
  if (origin.protocol !== "https:") throw new Error("INVALID_SITE_URL");
  const link = new URL(`/admin/reservas/${encodeURIComponent(payload.reservationId)}`, origin.origin).href;
  const priority = payload.priority === "URGENTE" ? "URGENTE" : "PRIORITÁRIO";
  const event = payload.lateConfirmation ? "Confirmação após o início"
    : payload.origin === "RESCHEDULE" ? "Reserva remarcada"
      : payload.origin === "SESSION_TIME_CHANGED" ? "Horário da sessão alterado" : "Nova reserva confirmada";
  const fields: Array<[string, string]> = [
    ["Tipo", `${priority} — ${event}`],
    ["Experiência", payload.experienceTitle],
    ["Base", payload.baseName],
    ["Dia e horário da sessão", formatSessionDateTime(payload.startsAt)],
    ["Confirmação da reserva", formatSessionDateTime(payload.confirmedAt)],
    ...(payload.origin !== "CONFIRMATION" ? [["Alteração", formatSessionDateTime(payload.occurredAt)] as [string, string]] : []),
    ["Participantes", String(payload.quantity)],
    ["Identificador da reserva", payload.reservationId],
  ];
  const subject = `[${priority}] ${payload.baseName} | ${formatSessionDateTime(payload.startsAt)} | ${payload.experienceTitle}`
    .replace(/[\r\n]/g, " ");
  const text = `${fields.map(([key, value]) => `${key}: ${value}`).join("\n")}\n\nAbrir reserva: ${link}\n\nHorários de Brasília (America/Sao_Paulo).`;
  const html = `<html lang="pt-BR"><body><h1>${escapeHtml(event)}</h1><table>${fields.map(([key, value]) => `<tr><th align="left">${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`).join("")}</table><p><a href="${escapeHtml(link)}">Abrir reserva no painel</a></p><p>Horários de Brasília (America/Sao_Paulo).</p></body></html>`;
  return { to: ALERT_RECIPIENT, subject, html, text };
}

export function createLastMinuteAlertQueue(client: AlertRpcClient) {
  async function call(name: string, args: RecordValue) {
    const result = await client.rpc(name, args);
    if (result.error) throw new Error("ALERT_QUEUE_UNAVAILABLE");
    return result.data;
  }
  return {
    async claim(limit: number) {
      const data = await call("claim_last_minute_alerts", { p_limit: limit });
      if (!Array.isArray(data)) throw new Error("INVALID_ALERT_QUEUE");
      return data.map(parseClaim);
    },
    async freeze(claim: AlertClaim, message: EmailMessage) {
      const data = await call("freeze_last_minute_alert", { p_alert_id: claim.id, p_claim_token: claim.claimToken, p_message: message });
      return data === null ? null : messageContent(data);
    },
    async complete(claim: AlertClaim) {
      if (await call("complete_last_minute_alert", { p_alert_id: claim.id, p_claim_token: claim.claimToken }) !== true) throw new Error("ALERT_NOT_RECORDED");
    },
    async fail(claim: AlertClaim, error: unknown) {
      if (await call("fail_last_minute_alert", {
        p_alert_id: claim.id, p_claim_token: claim.claimToken, p_error_code: sanitizeEmailErrorCode(error),
        p_retryable: isRetryableEmailError(error), p_unknown: emailDeliveryOf(error) !== "NOT_SENT",
      }) !== true) throw new Error("ALERT_NOT_RECORDED");
    },
  };
}

export type AlertRuntime = {
  queue: ReturnType<typeof createLastMinuteAlertQueue>;
  provider: EmailProvider;
  siteUrl: string;
  log?: (entry: AlertLog) => void;
};

/** Falhas de notificação não alteram a reserva nem o pagamento. */
export async function processLastMinuteAlerts(runtime: AlertRuntime, limit = ALERT_BATCH_SIZE): Promise<AlertReport> {
  const claims = await runtime.queue.claim(Math.max(1, Math.min(limit, ALERT_BATCH_SIZE)));
  let sent = 0;
  for (const claim of claims) {
    const entry = { alertId: claim.id, attempt: claim.attempt };
    try {
      const message = await runtime.queue.freeze(claim, buildLastMinuteAlert(claim.payload, runtime.siteUrl));
      if (!message) { runtime.log?.({ ...entry, outcome: "skipped" }); continue; }
      await runtime.provider.send({ ...message, idempotencyKey: `last-minute-alert/${claim.id}` });
    } catch (error) {
      await runtime.queue.fail(claim, error).catch(() => undefined);
      runtime.log?.({ ...entry, outcome: "failed", errorCode: sanitizeEmailErrorCode(error) });
      continue;
    }
    sent += 1;
    // Depois do aceite, nunca chamar fail(): o provedor já pode ter entregue.
    // Se gravar falhar, o lease vence e a mesma mensagem/chave é recuperada.
    try {
      await runtime.queue.complete(claim);
      runtime.log?.({ ...entry, outcome: "sent" });
    } catch {
      runtime.log?.({ ...entry, outcome: "failed", errorCode: "SENT_NOT_RECORDED" });
    }
  }
  return { outcome: "PROCESSED", processed: claims.length, sent };
}
