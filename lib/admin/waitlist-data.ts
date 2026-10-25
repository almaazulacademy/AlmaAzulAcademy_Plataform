/**
 * Lista de espera: as chamadas do painel ao Supabase.
 *
 * Toda decisão é do banco. Cada função entrega o ator validado pela sessão
 * administrativa às RPCs da fase 1 (`admin_waitlist_sessions`,
 * `admin_list_waitlist_entries_page`, `admin_waitlist_entry`,
 * `admin_remove_waitlist_entry`), que conferem `is_active_admin` de novo e, na
 * remoção, gravam a auditoria. Nada aqui lê tabela direto nem registra dado
 * pessoal em log.
 *
 * `createWaitlistAdminData(rpc)` não depende do Next nem do Supabase: é o que os
 * testes usam contra o Postgres em memória.
 */

import {
  parseWaitlistEntryDetail,
  parseWaitlistEntryPage,
  parseWaitlistSessions,
  validateWaitlistRemoval,
  waitlistAdminError,
  WAITLIST_ENTRIES_PAGE_SIZE,
  type WaitlistEntryDetail,
  type WaitlistEntryPage,
  type WaitlistSession,
  type WaitlistStatusFilter,
} from "./waitlist.ts";

type RpcResult = { data: unknown; error: { message: string; code?: string } | null };
export type WaitlistAdminRpc = (name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;

function failure(error: { message: string; code?: string }) {
  return new Error(error.code ? `${error.code}: ${error.message}` : error.message);
}

export function createWaitlistAdminData(rpc: WaitlistAdminRpc) {
  async function call(name: string, args: Record<string, unknown>) {
    const result = await rpc(name, args);
    if (result.error) throw failure(result.error);
    return result.data;
  }

  return {
    /** Turmas com inscrição. `includePast` traz também as que já começaram. */
    async sessions(actorUserId: string, includePast: boolean): Promise<WaitlistSession[]> {
      return parseWaitlistSessions(await call("admin_waitlist_sessions", { p_actor_id: actorUserId, p_include_past: includePast }));
    },

    /** Inscrições, uma página por vez, na ordem da fila. Paginação no banco. */
    async entries(
      actorUserId: string,
      filters: { sessionId: string | null; baseId: string | null; status: WaitlistStatusFilter; query: string; page: number },
    ): Promise<WaitlistEntryPage> {
      return parseWaitlistEntryPage(await call("admin_list_waitlist_entries_page", {
        p_actor_id: actorUserId,
        p_session_id: filters.sessionId,
        p_base_id: filters.baseId,
        p_status: filters.status === "ALL" ? null : filters.status,
        p_query: filters.query || null,
        p_limit: WAITLIST_ENTRIES_PAGE_SIZE,
        p_offset: (Math.max(1, filters.page) - 1) * WAITLIST_ENTRIES_PAGE_SIZE,
      }));
    },

    /** Uma inscrição, os avisos com as tentativas e as ações da equipe. */
    async entry(actorUserId: string, entryId: string): Promise<WaitlistEntryDetail | null> {
      return parseWaitlistEntryDetail(await call("admin_waitlist_entry", { p_actor_id: actorUserId, p_entry_id: entryId }));
    },

    /** Remove da lista. O banco trava a inscrição, descarta avisos pendentes e audita. */
    async remove(actorUserId: string, entryId: string, reason: string): Promise<{ removed: boolean; status: string }> {
      const answer = await call("admin_remove_waitlist_entry", { p_actor_id: actorUserId, p_entry_id: entryId, p_reason: reason });
      const row = answer && typeof answer === "object" ? answer as Record<string, unknown> : {};
      return { removed: row.removed === true, status: typeof row.status === "string" ? row.status : "" };
    },
  };
}

export type WaitlistAdminData = ReturnType<typeof createWaitlistAdminData>;

export type WaitlistRemovalResponse = { status: number; body: Record<string, unknown> };

/**
 * O corpo da rota de remoção, sem Next: valida o pedido e devolve a resposta.
 * O ator vem da sessão validada, nunca do corpo.
 */
export async function handleWaitlistRemoval(data: WaitlistAdminData, actorUserId: string, entryId: string, body: unknown): Promise<WaitlistRemovalResponse> {
  const validation = validateWaitlistRemoval(body);
  if (!validation.success) {
    return { status: 400, body: { message: Object.values(validation.errors)[0], errors: validation.errors } };
  }
  try {
    const result = await data.remove(actorUserId, entryId, validation.data.reason);
    return result.removed
      ? { status: 200, body: { removed: true, status: result.status, message: "Inscrição removida da lista de espera." } }
      : { status: 409, body: { removed: false, status: result.status, message: "Esta inscrição já não estava ativa. Nada foi alterado." } };
  } catch (error) {
    const mapped = waitlistAdminError(error);
    return { status: mapped.status, body: { message: mapped.message } };
  }
}
