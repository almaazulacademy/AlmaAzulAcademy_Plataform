/**
 * Chamada a uma RPC nova com volta para a anterior só quando a nova não existe
 * no banco.
 *
 * As listagens da agenda regular (`list_public_regular_*`, migration
 * `202610280001`) são as antigas menos os eventos especiais. Se a função nova
 * não existir — banco de teste antigo ou rollback da migration —, não existe
 * evento nenhum: o rollback recusa enquanto houver um. Nesse caso, e só nele, a
 * função antiga devolve exatamente o mesmo resultado.
 *
 * Qualquer outra falha da nova (rede, tempo, permissão) é devolvida como está:
 * cair na antiga num erro passageiro poderia mostrar um evento publicado no
 * meio da agenda regular.
 *
 * Módulo puro, sem imports de aplicação: é lido pelo Next e pelos testes.
 */

type RpcError = { message: string; code?: string };
type RpcResult = { data: unknown; error: RpcError | null };
type RpcClient = { rpc(name: string, args?: Record<string, unknown>): PromiseLike<RpcResult> };

/** PostgREST responde PGRST202 quando a função não está no schema cache. */
export function isMissingFunction(error: RpcError | null) {
  if (!error) return false;
  return error.code === "PGRST202"
    || error.code === "42883"
    || /could not find the function|function .* does not exist/i.test(error.message);
}

export async function rpcWithLegacyFallback(client: RpcClient, name: string, legacy: string, args?: Record<string, unknown>): Promise<RpcResult> {
  const result = await client.rpc(name, args);
  if (!isMissingFunction(result.error)) return result;
  return client.rpc(legacy, args);
}
