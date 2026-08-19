/**
 * Autenticação server-to-server com a conta de serviço do Google.
 *
 * Fluxo oficial de *JWT bearer* (RFC 7523), o mesmo que a biblioteca do Google
 * executa por baixo: assina uma asserção com a chave privada da service account
 * e a troca por um access token no endpoint de OAuth2 do Google.
 *
 * Feito à mão, com `node:crypto`, por dois motivos: o pacote `googleapis` traz
 * uma árvore enorme para quatro chamadas HTTP, e o projeto já resolve InfinitePay
 * e Supabase Auth do mesmo jeito. Nenhuma credencial atravessa o navegador —
 * este módulo só existe do lado do servidor.
 */

import { createSign } from "node:crypto";

import { SHEETS_SCOPE, type GoogleSheetsConfig } from "./config.ts";
import { GoogleSheetsError, httpError } from "./errors.ts";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TOKEN_LIFETIME_SECONDS = 3600;
/** Margem antes do vencimento: um token quase expirado não é reaproveitado. */
const RENEWAL_MARGIN_MS = 60_000;

type CachedToken = { accessToken: string; expiresAt: number };

const cache = new Map<string, CachedToken>();

function base64Url(value: string | Buffer) {
  const buffer = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildAssertion(config: GoogleSheetsConfig) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: config.clientEmail,
    scope: SHEETS_SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: issuedAt,
    exp: issuedAt + TOKEN_LIFETIME_SECONDS,
  }));

  const payload = `${header}.${claims}`;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(payload);
    signer.end();
    return `${payload}.${base64Url(signer.sign(config.privateKey))}`;
  } catch {
    // Chave malformada, PEM truncado, `\n` não convertido. Nunca vaza o motivo
    // exato porque a mensagem original pode conter fragmento da chave.
    throw new GoogleSheetsError("INVALID_PRIVATE_KEY", false);
  }
}

/**
 * Access token da conta de serviço, reaproveitado enquanto for válido.
 *
 * O cache é por e-mail da conta e vive no processo: em serverless ele dura o
 * tempo da instância, o que já evita uma troca de token por sincronização.
 */
export async function getAccessToken(config: GoogleSheetsConfig): Promise<string> {
  const cached = cache.get(config.clientEmail);
  if (cached && cached.expiresAt - RENEWAL_MARGIN_MS > Date.now()) return cached.accessToken;

  const assertion = buildAssertion(config);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new GoogleSheetsError("TIMEOUT", true);
    }
    throw new GoogleSheetsError("NETWORK_ERROR", true);
  }

  if (!response.ok) {
    // 400 aqui costuma ser relógio fora de hora ou chave revogada; 401/403,
    // conta sem permissão. Nenhum dos dois melhora com repetição imediata.
    if (response.status >= 400 && response.status < 500) {
      throw new GoogleSheetsError("AUTH_FAILED", false);
    }
    throw httpError(response.status);
  }

  const payload: unknown = await response.json().catch(() => null);
  const token = payload && typeof payload === "object"
    ? (payload as Record<string, unknown>).access_token
    : null;
  const expiresIn = payload && typeof payload === "object"
    ? Number((payload as Record<string, unknown>).expires_in)
    : NaN;

  if (typeof token !== "string" || !token) throw new GoogleSheetsError("INVALID_RESPONSE", true);

  const lifetime = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : TOKEN_LIFETIME_SECONDS;
  cache.set(config.clientEmail, { accessToken: token, expiresAt: Date.now() + lifetime * 1000 });
  return token;
}

/** Usado pelo script de setup entre execuções e pelos testes. */
export function clearAccessTokenCache() {
  cache.clear();
}
