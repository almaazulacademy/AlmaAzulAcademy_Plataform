/**
 * Limite de tentativas das rotas públicas que aceitam CPF + código ou o token
 * do link: a consulta da reserva e as duas do autoatendimento de Stand-by.
 *
 * O estado e as regras ficam no banco (`register_customer_access_attempt`, da
 * migration `202610160001`). Os baldes são os mesmos nas três rotas: alternar
 * entre elas não dá tentativa extra.
 *
 * Este módulo só traduz a resposta. Quem decide o que fazer quando o limite não
 * responde é cada rota: o autoatendimento fecha; a consulta da reserva, que já
 * existia sem limite, segue funcionando como antes.
 */

export const ACCESS_ATTEMPT_RPC = "register_customer_access_attempt";

type RpcResult = { data: unknown; error: { message: string; code?: string } | null };
export type AccessRpc = (name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;

export type AccessCredentialArgs = { p_cpf: string | null; p_public_code: string | null; p_link_token: string | null };

export type AccessAttempt =
  | { status: "ALLOWED" }
  | { status: "BLOCKED"; retryAfterSeconds: number }
  /** MISSING: a função não existe — a migration ainda não foi aplicada. */
  | { status: "UNAVAILABLE"; reason: "MISSING" | "ERROR" };

/** PostgREST (PGRST202) ou Postgres (42883): a função não existe. */
function isMissingFunction(error: { message: string; code?: string }) {
  return error.code === "PGRST202" || error.code === "42883" || /could not find the function|does not exist/i.test(error.message);
}

/**
 * Registra a tentativa. Nunca lança. Recebe só o que o banco precisa e não
 * devolve nada da credencial.
 */
export async function registerAccessAttempt(rpc: AccessRpc, clientAddress: string, credential: AccessCredentialArgs): Promise<AccessAttempt> {
  let result: RpcResult;
  try {
    result = await rpc(ACCESS_ATTEMPT_RPC, { p_client_address: clientAddress, ...credential });
  } catch {
    return { status: "UNAVAILABLE", reason: "ERROR" };
  }
  if (result.error) return { status: "UNAVAILABLE", reason: isMissingFunction(result.error) ? "MISSING" : "ERROR" };
  const data = result.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { status: "UNAVAILABLE", reason: "ERROR" };
  const row = data as Record<string, unknown>;
  if (row.allowed === true) return { status: "ALLOWED" };
  const seconds = Number(row.retryAfterSeconds);
  return { status: "BLOCKED", retryAfterSeconds: Math.max(1, Math.ceil(Number.isFinite(seconds) ? seconds : 900)) };
}

export const TOO_MANY_ATTEMPTS_MESSAGE = "Muitas tentativas seguidas. Por segurança, aguarde alguns minutos antes de tentar de novo.";
