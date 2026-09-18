/**
 * "Reenviar QR Code" de uma reserva — orquestração pura.
 *
 * Ordem obrigatória: carrega o payload (só leitura) → envia → só então registra
 * CHECKIN_QR_RESENT. Falha no envio não registra nada e permite nova tentativa.
 *
 * Caso ambíguo explícito: o provedor confirmou o envio, mas o registro falhou.
 * O cliente provavelmente recebeu; o resultado diz isso em vez de "não enviado".
 */

export type QrReminderOutcome = "SENT" | "NOT_AVAILABLE" | "FAILED" | "SENT_NOT_RECORDED";

export type QrReminderResult = { outcome: QrReminderOutcome; errorCode?: string };

export type QrReminderDeps<Message> = {
  /** Lança com mensagem contendo o motivo quando a reserva não pode receber. */
  load: () => Promise<unknown>;
  build: (payload: unknown) => Message | null;
  send: (message: Message) => Promise<void>;
  record: () => Promise<void>;
  sanitizeError: (error: unknown) => string;
};

const NOT_AVAILABLE = /RESERVATION_NOT_CONFIRMED|RESERVATION_WITHOUT_TOKEN/;

export async function deliverQrReminder<Message>(deps: QrReminderDeps<Message>): Promise<QrReminderResult> {
  let payload: unknown;
  try {
    payload = await deps.load();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const match = message.match(NOT_AVAILABLE);
    if (match) return { outcome: "NOT_AVAILABLE", errorCode: match[0] === "RESERVATION_NOT_CONFIRMED" ? "NOT_CONFIRMED" : "NO_TOKEN" };
    return { outcome: "FAILED", errorCode: "PAYLOAD_UNAVAILABLE" };
  }

  const message = deps.build(payload);
  if (!message) return { outcome: "NOT_AVAILABLE", errorCode: "PAYLOAD_EMPTY" };

  try {
    await deps.send(message);
  } catch (error) {
    return { outcome: "FAILED", errorCode: deps.sanitizeError(error) };
  }

  try {
    await deps.record();
  } catch {
    return { outcome: "SENT_NOT_RECORDED", errorCode: "AUDIT_UNAVAILABLE" };
  }
  return { outcome: "SENT" };
}
