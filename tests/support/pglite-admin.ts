/**
 * Cliente administrativo de teste, apoiado no Postgres em memória.
 *
 * Tem a mesma forma que o serviço da planilha usa do supabase-js — `rpc(nome,
 * argumentos)` e `from(tabela).select(colunas).eq(coluna, valor)` — e executa
 * as funções e as consultas de verdade no PGlite. É o que permite exercitar
 * `runSheetSyncJob` e a fila de pendentes de ponta a ponta, com snapshots, jobs
 * e autorizações reais, sem Supabase e sem rede.
 *
 * `calls` registra o que foi chamado, e `failFrom`/`failRpc` injetam falhas.
 */

import type { PGlite } from "@electric-sql/pglite";

type Failure = { code?: string; message?: string };
type Result = { data: unknown; error: { code: string; message: string } | null };

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const COLUMNS = /^[a-z_][a-z0-9_]*(, [a-z_][a-z0-9_]*)*$/;

export function createPgliteAdmin(db: PGlite) {
  const calls = { rpc: [] as string[], from: [] as string[] };
  const rpcFailures = new Map<string, Failure[]>();
  const fromFailures = new Map<string, Failure[]>();

  function failure(queue: Map<string, Failure[]>, name: string): Result | null {
    const next = queue.get(name)?.shift();
    return next ? { data: null, error: { code: next.code ?? "XX000", message: next.message ?? "falha simulada" } } : null;
  }

  function asError(error: unknown): Result {
    const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "XX000";
    return { data: null, error: { code, message: error instanceof Error ? error.message : String(error) } };
  }

  async function rpc(name: string, args: Record<string, unknown> = {}): Promise<Result> {
    calls.rpc.push(name);
    const failed = failure(rpcFailures, name);
    if (failed) return failed;

    const keys = Object.keys(args);
    if (!IDENTIFIER.test(name) || keys.some((key) => !IDENTIFIER.test(key))) throw new Error(`rpc inválida: ${name}`);
    const sql = `select * from public.${name}(${keys.map((key, index) => `${key} => $${index + 1}`).join(", ")})`;
    try {
      const result = await db.query(sql, keys.map((key) => args[key]));
      const rows = result.rows as Array<Record<string, unknown>>;
      // Função escalar: uma coluna com o nome da função. Função de tabela: linhas.
      const scalar = result.fields.length === 1 && result.fields[0].name === name;
      return { data: scalar ? rows[0]?.[name] ?? null : rows, error: null };
    } catch (error) {
      return asError(error);
    }
  }

  function from(table: string) {
    return {
      select(columns: string) {
        return {
          async eq(column: string, value: unknown): Promise<Result> {
            calls.from.push(table);
            const failed = failure(fromFailures, table);
            if (failed) return failed;
            if (!IDENTIFIER.test(table) || !IDENTIFIER.test(column) || !COLUMNS.test(columns)) throw new Error(`consulta inválida: ${table}`);
            try {
              const result = await db.query(`select ${columns} from public.${table} where ${column} = $1`, [value]);
              return { data: result.rows, error: null };
            } catch (error) {
              return asError(error);
            }
          },
        };
      },
    };
  }

  return {
    client: { rpc, from },
    calls,
    /** As próximas `times` leituras da tabela falham com este erro. */
    failFrom(table: string, failure: Failure, times = 1) {
      fromFailures.set(table, [...(fromFailures.get(table) ?? []), ...Array.from({ length: times }, () => failure)]);
    },
    failRpc(name: string, failure: Failure, times = 1) {
      rpcFailures.set(name, [...(rpcFailures.get(name) ?? []), ...Array.from({ length: times }, () => failure)]);
    },
    clearFailures() {
      rpcFailures.clear();
      fromFailures.clear();
    },
    reset() {
      calls.rpc.length = 0;
      calls.from.length = 0;
    },
  };
}
