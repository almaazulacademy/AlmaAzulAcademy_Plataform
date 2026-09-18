/**
 * Origem pública das URLs do check-in (link e imagem do QR).
 *
 * Exclusiva do check-in: não é usada por canonical, metadata, checkout,
 * InfinitePay nem webhook — esses continuam em `SITE_URL`. Existe para que um
 * e-mail disparado por um Preview da Vercel aponte para o próprio Preview, e o
 * mesmo código, em produção, aponte para o domínio oficial.
 *
 * Prioridade:
 *   1. `CHECKIN_PUBLIC_ORIGIN` explícita (https, ou http só para localhost);
 *   2. Preview da Vercel: `VERCEL_BRANCH_URL` (estável entre pushes da branch)
 *      e, na falta dela, `VERCEL_URL` (URL do deploy);
 *   3. qualquer outro caso — produção e ambiente local — `SITE_URL`.
 *
 * Em produção a variável de Preview nunca é usada, mesmo que exista.
 */

import { SITE_URL } from "../site.ts";

type Env = Record<string, string | undefined>;

function readEnv(): Env {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

function normalizeOrigin(value: string | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function vercelHostOrigin(host: string | undefined) {
  const text = host?.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return text ? normalizeOrigin(`https://${text}`) : null;
}

export function resolveCheckinOrigin(env: Env = readEnv()): string {
  const explicit = normalizeOrigin(env.CHECKIN_PUBLIC_ORIGIN);
  if (explicit) return explicit;

  if (env.VERCEL_ENV === "preview") {
    const preview = vercelHostOrigin(env.VERCEL_BRANCH_URL) ?? vercelHostOrigin(env.VERCEL_URL);
    if (preview) return preview;
  }

  return SITE_URL;
}
