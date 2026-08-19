/**
 * Configuração da integração com o Google Sheets.
 *
 * Sem as três variáveis, a integração fica *desligada* — e desligada quer dizer
 * inerte, não quebrada: nenhuma reserva deixa de confirmar, nenhum job é
 * enfileirado, nenhum log de erro é emitido. Remover as variáveis da Vercel é o
 * jeito suportado de desativar a sincronização sem tocar em código.
 */

export const GOOGLE_SHEETS_INTEGRATION = "GOOGLE_SHEETS";

/** Escopo mínimo: ler e escrever nas planilhas compartilhadas com a conta. */
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export type GoogleSheetsConfig = {
  spreadsheetId: string;
  clientEmail: string;
  privateKey: string;
  timeoutMs: number;
};

type Env = Record<string, string | undefined>;

/**
 * Nenhum destes segredos pode virar variável pública. Se alguém criar a versão
 * `NEXT_PUBLIC_`, ela vai parar no bundle do navegador — então a integração se
 * recusa a subir e diz exatamente o porquê.
 */
export const FORBIDDEN_PUBLIC_KEYS = [
  "NEXT_PUBLIC_GOOGLE_SHEETS_SPREADSHEET_ID",
  "NEXT_PUBLIC_GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "NEXT_PUBLIC_GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY",
];

export function findForbiddenPublicKeys(env: Env) {
  return FORBIDDEN_PUBLIC_KEYS.filter((key) => Boolean(env[key]?.trim()));
}

/**
 * A chave privada chega da Vercel com `\n` literal, porque variável de ambiente
 * não guarda quebra de linha. O PEM só é válido com as quebras de verdade.
 */
export function normalizePrivateKey(value: string) {
  return value.replace(/\\n/g, "\n").trim();
}

export function readGoogleSheetsConfig(env: Env = process.env): GoogleSheetsConfig | null {
  const forbidden = findForbiddenPublicKeys(env);
  if (forbidden.length) {
    console.error("[google-sheets]", {
      scope: "integrations.google_sheets",
      stage: "configuration",
      outcome: "failed",
      errorCode: "PUBLIC_ENV_FORBIDDEN",
      keys: forbidden,
    });
    return null;
  }

  const spreadsheetId = env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim() ?? "";
  const clientEmail = env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() ?? "";
  const rawPrivateKey = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ?? "";
  if (!spreadsheetId || !clientEmail || !rawPrivateKey.trim()) return null;

  const privateKey = normalizePrivateKey(rawPrivateKey);
  if (!privateKey.includes("BEGIN") || !privateKey.includes("PRIVATE KEY")) return null;

  const timeout = Number(env.GOOGLE_SHEETS_TIMEOUT_MS ?? "");
  const timeoutMs = Number.isFinite(timeout) && timeout >= 1000 && timeout <= 20000 ? Math.trunc(timeout) : 8000;

  return { spreadsheetId, clientEmail, privateKey, timeoutMs };
}

export function isGoogleSheetsEnabled(env: Env = process.env) {
  return readGoogleSheetsConfig(env) !== null;
}

/** Quantos jobs pendentes uma execução bem-sucedida tenta drenar de carona. */
export const OPPORTUNISTIC_DRAIN_LIMIT = 3;

/** Depois disso o job para de ser tentado sozinho e espera ação administrativa. */
export const MAX_SYNC_ATTEMPTS = 5;
