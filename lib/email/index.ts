/**
 * Seleção do provedor de e-mail.
 *
 * Sem `RESEND_API_KEY` e `EMAIL_FROM` a funcionalidade fica *desligada e inerte*:
 * nenhuma reserva deixa de confirmar, nenhum job é criado, nenhum erro é
 * emitido. Remover as variáveis é o jeito suportado de desativar o envio.
 */

import { ResendProvider } from "@/lib/email/resend";
import type { EmailProvider } from "@/lib/email/email-provider";

/** Depois disso o envio para de ser tentado sozinho e espera ação humana. */
export const MAX_EMAIL_ATTEMPTS = 3;

/** Quantos envios pendentes uma confirmação bem-sucedida tenta recuperar de carona. */
export const OPPORTUNISTIC_EMAIL_DRAIN = 2;

/** Minutos até um envio preso em PENDING poder ser retentado. */
export const STALE_EMAIL_MINUTES = 15;

type Env = Record<string, string | undefined>;

const FORBIDDEN_PUBLIC_KEYS = ["NEXT_PUBLIC_RESEND_API_KEY", "NEXT_PUBLIC_EMAIL_FROM"];

export function findForbiddenPublicEmailKeys(env: Env = process.env) {
  return FORBIDDEN_PUBLIC_KEYS.filter((key) => Boolean(env[key]?.trim()));
}

export function getEmailProvider(env: Env = process.env): EmailProvider | null {
  const forbidden = findForbiddenPublicEmailKeys(env);
  if (forbidden.length) {
    console.error("[email]", {
      scope: "notifications.email",
      stage: "configuration",
      outcome: "failed",
      errorCode: "PUBLIC_ENV_FORBIDDEN",
      keys: forbidden,
    });
    return null;
  }

  const provider = env.EMAIL_PROVIDER?.trim().toUpperCase() || "RESEND";
  if (provider === "NONE") return null;
  if (provider !== "RESEND") {
    console.error("[email]", { scope: "notifications.email", stage: "configuration", outcome: "failed", errorCode: "UNSUPPORTED_PROVIDER" });
    return null;
  }

  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  if (!apiKey || !from) return null;

  return new ResendProvider({ apiKey, from, replyTo: env.EMAIL_REPLY_TO?.trim() || null });
}

export function isEmailEnabled(env: Env = process.env) {
  return getEmailProvider(env) !== null;
}

export type { EmailMessage, EmailProvider } from "@/lib/email/email-provider";
