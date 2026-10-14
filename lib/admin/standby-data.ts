/**
 * Stand-by de reservas: as chamadas do painel ao Supabase.
 *
 * Toda decisão é do banco. Cada função aqui entrega o ator validado pela sessão
 * administrativa a uma RPC `security definer`, que confere de novo se ele é
 * ADMIN ou OPERATOR ativo, trava o que precisa e grava a auditoria. Quando a
 * RPC recusa, ela lança e nada é sincronizado.
 *
 * A planilha vem depois, do mesmo jeito que na confirmação, no cancelamento e
 * na troca de turma: uma falha do Google não desfaz o que o Supabase gravou. E
 * nenhuma destas sincronizações cria a turma original na planilha — ver
 * `lib/integrations/google-sheets/standby-guard.ts`.
 *
 * Nenhum e-mail é disparado por este módulo. A confirmação do reagendamento é
 * enviada pela rota de reagendar, depois de `rescheduleReservationFromStandby`
 * devolver o resultado que o banco gravou.
 */

import {
  parseStandbyEntry,
  parseStandbyHistory,
  parseStandbyLink,
  parseStandbyListPage,
  parseStandbyOptions,
  parseStandbyResolution,
  STANDBY_PAGE_SIZE,
  type StandbyEntry,
  type StandbyHistory,
  type StandbyLink,
  type StandbyLinkFilter,
  type StandbyListPage,
  type StandbyOptions,
  type StandbyResolution,
} from "@/lib/admin/standby";
import { syncReservationAfterChange, syncReservationSessionChange } from "@/lib/integrations/google-sheets/service";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

function adminClient() {
  const client = getSupabaseAdminClient();
  if (!client) throw new Error("ADMIN_NOT_CONFIGURED");
  return client;
}

/** Lista "Aguardando reagendamento", uma página por vez. */
export async function listStandbyReservations(
  actorUserId: string,
  filters: { query: string; baseId: string | null; link: StandbyLinkFilter; page: number },
): Promise<StandbyListPage> {
  const result = await adminClient().rpc("admin_list_standby_reservations_page", {
    p_actor_id: actorUserId,
    p_query: filters.query || null,
    p_base_id: filters.baseId,
    p_link: filters.link || null,
    p_limit: STANDBY_PAGE_SIZE,
    p_offset: (Math.max(1, filters.page) - 1) * STANDBY_PAGE_SIZE,
  });
  if (result.error) throw new Error(result.error.message);
  return parseStandbyListPage(result.data);
}

/**
 * A reserva em Stand-by, a turma original e as turmas elegíveis. Lida quando o
 * admin abre o modal: as vagas mudam a cada confirmação.
 */
export async function getStandbyOptions(actorUserId: string, reservationId: string): Promise<StandbyOptions | null> {
  const result = await adminClient().rpc("admin_standby_reschedule_options", {
    p_actor_id: actorUserId,
    p_reservation_id: reservationId,
  });
  if (result.error) throw new Error(result.error.message);
  return parseStandbyOptions(result.data);
}

/** Trilha interna do Stand-by da reserva. Nunca é pública. */
export async function getStandbyHistory(actorUserId: string, reservationId: string): Promise<StandbyHistory> {
  const result = await adminClient().rpc("admin_reservation_standby_history", {
    p_actor_id: actorUserId,
    p_reservation_id: reservationId,
  });
  if (result.error) throw new Error(result.error.message);
  return parseStandbyHistory(result.data);
}

/** Coloca uma reserva confirmada e paga em Stand-by. Libera as vagas da turma. */
export async function setReservationStandby(actorUserId: string, reservationId: string, reason: string): Promise<StandbyEntry | null> {
  const result = await adminClient().rpc("admin_set_reservation_standby", {
    p_actor_id: actorUserId,
    p_reservation_id: reservationId,
    p_reason: reason,
  });
  if (result.error) throw new Error(result.error.message);
  const entry = parseStandbyEntry(result.data);
  if (!entry) return null;

  // A reserva ainda aponta para a turma original: a linha dela e os totais da
  // turma são atualizados se a turma já estiver na planilha, e só nesse caso.
  await syncReservationAfterChange(reservationId, "STANDBY").catch(() => undefined);
  return entry;
}

/** Devolve a reserva à turma original, se ela ainda puder recebê-la. */
export async function undoReservationStandby(actorUserId: string, reservationId: string, reason: string): Promise<StandbyResolution | null> {
  const result = await adminClient().rpc("admin_undo_reservation_standby", {
    p_actor_id: actorUserId,
    p_reservation_id: reservationId,
    p_reason: reason || null,
  });
  if (result.error) throw new Error(result.error.message);
  const resolution = parseStandbyResolution(result.data);
  if (!resolution) return null;

  await syncReservationAfterChange(reservationId, "STANDBY").catch(() => undefined);
  return resolution;
}

/**
 * Reagenda para outra turma do mesmo valor. A régua — aberta, futura,
 * publicada, com vagas e preço igual ao pago — é aplicada pela RPC, com a
 * reserva e a sessão travadas.
 */
export async function rescheduleReservationFromStandby(
  actorUserId: string,
  reservationId: string,
  targetSessionId: string,
  reason: string,
): Promise<StandbyResolution | null> {
  const result = await adminClient().rpc("admin_reschedule_standby_same_price", {
    p_actor_id: actorUserId,
    p_reservation_id: reservationId,
    p_target_session_id: targetSessionId,
    p_reason: reason || null,
  });
  if (result.error) throw new Error(result.error.message);
  const resolution = parseStandbyResolution(result.data);
  if (!resolution) return null;

  // A reserva vai para a turma nova, que pode precisar ser criada na planilha.
  // A turma original só tem os totais corrigidos se já estiver lá.
  await syncReservationSessionChange(reservationId, resolution.previousSessionId).catch(() => undefined);
  return resolution;
}

/**
 * Gera (ou substitui) o link individual. O token só existe nesta resposta: o
 * banco guarda o hash, e este módulo não o registra em lugar nenhum.
 */
export async function generateStandbyLink(actorUserId: string, reservationId: string): Promise<StandbyLink | null> {
  const result = await adminClient().rpc("admin_generate_reservation_standby_link", {
    p_actor_id: actorUserId,
    p_reservation_id: reservationId,
  });
  if (result.error) throw new Error(result.error.message);
  return parseStandbyLink(result.data);
}

/** Revoga o link. O token anterior deixa de valer na hora. */
export async function revokeStandbyLink(actorUserId: string, reservationId: string): Promise<boolean> {
  const result = await adminClient().rpc("admin_revoke_reservation_standby_link", {
    p_actor_id: actorUserId,
    p_reservation_id: reservationId,
  });
  if (result.error) throw new Error(result.error.message);
  return result.data === true;
}
