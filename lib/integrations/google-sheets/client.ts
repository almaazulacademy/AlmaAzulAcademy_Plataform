/**
 * Cliente da API oficial do Google Sheets (v4), via REST.
 *
 * Escritas de dados usam `valueInputOption=RAW`: um nome que comece com "=" ou
 * um telefone entre parênteses é gravado como texto, e não interpretado como
 * fórmula. `USER_ENTERED` fica reservado ao setup, que precisa que as fórmulas
 * da `Lista da Sessão` sejam de fato fórmulas.
 *
 * Nada aqui roda no navegador. O token da conta de serviço só existe no
 * servidor e nunca é anexado a um log.
 */

import { getAccessToken } from "./auth.ts";
import type { GoogleSheetsConfig } from "./config.ts";
import { GoogleSheetsError, httpError } from "./errors.ts";
import type { SheetValue } from "./mapping.ts";
import type { SheetsGateway } from "./sync.ts";

const API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

export type ValueInputOption = "RAW" | "USER_ENTERED";

export type SheetsClient = SheetsGateway & {
  /** Chamada crua à API, para o que o gateway de sincronização não cobre. */
  call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  getSpreadsheet<T>(fields: string): Promise<T>;
  updateSpreadsheet(requests: unknown[]): Promise<void>;
  writeValues(range: string, values: SheetValue[][], input: ValueInputOption): Promise<void>;
};

function asRows(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => (Array.isArray(row) ? row.map((cell) => (cell === null || cell === undefined ? "" : String(cell))) : []));
}

export function createSheetsClient(config: GoogleSheetsConfig): SheetsClient {
  const root = `${API_BASE}/${encodeURIComponent(config.spreadsheetId)}`;

  async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const accessToken = await getAccessToken(config);

    let response: Response;
    try {
      response = await fetch(`${root}${path}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new GoogleSheetsError("TIMEOUT", true);
      }
      throw new GoogleSheetsError("NETWORK_ERROR", true);
    }

    // O corpo do erro do Google pode citar conteúdo de célula e a URL assinada.
    // Só o status sobrevive daqui para frente.
    if (!response.ok) throw httpError(response.status);

    if (response.status === 204) return undefined as T;
    const payload: unknown = await response.json().catch(() => null);
    if (payload === null) throw new GoogleSheetsError("INVALID_RESPONSE", true);
    return payload as T;
  }

  async function writeValues(range: string, values: SheetValue[][], input: ValueInputOption) {
    await call(`/values/${encodeURIComponent(range)}?valueInputOption=${input}`, {
      method: "PUT",
      body: { range, majorDimension: "ROWS", values },
    });
  }

  return {
    call,
    writeValues,

    getSpreadsheet<T>(fields: string) {
      return call<T>(`?fields=${encodeURIComponent(fields)}`);
    },

    async updateSpreadsheet(requests: unknown[]) {
      if (!requests.length) return;
      await call(":batchUpdate", { method: "POST", body: { requests } });
    },

    async batchGet(ranges: string[]) {
      if (!ranges.length) return [];
      const query = ranges.map((range) => `ranges=${encodeURIComponent(range)}`).join("&");
      const payload = await call<{ valueRanges?: Array<{ values?: unknown }> }>(
        `/values:batchGet?${query}&majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`,
      );
      return ranges.map((_, index) => asRows(payload.valueRanges?.[index]?.values));
    },

    async batchUpdate(updates: Array<{ range: string; values: SheetValue[][] }>) {
      if (!updates.length) return;
      await call("/values:batchUpdate", {
        method: "POST",
        body: {
          valueInputOption: "RAW",
          data: updates.map((update) => ({ range: update.range, majorDimension: "ROWS", values: update.values })),
        },
      });
    },

    async append(range: string, values: SheetValue[][]) {
      if (!values.length) return;
      await call(
        `/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { method: "POST", body: { range, majorDimension: "ROWS", values } },
      );
    },
  };
}
